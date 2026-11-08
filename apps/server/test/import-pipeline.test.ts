import type { DatabaseSpec, StreamEvent, SystemSpec } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { build } from '../src/agents';
import { isolateEnv, json, mockFetch, openAiReply } from './helpers';

isolateEnv();

const SCHEMA = `Our shop has 80 million orders.
\`\`\`sql
CREATE TABLE users (id bigint primary key, email text unique);
CREATE TABLE orders (id bigint primary key, user_id bigint references users(id), placed_at timestamp);
\`\`\``;

const COMPOSE = `services:
  web:
    image: nginx
    depends_on: [api]
  api:
    build: .
    depends_on: [db]
  db:
    image: postgres:16
`;

const collect = () => {
  const events: StreamEvent[] = [];
  return { events, emit: (e: StreamEvent) => void events.push(e) };
};
const environmentOf = (events: StreamEvent[]) => {
  const event = events.find((e) => e.type === 'environment');
  return event?.type === 'environment' ? event.environment : null;
};
const titles = (events: StreamEvent[]) => events.flatMap((e) => (e.type === 'step' && e.status !== 'running' ? [`${e.agent}:${e.title}`] : []));

describe('building from a pasted file', () => {
  it('builds a pasted schema without any AI, keeping every table and key, and still runs the Red Team and claims', async () => {
    const { events, emit } = collect();
    await build(SCHEMA, emit);
    const env = environmentOf(events)!;
    expect(env.domain).toBe('database');
    const spec = env.spec as DatabaseSpec;
    expect(spec.tables.map((t) => t.name)).toEqual(['users', 'orders']);
    expect(spec.tables[1].columns[1].references).toEqual({ table: 'users', column: 'id' });
    expect(titles(events)[0]).toBe('interpreter:Reading your SQL schema');
    expect(titles(events).some((t) => t.startsWith('architect'))).toBe(false);
    expect(env.unmodelled[0]).toMatch(/Row counts and the query workload are estimates/);
    expect(events.some((e) => e.type === 'findings')).toBe(true);
  });

  it('asks Gemini only for rows and queries, keeps the structure, and drops a query on a column that is not there', async () => {
    process.env.GEMINI_API_KEY = 'g';
    const bodies: string[] = [];
    mockFetch((_, init) => {
      bodies.push(String(init.body));
      return json(
        openAiReply(
          JSON.stringify({
            name: 'Shop orders',
            summary: 'Users and their orders.',
            rows: { users: 2000000, orders: 80000000, ghost: 5 },
            workload: [
              { name: 'order history', kind: 'read', table: 'orders', where: ['user_id'], perSecond: 300 },
              { name: 'by coupon', kind: 'read', table: 'orders', where: ['coupon'], perSecond: 10 },
            ],
          }),
        ),
      );
    });
    const { events, emit } = collect();
    await build(SCHEMA, emit);
    const env = environmentOf(events)!;
    const spec = env.spec as DatabaseSpec;
    expect(env.name).toBe('Shop orders');
    expect(spec.tables.map((t) => [t.name, t.rows])).toEqual([
      ['users', 2000000],
      ['orders', 80000000],
    ]);
    expect(spec.workload.map((q) => q.name)).toEqual(['order history']);
    // The routing, the Reviewer and the repairs never run on an import: the only call is the estimate.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Our shop has 80 million orders.');
    expect(titles(events)).toContain('architect:Estimating rows and queries');
  });

  it('keeps the file as read when the estimate fails', async () => {
    process.env.GEMINI_API_KEY = 'g';
    mockFetch(() => json(openAiReply('not json at all')));
    const { events, emit } = collect();
    await build(COMPOSE, emit);
    const env = environmentOf(events)!;
    expect(env.domain).toBe('software');
    const spec = env.spec as SystemSpec;
    expect(spec.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['users>web', 'web>api', 'api>db']);
    expect(env.name).toBe('Imported stack (3 services)');
  });
});
