import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { linkKey, netOrder, type Environment, type NetNode, type NetRun, type NetSpec } from '@tv/core';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select, useStore } from '../../store';
import { ClaimPin, Floor, Movable, Tag, pick, useArranged } from '../shared';
import './Queues.css';
import { Tower, floorsOf, towerHeight } from './Tower';

// Queues as you'd see them: a row of counters per station with staff behind them, people (or cars) waiting in snaking lines,
// lanes with traffic lights, elevator cars in their shafts, and people walking between stations as they are served.

const net = () => runner.run as NetRun | null;
const LAYER_GAP = 12;
const ROW_GAP = 9;
const SPACING = 1.1;
const MAX_PEOPLE = 70;
const MAX_COUNTERS = 12;
const dummy = new THREE.Object3D();
const tint = new THREE.Color();
const CALM = new THREE.Color('#7dd3fc');
const TENSE = new THREE.Color('#fb923c');
const FULL = new THREE.Color('#ef4444');

export function queuesLayout(spec: NetSpec) {
  const depth = new Map<string, number>();
  for (const id of netOrder(spec)) {
    const incoming = spec.edges.filter((e) => e.to === id).map((e) => (depth.get(e.from) ?? 0) + 1);
    depth.set(id, Math.max(0, ...incoming));
  }
  const layers = new Map<number, string[]>();
  for (const [id, d] of depth) layers.set(d, [...(layers.get(d) ?? []), id]);
  const maxDepth = Math.max(0, ...layers.keys());
  const positions = new Map<string, THREE.Vector3>();
  // Lines form to the left of each station, so the layout sits a little right of centre to keep them in frame.
  const shift = LAYER_GAP * 0.25;
  for (const [d, ids] of layers) ids.forEach((id, i) => positions.set(id, new THREE.Vector3((d - maxDepth / 2) * LAYER_GAP + shift, 0, (i - (ids.length - 1) / 2) * ROW_GAP)));
  return positions;
}

export function queuesExtent(spec: NetSpec) {
  const ps = [...queuesLayout(spec).values()];
  const xs = ps.map((p) => p.x);
  const zs = ps.map((p) => p.z);
  return { width: Math.max(...xs) - Math.min(...xs) + LAYER_GAP * 1.4, depth: Math.max(...zs) - Math.min(...zs) + ROW_GAP * 1.2 };
}

// Where the elevator bank stands and how high it reaches, so the camera can frame the whole building.
export function towerFocus(environment: Environment) {
  const spec = environment.spec as NetSpec;
  const node = spec.nodes?.find((n) => n.kind === 'elevator');
  if (!node) return null;
  const at = queuesLayout(spec).get(node.id);
  return { x: at?.x ?? 0, z: at?.z ?? 0, height: towerHeight(floorsOf(environment, node)) };
}

const role = (run: NetRun, node: NetNode) => run.role(node);
const servers = (node: NetNode) => Math.min(MAX_COUNTERS, Math.max(1, node.count ?? 1));

// Counter positions along z for a station, and the spot in front of each where the person being served stands.
const counterZ = (n: number, i: number) => (i - (n - 1) / 2) * SPACING;

function Person({ color = '#cbd5e1' }: { color?: string }) {
  return (
    <group>
      <mesh position={[0, 0.42, 0]} castShadow>
        <capsuleGeometry args={[0.16, 0.42, 4, 10]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.9, 0]} castShadow>
        <sphereGeometry args={[0.13, 12, 10]} />
        <meshStandardMaterial color="#f1c7a3" roughness={0.6} />
      </mesh>
    </group>
  );
}

