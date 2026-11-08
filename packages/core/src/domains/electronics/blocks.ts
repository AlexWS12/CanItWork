import { z } from 'zod';
import type { CircuitSpec, Part } from './parts';

// Building blocks: circuits too large to wire by hand in a design, such as a 16-bit adder of 20 logic chips and 340 wires.
// The Architect names a block and its size; compiling expands it into real 74HC chips, switches, LEDs, wiring and behaviour tests,
// so every view, check and the build guide see the full circuit while the design itself stays a few lines long.

const KINDS = ['adder', 'adder_subtractor', 'comparator', 'multiplier', 'alu'] as const;
// The widest of each kind that still builds and simulates at a usable size: an 8x8 multiplier is already about 90 chips.
const MAX_BITS: Record<(typeof KINDS)[number], number> = { adder: 32, adder_subtractor: 32, comparator: 32, multiplier: 8, alu: 16 };

export const BlockSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]*$/)
      .max(16),
    kind: z.enum(KINDS),
    bits: z.number().int().min(1).max(32),
  })
  .refine(
    (b) => b.bits <= MAX_BITS[b.kind],
    (b) => ({ message: `A ${b.kind} block takes at most ${MAX_BITS[b.kind]} bits`, path: ['bits'] }),
  );
export type Block = z.infer<typeof BlockSchema>;

export const blockDoc = `"blocks"?: [{"id": short name, "kind": "adder"|"adder_subtractor"|"comparator"|"multiplier"|"alu", "bits": width}] — for wide arithmetic and logic built from gates. Each block brings its own input switches for two numbers A and B (swA0..., swB0...), its 74HC gate chips, output LEDs and its behaviour tests, all wired to the battery:
- "adder" (up to 32 bits): sum LEDs ledS0... and ledCout.
- "adder_subtractor" (up to 32 bits): an adder plus swSub, on to subtract.
- "comparator" (up to 32 bits): ledGT, ledEQ and ledLT for A > B, A = B and A < B.
- "multiplier" (up to 8 bits): product LEDs ledP0... ledP(2 x bits - 1).
- "alu" (up to 16 bits): select switches swS1 swS0 pick add (00), subtract (01), AND (10) or OR (11); result LEDs ledR0... and ledCout.
A block is real hardware made of logic gate chips, so it fully satisfies a request for logic gates. Use one for any adder, calculator, comparator, multiplier or ALU over 2 bits instead of wiring the gates yourself: a 16-bit calculator is {"id":"calc","kind":"adder","bits":16}, or "adder_subtractor" if it should also subtract, and a 4-bit multiplier is {"id":"mul","kind":"multiplier","bits":4}. Add only a 5 V battery to "parts", write no wires or tests for the block (it wires, powers and tests itself), and add your own parts only for anything extra the user asked for. With more than one block, its part ids are prefixed with the block id and an underscore.`;

const QUAD = ['A1', 'B1', 'Y1', 'A2', 'B2', 'Y2', 'GND', 'Y3', 'A3', 'B3', 'Y4', 'A4', 'B4', 'VCC'];
const HEX = ['A1', 'Y1', 'A2', 'Y2', 'A3', 'Y3', 'GND', 'Y4', 'A4', 'Y5', 'A5', 'Y6', 'A6', 'VCC'];
const GATES = {
  xor: { label: '74HC86 Quad XOR', per: 4, when: (g: number) => `A${g} != B${g}` },
  and: { label: '74HC08 Quad AND', per: 4, when: (g: number) => `A${g} && B${g}` },
  or: { label: '74HC32 Quad OR', per: 4, when: (g: number) => `A${g} || B${g}` },
  not: { label: '74HC04 Hex NOT', per: 6, when: (g: number) => `!A${g}` },
} as const;
type Gate = keyof typeof GATES;

