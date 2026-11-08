import { describe, expect, it } from 'vitest';
import { DOMAINS, SystemRun, evaluate, type CircuitRun, type CircuitSpec, type Domain, type Incident, type NetRun, type NetSpec, type SystemSpec, type TimedEvent } from '../src';

/**
 * The stories a demo tells: break something, and the agents find a fix that helps.
 * Each case here once showed a fix that did nothing, made things worse, or crashed.
 */

// Scored the way the server's recover() does: the failure at 20% of the horizon, each fix after the response delay.
function story(domain: Domain, spec: unknown, incident: Incident) {
  const model = domain.compile(spec);
  const at = Math.floor(domain.horizon * 0.2);
  const ticks = Math.max(at + Math.floor(domain.horizon * 0.6), domain.horizon);
  const events: TimedEvent[] = [{ at, incident }];
  const nothing = evaluate(domain, model, { seed: 1, ticks, events }).score;
  const options = domain.rules.recoveries(model, incident).map((o) => ({
    title: o.title,
    score: evaluate(domain, model, { seed: 1, ticks, events: [...events, { at: at + domain.responseDelay, patches: o.patches }] }).score,
  }));
  const best = options.reduce((a, b) => (b.score > a.score ? b : a), { title: 'none', score: -1 });
  return { nothing, best, options };
}

