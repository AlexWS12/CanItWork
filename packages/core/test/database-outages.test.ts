import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../src';
import type { SchemaRun } from '../src/domains/database/engine';
import { DatabasePatchSchema, type DatabaseSpec } from '../src/domains/database/schema';

const database = DOMAINS.database;

// A shop: orders looked up by customer, a product catalogue read on its own, and order writes.
const shop = (over: Partial<DatabaseSpec> = {}): DatabaseSpec =>
  database.specSchema.parse({
    tables: [
      { name: 'customers', rows: 100000, columns: [{ name: 'id', type: 'bigint', primary: true }] },
      {
        name: 'orders',
        rows: 2000000,
        columns: [
          { name: 'id', type: 'bigint', primary: true },
          { name: 'customer_id', type: 'bigint', references: { table: 'customers', column: 'id' } },
        ],
        indexes: [['customer_id']],
      },
      { name: 'products', rows: 50000, columns: [{ name: 'id', type: 'bigint', primary: true }] },
    ],
    workload: [
      { name: 'order history', kind: 'read', table: 'orders', where: ['customer_id'], joins: [{ table: 'customers', local: 'customer_id', foreign: 'id' }], perSecond: 200 },
      { name: 'product page', kind: 'read', table: 'products', where: ['id'], perSecond: 300 },
      { name: 'place order', kind: 'write', table: 'orders', perSecond: 20 },
    ],
    ...over,
  }) as DatabaseSpec;

const run = (spec: DatabaseSpec, ticks = 3) => {
  const r = database.createRun(spec, 1) as SchemaRun;
  for (let i = 0; i < ticks; i++) r.step();
  return r;
};
const served = (r: SchemaRun, query: string) => r.queries.get(query)!.served;

describe('connection pool exhaustion', () => {
  it('a lock on orders holds connections until the pool runs out, stalling the product page that never touches orders', () => {
    const r = run(shop());
    expect(r.inUse).toBeLessThan(r.poolSize);
    expect(served(r, 'product page')).toBe(1);
    r.inject({ type: 'lock_table', target: 'orders' });
    expect(r.inUse).toBeGreaterThan(r.poolSize);
    expect(served(r, 'product page')).toBeLessThan(0.2);
    expect(r.telemetry().find((m) => m.label === 'connections')!.tone).toBe('danger');
    // Releasing the lock gives the waiting queries' connections back.
    r.apply([{ op: 'unlock_table', table: 'orders' }]);
    expect(r.inUse).toBeLessThan(r.poolSize);
    expect(served(r, 'product page')).toBe(1);
  });

  it('a leak that takes the whole pool stops everything until the connections are recycled', () => {
    const r = run(shop());
    r.inject({ type: 'connection_leak', value: 1 });
    expect(r.withinBudget).toBe(0);
    r.apply([{ op: 'recycle_connections' }]);
    expect(r.withinBudget).toBe(1);
  });

  it('a partial leak hurts only once what is left is too small for the workload', () => {
    const r = run(shop());
    const active = r.inUse;
    r.inject({ type: 'connection_leak', value: 0.5 });
    expect(r.withinBudget).toBe(1);
    // Leave half of what the working queries need.
    r.inject({ type: 'connection_leak', value: 0.5 - active / 2 / r.poolSize });
    expect(r.withinBudget).toBeLessThan(1);
    r.apply([{ op: 'add_pooler' }]);
    expect(r.withinBudget).toBe(1);
  });

  it('flags a pool too small for the workload, and the mend sizes it unless the user stated the size', () => {
    // A report that scans every order holds each connection for seconds.
    const tight = shop({ pool: 5 });
    tight.workload.push({ name: 'sales report', kind: 'read', table: 'orders', where: [], joins: [], perSecond: 2 });
    const issues = database.validate(tight);
    const issue = issues.find((i) => /connections at once/.test(i.message));
    expect(issue?.repair).toBe(true);
    const mended = database.rules.mend!(tight, issues, [])!;
    expect((mended.spec as DatabaseSpec).pool).toBeGreaterThan(5);
    expect(database.validate(mended.spec).some((i) => /connections at once/.test(i.message))).toBe(false);
    expect(database.rules.mend!(tight, issues, [5])).toBeNull();
  });
});

