import type { Column, DatabaseSpec, Table } from './schema';

// A design as a Postgres file anyone can run: CREATE TABLE in an order that satisfies every foreign key, then the indexes.
// It is written by code from the design the simulator tested, never by a model, so the file is exactly what passed.

export interface SqlExportOptions {
  /** The design's name, for the header */
  name?: string;
  /** Read replicas running now, including any a fix added */
  replicas?: number;
  /** Connections per node now */
  pool?: number;
  /** Whether a fix put a connection pooler in front */
  pooler?: boolean;
}

const TYPE: Record<Column['type'], string> = {
  int: 'integer',
  bigint: 'bigint',
  uuid: 'uuid',
  text: 'text',
  decimal: 'numeric',
  bool: 'boolean',
  timestamp: 'timestamptz',
};

const ON_DELETE: Record<NonNullable<NonNullable<Column['references']>['onDelete']>, string> = {
  cascade: 'CASCADE',
  restrict: 'RESTRICT',
  set_null: 'SET NULL',
};

// Words Postgres reserves, which a table or column could easily be called ("order", "user"): those get quoted
const RESERVED = new Set(
  'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric table tablesample then to trailing true union unique user using variadic verbose when where window with'.split(
    ' ',
  ),
);

/** A name as Postgres needs it: bare when it is a plain lowercase word, quoted otherwise. */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Postgres limits names to 63 bytes. */
const short = (name: string) => (name.length > 63 ? name.slice(0, 63) : name);

const plain = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

const count = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));

/** Tables in an order where each comes after the tables it points at; a cycle's back-references are returned to add later. */
function ordered(tables: Table[]) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: Table[] = [];
  const later: Array<{ table: Table; column: Column }> = [];
  const visit = (t: Table) => {
    if (done.has(t.name)) return;
    visiting.add(t.name);
    for (const column of t.columns) {
      const target = column.references && byName.get(column.references.table);
      if (!target || target === t) continue;
      if (visiting.has(target.name)) later.push({ table: t, column });
      else visit(target);
    }
    visiting.delete(t.name);
    done.add(t.name);
    out.push(t);
  };
  for (const t of tables) visit(t);
  return { tables: out, later };
}

/** Whether a foreign key points at a real column of a real table, so Postgres will accept it. */
function resolvable(tables: Table[], column: Column) {
  const ref = column.references;
  if (!ref) return false;
  const target = tables.find((t) => t.name === ref.table);
  const targetColumn = target?.columns.find((c) => c.name === ref.column);
  if (!target || !targetColumn) return false;
  // The two columns must compare: the same type, or two sizes of whole number
  const whole = (t: Column['type']) => t === 'int' || t === 'bigint';
  if (targetColumn.type !== column.type && !(whole(targetColumn.type) && whole(column.type))) return false;
  // Postgres needs the target to be a primary key or unique on its own
  const primaries = target.columns.filter((c) => c.primary);
  return (targetColumn.primary && primaries.length === 1) || Boolean(targetColumn.unique);
}

function foreignKey(column: Column) {
  const ref = column.references!;
  return `REFERENCES ${ident(ref.table)} (${ident(ref.column)})${ref.onDelete ? ` ON DELETE ${ON_DELETE[ref.onDelete]}` : ''}`;
}

function createTable(table: Table, tables: Table[], deferred: Set<Column>) {
  const primaries = table.columns.filter((c) => c.primary);
  const lines = table.columns.map((c) => {
    const parts = [ident(c.name), TYPE[c.type]];
    if (c.primary && primaries.length === 1) parts.push('PRIMARY KEY');
    else if (c.nullable === false || c.primary) parts.push('NOT NULL');
    else if (c.nullable) parts.push('NULL');
    if (c.unique && !(c.primary && primaries.length === 1)) parts.push('UNIQUE');
    if (c.references && resolvable(tables, c) && !deferred.has(c)) parts.push(foreignKey(c));
    return `  ${parts.join(' ')}`;
  });
  if (primaries.length > 1) lines.push(`  PRIMARY KEY (${primaries.map((c) => ident(c.name)).join(', ')})`);
  const notes = [`-- ${table.name}: about ${count(table.rows)} rows in the simulation`];
  if (table.partitions && table.partitions > 1)
    notes.push(`-- Sharded ${table.partitions} ways${table.partitionBy ? ` by ${table.partitionBy}` : ''} across database nodes in the simulation`);
  for (const c of table.columns)
    if (c.references && !resolvable(tables, c))
      notes.push(`-- ${c.name} points at ${c.references.table}.${c.references.column}, which is not a key of the same type there, so it has no foreign key`);
  return `${notes.join('\n')}\nCREATE TABLE ${ident(table.name)} (\n${lines.join(',\n')}\n);`;
}

/** Indexes worth creating: not one a primary key or unique column already gives, and each set of columns once. */
function indexes(table: Table) {
  const primaries = table.columns
    .filter((c) => c.primary)
    .map((c) => c.name)
    .join(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of table.indexes) {
    const columns = raw.filter((name) => table.columns.some((c) => c.name === name));
    if (!columns.length) continue;
    const key = columns.join(',');
    if (seen.has(key) || key === primaries) continue;
    if (columns.length === 1 && table.columns.find((c) => c.name === columns[0])?.unique) continue;
    seen.add(key);
    out.push(`CREATE INDEX ${ident(short(`${table.name}_${columns.join('_')}_idx`))} ON ${ident(table.name)} (${columns.map(ident).join(', ')});`);
  }
  return out;
}

/** The design as a Postgres SQL file. */
export function toSql(spec: DatabaseSpec, options: SqlExportOptions = {}): string {
  const { tables, later } = ordered(spec.tables);
  const deferred = new Set(later.map((l) => l.column));
  const header = [
    `-- ${plain(options.name ?? 'Database')}, exported from CanItWork`,
    '-- Written from the design the simulator tested, including any fixes applied. Runs on Postgres 13 or newer.',
  ];
  const replicas = options.replicas ?? spec.replicas ?? 0;
  if (replicas > 0) header.push(`-- The simulation ran ${replicas} read replica${replicas === 1 ? '' : 's'} beside the primary.`);
  if (options.pool ?? spec.pool)
    header.push(`-- Connection pool: ${options.pool ?? spec.pool} connections per node${options.pooler ? ', behind a connection pooler such as PgBouncer' : ''}.`);
  else if (options.pooler) header.push('-- A connection pooler such as PgBouncer sits in front of the database.');
  const body: string[] = [header.join('\n')];
  for (const table of tables) body.push(createTable(table, spec.tables, deferred));
  for (const { table, column } of later)
    if (resolvable(spec.tables, column)) body.push(`ALTER TABLE ${ident(table.name)} ADD FOREIGN KEY (${ident(column.name)}) ${foreignKey(column)};`);
  const created = tables.flatMap(indexes);
  if (created.length) body.push(created.join('\n'));
  if (spec.workload.length) {
    const lines = spec.workload.map((q) => {
      const where = q.where.length ? ` by ${q.where.join(', ')}` : '';
      const joins = q.joins.length ? `, joining ${q.joins.map((j) => j.table).join(', ')}` : '';
      const loop = (q.repeats ?? 1) > 1 ? `, ${q.repeats} times per request` : '';
      return `--   ${plain(q.name)}: ${q.kind} ${q.table}${where}${joins}, ${q.perSecond} a second${loop}`;
    });
    body.push(`-- The workload the simulation ran:\n${lines.join('\n')}`);
  }
  return `${body.join('\n\n')}\n`;
}
