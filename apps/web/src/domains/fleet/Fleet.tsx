import { Html, RoundedBox } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { FleetRun, FleetSpec, FleetUnit } from '@tv/core';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select, useStore } from '../../store';
import { ClaimPin, Floor, Tag, pick } from '../shared';
import { Box, Cyl, FINISH, Windows, mat } from '../../scene/kit';
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

// The spec only gives each obstacle a box, so its proportions decide what it is drawn as:
// a slim or small one is a stand of trees, a low wide one is rocks, anything taller is a building.
function Obstacle({ w, d, h }: { w: number; d: number; h: number }) {
  const footprint = Math.max(w, d);
  if (h < 0.7 && footprint > 1.2) {
    return (
      <group>
        {[-0.3, 0.1, 0.35].map((f, i) => (
          <mesh
            key={i}
            position={[f * w, h * 0.45, (i - 1) * 0.25 * d]}
            scale={[w * (0.35 - i * 0.05), h, d * (0.4 - i * 0.06)]}
            material={mat('#6a6458', { rough: 1 })}
            castShadow
            receiveShadow
          >
            <dodecahedronGeometry args={[1, 0]} />
          </mesh>
        ))}
      </group>
    );
  }
  if (footprint <= 1.6 || h > footprint * 2.5) {
    const trees = Math.max(1, Math.min(5, Math.round((w * d) / 0.8)));
    return (
      <group>
        {Array.from({ length: trees }, (_, i) => {
          const a = (i / trees) * Math.PI * 2;
          const r = trees > 1 ? Math.min(w, d) * 0.3 : 0;
          const th = h * (0.8 + ((i * 37) % 5) * 0.06);
          return (
            <group key={i} position={[Math.cos(a) * r, 0, Math.sin(a) * r]}>
              <Cyl r={0.06} h={th * 0.35} at={[0, th * 0.17, 0]} m={FINISH.wood()} seg={8} />
              <mesh position={[0, th * 0.62, 0]} material={mat(i % 2 ? '#3f6b45' : '#355c3b', { rough: 0.9 })} castShadow>
                <coneGeometry args={[Math.max(0.25, Math.min(w, d) * 0.32), th * 0.75, 10]} />
              </mesh>
            </group>
          );
        })}
      </group>
    );
  }
  const floors = Math.max(1, Math.min(8, Math.round(h / 0.45)));
  return (
    <group>
      <Box size={[w, h, d]} at={[0, h / 2, 0]} m={FINISH.concrete()} />
      <Box size={[w * 1.02, 0.08, d * 1.02]} at={[0, h + 0.04, 0]} m={FINISH.roof()} />
      <Windows w={w * 0.85} rows={floors} cols={Math.max(2, Math.round(w / 0.45))} at={[0, 0.3, d / 2 + 0.01]} gap={(h - 0.4) / floors} />
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
          <group key={i} position={[c.x, 0, c.z]}>
            <Obstacle w={o.width * s} d={o.depth * s} h={h} />
          </group>
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
    // A six-wheeled rover with a sensor mast, in its role's colour
    return (
      <group>
        <RoundedBox args={[0.9, 0.28, 0.6]} radius={0.05} smoothness={2} position={[0, 0.32, 0]} castShadow>
          <meshStandardMaterial color={color} roughness={0.5} />
        </RoundedBox>
        <mesh position={[0, 0.47, 0]} castShadow>
          <boxGeometry args={[0.6, 0.06, 0.45]} />
          <meshStandardMaterial color="#2b2f36" roughness={0.5} />
        </mesh>
        <mesh position={[0.3, 0.68, 0]} castShadow>
          <cylinderGeometry args={[0.025, 0.025, 0.4, 8]} />
          <meshStandardMaterial color="#9aa3ad" metalness={0.6} roughness={0.4} />
        </mesh>
        <mesh position={[0.3, 0.9, 0]}>
          <boxGeometry args={[0.14, 0.08, 0.2]} />
          <meshStandardMaterial color="#16181c" roughness={0.3} />
        </mesh>
        {[-0.32, 0, 0.32]
          .flatMap((x) => [-0.33, 0.33].map((z) => [x, z]))
          .map(([x, z], i) => (
            <mesh key={i} position={[x, 0.13, z]} rotation={[Math.PI / 2, 0, 0]} castShadow>
              <cylinderGeometry args={[0.13, 0.13, 0.1, 14]} />
              <meshStandardMaterial color="#16181c" roughness={0.9} />
            </mesh>
          ))}
      </group>
    );
  }
  // A quadcopter: dark body with its role's colour on top, four arms, motor pods and blurred spinning props
  return (
    <group>
      <RoundedBox args={[0.38, 0.12, 0.38]} radius={0.04} smoothness={2} castShadow>
        <meshStandardMaterial color="#23272e" roughness={0.4} />
      </RoundedBox>
      <mesh position={[0, 0.07, 0]}>
        <boxGeometry args={[0.28, 0.03, 0.28]} />
        <meshStandardMaterial color={color} roughness={0.4} emissive={color} emissiveIntensity={0.3} />
      </mesh>
      <mesh position={[0, -0.09, 0]}>
        <sphereGeometry args={[0.06, 12, 8]} />
        <meshStandardMaterial color="#10151c" metalness={0.4} roughness={0.15} />
      </mesh>
      {[
        [0.32, 0.32],
        [-0.32, 0.32],
        [0.32, -0.32],
        [-0.32, -0.32],
      ].map(([x, z], i) => (
        <group key={i}>
          <mesh position={[x / 2, 0, z / 2]} rotation={[0, Math.atan2(x, z), 0]}>
            <boxGeometry args={[0.04, 0.03, 0.46]} />
            <meshStandardMaterial color="#3a3f47" roughness={0.5} />
          </mesh>
          <group position={[x, 0.03, z]}>
            <mesh>
              <cylinderGeometry args={[0.05, 0.05, 0.08, 12]} />
              <meshStandardMaterial color="#3a3f47" metalness={0.5} roughness={0.4} />
            </mesh>
            <mesh ref={(m) => (rotors.current[i] = m)} position={[0, 0.05, 0]}>
              <cylinderGeometry args={[0.22, 0.22, 0.008, 20]} />
              <meshStandardMaterial color="#d8dde4" transparent opacity={0.35} depthWrite={false} />
            </mesh>
          </group>
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
          {/* Units draw about twice life size: at the scale of a search area they would otherwise be specks */}
          <group scale={1.9}>
            <UnitBody unit={u} color={u.status === 'lost' ? '#4b5563' : roleColor(spec, u.role.id)} />
          </group>
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
