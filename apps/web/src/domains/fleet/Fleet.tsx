import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { FleetRun, FleetSpec, FleetUnit } from '@tv/core';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select, useStore } from '../../store';
import { ClaimPin, Floor, Tag, pick } from '../shared';
import './Fleet.css';

// The field seen from above: units coloured by role over a coverage map that fills in as scouts sweep it, radio links between
// units in contact, and targets that change as they are found, reported and served.

const fleet = () => runner.run as FleetRun | null;
const SIDE = 40;
const ROLE_COLORS = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#fb7185', '#2dd4bf'];
const AIR = 2.4;
const dummy = new THREE.Object3D();
const tint = new THREE.Color();

export const fleetScale = (spec: FleetSpec) => SIDE / Math.max(spec.area.width, spec.area.depth);

const toScene = (spec: FleetSpec, x: number, y: number, s: number) => new THREE.Vector3((x - spec.area.width / 2) * s, 0, (y - spec.area.depth / 2) * s);

const roleColor = (spec: FleetSpec, roleId: string) =>
  ROLE_COLORS[
    Math.max(
      0,
      spec.roles.findIndex((r) => r.id === roleId),
    ) % ROLE_COLORS.length
  ];

function Coverage({ spec, s }: { spec: FleetSpec; s: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const run = fleet();
  const count = run ? run.cols * run.rows : 0;
  const shown = useRef(-1);
  useFrame(() => {
    const r = fleet();
    if (!r || !mesh.current) return;
    if (shown.current === -1) {
      for (let c = 0; c < count; c++) {
        const p = toScene(spec, ((c % r.cols) + 0.5) * r.cell, (Math.floor(c / r.cols) + 0.5) * r.cell, s);
        dummy.position.set(p.x, 0.02, p.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.updateMatrix();
        mesh.current.setMatrixAt(c, dummy.matrix);
      }
      mesh.current.instanceMatrix.needsUpdate = true;
    }
    if (r.tick === shown.current) return;
    shown.current = r.tick;
    for (let c = 0; c < count; c++) mesh.current.setColorAt(c, tint.set(r.explored[c] ? '#0f766e' : '#141c2b'));
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  });
  if (!run || !count) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} key={count} onClick={() => select(null)}>
      <planeGeometry args={[run.cell * s * 0.94, run.cell * s * 0.94]} />
      <meshBasicMaterial transparent opacity={0.55} />
    </instancedMesh>
  );
}

function Base({ spec, s }: { spec: FleetSpec; s: number }) {
  const at = toScene(spec, spec.base.x, spec.base.y, s);
  return (
    <group position={at} onClick={pick('base')}>
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <cylinderGeometry args={[1.4, 1.4, 0.12, 32]} />
        <meshStandardMaterial color="#1e293b" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.13, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.9, 1.1, 32]} />
        <meshBasicMaterial color="#fbbf24" toneMapped={false} />
      </mesh>
      {Array.from({ length: Math.min(spec.base.chargers, 12) }, (_, i) => (
        <mesh
          key={i}
          position={[Math.cos((i / Math.min(spec.base.chargers, 12)) * Math.PI * 2) * 1.8, 0.2, Math.sin((i / Math.min(spec.base.chargers, 12)) * Math.PI * 2) * 1.8]}
          castShadow
        >
          <boxGeometry args={[0.35, 0.4, 0.35]} />
          <meshStandardMaterial color="#334155" emissive="#22d3ee" emissiveIntensity={0.25} />
        </mesh>
      ))}
      <Tag text="Base" tint="#fbbf24" y={1.4} />
    </group>
  );
}

function Obstacles({ spec, s }: { spec: FleetSpec; s: number }) {
  return (
    <group>
      {spec.area.obstacles.map((o, i) => {
        const c = toScene(spec, o.x + o.width / 2, o.y + o.depth / 2, s);
        const h = Math.max(0.4, Math.min(6, o.height * s));
        return (
          <mesh key={i} position={[c.x, h / 2, c.z]} castShadow receiveShadow>
            <boxGeometry args={[o.width * s, h, o.depth * s]} />
            <meshStandardMaterial color="#475569" roughness={0.8} />
          </mesh>
        );
      })}
    </group>
  );
}

