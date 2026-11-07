import { Grid } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { isIndexed, type DatabaseSpec, type SchemaRun, type Table } from '@tv/core';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select, useStore } from '../../store';
import { pick } from '../shared';

const engine = () => runner.run as SchemaRun | null;
const WIDTH = 5.6;
const HEADER = 0.85;
const ROW = 0.42;
const PX = 96;
const GAP_X = 2.6;
const GAP_Z = 1.8;

const cardHeight = (table: Table) => HEADER + table.columns.length * ROW + 0.16;

export function schemaExtent(spec: DatabaseSpec) {
  const columns = Math.max(2, Math.ceil(Math.sqrt(spec.tables.length * 1.3)));
  const rows: Table[][] = [];
  spec.tables.forEach((t, i) => (rows[Math.floor(i / columns)] ??= []).push(t));
  const depth = rows.reduce((sum, row) => sum + Math.max(...row.map(cardHeight)) + GAP_Z, -GAP_Z);
  return { width: Math.min(columns, spec.tables.length) * (WIDTH + GAP_X), depth };
}

function layout(spec: DatabaseSpec) {
  const columns = Math.max(2, Math.ceil(Math.sqrt(spec.tables.length * 1.3)));
  const positions = new Map<string, THREE.Vector3>();
  const rows: Table[][] = [];
  spec.tables.forEach((t, i) => (rows[Math.floor(i / columns)] ??= []).push(t));
  let z = 0;
  const totalZ = rows.reduce((sum, row) => sum + Math.max(...row.map(cardHeight)) + GAP_Z, -GAP_Z);
  for (const row of rows) {
    const height = Math.max(...row.map(cardHeight));
    row.forEach((t, i) => {
      positions.set(t.name, new THREE.Vector3((i - (row.length - 1) / 2) * (WIDTH + GAP_X), 0.12, z - totalZ / 2 + cardHeight(t) / 2));
    });
    z += height + GAP_Z;
  }
  return positions;
}

function drawCard(ctx: CanvasRenderingContext2D, table: Table, run: SchemaRun) {
  const w = WIDTH * PX;
  const h = cardHeight(table) * PX;
  const locked = run.locked.has(table.name);
  const load = run.tableLoad.get(table.name) ?? 0;
  const total = [...run.tableLoad.values()].reduce((a, b) => a + b, 0) || 1;
  const queries = run.spec.workload.filter((q) => q.table === table.name);
  const scanning = queries.some((q) => run.queries.get(q.name)?.scanned);
  const heat = load / total;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#121a29';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = locked ? '#7f1d2d' : scanning ? '#6b3f12' : '#1d3a4a';
  ctx.fillRect(0, 0, w, HEADER * PX);
  ctx.fillStyle = '#f1f5fb';
  ctx.font = '600 30px "Space Grotesk Variable", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(table.name, 18, 28);
  ctx.font = '500 19px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#b6c4da';
  ctx.fillText(`${table.rows.toLocaleString('en-US')} rows${locked ? ' · LOCKED' : ''}`, 18, 62);
  ctx.fillStyle = heat > 0.5 ? '#ffb347' : '#2fd4c2';
  ctx.fillRect(w - 100, 54, 84 * Math.min(1, heat), 12);
  ctx.strokeStyle = '#46597c';
  ctx.strokeRect(w - 100, 54, 84, 12);

  table.columns.forEach((col, i) => {
    const y = (HEADER + i * ROW) * PX;
    const dropped = run.droppedColumns.has(`${table.name}.${col.name}`);
    if (i % 2) {
      ctx.fillStyle = '#17212f';
      ctx.fillRect(0, y, w, ROW * PX);
    }
    const mid = y + (ROW * PX) / 2;
    ctx.font = '500 22px "IBM Plex Mono", monospace';
    ctx.fillStyle = dropped ? '#ff5a68' : col.primary ? '#ffb347' : col.references ? '#7dd3fc' : '#e2e8f0';
    ctx.fillText(col.name, 18, mid);
    ctx.font = '400 19px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#8d9ab2';
    const badge = col.primary ? 'PK' : col.references ? 'FK' : isIndexed(table, col.name) ? 'IDX' : '';
    ctx.textAlign = 'right';
    ctx.fillText(`${col.type} ${badge}`.trim(), w - 16, mid);
    ctx.textAlign = 'left';
    if (dropped) {
      ctx.fillStyle = '#ff5a68';
      ctx.fillRect(14, mid - 1, w - 28, 2);
    }
  });
  ctx.strokeStyle = locked ? '#ff5a68' : scanning ? '#ffb347' : '#3a4e70';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);
}

