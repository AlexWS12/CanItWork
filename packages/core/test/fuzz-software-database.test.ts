import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../src';
import type { DatabaseSpec } from '../src/domains/database/schema';
import type { SystemSpec } from '../src/domains/software/schema';

// Thousands of random designs, including broken ones, through everything a design meets after the Architect: the checks, the
// mend, a run with every incident the domain hypothesises, and every recovery option. Nothing may throw, produce NaN, or leave
// a mended design worse than it was.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = ReturnType<typeof rng>;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rand, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
const chance = (r: Rand, p: number) => r() < p;

const KINDS = ['gateway', 'service', 'service', 'service', 'database', 'cache', 'queue', 'external'] as const;
// Latencies a real design would give each kind, in milliseconds: a 300 ms cache makes every chain time out, which no mend can fix.
const LATENCY: Record<(typeof KINDS)[number], [number, number]> = {
  gateway: [1, 10],
  service: [5, 80],
  database: [2, 40],
  cache: [1, 5],
  queue: [1, 10],
  external: [40, 400],
};

function randomSystem(r: Rand): SystemSpec {
  const n = int(r, 2, 14);
  const zones = chance(r, 0.3) ? ['a', 'b', 'c'].slice(0, int(r, 1, 3)) : [];
  const nodes: SystemSpec['nodes'] = [{ id: 'users', kind: 'client' }];
  for (let i = 1; i < n; i++) {
    const kind = pick(r, KINDS);
    nodes.push({
      id: `${kind}${i}`,
      label: chance(r, 0.7) ? `${kind} ${i}` : undefined,
      kind,
      replicas: chance(r, 0.7) ? int(r, 1, 8) : undefined,
      capacity: chance(r, 0.4) ? int(r, 20, 3000) : undefined,
      latency: chance(r, 0.3) ? int(r, ...LATENCY[kind]) : undefined,
      zones: zones.length && chance(r, 0.7) ? zones.slice(0, int(r, 1, zones.length)) : undefined,
    });
  }
  const edges: SystemSpec['edges'] = [];
  // Mostly forward edges, so most designs are valid; a few backward ones make loops.
  for (let i = 1; i < nodes.length; i++) edges.push({ from: nodes[int(r, 0, i - 1)].id, to: nodes[i].id, mode: nodes[i].kind === 'queue' ? 'async' : undefined });
  for (let k = int(r, 0, 4); k > 0; k--) {
    const a = int(r, 0, nodes.length - 1);
    const b = int(r, 0, nodes.length - 1);
    if (a !== b) edges.push({ from: nodes[a].id, to: nodes[b].id, calls: chance(r, 0.2) ? int(r, 1, 3) : undefined, optional: chance(r, 0.2) || undefined });
  }
  return { traffic: int(r, 1, 30000), retries: int(r, 0, 3), nodes, edges };
}

const TYPES = ['int', 'bigint', 'uuid', 'text', 'decimal', 'bool', 'timestamp'] as const;

function randomSchema(r: Rand): DatabaseSpec {
  const names = ['users', 'orders', 'items', 'events', 'accounts', 'posts', 'tags', 'payments', 'logs', 'devices'].slice(0, int(r, 1, 10));
  const tables: DatabaseSpec['tables'] = names.map((name) => {
    const columns: DatabaseSpec['tables'][number]['columns'] = [{ name: 'id', type: pick(r, ['bigint', 'uuid', 'int'] as const), primary: chance(r, 0.9) || undefined }];
    for (let c = int(r, 0, 5); c > 0; c--) columns.push({ name: `c${c}`, type: pick(r, TYPES), unique: chance(r, 0.1) || undefined });
    return { name, rows: int(r, 0, 1) ? int(r, 10, 1e9) : 0, columns, indexes: [] };
  });
  for (const t of tables) {
    // Foreign keys: usually right, sometimes the wrong type, a missing column or a missing table.
    for (let k = int(r, 0, 2); k > 0; k--) {
      const parent = pick(r, tables);
      const broken = r();
      t.columns.push({
        name: `${parent.name}_ref${k}`,
        type: broken < 0.15 ? 'text' : parent.columns[0].type,
        references: {
          table: broken > 0.92 ? 'missing' : parent.name,
          column: broken > 0.85 && broken <= 0.92 ? 'nope' : 'id',
          onDelete: pick(r, ['cascade', 'restrict', 'set_null'] as const),
        },
      });
    }
    for (let k = int(r, 0, 2); k > 0; k--) t.indexes.push(chance(r, 0.85) ? [pick(r, t.columns).name] : ['missing']);
    if (chance(r, 0.2)) {
      t.partitions = int(r, 2, 16);
      if (chance(r, 0.7)) t.partitionBy = chance(r, 0.85) ? pick(r, t.columns).name : 'missing';
    }
  }
  const workload: DatabaseSpec['workload'] = [];
  for (let k = int(r, 0, 6); k > 0; k--) {
    const t = chance(r, 0.95) ? pick(r, tables) : { name: 'missing', columns: [{ name: 'id' }] };
    const other = pick(r, tables);
    workload.push({
      name: `q${k}`,
      kind: chance(r, 0.7) ? 'read' : 'write',
      table: t.name,
      where: chance(r, 0.7) ? [chance(r, 0.9) ? pick(r, t.columns).name : 'missing'] : [],
      joins: chance(r, 0.3) ? [{ table: other.name, local: pick(r, t.columns).name, foreign: chance(r, 0.9) ? 'id' : 'missing' }] : [],
      perSecond: int(r, 1, 20000),
    });
  }
  return { tables, workload, replicas: chance(r, 0.3) ? int(r, 0, 4) : undefined };
}

