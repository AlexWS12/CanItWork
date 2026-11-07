import type { Breakable, Evaluation, Incident, Inspection, Metric, Point, Run, TimedEvent } from '../../domain';
import { partitionsOf, type DatabasePatch, type DatabaseSpec, type Query, type Table } from './schema';

const ROWS_PER_PAGE = 100;
const CAPACITY = 40000;
const MS_PER_COST = 0.05;
const BUDGET_MS = 100;
const GROWTH_PER_TICK = 60;
const SERIES_STEP = 5;
const GATHER_MS = 0.5;
const DEFAULT_SKEW = 0.5;

export interface QueryState {
  cost: number;
  latency: number;
  ok: boolean;
  broken: string | null;
  scanned: boolean;
  /** Partitions each execution touches: 1 when it filters on the partition key, all of them when it doesn't. */
  partitions: number;
}

const queueing = (utilization: number) => 1 / (1 - Math.min(utilization, 0.97));

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
  /** Share of a partitioned table's keyed traffic landing on its first partition, while a hot key lasts. */
  readonly hot = new Map<string, number>();
  /** Utilization of each partition of every partitioned table. */
  readonly partitionLoad = new Map<string, number[]>();
  tick = 0;
  utilization = 0;
  withinBudget = 1;

  private spike = 1;
  private replicas = 0;
  private series: Point[] = [];
  private scoreSum = 0;

  constructor(spec: DatabaseSpec, _seed: number) {
    this.spec = structuredClone(spec);
    this.replicas = spec.replicas ?? 0;
    this.measure();
  }

  /** Fraction of a table's keyed traffic each partition receives. */
  shares(table: Table): number[] {
    const n = partitionsOf(table);
    const skew = this.hot.get(table.name);
    if (skew === undefined || n === 1) return new Array(n).fill(1 / n);
    return Array.from({ length: n }, (_, i) => (i === 0 ? skew : (1 - skew) / (n - 1)));
  }

  table(name: string) {
    return this.spec.tables.find((t) => t.name === name);
  }

  private blocked(query: Query) {
    const tables = [query.table, ...query.joins.map((j) => j.table)];
    const locked = tables.find((t) => this.locked.has(t));
    if (locked) return `${locked} is locked`;
    const columns = [...query.where.map((c) => `${query.table}.${c}`), ...query.joins.flatMap((j) => [`${query.table}.${j.local}`, `${j.table}.${j.foreign}`])];
    const missing = columns.find((c) => this.droppedColumns.has(c));
    if (missing) return `${missing} was dropped`;
    if (!this.table(query.table)) return `${query.table} doesn't exist`;
    return null;
  }

  /**
   * Work for one execution. `each` is the work on one partition it touches and `partitions` how
   * many it touches; `cost` is their product, the total, which equals `each` on an unpartitioned table.
   */
  costOf(query: Query) {
    const table = this.table(query.table);
    if (!table) return { cost: 0, each: 0, partitions: 1, scanned: false };
    const parts = partitionsOf(table);
    const keyed = query.kind === 'write' || query.where.includes(table.partitionBy ?? '');
    const partitions = keyed ? 1 : parts;
    const rows = table.rows / parts;
    const usesIndex = query.where.some((c) => isIndexed(table, c));
    const access = query.where.length && usesIndex ? seek(rows) : scan(rows);
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
    return { cost: cost * partitions, each: cost, partitions, scanned };
  }

  /**
   * Unpartitioned tables share the primary; each partition of a partitioned table is its own node.
   * Every node has the same capacity, multiplied by its replicas.
   */
  private measure() {
    this.queries.clear();
    this.tableLoad.clear();
    this.partitionLoad.clear();
    const capacity = CAPACITY * (1 + this.replicas);
    let primary = 0;
    for (const table of this.spec.tables) {
      if (partitionsOf(table) > 1) this.partitionLoad.set(table.name, new Array(partitionsOf(table)).fill(0));
    }
    for (const query of this.spec.workload) {
      const { cost, each, partitions, scanned } = this.costOf(query);
      const broken = this.blocked(query);
      this.queries.set(query.name, { cost, latency: 0, ok: false, broken, scanned, partitions });
      if (broken) continue;
      const units = each * query.perSecond * this.spike;
      this.tableLoad.set(query.table, (this.tableLoad.get(query.table) ?? 0) + units * partitions);
      const parts = this.partitionLoad.get(query.table);
      if (!parts) primary += units;
      else if (partitions > 1) parts.forEach((_, i) => (parts[i] += units));
      else this.shares(this.table(query.table)!).forEach((share, i) => (parts[i] += units * share));
    }
    for (const parts of this.partitionLoad.values()) parts.forEach((units, i) => (parts[i] = units / capacity));
    const primaryUtil = primary / capacity;
    this.utilization = Math.max(primaryUtil, ...[...this.partitionLoad.values()].flat());

    let good = 0;
    let total = 0;
    for (const query of this.spec.workload) {
      const state = this.queries.get(query.name)!;
      total += query.perSecond;
      const each = state.cost / state.partitions;
      const parts = this.partitionLoad.get(query.table);
      let fraction: number;
      if (!parts) {
        state.latency = each * MS_PER_COST * queueing(primaryUtil);
        fraction = state.latency <= BUDGET_MS ? 1 : 0;
      } else if (state.partitions > 1) {
        state.latency = each * MS_PER_COST * queueing(Math.max(...parts)) + GATHER_MS * state.partitions;
        fraction = state.latency <= BUDGET_MS ? 1 : 0;
      } else {
        const shares = this.shares(this.table(query.table)!);
        const latencies = parts.map((u) => each * MS_PER_COST * queueing(u));
        state.latency = Math.max(...latencies.filter((_, i) => shares[i] > 0));
        fraction = latencies.reduce((sum, l, i) => sum + (l <= BUDGET_MS ? shares[i] : 0), 0);
      }
      if (state.broken) fraction = 0;
      state.ok = fraction >= 0.999;
      good += query.perSecond * fraction;
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
      case 'hot_partition':
        if (table && partitionsOf(table) > 1) {
          const n = partitionsOf(table);
          this.hot.set(tableName, Math.min(0.95, Math.max(1 / n, incident.value ?? DEFAULT_SKEW)));
        }
        break;
      case 'cool_partition':
        this.hot.delete(tableName);
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
        case 'repartition': {
          const table = this.table(patch.table);
          if (!table) break;
          if (patch.by && !table.columns.some((c) => c.name === patch.by)) break;
          const before = table.partitionBy;
          table.partitions = patch.partitions;
          if (patch.by) table.partitionBy = patch.by;
          // A new key spreads the hot key's rows out; more partitions on the same key don't.
          if (patch.by && patch.by !== before) this.hot.delete(patch.table);
          break;
        }
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
    const partitioned = this.spec.tables.find((t) => partitionsOf(t) > 1 && !this.hot.has(t.name));
    if (partitioned) {
      out.push({
        label: `Hot key on ${partitioned.name}`,
        incident: { type: 'hot_partition', target: partitioned.name, value: 0.6 },
        keywords: ['hot', 'partition', 'shard', 'skew', 'celebrity', partitioned.name],
      });
    }
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
    const rows: Inspection['rows'] = [
      ['Rows', table.rows.toLocaleString('en-US')],
      ['Columns', table.columns.length],
      ['Indexes', table.indexes.length],
      ['Queries', queries.length],
      ['Slowest', `${Math.round(slowest)} ms`],
      ['Status', locked ? 'Locked' : 'Open'],
    ];
    const parts = this.partitionLoad.get(target);
    if (parts) {
      rows.push(['Partitions', `${parts.length} by ${table.partitionBy}`]);
      rows.push(['Busiest partition', `${Math.round(Math.max(...parts) * 100)}% load`]);
      actions.push(
        this.hot.has(target)
          ? { label: 'Even out the hot key', incident: { type: 'cool_partition', target }, destructive: false }
          : { label: 'Send a hot key here', incident: { type: 'hot_partition', target, value: 0.6 }, destructive: true },
      );
    }
    return { title: target, rows, actions };
  }
}
