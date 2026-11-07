import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, SchemaRun, SystemRun, domainList, evaluate, type CircuitSpec, type DatabaseSpec, type SystemSpec } from '../src';
import type { Domain } from '../src';

const { electronics, software, database } = DOMAINS;

const ledCircuit = (ohms: number | null, extra: Partial<CircuitSpec> = {}): CircuitSpec => ({
  parts: [
    { id: 'U1', type: 'arduino' },
    { id: 'D1', type: 'led', color: 'red' },
    ...(ohms ? [{ id: 'R1', type: 'resistor' as const, ohms }] : []),
  ],
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

describe('electronics', () => {
  it('solves an LED and resistor to the current Ohm\'s law predicts', () => {
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

const threeTier = (overrides: Partial<SystemSpec> = {}): SystemSpec => ({
  traffic: 300,
  retries: 2,
  nodes: [
    { id: 'users', kind: 'client' },
    { id: 'gateway', kind: 'gateway', replicas: 2 },
    { id: 'api', kind: 'service', replicas: 3 },
    { id: 'db', kind: 'database' },
    { id: 'events', kind: 'queue' },
    { id: 'worker', kind: 'service', replicas: 2 },
  ],
  edges: [
    { from: 'users', to: 'gateway' },
    { from: 'gateway', to: 'api' },
    { from: 'api', to: 'db' },
    { from: 'api', to: 'events', mode: 'async' },
    { from: 'events', to: 'worker', mode: 'async' },
  ],
  ...overrides,
});

describe('software', () => {
  const ticks = 120;
  const healthy = evaluate(software, threeTier(), { seed: 1, ticks, events: [] });

  it('serves everything when healthy', () => {
    expect(healthy.score).toBeGreaterThan(99);
  });

  it('cascades a database failure to the client, and failover restores it', () => {
    const events = [{ at: 30, incident: { type: 'node_down', target: 'db' } }];
    const down = evaluate(software, threeTier(), { seed: 1, ticks, events });
    expect(down.score).toBeLessThan(60);
    const failedOver = evaluate(software, threeTier(), { seed: 1, ticks, events: [...events, { at: 45, patches: [{ op: 'failover', node: 'db' }] }] });
    expect(failedOver.score).toBeGreaterThan(down.score + 20);
  });

  it('keeps serving through a queue when the consumer dies, while the backlog grows', () => {
    const run = new SystemRun(threeTier(), 1);
    run.inject({ type: 'node_down', target: 'worker' });
    for (let i = 0; i < 60; i++) run.step();
    expect(run.success).toBeGreaterThan(0.95);
    expect(run.states.get('events')!.backlog).toBeGreaterThan(1000);
  });

  it('amplifies load with retries when a dependency is failing', () => {
    const load = (retries: number) => {
      const run = new SystemRun(threeTier({ retries }), 1);
      run.inject({ type: 'node_down', target: 'db' });
      for (let i = 0; i < 20; i++) run.step();
      return run.states.get('db')!.inflow;
    };
    expect(load(3)).toBeGreaterThan(load(0) * 2);
  });

  it('refuses a cycle rather than simulating nonsense', () => {
    const spec = threeTier();
    spec.edges.push({ from: 'db', to: 'api' });
    expect(software.validate(spec).some((i) => i.severity === 'error' && i.message.includes('cycle'))).toBe(true);
  });

  it('names a single point of failure', () => {
    expect(software.validate(threeTier()).some((i) => i.message.includes('db is a single point of failure'))).toBe(true);
  });
});

const shop = (): DatabaseSpec => ({
  tables: [
    { name: 'users', rows: 100000, columns: [{ name: 'id', type: 'bigint', primary: true }, { name: 'email', type: 'text' }], indexes: [] },
    {
      name: 'orders',
      rows: 5000000,
      columns: [
        { name: 'id', type: 'bigint', primary: true },
        { name: 'user_id', type: 'bigint', references: { table: 'users', column: 'id' } },
        { name: 'status', type: 'text' },
      ],
      indexes: [['user_id']],
    },
  ],
  workload: [
    { name: 'history', kind: 'read', table: 'orders', where: ['user_id'], joins: [], perSecond: 200 },
    { name: 'place order', kind: 'write', table: 'orders', where: [], joins: [], perSecond: 20 },
  ],
});

describe('database', () => {
  const ticks = 120;

  it('makes an index the difference between a seek and a full scan', () => {
    const indexed = new SchemaRun(shop(), 1);
    const bare = new SchemaRun(shop(), 1);
    bare.inject({ type: 'drop_index', target: 'orders.user_id' });
    const cost = (run: SchemaRun) => run.queries.get('history')!.cost;
    expect(cost(bare)).toBeGreaterThan(cost(indexed) * 1000);
    expect(bare.queries.get('history')!.scanned).toBe(true);
  });

  it('hurts the score when an index goes, and recovers when it is rebuilt', () => {
    const events = [{ at: 20, incident: { type: 'drop_index', target: 'orders.user_id' } }];
    const healthy = evaluate(database, shop(), { seed: 1, ticks, events: [] });
    const dropped = evaluate(database, shop(), { seed: 1, ticks, events });
    const rebuilt = evaluate(database, shop(), { seed: 1, ticks, events: [...events, { at: 40, patches: [{ op: 'add_index', table: 'orders', columns: ['user_id'] }] }] });
    expect(dropped.score).toBeLessThan(healthy.score - 20);
    expect(rebuilt.score).toBeGreaterThan(dropped.score + 20);
  });

  it('breaks every query that depends on a dropped column or locked table', () => {
    const run = new SchemaRun(shop(), 1);
    run.inject({ type: 'drop_column', target: 'orders.user_id' });
    expect(run.queries.get('history')!.broken).toContain('dropped');
    const locked = new SchemaRun(shop(), 1);
    locked.inject({ type: 'lock_table', target: 'orders' });
    expect(locked.withinBudget).toBe(0);
  });

  it('grows tables from the write workload', () => {
    const run = new SchemaRun(shop(), 1);
    for (let i = 0; i < 10; i++) run.step();
    expect(run.table('orders')!.rows).toBeGreaterThan(5000000);
  });

  it('rejects a foreign key to nothing, and a type mismatch', () => {
    const missing = shop();
    missing.tables[1].columns[1].references = { table: 'ghosts', column: 'id' };
    expect(database.validate(missing).some((i) => i.severity === 'error' && i.message.includes("doesn't exist"))).toBe(true);
    const mismatch = shop();
    mismatch.tables[1].columns[1].type = 'text';
    expect(database.validate(mismatch).some((i) => i.severity === 'error' && i.message.includes('references text') || i.message.includes('is text'))).toBe(true);
  });

  it('points out a table with no primary key and an unindexed foreign key', () => {
    const spec = shop();
    spec.tables[0].columns[0].primary = false;
    spec.tables[1].indexes = [];
    const messages = database.validate(spec).map((i) => i.message);
    expect(messages.some((m) => m.includes('no primary key'))).toBe(true);
    expect(messages.some((m) => m.includes('has no index'))).toBe(true);
  });
});

describe.each(domainList().map((d) => [d.id, d] as [string, Domain]))('%s meets the platform contract', (_, domain) => {
  const spec = domain.rules.spec(domain.examples[0]);
  const model = domain.compile(spec);
  const ticks = Math.min(domain.horizon, 300);

  it('parses, compiles and validates its own fallback spec', () => {
    expect(domain.specSchema.safeParse(spec).success).toBe(true);
    expect(domain.validate(model).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('is deterministic for a seed', () => {
    expect(evaluate(domain, model, { seed: 3, ticks, events: [] })).toEqual(evaluate(domain, model, { seed: 3, ticks, events: [] }));
  });

  it('offers working failures, and replaying its log reproduces a live run', () => {
    const live = domain.createRun(model, 1);
    const options = live.breakables();
    expect(options.length).toBeGreaterThan(1);
    for (let i = 0; i < 20; i++) live.step();
    live.inject(options[0].incident);
    for (let i = 0; i < 40; i++) live.step();
    const replay = evaluate(domain, model, { seed: 1, ticks: live.tick, events: live.log });
    expect(replay).toEqual(live.evaluation());
  });

  it('proposes hypotheses and recoveries the schemas accept', () => {
    const claims = domain.rules.hypotheses(model);
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(domain.incidentTypes).toContain(claim.incident.type);
      for (const option of domain.rules.recoveries(model, claim.incident)) {
        for (const patch of option.patches) expect(domain.patchSchema.safeParse(patch).success).toBe(true);
      }
    }
  });

  it('explains what it does not model', () => {
    expect(domain.limits.length).toBeGreaterThan(0);
  });
});
