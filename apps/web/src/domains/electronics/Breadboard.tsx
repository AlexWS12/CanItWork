import { useFrame } from '@react-three/fiber';
import { pinsOf, type CircuitRun, type CircuitSpec, type Part } from '@tv/core';
import { useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select } from '../../store';
import { PITCH, PackageBody, dipRows } from './Packages';

// A real breadboard: chips straddle the centre channel, leads go into holes, and each wire of the spec is a jumper between holes.
// Each 5-hole column strip is one electrical node, so a lead placed in a chip pin's strip needs no wire at all.

const circuit = () => runner.run as CircuitRun | null;
const LED_COLORS = { red: '#ff3b3b', yellow: '#ffd24a', green: '#3dff7a', blue: '#4aa3ff', white: '#ffffff' };
const JUMPER_COLORS = ['#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#eab308', '#ec4899', '#14b8a6', '#f97316'];
const REACH = 7;
const CHIP_GAP = 3;

type Half = 'A' | 'B';
type Rail = '+' | '-';
export type Spot = { kind: 'strip'; col: number; half: Half; row: number } | { kind: 'rail'; col: number; side: 'top' | 'bottom'; rail: Rail };

const zA = (row: number) => -0.375 - (4 - row) * PITCH;
const zB = (row: number) => 0.375 + row * PITCH;
const RAIL_Z = { top: { '+': zA(0) - 0.55, '-': zA(0) - 0.85 }, bottom: { '+': zB(4) + 0.55, '-': zB(4) + 0.85 } } as const;

export const LEADED = (part: Part) =>
  ['resistor', 'led', 'capacitor', 'button', 'switch', 'buzzer'].includes(part.type) ||
  (part.type === 'custom' && ['axial', 'radial', 'to92', 'pot'].includes(part.package ?? '') && pinsOf(part).length <= 3);
export const STRADDLES = (part: Part) => part.type === 'custom' && (part.package === 'dip' || part.package === 'module') && pinsOf(part).length >= 4;

export interface BoardLayout {
  columns: number;
  x0: number;
  spots: Map<string, Spot>;
  chips: Map<string, { col: number; half: number }>;
  offBoard: Map<string, [number, number]>;
  wireEnds: Array<[Spot | string, Spot | string] | null>;
  supply: Map<string, Rail>;
  railsUsed: Set<string>;
}

class Nets {
  private parent = new Map<string, string>();
  find(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(key, root);
    return root;
  }
  join(a: string, b: string) {
    this.parent.set(this.find(a), this.find(b));
  }
}

