import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, evaluate, type CircuitSpec } from '../src';

type Part = CircuitSpec['parts'][number];
type Custom = NonNullable<Part['custom']>;

const custom = (id: string, def: Pick<Custom, 'label' | 'pins'> & Partial<Custom>, extra: Partial<Part> = {}): Part => ({
  id,
  type: 'custom',
  ...extra,
  custom: { paths: [], switches: [], drivers: [], sources: [], gpio: [], output: false, visual: [], ...def },
});

const steps = (run: CircuitRun, ticks: number) => {
  for (let i = 0; i < ticks; i++) run.step();
};

const greenhouse = (on = 35, off = 60): CircuitSpec => ({
  parts: [
    { id: 'U1', type: 'arduino' },
    { id: 'B1', type: 'battery', volts: 9, maxAmps: 2 },
    { id: 'P1', type: 'motor', volts: 9, ohms: 9, maxAmps: 1.5 },
    custom(
      'S1',
      {
        label: 'Soil sensor',
        pins: ['VCC', 'GND', 'AO'],
        paths: [{ a: 'VCC', b: 'GND', ohms: 500 }],
        supply: { pos: 'VCC', neg: 'GND', minVolts: 3, maxVolts: 5.5 },
        sensor: { quantity: 'soil moisture', unit: '%', min: 0, max: 100 },
      },
      { measures: 'soil' },
    ),
    custom('K1', {
      label: 'Relay',
      pins: ['IN', 'VCC', 'GND', 'COM', 'NO'],
      paths: [{ a: 'VCC', b: 'GND', ohms: 70 }],
      switches: [{ a: 'COM', b: 'NO', ohms: 0.05, when: 'IN', ref: 'GND', aboveVolts: 2 }],
    }),
  ],
  wires: [
    { from: 'U1.5V', to: 'S1.VCC' },
    { from: 'U1.GND', to: 'S1.GND' },
    { from: 'U1.D7', to: 'K1.IN' },
    { from: 'U1.5V', to: 'K1.VCC' },
    { from: 'U1.GND', to: 'K1.GND' },
    { from: 'B1.neg', to: 'U1.GND' },
    { from: 'B1.pos', to: 'K1.COM' },
    { from: 'K1.NO', to: 'P1.a' },
    { from: 'P1.b', to: 'B1.neg' },
  ],
  drive: [],
  vars: { watering: 0 },
  program: [
    { when: `S1 < ${on}`, then: [{ set: 'watering', to: 1 }] },
    { when: `S1 > ${off}`, then: [{ set: 'watering', to: 0 }] },
    { when: 'watering == 1', then: [{ pin: 'U1.D7', mode: 'high' }], else: [{ pin: 'U1.D7', mode: 'low' }] },
  ],
  world: [{ id: 'soil', label: 'Soil moisture', unit: '%', start: 50, min: 0, max: 100, drift: -1.5, effects: [{ from: 'P1', rate: 8 }], target: { min: 30, max: 70 } }],
});

const robot = (stop: 'brake' | 'coast' | null): CircuitSpec => ({
  parts: [
    { id: 'U1', type: 'arduino' },
    { id: 'B1', type: 'battery', volts: 7.4, maxAmps: 5 },
    { id: 'H1', type: 'motor_driver' },
    { id: 'M1', type: 'motor', volts: 6 },
    { id: 'US1', type: 'ultrasonic', measures: 'wall' },
  ],
  wires: [
    { from: 'B1.pos', to: 'H1.VS' },
    { from: 'B1.neg', to: 'H1.GND' },
    { from: 'B1.neg', to: 'U1.GND' },
    { from: 'U1.5V', to: 'H1.VCC' },
    { from: 'U1.D3', to: 'H1.ENA' },
    { from: 'U1.D4', to: 'H1.IN1' },
    { from: 'U1.D5', to: 'H1.IN2' },
    { from: 'H1.OUT1', to: 'M1.a' },
    { from: 'H1.OUT2', to: 'M1.b' },
    { from: 'U1.5V', to: 'US1.VCC' },
    { from: 'U1.GND', to: 'US1.GND' },
    { from: 'US1.ECHO', to: 'U1.D12' },
  ],
  drive: [
    { pin: 'U1.D4', mode: 'high' },
    { pin: 'U1.D5', mode: 'low' },
    { pin: 'U1.D3', mode: 'pwm', value: 0.8 },
  ],
  program: stop === null ? [] : [{ when: 'US1 < 30', then: [stop === 'brake' ? { pin: 'U1.D4', mode: 'low' } : { pin: 'U1.D3', mode: 'low' }] }],
  world: [{ id: 'wall', label: 'Distance to wall', unit: 'cm', start: 150, min: 0, max: 400, effects: [{ from: 'M1', rate: -40 }], target: { min: 10, max: 400 } }],
});