function Counters({ node }: { node: NetNode }) {
  const n = servers(node);
  const lights = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const staff = useRef<Array<THREE.Group | null>>([]);
  const customers = useRef<Array<THREE.Group | null>>([]);
  useFrame(() => {
    const run = net();
    const state = run?.states.get(node.id);
    if (!run || !state) return;
    const busy = state.down ? 0 : Math.min(n, Math.round(Math.min(1, state.utilization) * n + (state.queue > 0 ? n : 0)));
    for (let i = 0; i < n; i++) {
      const open = !state.down && i < n - Math.round((state.lost * n) / Math.max(1, node.count ?? 1));
      const serving = open && i < Math.max(busy, state.queue > 0 ? n : 0);
      lights.current[i]?.color.set(!open ? '#334155' : serving ? '#22c55e' : '#facc15');
      if (lights.current[i]) lights.current[i]!.emissive.set(!open ? '#000000' : serving ? '#22c55e' : '#facc15');
      if (staff.current[i]) staff.current[i]!.visible = open;
      if (customers.current[i]) customers.current[i]!.visible = serving;
    }
  });
  return (
    <group>
      {Array.from({ length: n }, (_, i) => (
        <group key={i} position={[0, 0, counterZ(n, i)]}>
          <mesh position={[0, 0.45, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.7, 0.9, 0.9]} />
            <meshStandardMaterial color="#334155" roughness={0.7} />
          </mesh>
          <mesh position={[0, 1.15, 0.38]}>
            <sphereGeometry args={[0.09, 10, 8]} />
            <meshStandardMaterial ref={(m) => (lights.current[i] = m)} color="#22c55e" emissive="#22c55e" emissiveIntensity={1.4} toneMapped={false} />
          </mesh>
          <group ref={(g) => (staff.current[i] = g)} position={[0.6, 0, 0]}>
            <Person color="#1d4ed8" />
          </group>
          <group ref={(g) => (customers.current[i] = g)} position={[-0.65, 0, 0]}>
            <Person color="#e2e8f0" />
          </group>
        </group>
      ))}
    </group>
  );
}

function Lanes({ node }: { node: NetNode }) {
  const n = servers(node);
  const light = useRef<THREE.MeshStandardMaterial>(null!);
  useFrame(({ clock }) => {
    const run = net();
    const state = run?.states.get(node.id);
    const green = !state?.down && Math.floor(clock.elapsedTime / 3) % 2 === 0;
    light.current?.color.set(green ? '#22c55e' : '#ef4444');
    light.current?.emissive.set(green ? '#22c55e' : '#ef4444');
  });
  return (
    <group>
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} position={[-1.5, 0.02, counterZ(n, i) * 1.3]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[5, 1.1]} />
          <meshStandardMaterial color="#1f2937" />
        </mesh>
      ))}
      <mesh position={[0.4, 1.2, -((n - 1) / 2) * SPACING * 1.3 - 0.9]} castShadow>
        <boxGeometry args={[0.25, 0.7, 0.25]} />
        <meshStandardMaterial color="#111827" />
      </mesh>
      <mesh position={[0.4, 1.35, -((n - 1) / 2) * SPACING * 1.3 - 0.75]}>
        <sphereGeometry args={[0.1, 10, 8]} />
        <meshStandardMaterial ref={light} color="#22c55e" emissive="#22c55e" emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
      <mesh position={[0.4, 0.45, -((n - 1) / 2) * SPACING * 1.3 - 0.9]}>
        <cylinderGeometry args={[0.05, 0.05, 0.9, 8]} />
        <meshStandardMaterial color="#475569" />
      </mesh>
    </group>
  );
}

