import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, type CircuitSpec } from '../src';

const { electronics } = DOMAINS;
const settle = (spec: CircuitSpec, setup?: (run: CircuitRun) => void, ticks = 6) => {
  const run = new CircuitRun(spec, 1);
  setup?.(run);
  for (let i = 0; i < ticks; i++) run.step();
  return run;
};
const part = (spec: CircuitSpec, id: string) => spec.parts.find((p) => p.id === id)!;

describe('diode', () => {
  const circuit = (reversed: boolean): CircuitSpec => ({
    parts: [
      { id: 'B1', type: 'battery', volts: 9 },
      { id: 'D1', type: 'diode' },
      { id: 'R1', type: 'resistor', ohms: 470 },
      { id: 'L1', type: 'led', color: 'red' },
    ],
    wires: [
      { from: 'B1.pos', to: reversed ? 'D1.cathode' : 'D1.anode' },
      { from: reversed ? 'D1.anode' : 'D1.cathode', to: 'R1.a' },
      { from: 'R1.b', to: 'L1.anode' },
      { from: 'L1.cathode', to: 'B1.neg' },
    ],
    drive: [],
  });

  it('conducts forwards with about 0.7 V across it', () => {
    const spec = circuit(false);
    const run = settle(spec);
    expect(run.isRunning(part(spec, 'L1'))).toBe(true);
    expect(run.voltsBetween('D1.anode', 'D1.cathode')).toBeCloseTo(0.7, 0);
  });

  it('blocks current backwards', () => {
    const spec = circuit(true);
    expect(settle(spec).isRunning(part(spec, 'L1'))).toBe(false);
  });
});

describe('potentiometer', () => {
  const dimmer: CircuitSpec = {
    parts: [
      { id: 'B1', type: 'battery', volts: 9 },
      { id: 'P1', type: 'pot', ohms: 10000 },
      { id: 'R1', type: 'resistor', ohms: 220 },
      { id: 'L1', type: 'led', color: 'green' },
    ],
    wires: [
      { from: 'B1.pos', to: 'P1.a' },
      { from: 'P1.wiper', to: 'R1.a' },
      { from: 'R1.b', to: 'L1.anode' },
      { from: 'L1.cathode', to: 'B1.neg' },
    ],
    drive: [],
  };
  const amps = (position: number) => settle(dimmer, (r) => r.inject({ type: 'set_reading', target: 'P1', value: position })).readings.get('L1')?.amps ?? 0;

  it('brightens the LED as it is turned up', () => {
    expect(amps(95)).toBeGreaterThan(amps(50));
    expect(amps(50)).toBeGreaterThan(amps(5));
  });
});

describe('light and temperature sensors', () => {
  const divider = (type: 'ldr' | 'thermistor'): CircuitSpec => ({
    parts: [
      { id: 'B1', type: 'battery', volts: 5 },
      { id: 'S1', type },
      { id: 'R1', type: 'resistor', ohms: 10000 },
    ],
    wires: [
      { from: 'B1.pos', to: 'S1.a' },
      { from: 'S1.b', to: 'R1.a' },
      { from: 'R1.b', to: 'B1.neg' },
    ],
    drive: [],
  });
  const out = (type: 'ldr' | 'thermistor', value: number) => settle(divider(type), (r) => r.inject({ type: 'set_reading', target: 'S1', value })).voltsBetween('R1.a', 'B1.neg');

  it('an LDR divider rises with light', () => {
    expect(out('ldr', 90)).toBeGreaterThan(out('ldr', 50));
    expect(out('ldr', 50)).toBeGreaterThan(out('ldr', 10));
  });

  it('a 10k NTC thermistor reads 10k at 25 C and falls as it warms', () => {
    expect(out('thermistor', 25)).toBeCloseTo(2.5, 1);
    expect(out('thermistor', 60)).toBeGreaterThan(out('thermistor', 25));
  });
});

