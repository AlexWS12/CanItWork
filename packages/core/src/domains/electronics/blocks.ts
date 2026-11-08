import { z } from 'zod';
import type { CircuitSpec, Part } from './parts';

// Building blocks: circuits too large to wire by hand in a design, such as a 16-bit adder of 20 logic chips and 340 wires.
// The Architect names a block and its size; compiling expands it into real 74HC chips, switches, LEDs, wiring and behaviour tests,
// so every view, check and the build guide see the full circuit while the design itself stays a few lines long.

export const BlockSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]*$/)
    .max(16),
  kind: z.enum(['adder', 'adder_subtractor']),
  bits: z.number().int().min(1).max(32),
});
export type Block = z.infer<typeof BlockSchema>;

export const blockDoc = `"blocks"?: [{"id": short name, "kind": "adder"|"adder_subtractor", "bits": 1-32}] — for wide arithmetic built from logic gates. A block brings its own input switches (swA0..., swB0...; adder_subtractor adds swSub, on to subtract), 74HC86/08/32 gate chips, sum LEDs (ledS0..., ledCout) and its behaviour tests, all wired to the battery. A block is real hardware made of logic gate chips, so it fully satisfies a request for logic gates. Use one for any adder or calculator over 2 bits instead of wiring the gates yourself: a 16-bit calculator is {"id":"calc","kind":"adder","bits":16}, or "adder_subtractor" if it should also subtract. Add only a 5 V battery to "parts", write no wires or tests for the block (it wires, powers and tests itself), and add your own parts only for anything extra the user asked for. With more than one block, its part ids are prefixed with the block id and an underscore.`;

const PINS = ['A1', 'B1', 'Y1', 'A2', 'B2', 'Y2', 'GND', 'Y3', 'A3', 'B3', 'Y4', 'A4', 'B4', 'VCC'];
const GATES = { xor: ['74HC86 Quad XOR', '!='], and: ['74HC08 Quad AND', '&&'], or: ['74HC32 Quad OR', '||'] } as const;
type Gate = keyof typeof GATES;

const chip = (id: string, gate: Gate): Part =>
  ({
    id,
    type: 'custom',
    package: 'dip',
    custom: {
      label: GATES[gate][0],
      pins: PINS,
      paths: [{ a: 'VCC', b: 'GND', ohms: 5000 }],
      switches: [],
      drivers: [1, 2, 3, 4].map((g) => ({ pin: `Y${g}`, high: 'VCC', low: 'GND', when: `A${g} ${GATES[gate][1]} B${g}`, ref: 'GND', aboveVolts: 2.5, ohms: 50, invert: false })),
      sources: [],
      gpio: [],
      supply: { pos: 'VCC', neg: 'GND', minVolts: 2, maxVolts: 6 },
      maxAmps: 0.05,
      output: false,
      visual: [],
    },
  }) as Part;

const bit = (value: number, i: number) => Math.floor(value / 2 ** i) % 2;

// The cases that catch wiring mistakes in an adder: carries rippling the whole width, alternating bits, and a few ordinary sums.
function samples(bits: number): Array<[number, number]> {
  const max = 2 ** bits - 1;
  if (bits <= 2) {
    const all: Array<[number, number]> = [];
    for (let a = 0; a <= max; a++) for (let b = 0; b <= max; b++) all.push([a, b]);
    return all;
  }
  const odd = Array.from({ length: bits }, (_, i) => (i % 2 ? 2 ** i : 0)).reduce((a, b) => a + b, 0);
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % (max + 1);
  };
  const out: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [max, 1],
    [Math.floor(max / 2), 1],
    [max, max],
    [odd, max - odd],
    [odd, odd],
  ];
  while (out.length < 10) out.push([next(), next()]);
  return out;
}

