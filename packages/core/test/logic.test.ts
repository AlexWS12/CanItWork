import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, type CircuitSpec } from '../src';

const { electronics } = DOMAINS;
type SpecPart = CircuitSpec['parts'][number];

const chip = (id: string, label: string, outputs: Record<string, string>, inputs: string[], state?: NonNullable<SpecPart['custom']>['state']): SpecPart => ({
  id,
  type: 'custom',
  package: 'dip',
  custom: {
    label,
    pins: ['VCC', 'GND', ...inputs, ...Object.keys(outputs)],
    paths: [{ a: 'VCC', b: 'GND', ohms: 5000 }],
    switches: [],
    drivers: Object.entries(outputs).map(([pin, when]) => ({ pin, high: 'VCC', low: 'GND', when, ref: 'GND', aboveVolts: 2.5, ohms: 50, invert: false })),
    sources: [],
    gpio: [],
    supply: { pos: 'VCC', neg: 'GND', minVolts: 2, maxVolts: 6 },
    output: false,
    visual: [],
    state,
  },
});

// Each input is a switch from +5 V with a 10k pull-down; each output drives an LED through 330 ohms.
function board(chips: SpecPart[], inputs: Record<string, string>, outputs: Record<string, string>, extraWires: CircuitSpec['wires'] = []): CircuitSpec {
  const parts: SpecPart[] = [{ id: 'B1', type: 'battery', volts: 5, maxAmps: 2 }, ...chips];
  const wires: CircuitSpec['wires'] = [...extraWires];
  for (const c of chips) wires.push({ from: 'B1.pos', to: `${c.id}.VCC` }, { from: `${c.id}.GND`, to: 'B1.neg' });
  for (const [sw, pin] of Object.entries(inputs)) {
    parts.push({ id: sw, type: 'switch' }, { id: `R${sw}`, type: 'resistor', ohms: 10000 });
    wires.push({ from: 'B1.pos', to: `${sw}.a` }, { from: `${sw}.b`, to: pin }, { from: pin, to: `R${sw}.a` }, { from: `R${sw}.b`, to: 'B1.neg' });
  }
  for (const [led, pin] of Object.entries(outputs)) {
    parts.push({ id: led, type: 'led', color: 'green' }, { id: `R${led}`, type: 'resistor', ohms: 330 });
    wires.push({ from: pin, to: `R${led}.a` }, { from: `R${led}.b`, to: `${led}.anode` }, { from: `${led}.cathode`, to: 'B1.neg' });
  }
  return { parts, wires, drive: [], layout: 'breadboard' };
}

const lit = (run: CircuitRun, ids: string[]) => ids.map((id) => (run.isRunning(run.spec.parts.find((p) => p.id === id)!) ? 1 : 0)).join('');

describe('logic chips', () => {
  // A 2-bit adder from a 74HC86 (XOR), a 74HC08 (AND) and a 74HC32 (OR), chained through each other's pins.
  const adder = board(
    [
      chip('U1', '74HC86 quad XOR', { Y1: 'A1 != B1', Y2: 'A2 != B2', Y3: 'A3 != B3' }, ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']),
      chip('U2', '74HC08 quad AND', { Y1: 'A1 && B1', Y2: 'A2 && B2', Y3: 'A3 && B3' }, ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']),
      chip('U3', '74HC32 quad OR', { Y1: 'A1 || B1' }, ['A1', 'B1']),
    ],
    { SA0: 'U1.A1', SB0: 'U1.B1', SA1: 'U1.A2', SB1: 'U1.B2' },
    { S0: 'U1.Y1', S1: 'U1.Y3', C: 'U3.Y1' },
    [
      // carry0 = A0 AND B0
      { from: 'U1.A1', to: 'U2.A1' },
      { from: 'U1.B1', to: 'U2.B1' },
      // S1 = (A1 XOR B1) XOR carry0
      { from: 'U1.Y2', to: 'U1.A3' },
      { from: 'U2.Y1', to: 'U1.B3' },
      // carry = (A1 AND B1) OR ((A1 XOR B1) AND carry0)
      { from: 'U1.A2', to: 'U2.A2' },
      { from: 'U1.B2', to: 'U2.B2' },
      { from: 'U1.Y2', to: 'U2.A3' },
      { from: 'U2.Y1', to: 'U2.B3' },
      { from: 'U2.Y2', to: 'U3.A1' },
      { from: 'U2.Y3', to: 'U3.B1' },
    ],
  );

  it('adds every pair of 2-bit numbers', () => {
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        const run = new CircuitRun(adder, 1);
        const set = (id: string, on: number) => run.inject({ type: 'set_reading', target: id, value: on });
        set('SA0', a & 1);
        set('SA1', a >> 1);
        set('SB0', b & 1);
        set('SB1', b >> 1);
        for (let i = 0; i < 4; i++) run.step();
        const sum = a + b;
        expect(lit(run, ['C', 'S1', 'S0']), `${a} + ${b}`).toBe([sum >> 2, (sum >> 1) & 1, sum & 1].join(''));
      }
    }
  });

  it('passes validation with no warnings about LEDs that never light', () => {
    const issues = electronics.validate(adder);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.filter((i) => /never turns on/.test(i.message))).toEqual([]);
  });

  it('rejects a logic expression naming a pin the chip lacks', () => {
    const bad = structuredClone(adder);
    bad.parts.find((p) => p.id === 'U3')!.custom!.drivers[0].when = 'A1 || Q9';
    expect(electronics.validate(bad).some((i) => i.severity === 'error' && /Q9/.test(i.message))).toBe(true);
  });

  it('goes dark when the chips lose power', () => {
    const run = new CircuitRun(adder, 1);
    run.inject({ type: 'set_reading', target: 'SA0', value: 1 });
    for (let i = 0; i < 4; i++) run.step();
    expect(lit(run, ['S0'])).toBe('1');
    run.inject({ type: 'low_supply', target: 'B1', value: 0.5 });
    for (let i = 0; i < 4; i++) run.step();
    expect(lit(run, ['S0'])).toBe('0');
  });
});

