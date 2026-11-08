import { createHash, randomBytes } from 'node:crypto';
import { DOMAINS, sqlStatements, type DatabaseSpec } from '@tv/core';
import type { Hono } from 'hono';
import postgres from 'postgres';
import { visitorOf } from './integrations/limit';

// Before someone downloads a database design as SQL, Tiger Data's Postgres runs it for real: proof the file is Postgres that
// works, not SQL-shaped text. The server never runs SQL it is sent. It takes the design, checks it against the schema, writes
// the statements itself (every name quoted, every type and action from a fixed list) and runs them one at a time, inside a
// fresh scratch schema, in a transaction that is always rolled back, under a time limit. Nothing is ever kept.

export interface CheckResult {
  ok: boolean;
  /** "16.4": the Postgres that ran it */
  version?: string;
  tables?: number;
  foreignKeys?: number;
  indexes?: number;
  ms?: number;
  /** What Postgres said when it refused a statement */
  error?: string;
}

const ROLLBACK = 'canitwork-export-check-rollback';
const MAX_AT_ONCE = 2;
const PER_HOUR = 60;

let client: postgres.Sql | null = null;
let clientUrl = '';
const sqlFor = (url: string) => {
  if (!client || clientUrl !== url) {
    client = postgres(url, { max: MAX_AT_ONCE, onnotice: () => undefined, idle_timeout: 30, connect_timeout: 10 });
    clientUrl = url;
  }
  return client;
};

let running = 0;
const cache = new Map<string, CheckResult>();
const seen = new Map<string, number[]>();

/** Runs the design's statements on the Postgres at url, in a scratch schema that is rolled back, and says what it built. */
export async function checkOnPostgres(spec: DatabaseSpec, url: string): Promise<CheckResult> {
  const statements = sqlStatements(spec);
  const key = createHash('sha256').update(statements.join('\n')).digest('hex');
  const known = cache.get(key);
  if (known) return known;
  const sql = sqlFor(url);
  const schema = `canitwork_check_${randomBytes(6).toString('hex')}`;
  const started = Date.now();
  let result: CheckResult = { ok: false };
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '5s'`);
      await tx.unsafe(`SET LOCAL lock_timeout = '2s'`);
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
      for (const statement of statements) await tx.unsafe(statement);
      const [{ version }] = await tx.unsafe<Array<{ version: string }>>(`SELECT current_setting('server_version') AS version`);
      const [counts] = await tx.unsafe<Array<{ tables: number; fks: number; indexes: number }>>(
        `SELECT
           (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = '${schema}') AS tables,
           (SELECT count(*)::int FROM information_schema.table_constraints WHERE table_schema = '${schema}' AND constraint_type = 'FOREIGN KEY') AS fks,
           (SELECT count(*)::int FROM pg_indexes i WHERE i.schemaname = '${schema}'
              AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conindid WHERE r.relname = i.indexname AND c.contype IN ('p', 'u'))) AS indexes`,
      );
      result = { ok: true, version: version.split(' ')[0], tables: counts.tables, foreignKeys: counts.fks, indexes: counts.indexes, ms: Date.now() - started };
      // Always undone: nothing the check built survives it
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message !== ROLLBACK) result = { ok: false, error: message.slice(0, 300), ms: Date.now() - started };
  }
  // A refusal from Postgres is about the design and worth remembering; a lost connection is not
  if (result.ok || /syntax|exist|type|constraint|relation|column|duplicate/i.test(result.error ?? '')) {
    cache.set(key, result);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return result;
}

export function mountExportCheck(app: Hono) {
  app.post('/api/export/check', async (c) => {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) return c.json({ ok: false, error: 'No database is connected, so the SQL was not checked' }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = DOMAINS.database.specSchema.safeParse((body as { spec?: unknown } | null)?.spec);
    if (!parsed.success) return c.json({ ok: false, error: 'That is not a database design' }, 400);
    const visitor = visitorOf(c);
    const now = Date.now();
    const recent = (seen.get(visitor) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= PER_HOUR) return c.json({ ok: false, error: 'Too many checks this hour; try again later' }, 429);
    if (running >= MAX_AT_ONCE) return c.json({ ok: false, error: 'The database is busy checking another design; try again in a moment' }, 503);
    recent.push(now);
    seen.set(visitor, recent);
    running++;
    try {
      return c.json(await checkOnPostgres(parsed.data as DatabaseSpec, url));
    } finally {
      running--;
    }
  });
}
