import { Grid } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { linkKey, netOrder, type NetRun, type NetSpec } from '@tv/core';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select, useStore } from '../../store';
import { Movable, Tag, pick, useArranged } from '../shared';
import { NET_STYLES, styleOf, type Shape } from './styles';

const net = () => runner.run as NetRun | null;
const LAYER_GAP = 8;
const ROW_GAP = 5.5;
const dummy = new THREE.Object3D();
const color = new THREE.Color();

/** Columns by depth from the sources, so flow reads left to right. */
export function networkLayout(spec: NetSpec) {
  const depth = new Map<string, number>();
  for (const id of netOrder(spec)) {
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

export function networkExtent(spec: NetSpec) {
  const positions = [...networkLayout(spec).values()];
  const xs = positions.map((p) => p.x);
  const zs = positions.map((p) => p.z);
  return { width: Math.max(...xs) - Math.min(...xs) + LAYER_GAP, depth: Math.max(...zs) - Math.min(...zs) + ROW_GAP };
}

const health = (down: boolean, utilization: number) => (down ? '#ff3b4e' : utilization > 1 ? '#ff7a45' : utilization > 0.85 ? '#ffb347' : '#2fd4c2');

function Body({ shape, tint }: { shape: Shape; tint: string }) {
  const metal = <meshStandardMaterial color={tint} metalness={0.55} roughness={0.4} />;
  switch (shape) {
    case 'stack':
      return (
        <group>
          <mesh position={[0, 0.7, 0]} castShadow>
            <boxGeometry args={[2.2, 1.4, 1.6]} />
            {metal}
          </mesh>
          <mesh position={[0.6, 2, 0]} castShadow>
            <cylinderGeometry args={[0.22, 0.3, 2.4, 16]} />
            {metal}
          </mesh>
        </group>
      );
    case 'tower':
      return (
        <mesh position={[0, 1.4, 0]} castShadow>
          <cylinderGeometry args={[0.7, 1.05, 2.8, 24]} />
          {metal}
        </mesh>
      );
    case 'panel':
      return (
        <group>
          {[-0.8, 0.8].map((x) => (
            <mesh key={x} position={[x, 0.6, 0]} rotation={[-0.6, 0, 0]} castShadow>
              <boxGeometry args={[1.4, 0.08, 1.6]} />
              <meshStandardMaterial color={tint} metalness={0.8} roughness={0.2} />
            </mesh>
          ))}
        </group>
      );
    case 'turbine':
      return (
        <group>
          <mesh position={[0, 1.6, 0]} castShadow>
            <cylinderGeometry args={[0.08, 0.14, 3.2, 10]} />
            {metal}
          </mesh>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[0, 3.2, 0.12]} rotation={[0, 0, (i * Math.PI * 2) / 3]}>
              <boxGeometry args={[0.12, 1.5, 0.04]} />
              {metal}
            </mesh>
          ))}
        </group>
      );
    case 'pylon':
      return (
        <group>
          {[-0.6, 0.6].map((x) => (
            <mesh key={x} position={[x, 1.2, 0]} castShadow>
              <boxGeometry args={[0.14, 2.4, 0.14]} />
              {metal}
            </mesh>
          ))}
          <mesh position={[0, 2.3, 0]} castShadow>
            <boxGeometry args={[2, 0.14, 0.14]} />
            {metal}
          </mesh>
          <mesh position={[0, 0.35, 0]} castShadow>
            <boxGeometry args={[1.6, 0.7, 1.2]} />
            <meshStandardMaterial color="#2b3750" metalness={0.6} roughness={0.4} />
          </mesh>
        </group>
      );
    case 'tank':
      return (
        <mesh position={[0, 0.6, 0]} castShadow>
          <cylinderGeometry args={[1.2, 1.2, 1.2, 32]} />
          {metal}
        </mesh>
      );
    case 'houses':
      return (
        <group>
          {[
            [-0.7, -0.5, 0.8],
            [0.6, -0.4, 1.1],
            [-0.2, 0.6, 0.9],
            [0.8, 0.7, 0.7],
          ].map(([x, z, h], i) => (
            <mesh key={i} position={[x, h / 2, z]} castShadow>
              <boxGeometry args={[0.7, h, 0.7]} />
              <meshStandardMaterial color={tint} roughness={0.7} />
            </mesh>
          ))}
        </group>
      );
    case 'plant':
      return (
        <group>
          <mesh position={[0, 0.65, 0]} castShadow>
            <boxGeometry args={[2.2, 1.3, 1.6]} />
            {metal}
          </mesh>
          <mesh position={[-0.6, 1.55, 0]} rotation={[0, 0, Math.PI / 4]}>
            <boxGeometry args={[0.6, 0.6, 1.6]} />
            {metal}
          </mesh>
        </group>
      );
    case 'crowd':
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
              <meshStandardMaterial color={tint} />
            </mesh>
          ))}
        </group>
      );
    case 'beds':
      return (
        <group>
          {[-0.75, 0, 0.75].map((x) => (
            <mesh key={x} position={[x, 0.3, 0]} castShadow>
              <boxGeometry args={[0.55, 0.3, 1.5]} />
              <meshStandardMaterial color={tint} roughness={0.6} />
            </mesh>
          ))}
        </group>
      );
    case 'strip':
      return (
        <group>
          <mesh position={[0, 0.06, 0]} receiveShadow>
            <boxGeometry args={[3.4, 0.1, 1]} />
            <meshStandardMaterial color={tint} roughness={0.9} />
          </mesh>
          <mesh position={[0, 0.12, 0]}>
            <boxGeometry args={[2.8, 0.02, 0.06]} />
            <meshBasicMaterial color="#e8eef6" toneMapped={false} />
          </mesh>
        </group>
      );
    case 'desk':
      return (
        <group>
          {[-0.6, 0.6].map((x) => (
            <group key={x} position={[x, 0, 0]}>
              <mesh position={[0, 0.45, 0]} castShadow>
                <boxGeometry args={[0.9, 0.08, 0.7]} />
                {metal}
              </mesh>
              <mesh position={[0, 0.75, -0.2]}>
                <boxGeometry args={[0.5, 0.35, 0.04]} />
                <meshStandardMaterial color="#1b2436" emissive={tint} emissiveIntensity={0.4} />
              </mesh>
            </group>
          ))}
        </group>
      );
    case 'dock':
      return (
        <group>
          <mesh position={[0, 0.5, 0]} castShadow>
            <boxGeometry args={[2.2, 1, 1.6]} />
            {metal}
          </mesh>
          {[-0.6, 0, 0.6].map((x) => (
            <mesh key={x} position={[x, 0.4, 0.81]}>
              <boxGeometry args={[0.45, 0.6, 0.02]} />
              <meshStandardMaterial color="#1b2436" />
            </mesh>
          ))}
        </group>
      );
    case 'ship':
      return (
        <group>
          <mesh position={[0, 0.3, 0]} castShadow>
            <boxGeometry args={[2.6, 0.5, 1]} />
            {metal}
          </mesh>
          {[-0.7, -0.2, 0.3].map((x, i) => (
            <mesh key={x} position={[x, 0.75, 0]} castShadow>
              <boxGeometry args={[0.45, 0.4, 0.8]} />
              <meshStandardMaterial color={['#c9734b', '#4b8fc9', '#c9b24b'][i]} />
            </mesh>
          ))}
        </group>
      );
    default:
      return (
        <mesh position={[0, 0.6, 0]} castShadow>
          <boxGeometry args={[1.6, 1.2, 1.4]} />
          {metal}
        </mesh>
      );
  }
}