function Targets({ spec, s }: { spec: FleetSpec; s: number }) {
  const run = fleet();
  const refs = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const groups = useRef<Array<THREE.Group | null>>([]);
  useFrame(({ clock }) => {
    const r = fleet();
    if (!r) return;
    r.targets.forEach((t, i) => {
      const m = refs.current[i];
      const g = groups.current[i];
      if (!m || !g) return;
      const done = t.served >= r.spec.deliveriesPerTarget && r.spec.deliveriesPerTarget > 0;
      m.color.set(done ? '#22c55e' : t.reported ? '#f97316' : t.found ? '#fde047' : '#475569');
      m.emissive.set(done ? '#22c55e' : t.reported ? '#f97316' : t.found ? '#fde047' : '#000000');
      m.emissiveIntensity = t.found && !done ? 0.8 + Math.sin(clock.elapsedTime * 4) * 0.4 : 0.3;
      m.opacity = t.found ? 1 : 0.35;
      const p = toScene(spec, t.x, t.y, s);
      g.position.set(p.x, 0, p.z);
    });
  });
  if (!run) return null;
  return (
    <group>
      {run.targets.map((_, i) => (
        <group key={i} ref={(g) => (groups.current[i] = g)}>
          <mesh position={[0, 0.35, 0]}>
            <coneGeometry args={[0.28, 0.7, 12]} />
            <meshStandardMaterial ref={(m) => (refs.current[i] = m)} transparent toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function UnitBody({ unit, color }: { unit: FleetUnit; color: string }) {
  const rotors = useRef<Array<THREE.Mesh | null>>([]);
  useFrame((_, dt) => {
    const flying = unit.status === 'out' || unit.status === 'returning';
    for (const r of rotors.current) if (r) r.rotation.y += flying ? dt * 40 : 0;
  });
  if (unit.role.ground) {
    return (
      <group>
        <mesh position={[0, 0.3, 0]} castShadow>
          <boxGeometry args={[0.8, 0.35, 0.55]} />
          <meshStandardMaterial color={color} roughness={0.5} />
        </mesh>
        {[-0.3, 0.3]
          .flatMap((x) => [-0.3, 0.3].map((z) => [x, z]))
          .map(([x, z], i) => (
            <mesh key={i} position={[x, 0.13, z]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.13, 0.13, 0.1, 12]} />
              <meshStandardMaterial color="#111827" />
            </mesh>
          ))}
      </group>
    );
  }
  return (
    <group>
      <mesh castShadow>
        <boxGeometry args={[0.36, 0.14, 0.36]} />
        <meshStandardMaterial color={color} roughness={0.4} emissive={color} emissiveIntensity={0.25} />
      </mesh>
      {[
        [0.32, 0.32],
        [-0.32, 0.32],
        [0.32, -0.32],
        [-0.32, -0.32],
      ].map(([x, z], i) => (
        <group key={i} position={[x, 0.06, z]}>
          <mesh rotation={[0, Math.PI / 4, 0]}>
            <boxGeometry args={[0.5, 0.03, 0.05]} />
            <meshStandardMaterial color="#cbd5e1" />
          </mesh>
          <mesh ref={(m) => (rotors.current[i] = m)} position={[0, 0.04, 0]}>
            <cylinderGeometry args={[0.2, 0.2, 0.01, 16]} />
            <meshStandardMaterial color="#e2e8f0" transparent opacity={0.45} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Units({ spec, s }: { spec: FleetSpec; s: number }) {
  const run = fleet();
  const groups = useRef<Map<string, THREE.Group>>(new Map());
  const rings = useRef<Map<string, THREE.Mesh>>(new Map());
  useFrame(({ clock }, dt) => {
    const r = fleet();
    if (!r) return;
    for (const u of r.units) {
      const g = groups.current.get(u.id);
      if (!g) continue;
      const p = toScene(spec, u.x, u.y, s);
      const flying = u.status === 'out' || u.status === 'returning';
      const lost = u.status === 'lost';
      const y = lost ? 0.12 : u.role.ground ? 0 : flying ? AIR + Math.sin(clock.elapsedTime * 2 + u.id.length) * 0.08 : 0.2;
      g.position.x = THREE.MathUtils.damp(g.position.x, p.x, 10, dt);
      g.position.z = THREE.MathUtils.damp(g.position.z, p.z, 10, dt);
      g.position.y = THREE.MathUtils.damp(g.position.y, y, 6, dt);
      g.rotation.z = THREE.MathUtils.damp(g.rotation.z, lost ? 1.1 : 0, 4, dt);
      const ring = rings.current.get(u.id);
      if (ring) ring.visible = flying && !r.connected.has(u.id);
    }
  });
  if (!run) return null;
  return (
    <group>
      {run.units.map((u) => (
        <group
          key={u.id}
          ref={(g) => {
            if (g) groups.current.set(u.id, g);
          }}
          onClick={pick(u.id)}
        >
          <UnitBody unit={u} color={u.status === 'lost' ? '#4b5563' : roleColor(spec, u.role.id)} />
          <mesh
            ref={(m) => {
              if (m) rings.current.set(u.id, m);
            }}
            position={[0, -0.12, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            visible={false}
          >
            <ringGeometry args={[0.38, 0.5, 24]} />
            <meshBasicMaterial color="#ef4444" toneMapped={false} />
          </mesh>
          <ClaimPin id={u.id} position={[0, 0.5, 0]} />
        </group>
      ))}
    </group>
  );
}

// Radio links between units in contact, redrawn from the run every frame.
function Links({ spec, s }: { spec: FleetSpec; s: number }) {
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  const positions = useMemo(() => new Float32Array(400 * 6), []);
  useMemo(() => geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)), [geometry, positions]);
  useFrame(() => {
    const r = fleet();
    if (!r) return;
    let n = 0;
    const where = (id: string) => {
      if (id === 'base') return toScene(spec, spec.base.x, spec.base.y, s).setY(0.3);
      const u = r.unit(id);
      return u ? toScene(spec, u.x, u.y, s).setY(u.role.ground ? 0.4 : AIR) : null;
    };
    for (const [a, b] of r.links.slice(0, 400)) {
      const pa = where(a);
      const pb = where(b);
      if (!pa || !pb) continue;
      positions.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], n * 6);
      n++;
    }
    geometry.setDrawRange(0, n * 2);
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  });
  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial color="#22d3ee" transparent opacity={0.55} toneMapped={false} />
    </lineSegments>
  );
}

function Legend({ spec }: { spec: FleetSpec }) {
  return (
    <Html fullscreen calculatePosition={(_, __, size) => [size.width / 2, size.height / 2]} zIndexRange={[8, 0]} style={{ pointerEvents: 'none' }}>
      <div className="fleet-legend">
        {spec.roles.map((r) => (
          <div key={r.id} className="fleet-legend-row">
            <span className="fleet-dot" style={{ background: roleColor(spec, r.id) }} />
            <span>
              {r.count} {r.label ?? r.id}
            </span>
            <em>{r.behavior}</em>
          </div>
        ))}
        <div className="fleet-legend-row fleet-legend-key">
          <span className="fleet-dot" style={{ background: '#fde047' }} /> found <span className="fleet-dot" style={{ background: '#f97316' }} /> reported{' '}
          <span className="fleet-dot" style={{ background: '#22c55e' }} /> served
        </div>
      </div>
    </Html>
  );
}

export function Fleet() {
  useStore((s) => s.structure);
  const run = fleet();
  const structure = useStore.getState().structure;
  const spec = useMemo(() => (run ? (structuredClone(run.spec) as FleetSpec) : null), [run, structure]);
  if (!spec) return null;
  const s = fleetScale(spec);
  const w = spec.area.width * s;
  const d = spec.area.depth * s;
  return (
    <group>
      <Floor width={w + 6} depth={d + 6} fade={120} />
      <Coverage spec={spec} s={s} />
      <Obstacles spec={spec} s={s} />
      <Base spec={spec} s={s} />
      <Targets spec={spec} s={s} />
      <Links spec={spec} s={s} />
      <Units spec={spec} s={s} />
      <Legend spec={spec} />
    </group>
  );
}
