import type { Domain, Hypothesis, Incident, Issue, RecoveryOption } from '../../domain';
import { SchemaRun, isIndexed } from './engine';
import { DatabasePatchSchema, DatabaseSpecSchema, partitionsOf, type Column, type DatabaseSpec, type Table } from './schema';

function validateSchema(spec: DatabaseSpec): Issue[] {
  const issues: Issue[] = [];
  const names = new Set(spec.tables.map((t) => t.name));
  if (names.size !== spec.tables.length) issues.push({ severity: 'error', message: 'Two tables share a name' });
  const table = (name: string) => spec.tables.find((t) => t.name === name);

  for (const t of spec.tables) {
    for (const col of t.columns) {
      if (!col.references) continue;
      const parent = table(col.references.table);
      const target = parent?.columns.find((c) => c.name === col.references!.column);
      if (!target) {
        issues.push({ severity: 'error', message: `${t.name}.${col.name} references ${col.references.table}.${col.references.column}, which doesn't exist`, target: t.name });
      } else if (target.type !== col.type) {
        issues.push({ severity: 'error', message: `${t.name}.${col.name} is ${col.type} but references ${target.type}`, target: t.name });
      } else if (!target.primary && !target.unique) {
        issues.push({ severity: 'warning', message: `${t.name}.${col.name} references a column that isn't unique`, target: t.name });
      }
    }
    for (const index of t.indexes) {
      for (const name of index)
        if (!t.columns.some((c) => c.name === name)) issues.push({ severity: 'error', message: `Index on ${t.name} uses ${name}, which doesn't exist`, target: t.name });
    }
    if (t.partitionBy && !t.columns.some((c) => c.name === t.partitionBy)) {
      issues.push({ severity: 'error', repair: true, message: `${t.name} is partitioned by ${t.partitionBy}, which isn't one of its columns`, target: t.name });
    }
    if ((t.partitions ?? 1) > 1 && !t.partitionBy) {
      issues.push({ severity: 'error', repair: true, message: `${t.name} has ${t.partitions} partitions but no partitionBy column to route rows`, target: t.name });
    }
  }
  for (const query of spec.workload) {
    const t = table(query.table);
    if (!t) {
      issues.push({ severity: 'error', message: `Query ${query.name} uses table ${query.table}, which doesn't exist` });
      continue;
    }
    for (const name of query.where)
      if (!t.columns.some((c) => c.name === name)) issues.push({ severity: 'error', message: `Query ${query.name} filters on ${query.table}.${name}, which doesn't exist` });
    for (const join of query.joins) {
      if (!table(join.table)?.columns.some((c) => c.name === join.foreign))
        issues.push({ severity: 'error', message: `Query ${query.name} joins on ${join.table}.${join.foreign}, which doesn't exist` });
      if (!t.columns.some((c) => c.name === join.local))
        issues.push({ severity: 'error', message: `Query ${query.name} joins from ${query.table}.${join.local}, which doesn't exist` });
    }
  }
  if (issues.some((i) => i.severity === 'error')) return issues;

  for (const t of spec.tables) {
    if (!t.columns.some((c) => c.primary)) issues.push({ severity: 'warning', message: `${t.name} has no primary key`, target: t.name });
    for (const col of t.columns) {
      if (col.references && !isIndexed(t, col.name)) issues.push({ severity: 'warning', message: `Foreign key ${t.name}.${col.name} has no index`, target: t.name });
    }
    const repeats = t.columns.map((c) => c.name.match(/^(.+?)_?\d+$/)?.[1]).filter(Boolean);
    const repeated = repeats.find((name, i) => repeats.indexOf(name) !== i);
    if (repeated) issues.push({ severity: 'warning', message: `${t.name} repeats ${repeated} columns, which belong in their own table`, target: t.name });
  }
  for (const query of spec.workload) {
    const t = table(query.table)!;
    const parts = partitionsOf(t);
    if (query.kind === 'read' && parts > 1 && !query.where.includes(t.partitionBy!)) {
      issues.push({ severity: 'warning', message: `${query.name} doesn't filter on ${t.name}.${t.partitionBy}, so it reads all ${parts} partitions`, target: t.name });
    }
  }
  const run = new SchemaRun(spec, 1);
  run.step();
  for (const query of spec.workload) {
    const state = run.queries.get(query.name);
    if (state && !state.ok)
      issues.push({
        severity: 'warning',
        message: `${query.name} misses its budget at ${Math.round(state.latency)} ms${state.scanned ? ', and it scans a whole table' : ''}`,
        target: query.table,
      });
  }
  return issues;
}

