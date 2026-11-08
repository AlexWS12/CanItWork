import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mountExportCheck } from '../src/exportCheck';
import { isolateEnv } from './helpers';

// The live check against Postgres needs a database, so CI covers what happens before one is reached.
describe('checking an export on Postgres', () => {
  isolateEnv();
  const app = () => {
    const a = new Hono();
    mountExportCheck(a);
    return a;
  };
  const post = (body: unknown) => app().request('/api/export/check', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('says the SQL was not checked when no database is connected', async () => {
    const res = await post({ spec: { tables: [{ name: 't', rows: 1, columns: [{ name: 'id', type: 'int', primary: true }] }] } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('not checked');
  });

  it('refuses anything that is not a database design, before touching the database', async () => {
    process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
    for (const body of [{}, { spec: 'DROP TABLE runs' }, { spec: { tables: [] } }, { sql: 'DROP TABLE runs;' }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});
