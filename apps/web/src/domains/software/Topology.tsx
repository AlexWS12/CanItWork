import { Grid } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { edgeKey, topoOrder, type SystemNode, type SystemRun, type SystemSpec } from '@tv/core';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select, useStore } from '../../store';
import { ClaimPin, Tag, pick } from '../shared';

const system = () => runner.run as SystemRun | null;
const LAYER_GAP = 7;
const ROW_GAP = 5;
const dummy = new THREE.Object3D();
const color = new THREE.Color();

function layout(spec: SystemSpec) {
  const depth = new Map<string, number>();
  for (const id of topoOrder(spec)) {
    const incoming = spec.edges.filter((e) => e.to === id).map((e) => (depth.get(e.from) ?? 0) + 1);
    depth.set(id, Math.max(0, ...incoming));
  }
  const layers = new Map<number, string[]>();
  for (const [id, d] of depth) layers.set(d, [...(layers.get(d) ?? []), id]);
  const maxDepth = Math.max(0, ...layers.keys());
  const positions = new Map<string, THREE.Vector3>();
  for (const [d, ids] of layers) {
    ids.forEach((id, i) => positions.set(id, new THREE.Vector3((d - maxDepth / 2) * LAYER_GAP, 0, (i - (ids.length - 1) / 2) * ROW_GAP)));
  }
  return positions;
}

// How much floor the layout covers, so the camera can frame wide chains and tall layers without the side panels cutting them off.
export function topologyExtent(spec: SystemSpec) {
  const points = [...layout(spec).values()];
  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  return { width: Math.max(0, ...xs) - Math.min(0, ...xs), depth: Math.max(0, ...zs) - Math.min(0, ...zs) };
}

const healthColor = (down: boolean, utilization: number, success: number) => {
  if (down) return '#ff3b4e';
  if (success < 0.9 || utilization > 1) return '#ff7a45';
  if (utilization > 0.8) return '#ffb347';
  return '#2fd4c2';
};