const chip = (id: string, gate: Gate): Part =>
  ({
    id,
    type: 'custom',
    package: 'dip',
    custom: {
      label: GATES[gate].label,
      pins: gate === 'not' ? HEX : QUAD,
      paths: [{ a: 'VCC', b: 'GND', ohms: 5000 }],
      switches: [],
      drivers: Array.from({ length: GATES[gate].per }, (_, i) => ({
        pin: `Y${i + 1}`,
        high: 'VCC',
        low: 'GND',
        when: GATES[gate].when(i + 1),
        ref: 'GND',
        aboveVolts: 2.5,
        ohms: 50,
        invert: false,
      })),
      sources: [],
      gpio: [],
      supply: { pos: 'VCC', neg: 'GND', minVolts: 2, maxVolts: 6 },
      maxAmps: 0.05,
      output: false,
      visual: [],
    },
  }) as Part;

const bit = (value: number, i: number) => Math.floor(value / 2 ** i) % 2;
type Test = NonNullable<CircuitSpec['tests']>[number];

// The cases that catch wiring mistakes: carries rippling the whole width, alternating bits, equal values and a few ordinary ones.
function samples(bits: number, count = 10): Array<[number, number]> {
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
  while (out.length < count) out.push([next(), next()]);
  return out;
}

// Wires gates out of real chips: each call hands out the next free gate of a kind, adding a chip, powered from the rails, when one fills up.
function builder(prefix: string, supply: { pos: string; neg: string }) {
  const parts: Part[] = [];
  const wires: CircuitSpec['wires'] = [];
  const wire = (from: string, to: string) => wires.push({ from, to });
  const id = (name: string) => `${prefix}${name}`;
  const used: Record<Gate, number> = { xor: 0, and: 0, or: 0, not: 0 };
  const take = (kind: Gate) => {
    const n = used[kind]++;
    const chipId = id(`${kind}${Math.floor(n / GATES[kind].per) + 1}`);
    if (n % GATES[kind].per === 0) {
      parts.push(chip(chipId, kind));
      wire(supply.pos, `${chipId}.VCC`);
      wire(supply.neg, `${chipId}.GND`);
    }
    return { chipId, g: (n % GATES[kind].per) + 1 };
  };
  // A two-input gate fed by two signals; returns its output.
  const gate = (kind: Exclude<Gate, 'not'>, a: string, b: string) => {
    const { chipId, g } = take(kind);
    wire(a, `${chipId}.A${g}`);
    wire(b, `${chipId}.B${g}`);
    return `${chipId}.Y${g}`;
  };
  const not = (a: string) => {
    const { chipId, g } = take('not');
    wire(a, `${chipId}.A${g}`);
    return `${chipId}.Y${g}`;
  };
  const half = (a: string, b: string) => ({ sum: gate('xor', a, b), carry: gate('and', a, b) });
  // Sum = A xor B xor Cin, carry = A·B + Cin·(A xor B).
  const full = (a: string, b: string, cin: string) => {
    const x = gate('xor', a, b);
    const both = gate('and', a, b);
    const sum = gate('xor', x, cin);
    const pass = gate('and', x, cin);
    return { sum, carry: gate('or', both, pass) };
  };
  // A switch to the supply with a 10 kΩ pull-down, so an open switch reads as 0.
  const input = (name: string) => {
    parts.push({ id: id(`sw${name}`), type: 'switch', closed: false, package: 'dip' } as Part, { id: id(`r${name}`), type: 'resistor', ohms: 10000, package: 'axial' } as Part);
    wire(supply.pos, `${id(`sw${name}`)}.a`);
    wire(`${id(`sw${name}`)}.b`, `${id(`r${name}`)}.a`);
    wire(supply.neg, `${id(`r${name}`)}.b`);
    return `${id(`sw${name}`)}.b`;
  };
  const led = (name: string, from: string, color = 'red') => {
    parts.push({ id: id(`led${name}`), type: 'led', color, package: 'axial' } as Part, { id: id(`res${name}`), type: 'resistor', ohms: 220, package: 'axial' } as Part);
    wire(from, `${id(`res${name}`)}.a`);
    wire(`${id(`res${name}`)}.b`, `${id(`led${name}`)}.anode`);
    wire(supply.neg, `${id(`led${name}`)}.cathode`);
    return id(`led${name}`);
  };
  // A behaviour test row: which switches are on, and which of the outputs must be lit.
  const row = (name: string, set: Record<string, number>, outputs: string[], lit: (output: string, i: number) => boolean): Test => {
    const on = outputs.filter((o, i) => lit(o, i));
    return { name, set: Object.fromEntries(Object.entries(set).map(([k, v]) => [id(k), v])), on, off: outputs.filter((o) => !on.includes(o)) };
  };
  return { parts, wires, gate, not, half, full, input, led, row };
}