export function layoutBreadboard(spec: CircuitSpec): BoardLayout {
  const nets = new Nets();
  for (const w of spec.wires) nets.join(w.from, w.to);
  const supplyPart =
    spec.parts.find((p) => p.type === 'battery') ?? spec.parts.find((p) => p.type === 'arduino') ?? spec.parts.find((p) => p.custom?.sources.length && !STRADDLES(p));
  const supply = new Map<string, Rail>();
  if (supplyPart) {
    const [pos, neg] =
      supplyPart.type === 'battery' ? ['pos', 'neg'] : supplyPart.type === 'arduino' ? ['5V', 'GND'] : [supplyPart.custom!.sources[0].pos, supplyPart.custom!.sources[0].neg];
    supply.set(nets.find(`${supplyPart.id}.${pos}`), '+');
    supply.set(nets.find(`${supplyPart.id}.${neg}`), '-');
  }
  // Without a battery, a straddling board's own ground and 3V3 feed the rails.
  if (!supplyPart) {
    const board = spec.parts.find((p) => STRADDLES(p) && p.custom?.sources.length);
    const source = board?.custom?.sources[0];
    if (board && source) {
      supply.set(nets.find(`${board.id}.${source.pos}`), '+');
      supply.set(nets.find(`${board.id}.${source.neg}`), '-');
    }
  }

  const spots = new Map<string, Spot>();
  const strips = new Map<string, { net: string; used: number }>();
  const anchors = new Map<string, Array<{ col: number; half: Half }>>();
  const stripKey = (col: number, half: Half) => `${col}${half}`;
  const claim = (col: number, half: Half, net: string, row?: number): Spot => {
    const key = stripKey(col, half);
    const strip = strips.get(key) ?? { net, used: 0 };
    strips.set(key, strip);
    const order = half === 'A' ? [4, 3, 2, 1, 0] : [0, 1, 2, 3, 4];
    const r = row ?? order[Math.min(4, strip.used)];
    strip.used++;
    const list = anchors.get(net) ?? [];
    if (!list.some((a) => a.col === col && a.half === half)) list.push({ col, half });
    anchors.set(net, list);
    return { kind: 'strip', col, half, row: r };
  };

  const chips = new Map<string, { col: number; half: number }>();
  let cursor = 2;
  for (const part of spec.parts.filter(STRADDLES)) {
    const { near, far, half } = dipRows(part);
    chips.set(part.id, { col: cursor, half });
    near.forEach((pin, i) => spots.set(`${part.id}.${pin}`, claim(cursor + i, 'B', nets.find(`${part.id}.${pin}`), 0)));
    far.forEach((pin, i) => spots.set(`${part.id}.${pin}`, claim(cursor + i, 'A', nets.find(`${part.id}.${pin}`), 4)));
    cursor += half + CHIP_GAP;
  }

  const free = (col: number, half: Half) => col >= 1 && !strips.has(stripKey(col, half));
  const nearestFree = (around: number, half: Half, avoid = -1): number => {
    for (let d = 0; d < 200; d++) {
      for (const col of [around + d, around - d]) if (col !== avoid && free(col, half)) return col;
    }
    return around;
  };
  const sideOf = (half: Half) => (half === 'A' ? 'top' : 'bottom');

  let flip = 0;
  for (const part of spec.parts.filter(LEADED)) {
    const pins = pinsOf(part);
    if (pins.length === 3) {
      const half: Half = flip++ % 2 ? 'A' : 'B';
      let col: number = nearestFree(cursor, half);
      while (!free(col + 1, half) || !free(col + 2, half)) col = nearestFree(col + 1, half);
      pins.forEach((pin, i) => spots.set(`${part.id}.${pin}`, claim(col + i, half, nets.find(`${part.id}.${pin}`))));
      cursor = Math.max(cursor, col + 4);
      continue;
    }
    let ref: { col: number; half: Half } | null = null;
    // Place the lead that already has a home first, so the part sits next to the chip it serves.
    const ordered = [...pins].sort((a, b) => Number(anchors.has(nets.find(`${part.id}.${b}`))) - Number(anchors.has(nets.find(`${part.id}.${a}`))));
    for (const pin of ordered) {
      const key = `${part.id}.${pin}`;
      const net = nets.find(key);
      const rail = supply.get(net);
      if (rail && ref) {
        spots.set(key, { kind: 'rail', col: ref.col, side: sideOf(ref.half), rail });
        continue;
      }
      const home = (anchors.get(net) ?? []).find(
        (a) => (strips.get(stripKey(a.col, a.half))?.used ?? 5) < 5 && (!ref || (Math.abs(a.col - ref.col) <= REACH && !(a.col === ref.col && a.half === ref.half))),
      );
      if (home && !rail) {
        spots.set(key, claim(home.col, home.half, net));
        ref = home;
        continue;
      }
      const half: Half = ref?.half ?? (flip++ % 2 ? 'A' : 'B');
      const col: number = ref ? nearestFree(ref.col + 2, half, ref.col) : nearestFree(cursor, half);
      spots.set(key, claim(col, half, net));
      if (!ref) cursor = Math.max(cursor, col + 1);
      ref = { col, half };
    }
  }

  const used = [...strips.keys()].map((k) => parseInt(k, 10));
  const columns = Math.max(30, Math.max(0, ...used) + 4);
  const x0 = -((columns - 1) * PITCH) / 2;

  const offBoard = new Map<string, [number, number]>();
  let ox = x0 + 0.6;
  for (const part of spec.parts.filter((p) => !LEADED(p) && !STRADDLES(p))) {
    const width = part.type === 'arduino' ? 7.6 : part.custom && pinsOf(part).length > 8 ? 3.4 : 2.8;
    offBoard.set(part.id, [ox + width / 2, RAIL_Z.top['-'] - 2.6 - (part.type === 'arduino' ? 1.6 : 0)]);
    ox += width + 0.6;
  }

  const railsUsed = new Set<string>();
  const resolve = (key: string, other: string): Spot | string => {
    const spot = spots.get(key);
    if (spot) return spot;
    const rail = supply.get(nets.find(key));
    if (!rail) return key;
    const near = spots.get(other);
    const side = near?.kind === 'strip' ? sideOf(near.half) : near?.kind === 'rail' ? near.side : 'top';
    return { kind: 'rail', col: near ? near.col : 0, side, rail };
  };
  const same = (a: Spot | string, b: Spot | string) =>
    typeof a !== 'string' &&
    typeof b !== 'string' &&
    ((a.kind === 'strip' && b.kind === 'strip' && a.col === b.col && a.half === b.half) || (a.kind === 'rail' && b.kind === 'rail' && a.side === b.side && a.rail === b.rail));
  const wireEnds = spec.wires.map((w) => {
    let a = resolve(w.from, w.to);
    let b = resolve(w.to, w.from);
    // A jumper from a strip lands in the next free hole of that strip, not on the lead already there.
    const hole = (s: Spot | string) => (typeof s !== 'string' && s.kind === 'strip' ? claim(s.col, s.half, strips.get(stripKey(s.col, s.half))!.net) : s);
    for (const s of [a, b]) if (typeof s !== 'string' && s.kind === 'rail') railsUsed.add(`${s.side}${s.rail}`);
    if (same(a, b) || (typeof a === 'string' && typeof b === 'string' && false)) return null;
    a = hole(a);
    b = hole(b);
    return [a, b] as [Spot | string, Spot | string];
  });
  for (const s of spots.values()) if (s.kind === 'rail') railsUsed.add(`${s.side}${s.rail}`);
  return { columns, x0, spots, chips, offBoard, wireEnds, supply, railsUsed };
}

