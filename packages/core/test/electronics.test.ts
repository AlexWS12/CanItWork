import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, evaluate, type CircuitSpec } from '../src';

const { electronics } = DOMAINS;

const ledCircuit = (ohms: number | null, extra: Partial<CircuitSpec> = {}): CircuitSpec => ({
  parts: [{ id: 'U1', type: 'arduino' }, { id: 'D1', type: 'led', color: 'red' }, ...(ohms ? [{ id: 'R1', type: 'resistor' as const, ohms }] : [])],
  wires: ohms
    ? [
        { from: 'U1.D13', to: 'R1.a' },
        { from: 'R1.b', to: 'D1.anode' },
        { from: 'D1.cathode', to: 'U1.GND' },
      ]
    : [
        { from: 'U1.D13', to: 'D1.anode' },
        { from: 'D1.cathode', to: 'U1.GND' },
      ],
  drive: [{ pin: 'U1.D13', mode: 'high' }],
  ...extra,
});

const runFor = (spec: CircuitSpec, ticks: number) => {
  const run = new CircuitRun(spec, 1);
  for (let i = 0; i < ticks; i++) run.step();
  return run;
};

const servo = (volts: number, maxVolts = 6): CircuitSpec['parts'][number] => ({
  id: 'SV1',
  type: 'custom',
  custom: {
    label: 'Servo',
    pins: ['VCC', 'GND', 'SIG'],
    paths: [{ a: 'VCC', b: 'GND', ohms: volts / 0.25 }],
    switches: [],
    drivers: [],
    sources: [],
    gpio: [],
    supply: { pos: 'VCC', neg: 'GND', minVolts: 4, maxVolts },
    output: true,
    visual: [],
  },
});

type Part = CircuitSpec['parts'][number];
type Custom = NonNullable<Part['custom']>;

const customPart = (id: string, def: Pick<Custom, 'label' | 'pins'> & Partial<Custom>): Part => ({
  id,
  type: 'custom',
  custom: { paths: [], switches: [], drivers: [], sources: [], gpio: [], output: false, visual: [], ...def },
});

const soil = (pin?: string) =>
  customPart('S1', {
    label: 'Soil sensor',
    pins: ['VCC', 'GND', 'AO'],
    paths: [{ a: 'VCC', b: 'GND', ohms: 500 }],
    supply: { pos: 'VCC', neg: 'GND', minVolts: 3, maxVolts: 5.5 },
    sensor: { quantity: 'soil moisture', unit: '%', min: 0, max: 100, value: 60, pin },
  });

const wateringRig = (read: string, below: number): CircuitSpec => ({
  parts: [
    { id: 'U1', type: 'arduino' },
    { id: 'B1', type: 'battery', volts: 9, maxAmps: 2 },
    { id: 'P1', type: 'motor', volts: 9, ohms: 9, maxAmps: 1.5 },
    soil('AO'),
    customPart('K1', {
      label: 'Relay',
      pins: ['IN', 'VCC', 'GND', 'COM', 'NO'],
      paths: [{ a: 'VCC', b: 'GND', ohms: 70 }],
      switches: [{ a: 'COM', b: 'NO', ohms: 0.05, when: 'IN', ref: 'GND', aboveVolts: 2 }],
    }),
  ],
  wires: [
    { from: 'U1.5V', to: 'S1.VCC' },
    { from: 'U1.GND', to: 'S1.GND' },
    { from: 'S1.AO', to: 'U1.A0' },
    { from: 'U1.D7', to: 'K1.IN' },
    { from: 'U1.5V', to: 'K1.VCC' },
    { from: 'U1.GND', to: 'K1.GND' },
    { from: 'B1.neg', to: 'U1.GND' },
    { from: 'B1.pos', to: 'K1.COM' },
    { from: 'K1.NO', to: 'P1.a' },
    { from: 'P1.b', to: 'B1.neg' },
  ],
  drive: [],
  program: [{ if: { read, op: '<', value: below }, then: [{ pin: 'U1.D7', mode: 'high' }], else: [{ pin: 'U1.D7', mode: 'low' }] }],
});