const id = (name = 'id', type: Column['type'] = 'bigint'): Column => ({ name, type, primary: true });
const fk = (name: string, table: string): Column => ({ name, type: 'bigint', references: { table, column: 'id', onDelete: 'restrict' } });
const text = (name: string): Column => ({ name, type: 'text' });

/** The biggest table a query filters on, and the column it filters by. */
function partitionCandidate(spec: DatabaseSpec) {
  const filtered = spec.workload.filter((q) => q.where.length).map((q) => ({ table: spec.tables.find((t) => t.name === q.table), key: q.where[0] }));
  return filtered.filter((c): c is { table: Table; key: string } => Boolean(c.table)).sort((a, b) => b.table.rows - a.table.rows)[0] ?? null;
}

function buildSchema(prompt: string): DatabaseSpec {
  const spec = baseSchema(prompt);
  if (/shard|partition|scale[sd]? out|horizontal/i.test(prompt)) {
    const candidate = partitionCandidate(spec);
    if (candidate) {
      candidate.table.partitions = 8;
      candidate.table.partitionBy = candidate.key;
    }
  }
  return spec;
}

function baseSchema(prompt: string): DatabaseSpec {
  if (/universit|school|student|course|college/i.test(prompt)) {
    const tables: Table[] = [
      { name: 'students', rows: 40000, columns: [id(), text('name'), { name: 'email', type: 'text', unique: true }, { name: 'enrolled_at', type: 'timestamp' }], indexes: [] },
      { name: 'departments', rows: 40, columns: [id(), text('name')], indexes: [] },
      { name: 'instructors', rows: 1800, columns: [id(), text('name'), fk('department_id', 'departments')], indexes: [] },
      { name: 'courses', rows: 6000, columns: [id(), text('title'), fk('department_id', 'departments'), fk('instructor_id', 'instructors')], indexes: [] },
      { name: 'enrollments', rows: 900000, columns: [id(), fk('student_id', 'students'), fk('course_id', 'courses'), text('grade')], indexes: [['student_id']] },
    ];
    return {
      tables,
      workload: [
        { name: 'student transcript', kind: 'read', table: 'enrollments', where: ['student_id'], joins: [{ table: 'courses', local: 'course_id', foreign: 'id' }], perSecond: 120 },
        { name: 'course roster', kind: 'read', table: 'enrollments', where: ['course_id'], joins: [{ table: 'students', local: 'student_id', foreign: 'id' }], perSecond: 30 },
        { name: 'enroll in course', kind: 'write', table: 'enrollments', where: [], joins: [], perSecond: 15 },
      ],
    };
  }
  const tables: Table[] = [
    { name: 'customers', rows: 200000, columns: [id(), { name: 'email', type: 'text', unique: true }, text('name')], indexes: [] },
    { name: 'products', rows: 50000, columns: [id(), text('title'), { name: 'price', type: 'decimal' }], indexes: [] },
    { name: 'orders', rows: 3000000, columns: [id(), fk('customer_id', 'customers'), { name: 'created_at', type: 'timestamp' }, text('status')], indexes: [['customer_id']] },
    { name: 'order_items', rows: 9000000, columns: [id(), fk('order_id', 'orders'), fk('product_id', 'products'), { name: 'quantity', type: 'int' }], indexes: [['order_id']] },
  ];
  return {
    tables,
    workload: [
      { name: 'order history', kind: 'read', table: 'orders', where: ['customer_id'], joins: [{ table: 'order_items', local: 'id', foreign: 'order_id' }], perSecond: 300 },
      { name: 'orders by status', kind: 'read', table: 'orders', where: ['status'], joins: [], perSecond: 5 },
      { name: 'place order', kind: 'write', table: 'orders', where: [], joins: [], perSecond: 40 },
    ],
  };
}