function Card({ table, at }: { table: Table; at: THREE.Vector3 }) {
  const height = cardHeight(table);
  const { canvas, texture } = useMemo(() => {
    const element = document.createElement('canvas');
    element.width = WIDTH * PX;
    element.height = Math.ceil(height * PX);
    const map = new THREE.CanvasTexture(element);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    return { canvas: element, texture: map };
  }, [height]);
  const last = useRef('');
  const outline = useRef<THREE.Mesh>(null!);

  const redraw = () => {
    const run = engine();
    const ctx = canvas.getContext('2d');
    if (!run || !ctx) return;
    const live = run.table(table.name) ?? table;
    drawCard(ctx, live, run);
    texture.needsUpdate = true;
  };

  useEffect(() => {
    void document.fonts.ready.then(redraw);
  }, [canvas]);

  useFrame(() => {
    const run = engine();
    if (!run) return;
    const live = run.table(table.name) ?? table;
    const signature = [
      Math.round(live.rows / 1000),
      live.indexes.length,
      run.locked.has(table.name),
      [...run.droppedColumns].join(),
      Math.round((run.tableLoad.get(table.name) ?? 0) / 100),
      run.spec.workload.filter((q) => q.table === table.name).map((q) => run.queries.get(q.name)?.scanned).join(),
    ].join('|');
    if (signature !== last.current) {
      last.current = signature;
      redraw();
    }
    outline.current.visible = useStore.getState().selected === table.name;
  });

  return (
    <group position={at}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} onClick={pick(table.name)} castShadow receiveShadow>
        <planeGeometry args={[WIDTH, height]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.06, 0]} castShadow>
        <boxGeometry args={[WIDTH, 0.1, height]} />
        <meshStandardMaterial color="#0b111c" />
      </mesh>
      <mesh ref={outline} position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <planeGeometry args={[WIDTH + 0.28, height + 0.28]} />
        <meshBasicMaterial color="#22d3ee" toneMapped={false} />
      </mesh>
    </group>
  );
}

function Relations({ spec, positions }: { spec: DatabaseSpec; positions: Map<string, THREE.Vector3> }) {
  const pulses = useRef<THREE.InstancedMesh>(null!);
  const phase = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const links = useMemo(() => {
    const out: Array<{ curve: THREE.CubicBezierCurve3; geometry: THREE.TubeGeometry; from: string; to: string }> = [];
    for (const table of spec.tables) {
      const a = positions.get(table.name);
      if (!a) continue;
      table.columns.forEach((col, index) => {
        const ref = col.references;
        const parent = ref && spec.tables.find((t) => t.name === ref.table);
        const b = ref && positions.get(ref.table);
        if (!ref || !parent || !b) return;
        const rowZ = (t: Table, origin: THREE.Vector3, i: number) => origin.z - cardHeight(t) / 2 + HEADER + (i + 0.5) * ROW;
        const side = b.x >= a.x ? 1 : -1;
        const start = new THREE.Vector3(a.x + (side * WIDTH) / 2, 0.18, rowZ(table, a, index));
        const target = Math.max(0, parent.columns.findIndex((c) => c.name === ref.column));
        const sameColumn = Math.abs(a.x - b.x) < 0.1;
        const end = new THREE.Vector3(b.x + (sameColumn ? (side * WIDTH) / 2 : (-side * WIDTH) / 2), 0.18, rowZ(parent, b, target));
        const reach = sameColumn ? 2.2 : Math.max(1.2, Math.abs(end.x - start.x) / 2);
        const curve = new THREE.CubicBezierCurve3(
          start,
          start.clone().add(new THREE.Vector3(side * reach, 0.5, 0)),
          end.clone().add(new THREE.Vector3((sameColumn ? side : -side) * reach, 0.5, 0)),
          end,
        );
        out.push({ curve, from: table.name, to: ref.table, geometry: new THREE.TubeGeometry(curve, 30, 0.035, 6) });
      });
    }
    return out;
  }, [spec, positions]);

  useFrame((_, dt) => {
    const run = engine();
    if (!run) return;
    if (runner.running) phase.current += dt * runner.speed * 0.5;
    let n = 0;
    links.forEach(({ curve, from, to }) => {
      const active = run.spec.workload.some((q) => (q.table === from && q.joins.some((j) => j.table === to)) || (q.table === to && q.joins.some((j) => j.table === from)));
      if (!active) return;
      for (let i = 0; i < 3; i++) {
        dummy.position.copy(curve.getPoint((phase.current + i / 3) % 1));
        dummy.updateMatrix();
        pulses.current.setMatrixAt(n++, dummy.matrix);
      }
    });
    pulses.current.count = n;
    pulses.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      {links.map(({ geometry }, i) => (
        <mesh key={i} geometry={geometry}>
          <meshStandardMaterial color="#7dd3fc" emissive="#7dd3fc" emissiveIntensity={0.25} />
        </mesh>
      ))}
      <instancedMesh ref={pulses} args={[undefined, undefined, Math.max(1, links.length * 3)]} frustumCulled={false}>
        <sphereGeometry args={[0.11, 10, 10]} />
        <meshBasicMaterial color="#ffb347" toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

export function Schema() {
  useStore((s) => s.structure);
  const run = engine();
  const spec = run?.spec ?? null;
  const positions = useMemo(() => (spec ? layout(spec) : new Map<string, THREE.Vector3>()), [spec]);
  if (!spec) return null;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow onClick={() => select(null)}>
        <planeGeometry args={[80, 60]} />
        <meshStandardMaterial color="#0f1725" roughness={0.7} />
      </mesh>
      <Grid args={[80, 60]} cellSize={1} cellThickness={0.3} cellColor="#1c2940" sectionSize={5} sectionThickness={0.6} sectionColor="#27384f" fadeDistance={110} />
      <Relations spec={spec} positions={positions} />
      {spec.tables.map((table) => {
        const at = positions.get(table.name);
        return at ? <Card key={table.name} table={table} at={at} /> : null;
      })}
    </group>
  );
}
