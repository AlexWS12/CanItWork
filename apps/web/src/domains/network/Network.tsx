import { useFrame } from '@react-three/fiber';
import { linkKey, netOrder, type NetRun, type NetSpec } from '@tv/core';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { LOOK } from '../../scene/look';
import { CHARACTERS, Packed, useInstancedModel } from '../../scene/Model';
import { Unknown } from '../../scene/Unknown';
import { useStore } from '../../store';
import { ClaimPin, Floor, Movable, Tag, pick, useArranged } from '../shared';
import { PACKED } from './packed';
import { PROPS } from './props';
import { NET_STYLES, styleOf, type Carrier } from './styles';

// The current run if it is a flow network; while the view switches kinds of system, the runner may already hold another
const net = () => {
  const run = runner.run as NetRun | null;
  return run && 'links' in run && 'states' in run ? run : null;
};
const LAYER_GAP = 8;
const ROW_GAP = 5.5;
const dummy = new THREE.Object3D();
const color = new THREE.Color();

const MAX_COLUMNS = 6;
/** How much larger than their footprint the models draw: the column gap leaves room, and bigger models read from further away. */
const MODEL_SCALE = 1.3;

/**
 * Columns by depth from the sources, so flow reads left to right. A long chain wraps into rows that snake back and forth,
 * so an eight-stage airport stays a screenful instead of one thin line.
 */
export function networkLayout(spec: NetSpec) {
  const depth = new Map<string, number>();
  for (const id of netOrder(spec)) {
    const incoming = spec.edges.filter((e) => e.to === id).map((e) => (depth.get(e.from) ?? 0) + 1);
    depth.set(id, Math.max(0, ...incoming));
  }
  const layers = new Map<number, string[]>();
  for (const [id, d] of depth) layers.set(d, [...(layers.get(d) ?? []), id]);
  const count = Math.max(0, ...layers.keys()) + 1;
  const rows = Math.ceil(count / MAX_COLUMNS);
  const perRow = Math.ceil(count / rows);
  // Each band of columns is as tall as its busiest column
  const heights = Array.from({ length: rows }, (_, r) => Math.max(1, ...[...layers].filter(([d]) => Math.floor(d / perRow) === r).map(([, ids]) => ids.length)) * ROW_GAP);
  const total = heights.reduce((a, b) => a + b, 0) + (rows - 1) * ROW_GAP;
  const positions = new Map<string, THREE.Vector3>();
  for (const [d, ids] of layers) {
    const row = Math.floor(d / perRow);
    const step = d % perRow;
    const column = row % 2 ? perRow - 1 - step : step;
    const top = -total / 2 + heights.slice(0, row).reduce((a, b) => a + b, 0) + row * ROW_GAP + heights[row] / 2;
    ids.forEach((id, i) => positions.set(id, new THREE.Vector3((column - (perRow - 1) / 2) * LAYER_GAP, 0, top + (i - (ids.length - 1) / 2) * ROW_GAP)));
  }
  return positions;
}

const health = (down: boolean, utilization: number) => (down ? '#ff3b4e' : utilization > 1 ? '#ff7a45' : utilization > 0.85 ? '#ffb347' : '#3fc48f');

// A soft disc that fades to nothing at its rim: health shows as light on the floor, not as a hard ring
const glowTexture = (() => {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
})();