// A shown value must be a real number, or text with no NaN, undefined or Infinity in it.
const shown = (v: string | number) => (typeof v === 'number' ? Number.isFinite(v) : !/NaN|undefined|Infinity/.test(v));
// An error outweighs any number of warnings: the checks stop at some errors (a loop), so mending one can reveal warnings behind it.
const badness = (issues: Array<{ severity: string; repair?: boolean }>) => issues.reduce((sum, i) => sum + (i.severity === 'error' ? 1000 : i.repair ? 1 : 0), 0);

const mends = { better: 0, notBetter: 0 };

function exercise(id: 'software' | 'database', spec: unknown, seed: number) {
  const domain = DOMAINS[id];
  const parsed = domain.specSchema.safeParse(spec);
  if (!parsed.success) return 'unparsed';
  let current = parsed.data;
  const issues = domain.validate(domain.compile(current));
  const mended = domain.rules.mend?.(current, issues, []);
  if (mended) {
    const after = domain.validate(domain.compile(mended.spec));
    const errors = (xs: typeof after) => xs.filter((i) => i.severity === 'error').length;
    // A mend never adds an error. It can leave more warnings, such as a retry storm that capacity alone can't settle; the
    // pipeline keeps a mend only when it leaves fewer problems, so those are dropped there.
    expect(errors(after), JSON.stringify({ seed, before: issues, after })).toBeLessThanOrEqual(errors(issues));
    expect(domain.specSchema.safeParse(mended.spec).success).toBe(true);
    if (badness(after) < badness(issues)) {
      mends.better++;
      current = mended.spec;
    } else mends.notBetter++;
  }
  if (domain.validate(domain.compile(current)).some((i) => i.severity === 'error')) return 'invalid';
  const compiled = domain.compile(current);
  for (const hypothesis of domain.rules.hypotheses(current)) {
    const run = domain.createRun(compiled, seed);
    for (let i = 0; i < 20; i++) run.step();
    run.inject(hypothesis.incident);
    for (let i = 0; i < 20; i++) run.step();
    for (const option of domain.rules.recoveries(current, hypothesis.incident)) {
      const patches = option.patches.filter((p) => domain.patchSchema.safeParse(p).success);
      expect(patches.length, `${option.title} has a patch the schema rejects`).toBe(option.patches.length);
      run.apply(patches);
      run.step();
    }
    const evaluation = run.evaluation();
    for (const metric of run.telemetry()) {
      expect(shown(metric.value), `${metric.label} is ${metric.value} (seed ${seed})`).toBe(true);
      for (const row of metric.detail ?? []) expect(shown(row.value), `${metric.label}: ${row.label} is ${row.value} (seed ${seed})`).toBe(true);
    }
    for (const breakable of run.breakables()) {
      const target = breakable.incident.target ?? '';
      for (const [label, value] of run.inspect(target)?.rows ?? []) expect(shown(value), `${target} ${label} is ${value} (seed ${seed})`).toBe(true);
    }
    expect(evaluation).toBeTruthy();
  }
  // Everything a user can break from the scene, one after another on the same run.
  const run = domain.createRun(compiled, seed);
  for (const breakable of run.breakables()) {
    run.inject(breakable.incident);
    for (let i = 0; i < 5; i++) run.step();
  }
  for (const metric of run.telemetry()) expect(shown(metric.value), `${metric.label} is ${metric.value} after breaking everything (seed ${seed})`).toBe(true);
  return 'ran';
}

describe('random software and database designs', () => {
  for (const [id, make] of [
    ['software', randomSystem],
    ['database', randomSchema],
  ] as const) {
    it(`${id}: 1500 random designs check, mend, run, break and recover without throwing`, () => {
      const outcomes: Record<string, number> = {};
      mends.better = mends.notBetter = 0;
      for (let seed = 1; seed <= 1500; seed++) {
        const outcome = exercise(id, make(rng(seed)), seed);
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      }
      // Most random designs should come through runnable once mended, and nearly every mend should leave fewer problems.
      expect(outcomes.ran ?? 0, JSON.stringify(outcomes)).toBeGreaterThan(1000);
      expect(mends.better / (mends.better + mends.notBetter || 1), JSON.stringify(mends)).toBeGreaterThan(0.9);
    });
  }
});
