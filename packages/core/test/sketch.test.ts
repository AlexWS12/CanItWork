import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, type CircuitSpec } from '../src';
import { compile, evaluate } from '../src/domains/electronics/sketch';

type Part = CircuitSpec['parts'][number];
type Custom = NonNullable<Part['custom']>;

const custom = (id: string, def: Pick<Custom, 'label' | 'pins'> & Partial<Custom>): Part => ({
  id,
  type: 'custom',
  custom: { paths: [], switches: [], drivers: [], sources: [], gpio: [], output: false, visual: [], ...def },
});

const steps = (run: CircuitRun, ticks: number) => {
  for (let i = 0; i < ticks; i++) run.step();
};

const calc = (source: string, names: Record<string, number> = {}) => evaluate(compile(source), (name) => names[name] ?? NaN);

const servo = custom('SV', {
  label: 'Servo',
  pins: ['VCC', 'GND', 'SIG'],
  paths: [{ a: 'VCC', b: 'GND', ohms: 25 }],
  supply: { pos: 'VCC', neg: 'GND', minVolts: 4.5, maxVolts: 6 },
  actuator: { quantity: 'angle', pin: 'SIG', min: 0, max: 180 },
});

const lcd = custom('LCD', {
  label: 'LCD',
  pins: ['VCC', 'GND'],
  paths: [{ a: 'VCC', b: 'GND', ohms: 250 }],
  supply: { pos: 'VCC', neg: 'GND', minVolts: 4.5, maxVolts: 5.5 },
  actuator: { quantity: 'text', min: 0, max: 0 },
});

const sweep = (): CircuitSpec => ({
  parts: [{ id: 'U1', type: 'arduino' }, servo, lcd],
  wires: [
    { from: 'U1.5V', to: 'SV.VCC' },
    { from: 'U1.GND', to: 'SV.GND' },
    { from: 'U1.D9', to: 'SV.SIG' },
    { from: 'U1.5V', to: 'LCD.VCC' },
    { from: 'U1.GND', to: 'LCD.GND' },
  ],
  drive: [],
  vars: { angle: 0, step: 5 },
  program: [
    { every: 0.05, then: [{ set: 'angle', to: 'angle + step' }] },
    { when: 'angle >= 180', then: [{ set: 'step', to: -5 }] },
    { when: 'angle <= 0', then: [{ set: 'step', to: 5 }] },
    {
      then: [
        { pin: 'U1.D9', mode: 'angle', value: 'angle' },
        { show: 'LCD', text: 'Angle {angle} deg' },
      ],
    },
  ],
});

const light = (id: string, color: 'red' | 'yellow' | 'green') => [
  { id, type: 'led' as const, color },
  { id: `R${id}`, type: 'resistor' as const, ohms: 220 },
];

const trafficLight = (): CircuitSpec => ({
  parts: [{ id: 'U1', type: 'arduino' }, ...light('RED', 'red'), ...light('YEL', 'yellow'), ...light('GRN', 'green')],
  wires: [
    ['D2', 'RED'],
    ['D3', 'YEL'],
    ['D4', 'GRN'],
  ].flatMap(([pin, id]) => [
    { from: `U1.${pin}`, to: `R${id}.a` },
    { from: `R${id}.b`, to: `${id}.anode` },
    { from: `${id}.cathode`, to: 'U1.GND' },
  ]),
  drive: [],
  program: [
    {
      then: [
        { pin: 'U1.D2', mode: 'pwm', value: 't % 9 < 4 ? 1 : 0' },
        { pin: 'U1.D4', mode: 'pwm', value: 't % 9 >= 4 && t % 9 < 7 ? 1 : 0' },
        { pin: 'U1.D3', mode: 'pwm', value: 't % 9 >= 7 ? 1 : 0' },
      ],
    },
  ],
});

describe('sketch expressions', () => {
  it('follows normal precedence, with conditions, functions and variables', () => {
    expect(calc('2 + 3 * 4')).toBe(14);
    expect(calc('(2 + 3) * 4')).toBe(20);
    expect(calc('-a % 360', { a: 30 })).toBe(330);
    expect(calc('a > 1 && b < 2 ? 10 : 20', { a: 2, b: 1 })).toBe(10);
    expect(calc('!(a == 3) || 0', { a: 3 })).toBe(0);
    expect(calc('clamp(x * 2, 0, 100) + max(1, 2)', { x: 80 })).toBe(102);
    expect(calc('U1.A0 / 1023 * 100', { 'U1.A0': 1023 })).toBe(100);
  });

  it('refuses input it cannot read instead of guessing', () => {
    expect(() => compile('2 +')).toThrow();
    expect(() => compile('alert(1)')).toThrow(/known function/);
    expect(() => compile('a; b')).toThrow();
  });
});

