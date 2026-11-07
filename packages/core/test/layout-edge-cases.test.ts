import { describe, expect, it } from 'vitest';
import { evaluate, type Domain, type Evaluation } from '../src';
import { database } from '../src/domains/database';
import { SchemaRun } from '../src/domains/database/engine';
import type { DatabaseSpec } from '../src/domains/database/schema';
import { software } from '../src/domains/software';
import type { SystemSpec } from '../src/domains/software/schema';
import { SystemRun } from '../src/domains/software/system';
import { warehouse } from '../src/domains/warehouse';
import { DEFAULT_SPEC, compileWorld } from '../src/domains/warehouse/compile';
import type { WorldSpec } from '../src/domains/warehouse/schema';
import { Sim, orderWeights } from '../src/domains/warehouse/sim';

function expectSane(result: Evaluation) {
  expect(Number.isFinite(result.score)).toBe(true);
  expect(result.score).toBeGreaterThanOrEqual(0);
  expect(result.score).toBeLessThanOrEqual(100);
  for (const m of result.metrics) expect(String(m.value)).not.toMatch(/NaN|Infinity/);
}

/** Breaks a design every way it offers, applies every recovery, and checks the replay matches. */
function exercise(domain: Domain, spec: unknown) {
  expect(domain.specSchema.safeParse(spec).success).toBe(true);
  const model = domain.compile(spec);
  expect(domain.validate(model).filter((i) => i.severity === 'error')).toEqual([]);
  const live = domain.createRun(model, 3);
  const incidents = [...live.breakables().map((b) => b.incident), ...domain.rules.hypotheses(model).map((h) => h.incident)];
  for (const incident of incidents) {
    for (let t = 0; t < 6; t++) live.step();
    live.inject(incident);
    for (const option of domain.rules.recoveries(model, incident)) live.apply(option.patches);
  }
  for (let t = 0; t < 20; t++) live.step();
  expectSane(live.evaluation());
  expect(evaluate(domain, model, { seed: 3, ticks: live.tick, events: live.log })).toEqual(live.evaluation());
  for (const variant of domain.variants(model, spec)) {
    const variantModel = variant.spec ? domain.compile(variant.spec) : model;
    expectSane(evaluate(domain, variantModel, { seed: 1, ticks: 40, events: variant.patches ? [{ at: 0, patches: variant.patches }] : [] }));
  }
}

describe('warehouse layout edge cases', () => {
  const shapes = ['rect', 'L', 'U', 'T'] as const;

  it.each(shapes)('survives every failure and fix on a %s floor with zones', (shape) => {
    exercise(warehouse, {
      ...DEFAULT_SPEC,
      shape,
      aisles: 4,
      robots: 5,
      zones: [
        { name: 'Cold', aisles: 1, share: 0.5 },
        { name: 'Dry', aisles: 2 },
      ],
    });
  });

  it('falls back to a uniform draw when every zone share is zero', () => {
    const world = compileWorld({
      ...DEFAULT_SPEC,
      zones: [
        { name: 'A', aisles: 1, share: 0 },
        { name: 'B', aisles: 2, share: 0 },
      ],
    });
    expect(orderWeights(world)).toBeNull();
    const sim = new Sim(world, 1);
    for (let t = 0; t < 300; t++) sim.step();
    expect(sim.orders.length).toBeGreaterThan(0);
  });

  it('sends every order to a zone with a full share', () => {
    const world = compileWorld({ ...DEFAULT_SPEC, zones: [{ name: 'Only', aisles: 1, share: 1 }] });
    const sim = new Sim(world, 2);
    for (let t = 0; t < 400; t++) sim.step();
    expect(sim.orders.every((o) => o.shelf.zone === 'Only')).toBe(true);
  });

  it('skips zones past the last aisle instead of crashing', () => {
    const spec: WorldSpec = {
      ...DEFAULT_SPEC,
      aisles: 2,
      zones: [
        { name: 'A', aisles: 2 },
        { name: 'Ghost', aisles: 1, share: 0.9 },
      ],
    };
    const world = compileWorld(spec);
    expect(world.zones.map((z) => z.name)).toEqual(['A']);
    expect(orderWeights(world)).toBeNull();
    expect(warehouse.validate(world).some((i) => i.severity === 'error')).toBe(true);
    const sim = new Sim(world, 1);
    for (let t = 0; t < 200; t++) sim.step();
    expect(Number.isFinite(sim.metrics().delivered)).toBe(true);
  });

  it('keeps the smallest and largest floors of every shape reachable', () => {
    for (const shape of shapes) {
      for (const spec of [
        { ...DEFAULT_SPEC, shape, robots: 1, aisles: 1, shelvesPerAisle: 3, conveyors: 1, chargers: 1, docks: 1 },
        { ...DEFAULT_SPEC, shape, robots: 12, aisles: 6, shelvesPerAisle: 12, conveyors: 2, chargers: 4, docks: 4 },
      ] as WorldSpec[]) {
        expect(warehouse.validate(compileWorld(spec)).filter((i) => i.severity === 'error')).toEqual([]);
        expectSane(evaluate(warehouse, compileWorld(spec), { seed: 1, ticks: 200, events: [] }));
      }
    }
  });
});

const zoned = (): SystemSpec => software.rules.spec('A payment system running in two availability zones');