describe('sequential chips', () => {
  // A 555 in astable mode: the capacitor charges through RA + RB and discharges through RB.
  const timer: SpecPart = {
    id: 'U1',
    type: 'custom',
    package: 'dip',
    custom: {
      label: 'NE555 timer',
      pins: ['GND', 'TRIG', 'OUT', 'RST', 'CV', 'THR', 'DIS', 'VCC'],
      paths: [{ a: 'VCC', b: 'GND', ohms: 1500 }],
      switches: [{ a: 'DIS', b: 'GND', ohms: 10, when: '!q', ref: 'GND', aboveVolts: 2 }],
      drivers: [{ pin: 'OUT', high: 'VCC', low: 'GND', when: 'q', ref: 'GND', aboveVolts: 2, ohms: 20, invert: false }],
      sources: [],
      gpio: [],
      supply: { pos: 'VCC', neg: 'GND', minVolts: 4.5, maxVolts: 16 },
      output: false,
      visual: [],
      state: {
        ref: 'GND',
        aboveVolts: 2,
        vars: { q: 1 },
        rules: [
          { when: 'v.TRIG < v.VCC / 3', set: 'q', to: 1 },
          { when: 'v.THR > v.VCC * 2 / 3', set: 'q', to: 0 },
        ],
      },
    },
  };
  const blinker: CircuitSpec = {
    parts: [
      { id: 'B1', type: 'battery', volts: 9, maxAmps: 0.5 },
      timer,
      { id: 'RA', type: 'resistor', ohms: 1000 },
      { id: 'RB', type: 'resistor', ohms: 4700 },
      { id: 'C1', type: 'capacitor', farads: 0.0001 },
      { id: 'R1', type: 'resistor', ohms: 470 },
      { id: 'D1', type: 'led', color: 'red' },
    ],
    wires: [
      { from: 'B1.pos', to: 'U1.VCC' },
      { from: 'B1.pos', to: 'U1.RST' },
      { from: 'U1.GND', to: 'B1.neg' },
      { from: 'B1.pos', to: 'RA.a' },
      { from: 'RA.b', to: 'U1.DIS' },
      { from: 'U1.DIS', to: 'RB.a' },
      { from: 'RB.b', to: 'U1.THR' },
      { from: 'U1.THR', to: 'U1.TRIG' },
      { from: 'U1.THR', to: 'C1.a' },
      { from: 'C1.b', to: 'B1.neg' },
      { from: 'U1.OUT', to: 'R1.a' },
      { from: 'R1.b', to: 'D1.anode' },
      { from: 'D1.cathode', to: 'B1.neg' },
    ],
    drive: [],
  };

  it('a 555 astable blinks its LED at roughly the textbook rate', () => {
    const run = new CircuitRun(blinker, 1);
    const led = blinker.parts.find((p) => p.id === 'D1')!;
    let edges = 0;
    let was = false;
    const ticks = 12 * 10;
    for (let i = 0; i < ticks; i++) {
      run.step();
      const now = run.isRunning(led);
      if (now && !was) edges++;
      was = now;
    }
    // f = 1.44 / ((RA + 2 RB) C) = 1.38 Hz, so about 14 flashes in 10 s; the 1/48 s substep blurs it a little.
    expect(edges).toBeGreaterThanOrEqual(9);
    expect(edges).toBeLessThanOrEqual(18);
  });

  it('a counter advances on each rising clock edge', () => {
    const counter = chip('U2', '74HC161 4-bit counter', { Q0: 'n % 2 >= 1', Q1: 'n % 4 >= 2', Q2: 'n % 8 >= 4', Q3: 'n % 16 >= 8' }, ['CLK'], {
      ref: 'GND',
      aboveVolts: 2.5,
      vars: { n: 0 },
      rules: [{ edge: 'CLK', set: 'n', to: '(n + 1) % 16' }],
    });
    const spec = board([counter], { SW: 'U2.CLK' }, { L0: 'U2.Q0', L1: 'U2.Q1', L2: 'U2.Q2', L3: 'U2.Q3' });
    const run = new CircuitRun(spec, 1);
    const press = (n: number) => {
      for (let k = 0; k < n; k++) {
        run.inject({ type: 'set_reading', target: 'SW', value: 1 });
        run.step();
        run.step();
        run.inject({ type: 'set_reading', target: 'SW', value: 0 });
        run.step();
        run.step();
      }
    };
    press(5);
    expect(lit(run, ['L3', 'L2', 'L1', 'L0'])).toBe('0101');
    press(6);
    expect(lit(run, ['L3', 'L2', 'L1', 'L0'])).toBe('1011');
  });
});