/** Health as a glow under each node, an outline when selected, and a bar for work waiting there. */
function Status({ id }: { id: string }) {
  const glow = useRef<THREE.MeshBasicMaterial>(null!);
  const bar = useRef<THREE.Mesh>(null!);
  const outline = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    const run = net();
    const state = run?.states.get(id);
    const node = run?.node(id);
    if (!run || !state || !node) return;
    const down = state.down;
    glow.current.color.set(health(down, state.utilization));
    glow.current.opacity = down ? 0.55 + Math.sin(clock.elapsedTime * 6) * 0.3 : 0.4;
    const room = run.bufferOf(node) + (run.capacityOf(node) === Infinity ? 0 : run.capacityOf(node));
    const level = room > 0 ? Math.min(1, (state.queue + run.heldAt(id)) / room) : 0;
    bar.current.visible = level > 0.02;
    bar.current.scale.x = Math.max(0.02, level);
    bar.current.position.x = -1.2 + 1.2 * level;
    outline.current.visible = useStore.getState().selected === id;
  });
  return (
    <group>
      <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[5, 5]} />
        <meshBasicMaterial ref={glow} map={glowTexture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={outline} position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[2.15, 2.25, 56]} />
        <meshBasicMaterial color={LOOK.accent} toneMapped={false} />
      </mesh>
      <mesh ref={bar} position={[-1.2, 0.05, 2.1]}>
        <boxGeometry args={[2.4, 0.05, 0.16]} />
        <meshBasicMaterial color={LOOK.accent} toneMapped={false} />
      </mesh>
    </group>
  );
}

// What travels along the links, scaled to read at the size of the models
function CarrierGeometry({ carrier }: { carrier: Carrier }) {
  if (carrier === 'box') return <boxGeometry args={[0.3, 0.22, 0.3]} />;
  if (carrier === 'person') return <capsuleGeometry args={[0.09, 0.26, 3, 8]} />;
  return <sphereGeometry args={[0.12, 10, 8]} />;
}

// The people walking the paths (patients, passengers, callers): real characters, a few kinds mixed, each kind one draw
const WALKERS = CHARACTERS.slice(2, 5);
const WALKER_HEIGHT = 0.62;

function PackedLinks(props: { spec: NetSpec; positions: Map<string, THREE.Vector3>; flowTint: string; carrier: Carrier }) {
  const bodies = [useInstancedModel(WALKERS[0]), useInstancedModel(WALKERS[1]), useInstancedModel(WALKERS[2])];
  return <Links {...props} bodies={bodies} />;
}

