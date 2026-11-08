import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, toSql, type DatabaseSpec } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { importFile } from '../src/importers';

// An exported file read back by our own importer must give the same design: same tables, columns, types, keys,
// cascades and indexes. Names come back lowercase, since the importer folds them as Postgres does.

const here = path.dirname(fileURLToPath(import.meta.url));
const verified = JSON.parse(readFileSync(path.resolve(here, '../data/verified-designs.json'), 'utf8')) as Record<string, { domain: string; draft: { spec: unknown } }>;

const NAMES = ['users', 'order', 'orders', 'user', 'group', 'items', 'accounts', 'select', 'events', 'table', 'payments', 'products', 'MixedCase', 'line_items', 'check'];
const COLUMNS = ['id', 'name', 'email', 'created_at', 'amount', 'status', 'from', 'to', 'limit', 'title', 'body', 'price', 'qty', 'kind', 'ref'];
const TYPES = ['int', 'bigint', 'uuid', 'text', 'decimal', 'bool', 'timestamp'] as const;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function randomSpec(seed: number): DatabaseSpec {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const names = [...NAMES].sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 6));
  const tables = names.map((name) => {
    const key = pick(['int', 'bigint', 'uuid'] as const);
    const composite = r() < 0.15;
    const columns: Array<Record<string, unknown>> = [{ name: 'id', type: key, primary: true }];
    if (composite) columns.push({ name: 'part', type: 'int', primary: true });
    for (const c of [...COLUMNS.slice(1)].sort(() => r() - 0.5).slice(0, Math.floor(r() * 5)))
      columns.push({ name: c, type: pick(TYPES), ...(r() < 0.2 ? { unique: true } : {}), ...(r() < 0.2 ? { nullable: true } : {}) });
    return { name, rows: Math.floor(r() * 1e7), columns, indexes: [] as string[][] };
  });
  // Foreign keys between tables, sometimes into a cycle, sometimes onto a column of the wrong type
  for (const t of tables) {
    if (r() < 0.6 && tables.length > 1) {
      const target = pick(tables.filter((o) => o !== t));
      const targetId = target.columns[0] as { type: string };
      const type = r() < 0.85 ? targetId.type : pick(TYPES);
      t.columns.push({
        name: `${target.name.replace(/\W/g, '_').toLowerCase()}_fk`,
        type,
        references: { table: target.name, column: 'id', ...(r() < 0.5 ? { onDelete: pick(['cascade', 'restrict', 'set_null'] as const) } : {}) },
      });
    }
    const plainColumns = t.columns.filter((c) => !c.primary).map((c) => c.name as string);
    if (plainColumns.length && r() < 0.6) t.indexes.push([pick(plainColumns)]);
  }
  return DOMAINS.database.specSchema.parse({ tables, workload: [] }) as DatabaseSpec;
}

/** What a file can carry, in the importer's terms: lowercase names, and only keys Postgres would accept. */
function shape(spec: DatabaseSpec, sql: string) {
  const unquote = (name: string) => name.replace(/^"|"$/g, '').replace(/""/g, '"').toLowerCase();
  // Foreign keys the file declares, as "table.column", read per CREATE TABLE block and from ALTER TABLE lines
  const fks = new Set<string>();
  for (const block of sql.split(/^CREATE TABLE /m).slice(1)) {
    const table = unquote(block.match(/^("(?:[^"]|"")+"|\w+)/)![1]);
    for (const m of block.matchAll(/^\s+("(?:[^"]|"")+"|\w+) \w+\b[^\n]*\bREFERENCES\b/gm)) fks.add(`${table}.${unquote(m[1])}`);
  }
  for (const m of sql.matchAll(/ALTER TABLE ("(?:[^"]|"")+"|\w+) ADD FOREIGN KEY \(("(?:[^"]|"")+"|\w+)\)/g)) fks.add(`${unquote(m[1])}.${unquote(m[2])}`);
  return spec.tables
    .map((t) => ({
      name: t.name.toLowerCase(),
      columns: t.columns
        .map((c) => ({
          name: c.name.toLowerCase(),
          type: c.type,
          primary: Boolean(c.primary),
          nullable: Boolean(c.nullable),
          references:
            c.references && fks.has(`${t.name.toLowerCase()}.${c.name.toLowerCase()}`)
              ? `${c.references.table.toLowerCase()}.${c.references.column.toLowerCase()}:${c.references.onDelete ?? ''}`
              : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function roundTrip(spec: DatabaseSpec, label: string) {
  const sql = toSql(spec, { name: label });
  const back = importFile(sql);
  expect(back?.domain, label).toBe('database');
  const reread = back!.spec as DatabaseSpec;
  const theirs = shape(reread, toSql(reread));
  expect(theirs, label).toEqual(shape(spec, sql));
  // Every index the export wrote comes back
  const written = [...sql.matchAll(/^CREATE INDEX \S+ ON ("?[\w ]+"?) \(([^)]*)\)/gm)].map(
    (m) => `${m[1].replace(/"/g, '').toLowerCase()}:${m[2].replace(/"/g, '').toLowerCase()}`,
  );
  const indexes = new Set(reread.tables.flatMap((t) => t.indexes.map((cols) => `${t.name}:${cols.join(', ')}`)));
  for (const index of written) expect(indexes.has(index), `${label} index ${index}`).toBe(true);
}

describe('an exported SQL file reads back as the same design', () => {
  it('for every verified database design', () => {
    const designs = Object.entries(verified).filter(([, v]) => v.domain === 'database');
    expect(designs.length).toBeGreaterThan(0);
    for (const [prompt, v] of designs) roundTrip(DOMAINS.database.specSchema.parse(v.draft.spec) as DatabaseSpec, prompt);
  });

  it('for 300 random schemas with reserved names, cycles, composite keys and mismatched types', () => {
    for (let seed = 1; seed <= 300; seed++) roundTrip(randomSpec(seed), `seed ${seed}`);
  });
});
