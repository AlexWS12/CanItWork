import { describe, expect, it } from 'vitest';
import { DOMAINS, costOfFix, designCost, money } from '../src';
import type { DatabaseSpec } from '../src/domains/database/schema';
import type { SystemSpec } from '../src/domains/software/schema';
import type { SystemRun } from '../src/domains/software/system';

const software = DOMAINS.software;
const database = DOMAINS.database;

const stack = (edit: (s: SystemSpec) => void = () => {}) => {
  const spec = software.specSchema.parse({
    traffic: 100,
    nodes: [
      { id: 'users', kind: 'client' },
      { id: 'gateway', kind: 'gateway', replicas: 2 },
      { id: 'api', kind: 'service', replicas: 3 },
      { id: 'db', kind: 'database', replicas: 2 },
      { id: 'jobs', kind: 'queue' },
      { id: 'worker', kind: 'service', replicas: 2 },
      { id: 'stripe', kind: 'external' },
    ],
    edges: [
      { from: 'users', to: 'gateway' },
      { from: 'gateway', to: 'api' },
      { from: 'api', to: 'db' },
      { from: 'api', to: 'jobs', mode: 'async' },
      { from: 'jobs', to: 'worker', mode: 'async' },
      { from: 'api', to: 'stripe' },
    ],
  }) as SystemSpec;
  edit(spec);
  return spec;
};

const schema = (edit: (s: DatabaseSpec) => void = () => {}) => {
  const spec = database.specSchema.parse({
    tables: [
      { name: 'users', rows: 1_000_000, columns: [{ name: 'id', type: 'bigint', primary: true }] },
      {
        name: 'orders',
        rows: 50_000_000,
        columns: [
          { name: 'id', type: 'bigint', primary: true },
          { name: 'user_id', type: 'bigint' },
        ],
        indexes: [['user_id']],
      },
    ],
    workload: [{ name: 'history', kind: 'read', table: 'orders', where: ['user_id'], perSecond: 100 }],
  }) as DatabaseSpec;
  edit(spec);
  return spec;
};

describe('monthly cost', () => {
  it('prices a software stack replica by replica, with queue messages and API calls by volume', () => {
    const cost = designCost(software, stack())!;
    const line = (label: string) => cost.lines.find((l) => l.label === label)!.usd;
    expect(line('gateway')).toBe(50);
    expect(line('api')).toBe(90);
    expect(line('db')).toBe(280);
    expect(line('worker')).toBe(60);
    // 100 requests a second for a month is about 263 million queue messages and API calls.
    expect(line('jobs')).toBeCloseTo(5 + 0.4 * 263, -1);
    expect(line('stripe')).toBeCloseTo(263, -1);
    expect(cost.usd).toBeCloseTo(
      cost.lines.reduce((s, l) => s + l.usd, 0),
      1,
    );
    expect(cost.ceiling).toBeUndefined();
  });

  it('charges more for a replica sized for more traffic, within reason', () => {
    const big = designCost(
      software,
      stack((s) => (s.nodes.find((n) => n.id === 'api')!.capacity = 800)),
    )!;
    expect(big.lines.find((l) => l.label === 'api')!.usd).toBe(360);
  });

  it('gives a ceiling when something autoscales, and the live cost rises as replicas boot', () => {
    const spec = stack((s) => {
      s.retries = 0;
      s.nodes.find((n) => n.id === 'api')!.autoscale = { max: 12 };
    });
    expect(designCost(software, spec)!.ceiling).toBe(designCost(software, spec)!.usd + 9 * 30);
    const run = software.createRun(spec, 1) as SystemRun;
    for (let i = 0; i < 10; i++) run.step();
    const before = run.cost().usd;
    run.inject({ type: 'traffic_spike', value: 8 });
    for (let i = 0; i < 60; i++) run.step();
    expect(run.cost().usd).toBeGreaterThan(before);
    expect(
      run
        .telemetry()
        .find((m) => m.label === 'monthly cost')!
        .detail!.some((d) => d.label === 'at full autoscale'),
    ).toBe(true);
  });

  it('prices a schema by its nodes, replicas, partitions and storage', () => {
    const plain = designCost(database, schema())!;
    expect(plain.lines[0]).toEqual({ label: 'Primary database', usd: 140 });
    expect(plain.lines.find((l) => l.label.startsWith('Storage'))!.usd).toBeGreaterThan(0);
    const replicated = designCost(
      database,
      schema((s) => (s.replicas = 2)),
    )!;
    expect(replicated.lines.find((l) => l.label === '2 read replicas')!.usd).toBe(280);
    const sharded = designCost(
      database,
      schema((s) => Object.assign(s.tables[1], { partitions: 4, partitionBy: 'user_id' })),
    )!;
    expect(sharded.lines[0]).toEqual({ label: '5 database nodes', usd: 700 });
  });

  it('says what a fix adds: replicas cost money, a pooler a little, batching an N+1 loop nothing', () => {
    expect(costOfFix(software, stack(), [{ op: 'scale', node: 'api', replicas: 6 }])).toBe(90);
    expect(costOfFix(software, stack(), [{ op: 'set_retries', retries: 0 }])).toBeLessThanOrEqual(0);
    expect(costOfFix(database, schema(), [{ op: 'add_replica' }])).toBeGreaterThan(140);
    expect(costOfFix(database, schema(), [{ op: 'add_pooler' }])).toBe(15);
    expect(costOfFix(database, schema(), [{ op: 'batch_query', query: 'history' }])).toBe(0);
  });

  it('has no price list for domains that are not software or databases', () => {
    const warehouse = DOMAINS.warehouse;
    expect(designCost(warehouse, warehouse.compile(warehouse.rules.spec('a warehouse')))).toBeNull();
  });

  it('writes money plainly, and a change with its sign', () => {
    expect(money(1234.4)).toBe('$1,234/mo');
    expect(money(90, true)).toBe('+$90/mo');
    expect(money(-30, true)).toBe('−$30/mo');
    expect(money(0.2, true)).toBe('no extra cost');
  });
});
