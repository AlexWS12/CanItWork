import { describe, expect, it } from 'vitest';
import { DOMAINS, asDatabaseNode, sizeWorkload } from '../src';
import type { DatabaseSpec } from '../src/domains/database/schema';
import type { SystemSpec } from '../src/domains/software/schema';

const software = DOMAINS.software;
const database = DOMAINS.database;

const app = software.specSchema.parse({
  traffic: 300,
  nodes: [
    { id: 'users', kind: 'client' },
    { id: 'chat', label: 'Chat Service', kind: 'service', replicas: 3 },
    { id: 'search', label: 'Search', kind: 'service', replicas: 2 },
    { id: 'db', label: 'Messages DB', kind: 'database', replicas: 2 },
  ],
  edges: [
    { from: 'users', to: 'chat' },
    { from: 'chat', to: 'db' },
    { from: 'users', to: 'search' },
    { from: 'search', to: 'db' },
  ],
}) as SystemSpec;

const schema = (indexed = true) =>
  database.specSchema.parse({
    tables: [
      { name: 'users', rows: 200000, columns: [{ name: 'id', type: 'bigint', primary: true }] },
      {
        name: 'messages',
        rows: 20000000,
        columns: [
          { name: 'id', type: 'bigint', primary: true },
          { name: 'user_id', type: 'bigint', references: { table: 'users', column: 'id' } },
        ],
        indexes: indexed ? [['user_id']] : [],
      },
    ],
    workload: [
      { name: 'history', kind: 'read', table: 'messages', where: ['user_id'], perSecond: 30 },
      { name: 'send', kind: 'write', table: 'messages', perSecond: 10 },
    ],
  }) as DatabaseSpec;

describe('opening a database as its schema', () => {
  it('offers its database as a schema, naming the services that call it and the load it carries', () => {
    const run = software.createRun(app, 1);
    for (let i = 0; i < 10; i++) run.step();
    const drill = run.inspect('db')!.drill!;
    expect(drill.label).toBe('Open its schema');
    expect(drill.node).toBe('db');
    expect(drill.rps).toBeGreaterThan(400);
    expect(drill.prompt).toMatch(/schema behind Messages DB, used by Chat Service, Search,/);
    expect(drill.prompt).toContain(`about ${drill.rps} queries per second`);
    // Only databases open this way.
    expect(run.inspect('chat')!.drill).toBeUndefined();
  });

  it('sizes the schema to carry exactly that load, keeping the mix of queries', () => {
    const sized = sizeWorkload(schema(), 600);
    expect(sized.workload.reduce((s, q) => s + q.perSecond, 0)).toBeCloseTo(600, 0);
    expect(sized.workload[0].perSecond / sized.workload[1].perSecond).toBeCloseTo(3, 1);
  });

  it('comes back as the database node: a missing index inside the schema means less capacity and slower queries', () => {
    const good = asDatabaseNode(sizeWorkload(schema(true), 600), 2);
    const bad = asDatabaseNode(sizeWorkload(schema(false), 600), 2);
    expect(good.capacity).toBeGreaterThan(bad.capacity * 10);
    expect(bad.latency).toBeGreaterThan(good.latency * 10);
    // And the services feel it: the same design with the slow schema behind its database does worse.
    const withSchema = (link: { capacity: number; latency: number }) => {
      const spec = structuredClone(app);
      Object.assign(
        spec.nodes.find((n) => n.id === 'db')!,
        link,
      );
      const run = software.createRun(spec, 1);
      for (let i = 0; i < 40; i++) run.step();
      return run.evaluation().score;
    };
    expect(withSchema(good)).toBeGreaterThan(withSchema(bad));
  });
});
