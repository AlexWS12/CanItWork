import { describe, expect, it } from 'vitest';
import { DOMAINS, SchemaRun, evaluate, type DatabaseSpec } from '../src';

const { database } = DOMAINS;

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
