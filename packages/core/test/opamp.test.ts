import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, type CircuitSpec } from '../src';

type SpecPart = CircuitSpec['parts'][number];

// An LM358-style op-amp on a single 9 V supply, with a pot setting its input.
const opamp: SpecPart = {
  id: 'U1',
  type: 'custom',
  package: 'dip',
  custom: {
    label: 'LM358 op-amp',
    pins: ['OUT', 'IN-', 'IN+', 'GND', 'VCC'],
    paths: [{ a: 'VCC', b: 'GND', ohms: 9000 }],
    switches: [],
    drivers: [],
    sources: [],
    gpio: [],
    output: false,
    visual: [],
    amplifiers: [{ out: 'OUT', plus: 'IN+', minus: 'IN-', high: 'VCC', low: 'GND', gain: 100000, ohms: 75, headroom: 0.1 }],
  },
};

// Input from a pot across the supply, so the test can sweep it; output measured across a 10k load.
function circuit(feedback: CircuitSpec['wires'], extra: SpecPart[] = []): CircuitSpec {
  return {
    parts: [{ id: 'B1', type: 'battery', volts: 9, maxAmps: 1 }, opamp, { id: 'P1', type: 'pot', ohms: 10000 }, { id: 'RL', type: 'resistor', ohms: 10000 }, ...extra],
    wires: [
      { from: 'B1.pos', to: 'U1.VCC' },
      { from: 'U1.GND', to: 'B1.neg' },
      { from: 'B1.pos', to: 'P1.a' },
      { from: 'P1.b', to: 'B1.neg' },
      { from: 'U1.OUT', to: 'RL.a' },
      { from: 'RL.b', to: 'B1.neg' },
      ...feedback,
    ],
    drive: [],
  };
}

const settle = (spec: CircuitSpec, pot: number) => {
  const run = new CircuitRun(spec, 1);
  run.inject({ type: 'set_reading', target: 'P1', value: pot });
  for (let i = 0; i < 4; i++) run.step();
  return { out: run.voltsBetween('U1.OUT', 'B1.neg'), input: run.voltsBetween('P1.wiper', 'B1.neg') };
};

describe('op-amps', () => {
  it('a non-inverting amplifier has gain 1 + R2/R1', () => {
    // R2 = 100k from OUT to IN-, R1 = 10k from IN- to ground: gain 11.
    const spec = circuit(
      [
        { from: 'P1.wiper', to: 'U1.IN+' },
        { from: 'U1.OUT', to: 'R2.a' },
        { from: 'R2.b', to: 'U1.IN-' },
        { from: 'U1.IN-', to: 'R1.a' },
        { from: 'R1.b', to: 'B1.neg' },
      ],
      [
        { id: 'R1', type: 'resistor', ohms: 10000 },
        { id: 'R2', type: 'resistor', ohms: 100000 },
      ],
    );
    // A 5% pot setting is about 0.45 V in; 11x is about 4.95 V out.
    const { out, input } = settle(spec, 5);
    expect(out / input).toBeCloseTo(11, 1);
  });

  it('a buffer follows its input', () => {
    const spec = circuit([
      { from: 'P1.wiper', to: 'U1.IN+' },
      { from: 'U1.OUT', to: 'U1.IN-' },
    ]);
    for (const pot of [20, 50, 70]) {
      const { out, input } = settle(spec, pot);
      expect(out).toBeCloseTo(input, 2);
    }
  });

  it('saturates near the supply rail instead of exceeding it', () => {
    const spec = circuit(
      [
        { from: 'P1.wiper', to: 'U1.IN+' },
        { from: 'U1.OUT', to: 'R2.a' },
        { from: 'R2.b', to: 'U1.IN-' },
        { from: 'U1.IN-', to: 'R1.a' },
        { from: 'R1.b', to: 'B1.neg' },
      ],
      [
        { id: 'R1', type: 'resistor', ohms: 10000 },
        { id: 'R2', type: 'resistor', ohms: 100000 },
      ],
    );
    // 50% is 4.5 V in; 11x would be 49.5 V, so the output pins near 9 V.
    const { out } = settle(spec, 50);
    expect(out).toBeGreaterThan(8.5);
    expect(out).toBeLessThan(9.01);
  });

  it('with no feedback it acts as a comparator against a reference divider', () => {
    const spec = circuit(
      [
        { from: 'P1.wiper', to: 'U1.IN+' },
        { from: 'B1.pos', to: 'RA.a' },
        { from: 'RA.b', to: 'U1.IN-' },
        { from: 'U1.IN-', to: 'RB.a' },
        { from: 'RB.b', to: 'B1.neg' },
      ],
      [
        { id: 'RA', type: 'resistor', ohms: 10000 },
        { id: 'RB', type: 'resistor', ohms: 10000 },
      ],
    );
    expect(settle(spec, 30).out).toBeLessThan(0.5);
    expect(settle(spec, 70).out).toBeGreaterThan(8.5);
  });

  it('validates the op-amp pins', () => {
    const spec = circuit([{ from: 'P1.wiper', to: 'U1.IN+' }]);
    const bad = structuredClone(spec);
    bad.parts.find((p) => p.id === 'U1')!.custom!.amplifiers![0].minus = 'INV';
    expect(DOMAINS.electronics.validate(bad).some((i) => i.severity === 'error' && /INV/.test(i.message))).toBe(true);
  });
});