export function spotPosition(layout: BoardLayout, spot: Spot, lift = 0.06) {
  const x = layout.x0 + spot.col * PITCH;
  if (spot.kind === 'rail') return new THREE.Vector3(x, lift, RAIL_Z[spot.side][spot.rail]);
  return new THREE.Vector3(x, lift, spot.half === 'A' ? zA(spot.row) : zB(spot.row));
}

export function breadboardExtent(spec: CircuitSpec) {
  const layout = layoutBreadboard(spec);
  const width = layout.columns * PITCH + 1;
  const offRow = layout.offBoard.size ? 4.6 : 0;
  const right = Math.max(width / 2, ...[...layout.offBoard.values()].map(([x]) => x + 2));
  return { width: Math.max(width, right * 2), depth: 6.2 + offRow, centerX: 0, centerZ: -offRow / 2 };
}

function Holes({ layout }: { layout: BoardLayout }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const points = useMemo(() => {
    const out: THREE.Vector3[] = [];
    for (let c = 0; c < layout.columns; c++) {
      for (let r = 0; r < 5; r++) {
        out.push(spotPosition(layout, { kind: 'strip', col: c, half: 'A', row: r }, 0.181));
        out.push(spotPosition(layout, { kind: 'strip', col: c, half: 'B', row: r }, 0.181));
      }
      if (c % 6 !== 5) {
        for (const side of ['top', 'bottom'] as const) for (const rail of ['+', '-'] as const) out.push(spotPosition(layout, { kind: 'rail', col: c, side, rail }, 0.181));
      }
    }
    return out;
  }, [layout]);
  useFrame(() => {
    if (!mesh.current || mesh.current.userData.done) return;
    const o = new THREE.Object3D();
    o.rotation.x = -Math.PI / 2;
    points.forEach((p, i) => {
      o.position.copy(p);
      o.updateMatrix();
      mesh.current.setMatrixAt(i, o.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    mesh.current.userData.done = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, points.length]} key={points.length}>
      <planeGeometry args={[0.09, 0.09]} />
      <meshBasicMaterial color="#3b3f46" />
    </instancedMesh>
  );
}

function BoardBody({ layout }: { layout: BoardLayout }) {
  const width = layout.columns * PITCH + 0.5;
  const railLine = (side: 'top' | 'bottom', rail: Rail) => {
    const z = RAIL_Z[side][rail] + (side === 'top' ? -1 : 1) * (rail === '-' ? 0.17 : -0.17) * (side === 'top' ? -1 : 1);
    return (
      <mesh key={`${side}${rail}`} position={[0, 0.182, z + (rail === '+' ? (side === 'top' ? 0.17 : -0.17) : side === 'top' ? -0.17 : 0.17)]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width - 0.4, 0.03]} />
        <meshBasicMaterial color={rail === '+' ? '#dc2626' : '#2563eb'} />
      </mesh>
    );
  };
  return (
    <group>
      <mesh position={[0, 0.09, 0]} receiveShadow castShadow onClick={(e) => (e.stopPropagation(), select(null))}>
        <boxGeometry args={[width, 0.18, RAIL_Z.bottom['-'] - RAIL_Z.top['-'] + 0.6]} />
        <meshStandardMaterial color="#eceae4" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.183, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width - 0.2, 0.28]} />
        <meshStandardMaterial color="#d6d3cb" roughness={0.9} />
      </mesh>
      {(['top', 'bottom'] as const).flatMap((side) => (['+', '-'] as const).map((rail) => railLine(side, rail)))}
      <Holes layout={layout} />
    </group>
  );
}