const numberSwitches = (bits: number, x: number, y: number) => {
  const set: Record<string, number> = {};
  for (let i = 0; i < bits; i++) {
    set[`swA${i}`] = bit(x, i);
    set[`swB${i}`] = bit(y, i);
  }
  return set;
};

// A ripple-carry adder; with a mode switch, B goes through XOR gates and the mode is the first carry in, so it subtracts.
function adder(block: Block, b: ReturnType<typeof builder>) {
  const subtract = block.kind === 'adder_subtractor';
  const mode = subtract ? b.input('Sub') : null;
  let carry: string | null = mode;
  const sums: string[] = [];
  for (let i = 0; i < block.bits; i++) {
    const a = b.input(`A${i}`);
    let bi = b.input(`B${i}`);
    if (mode) bi = b.gate('xor', bi, mode);
    if (!carry) {
      const h = b.half(a, bi);
      sums.push(b.led(`S${i}`, h.sum));
      carry = h.carry;
      continue;
    }
    const f = b.full(a, bi, carry);
    sums.push(b.led(`S${i}`, f.sum));
    carry = f.carry;
  }
  const outputs = [...sums, b.led('Cout', carry!, 'blue')];
  // Subtraction shows A + (not B) + 1: the low bits are A - B in two's complement and the carry LED means no borrow.
  const test = (x: number, y: number, sub: boolean) =>
    b.row(`${x} ${sub ? '-' : '+'} ${y}`, { ...(subtract ? { swSub: sub ? 1 : 0 } : {}), ...numberSwitches(block.bits, x, y) }, outputs, (_, i) =>
      Boolean(bit(sub ? x + (2 ** block.bits - 1 - y) + 1 : x + y, i)),
    );
  const pairs = samples(block.bits);
  return subtract ? [...pairs.slice(0, 6).map(([x, y]) => test(x, y, false)), ...pairs.slice(0, 6).map(([x, y]) => test(x, y, true))] : pairs.map(([x, y]) => test(x, y, false));
}

// A magnitude comparator built from the low bit up: A > B so far is "this bit says so, or it ties and the bits below said so".
function comparator(block: Block, b: ReturnType<typeof builder>) {
  let gt: string | null = null;
  let lt: string | null = null;
  let eq: string | null = null;
  for (let i = 0; i < block.bits; i++) {
    const a = b.input(`A${i}`);
    const bi = b.input(`B${i}`);
    const aOnly = b.gate('and', a, b.not(bi));
    const bOnly = b.gate('and', b.not(a), bi);
    const same = b.not(b.gate('xor', a, bi));
    gt = gt ? b.gate('or', aOnly, b.gate('and', same, gt)) : aOnly;
    lt = lt ? b.gate('or', bOnly, b.gate('and', same, lt)) : bOnly;
    eq = eq ? b.gate('and', same, eq) : same;
  }
  const outputs = [b.led('GT', gt!, 'green'), b.led('EQ', eq!, 'yellow'), b.led('LT', lt!, 'red')];
  const max = 2 ** block.bits - 1;
  const pairs = [...samples(block.bits, 8), [max, max - 1], [max - 1, max], [Math.floor(max / 2) + 1, Math.floor(max / 2)], [7 & max, 7 & max]] as Array<[number, number]>;
  return pairs.map(([x, y]) => b.row(`${x} vs ${y}`, numberSwitches(block.bits, x, y), outputs, (_, i) => [x > y, x === y, x < y][i]));
}