describe('demo stories', () => {
  it('fleet: offers recoveries for ground robots that already run four hours, instead of throwing', () => {
    const { fleet } = DOMAINS;
    const spec = fleet.rules.spec('sidewalk delivery robots bringing parcels to 12 houses') as { roles: Array<{ endurance: number; range: number; ground?: boolean }> };
    for (const role of spec.roles) Object.assign(role, { endurance: 240, range: 20000, ground: true });
    const model = fleet.compile(fleet.specSchema.parse(spec));
    for (const incident of [undefined, ...fleet.rules.hypotheses(model).map((h) => h.incident)]) {
      const options = fleet.rules.recoveries(model, incident);
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) expect(fleet.patchSchema.safeParse(option.patches[0]).success, option.title).toBe(true);
    }
  });

  // An airport whose links are capped, as the Architect writes them: the gates and their taxi links set the pace.
  const airport: NetSpec = {
    nodes: [
      { id: 'inbound', kind: 'arrivals', rate: 0.35, buffer: 10 },
      { id: 'runway', kind: 'runway', capacity: 0.5 },
      { id: 'gates', kind: 'gates', capacity: 0.022, count: 20 },
      { id: 'departures', kind: 'departure' },
    ],
    edges: [
      { from: 'inbound', to: 'runway', capacity: 0.5, delay: 1 },
      { from: 'runway', to: 'gates', capacity: 0.5, delay: 2 },
      { from: 'gates', to: 'departures', capacity: 0.44, delay: 2 },
    ],
  };

  it('flow: scaling a stage widens its capped links, so the bigger stage really carries more', () => {
    const { airport: domain } = DOMAINS;
    const model = domain.compile(airport);
    const live = domain.createRun(model, 1) as unknown as NetRun;
    live.apply([{ op: 'scale', node: 'gates', count: 40 }]);
    const edges = (live as unknown as { spec: NetSpec }).spec.edges;
    expect(edges.find((e) => e.to === 'gates')!.capacity).toBeCloseTo(1);
    expect(edges.find((e) => e.from === 'gates')!.capacity).toBeCloseTo(0.88);
    expect(edges.find((e) => e.from === 'inbound')!.capacity).toBe(0.5);
  });

  it('flow: a holiday rush has a recovery that beats doing nothing', () => {
    const { airport: domain } = DOMAINS;
    const { nothing, best } = story(domain, airport, { type: 'surge', value: 1.5 });
    expect(nothing).toBeLessThan(95);
    expect(best.score, `${best.title} vs doing nothing ${nothing}`).toBeGreaterThan(nothing + 5);
  });

  it('power: a heat wave has a recovery that beats doing nothing, and more generation never blacks out a feeder', () => {
    const { power } = DOMAINS;
    const preset = power.rules.spec(power.examples[0]);
    const surge = power.rules.hypotheses(power.compile(preset)).find((h) => h.incident.type === 'surge')!.incident;
    const { nothing, best } = story(power, preset, surge);
    expect(best.score, `${best.title} vs doing nothing ${nothing}`).toBeGreaterThan(nothing);
    // A line that only runs at its rating is the bottleneck, not overloaded: it stays closed.
    const run = power.createRun(power.compile(preset), 1) as unknown as NetRun;
    run.inject(surge);
    for (let t = 0; t < 10; t++) run.step();
    run.apply([{ op: 'scale', node: 'gas', count: 3 }]);
    for (let t = 0; t < 80; t++) run.step();
    expect([...run.links.values()].filter((l) => l.tripped)).toEqual([]);
    expect(run.ratio).toBeGreaterThan(0.95);
  });

  // A switch lights an LED. With the switch off, as a run starts, a loose wire or a dead switch changes nothing visible.
  const lamp: CircuitSpec = {
    parts: [
      { id: 'B1', type: 'battery', volts: 5 },
      { id: 'S1', type: 'switch' },
      { id: 'R1', type: 'resistor', ohms: 330 },
      { id: 'D1', type: 'led', color: 'green' },
    ],
    wires: [
      { from: 'B1.pos', to: 'S1.a' },
      { from: 'S1.b', to: 'R1.a' },
      { from: 'R1.b', to: 'D1.anode' },
      { from: 'D1.cathode', to: 'B1.neg' },
    ],
    drive: [],
    tests: [
      { name: 'off', set: { S1: 0 }, on: [], off: ['D1'] },
      { name: 'on', set: { S1: 1 }, on: ['D1'], off: [] },
    ],
  };

  it('electronics: judges a loose wire at every tested input, and reseating it wins', () => {
    const { electronics } = DOMAINS;
    const { nothing, best } = story(electronics, lamp, { type: 'loose_wire', target: 'W1' });
    expect(nothing).toBeLessThanOrEqual(50);
    expect(best.title).toBe('Reseat W1');
    expect(best.score).toBeGreaterThan(95);
    const run = electronics.createRun(electronics.compile(lamp), 1);
    run.inject({ type: 'loose_wire', target: 'W1' });
    for (let t = 0; t < 20; t++) run.step();
    expect(run.evaluation().metrics.find((m) => m.label === 'behaviour tests passing')?.value).toBe('1/2');
  });

  it('electronics: a healthy run is scored exactly as before, with no tests rerun', () => {
    const { electronics } = DOMAINS;
    const run = electronics.createRun(electronics.compile(lamp), 1);
    for (let t = 0; t < 20; t++) run.step();
    expect(run.evaluation().metrics.some((m) => m.label === 'behaviour tests passing')).toBe(false);
  });

  it('electronics: replacing a shorted resistor also replaces the LED the short burned out', () => {
    const { electronics } = DOMAINS;
    const led: CircuitSpec = {
      parts: [
        { id: 'B1', type: 'battery', volts: 9 },
        { id: 'R1', type: 'resistor', ohms: 470 },
        { id: 'D1', type: 'led', color: 'red' },
      ],
      wires: [
        { from: 'B1.pos', to: 'R1.a' },
        { from: 'R1.b', to: 'D1.anode' },
        { from: 'D1.cathode', to: 'B1.neg' },
      ],
      drive: [],
    };
    const { nothing, best, options } = story(electronics, led, { type: 'short_part', target: 'R1' });
    expect(options[0].title).toBe('Replace R1 and D1');
    expect(best.score).toBeGreaterThan(nothing + 30);
  });

  it('electronics: a sketch reading a burned potentiometer holds the servo instead of showing NaN', () => {
    const { electronics } = DOMAINS;
    const servo = electronics.specSchema.parse({
      parts: [
        { id: 'A1', type: 'arduino', usb: true },
        { id: 'POT1', type: 'pot', ohms: 10000 },
        {
          id: 'SERVO1',
          type: 'custom',
          custom: { label: 'Hobby Servo', pins: ['SIG', 'VCC', 'GND'], paths: [{ a: 'VCC', b: 'GND', ohms: 1000 }], actuator: { quantity: 'angle', pin: 'SIG', min: 0, max: 180 } },
        },
      ],
      wires: [
        { from: 'POT1.a', to: 'A1.5V' },
        { from: 'POT1.wiper', to: 'A1.A0' },
        { from: 'POT1.b', to: 'A1.GND' },
        { from: 'SERVO1.VCC', to: 'A1.5V' },
        { from: 'SERVO1.GND', to: 'A1.GND' },
        { from: 'SERVO1.SIG', to: 'A1.D9' },
      ],
      drive: [{ pin: 'A1.D9', mode: 'angle', value: 90 }],
      program: [
        {
          every: 0.02,
          then: [
            { set: 'pot_angle', to: 'round((A1.A0 / 1023.0) * 180)' },
            { pin: 'A1.D9', mode: 'angle', value: 'pot_angle' },
          ],
        },
      ],
    });
    for (const type of ['burn_part', 'short_part']) {
      const run = electronics.createRun(electronics.compile(servo), 1);
      for (let t = 0; t < 10; t++) run.step();
      run.inject({ type, target: 'POT1' });
      for (let t = 0; t < 40; t++) run.step();
      for (const m of [...run.telemetry(), ...run.evaluation().metrics]) expect(String(m.value), `${type}: ${m.label}`).not.toMatch(/NaN|Infinity/);
    }
  });

  it('software: a dead consumer behind a queue costs requests once its messages pass retention', () => {
    const spec: SystemSpec = {
      traffic: 300,
      retries: 2,
      nodes: [
        { id: 'users', kind: 'client' },
        { id: 'api', kind: 'service', replicas: 3 },
        { id: 'events', kind: 'queue' },
        { id: 'worker', kind: 'service', replicas: 2 },
      ],
      edges: [
        { from: 'users', to: 'api' },
        { from: 'api', to: 'events', mode: 'async' },
        { from: 'events', to: 'worker', mode: 'async' },
      ],
    };
    const run = new SystemRun(spec, 1);
    run.inject({ type: 'node_down', target: 'worker' });
    for (let i = 0; i < 60; i++) run.step();
    // The queue still decouples a short outage.
    expect(run.success).toBeGreaterThan(0.95);
    for (let i = 0; i < 140; i++) run.step();
    expect(run.expired).toBeGreaterThan(0);
    expect(run.success).toBeLessThan(0.5);
    // A healthy queue never expires anything.
    const healthy = new SystemRun(spec, 1);
    for (let i = 0; i < 300; i++) healthy.step();
    expect(healthy.expired).toBe(0);
  });

  it('electronics: an op-amp follower that saturated while its input was loose settles back once the wire is reseated', () => {
    const { electronics } = DOMAINS;
    const follower = electronics.specSchema.parse({
      parts: [
        { id: 'B1', type: 'battery', volts: 9 },
        { id: 'R1', type: 'resistor', ohms: 10000 },
        { id: 'R2', type: 'resistor', ohms: 10000 },
        {
          id: 'U1',
          type: 'custom',
          custom: {
            label: 'LM358',
            pins: ['OUT', 'INM', 'INP', 'VCC', 'GND'],
            paths: [{ a: 'VCC', b: 'GND', ohms: 10000 }],
            amplifiers: [{ out: 'OUT', plus: 'INP', minus: 'INM', high: 'VCC', low: 'GND' }],
          },
        },
        { id: 'RL', type: 'resistor', ohms: 10000 },
      ],
      wires: [
        { from: 'B1.pos', to: 'R1.a' },
        { from: 'R1.b', to: 'R2.a' },
        { from: 'R2.b', to: 'B1.neg' },
        { from: 'R1.b', to: 'U1.INP' },
        { from: 'U1.OUT', to: 'U1.INM' },
        { from: 'B1.pos', to: 'U1.VCC' },
        { from: 'U1.GND', to: 'B1.neg' },
        { from: 'U1.OUT', to: 'RL.a' },
        { from: 'RL.b', to: 'B1.neg' },
      ],
    });
    const run = electronics.createRun(electronics.compile(follower), 1) as CircuitRun;
    const out = () => run.voltsBetween('U1.OUT', 'B1.neg');
    for (let t = 0; t < 20; t++) run.step();
    const healthy = out();
    expect(healthy).toBeGreaterThan(4);
    run.inject({ type: 'loose_wire', target: 'W1' });
    for (let t = 0; t < 20; t++) run.step();
    expect(out()).toBeLessThan(1);
    run.apply([{ op: 'secure_wire', wire: 'W1' }]);
    for (let t = 0; t < 20; t++) run.step();
    expect(out()).toBeCloseTo(healthy, 1);
  });
});