describe('the physical world around a circuit', () => {
  it('keeps the soil in range when the sketch waters on a low reading', () => {
    const spec = greenhouse();
    expect(DOMAINS.electronics.validate(spec)).toEqual([]);
    const run = new CircuitRun(spec, 1);
    const soil: number[] = [];
    for (let i = 0; i < 12 * 90; i++) {
      run.step();
      soil.push(run.world.get('soil')!);
    }
    const settled = soil.slice(12 * 10);
    expect(Math.min(...settled)).toBeGreaterThan(30);
    expect(Math.max(...settled)).toBeLessThan(70);
    expect(run.telemetry().some((m) => m.label === 'soil moisture')).toBe(true);
    expect(run.read('S1')).toBeCloseTo(soil[soil.length - 1], 5);
  });

  it('lets the soil dry out when the pump fails, and the score shows it', () => {
    const spec = greenhouse();
    const ticks = 12 * 90;
    const healthy = evaluate(DOMAINS.electronics, spec, { seed: 1, ticks, events: [] });
    const broken = evaluate(DOMAINS.electronics, spec, { seed: 1, ticks, events: [{ at: 120, incident: { type: 'burn_part', target: 'P1' } }] });
    expect(healthy.scoreLabel).toBe('% of outputs and targets OK');
    expect(broken.score).toBeLessThan(healthy.score - 20);
    expect(broken.metrics.find((m) => m.label === 'soil moisture on target')!.value).not.toBe('100%');
  });

  it('rejects a controller that never brings the soil back into range', () => {
    const issues = DOMAINS.electronics.validate(greenhouse(5, 15));
    expect(issues.some((i) => i.repair && i.message.startsWith('Soil moisture stays within 30–70 %'))).toBe(true);
  });

  it('drives a robot toward a wall, and only a sketch that brakes in time passes the checks', () => {
    expect(DOMAINS.electronics.validate(robot('brake')).filter((i) => i.repair)).toEqual([]);
    for (const stop of ['coast', null] as const) {
      expect(DOMAINS.electronics.validate(robot(stop)).some((i) => i.repair && i.message.startsWith('Distance to wall'))).toBe(true);
    }
    const run = new CircuitRun(robot('brake'), 1);
    steps(run, 12 * 20);
    expect(run.world.get('wall')!).toBeGreaterThan(10);
    expect(run.world.get('wall')!).toBeLessThan(40);
  });

  it('changes conditions by setting the quantity a sensor measures', () => {
    const run = new CircuitRun(greenhouse(), 1);
    steps(run, 5);
    run.inject({ type: 'set_reading', target: 'S1', value: 10 });
    expect(run.world.get('soil')).toBe(10);
    run.inject({ type: 'set_reading', target: 'soil', value: 90 });
    expect(run.read('S1')).toBe(90);
  });

  it('rejects a world that points at parts or quantities that are not there', () => {
    const spec = greenhouse();
    spec.world![0].effects = [{ from: 'NOPE', rate: 1 }];
    (spec.parts[3] as Part).measures = 'humidity';
    const errors = DOMAINS.electronics.validate(spec).filter((i) => i.severity === 'error');
    expect(errors.some((i) => i.message.includes('NOPE'))).toBe(true);
    expect(errors.some((i) => i.message.includes('humidity'))).toBe(true);
  });
});

describe('heaters and other loads switched by a relay', () => {
  it('counts an actuator nothing drives from a board pin as fully on while it has power', () => {
    const spec = greenhouse();
    spec.parts = spec.parts.filter((p) => p.id !== 'P1');
    spec.parts.push(
      custom('HT', { label: 'Heater', pins: ['A', 'B'], paths: [{ a: 'A', b: 'B', ohms: 14 }], output: true, actuator: { quantity: 'brightness', pin: 'A', min: 0, max: 1 } }),
    );
    spec.wires = spec.wires.map((w) => ({
      from: w.from.replace('P1', 'HT').replace('.a', '.A').replace('.b', '.B'),
      to: w.to.replace('P1', 'HT').replace('.a', '.A').replace('.b', '.B'),
    }));
    spec.world = [
      { id: 'room', label: 'Room', unit: 'C', start: 18, min: 0, max: 40, toward: { value: 10, rate: 0.02 }, effects: [{ from: 'HT', rate: 0.6 }], target: { min: 20, max: 23 } },
    ];
    spec.parts.find((p) => p.id === 'S1')!.measures = 'room';
    spec.program = [{ when: 'S1 < 21.5', then: [{ pin: 'U1.D7', mode: 'high' }], else: [{ pin: 'U1.D7', mode: 'low' }] }];
    spec.vars = {};
    expect(DOMAINS.electronics.validate(spec).filter((i) => i.repair)).toEqual([]);
  });
});

describe('explaining why a design fails', () => {
  it('says a motor was still turning when the robot reached the wall', () => {
    const message = DOMAINS.electronics.validate(robot('coast')).find((i) => i.message.startsWith('Distance to wall'))!.message;
    expect(message).toMatch(/first left the range after [\d.]+ s/);
    expect(message).toMatch(/M1 at \d+% \(motors take a moment to stop/);
  });

  it('says when a quantity never reaches its target at all', () => {
    const spec = greenhouse();
    spec.world![0].start = 5;
    spec.world![0].effects = [];
    const message = DOMAINS.electronics.validate(spec).find((i) => i.message.startsWith('Soil moisture'))!.message;
    expect(message).toMatch(/never reached the range from its start of 5$/);
  });

  it('says what voltage a relay needs when its coil never pulls in', () => {
    const spec = greenhouse();
    const relay = spec.parts.find((p) => p.id === 'K1')!.custom!;
    relay.switches[0].aboveVolts = 6;
    const message = DOMAINS.electronics.validate(spec).find((i) => i.target === 'K1')?.message;
    expect(message).toBe('K1 never connects COM to NO: it needs IN at least 6 V above GND, but gets 5 V');
  });
});