describe('sketches that keep state and track time', () => {
  it('sweeps a servo back and forth and shows the angle', () => {
    const spec = sweep();
    expect(DOMAINS.electronics.validate(spec)).toEqual([]);
    const run = new CircuitRun(spec, 1);
    const angles: number[] = [];
    for (let i = 0; i < 120; i++) {
      run.step();
      angles.push(run.outputs.get('SV') ?? 0);
    }
    expect(Math.max(...angles)).toBeGreaterThanOrEqual(175);
    const top = angles.indexOf(Math.max(...angles));
    expect(angles[top + 10]).toBeLessThan(angles[top]);
    expect(run.texts.get('LCD')).toBe(`Angle ${run.vars.get('angle')} deg`);
  });

  it('runs a timed sequence, and the checks see every light come on', () => {
    const spec = trafficLight();
    expect(DOMAINS.electronics.validate(spec).filter((i) => i.repair)).toEqual([]);
    const run = new CircuitRun(spec, 1);
    const seen = new Set<string>();
    for (let i = 0; i < 12 * 10; i++) {
      run.step();
      for (const id of ['RED', 'YEL', 'GRN']) if ((run.readings.get(id)?.amps ?? 0) > 0.005) seen.add(id);
    }
    expect([...seen].sort()).toEqual(['GRN', 'RED', 'YEL']);
  });

  it('starts the sketch over when the board browns out', () => {
    const spec = sweep();
    spec.parts.push({ id: 'B1', type: 'battery', volts: 9, maxAmps: 2 });
    spec.wires.push({ from: 'B1.pos', to: 'U1.VIN' }, { from: 'B1.neg', to: 'U1.GND' });
    const run = new CircuitRun(spec, 1);
    steps(run, 30);
    expect(run.vars.get('angle')).toBeGreaterThan(50);
    run.inject({ type: 'low_supply', target: 'B1', value: 4 });
    steps(run, 5);
    expect(run.vars.get('angle')).toBe(0);
    expect(run.time()).toBe(0);
  });

  it('rejects a program that uses a name it never defines, or cannot be read', () => {
    const unknown = sweep();
    unknown.program![0].then = [{ set: 'angle', to: 'angle + speed' }];
    expect(DOMAINS.electronics.validate(unknown).some((i) => i.severity === 'error' && i.message.includes('speed'))).toBe(true);
    const broken = sweep();
    broken.program![1].when = 'angle >=';
    expect(DOMAINS.electronics.validate(broken).some((i) => i.severity === 'error' && i.message.includes("can't read"))).toBe(true);
  });

  it('accepts an output that only runs every 30 seconds', () => {
    const spec: CircuitSpec = {
      parts: [
        { id: 'U1', type: 'arduino' },
        { id: 'D1', type: 'led', color: 'green' },
        { id: 'R1', type: 'resistor', ohms: 220 },
      ],
      wires: [
        { from: 'U1.D7', to: 'R1.a' },
        { from: 'R1.b', to: 'D1.anode' },
        { from: 'D1.cathode', to: 'U1.GND' },
      ],
      drive: [],
      program: [{ when: 't % 30 >= 27', then: [{ pin: 'U1.D7', mode: 'high' }], else: [{ pin: 'U1.D7', mode: 'low' }] }],
    };
    expect(DOMAINS.electronics.validate(spec)).toEqual([]);
  });
});

describe('buttons', () => {
  const pedestrian = (): CircuitSpec => ({
    parts: [
      { id: 'U1', type: 'arduino' },
      { id: 'BTN', type: 'button' },
      { id: 'RPD', type: 'resistor', ohms: 10000 },
      { id: 'D1', type: 'led', color: 'white' },
      { id: 'R1', type: 'resistor', ohms: 220 },
    ],
    wires: [
      { from: 'U1.5V', to: 'BTN.a' },
      { from: 'BTN.b', to: 'U1.D5' },
      { from: 'U1.D5', to: 'RPD.a' },
      { from: 'RPD.b', to: 'U1.GND' },
      { from: 'U1.D7', to: 'R1.a' },
      { from: 'R1.b', to: 'D1.anode' },
      { from: 'D1.cathode', to: 'U1.GND' },
    ],
    drive: [],
    vars: { lit: 0 },
    program: [
      { when: 'U1.D5 == 1', then: [{ set: 'lit', to: 't + 3' }] },
      { when: 't < lit', then: [{ pin: 'U1.D7', mode: 'high' }], else: [{ pin: 'U1.D7', mode: 'low' }] },
    ],
  });

  it('stay released until pressed, and a sketch can latch a press', () => {
    const spec = pedestrian();
    expect(DOMAINS.electronics.validate(spec).filter((i) => i.repair)).toEqual([]);
    const run = new CircuitRun(spec, 1);
    steps(run, 12);
    expect(run.read('U1.D5')).toBe(0);
    expect(run.inspect('BTN')?.actions[0].label).toBe('Press');
    run.inject({ type: 'set_reading', target: 'BTN', value: 1 });
    steps(run, 2);
    run.inject({ type: 'set_reading', target: 'BTN', value: 0 });
    steps(run, 12);
    expect(run.readings.get('D1')?.amps ?? 0).toBeGreaterThan(0.005);
    steps(run, 36);
    expect(run.readings.get('D1')?.amps ?? 0).toBeLessThan(0.001);
  });
});