/** Health ring under each node, and a bar for work waiting there. */
function Status({ id }: { id: string }) {
  const ring = useRef<THREE.MeshBasicMaterial>(null!);
  const bar = useRef<THREE.Mesh>(null!);
  const outline = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    const run = net();
    const state = run?.states.get(id);
    const node = run?.node(id);
    if (!run || !state || !node) return;
    const down = state.down;
    ring.current.color.set(health(down, state.utilization)).multiplyScalar(down ? 1.4 + Math.sin(clock.elapsedTime * 6) * 0.5 : 1.6);
    const room = run.bufferOf(node) + (run.capacityOf(node) === Infinity ? 0 : run.capacityOf(node));
    const level = room > 0 ? Math.min(1, (state.queue + run.heldAt(id)) / room) : 0;
    bar.current.visible = level > 0.02;
    bar.current.scale.x = Math.max(0.02, level);
    bar.current.position.x = -1.1 + 1.1 * level;
    outline.current.visible = useStore.getState().selected === id;
  });
  return (
    <group>
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.75, 1.95, 44]} />
        <meshBasicMaterial ref={ring} toneMapped={false} />
      </mesh>
      <mesh ref={outline} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[2.05, 2.2, 44]} />
        <meshBasicMaterial color="#22d3ee" toneMapped={false} />
      </mesh>
      <mesh ref={bar} position={[-1.1, 0.05, 2.25]}>
        <boxGeometry args={[2.2, 0.06, 0.22]} />
        <meshBasicMaterial color="#ffb347" toneMapped={false} />
      </mesh>
    </group>
  );
}

