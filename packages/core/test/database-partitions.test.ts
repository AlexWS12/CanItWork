import { describe, expect, it } from 'vitest';
import { evaluate } from '../src';
import { database } from '../src/domains/database';
import { SchemaRun } from '../src/domains/database/engine';
import { DatabasePatchSchema, type DatabaseSpec } from '../src/domains/database/schema';

const social = (partitions?: number): DatabaseSpec => ({
  tables: [
    {
      name: 'users',
      rows: 10_000_000,
      columns: [
        { name: 'id', type: 'bigint', primary: true },
        { name: 'name', type: 'text' },
      ],
      indexes: [],
    },
    {
      name: 'posts',
      rows: 200_000_000,
      columns: [
        { name: 'id', type: 'bigint', primary: true },
        { name: 'user_id', type: 'bigint', references: { table: 'users', column: 'id' } },
        { name: 'body', type: 'text' },
      ],
      indexes: [['user_id']],
      ...(partitions ? { partitions, partitionBy: 'user_id' } : {}),
    },
    {
      name: 'likes',
      rows: 2_000_000_000,
      columns: [
        { name: 'id', type: 'bigint', primary: true },
        { name: 'post_id', type: 'bigint', references: { table: 'posts', column: 'id' } },
      ],
      indexes: [['post_id']],
    },
  ],
  workload: [
    {
      name: 'user posts',
      kind: 'read',
      table: 'posts',
      where: ['user_id'],
      joins: [
        { table: 'likes', local: 'id', foreign: 'post_id' },
        { table: 'users', local: 'user_id', foreign: 'id' },
      ],
      perSecond: 1000,
    },
    { name: 'new post', kind: 'write', table: 'posts', where: [], joins: [], perSecond: 2000 },
  ],
});

const ticks = 120;
const hot = [{ at: 20, incident: { type: 'hot_partition', target: 'posts', value: 0.8 } }];

describe('database partitions', () => {
  it('changes nothing for a schema without partitions or replicas', () => {
    const plain = evaluate(database, social(), { seed: 1, ticks, events: [] });
    const explicit = social();
    explicit.tables[1].partitions = 1;
    explicit.replicas = 0;
    expect(evaluate(database, explicit, { seed: 1, ticks, events: [] })).toEqual(plain);
  });

  it('spreads keyed load over the partitions', () => {
    const one = new SchemaRun(social(), 1);
    const eight = new SchemaRun(social(8), 1);
    expect(eight.partitionLoad.get('posts')).toHaveLength(8);
    expect(eight.utilization).toBeLessThan(one.utilization / 4);
    expect(eight.queries.get('user posts')!.partitions).toBe(1);
    expect(eight.withinBudget).toBe(1);
  });

  it('reads every partition when a query does not filter on the key', () => {
    const spec = social(8);
    spec.workload.push({ name: 'by body', kind: 'read', table: 'posts', where: ['body'], joins: [], perSecond: 1 });
    const run = new SchemaRun(spec, 1);
    const query = run.queries.get('by body')!;
    expect(query.partitions).toBe(8);
    expect(query.scanned).toBe(true);
    expect(database.validate(spec).map((i) => i.message)).toContain("by body doesn't filter on posts.user_id, so it reads all 8 partitions");
  });

  it('overloads one partition when a hot key lands on it, and recovers when it cools', () => {
    const healthy = evaluate(database, social(8), { seed: 1, ticks, events: [] });
    const skewed = evaluate(database, social(8), { seed: 1, ticks, events: hot });
    expect(healthy.score).toBeGreaterThan(99);
    expect(skewed.score).toBeLessThan(healthy.score - 15);
    const cooled = evaluate(database, social(8), { seed: 1, ticks, events: [...hot, { at: 40, incident: { type: 'cool_partition', target: 'posts' } }] });
    expect(cooled.score).toBeGreaterThan(skewed.score + 10);
    const run = new SchemaRun(social(8), 1);
    run.inject(hot[0].incident);
    const loads = run.partitionLoad.get('posts')!;
    expect(loads[0]).toBeGreaterThan(1);
    expect(Math.max(...loads.slice(1))).toBeLessThan(0.5);
  });

  it('ignores a hot key on a table that is not partitioned', () => {
    const plain = evaluate(database, social(), { seed: 1, ticks, events: [] });
    expect(evaluate(database, social(), { seed: 1, ticks, events: hot })).toEqual(plain);
  });

  it('clears the hot key only when repartitioning changes the key', () => {
    const same = new SchemaRun(social(8), 1);
    same.inject(hot[0].incident);
    same.apply([{ op: 'repartition', table: 'posts', partitions: 16 }]);
    expect(same.hot.has('posts')).toBe(true);
    const rekeyed = new SchemaRun(social(8), 1);
    rekeyed.inject(hot[0].incident);
    rekeyed.apply([{ op: 'repartition', table: 'posts', partitions: 8, by: 'id' }]);
    expect(rekeyed.hot.has('posts')).toBe(false);
    expect(rekeyed.queries.get('user posts')!.partitions).toBe(8);
  });

  it('starts with the read replicas the spec asks for', () => {
    const spec = social();
    const base = new SchemaRun(spec, 1).utilization;
    expect(new SchemaRun({ ...spec, replicas: 1 }, 1).utilization).toBeCloseTo(base / 2);
  });

  it('rejects a partition key that is not a column, or partitions with no key', () => {
    const badKey = social(8);
    badKey.tables[1].partitionBy = 'ghost';
    expect(database.validate(badKey).some((i) => i.severity === 'error' && i.repair && i.message.includes("partitioned by ghost, which isn't one of its columns"))).toBe(true);
    const noKey = social();
    noKey.tables[1].partitions = 4;
    expect(database.validate(noKey).some((i) => i.severity === 'error' && i.message.includes('4 partitions but no partitionBy'))).toBe(true);
  });

  it('claims a hot partition and offers recoveries the schema accepts', () => {
    const claims = database.rules.hypotheses(social(8));
    const claim = claims.find((c) => c.incident.type === 'hot_partition');
    expect(claim).toBeDefined();
    const options = database.rules.recoveries(social(8), claim!.incident);
    expect(options.map((o) => o.title)).toContain('Repartition posts by id');
    for (const option of options) for (const patch of option.patches) expect(DatabasePatchSchema.safeParse(patch).success).toBe(true);
  });

  it('offers a hot key to break and replays it exactly', () => {
    const live = database.createRun(social(8), 1);
    const option = live.breakables().find((b) => b.incident.type === 'hot_partition');
    expect(option).toBeDefined();
    for (let i = 0; i < 20; i++) live.step();
    live.inject(option!.incident);
    for (let i = 0; i < 40; i++) live.step();
    expect(evaluate(database, social(8), { seed: 1, ticks: live.tick, events: live.log })).toEqual(live.evaluation());
  });

  it('partitions the fallback schema when the prompt asks for sharding', () => {
    const spec = database.rules.spec('A sharded e-commerce database with customers and orders');
    const orders = spec.tables.find((t) => t.name === 'orders')!;
    expect(orders).toMatchObject({ partitions: 8, partitionBy: 'customer_id' });
    expect(database.validate(spec).filter((i) => i.severity === 'error')).toEqual([]);
    expect(database.rules.spec('An e-commerce database').tables.every((t) => !t.partitions)).toBe(true);
  });
});
