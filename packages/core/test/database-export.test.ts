import { describe, expect, it } from 'vitest';
import { DOMAINS, ident, toSql } from '../src';
import type { SchemaRun } from '../src/domains/database/engine';
import type { DatabaseSpec } from '../src/domains/database/schema';

const database = DOMAINS.database;
const spec = (raw: unknown) => database.specSchema.parse(raw) as DatabaseSpec;

const shop = () =>
  spec({
    tables: [
      {
        name: 'order_items',
        rows: 4_000_000,
        columns: [
          { name: 'order_id', type: 'bigint', primary: true, references: { table: 'order', column: 'id', onDelete: 'cascade' } },
          { name: 'sku', type: 'text', primary: true },
          { name: 'qty', type: 'int' },
        ],
      },
      {
        name: 'order',
        rows: 500_000,
        columns: [
          { name: 'id', type: 'bigint', primary: true },
          { name: 'user', type: 'bigint', references: { table: 'users', column: 'id' } },
          { name: 'created_at', type: 'timestamp' },
        ],
        indexes: [['user'], ['id']],
        partitions: 4,
        partitionBy: 'user',
      },
      {
        name: 'users',
        rows: 90_000,
        columns: [
          { name: 'id', type: 'bigint', primary: true },
          { name: 'email', type: 'text', unique: true },
          { name: 'note', type: 'text', nullable: true },
        ],
      },
    ],
    workload: [{ name: 'history', kind: 'read', table: 'order', where: ['user'], perSecond: 120 }],
    replicas: 1,
  });

describe('exporting a database design as SQL', () => {
  it('creates every table after the tables it points at', () => {
    const sql = toSql(shop(), { name: 'Shop' });
    const at = (name: string) => sql.indexOf(`CREATE TABLE ${name} `);
    expect(at('users')).toBeGreaterThan(-1);
    expect(at('users')).toBeLessThan(at('"order"'));
    expect(at('"order"')).toBeLessThan(at('order_items'));
  });

  it('quotes reserved words and keeps plain names bare', () => {
    expect(ident('users')).toBe('users');
    expect(ident('order')).toBe('"order"');
    expect(ident('user')).toBe('"user"');
    expect(ident('Weird Name')).toBe('"Weird Name"');
    expect(ident('a"b')).toBe('"a""b"');
    const sql = toSql(shop());
    expect(sql).toContain('"user" bigint REFERENCES users (id)');
  });

  it('writes keys, uniques, nullables, cascades and composite primary keys', () => {
    const sql = toSql(shop());
    expect(sql).toContain('id bigint PRIMARY KEY');
    expect(sql).toContain('email text UNIQUE');
    expect(sql).toContain('note text NULL');
    expect(sql).toContain('order_id bigint NOT NULL REFERENCES "order" (id) ON DELETE CASCADE');
    expect(sql).toContain('PRIMARY KEY (order_id, sku)');
  });

  it('creates each useful index once, skipping the one the primary key already gives', () => {
    const sql = toSql(shop());
    expect(sql).toContain('CREATE INDEX order_user_idx ON "order" ("user");');
    expect(sql.match(/CREATE INDEX/g)).toHaveLength(1);
  });

  it('notes what Postgres DDL cannot say: rows, sharding, replicas and the workload', () => {
    const sql = toSql(shop(), { name: 'Shop' });
    expect(sql).toContain('-- Shop, exported from CanItWork');
    expect(sql).toContain('-- order: about 500k rows in the simulation');
    expect(sql).toContain('Sharded 4 ways by user');
    expect(sql).toContain('1 read replica beside the primary');
    expect(sql).toContain('--   history: read order by user, 120 a second');
    expect(sql).not.toMatch(/PARTITION BY/);
  });

  it('adds the foreign keys of a cycle afterwards, so every CREATE TABLE runs', () => {
    const cycle = spec({
      tables: [
        {
          name: 'teams',
          rows: 10,
          columns: [
            { name: 'id', type: 'int', primary: true },
            { name: 'captain_id', type: 'int', references: { table: 'players', column: 'id' } },
          ],
        },
        {
          name: 'players',
          rows: 100,
          columns: [
            { name: 'id', type: 'int', primary: true },
            { name: 'team_id', type: 'int', references: { table: 'teams', column: 'id' } },
          ],
        },
      ],
    });
    const sql = toSql(cycle);
    expect(sql).toMatch(/ALTER TABLE \w+ ADD FOREIGN KEY/);
    expect(sql.match(/REFERENCES/g)).toHaveLength(2);
  });

  it('leaves out a foreign key Postgres would reject, and says why', () => {
    const broken = spec({
      tables: [
        { name: 'a', rows: 1, columns: [{ name: 'id', type: 'uuid', primary: true }] },
        {
          name: 'b',
          rows: 1,
          columns: [
            { name: 'id', type: 'int', primary: true },
            { name: 'a_id', type: 'int', references: { table: 'a', column: 'id' } },
            { name: 'ghost', type: 'int', references: { table: 'nope', column: 'id' } },
          ],
        },
      ],
    });
    const sql = toSql(broken);
    expect(sql).not.toContain('REFERENCES');
    expect(sql).toContain('-- a_id points at a.id');
    expect(sql).toContain('-- ghost points at nope.id');
  });

  it('includes the fixes applied while it ran: an added index and replica', () => {
    const run = database.createRun(shop(), 1) as SchemaRun;
    run.apply([{ op: 'add_index', table: 'users', columns: ['note'] }, { op: 'add_replica' }]);
    const sql = run.toSql('Shop');
    expect(sql).toContain('CREATE INDEX users_note_idx ON users (note);');
    expect(sql).toContain('2 read replicas beside the primary');
  });

  it('exports every shipped example and verified-style design without throwing', () => {
    for (const example of database.examples) {
      const design = database.compile(database.rules.spec(example)) as DatabaseSpec;
      const sql = toSql(design, { name: example });
      expect(sql.match(/CREATE TABLE/g)?.length, example).toBe(design.tables.length);
    }
  });
});