describe('behaviour tests', () => {
  const andGate = (when: string): CircuitSpec => {
    const spec = board([chip('U1', '74HC08 AND', { Y1: when }, ['A1', 'B1'])], { S1: 'U1.A1', S2: 'U1.B1' }, { L1: 'U1.Y1' });
    spec.tests = [
      { name: '0 0', set: { S1: 0, S2: 0 }, on: [], off: ['L1'] },
      { name: '1 0', set: { S1: 1, S2: 0 }, on: [], off: ['L1'] },
      { name: '0 1', set: { S1: 0, S2: 1 }, on: [], off: ['L1'] },
      { name: '1 1', set: { S1: 1, S2: 1 }, on: ['L1'], off: [] },
    ];
    return spec;
  };

  it('passes a correct AND gate', () => {
    expect(electronics.validate(andGate('A1 && B1')).filter((i) => /behaviour tests/.test(i.message))).toEqual([]);
  });

  it('names the failing rows of a gate wired as OR', () => {
    const issue = electronics.validate(andGate('A1 || B1')).find((i) => /behaviour tests/.test(i.message));
    expect(issue?.repair).toBe(true);
    expect(issue?.message).toMatch(/2 of 4 behaviour tests fail/);
    expect(issue?.message).toMatch(/"1 0" \(S1=1, S2=0\): L1 should be off but is on/);
  });

  it('accepts custom fields written beside the type', () => {
    const parsed = electronics.specSchema.parse({
      parts: [{ id: 'Q1', type: 'custom', label: '2N2222', pins: ['C', 'B', 'E'], switches: [{ a: 'C', b: 'E', when: 'B', ref: 'E', aboveVolts: 0.65 }] }],
      wires: [],
    });
    expect(parsed.parts[0].custom?.pins).toEqual(['C', 'B', 'E']);
  });
});

describe('Red Team rules on logic circuits', () => {
  it('attack from the test case that lights the most outputs, so the damage shows', () => {
    const spec = board([chip('U1', '74HC08 AND', { Y1: 'A1 && B1' }, ['A1', 'B1'])], { S1: 'U1.A1', S2: 'U1.B1' }, { L1: 'U1.Y1' });
    spec.tests = [
      { name: 'both off', set: { S1: 0, S2: 0 }, on: [], off: ['L1'] },
      { name: 'both on', set: { S1: 1, S2: 1 }, on: ['L1'], off: [] },
    ];
    const claims = electronics.rules.hypotheses(spec);
    const chipClaim = claims.find((c) => c.incident.type === 'burn_part');
    expect(chipClaim?.incident.target).toBe('U1');
    expect(chipClaim?.setup).toEqual([
      { type: 'set_reading', target: 'S1', value: 1 },
      { type: 'set_reading', target: 'S2', value: 1 },
    ]);
    // With the setup applied, burning the chip really does take the LED out.
    const run = new CircuitRun(spec, 1);
    for (const incident of chipClaim!.setup!) run.inject(incident);
    for (let i = 0; i < 4; i++) run.step();
    expect(lit(run, ['L1'])).toBe('1');
    run.inject(chipClaim!.incident);
    for (let i = 0; i < 4; i++) run.step();
    expect(lit(run, ['L1'])).toBe('0');
  });
});