describe('software zone edge cases', () => {
  it('survives every failure and fix on a zoned design', () => {
    exercise(software, zoned());
  });

  it('ignores a zone nobody runs in, and recovering a zone that was never down', () => {
    const run = new SystemRun(zoned(), 1);
    run.inject({ type: 'zone_down', target: 'mars-1' });
    run.inject({ type: 'recover', target: 'zone-b' });
    for (let i = 0; i < 30; i++) run.step();
    expect(run.success).toBeGreaterThan(0.99);
  });

  it('takes everything zoned down when every zone fails, then stays in a retry storm until retries stop', () => {
    const run = new SystemRun(zoned(), 1);
    run.inject({ type: 'zone_down', target: 'zone-a' });
    run.inject({ type: 'zone_down', target: 'zone-b' });
    for (let i = 0; i < 20; i++) run.step();
    expect(run.success).toBeLessThan(0.05);
    expectSane(run.evaluation());
    run.inject({ type: 'recover', target: 'zone-a' });
    run.inject({ type: 'recover', target: 'zone-b' });
    for (let i = 0; i < 60; i++) run.step();
    // Every replica is back, but retries from the outage keep the database overloaded: a metastable failure.
    expect([...run.states.values()].every((s) => s.alive === 1)).toBe(true);
    expect(run.success).toBeLessThan(0.95);
    run.apply([{ op: 'set_retries', retries: 0 }]);
    for (let i = 0; i < 30; i++) run.step();
    expect(run.success).toBeGreaterThan(0.99);
    run.apply([{ op: 'set_retries', retries: 2 }]);
    for (let i = 0; i < 30; i++) run.step();
    expect(run.success).toBeGreaterThan(0.99);
  });

  it('adds a zone once, even when asked twice, and never lowers replicas', () => {
    const run = new SystemRun(zoned(), 1);
    const db = run.spec.nodes.find((n) => n.kind === 'database')!;
    run.apply([
      { op: 'add_zone', node: db.id, zone: 'zone-b' },
      { op: 'add_zone', node: db.id, zone: 'zone-b' },
      { op: 'add_zone', node: 'ghost', zone: 'zone-b' },
    ]);
    expect(db.zones).toEqual(['zone-a', 'zone-b']);
    expect(db.replicas).toBe(2);
    const api = run.spec.nodes.find((n) => n.replicas === 3)!;
    run.apply([{ op: 'add_zone', node: api.id, zone: 'zone-c' }]);
    expect(api.replicas).toBe(3);
  });

  it('keeps nodes without zones running through any zone outage', () => {
    const spec = zoned();
    for (const node of spec.nodes) delete node.zones;
    const run = new SystemRun(spec, 1);
    run.inject({ type: 'zone_down', target: 'zone-a' });
    for (let i = 0; i < 20; i++) run.step();
    expect(run.success).toBeGreaterThan(0.99);
    expect(run.breakables().some((b) => b.incident.type === 'zone_down')).toBe(false);
  });
});

const sharded = (): DatabaseSpec => database.rules.spec('A sharded e-commerce database with customers and orders');

describe('database partition edge cases', () => {
  it('survives every failure and fix on a partitioned schema', () => {
    exercise(database, sharded());
  });

  it('clamps a hot key to a valid share, whatever value it is given', () => {
    for (const value of [-1, 0, 0.01, 1, 5, Number.MAX_VALUE]) {
      const run = new SchemaRun(sharded(), 1);
      run.inject({ type: 'hot_partition', target: 'orders', value });
      const share = run.hot.get('orders')!;
      expect(share).toBeGreaterThanOrEqual(1 / 8);
      expect(share).toBeLessThanOrEqual(0.95);
      run.step();
      expect(Number.isFinite(run.withinBudget)).toBe(true);
    }
  });

  it('drops back to one node when repartitioned to a single partition, even with a hot key', () => {
    const run = new SchemaRun(sharded(), 1);
    run.inject({ type: 'hot_partition', target: 'orders', value: 0.9 });
    run.apply([{ op: 'repartition', table: 'orders', partitions: 1 }]);
    expect(run.partitionLoad.has('orders')).toBe(false);
    for (let i = 0; i < 10; i++) run.step();
    expectSane(run.evaluation());
  });

  it('ignores a repartition by a column that does not exist, or on a table that does not exist', () => {
    const run = new SchemaRun(sharded(), 1);
    run.apply([
      { op: 'repartition', table: 'orders', partitions: 4, by: 'ghost' },
      { op: 'repartition', table: 'ghosts', partitions: 4 },
    ]);
    expect(run.table('orders')).toMatchObject({ partitions: 8, partitionBy: 'customer_id' });
  });

  it('runs a partitioned table with no workload, or with writes only', () => {
    const idle = sharded();
    idle.workload = [];
    expectSane(evaluate(database, idle, { seed: 1, ticks: 20, events: [] }));
    const writes = sharded();
    writes.workload = writes.workload.filter((q) => q.kind === 'write');
    const run = new SchemaRun(writes, 1);
    expect([...run.queries.values()].every((q) => q.partitions === 1)).toBe(true);
    expectSane(evaluate(database, writes, { seed: 1, ticks: 20, events: [] }));
  });

  it('survives a partition key that is not a column, which the validator rejects', () => {
    const spec = sharded();
    spec.tables.find((t) => t.name === 'orders')!.partitionBy = 'ghost';
    expect(database.validate(spec).some((i) => i.severity === 'error')).toBe(true);
    expectSane(evaluate(database, spec, { seed: 1, ticks: 20, events: [{ at: 5, incident: { type: 'hot_partition', target: 'orders' } }] }));
  });
});