describe('replication lag', () => {
  it('a stalled replica serves stale reads until reads go to the primary or the replicas are rebuilt', () => {
    const r = run(shop({ replicas: 2 }));
    expect(r.lag).toBe(0);
    r.inject({ type: 'replica_lag', value: 300 });
    r.step();
    expect(r.lag).toBeGreaterThan(300);
    expect(r.queries.get('product page')!.stale).toBe(true);
    // Two of three nodes answer reads, so two thirds of them are old.
    expect(served(r, 'product page')).toBeCloseTo(1 / 3, 2);
    r.apply([{ op: 'reads_to_primary' }]);
    expect(served(r, 'product page')).toBe(1);
    r.apply([{ op: 'resync_replica' }]);
    expect(r.lag).toBe(0);
  });

  it('falls behind on its own when writes outpace replay, and the checks say so', () => {
    const heavy = shop({ replicas: 1 });
    heavy.workload[2].perSecond = 5000;
    const r = run(heavy, 10);
    expect(r.lag).toBeGreaterThan(5);
    expect(database.validate(heavy).some((i) => /outpace what the replicas can replay/.test(i.message))).toBe(true);
  });

  it('has no lag to speak of without replicas', () => {
    const r = run(shop());
    r.inject({ type: 'replica_lag', value: 300 });
    r.step();
    expect(r.lag).toBe(0);
    expect(r.telemetry().some((m) => m.label.startsWith('replica lag'))).toBe(false);
  });
});

describe('N+1 queries', () => {
  it('an N+1 loop multiplies round trips past the budget and load on the database, and batching undoes it', () => {
    const r = run(shop());
    const before = r.utilization;
    r.inject({ type: 'n_plus_one', target: 'order history', value: 50 });
    expect(r.queries.get('order history')!.latency).toBeGreaterThan(100);
    expect(served(r, 'order history')).toBe(0);
    expect(r.utilization).toBeGreaterThan(before * 10);
    expect(r.telemetry().find((m) => m.label === 'N+1 loops')?.value).toBe(1);
    r.apply([{ op: 'batch_query', query: 'order history' }]);
    expect(served(r, 'order history')).toBe(1);
  });

  it('warns about a loop the design already has', () => {
    const looped = shop();
    looped.workload[0].repeats = 20;
    expect(database.validate(looped).some((i) => /runs 20 times per request, an N\+1 loop/.test(i.message))).toBe(true);
  });
});

describe('claims and recoveries', () => {
  it('claims the pool cascade, the N+1 loop and stale replicas, each with recoveries the schema accepts', () => {
    const spec = shop({ replicas: 1 });
    const claims = database.rules.hypotheses(spec);
    expect(claims.map((c) => c.incident.type)).toEqual(expect.arrayContaining(['lock_table', 'n_plus_one']));
    expect(claims.find((c) => c.incident.type === 'lock_table')!.claim).toMatch(/pool runs out, stalling product page too/);
    for (const type of ['connection_leak', 'replica_lag', 'n_plus_one', 'lock_table'] as const) {
      const incident = { type, target: type === 'n_plus_one' ? 'order history' : type === 'lock_table' ? 'orders' : undefined, value: 50 };
      const options = database.rules.recoveries(spec, incident);
      expect(options.length, type).toBeGreaterThan(0);
      for (const o of options) for (const p of o.patches) expect(DatabasePatchSchema.safeParse(p).success, `${type}: ${JSON.stringify(p)}`).toBe(true);
    }
  });

  it('offers each new outage to break from the scene', () => {
    const labels = run(shop({ replicas: 1 }))
      .breakables()
      .map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(['Leak connections', 'Stall the replicas', 'N+1 on order history']));
  });
});