function Links({ spec, positions, flowTint }: { spec: NetSpec; positions: Map<string, THREE.Vector3>; flowTint: string }) {
  const packets = useRef<THREE.InstancedMesh>(null!);
  const tubes = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const phase = useRef(0);
  const MAX = 480;
  const curves = useMemo(
    () =>
      spec.edges.map((e) => {
        const a = (positions.get(e.from) ?? new THREE.Vector3()).clone().setY(0.5);
        const b = (positions.get(e.to) ?? new THREE.Vector3()).clone().setY(0.5);
        const curve = new THREE.CubicBezierCurve3(a, new THREE.Vector3((a.x + b.x) / 2, 0.5, a.z), new THREE.Vector3((a.x + b.x) / 2, 0.5, b.z), b);
        return { curve, key: linkKey(e), geometry: new THREE.TubeGeometry(curve, 30, 0.05, 6) };
      }),
    [spec, positions],
  );

  useFrame((_, dt) => {
    const run = net();
    if (!run) return;
    if (runner.running) phase.current += dt * runner.speed * 0.45;
    const peak = Math.max(EPSILON, ...[...run.links.values()].map((l) => l.flow));
    let n = 0;
    curves.forEach(({ curve, key }, i) => {
      const link = run.links.get(key);
      const tube = tubes.current[i];
      if (tube) tube.color.set(link?.down ? '#ff3b4e' : '#64789c');
      const flow = link?.flow ?? 0;
      if (!link || link.down || flow <= peak * 0.01) return;
      const count = Math.max(1, Math.round((flow / peak) * 10));
      for (let k = 0; k < count && n < MAX; k++) {
        dummy.position.copy(curve.getPoint((phase.current + k / count) % 1));
        dummy.scale.setScalar(0.12);
        dummy.updateMatrix();
        packets.current.setMatrixAt(n, dummy.matrix);
        packets.current.setColorAt(n, color.set(flowTint).multiplyScalar(1.6));
        n++;
      }
    });
    packets.current.count = n;
    packets.current.instanceMatrix.needsUpdate = true;
    if (packets.current.instanceColor) packets.current.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      {curves.map(({ geometry, key }, i) => (
        <mesh key={key} geometry={geometry} onClick={pick(key)}>
          <meshStandardMaterial ref={(m) => void (tubes.current[i] = m)} color="#64789c" />
        </mesh>
      ))}
      <instancedMesh ref={packets} args={[undefined, undefined, MAX]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

const EPSILON = 1e-6;

export function Network() {
  useStore((s) => s.structure);
  const run = net();
  const structure = useStore.getState().structure;
  const spec = useMemo(() => (run ? ({ ...run.spec, edges: [...run.spec.edges] } as NetSpec) : null), [run, structure]);
  const positions = useArranged(useMemo(() => (spec ? networkLayout(spec) : new Map<string, THREE.Vector3>()), [spec]));
  if (!spec || !run) return null;
  const style = NET_STYLES[run.config.id];
  const width = Math.max(70, positions.size * 4);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow onClick={() => select(null)}>
        <planeGeometry args={[width, 48]} />
        <meshStandardMaterial color="#121a29" roughness={0.6} metalness={0.3} />
      </mesh>
      <Grid args={[width, 48]} cellSize={1} cellThickness={0.4} cellColor="#1f2c44" sectionSize={LAYER_GAP} sectionThickness={0.8} sectionColor="#2d3f5f" fadeDistance={110} />
      <Links spec={spec} positions={positions} flowTint={style?.flow ?? '#5eead4'} />
      {spec.nodes.map((node) => {
        const at = positions.get(node.id);
        if (!at) return null;
        const look = styleOf(run.config.id, node.kind);
        return (
          <Movable key={node.id} id={node.id} position={at}>
            <Body shape={look.shape} tint={look.color} />
            <Status id={node.id} />
            <Tag text={node.label ?? node.id} tint="#9fd8ff" y={3.4} />
          </Movable>
        );
      })}
    </group>
  );
}