const pwmMotor = (duty: number): CircuitSpec => ({
  parts: [
    { id: 'U1', type: 'arduino' },
    { id: 'B1', type: 'battery', volts: 9, maxAmps: 2 },
    { id: 'H1', type: 'motor_driver' },
    { id: 'M1', type: 'motor', volts: 9 },
  ],
  wires: [
    { from: 'B1.pos', to: 'H1.VS' },
    { from: 'B1.neg', to: 'H1.GND' },
    { from: 'B1.neg', to: 'U1.GND' },
    { from: 'U1.5V', to: 'H1.VCC' },
    { from: 'U1.D5', to: 'H1.ENA' },
    { from: 'U1.D7', to: 'H1.IN1' },
    { from: 'U1.D8', to: 'H1.IN2' },
    { from: 'H1.OUT1', to: 'M1.a' },
    { from: 'H1.OUT2', to: 'M1.b' },
  ],
  drive: [
    { pin: 'U1.D5', mode: 'pwm', value: duty },
    { pin: 'U1.D7', mode: 'high' },
    { pin: 'U1.D8', mode: 'low' },
  ],
});

describe('electronics over time', () => {
  it('waters only when the analog reading says the soil is dry, and drying soil is not a failure', () => {
    const spec = wateringRig('U1.A0', 300);
    expect(electronics.validate(spec).filter((i) => i.repair)).toEqual([]);
    const run = runFor(spec, 20);
    expect(run.read('U1.A0')).toBeGreaterThan(600);
    expect(run.isRunning(spec.parts[2])).toBe(false);
    run.inject({ type: 'set_reading', target: 'S1', value: 20 });
    for (let i = 0; i < 20; i++) run.step();
    expect(run.read('U1.A0')).toBeLessThan(250);
    expect(run.speeds.get('P1')!).toBeGreaterThan(0.5);
    expect(run.telemetry()[0].value).toBe('1/1');
  });

  it('treats a stuck sensor as a failure because the pump runs when it should not', () => {
    const run = runFor(wateringRig('S1', 30), 20);
    expect(run.telemetry()[0].value).toBe('1/1');
    run.inject({ type: 'sensor_fault', target: 'S1', value: 0 });
    for (let i = 0; i < 20; i++) run.step();
    expect(run.speeds.get('P1')!).toBeGreaterThan(0.5);
    expect(run.telemetry()[0].value).toBe('0/1');
    run.apply([{ op: 'replace_part', part: 'S1' }]);
    for (let i = 0; i < 40; i++) run.step();
    expect(run.telemetry()[0].value).toBe('1/1');
  });

  it('turns a servo to the angle the sketch asks for, and a design change is not a failure', () => {
    const spec: CircuitSpec = {
      parts: [
        { id: 'U1', type: 'arduino' },
        customPart('SV1', {
          label: 'Servo',
          pins: ['VCC', 'GND', 'SIG'],
          paths: [{ a: 'VCC', b: 'GND', ohms: 25 }],
          supply: { pos: 'VCC', neg: 'GND', minVolts: 4, maxVolts: 6 },
          actuator: { quantity: 'angle', pin: 'SIG', min: 0, max: 180 },
        }),
      ],
      wires: [
        { from: 'U1.5V', to: 'SV1.VCC' },
        { from: 'U1.GND', to: 'SV1.GND' },
        { from: 'U1.D9', to: 'SV1.SIG' },
      ],
      drive: [{ pin: 'U1.D9', mode: 'angle', value: 45 }],
    };
    expect(electronics.validate(spec)).toEqual([]);
    const run = runFor(spec, 3);
    expect(run.outputs.get('SV1')).toBeCloseTo(45);
    run.apply([{ op: 'set_drive', pin: 'U1.D9', mode: 'angle', value: 120 }]);
    run.step();
    expect(run.outputs.get('SV1')).toBeCloseTo(120);
    expect(run.telemetry()[0].value).toBe('1/1');
  });

  it('shows live readings on a display, and flags a display nothing writes to', () => {
    const lcd = customPart('L1', {
      label: 'LCD',
      pins: ['VCC', 'GND'],
      paths: [{ a: 'VCC', b: 'GND', ohms: 250 }],
      supply: { pos: 'VCC', neg: 'GND', minVolts: 4.5, maxVolts: 5.5 },
      actuator: { quantity: 'text', min: 0, max: 0 },
    });
    const spec: CircuitSpec = {
      parts: [{ id: 'U1', type: 'arduino' }, soil(), lcd],
      wires: [
        { from: 'U1.5V', to: 'S1.VCC' },
        { from: 'U1.GND', to: 'S1.GND' },
        { from: 'U1.5V', to: 'L1.VCC' },
        { from: 'U1.GND', to: 'L1.GND' },
      ],
      drive: [],
      program: [{ then: [{ show: 'L1', text: 'Soil {S1}' }] }],
    };
    expect(electronics.validate(spec)).toEqual([]);
    const run = runFor(spec, 3);
    expect(run.texts.get('L1')).toBe('Soil 60%');
    run.inject({ type: 'set_reading', target: 'S1', value: 35 });
    run.step();
    expect(run.texts.get('L1')).toBe('Soil 35%');
    const silent = electronics.validate({ ...spec, program: [] });
    expect(silent.some((i) => i.repair && i.message.includes('no program rule shows anything'))).toBe(true);
  });

  it('charges a capacitor with the RC time constant', () => {
    const run = runFor(
      {
        parts: [
          { id: 'B1', type: 'battery', volts: 5 },
          { id: 'R1', type: 'resistor', ohms: 1000 },
          { id: 'C1', type: 'capacitor', farads: 0.001 },
        ],
        wires: [
          { from: 'B1.pos', to: 'R1.a' },
          { from: 'R1.b', to: 'C1.a' },
          { from: 'C1.b', to: 'B1.neg' },
        ],
        drive: [],
      },
      12,
    );
    expect(run.capVolts.get('C1')!).toBeCloseTo(5 * (1 - Math.exp(-1)), 1);
  });

  it('browns out a board on VIN when its battery sags, unless USB is plugged in', () => {
    const spec = ledCircuit(220, {});
    spec.parts.push({ id: 'B1', type: 'battery', volts: 9 });
    spec.wires.push({ from: 'B1.pos', to: 'U1.VIN' }, { from: 'B1.neg', to: 'U1.GND' });
    const run = runFor(spec, 5);
    expect(run.boardOn.get('U1')).toBe(true);
    expect(run.isRunning(spec.parts[1])).toBe(true);
    run.inject({ type: 'low_supply', target: 'B1', value: 5 });
    for (let i = 0; i < 20; i++) run.step();
    expect(run.boardOn.get('U1')).toBe(false);
    expect(run.telemetry()[0].value).toBe('0/1');
    run.apply([{ op: 'set_usb', part: 'U1', usb: true }]);
    for (let i = 0; i < 20; i++) run.step();
    expect(run.boardOn.get('U1')).toBe(true);
    expect(run.isRunning(spec.parts[1])).toBe(true);
  });

  it('sets motor speed with PWM through the enable pin', () => {
    const speed = (duty: number) => runFor(pwmMotor(duty), 48).speeds.get('M1')!;
    const full = speed(1);
    const half = speed(0.5);
    expect(full).toBeGreaterThan(0.5);
    expect(half).toBeGreaterThan(full * 0.3);
    expect(half).toBeLessThan(full * 0.9);
    expect(speed(0)).toBeLessThan(0.05);
  });

  it('draws inrush current when a motor starts, then less once it spins', () => {
    const run = runFor(pwmMotor(1), 1);
    const inrush = run.readings.get('M1')!.amps;
    for (let i = 0; i < 40; i++) run.step();
    expect(run.readings.get('M1')!.amps).toBeLessThan(inrush / 2);
  });

  it('rejects a program that reads or drives something that is not there', () => {
    const reads = wateringRig('S9', 30);
    expect(electronics.validate(reads).some((i) => i.severity === 'error' && i.message.includes('reads S9'))).toBe(true);
    const drives = wateringRig('S1', 30);
    drives.program![0].then = [{ pin: 'K1.IN', mode: 'high' }];
    expect(electronics.validate(drives).some((i) => i.severity === 'error' && i.message.includes('K1.IN'))).toBe(true);
  });
});