describe('datasheet pin names in chip logic', () => {
  it('reads expressions over pins like IN1+ and IN1-, as an LM393 comparator', () => {
    const spec: CircuitSpec = {
      parts: [
        { id: 'B1', type: 'battery', volts: 9 },
        {
          id: 'U1',
          type: 'custom',
          package: 'dip',
          custom: {
            label: 'LM393 comparator',
            pins: ['OUT1', 'IN1-', 'IN1+', 'GND', 'VCC'],
            paths: [{ a: 'VCC', b: 'GND', ohms: 9000 }],
            switches: [{ a: 'OUT1', b: 'GND', ohms: 10, when: 'v.IN1+ < v.IN1-', ref: 'GND', aboveVolts: 0 }],
            drivers: [],
            sources: [],
            gpio: [],
            output: false,
            visual: [],
          },
        },
        { id: 'P1', type: 'pot', ohms: 10000 },
        { id: 'RA', type: 'resistor', ohms: 10000 },
        { id: 'RB', type: 'resistor', ohms: 10000 },
        { id: 'RL', type: 'resistor', ohms: 1000 },
        { id: 'D1', type: 'led', color: 'red' },
      ],
      wires: [
        { from: 'B1.pos', to: 'U1.VCC' },
        { from: 'U1.GND', to: 'B1.neg' },
        { from: 'B1.pos', to: 'P1.a' },
        { from: 'P1.b', to: 'B1.neg' },
        { from: 'P1.wiper', to: 'U1.IN1+' },
        { from: 'B1.pos', to: 'RA.a' },
        { from: 'RA.b', to: 'U1.IN1-' },
        { from: 'U1.IN1-', to: 'RB.a' },
        { from: 'RB.b', to: 'B1.neg' },
        { from: 'B1.pos', to: 'RL.a' },
        { from: 'RL.b', to: 'D1.anode' },
        { from: 'D1.cathode', to: 'U1.OUT1' },
      ],
      drive: [],
    };
    expect(DOMAINS.electronics.validate(spec).filter((i) => i.severity === 'error')).toEqual([]);
    // Open-collector output: it sinks the LED's current while IN1+ is below IN1-.
    expect(settle(spec, 20).out).toBeDefined();
    const led = (pot: number) => {
      const run = new CircuitRun(spec, 1);
      run.inject({ type: 'set_reading', target: 'P1', value: pot });
      for (let i = 0; i < 4; i++) run.step();
      return run.isRunning(spec.parts.find((p) => p.id === 'D1')!);
    };
    expect(led(20)).toBe(true);
    expect(led(80)).toBe(false);
  });
});