function Segment({ from, to, radius = 0.025, color = '#c8d0da' }: { from: THREE.Vector3; to: THREE.Vector3; radius?: number; color?: string }) {
  const { position, quaternion, length } = useMemo(() => {
    const dir = to.clone().sub(from);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return { position: from.clone().add(to).multiplyScalar(0.5), quaternion: q, length: dir.length() };
  }, [from, to]);
  return (
    <mesh position={position} quaternion={quaternion}>
      <cylinderGeometry args={[radius, radius, Math.max(0.001, length), 6]} />
      <meshStandardMaterial color={color} metalness={0.8} roughness={0.3} />
    </mesh>
  );
}

function LeadedBody({ part }: { part: Part }) {
  const glow = useRef<THREE.MeshStandardMaterial>(null);
  const lever = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const run = circuit();
    if (!run) return;
    if (glow.current && part.type === 'led') {
      const dead = run.burned.has(part.id);
      glow.current.emissiveIntensity = dead ? 0 : Math.min(7, (run.readings.get(part.id)?.amps ?? 0) * 500);
      glow.current.color.set(dead ? '#111' : LED_COLORS[part.color ?? 'red']);
    }
    if (lever.current) {
      const on = (run.values.get(part.id) ?? 0) >= 0.5;
      lever.current.position.x = THREE.MathUtils.damp(lever.current.position.x, on ? 0.09 : -0.09, 14, 1 / 60);
      lever.current.position.y = part.type === 'button' ? (on ? 0.36 : 0.42) : 0.42;
    }
  });
  switch (part.type) {
    case 'led': {
      const color = LED_COLORS[part.color ?? 'red'];
      return (
        <group>
          <mesh position={[0, 0.62, 0]} castShadow>
            <sphereGeometry args={[0.17, 20, 14]} />
            <meshStandardMaterial ref={glow} color={color} emissive={color} roughness={0.2} transparent opacity={0.9} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0.5, 0]} castShadow>
            <cylinderGeometry args={[0.17, 0.19, 0.24, 20]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.15} transparent opacity={0.85} roughness={0.2} />
          </mesh>
        </group>
      );
    }
    case 'resistor':
      return (
        <group>
          <mesh position={[0, 0.34, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <capsuleGeometry args={[0.08, 0.32, 4, 12]} />
            <meshStandardMaterial color="#d8be90" roughness={0.6} />
          </mesh>
          {[-0.12, -0.04, 0.04, 0.14].map((x, i) => (
            <mesh key={x} position={[x, 0.34, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.085, 0.085, 0.035, 12]} />
              <meshStandardMaterial color={['#7c2d12', '#111827', '#dc2626', '#c9a227'][i]} />
            </mesh>
          ))}
        </group>
      );
    case 'capacitor':
      return (part.farads ?? 1e-4) >= 1e-6 ? (
        <group>
          <mesh position={[0, 0.55, 0]} castShadow>
            <cylinderGeometry args={[0.2, 0.2, 0.55, 20]} />
            <meshStandardMaterial color="#1e3a8a" roughness={0.4} />
          </mesh>
          <mesh position={[0.15, 0.55, 0]}>
            <boxGeometry args={[0.08, 0.52, 0.16]} />
            <meshStandardMaterial color="#cbd5e1" />
          </mesh>
        </group>
      ) : (
        <mesh position={[0, 0.4, 0]} castShadow>
          <sphereGeometry args={[0.14, 16, 12]} />
          <meshStandardMaterial color="#d97706" roughness={0.5} />
        </mesh>
      );
    case 'switch':
      return (
        <group>
          <mesh position={[0, 0.3, 0]} castShadow>
            <boxGeometry args={[0.42, 0.2, 0.2]} />
            <meshStandardMaterial color="#1f2937" roughness={0.5} />
          </mesh>
          <mesh ref={lever} position={[-0.09, 0.42, 0]} castShadow>
            <boxGeometry args={[0.1, 0.14, 0.1]} />
            <meshStandardMaterial color="#f8fafc" roughness={0.4} />
          </mesh>
        </group>
      );
    case 'button':
      return (
        <group>
          <mesh position={[0, 0.28, 0]} castShadow>
            <boxGeometry args={[0.36, 0.16, 0.36]} />
            <meshStandardMaterial color="#1f2937" roughness={0.5} />
          </mesh>
          <mesh ref={lever} position={[0, 0.42, 0]} castShadow>
            <cylinderGeometry args={[0.11, 0.11, 0.14, 16]} />
            <meshStandardMaterial color="#e11d48" roughness={0.4} />
          </mesh>
        </group>
      );
    case 'buzzer':
      return (
        <mesh position={[0, 0.4, 0]} castShadow>
          <cylinderGeometry args={[0.3, 0.3, 0.32, 24]} />
          <meshStandardMaterial color="#14171f" roughness={0.4} />
        </mesh>
      );
    default:
      return <PackageBody part={part} />;
  }
}