describe('electronics', () => {
  it('runs a component it has never seen from its own definition', () => {
    const spec: CircuitSpec = {
      parts: [{ id: 'U1', type: 'arduino' }, servo(5)],
      wires: [
        { from: 'U1.5V', to: 'SV1.VCC' },
        { from: 'U1.GND', to: 'SV1.GND' },
      ],
      drive: [],
    };
    expect(electronics.validate(spec)).toEqual([]);
    const run = runFor(spec, 3);
    expect(run.readings.get('SV1')!.amps).toBeCloseTo(0.25, 1);
    expect(run.isRunning(spec.parts[1])).toBe(true);
    expect(run.telemetry()[0].value).toBe('1/1');
  });

  it('burns a custom part given too much voltage', () => {
    const spec: CircuitSpec = {
      parts: [{ id: 'B1', type: 'battery', volts: 12 }, servo(5)],
      wires: [
        { from: 'B1.pos', to: 'SV1.VCC' },
        { from: 'B1.neg', to: 'SV1.GND' },
      ],
      drive: [],
    };
    expect(runFor(spec, 20).burned.has('SV1')).toBe(true);
  });

  it('lets a custom board power and drive things at its own logic level', () => {
    const spec: CircuitSpec = {
      parts: [
        {
          id: 'E1',
          type: 'custom',
          custom: {
            label: 'ESP32',
            pins: ['3V3', 'GND', 'IO2'],
            paths: [],
            switches: [],
            drivers: [],
            sources: [{ pos: '3V3', neg: 'GND', volts: 3.3, ohms: 0.5 }],
            gpio: ['IO2'],
            gpioVolts: 3.3,
            output: false,
            visual: [],
          },
        },
        { id: 'R1', type: 'resistor', ohms: 220 },
        { id: 'D1', type: 'led', color: 'red' },
      ],
      wires: [
        { from: 'E1.IO2', to: 'R1.a' },
        { from: 'R1.b', to: 'D1.anode' },
        { from: 'D1.cathode', to: 'E1.GND' },
      ],
      drive: [{ pin: 'E1.IO2', mode: 'high' }],
    };
    expect(electronics.validate(spec)).toEqual([]);
    expect(runFor(spec, 3).readings.get('D1')!.amps).toBeCloseTo((3.3 - 1.9) / (25 + 220 + 12), 3);
  });

  it('switches a pump through a relay only when the control pin is high', () => {
    const spec: CircuitSpec = {
      parts: [
        { id: 'U1', type: 'arduino' },
        { id: 'B1', type: 'battery', volts: 9 },
        { id: 'P1', type: 'motor' },
        {
          id: 'K1',
          type: 'custom',
          custom: {
            label: 'Relay',
            pins: ['IN', 'VCC', 'GND', 'COM', 'NO'],
            paths: [{ a: 'VCC', b: 'GND', ohms: 70 }],
            switches: [{ a: 'COM', b: 'NO', ohms: 0.05, when: 'IN', ref: 'GND', aboveVolts: 2 }],
            drivers: [],
            sources: [],
            gpio: [],
            output: false,
            visual: [],
          },
        },
      ],
      wires: [
        { from: 'U1.D7', to: 'K1.IN' },
        { from: 'U1.5V', to: 'K1.VCC' },
        { from: 'U1.GND', to: 'K1.GND' },
        { from: 'B1.neg', to: 'U1.GND' },
        { from: 'B1.pos', to: 'K1.COM' },
        { from: 'K1.NO', to: 'P1.a' },
        { from: 'P1.b', to: 'B1.neg' },
      ],
      drive: [{ pin: 'U1.D7', mode: 'high' }],
    };
    expect(runFor(spec, 4).readings.get('P1')!.volts).toBeGreaterThan(6);
    const off = { ...spec, drive: [{ pin: 'U1.D7', mode: 'low' as const }] };
    expect(runFor(off, 4).readings.get('P1')?.volts ?? 0).toBeLessThan(0.5);
  });

  it('drives a coil from a stepper driver it has never seen', () => {
    const output = (pin: string, invert: boolean) => ({ pin, high: 'VMOT', low: 'GND', when: 'STEP', ref: 'GND', aboveVolts: 2, ohms: 1, invert });
    const spec: CircuitSpec = {
      parts: [
        { id: 'U1', type: 'arduino' },
        { id: 'B1', type: 'battery', volts: 12 },
        { id: 'M1', type: 'motor' },
        {
          id: 'A1',
          type: 'custom',
          custom: {
            label: 'A4988',
            pins: ['VMOT', 'GND', 'STEP', '1A', '1B'],
            paths: [],
            switches: [],
            drivers: [output('1A', false), output('1B', true)],
            sources: [],
            gpio: [],
            output: false,
            visual: [],
          },
        },
      ],
      wires: [
        { from: 'B1.pos', to: 'A1.VMOT' },
        { from: 'B1.neg', to: 'A1.GND' },
        { from: 'B1.neg', to: 'U1.GND' },
        { from: 'U1.D3', to: 'A1.STEP' },
        { from: 'A1.1A', to: 'M1.a' },
        { from: 'A1.1B', to: 'M1.b' },
      ],
      drive: [{ pin: 'U1.D3', mode: 'high' }],
    };
    expect(runFor(spec, 4).readings.get('M1')!.volts).toBeGreaterThan(6);
  });

  it('says a part is over its voltage rating instead of claiming it never turns on', () => {
    const spec: CircuitSpec = {
      parts: [{ id: 'B1', type: 'battery', volts: 7.4 }, servo(7.4)],
      wires: [
        { from: 'B1.pos', to: 'SV1.VCC' },
        { from: 'B1.neg', to: 'SV1.GND' },
      ],
      drive: [],
    };
    const messages = electronics.validate(spec).map((i) => i.message);
    expect(messages.some((m) => /SV1 gets 7\.\d V, above its 6 V maximum/.test(m))).toBe(true);
    expect(messages.some((m) => m.includes('never turns on'))).toBe(false);
  });

  it('names the root cause when a battery is overloaded, and lets a bigger pack fix it', () => {
    const spec = (maxAmps?: number): CircuitSpec => ({
      parts: [{ id: 'B1', type: 'battery', volts: 6, maxAmps }, ...['M1', 'M2', 'M3', 'M4'].map((id) => ({ id, type: 'motor' as const, volts: 6 }))],
      wires: ['M1', 'M2', 'M3', 'M4'].flatMap((m) => [
        { from: 'B1.pos', to: `${m}.a` },
        { from: `${m}.b`, to: 'B1.neg' },
      ]),
      drive: [],
    });
    const issues = electronics.validate(spec());
    const battery = issues.find((i) => i.target === 'B1');
    expect(battery?.repair).toBe(true);
    expect(battery?.message).toMatch(/\d+ mA.* its 1000 mA rating/);
    expect(electronics.validate(spec(4)).filter((i) => i.repair)).toEqual([]);
  });

  it('rates a motor for the voltage it was built for', () => {
    const pump = (ohms?: number, maxAmps?: number, volts?: number): CircuitSpec => ({
      parts: [
        { id: 'B1', type: 'battery', volts: 12, maxAmps: 3 },
        { id: 'P1', type: 'motor', ohms, maxAmps, volts },
      ],
      wires: [
        { from: 'B1.pos', to: 'P1.a' },
        { from: 'P1.b', to: 'B1.neg' },
      ],
      drive: [],
    });
    expect(electronics.validate(pump()).some((i) => i.target === 'P1' && i.repair)).toBe(true);
    expect(electronics.validate(pump(12, 1.5)).find((i) => i.target === 'P1')?.message).toMatch(/too much for a 6 V motor/);
    expect(electronics.validate(pump(12, 1.5, 12)).filter((i) => i.repair)).toEqual([]);
  });

  it('rejects a custom part that uses a pin it does not have', () => {
    const part = servo(5);
    part.custom!.paths = [{ a: 'VCC', b: 'NOPE', ohms: 10 }];
    const spec: CircuitSpec = { parts: [{ id: 'U1', type: 'arduino' }, part], wires: [], drive: [] };
    expect(electronics.validate(spec).some((i) => i.severity === 'error' && i.message.includes('NOPE'))).toBe(true);
  });

  it('flags a circuit where nothing does anything, so it gets redesigned', () => {
    const spec: CircuitSpec = {
      parts: [
        { id: 'U1', type: 'arduino' },
        { id: 'B1', type: 'battery' },
      ],
      wires: [],
      drive: [],
    };
    expect(electronics.validate(spec).some((i) => i.repair && i.message.includes('Nothing in this circuit'))).toBe(true);
  });

  it("solves an LED and resistor to the current Ohm's law predicts", () => {
    const run = runFor(ledCircuit(220), 3);
    expect(run.readings.get('D1')!.amps).toBeCloseTo((5 - 1.9) / (25 + 220 + 12), 3);
    expect(run.burned.size).toBe(0);
  });

  it('solves a resistor divider on a battery', () => {
    const run = runFor(
      {
        parts: [
          { id: 'B1', type: 'battery', volts: 9 },
          { id: 'R1', type: 'resistor', ohms: 1000 },
          { id: 'R2', type: 'resistor', ohms: 2000 },
        ],
        wires: [
          { from: 'B1.pos', to: 'R1.a' },
          { from: 'R1.b', to: 'R2.a' },
          { from: 'R2.b', to: 'B1.neg' },
        ],
        drive: [],
      },
      2,
    );
    expect(run.readings.get('R2')!.volts).toBeCloseTo(6, 1);
    expect(run.readings.get('R1')!.amps).toBeCloseTo(0.003, 4);
  });

  it('burns an LED with no resistor, and the checks say so before it runs', () => {
    const spec = ledCircuit(null);
    const run = runFor(spec, 20);
    expect(run.burned.has('D1')).toBe(true);
    expect(electronics.validate(spec).some((i) => i.message.includes('burns out'))).toBe(true);
  });

  it('flags an LED wired backwards instead of pretending it works', () => {
    const spec = ledCircuit(220);
    spec.wires[1] = { from: 'R1.b', to: 'D1.cathode' };
    spec.wires[2] = { from: 'D1.anode', to: 'U1.GND' };
    expect(electronics.validate(spec).some((i) => i.message.includes('never turns on'))).toBe(true);
  });

  it('rejects wiring to a pin that does not exist', () => {
    const spec = ledCircuit(220);
    spec.wires[0] = { from: 'U1.D99', to: 'R1.a' };
    expect(electronics.validate(spec).filter((i) => i.severity === 'error')).toHaveLength(1);
  });

  it('runs a motor through a driver, and not when the battery is lost', () => {
    const spec = electronics.rules.spec('an arduino with a motor driver and two motors');
    expect(electronics.validate(spec).filter((i) => i.severity === 'error')).toEqual([]);
    const healthy = runFor(spec, 5);
    expect(healthy.readings.get('MOT1')!.volts).toBeGreaterThan(4);
    const dead = new CircuitRun(spec, 1);
    dead.inject({ type: 'low_supply', target: 'B1', value: 1 });
    for (let i = 0; i < 5; i++) dead.step();
    expect(dead.readings.get('MOT1')!.volts).toBeLessThan(1.5);
  });

  it('a shorted resistor destroys what it protected, and a resistor fixes the bare LED', () => {
    const scenario = { seed: 1, ticks: 200 };
    const healthy = evaluate(electronics, ledCircuit(220), { ...scenario, events: [] });
    const shorted = evaluate(electronics, ledCircuit(220), { ...scenario, events: [{ at: 50, incident: { type: 'short_part', target: 'R1' } }] });
    expect(shorted.score).toBeLessThan(healthy.score);
    const fixed = evaluate(electronics, ledCircuit(null), {
      ...scenario,
      events: [{ at: 0, patches: [{ op: 'insert_resistor', wire: 'W1', ohms: 220 }] }],
    });
    expect(fixed.score).toBeGreaterThan(evaluate(electronics, ledCircuit(null), { ...scenario, events: [] }).score);
  });
});
