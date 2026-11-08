import { useFrame } from '@react-three/fiber';
import {
  BOARD_COLUMNS,
  LEADED,
  STRADDLES,
  boardOf,
  layoutBreadboard as layoutCore,
  localColumn,
  pinsOf,
  type BoardLayout as CoreLayout,
  type CircuitRun,
  type CircuitSpec,
  type Part,
  type Spot,
} from '@tv/core';
import { useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select } from '../../store';
import { PITCH, PackageBody, SevenSegment, SmallPart } from './Packages';

// Draws the core breadboard layout: the board, its holes, the parts in them and the jumpers between them.

const circuit = () => runner.run as CircuitRun | null;
const LED_COLORS = { red: '#ff3b3b', yellow: '#ffd24a', green: '#3dff7a', blue: '#4aa3ff', white: '#ffffff' };
const JUMPER_COLORS = ['#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#eab308', '#ec4899', '#14b8a6', '#f97316'];

type Rail = '+' | '-';
export type { Spot };

const zA = (row: number) => -0.375 - (4 - row) * PITCH;
const zB = (row: number) => 0.375 + row * PITCH;
const RAIL_Z = { top: { '+': zA(0) - 0.55, '-': zA(0) - 0.85 }, bottom: { '+': zB(4) + 0.55, '-': zB(4) + 0.85 } } as const;

const BOARD_DEPTH = RAIL_Z.bottom['-'] - RAIL_Z.top['-'] + 0.6;
const BOARD_GAP = { x: 1.4, z: 1.8 };

export interface BoardLayout extends Omit<CoreLayout, 'offBoard'> {
  x0: number;
  offBoard: Map<string, [number, number]>;
  /** Where each board sits: a big circuit spreads over full-size boards in a grid, wired together by their rails. */
  origins: Array<[number, number]>;
  boardColumns: number;
}

// A circuit that fits one board keeps a board sized to it; a bigger one uses full-size 63-column boards, two to a row so the stage between the panels frames them.
function grid(boards: number, columns: number) {
  if (boards === 1) return { boardColumns: columns, origins: [[0, 0]] as Array<[number, number]> };
  const perRow = 2;
  const rows = Math.ceil(boards / perRow);
  const width = BOARD_COLUMNS * PITCH + 0.5;
  const origins = Array.from({ length: boards }, (_, b): [number, number] => {
    const inRow = Math.min(perRow, boards - Math.floor(b / perRow) * perRow);
    return [((b % perRow) - (inRow - 1) / 2) * (width + BOARD_GAP.x), (Math.floor(b / perRow) - (rows - 1) / 2) * (BOARD_DEPTH + BOARD_GAP.z)];
  });
  return { boardColumns: BOARD_COLUMNS, origins };
}

export function layoutBreadboard(spec: CircuitSpec): BoardLayout {
  const core = layoutCore(spec);
  const { boardColumns, origins } = grid(core.boards, core.columns);
  const x0 = -((boardColumns - 1) * PITCH) / 2;
  const offBoard = new Map<string, [number, number]>();
  // Supplies and boards sit above the first board.
  let ox = origins[0][0] + x0 + 0.6;
  for (const id of core.offBoard) {
    const part = spec.parts.find((p) => p.id === id)!;
    const width = part.type === 'arduino' ? 7.6 : part.custom && pinsOf(part).length > 8 ? 3.4 : 2.8;
    offBoard.set(id, [ox + width / 2, origins[0][1] + RAIL_Z.top['-'] - 2.6 - (part.type === 'arduino' ? 1.6 : 0)]);
    ox += width + 0.6;
  }
  return { ...core, x0, offBoard, origins, boardColumns };
}

// Where a column sits: its board's origin plus its place along that board.
function columnAt(layout: BoardLayout, col: number) {
  const multi = layout.origins.length > 1;
  const [ox, oz] = layout.origins[multi ? Math.min(layout.origins.length - 1, boardOf(col)) : 0];
  return { x: ox + layout.x0 + (multi ? localColumn(col) : col) * PITCH, z: oz };
}

export function spotPosition(layout: BoardLayout, spot: Spot, lift = 0.06) {
  const { x, z } = columnAt(layout, spot.col);
  if (spot.kind === 'rail') return new THREE.Vector3(x, lift, z + RAIL_Z[spot.side][spot.rail]);
  return new THREE.Vector3(x, lift, z + (spot.half === 'A' ? zA(spot.row) : zB(spot.row)));
}