function Entrance({ exit }: { exit: boolean }) {
  return (
    <group>
      {[-1.4, 1.4].map((z) => (
        <mesh key={z} position={[0, 1.2, z]} castShadow>
          <boxGeometry args={[0.3, 2.4, 0.3]} />
          <meshStandardMaterial color={exit ? '#166534' : '#475569'} />
        </mesh>
      ))}
      <mesh position={[0, 2.5, 0]} castShadow>
        <boxGeometry args={[0.35, 0.3, 3.1]} />
        <meshStandardMaterial color={exit ? '#22c55e' : '#64748b'} emissive={exit ? '#22c55e' : '#000000'} emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

// The people (or cars) waiting at a station, laid out as a snaking line in front of it.
function Line({ node, cars }: { node: NetNode; cars: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const heads = useRef<THREE.InstancedMesh>(null);
  const shown = useRef(-1);
  useFrame(() => {
    const run = net();
    const state = run?.states.get(node.id);
    if (!run || !state || !mesh.current) return;
    const waiting = Math.min(MAX_PEOPLE, Math.round(state.queue + run.heldAt(node.id)));
    if (waiting === shown.current) return;
    shown.current = waiting;
    const room = Math.max(1, run.bufferOf(node));
    const pressure = Math.min(1, waiting / room);
    tint.copy(CALM).lerp(pressure > 0.9 ? FULL : TENSE, Math.min(1, pressure * 1.1));
    const perRow = 7;
    const width = servers(node) * SPACING;
    for (let i = 0; i < MAX_PEOPLE; i++) {
      if (i >= waiting) {
        dummy.position.set(0, -10, 0);
      } else {
        const row = Math.floor(i / perRow);
        const k = i % perRow;
        const along = row % 2 === 0 ? k : perRow - 1 - k;
        const z = (along / (perRow - 1) - 0.5) * Math.max(2.4, width);
        dummy.position.set(-1.6 - row * (cars ? 1.2 : 0.75), cars ? 0.25 : 0.42, z);
      }
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
      mesh.current.setColorAt(i, tint);
      if (heads.current) {
        dummy.position.y += 0.48;
        dummy.updateMatrix();
        heads.current.setMatrixAt(i, dummy.matrix);
      }
    }
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    if (heads.current) heads.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <instancedMesh ref={mesh} args={[undefined, undefined, MAX_PEOPLE]} castShadow frustumCulled={false}>
        {cars ? <boxGeometry args={[0.9, 0.5, 0.5]} /> : <capsuleGeometry args={[0.15, 0.4, 4, 8]} />}
        <meshStandardMaterial roughness={0.6} />
      </instancedMesh>
      {!cars && (
        <instancedMesh ref={heads} args={[undefined, undefined, MAX_PEOPLE]} frustumCulled={false}>
          <sphereGeometry args={[0.12, 10, 8]} />
          <meshStandardMaterial color="#f1c7a3" roughness={0.6} />
        </instancedMesh>
      )}
    </group>
  );
}

// People walking from one station to the next, as many as the link carries.
function Walkers({ spec, positions }: { spec: NetSpec; positions: Map<string, THREE.Vector3> }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const phase = useRef(0);
  const PER_LINK = 6;
  useFrame((_, dt) => {
    const run = net();
    if (!run || !mesh.current) return;
    if (runner.running) phase.current += dt * runner.speed * 0.35;
    let n = 0;
    for (const e of spec.edges) {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      const link = run.links.get(linkKey(e));
      if (!a || !b || !link || link.down || link.flow <= 1e-6) continue;
      const count = Math.min(PER_LINK, Math.max(1, Math.round(link.flow)));
      for (let k = 0; k < count; k++) {
        const t = (phase.current + k / count) % 1;
        dummy.position.set(a.x + 1.2 + (b.x - 2.8 - (a.x + 1.2)) * t, 0.42, a.z + (b.z - a.z) * t);
        dummy.updateMatrix();
        mesh.current.setMatrixAt(n++, dummy.matrix);
      }
    }
    mesh.current.count = n;
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, Math.max(1, spec.edges.length * PER_LINK)]} frustumCulled={false}>
      <capsuleGeometry args={[0.13, 0.36, 4, 8]} />
      <meshStandardMaterial color="#a7f3d0" roughness={0.5} />
    </instancedMesh>
  );
}

function Paths({ spec, positions }: { spec: NetSpec; positions: Map<string, THREE.Vector3> }) {
  return (
    <group>
      {spec.edges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        const from = new THREE.Vector3(a.x + 1.2, 0.015, a.z);
        const to = new THREE.Vector3(b.x - 2.8, 0.015, b.z);
        const mid = from.clone().lerp(to, 0.5);
        const length = from.distanceTo(to);
        const angle = Math.atan2(to.z - from.z, to.x - from.x);
        return (
          <mesh key={i} position={mid} rotation={[-Math.PI / 2, 0, -angle]} receiveShadow onClick={pick(linkKey(e))}>
            <planeGeometry args={[length, 0.7]} />
            <meshStandardMaterial color="#1e293b" roughness={0.9} />
          </mesh>
        );
      })}
    </group>
  );
}

function StationLabel({ node, x = 0, y = 3.1 }: { node: NetNode; x?: number; y?: number }) {
  const label = useRef<HTMLDivElement>(null);
  useFrame(() => {
    const run = net();
    const state = run?.states.get(node.id);
    const el = label.current;
    if (!run || !state || !el) return;
    const kind = role(run, node);
    const waiting = Math.round(state.queue + run.heldAt(node.id));
    const n = servers(node);
    const text =
      kind === 'source'
        ? ''
        : kind === 'sink'
          ? `${Math.round(state.served)} / min`
          : state.down
            ? 'closed'
            : `${waiting} waiting · ${n - Math.round((state.lost * n) / Math.max(1, node.count ?? 1))} open`;
    if (el.textContent !== text) el.textContent = text;
    el.dataset.state = state.down ? 'down' : waiting >= run.bufferOf(node) * 0.9 && run.bufferOf(node) > 0 ? 'full' : waiting > 0 ? 'busy' : 'ok';
    el.style.display = text ? '' : 'none';
  });
  return (
    <Html position={[x, y, 0]} center zIndexRange={[10, 0]}>
      <div ref={label} className="queue-label" />
    </Html>
  );
}

export function Queues() {
  useStore((s) => s.structure);
  const environment = useStore((s) => s.environment);
  const run = net();
  const structure = useStore.getState().structure;
  const spec = useMemo(() => (run ? ({ ...run.spec, edges: [...run.spec.edges] } as NetSpec) : null), [run, structure]);
  const positions = useArranged(useMemo(() => (spec ? queuesLayout(spec) : new Map<string, THREE.Vector3>()), [spec]));
  if (!spec || !run) return null;
  const { width, depth } = queuesExtent(spec);
  // An exit fed only by elevators is the building's upper floors, which the tower already shows, so it isn't drawn again on the ground.
  const lifts = new Set(spec.nodes.filter((n) => n.kind === 'elevator').map((n) => n.id));
  const upstairs = new Set(
    spec.nodes.filter((n) => run.role(n) === 'sink' && spec.edges.some((e) => e.to === n.id) && spec.edges.every((e) => e.to !== n.id || lifts.has(e.from))).map((n) => n.id),
  );
  const ground = upstairs.size ? { ...spec, edges: spec.edges.filter((e) => !upstairs.has(e.to)) } : spec;
  return (
    <group>
      <Floor width={width + 10} depth={depth + 10} section={4} fade={120} />
      <Paths spec={ground} positions={positions} />
      <Walkers spec={ground} positions={positions} />
      {spec.nodes.map((node) => {
        const at = positions.get(node.id);
        if (!at || upstairs.has(node.id)) return null;
        const kind = role(run, node);
        const cars = node.kind === 'lane';
        return (
          <Movable key={node.id} id={node.id} position={at}>
            {kind === 'source' || kind === 'sink' ? (
              <Entrance exit={kind === 'sink'} />
            ) : node.kind === 'lane' ? (
              <Lanes node={node} />
            ) : node.kind === 'elevator' ? (
              <Tower node={node} environment={environment} />
            ) : (
              <Counters node={node} />
            )}
            {kind === 'stage' && <Line node={node} cars={cars} />}
            {node.kind === 'elevator' ? (
              <Tag text={`${node.label ?? node.id} · ${floorsOf(environment, node)} floors`} tint="#9fd8ff" y={towerHeight(floorsOf(environment, node)) + 0.9} />
            ) : (
              <Tag text={node.label ?? node.id} tint="#9fd8ff" y={3.7} />
            )}
            <StationLabel node={node} {...(node.kind === 'elevator' ? { x: -3.4, y: 2.2 } : {})} />
            <ClaimPin id={node.id} position={[0, 1.2, 0]} />
          </Movable>
        );
      })}
    </group>
  );
}
