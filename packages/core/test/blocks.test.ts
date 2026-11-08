import { describe, expect, it } from 'vitest';
import { electronics } from '../src/domains/electronics';
import type { CircuitSpec } from '../src/domains/electronics/parts';

const design = (blocks: unknown, parts: unknown[] = [{ id: 'batt', type: 'battery', volts: 5, maxAmps: 1 }]) =>
  electronics.specSchema.parse({ parts, wires: [], layout: 'breadboard', blocks }) as CircuitSpec;
const count = (spec: CircuitSpec, test: (p: CircuitSpec['parts'][number]) => boolean) => spec.parts.filter(test).length;
const problems = (spec: CircuitSpec) => electronics.validate(electronics.compile(spec)).filter((i) => i.severity === 'error' || i.repair);

describe('building blocks', () => {
  it('expands a 16-bit adder into 20 gate chips, 32 switches and 17 LEDs that pass every test', () => {
    const spec = design([{ id: 'calc', kind: 'adder', bits: 16 }]);
    const built = electronics.compile(spec);
    expect(count(built, (p) => p.type === 'custom')).toBe(20);
    expect(count(built, (p) => p.type === 'switch')).toBe(32);
    expect(count(built, (p) => p.type === 'led')).toBe(17);
    expect(problems(spec)).toEqual([]);
    expect(electronics.proof!(built)).toMatch(/^10 of 10 behaviour tests pass/);
  });

  it('subtracts through the same gates when the mode switch is on', () => {
    const spec = design([{ id: 'calc', kind: 'adder_subtractor', bits: 8 }]);
    const built = electronics.compile(spec);
    expect(built.parts.some((p) => p.id === 'swSub')).toBe(true);
    expect(built.tests!.some((t) => t.name === '255 - 1')).toBe(true);
    expect(problems(spec)).toEqual([]);
    expect(electronics.proof!(built)).toMatch(/^12 of 12 behaviour tests pass/);
  });

  it('tests a small adder exhaustively', () => {
    const built = electronics.compile(design([{ id: 'calc', kind: 'adder', bits: 2 }]));
    expect(built.tests).toHaveLength(16);
    expect(problems(design([{ id: 'calc', kind: 'adder', bits: 2 }]))).toEqual([]);
  });

  it('prefixes part ids when a design has more than one block, and adds a battery if none is given', () => {
    const built = electronics.compile(
      design(
        [
          { id: 'left', kind: 'adder', bits: 2 },
          { id: 'right', kind: 'adder', bits: 2 },
        ],
        [],
      ),
    );
    const ids = built.parts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('left_swA0');
    expect(ids).toContain('right_ledCout');
    expect(built.parts.filter((p) => p.type === 'battery')).toHaveLength(1);
  });

  it('forgives how a design refers to a block: wires to the block itself are dropped, prefixed part names resolve', () => {
    const spec = electronics.specSchema.parse({
      parts: [{ id: 'batt', type: 'battery', volts: 5, maxAmps: 1 }],
      wires: [{ from: 'batt.pos', to: 'calc.batt_pos' }],
      layout: 'breadboard',
      blocks: [{ id: 'calc', kind: 'adder', bits: 2 }],
      tests: [{ name: 'one plus nothing', set: { calc_swA0: 1 }, on: ['calc.ledS0'], off: ['calc_ledS1', 'ledCout'] }],
    }) as CircuitSpec;
    const built = electronics.compile(spec);
    expect(built.wires.some((w) => w.to.startsWith('calc.'))).toBe(false);
    expect(built.tests![0]).toMatchObject({ set: { swA0: 1 }, on: ['ledS0'], off: ['ledS1', 'ledCout'] });
    expect(problems(spec)).toEqual([]);
  });

  it('compares two 8-bit numbers with GT, EQ and LT LEDs that pass every test', () => {
    const spec = design([{ id: 'cmp', kind: 'comparator', bits: 8 }]);
    const built = electronics.compile(spec);
    expect(built.parts.filter((p) => p.type === 'led').map((p) => p.id)).toEqual(['ledGT', 'ledEQ', 'ledLT']);
    expect(problems(spec)).toEqual([]);
    expect(electronics.proof!(built)).toMatch(/^12 of 12 behaviour tests pass/);
  });

  it('multiplies two 4-bit numbers into 8 product LEDs, every test passing', () => {
    const spec = design([{ id: 'mul', kind: 'multiplier', bits: 4 }]);
    const built = electronics.compile(spec);
    expect(built.parts.filter((p) => p.type === 'led')).toHaveLength(8);
    expect(built.tests!.some((t) => t.name === '15 x 15')).toBe(true);
    expect(problems(spec)).toEqual([]);
    expect(electronics.proof!(built)).toMatch(/^10 of 10 behaviour tests pass/);
  });

  it('runs a 4-bit ALU through add, subtract, AND and OR from its select switches', () => {
    const spec = design([{ id: 'alu', kind: 'alu', bits: 4 }]);
    const built = electronics.compile(spec);
    expect(built.parts.some((p) => p.id === 'swS1') && built.parts.some((p) => p.id === 'swS0')).toBe(true);
    for (const op of ['+', '-', 'AND', 'OR']) expect(built.tests!.some((t) => t.name?.includes(` ${op} `))).toBe(true);
    expect(problems(spec)).toEqual([]);
    expect(electronics.proof!(built)).toMatch(/^16 of 16 behaviour tests pass/);
  });

  it('folds a design’s own copies of a block’s parts into the block, as the live ALU eval produced them', () => {
    const spec = electronics.specSchema.parse({
      parts: [
        { id: 'bat1', type: 'battery', volts: 5, maxAmps: 1 },
        { id: 'sw_s0', type: 'switch' },
        { id: 'r_s0', type: 'resistor', ohms: 10000 },
        { id: 'led_r0', type: 'led' },
        { id: 'r_r0', type: 'resistor', ohms: 220 },
      ],
      wires: [
        { from: 'bat1.pos', to: 'sw_s0.a' },
        { from: 'sw_s0.b', to: 'r_s0.a' },
        { from: 'r_s0.b', to: 'bat1.neg' },
        { from: 'r_r0.b', to: 'led_r0.anode' },
        { from: 'led_r0.cathode', to: 'bat1.neg' },
      ],
      layout: 'breadboard',
      blocks: [{ id: 'alu_4', kind: 'alu', bits: 4 }],
      tests: [{ name: 'add', set: { sw_s0: 0 }, on: [], off: ['led_r0'] }],
    }) as CircuitSpec;
    const built = electronics.compile(spec);
    const ids = built.parts.map((p) => p.id);
    for (const gone of ['sw_s0', 'r_s0', 'led_r0', 'r_r0']) expect(ids).not.toContain(gone);
    expect(ids).toContain('ledR0');
    expect(built.tests![0]).toMatchObject({ set: { swS0: 0 }, off: ['ledR0'] });
    expect(problems(spec)).toEqual([]);
  });

  it('counts up on its 555 clock, and its reset and preset switches prove every LED', () => {
    const spec = design([{ id: 'cnt', kind: 'counter', bits: 8 }]);
    const built = electronics.compile(spec);
    expect(built.parts.filter((p) => p.custom?.label === '74HC161 4-bit counter')).toHaveLength(2);
    expect(problems(spec)).toEqual([]);
    expect(electronics.proof!(built)).toMatch(/^5 of 5 behaviour tests pass/);
    const run = electronics.createRun(built, 1) as unknown as { step(): void; readings: Map<string, { amps: number }> };
    const leds = built.parts.filter((p) => p.type === 'led');
    const count = () => leds.reduce((sum, p, i) => sum + ((run.readings.get(p.id)?.amps ?? 0) > 0.002 ? 2 ** i : 0), 0);
    for (let t = 0; t < 36; t++) run.step();
    const early = count();
    for (let t = 0; t < 60; t++) run.step();
    expect(count()).toBeGreaterThan(early + 3);
    expect(electronics.specSchema.safeParse({ parts: [], wires: [], blocks: [{ id: 'c', kind: 'counter', bits: 2 }] }).success).toBe(false);
  });

  it('holds each kind to a width that still builds, and says so', () => {
    const tooWide = electronics.specSchema.safeParse({ parts: [], wires: [], blocks: [{ id: 'mul', kind: 'multiplier', bits: 12 }] });
    expect(tooWide.success).toBe(false);
    expect(JSON.stringify(tooWide.error?.issues)).toContain('at most 8 bits');
    expect(electronics.specSchema.safeParse({ parts: [], wires: [], blocks: [{ id: 'mul', kind: 'multiplier', bits: 8 }] }).success).toBe(true);
  });

  it('leaves a design without blocks untouched, and refuses a design with neither parts nor blocks', () => {
    const plain = design(undefined);
    expect(electronics.compile(plain)).toBe(plain);
    expect(electronics.specSchema.safeParse({ parts: [], wires: [] }).success).toBe(false);
  });
});