function hypotheses(spec: DatabaseSpec): Hypothesis[] {
  const out: Hypothesis[] = [];
  for (const query of spec.workload) {
    const table = spec.tables.find((t) => t.name === query.table);
    const column = query.where.find((c) => table?.indexes.some((ix) => ix[0] === c));
    if (!table || !column) continue;
    out.push({
      claim: `${query.name} relies on the index on ${table.name}.${column}: without it, it falls to a full scan.`,
      incident: { type: 'drop_index', target: `${table.name}.${column}` },
    });
    break;
  }
  const partitioned = spec.tables.find((t) => partitionsOf(t) > 1);
  if (partitioned) {
    out.push({
      claim: `A hot key on ${partitioned.name} sends most of its traffic to one of ${partitionsOf(partitioned)} partitions, which can't keep up.`,
      incident: { type: 'hot_partition', target: partitioned.name, value: 0.8 },
    });
  }
  const biggest = [...spec.tables].sort((a, b) => b.rows - a.rows)[0];
  out.push({ claim: `${biggest.name} doesn't scale: ten times the rows pushes queries over budget.`, incident: { type: 'row_surge', target: biggest.name, value: 10 } });
  const hot = spec.workload[0];
  if (hot) out.push({ claim: `A long lock on ${hot.table} stops the busiest query outright.`, incident: { type: 'lock_table', target: hot.table } });
  return out.slice(0, 3);
}

function recoveries(spec: DatabaseSpec, incident: Incident | undefined): RecoveryOption[] {
  const target = incident?.target ?? '';
  const [tableName, column] = target.split('.');
  const replica = { author: 'Capacity rules', title: 'Add a read replica', rationale: 'Double the capacity for reads.', patches: [{ op: 'add_replica' }] };
  switch (incident?.type) {
    case 'drop_index':
      return [
        {
          author: 'Schema rules',
          title: `Rebuild the index on ${target}`,
          rationale: 'Put the index back so reads can seek.',
          patches: [{ op: 'add_index', table: tableName, columns: [column] }],
        },
        replica,
      ];
    case 'drop_column':
      return [
        {
          author: 'Schema rules',
          title: `Restore ${target}`,
          rationale: 'Queries and foreign keys still depend on it.',
          patches: [{ op: 'restore_column', table: tableName, column }],
        },
      ];
    case 'lock_table':
      return [
        { author: 'Operations rules', title: `Release the lock on ${tableName}`, rationale: 'Let blocked queries through.', patches: [{ op: 'unlock_table', table: tableName }] },
      ];
    case 'hot_partition': {
      const table = spec.tables.find((t) => t.name === tableName);
      if (!table) return [replica];
      const parts = partitionsOf(table);
      const options: RecoveryOption[] = [];
      const primary = table.columns.find((c) => c.primary)?.name;
      if (primary && primary !== table.partitionBy) {
        options.push({
          author: 'Schema rules',
          title: `Repartition ${tableName} by ${primary}`,
          rationale: 'A unique key spreads the hot rows evenly, though queries on the old key then read every partition.',
          patches: [{ op: 'repartition', table: tableName, partitions: parts, by: primary }],
        });
      }
      options.push({
        author: 'Capacity rules',
        title: `Split ${tableName} into ${Math.min(32, parts * 2)} partitions`,
        rationale: 'Smaller partitions, though the hot key still lands on one of them.',
        patches: [{ op: 'repartition', table: tableName, partitions: Math.min(32, parts * 2) }],
      });
      options.push({ ...replica, rationale: 'Give every partition a replica to share the load.' });
      return options;
    }
    case 'row_surge': {
      const unindexed = spec.workload.flatMap((q) => {
        const t = spec.tables.find((x) => x.name === q.table);
        const col = q.where.find((c) => t && !isIndexed(t, c));
        return col ? [{ op: 'add_index', table: q.table, columns: [col] }] : [];
      });
      const options = [
        {
          author: 'Data rules',
          title: `Archive old ${tableName} rows`,
          rationale: 'Shrink the table back down.',
          patches: [{ op: 'archive_rows', table: tableName, fraction: 0.8 }],
        },
        replica,
      ];
      if (unindexed.length)
        options.unshift({ author: 'Schema rules', title: 'Index every filtered column', rationale: 'Seeks barely notice growth; scans do.', patches: unindexed });
      return options;
    }
    default:
      return [replica];
  }
}