function expand(block: Block, prefix: string, supply: { pos: string; neg: string }) {
  const parts: Part[] = [];
  const wires: CircuitSpec['wires'] = [];
  const wire = (from: string, to: string) => wires.push({ from, to });
  const id = (name: string) => `${prefix}${name}`;
  const used: Record<Gate, number> = { xor: 0, and: 0, or: 0 };
  // Hands out the next free gate of a kind, adding a chip, powered from the rails, every four gates.
  const gate = (kind: Gate) => {
    const n = used[kind]++;
    const chipId = id(`${kind}${Math.floor(n / 4) + 1}`);
    if (n % 4 === 0) {
      parts.push(chip(chipId, kind));
      wire(supply.pos, `${chipId}.VCC`);
      wire(supply.neg, `${chipId}.GND`);
    }
    const g = (n % 4) + 1;
    return { a: `${chipId}.A${g}`, b: `${chipId}.B${g}`, y: `${chipId}.Y${g}` };
  };
  // A switch to the supply with a 10 kΩ pull-down, so an open switch reads as 0.
  const input = (name: string) => {
    parts.push({ id: id(`sw${name}`), type: 'switch', closed: false, package: 'dip' } as Part, { id: id(`r${name}`), type: 'resistor', ohms: 10000, package: 'axial' } as Part);
    wire(supply.pos, `${id(`sw${name}`)}.a`);
    wire(`${id(`sw${name}`)}.b`, `${id(`r${name}`)}.a`);
    wire(supply.neg, `${id(`r${name}`)}.b`);
    return `${id(`sw${name}`)}.b`;
  };
  const led = (name: string, from: string) => {
    parts.push(
      { id: id(`led${name}`), type: 'led', color: name === 'Cout' ? 'blue' : 'red', package: 'axial' } as Part,
      { id: id(`res${name}`), type: 'resistor', ohms: 220, package: 'axial' } as Part,
    );
    wire(from, `${id(`res${name}`)}.a`);
    wire(`${id(`res${name}`)}.b`, `${id(`led${name}`)}.anode`);
    wire(supply.neg, `${id(`led${name}`)}.cathode`);
  };

  const subtract = block.kind === 'adder_subtractor';
  // Subtracting adds the two's complement: each B bit goes through an XOR with the mode switch, and the mode switch is the first carry in.
  const mode = subtract ? input('Sub') : null;
  let carry: string | null = mode;
  for (let i = 0; i < block.bits; i++) {
    const a = input(`A${i}`);
    let b = input(`B${i}`);
    if (mode) {
      const flip = gate('xor');
      wire(b, flip.a);
      wire(mode, flip.b);
      b = flip.y;
    }
    const half = gate('xor');
    wire(a, half.a);
    wire(b, half.b);
    const both = gate('and');
    wire(a, both.a);
    wire(b, both.b);
    if (!carry) {
      led(`S${i}`, half.y);
      carry = both.y;
      continue;
    }
    const sum = gate('xor');
    wire(half.y, sum.a);
    wire(carry, sum.b);
    led(`S${i}`, sum.y);
    const pass = gate('and');
    wire(half.y, pass.a);
    wire(carry, pass.b);
    const out = gate('or');
    wire(both.y, out.a);
    wire(pass.y, out.b);
    carry = out.y;
  }
  led('Cout', carry!);

  const outputs = [...Array.from({ length: block.bits }, (_, i) => id(`ledS${i}`)), id('ledCout')];
  const row = (x: number, y: number, sub: boolean) => {
    const set: Record<string, number> = {};
    if (subtract) set[id('swSub')] = sub ? 1 : 0;
    for (let i = 0; i < block.bits; i++) {
      set[id(`swA${i}`)] = bit(x, i);
      set[id(`swB${i}`)] = bit(y, i);
    }
    // Subtraction shows A + (not B) + 1: the low bits are A - B in two's complement and the carry LED means no borrow.
    const result = sub ? x + (2 ** block.bits - 1 - y) + 1 : x + y;
    const lit = outputs.filter((_, i) => bit(result, i) === 1);
    return { name: `${x} ${sub ? '-' : '+'} ${y}`, set, on: lit, off: outputs.filter((o) => !lit.includes(o)) };
  };
  const pairs = samples(block.bits);
  const tests = subtract
    ? [...pairs.slice(0, 6).map(([x, y]) => row(x, y, false)), ...pairs.slice(0, 6).map(([x, y]) => row(x, y, true))]
    : pairs.map(([x, y]) => row(x, y, false));
  return { parts, wires, tests };
}

/** Expands a design's blocks into parts, wires and tests; a design without blocks is returned as it is. */
export function expandBlocks(spec: CircuitSpec): CircuitSpec {
  if (!spec.blocks?.length) return spec;
  const parts = [...spec.parts];
  let battery = parts.find((p) => p.type === 'battery');
  if (!battery) {
    battery = { id: 'batt', type: 'battery', volts: 5, maxAmps: 1 } as Part;
    parts.unshift(battery);
  }
  const supply = { pos: `${battery.id}.pos`, neg: `${battery.id}.neg` };
  const taken = new Set(parts.map((p) => p.id));
  const builtWires: CircuitSpec['wires'] = [];
  const builtTests: NonNullable<CircuitSpec['tests']> = [];
  // How a design may refer to a block's parts: "calc_swA0", "calc.swA0" or plain "swA0" all mean the part the block built.
  const aliases = new Map<string, string>();
  for (const block of spec.blocks) {
    const prefix = spec.blocks.length > 1 ? `${block.id}_` : '';
    const built = expand(block, prefix, supply);
    // A part the design already defines under the same id wins, so a hand-placed part is never duplicated.
    parts.push(...built.parts.filter((p) => !taken.has(p.id)));
    builtWires.push(...built.wires);
    builtTests.push(...built.tests);
    for (const part of built.parts) {
      const plain = part.id.slice(prefix.length);
      for (const name of [part.id, plain, `${block.id}_${plain}`, `${block.id}.${plain}`]) aliases.set(name, part.id);
    }
  }
  const blockIds = new Set(spec.blocks.map((b) => b.id));
  const resolve = (ref: string) => {
    if (aliases.has(ref)) return aliases.get(ref)!;
    const dot = ref.lastIndexOf('.');
    const owner = dot > 0 ? ref.slice(0, dot) : ref;
    return aliases.has(owner) ? `${aliases.get(owner)}.${ref.slice(dot + 1)}` : ref;
  };
  // A block wires and powers itself, so a wire to the block as a whole (such as "calc.batt_pos") is dropped.
  const wires = [
    ...spec.wires.map((w) => ({ from: resolve(w.from), to: resolve(w.to) })).filter((w) => ![w.from, w.to].some((end) => blockIds.has(end.split('.')[0]))),
    ...builtWires,
  ];
  // The block brings its own tests, so a design's tests are kept only where every id they use exists.
  const known = new Set(parts.map((p) => p.id));
  const exists = (ref: string) => known.has(ref.split('.')[0]) || (spec.world ?? []).some((q) => q.id === ref);
  const tests = (spec.tests ?? [])
    .map((t) => ({ ...t, set: Object.fromEntries(Object.entries(t.set).map(([k, v]) => [resolve(k), v])), on: t.on.map(resolve), off: t.off.map(resolve) }))
    .filter((t) => [...Object.keys(t.set), ...t.on, ...t.off].every(exists));
  return { ...spec, parts, wires, tests: [...tests, ...builtTests], blocks: undefined };
}