// A leaded part sits above the midpoint of its holes, its legs bent down into them.
function Leaded({ part, holes, onPick }: { part: Part; holes: THREE.Vector3[]; onPick: (e: { stopPropagation: () => void }) => void }) {
  const { mid, angle, legs } = useMemo(() => {
    const m = holes.reduce((a, h) => a.add(h), new THREE.Vector3()).multiplyScalar(1 / holes.length);
    const a = holes[0];
    const b = holes[holes.length - 1];
    const ang = Math.atan2(-(b.z - a.z), b.x - a.x);
    const standing = part.type === 'led' || part.type === 'capacitor' || part.type === 'switch' || part.type === 'button' || part.type === 'buzzer' || holes.length === 3;
    const legTop = standing ? 0.4 : 0.34;
    const span = standing ? 0.08 : 0.2;
    const dir = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang));
    return {
      mid: m,
      angle: ang,
      legs: holes.map((h, i) => {
        const offset = holes.length === 3 ? (i - 1) * 0.1 : (i === 0 ? -1 : 1) * span;
        const top = m.clone().add(dir.clone().multiplyScalar(offset)).setY(legTop);
        return { h: h.clone().setY(0.18), knee: h.clone().setY(legTop), top };
      }),
    };
  }, [holes, part.type]);
  return (
    <group onClick={onPick}>
      {legs.map((l, i) => (
        <group key={i}>
          <Segment from={l.h} to={l.knee} />
          <Segment from={l.knee} to={l.top} />
        </group>
      ))}
      <group position={[mid.x, 0, mid.z]} rotation={[0, angle, 0]}>
        <LeadedBody part={part} />
      </group>
    </group>
  );
}

export function BoardParts({
  spec,
  layout,
  decorate,
  onPart,
}: {
  spec: CircuitSpec;
  layout: BoardLayout;
  decorate: (part: Part, at: THREE.Vector3, size: number) => ReactNode;
  onPart: (part: Part) => void;
}) {
  const pickOrToggle = (part: Part) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    select(part.id);
    onPart(part);
  };
  return (
    <group>
      <BoardBody layout={layout} />
      {spec.parts.filter(STRADDLES).map((part) => {
        const chip = layout.chips.get(part.id)!;
        const x = layout.x0 + (chip.col + (chip.half - 1) / 2) * PITCH;
        const at = new THREE.Vector3(x, 0.08, 0);
        return (
          <group key={part.id}>
            <group position={at} onClick={pickOrToggle(part)}>
              <PackageBody part={part} />
            </group>
            {decorate(part, at, 1 + chip.half * 0.12)}
          </group>
        );
      })}
      {spec.parts.filter(LEADED).map((part) => {
        const holes = pinsOf(part).map((pin) => {
          const spot = layout.spots.get(`${part.id}.${pin}`);
          return spot ? spotPosition(layout, spot) : new THREE.Vector3();
        });
        const mid = holes.reduce((a, h) => a.clone().add(h), new THREE.Vector3()).multiplyScalar(1 / holes.length);
        return (
          <group key={part.id}>
            <Leaded part={part} holes={holes} onPick={pickOrToggle(part)} />
            {decorate(part, mid, 0.55)}
          </group>
        );
      })}
    </group>
  );
}

export function jumperColor(from: string, to: string, i: number, layout: BoardLayout, ends: [Spot | string, Spot | string]) {
  const rail = ends.find((e): e is Extract<Spot, { kind: 'rail' }> => typeof e !== 'string' && e.kind === 'rail');
  if (rail) return rail.rail === '+' ? '#ef4444' : '#1f2937';
  if (/\.(GND|neg)$/.test(from) || /\.(GND|neg)$/.test(to)) return '#1f2937';
  return JUMPER_COLORS[i % JUMPER_COLORS.length];
}
