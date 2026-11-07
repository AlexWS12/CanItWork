import type { Domain, Hypothesis, Incident, Issue, RecoveryOption } from '../../domain';
import { SchemaRun, isIndexed } from './engine';
import { DatabasePatchSchema, DatabaseSpecSchema, type Column, type DatabaseSpec, type Table } from './schema';

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
      for (const name of index) if (!t.columns.some((c) => c.name === name)) issues.push({ severity: 'error', message: `Index on ${t.name} uses ${name}, which doesn't exist`, target: t.name });
    }
  }
  for (const query of spec.workload) {
    const t = table(query.table);
    if (!t) {
      issues.push({ severity: 'error', message: `Query ${query.name} uses table ${query.table}, which doesn't exist` });
      continue;
    }
    for (const name of query.where) if (!t.columns.some((c) => c.name === name)) issues.push({ severity: 'error', message: `Query ${query.name} filters on ${query.table}.${name}, which doesn't exist` });
    for (const join of query.joins) {
      if (!table(join.table)?.columns.some((c) => c.name === join.foreign)) issues.push({ severity: 'error', message: `Query ${query.name} joins on ${join.table}.${join.foreign}, which doesn't exist` });
      if (!t.columns.some((c) => c.name === join.local)) issues.push({ severity: 'error', message: `Query ${query.name} joins from ${query.table}.${join.local}, which doesn't exist` });
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
  const run = new SchemaRun(spec, 1);
  run.step();
  for (const query of spec.workload) {
    const state = run.queries.get(query.name);
    if (state && !state.ok) issues.push({ severity: 'warning', message: `${query.name} misses its budget at ${Math.round(state.latency)} ms${state.scanned ? ', and it scans a whole table' : ''}`, target: query.table });
  }
  return issues;
}

const id = (name = 'id', type: Column['type'] = 'bigint'): Column => ({ name, type, primary: true });
const fk = (name: string, table: string): Column => ({ name, type: 'bigint', references: { table, column: 'id', onDelete: 'restrict' } });
const text = (name: string): Column => ({ name, type: 'text' });

function buildSchema(prompt: string): DatabaseSpec {
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
    out.push({ claim: `${query.name} relies on the index on ${table.name}.${column}: without it, it falls to a full scan.`, incident: { type: 'drop_index', target: `${table.name}.${column}` } });
    break;
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
      return [{ author: 'Schema rules', title: `Rebuild the index on ${target}`, rationale: 'Put the index back so reads can seek.', patches: [{ op: 'add_index', table: tableName, columns: [column] }] }, replica];
    case 'drop_column':
      return [{ author: 'Schema rules', title: `Restore ${target}`, rationale: 'Queries and foreign keys still depend on it.', patches: [{ op: 'restore_column', table: tableName, column }] }];
    case 'lock_table':
      return [{ author: 'Operations rules', title: `Release the lock on ${tableName}`, rationale: 'Let blocked queries through.', patches: [{ op: 'unlock_table', table: tableName }] }];
    case 'row_surge': {
      const unindexed = spec.workload.flatMap((q) => {
        const t = spec.tables.find((x) => x.name === q.table);
        const col = q.where.find((c) => t && !isIndexed(t, c));
        return col ? [{ op: 'add_index', table: q.table, columns: [col] }] : [];
      });
      const options = [
        { author: 'Data rules', title: `Archive old ${tableName} rows`, rationale: 'Shrink the table back down.', patches: [{ op: 'archive_rows', table: tableName, fraction: 0.8 }] },
        replica,
      ];
      if (unindexed.length) options.unshift({ author: 'Schema rules', title: 'Index every filtered column', rationale: 'Seeks barely notice growth; scans do.', patches: unindexed });
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
  capabilities: 'Relational schemas: tables, columns, primary and foreign keys, indexes, row counts and a query workload. Checks referential integrity and common design flaws, and estimates query cost, load and how they change with data growth.',
  limits: ['Costs are estimates from a simple scan and seek model, not a real query planner', 'No transactions, isolation or replication lag', 'Relational schemas only'],
  examples: ['A university database with students, courses, instructors and enrollments'],
  suggestions: ['What happens if the enrollments table grows ten times?', 'What happens if a migration locks the busiest table?', 'Which queries need an index?'],
  keywords: /database|schema|\bsql\b|postgres|mysql|\btables?\b|foreign key|normali[sz]/i,
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
    "indexes": [[column names]]
  }],
  "workload": [{"name": string, "kind": "read"|"write", "table": string, "where": [columns], "joins": [{"table": string, "local": column here, "foreign": column there}], "perSecond": number}]
}
Include a realistic workload of 2 to 6 queries and realistic row counts. Foreign key columns must have the same type as the column they reference.`,
  incidentTypes: ['drop_index', 'drop_column', 'lock_table', 'row_surge', 'workload_spike'],
  incidentDoc: `{"type":"drop_index","target":"table.column"}
{"type":"drop_column","target":"table.column"}
{"type":"lock_table","target":"table"}
{"type":"row_surge","target":"table","value":multiplier}
{"type":"workload_spike","value":multiplier}`,
  patchSchema: DatabasePatchSchema,
  patchDoc: `{"op":"add_index","table":"t","columns":["c"]}
{"op":"add_replica"}
{"op":"archive_rows","table":"t","fraction":0.05-0.95}
{"op":"restore_column","table":"t","column":"c"}
{"op":"unlock_table","table":"t"}`,
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
    return [...out.slice(0, 3), { title: 'Add a read replica', patches: [{ op: 'add_replica' }] }];
  },
  rules: {
    spec: buildSchema,
    hypotheses,
    recoveries,
  },
};