describe('7-segment display', () => {
  // A CD4511-style decoder: four input switches set a BCD digit, which the display shows.
  const decoder = {
    0: 'abcdef',
    1: 'bc',
    2: 'abdeg',
    3: 'abcdg',
    4: 'bcfg',
    5: 'acdfg',
    6: 'acdefg',
    7: 'abc',
    8: 'abcdefg',
    9: 'abcdfg',
  } as Record<number, string>;
  const segment = (seg: string) =>
    Object.entries(decoder)
      .filter(([, lit]) => lit.includes(seg))
      .map(([n]) => `n == ${n}`)
      .join(' || ');
  const spec: CircuitSpec = {
    parts: [
      { id: 'B1', type: 'battery', volts: 5 },
      {
        id: 'U1',
        type: 'custom',
        package: 'dip',
        custom: {
          label: 'CD4511 BCD to 7-segment decoder',
          pins: ['VDD', 'VSS', 'A', 'B', 'C', 'D', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
          paths: [{ a: 'VDD', b: 'VSS', ohms: 5000 }],
          switches: [],
          drivers: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((seg) => ({
            pin: seg,
            high: 'VDD',
            low: 'VSS',
            when: segment(seg).replace(/n/g, '(A + 2 * B + 4 * C + 8 * D)'),
            ref: 'VSS',
            aboveVolts: 2.5,
            ohms: 50,
            invert: false,
          })),
          sources: [],
          gpio: [],
          supply: { pos: 'VDD', neg: 'VSS', minVolts: 3, maxVolts: 18 },
          output: false,
          visual: [],
        },
      },
      { id: 'X1', type: 'seven_segment', common: 'cathode' },
      ...['A', 'B', 'C', 'D'].flatMap((bit) => [
        { id: `S${bit}`, type: 'switch' as const },
        { id: `RP${bit}`, type: 'resistor' as const, ohms: 10000 },
      ]),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((seg) => ({ id: `R${seg}`, type: 'resistor' as const, ohms: 330 })),
    ],
    wires: [
      { from: 'B1.pos', to: 'U1.VDD' },
      { from: 'U1.VSS', to: 'B1.neg' },
      { from: 'X1.com', to: 'B1.neg' },
      ...['A', 'B', 'C', 'D'].flatMap((bit) => [
        { from: 'B1.pos', to: `S${bit}.a` },
        { from: `S${bit}.b`, to: `U1.${bit}` },
        { from: `U1.${bit}`, to: `RP${bit}.a` },
        { from: `RP${bit}.b`, to: 'B1.neg' },
      ]),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((seg) => [
        { from: `U1.${seg}`, to: `R${seg}.a` },
        { from: `R${seg}.b`, to: `X1.${seg}` },
      ]),
    ],
    drive: [],
  };

  it('shows the digit set on the switches', () => {
    for (const n of [0, 1, 2, 5, 7, 8, 9]) {
      const run = settle(spec, (r) => ['A', 'B', 'C', 'D'].forEach((bit, i) => r.inject({ type: 'set_reading', target: `S${bit}`, value: (n >> i) & 1 })));
      expect(run.glyph(part(spec, 'X1')), `digit ${n}`).toBe(String(n));
    }
  });

  it('lets behaviour tests name a segment pin, as in "X1.g is lit"', () => {
    const tests = [
      { name: '1', set: { SA: 1, SB: 0, SC: 0, SD: 0 }, on: ['X1.b', 'X1.c'], off: ['X1.a', 'X1.g'] },
      { name: '8 wrong on purpose', set: { SA: 0, SB: 0, SC: 0, SD: 1 }, on: [], off: ['X1.g'] },
    ];
    const issue = electronics.validate({ ...spec, tests }).find((i) => /behaviour tests fail/.test(i.message));
    expect(issue?.message).toMatch(/1 of 2 behaviour tests fail/);
    expect(issue?.message).toMatch(/X1\.g should be off but is on/);
  });

  it('validates, with every segment lighting in some case', () => {
    const issues = electronics.validate({ ...spec, tests: [{ name: '8', set: { SA: 0, SB: 0, SC: 0, SD: 1 }, on: ['X1'], off: [] }] });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