// An array multiplier: every bit of A ANDed with every bit of B, and each row of partial products added into the running total, shifted one place.
function multiplier(block: Block, b: ReturnType<typeof builder>) {
  const n = block.bits;
  const as = Array.from({ length: n }, (_, i) => b.input(`A${i}`));
  const bs = Array.from({ length: n }, (_, i) => b.input(`B${i}`));
  const total: Array<string | null> = new Array(2 * n).fill(null);
  for (let i = 0; i < n; i++) {
    let carry: string | null = null;
    for (let j = 0; j < n; j++) {
      const pp = b.gate('and', as[j], bs[i]);
      const at = total[i + j];
      if (!at && !carry) total[i + j] = pp;
      else if (!at || !carry) {
        const h = b.half((at ?? carry)!, pp);
        total[i + j] = h.sum;
        carry = h.carry;
      } else {
        const f = b.full(at, pp, carry);
        total[i + j] = f.sum;
        carry = f.carry;
      }
    }
    total[i + n] = carry;
  }
  // Every product bit that can be 1 gets an LED; a 1-bit product has no carry, so it has just one.
  const bits = total.flatMap((signal, k) => (signal ? [{ k, led: b.led(`P${k}`, signal) }] : []));
  const outputs = bits.map((x) => x.led);
  const pairs = samples(n, n <= 2 ? 16 : 10);
  // Sampled products can miss a middle bit, so add a power of two for each product bit no test lights yet: every LED is proven to work.
  for (const { k } of bits) {
    if (pairs.some(([x, y]) => bit(x * y, k))) continue;
    const low = Math.min(k, n - 1);
    pairs.push([2 ** low, 2 ** (k - low)]);
  }
  return pairs.map(([x, y]) => b.row(`${x} x ${y}`, numberSwitches(n, x, y), outputs, (_, i) => Boolean(bit(x * y, bits[i].k))));
}

// An ALU: an adder-subtractor beside AND and OR, with select switches choosing which result reaches the LEDs.
function alu(block: Block, b: ReturnType<typeof builder>) {
  const s1 = b.input('S1');
  const s0 = b.input('S0');
  const notS1 = b.not(s1);
  const notS0 = b.not(s0);
  const subtract = b.gate('and', s0, notS1);
  let carry = subtract;
  const results: string[] = [];
  for (let i = 0; i < block.bits; i++) {
    const a = b.input(`A${i}`);
    const bi = b.input(`B${i}`);
    const f = b.full(a, b.gate('xor', bi, subtract), carry);
    carry = f.carry;
    const logic = b.gate('or', b.gate('and', b.gate('and', a, bi), notS0), b.gate('and', b.gate('or', a, bi), s0));
    results.push(b.led(`R${i}`, b.gate('or', b.gate('and', f.sum, notS1), b.gate('and', logic, s1))));
  }
  const outputs = [...results, b.led('Cout', b.gate('and', carry, notS1), 'blue')];
  const max = 2 ** block.bits - 1;
  const ops = [
    { name: '+', s1: 0, s0: 0, of: (x: number, y: number) => x + y },
    { name: '-', s1: 0, s0: 1, of: (x: number, y: number) => x + (max - y) + 1 },
    { name: 'AND', s1: 1, s0: 0, of: (x: number, y: number) => andOf(x, y, block.bits) },
    { name: 'OR', s1: 1, s0: 1, of: (x: number, y: number) => orOf(x, y, block.bits) },
  ];
  const pairs = samples(block.bits, 6).slice(0, block.bits <= 2 ? 16 : 4);
  return ops.flatMap((op) =>
    pairs.map(([x, y]) =>
      b.row(
        `${x} ${op.name} ${y}`,
        { swS1: op.s1, swS0: op.s0, ...numberSwitches(block.bits, x, y) },
        outputs,
        (_, i) => Boolean(bit(op.of(x, y), i)) && (i < block.bits || op.s1 === 0),
      ),
    ),
  );
}

const andOf = (x: number, y: number, bits: number) => Array.from({ length: bits }, (_, i) => (bit(x, i) && bit(y, i) ? 2 ** i : 0)).reduce((a, c) => a + c, 0);
const orOf = (x: number, y: number, bits: number) => Array.from({ length: bits }, (_, i) => (bit(x, i) || bit(y, i) ? 2 ** i : 0)).reduce((a, c) => a + c, 0);

function expand(block: Block, prefix: string, supply: { pos: string; neg: string }) {
  const b = builder(prefix, supply);
  const tests = block.kind === 'comparator' ? comparator(block, b) : block.kind === 'multiplier' ? multiplier(block, b) : block.kind === 'alu' ? alu(block, b) : adder(block, b);
  return { parts: b.parts, wires: b.wires, tests };
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
