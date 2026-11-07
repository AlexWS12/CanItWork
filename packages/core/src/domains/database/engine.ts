import type { Breakable, Evaluation, Incident, Inspection, Metric, Point, Run, TimedEvent } from '../../domain';
import type { DatabasePatch, DatabaseSpec, Query, Table } from './schema';

const ROWS_PER_PAGE = 100;
const CAPACITY = 40000;
const MS_PER_COST = 0.05;
const BUDGET_MS = 100;
const GROWTH_PER_TICK = 60;
const SERIES_STEP = 5;

export interface QueryState {
  cost: number;
  latency: number;
  ok: boolean;
  broken: string | null;
  scanned: boolean;
}

export const isIndexed = (table: Table, column: string) => {
  const col = table.columns.find((c) => c.name === column);
  return Boolean(col?.primary || col?.unique || table.indexes.some((ix) => ix[0] === column));
};

const seek = (rows: number) => Math.log2(rows + 2);
const scan = (rows: number) => rows / ROWS_PER_PAGE + 1;

export class SchemaRun implements Run {
  readonly log: TimedEvent[] = [];
  readonly spec: DatabaseSpec;
  readonly queries = new Map<string, QueryState>();
  readonly tableLoad = new Map<string, number>();
  readonly locked = new Set<string>();
  readonly droppedColumns = new Set<string>();
  tick = 0;
  utilization = 0;
  withinBudget = 1;

  private spike = 1;
  private replicas = 0;
  private series: Point[] = [];
  private scoreSum = 0;

  constructor(spec: DatabaseSpec, _seed: number) {
    this.spec = structuredClone(spec);
    this.measure();
  }

  table(name: string) {
    return this.spec.tables.find((t) => t.name === name);
  }

  private blocked(query: Query) {
    const tables = [query.table, ...query.joins.map((j) => j.table)];
    const locked = tables.find((t) => this.locked.has(t));
    if (locked) return `${locked} is locked`;
    const columns = [
      ...query.where.map((c) => `${query.table}.${c}`),
      ...query.joins.flatMap((j) => [`${query.table}.${j.local}`, `${j.table}.${j.foreign}`]),
    ];
    const missing = columns.find((c) => this.droppedColumns.has(c));
    if (missing) return `${missing} was dropped`;
    if (!this.table(query.table)) return `${query.table} doesn't exist`;
    return null;
  }

  costOf(query: Query) {
    const table = this.table(query.table);
    if (!table) return { cost: 0, scanned: false };
    const usesIndex = query.where.some((c) => isIndexed(table, c));
    const access = query.where.length && usesIndex ? seek(table.rows) : scan(table.rows);
    let scanned = !(query.where.length && usesIndex);
    let cost = access;
    for (const join of query.joins) {
      const other = this.table(join.table);
      if (!other) continue;
      if (isIndexed(other, join.foreign)) cost += seek(other.rows);
      else {
        cost += scan(other.rows);
        scanned = true;
      }
    }
    if (query.kind === 'write') {
      cost = 2 + table.indexes.length * 1.5 + (query.where.length ? access : 0);
      for (const col of table.columns) {
        const parent = col.references && this.table(col.references.table);
        if (parent) cost += seek(parent.rows);
      }
    }
    return { cost, scanned };
  }

  private measure() {
    this.queries.clear();
    this.tableLoad.clear();
    let load = 0;
    for (const query of this.spec.workload) {
      const { cost, scanned } = this.costOf(query);
      const broken = this.blocked(query);
      this.queries.set(query.name, { cost, latency: 0, ok: false, broken, scanned });
      if (broken) continue;
      const units = cost * query.perSecond * this.spike;
      load += units;
      this.tableLoad.set(query.table, (this.tableLoad.get(query.table) ?? 0) + units);
    }
    const capacity = CAPACITY * (1 + this.replicas);
    this.utilization = load / capacity;
    const queueing = 1 / (1 - Math.min(this.utilization, 0.97));
    let good = 0;
    let total = 0;
    for (const query of this.spec.workload) {
      const state = this.queries.get(query.name)!;
      state.latency = state.cost * MS_PER_COST * queueing;
      state.ok = !state.broken && state.latency <= BUDGET_MS;
      total += query.perSecond;
      if (state.ok) good += query.perSecond;
    }
    this.withinBudget = total ? good / total : 1;
  }

  step() {
    for (const query of this.spec.workload) {
      if (query.kind !== 'write' || this.queries.get(query.name)?.broken) continue;
      const table = this.table(query.table);
      if (table) table.rows += Math.round(query.perSecond * this.spike * GROWTH_PER_TICK);
    }
    this.measure();
    this.tick++;
    this.scoreSum += this.withinBudget * 100;
    if (this.tick % SERIES_STEP === 0) this.series.push({ t: this.tick, value: Math.round(this.withinBudget * 1000) / 10 });
  }