export const database: Domain<DatabaseSpec, DatabaseSpec> = {
  id: 'database',
  label: 'Databases',
  blurb: 'Relational schemas with keys, indexes and a query workload',
  capabilities:
    'Relational schemas: tables, columns, primary and foreign keys, indexes, row counts, partitioning across nodes, read replicas and a query workload. Checks referential integrity and common design flaws, and estimates query cost, load, hot partitions and how they change with data growth.',
  limits: ['Costs are estimates from a simple scan and seek model, not a real query planner', 'No transactions, isolation or replication lag', 'Relational schemas only'],
  examples: ['A university database with students, courses, instructors and enrollments'],
  suggestions: ['What happens if the enrollments table grows ten times?', 'What happens if a migration locks the busiest table?', 'Which queries need an index?'],
  keywords: /database|schema|\bsql\b|postgres|mysql|\btables?\b|foreign key|normali[sz]|shard|partitioned/i,
  ticksPerSecond: 8,
  horizon: 300,
  seeds: 1,
  responseDelay: 15,
  specSchema: DatabaseSpecSchema,
  specDoc: `{
  "tables": [{
    "name": string,
    "rows": integer,
    "columns": [{"name": string, "type": "int"|"bigint"|"uuid"|"text"|"decimal"|"bool"|"timestamp", "primary"?: boolean, "unique"?: boolean, "nullable"?: boolean, "references"?: {"table": string, "column": string, "onDelete"?: "cascade"|"restrict"|"set_null"}}],
    "indexes": [[column names]],
    "partitions"?: integer 2-32, "partitionBy"?: column
  }],
  "workload": [{"name": string, "kind": "read"|"write", "table": string, "where": [columns], "joins": [{"table": string, "local": column here, "foreign": column there}], "perSecond": number}],
  "replicas"?: read replicas 0-8
}
Include a realistic workload of 2 to 6 queries and realistic row counts. Foreign key columns must have the same type as the column they reference. Partition only when the user asks for sharding or partitioning, by the column the busiest queries filter on.`,
  incidentTypes: ['drop_index', 'drop_column', 'lock_table', 'row_surge', 'workload_spike', 'hot_partition'],
  incidentDoc: `{"type":"drop_index","target":"table.column"}
{"type":"drop_column","target":"table.column"}
{"type":"lock_table","target":"table"}
{"type":"row_surge","target":"table","value":multiplier}
{"type":"workload_spike","value":multiplier}
{"type":"hot_partition","target":"partitioned table","value":share of its traffic on one partition 0.3-0.95}`,
  patchSchema: DatabasePatchSchema,
  patchDoc: `{"op":"add_index","table":"t","columns":["c"]}
{"op":"add_replica"}
{"op":"archive_rows","table":"t","fraction":0.05-0.95}
{"op":"restore_column","table":"t","column":"c"}
{"op":"unlock_table","table":"t"}
{"op":"repartition","table":"t","partitions":integer,"by"?:"column"}`,
  council: [
    { name: 'SchemaDesigner', brief: 'indexes, keys and table structure' },
    { name: 'PerformanceEngineer', brief: 'query cost and what is scanning' },
    { name: 'DataOperator', brief: 'capacity, replicas and archiving data' },
  ],
  compile: (spec) => spec,
  validate: validateSchema,
  describe: (spec) => JSON.stringify(spec),
  createRun: (spec, seed) => new SchemaRun(spec, seed),
  variants: (spec) => {
    const out = spec.workload.flatMap((q) => {
      const t = spec.tables.find((x) => x.name === q.table);
      const col = q.where.find((c) => t && !isIndexed(t, c));
      return col ? [{ title: `Index ${q.table}.${col}`, patches: [{ op: 'add_index', table: q.table, columns: [col] }] }] : [];
    });
    const candidate = partitionCandidate(spec);
    const partition =
      candidate && partitionsOf(candidate.table) === 1
        ? [
            {
              title: `Partition ${candidate.table.name} by ${candidate.key}`,
              spec: { ...spec, tables: spec.tables.map((t) => (t === candidate.table ? { ...t, partitions: 8, partitionBy: candidate.key } : t)) },
            },
          ]
        : [];
    return [...out.slice(0, 3), { title: 'Add a read replica', patches: [{ op: 'add_replica' }] }, ...partition];
  },
  rules: {
    spec: buildSchema,
    hypotheses,
    recoveries,
  },
};
