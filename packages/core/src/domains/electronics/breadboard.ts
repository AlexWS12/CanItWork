import { netsOf } from './nets';
import { pinsOf, type CircuitSpec, type Part } from './parts';

// Where each part goes on a breadboard: chips straddle the centre channel, leads go into holes, and each wire of the spec becomes a jumper between holes.
// Each 5-hole column strip is one electrical node, so a lead placed in a chip pin's strip needs no wire at all.
// Shared by the 3D view and the build guide, so the guide's hole numbers match what is drawn.

const REACH = 7;
const CHIP_GAP = 3;

// Pins split into two rows like a DIP: the first half along the near side left to right, the rest along the far side right to left, so pin 1 is bottom left.
export function dipRows(part: Part) {
  const pins = pinsOf(part);
  const half = Math.ceil(pins.length / 2);
  return { near: pins.slice(0, half), far: pins.slice(half).reverse(), half };
}

export type Half = 'A' | 'B';
export type Rail = '+' | '-';
export type Spot = { kind: 'strip'; col: number; half: Half; row: number } | { kind: 'rail'; col: number; side: 'top' | 'bottom'; rail: Rail };

export const LEADED = (part: Part) =>
  ['resistor', 'led', 'capacitor', 'button', 'switch', 'buzzer', 'diode', 'pot', 'ldr', 'thermistor', 'npn', 'pnp', 'nmos', 'pmos'].includes(part.type) ||
  (part.type === 'custom' && ['axial', 'radial', 'to92', 'pot'].includes(part.package ?? '') && pinsOf(part).length <= 3);
export const STRADDLES = (part: Part) =>
  part.type === 'seven_segment' || (part.type === 'custom' && (part.package === 'dip' || part.package === 'module') && pinsOf(part).length >= 4);

export interface BoardLayout {
  columns: number;
  spots: Map<string, Spot>;
  chips: Map<string, { col: number; half: number }>;
  // Parts that sit beside the board (batteries, boards, motors), in order.
  offBoard: string[];
  wireEnds: Array<[Spot | string, Spot | string] | null>;
  supply: Map<string, Rail>;
  railsUsed: Set<string>;
  // The off-board part whose two leads feed the rails, so the build guide connects the same part the layout assumed.
  source?: { id: string; pos: string; neg: string };
}

export function layoutBreadboard(spec: CircuitSpec): BoardLayout {
  const nets = netsOf(spec);
  const supplyPart =
    spec.parts.find((p) => p.type === 'battery') ?? spec.parts.find((p) => p.type === 'arduino') ?? spec.parts.find((p) => p.custom?.sources.length && !STRADDLES(p));
  const supply = new Map<string, Rail>();
  let source: BoardLayout['source'];
  if (supplyPart) {
    const [pos, neg] =
      supplyPart.type === 'battery' ? ['pos', 'neg'] : supplyPart.type === 'arduino' ? ['5V', 'GND'] : [supplyPart.custom!.sources[0].pos, supplyPart.custom!.sources[0].neg];
    supply.set(nets.find(`${supplyPart.id}.${pos}`), '+');
    supply.set(nets.find(`${supplyPart.id}.${neg}`), '-');
    source = { id: supplyPart.id, pos, neg };
  }
  const sourceLeads = new Set(source ? [`${source.id}.${source.pos}`, `${source.id}.${source.neg}`] : []);
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
      // Scan right for three free strips in a row. Searching around each miss can bounce back to the same column forever.
      let col: number = nearestFree(cursor, half);
      while (!free(col, half) || !free(col + 1, half) || !free(col + 2, half)) col++;
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
  const offBoard = spec.parts.filter((p) => !LEADED(p) && !STRADDLES(p)).map((p) => p.id);

  const railsUsed = new Set<string>();
  // Only the source's own two leads stand for the rails, since the guide wires those leads to them. Any other part beside the board,
  // such as a motor or solar panel, keeps its own end of the wire even on a power net, or nothing would ever connect it.
  const resolve = (key: string, other: string): Spot | string => {
    const spot = spots.get(key);
    if (spot) return spot;
    const rail = supply.get(nets.find(key));
    const near = spots.get(other);
    if (!rail || !sourceLeads.has(key) || !near) return key;
    return { kind: 'rail', col: near.col, side: near.kind === 'strip' ? sideOf(near.half) : near.side, rail };
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
  return { columns, spots, chips, offBoard, wireEnds, supply, railsUsed, source: source && offBoard.includes(source.id) ? source : undefined };
}