function Rack({ replicas, light }: { replicas: number; light: (m: THREE.MeshBasicMaterial | null) => void }) {
  const units = Math.min(6, replicas);
  return (
    <group>
      {Array.from({ length: units }, (_, i) => (
        <group key={i} position={[0, 0.3 + i * 0.46, 0]}>
          <mesh castShadow>
            <boxGeometry args={[1.7, 0.38, 1.3]} />
            <meshStandardMaterial color="#2b3750" metalness={0.65} roughness={0.35} />
          </mesh>
          <mesh position={[0, 0, 0.66]}>
            <boxGeometry args={[1.3, 0.07, 0.02]} />
            <meshBasicMaterial ref={i === 0 ? light : undefined} color="#2fd4c2" toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function NodeBody({ node }: { node: SystemNode }) {
  const light = useRef<THREE.MeshBasicMaterial | null>(null);
  const fill = useRef<THREE.Mesh>(null!);
  const setLight = (m: THREE.MeshBasicMaterial | null) => {
    if (m) light.current = m;
  };
  useFrame(() => {
    const state = system()?.states.get(node.id);
    if (!state) return;
    if (light.current) light.current.color.set(healthColor(state.down, state.utilization, state.success)).multiplyScalar(2);
    if (fill.current) {
      const level = Math.min(1, state.backlog / 3000);
      fill.current.scale.x = Math.max(0.02, level);
      fill.current.position.x = -1.4 + 1.4 * level;
    }
  });
  switch (node.kind) {
    case 'client':
      return (
        <group>
          {[
            [-0.6, -0.4],
            [0.5, -0.5],
            [0, 0.45],
            [-0.75, 0.55],
            [0.8, 0.4],
          ].map(([x, z], i) => (
            <mesh key={i} position={[x, 0.4, z]} castShadow>
              <capsuleGeometry args={[0.2, 0.35, 6, 12]} />
              <meshStandardMaterial color="#9fb3d4" />
            </mesh>
          ))}
        </group>
      );
    case 'gateway':
      return (
        <group>
          {[-1.1, 1.1].map((x) => (
            <mesh key={x} position={[x, 1, 0]} castShadow>
              <boxGeometry args={[0.4, 2, 0.9]} />
              <meshStandardMaterial color="#3d4d6e" metalness={0.6} roughness={0.35} />
            </mesh>
          ))}
          <mesh position={[0, 2.1, 0]} castShadow>
            <boxGeometry args={[2.9, 0.4, 0.9]} />
            <meshStandardMaterial color="#3d4d6e" metalness={0.6} roughness={0.35} />
          </mesh>
          <mesh position={[0, 1.85, 0.46]}>
            <boxGeometry args={[2, 0.08, 0.02]} />
            <meshBasicMaterial ref={setLight} color="#2fd4c2" toneMapped={false} />
          </mesh>
        </group>
      );
    case 'database':
      return (
        <group>
          {[0.42, 1.12, 1.82].map((y, i) => (
            <mesh key={y} position={[0, y, 0]} castShadow>
              <cylinderGeometry args={[1.05, 1.05, 0.6, 36]} />
              <meshStandardMaterial color={i === 2 ? '#51648c' : '#3d4d6e'} metalness={0.6} roughness={0.3} />
            </mesh>
          ))}
          <mesh position={[0, 2.16, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.7, 0.85, 36]} />
            <meshBasicMaterial ref={setLight} color="#2fd4c2" toneMapped={false} />
          </mesh>
        </group>
      );
    case 'cache':
      return (
        <group>
          <mesh position={[0, 0.6, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <torusGeometry args={[0.95, 0.26, 16, 44]} />
            <meshStandardMaterial color="#3d4d6e" metalness={0.7} roughness={0.25} />
          </mesh>
          <mesh position={[0, 0.6, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.55, 32]} />
            <meshBasicMaterial ref={setLight} color="#2fd4c2" toneMapped={false} />
          </mesh>
        </group>
      );
    case 'queue':
      return (
        <group position={[0, 0.65, 0]}>
          <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
            <capsuleGeometry args={[0.55, 2.6, 8, 24]} />
            <meshStandardMaterial color="#51648c" metalness={0.5} roughness={0.2} transparent opacity={0.42} />
          </mesh>
          <mesh ref={fill} position={[-1.4, 0, 0]}>
            <boxGeometry args={[2.8, 0.55, 0.55]} />
            <meshBasicMaterial color="#ffb347" toneMapped={false} />
          </mesh>
        </group>
      );
    case 'external':
      return (
        <mesh position={[0, 1.2, 0]} castShadow>
          <icosahedronGeometry args={[1.05, 1]} />
          <meshStandardMaterial color="#6b5fa8" wireframe />
        </mesh>
      );
    default:
      return <Rack replicas={node.replicas ?? 1} light={setLight} />;
  }
}

function Beacon({ node }: { node: SystemNode }) {
  const ring = useRef<THREE.Mesh>(null!);
  const material = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame(({ clock }) => {
    const state = system()?.states.get(node.id);
    const selected = useStore.getState().selected === node.id;
    const degraded = Boolean(state && state.degraded !== 1);
    const down = Boolean(state?.down);
    ring.current.visible = down || degraded || selected;
    material.current.color.set(down ? '#ff3b4e' : degraded ? '#ffb347' : '#22d3ee');
    ring.current.scale.setScalar(down ? 1 + ((clock.elapsedTime * 0.8) % 1) * 0.5 : 1);
  });
  return (
    <mesh ref={ring} position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
      <ringGeometry args={[1.8, 1.95, 44]} />
      <meshBasicMaterial ref={material} toneMapped={false} transparent opacity={0.9} />
    </mesh>
  );
}

function Links({ spec, positions }: { spec: SystemSpec; positions: Map<string, THREE.Vector3> }) {
  const packets = useRef<THREE.InstancedMesh>(null!);
  const phase = useRef(0);
  const MAX = 420;
  const curves = useMemo(
    () =>
      spec.edges.map((e) => {
        const a = (positions.get(e.from) ?? new THREE.Vector3()).clone().setY(0.5);
        const b = (positions.get(e.to) ?? new THREE.Vector3()).clone().setY(0.5);
        const curve = new THREE.CubicBezierCurve3(a, new THREE.Vector3((a.x + b.x) / 2, 0.5, a.z), new THREE.Vector3((a.x + b.x) / 2, 0.5, b.z), b);
        return { curve, edge: e, geometry: new THREE.TubeGeometry(curve, 30, 0.035, 6) };
      }),
    [spec, positions],
  );

  useFrame((_, dt) => {
    const run = system();
    if (!run) return;
    if (runner.running) phase.current += dt * runner.speed * 0.45;
    let n = 0;
    for (const { curve, edge } of curves) {
      const flow = run.flows.get(edgeKey(edge)) ?? 0;
      if (flow <= 0.5 || n >= MAX) continue;
      const count = Math.min(14, Math.ceil(Math.sqrt(flow) / 3));
      const state = run.states.get(edge.to);
      const bad = state ? state.down || state.success < 0.9 : false;
      for (let i = 0; i < count && n < MAX; i++) {
        dummy.position.copy(curve.getPoint((phase.current + i / count) % 1));
        dummy.scale.setScalar(0.11);
        dummy.updateMatrix();
        packets.current.setMatrixAt(n, dummy.matrix);
        packets.current.setColorAt(n, color.set(bad ? '#ff4d5e' : (edge.mode ?? 'sync') === 'async' ? '#ffb347' : '#5eead4').multiplyScalar(1.8));
        n++;
      }
    }
    packets.current.count = n;
    packets.current.instanceMatrix.needsUpdate = true;
    if (packets.current.instanceColor) packets.current.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      {curves.map(({ geometry, edge }) => (
        <mesh key={edgeKey(edge)} geometry={geometry}>
          <meshStandardMaterial color={edge.optional ? '#475569' : '#64789c'} />
        </mesh>
      ))}
      <instancedMesh ref={packets} args={[undefined, undefined, MAX]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

export function Topology() {
  useStore((s) => s.structure);
  const run = system();
  const structure = useStore.getState().structure;
  const spec = useMemo(() => (run ? ({ ...run.spec } as SystemSpec) : null), [run, structure]);
  const positions = useMemo(() => (spec ? layout(spec) : new Map<string, THREE.Vector3>()), [spec]);
  if (!spec) return null;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow onClick={() => select(null)}>
        <planeGeometry args={[70, 44]} />
        <meshStandardMaterial color="#121a29" roughness={0.6} metalness={0.3} />
      </mesh>
      <Grid args={[70, 44]} cellSize={1} cellThickness={0.4} cellColor="#1f2c44" sectionSize={LAYER_GAP} sectionThickness={0.8} sectionColor="#2d3f5f" fadeDistance={110} />
      <Links spec={spec} positions={positions} />
      {spec.nodes.map((node) => {
        const at = positions.get(node.id);
        if (!at) return null;
        return (
          <group key={node.id} position={at} onClick={pick(node.id)}>
            <NodeBody node={node} />
            <Beacon node={node} />
            <Tag text={node.label ?? node.id} tint="#9fd8ff" y={3} />
            <ClaimPin id={node.id} position={[0, 1.6, 0]} />
          </group>
        );
      })}
    </group>
  );
}