  inject(incident: Incident) {
    this.log.push({ at: this.tick, incident });
    const target = incident.target ?? '';
    const [tableName, column] = target.split('.');
    const table = this.table(tableName);
    switch (incident.type) {
      case 'drop_index':
        if (table) table.indexes = table.indexes.filter((ix) => ix[0] !== column);
        break;
      case 'drop_column':
        this.droppedColumns.add(target);
        break;
      case 'lock_table':
        this.locked.add(tableName);
        break;
      case 'row_surge':
        if (table) table.rows = Math.round(table.rows * Math.max(1.5, incident.value ?? 10));
        break;
      case 'workload_spike':
        this.spike = Math.max(1, incident.value ?? 3);
        break;
      case 'unlock':
        this.locked.delete(tableName);
        break;
      case 'restore_column':
        this.droppedColumns.delete(target);
        break;
    }
    this.measure();
  }

  apply(patches: unknown[]) {
    this.log.push({ at: this.tick, patches });
    for (const patch of patches as DatabasePatch[]) {
      switch (patch.op) {
        case 'add_index': {
          const table = this.table(patch.table);
          if (table) table.indexes.push(patch.columns);
          break;
        }
        case 'add_replica':
          this.replicas++;
          break;
        case 'archive_rows': {
          const table = this.table(patch.table);
          if (table) table.rows = Math.round(table.rows * (1 - patch.fraction));
          break;
        }
        case 'restore_column':
          this.droppedColumns.delete(`${patch.table}.${patch.column}`);
          break;
        case 'unlock_table':
          this.locked.delete(patch.table);
          break;
      }
    }
    this.measure();
  }

  evaluation(): Evaluation {
    const broken = [...this.queries.values()].filter((q) => q.broken).length;
    return {
      score: this.tick ? Math.round((this.scoreSum / this.tick) * 10) / 10 : 0,
      scoreLabel: '% of queries within 100 ms',
      metrics: [
        { label: 'database load', value: `${Math.round(this.utilization * 100)}%` },
        { label: 'queries broken', value: broken },
        { label: 'full scans', value: [...this.queries.values()].filter((q) => q.scanned).length },
      ],
      series: this.series,
    };
  }

  telemetry(): Metric[] {
    const pct = Math.round(this.withinBudget * 1000) / 10;
    const broken = [...this.queries.values()].filter((q) => q.broken).length;
    const load = Math.round(this.utilization * 100);
    const scans = [...this.queries.values()].filter((q) => q.scanned).length;
    return [
      { label: 'within 100 ms', value: `${pct}%`, tone: pct < 80 ? 'danger' : pct < 99 ? 'warn' : undefined },
      { label: 'database load', value: `${load}%`, tone: load > 100 ? 'danger' : load > 80 ? 'warn' : undefined },
      { label: 'full table scans', value: scans, tone: scans ? 'warn' : undefined },
      { label: 'queries broken', value: broken, tone: broken ? 'danger' : undefined },
    ];
  }

  private busiestTable() {
    return [...this.tableLoad.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.spec.tables[0].name;
  }

  breakables(): Breakable[] {
    const out: Breakable[] = [];
    const busiest = this.busiestTable();
    const used = this.spec.workload.flatMap((q) => {
      const table = this.table(q.table);
      const column = q.where.find((c) => table?.indexes.some((ix) => ix[0] === c));
      return column ? [`${q.table}.${column}`] : [];
    })[0];
    if (used) out.push({ label: `Drop ${used.split('.')[1]} index`, incident: { type: 'drop_index', target: used }, keywords: ['index', used] });
    out.push({ label: `Lock ${busiest}`, incident: { type: 'lock_table', target: busiest }, keywords: ['lock', 'migration', busiest] });
    out.push({ label: `${busiest} ×10`, incident: { type: 'row_surge', target: busiest, value: 10 }, keywords: ['rows', 'growth', 'grow', 'data', busiest] });
    out.push({ label: 'Queries ×3', incident: { type: 'workload_spike', value: 3 }, keywords: ['traffic', 'spike', 'surge', 'load', 'workload'] });
    return out;
  }

  inspect(target: string): Inspection | null {
    const table = this.table(target);
    if (!table) return null;
    const queries = this.spec.workload.filter((q) => q.table === target);
    const slowest = queries.map((q) => this.queries.get(q.name)?.latency ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const locked = this.locked.has(target);
    const referenced = table.columns.find((c) => this.spec.tables.some((t) => t.columns.some((col) => col.references?.table === target && col.references.column === c.name)));
    const actions: Inspection['actions'] = [
      locked
        ? { label: 'Release lock', incident: { type: 'unlock', target }, destructive: false }
        : { label: 'Lock this table', incident: { type: 'lock_table', target }, destructive: true },
      { label: 'Grow rows ×10', incident: { type: 'row_surge', target, value: 10 }, destructive: true },
    ];
    if (referenced) actions.push({ label: `Drop ${referenced.name}`, incident: { type: 'drop_column', target: `${target}.${referenced.name}` }, destructive: true });
    return {
      title: target,
      rows: [
        ['Rows', table.rows.toLocaleString('en-US')],
        ['Columns', table.columns.length],
        ['Indexes', table.indexes.length],
        ['Queries', queries.length],
        ['Slowest', `${Math.round(slowest)} ms`],
        ['Status', locked ? 'Locked' : 'Open'],
      ],
      actions,
    };
  }
}
