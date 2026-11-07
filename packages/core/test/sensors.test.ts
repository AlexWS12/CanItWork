import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, type CircuitSpec } from '../src';

type Part = CircuitSpec['parts'][number];
type Custom = NonNullable<Part['custom']>;

const custom = (id: string, def: Pick<Custom, 'label' | 'pins'> & Partial<Custom>): Part => ({
  id,
  type: 'custom',
  custom: { paths: [], switches: [], drivers: [], sources: [], gpio: [], output: false, visual: [], ...def },
});

const runFor = (spec: CircuitSpec, ticks: number) => {
  const run = new CircuitRun(spec, 1);
  for (let i = 0; i < ticks; i++) run.step();
  return run;
};

const steps = (run: CircuitRun, ticks: number) => {
  for (let i = 0; i < ticks; i++) run.step();
};

const vent = (read: string, text: string): CircuitSpec => ({
  parts: [
    { id: 'U1', type: 'arduino' },
    custom('DHT', {
      label: 'DHT22',
      pins: ['VCC', 'DATA', 'GND'],
      paths: [{ a: 'VCC', b: 'GND', ohms: 2000 }],
      supply: { pos: 'VCC', neg: 'GND', minVolts: 3.3, maxVolts: 6 },
      sensor: { quantity: 'temperature', unit: 'C', min: -40, max: 80, value: 22 },
    }),
    custom('SV', {
      label: 'Vent servo',
      pins: ['VCC', 'GND', 'SIG'],
      paths: [{ a: 'VCC', b: 'GND', ohms: 25 }],
      supply: { pos: 'VCC', neg: 'GND', minVolts: 4.5, maxVolts: 6 },
      actuator: { quantity: 'angle', pin: 'SIG', min: 0, max: 180 },
    }),
    custom('LCD', {
      label: 'LCD',
      pins: ['VCC', 'GND'],
      paths: [{ a: 'VCC', b: 'GND', ohms: 250 }],
      supply: { pos: 'VCC', neg: 'GND', minVolts: 4.5, maxVolts: 5.5 },
      actuator: { quantity: 'text', min: 0, max: 0 },
    }),
  ],
  wires: [
    { from: 'U1.5V', to: 'DHT.VCC' },
    { from: 'U1.GND', to: 'DHT.GND' },
    { from: 'DHT.DATA', to: 'U1.D2' },
    { from: 'U1.5V', to: 'SV.VCC' },
    { from: 'U1.GND', to: 'SV.GND' },
    { from: 'U1.D9', to: 'SV.SIG' },
    { from: 'U1.5V', to: 'LCD.VCC' },
    { from: 'U1.GND', to: 'LCD.GND' },
  ],
  drive: [{ pin: 'U1.D9', mode: 'angle', value: 0 }],
  program: [
    { if: { read, op: '>', value: 28 }, then: [{ pin: 'U1.D9', mode: 'angle', value: 90 }], else: [{ pin: 'U1.D9', mode: 'angle', value: 0 }] },
    { then: [{ show: 'LCD', text }] },
  ],
});

const robot = (): CircuitSpec => ({
  parts: [
    { id: 'U1', type: 'arduino' },
    { id: 'B1', type: 'battery', volts: 7.4, maxAmps: 5 },
    { id: 'H1', type: 'motor_driver' },
    { id: 'M1', type: 'motor', volts: 6 },
    { id: 'US1', type: 'ultrasonic' },
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
    { from: 'U1.D11', to: 'US1.TRIG' },
    { from: 'US1.ECHO', to: 'U1.D12' },
  ],
  drive: [
    { pin: 'U1.D4', mode: 'high' },
    { pin: 'U1.D5', mode: 'low' },
  ],
  program: [{ if: { read: 'U1.D12', op: '<', value: 20 }, then: [{ pin: 'U1.D3', mode: 'pwm', value: 0.3 }], else: [{ pin: 'U1.D3', mode: 'pwm', value: 0.9 }] }],
});

describe('checking a design', () => {
  it('flags a coil that stays over its rating, even when it dips below it now and then', () => {
    const output = (pin: string, invert: boolean) => ({ pin, high: 'VMOT', low: 'GND', when: 'STEP', ref: 'GND', aboveVolts: 2, ohms: 1.5, invert });
    const spec: CircuitSpec = {
      parts: [
        { id: 'U1', type: 'arduino' },
        { id: 'PSU', type: 'battery', volts: 12, maxAmps: 5 },
        { id: 'M1', type: 'motor', volts: 12, ohms: 4, maxAmps: 1.5 },
        custom('DRV', { label: 'A4988', pins: ['VMOT', 'GND', 'STEP', '1A', '1B'], drivers: [output('1A', false), output('1B', true)], maxAmps: 4 }),
      ],
      wires: [
        { from: 'PSU.pos', to: 'DRV.VMOT' },
        { from: 'PSU.neg', to: 'DRV.GND' },
        { from: 'PSU.neg', to: 'U1.GND' },
        { from: 'U1.D3', to: 'DRV.STEP' },
        { from: 'DRV.1A', to: 'M1.a' },
        { from: 'DRV.1B', to: 'M1.b' },
      ],
      drive: [{ pin: 'U1.D3', mode: 'blink', period: 10 }],
    };
    expect(DOMAINS.electronics.validate(spec).some((i) => i.target === 'M1' && i.repair)).toBe(true);
  });
});

describe('reading sensors the way a sketch does', () => {
  it('reads a digital sensor through the board pin it is wired to, in its own unit', () => {
    const run = runFor(vent('U1.D2', 'T {DHT}'), 10);
    expect(run.read('U1.D2')).toBe(22);
    expect(run.read('DHT.DATA')).toBe(22);
    expect(run.outputs.get('SV')).toBeCloseTo(0);
    run.inject({ type: 'set_reading', target: 'DHT', value: 33 });
    steps(run, 5);
    expect(run.outputs.get('SV')).toBeCloseTo(90);
    expect(run.texts.get('LCD')).toBe('T 33C');
  });

  it('reads the same value through the sensor id or its own pin', () => {
    expect(runFor(vent('DHT', 'x'), 5).read('DHT')).toBe(22);
    expect(runFor(vent('DHT.DATA', 'x'), 5).read('DHT.DATA')).toBe(22);
  });

  it('does not repeat a unit the display text already writes', () => {
    expect(runFor(vent('DHT', 'T:{DHT}C'), 5).texts.get('LCD')).toBe('T:22C');
    expect(runFor(vent('DHT', 'T:{DHT} °C'), 5).texts.get('LCD')).toBe('T:22 °C');
  });

  it('gives no reading from an unpowered sensor', () => {
    const spec = vent('U1.D2', 'T {DHT}');
    const run = runFor(spec, 5);
    run.inject({ type: 'loose_wire', target: 'W1' });
    steps(run, 3);
    expect(Number.isNaN(run.read('U1.D2'))).toBe(true);
    expect(run.texts.get('LCD')).toBe('T --');
  });

  it('measures distance with an ultrasonic sensor, so a robot slows near a wall', () => {
    const spec = robot();
    expect(DOMAINS.electronics.validate(spec).filter((i) => i.repair)).toEqual([]);
    const run = runFor(spec, 40);
    expect(run.read('U1.D12')).toBe(100);
    const cruising = run.speeds.get('M1')!;
    run.inject({ type: 'set_reading', target: 'US1', value: 10 });
    steps(run, 40);
    expect(run.speeds.get('M1')!).toBeLessThan(cruising * 0.7);
    expect(run.breakables().some((b) => b.incident.type === 'sensor_fault' && b.incident.target === 'US1')).toBe(true);
  });
});