function Links({
  spec,
  positions,
  flowTint,
  carrier,
  bodies,
}: {
  spec: NetSpec;
  positions: Map<string, THREE.Vector3>;
  flowTint: string;
  carrier: Carrier;
  bodies?: Array<ReturnType<typeof useInstancedModel>>;
}) {
  const packets = useRef<THREE.InstancedMesh>(null!);
  const walkers = useRef<Array<THREE.InstancedMesh | null>>([]);
  const tubes = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const phase = useRef(0);
  const MAX = 480;
  const lift = carrier === 'person' ? 0.22 : carrier === 'box' ? 0.15 : 0.5;
  const curves = useMemo(
    () =>
      spec.edges.map((e) => {
        const a = (positions.get(e.from) ?? new THREE.Vector3()).clone().setY(lift);
        const b = (positions.get(e.to) ?? new THREE.Vector3()).clone().setY(lift);
        const curve = new THREE.CubicBezierCurve3(a, new THREE.Vector3((a.x + b.x) / 2, lift, a.z), new THREE.Vector3((a.x + b.x) / 2, lift, b.z), b);
        const flat = carrier !== 'bead';
        return { curve, key: linkKey(e), geometry: new THREE.TubeGeometry(curve.clone(), 30, flat ? 0.22 : 0.05, flat ? 2 : 6) };
      }),
    [spec, positions, lift, carrier],
  );

  useFrame((_, dt) => {
    const run = net();
    if (!run) return;
    if (runner.running) phase.current += dt * runner.speed * 0.45;
    let peak = EPSILON;
    for (const link of run.links.values()) peak = Math.max(peak, link.flow);
    let n = 0;
    const counts = bodies ? bodies.map(() => 0) : [];
    curves.forEach(({ curve, key }, i) => {
      const link = run.links.get(key);
      const tube = tubes.current[i];
      if (tube) tube.color.set(link?.down ? '#ff3b4e' : '#4a515c');
      const flow = link?.flow ?? 0;
      if (!link || link.down || flow <= peak * 0.01) return;
      const count = Math.max(1, Math.round((flow / peak) * 10));
      for (let k = 0; k < count && n < MAX; k++) {
        const t = (phase.current + k / count) % 1;
        curve.getPoint(t, dummy.position);
        if (bodies) {
          // A character stands on the floor, facing the way it walks
          const v = n % bodies.length;
          const body = bodies[v];
          const k = WALKER_HEIGHT / body.size.y;
          dummy.position.y = WALKER_HEIGHT / 2;
          const ahead = curve.getPoint(Math.min(1, t + 0.01));
          ahead.y = dummy.position.y;
          dummy.lookAt(ahead);
          dummy.scale.set(body.size.x * k, body.size.y * k, body.size.z * k);
          dummy.updateMatrix();
          dummy.scale.set(1, 1, 1);
          walkers.current[v]?.setMatrixAt(counts[v]++, dummy.matrix);
          n++;
          continue;
        }
        if (carrier === 'person') dummy.position.y = 0.22;
        dummy.lookAt(curve.getPoint(Math.min(1, t + 0.01)));
        dummy.updateMatrix();
        packets.current.setMatrixAt(n, dummy.matrix);
        packets.current.setColorAt(n, color.set(flowTint).multiplyScalar(carrier === 'bead' ? 1.6 : 1));
        n++;
      }
    });
    if (bodies) {
      walkers.current.forEach((m, v) => {
        if (!m) return;
        m.count = counts[v];
        m.instanceMatrix.needsUpdate = true;
      });
      return;
    }
    packets.current.count = n;
    packets.current.instanceMatrix.needsUpdate = true;
    if (packets.current.instanceColor) packets.current.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      {curves.map(({ geometry, key }, i) => (
        <mesh key={key} geometry={geometry} onClick={pick(key)} receiveShadow>
          <meshStandardMaterial ref={(m) => void (tubes.current[i] = m)} color="#4a515c" roughness={0.9} />
        </mesh>
      ))}
      {bodies ? (
        bodies.map((body, v) => <instancedMesh key={v} ref={(m) => void (walkers.current[v] = m)} args={[body.geometry, body.material, MAX]} frustumCulled={false} castShadow />)
      ) : (
        <instancedMesh ref={packets} args={[undefined, undefined, MAX]} frustumCulled={false} castShadow={carrier !== 'bead'}>
          <CarrierGeometry carrier={carrier} />
          {carrier === 'bead' ? <meshBasicMaterial toneMapped={false} /> : <meshStandardMaterial roughness={0.6} />}
        </instancedMesh>
      )}
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
  // The floor reaches a little past the outermost nodes, wrapped rows included
  const xs = [...positions.values()].map((p) => p.x);
  const zs = [...positions.values()].map((p) => p.z);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  return (
    <group>
      <Floor position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]} width={Math.max(44, x1 - x0 + 26)} depth={Math.max(32, z1 - z0 + 22)} section={LAYER_GAP} />
      {style?.carrier === 'person' ? (
        <Packed fallback={<Links spec={spec} positions={positions} flowTint={style.flow} carrier="person" />}>
          <PackedLinks spec={spec} positions={positions} flowTint={style.flow} carrier="person" />
        </Packed>
      ) : (
        <Links spec={spec} positions={positions} flowTint={style?.flow ?? '#5eead4'} carrier={style?.carrier ?? 'bead'} />
      )}
      {spec.nodes.map((node) => {
        const at = positions.get(node.id);
        if (!at) return null;
        const look = styleOf(run.config.id, node.kind);
        // The pack-built model where there is one, else the code-built one
        const Model = look.prop === 'unknown' ? null : (PACKED[look.prop] ?? PROPS[look.prop]);
        return (
          <Movable key={node.id} id={node.id} position={at}>
            <group scale={MODEL_SCALE}>{Model ? <Model id={node.id} tint={look.color} /> : <Unknown size={[1.8, 1.4, 1.6]} quiet />}</group>
            <Status id={node.id} />
            <Tag text={Model ? (node.label ?? node.id) : `${node.label ?? node.id} · placeholder`} tint={Model ? '#c9d2dc' : LOOK.accent} y={3.9} />
            <ClaimPin id={node.id} />
          </Movable>
        );
      })}
    </group>
  );
}