export function breadboardExtent(spec: CircuitSpec) {
  const layout = layoutBreadboard(spec);
  const width = layout.boardColumns * PITCH + 1;
  const xs = layout.origins.map(([x]) => x);
  const zs = layout.origins.map(([, z]) => z);
  const span = Math.max(...xs) - Math.min(...xs) + width;
  const offRow = layout.offBoard.size ? 4.6 : 0;
  const right = Math.max(span / 2, ...[...layout.offBoard.values()].map(([x]) => x + 2));
  return { width: Math.max(span, right * 2), depth: Math.max(...zs) - Math.min(...zs) + 6.2 + offRow, centerX: 0, centerZ: -offRow / 2 };
}

function Holes({ layout, board }: { layout: BoardLayout; board: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const points = useMemo(() => {
    const out: THREE.Vector3[] = [];
    const first = layout.origins.length > 1 ? board * BOARD_COLUMNS : 0;
    for (let c = first; c < first + layout.boardColumns; c++) {
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

function BoardBody({ layout, board }: { layout: BoardLayout; board: number }) {
  const width = layout.boardColumns * PITCH + 0.5;
  const railLine = (side: 'top' | 'bottom', rail: Rail) => {
    const z = RAIL_Z[side][rail] + (side === 'top' ? -1 : 1) * (rail === '-' ? 0.17 : -0.17) * (side === 'top' ? -1 : 1);
    return (
      <mesh key={`${side}${rail}`} position={[0, 0.182, z + (rail === '+' ? (side === 'top' ? 0.17 : -0.17) : side === 'top' ? -0.17 : 0.17)]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width - 0.4, 0.03]} />
        <meshBasicMaterial color={rail === '+' ? '#dc2626' : '#2563eb'} />
      </mesh>
    );
  };
  const [ox, oz] = layout.origins[board];
  return (
    <group>
      <group position={[ox, 0, oz]}>
        <mesh position={[0, 0.09, 0]} receiveShadow castShadow onClick={(e) => (e.stopPropagation(), select(null))}>
          <boxGeometry args={[width, 0.18, RAIL_Z.bottom['-'] - RAIL_Z.top['-'] + 0.6]} />
          <meshStandardMaterial color="#eceae4" roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.183, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[width - 0.2, 0.28]} />
          <meshStandardMaterial color="#d6d3cb" roughness={0.9} />
        </mesh>
        {(['top', 'bottom'] as const).flatMap((side) => (['+', '-'] as const).map((rail) => railLine(side, rail)))}
      </group>
      <Holes layout={layout} board={board} />
    </group>
  );
}

// Short jumpers carry the supply rails from each board to the next, as on a real multi-board build.
function RailBridges({ layout }: { layout: BoardLayout }) {
  if (layout.origins.length < 2) return null;
  return (
    <group>
      {layout.origins.slice(1).flatMap((_, i) =>
        (['top', 'bottom'] as const).flatMap((side) =>
          (['+', '-'] as const).map((rail) => {
            const from = spotPosition(layout, { kind: 'rail', col: (i + 1) * BOARD_COLUMNS - 1, side, rail }, 0.22);
            const to = spotPosition(layout, { kind: 'rail', col: (i + 1) * BOARD_COLUMNS + 1, side, rail }, 0.22);
            const lift = from
              .clone()
              .lerp(to, 0.5)
              .setY(0.22 + Math.min(1.6, from.distanceTo(to) * 0.08));
            return (
              <group key={`${i}${side}${rail}`}>
                <Segment from={from} to={lift} radius={0.03} color={rail === '+' ? '#ef4444' : '#1f2937'} />
                <Segment from={lift} to={to} radius={0.03} color={rail === '+' ? '#ef4444' : '#1f2937'} />
              </group>
            );
          }),
        ),
      )}
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
    case 'diode':
    case 'pot':
    case 'ldr':
    case 'thermistor':
    case 'npn':
    case 'pnp':
    case 'nmos':
    case 'pmos':
      return <SmallPart part={part} />;
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
    const standing = ['led', 'capacitor', 'switch', 'button', 'buzzer', 'ldr', 'thermistor'].includes(part.type) || holes.length === 3;
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
      {layout.origins.map((_, board) => (
        <BoardBody key={board} layout={layout} board={board} />
      ))}
      <RailBridges layout={layout} />
      {spec.parts.filter(STRADDLES).map((part) => {
        const chip = layout.chips.get(part.id)!;
        const { x, z } = columnAt(layout, chip.col);
        const at = new THREE.Vector3(x + ((chip.half - 1) / 2) * PITCH, 0.08, z);
        return (
          <group key={part.id}>
            <group position={at} onClick={pickOrToggle(part)}>
              {part.type === 'seven_segment' ? <SevenSegment part={part} /> : <PackageBody part={part} />}
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
