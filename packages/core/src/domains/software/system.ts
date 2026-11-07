import type { Breakable, Evaluation, Incident, Inspection, Metric, Point, Run, TimedEvent } from '../../domain';
import { createRng, type Rng } from '../../rng';
import { DEFAULT_CAPACITY, DEFAULT_LATENCY, type SystemEdge, type SystemNode, type SystemPatch, type SystemSpec } from './schema';

const TIMEOUT_MS = 1000;
const CACHE_HIT = 0.8;
const CACHE_WARMUP = 40;
const SERIES_STEP = 5;

export interface NodeState {
  inflow: number;
  served: number;
  capacity: number;
  utilization: number;
  success: number;
  latency: number;
  backlog: number;
  down: boolean;
  degraded: number;
}

export const edgeKey = (e: Pick<SystemEdge, 'from' | 'to'>) => `${e.from}->${e.to}`;

export function topoOrder(spec: SystemSpec) {
  const indegree = new Map(spec.nodes.map((n) => [n.id, 0]));
  for (const e of spec.edges) if (indegree.has(e.to)) indegree.set(e.to, indegree.get(e.to)! + 1);
  const ready = spec.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    order.push(id);
    for (const e of spec.edges.filter((edge) => edge.from === id)) {
      if (!indegree.has(e.to)) continue;
      indegree.set(e.to, indegree.get(e.to)! - 1);
      if (indegree.get(e.to) === 0) ready.push(e.to);
    }
  }
  return order;
}

export class SystemRun implements Run {
  readonly log: TimedEvent[] = [];
  readonly spec: SystemSpec;
  readonly states = new Map<string, NodeState>();
  readonly flows = new Map<string, number>();
  readonly cut = new Set<string>();
  tick = 0;
  success = 1;
  latency = 0;
  amplification = 1;

  private order: string[] = [];
  private rng: Rng;
  private trafficFactor = 1;
  private coldUntil = new Map<string, number>();
  private series: Point[] = [];
  private scoreSum = 0;
  private failed = 0;
  private added = 0;

  constructor(spec: SystemSpec, seed: number) {
    this.spec = structuredClone(spec);
    this.rng = createRng(seed);
    for (const node of this.spec.nodes) this.states.set(node.id, this.blank());
    this.order = topoOrder(this.spec);
  }

  private blank(): NodeState {
    return { inflow: 0, served: 0, capacity: 0, utilization: 0, success: 1, latency: 0, backlog: 0, down: false, degraded: 1 };
  }

  private node(id: string) {
    return this.spec.nodes.find((n) => n.id === id);
  }

  private capacityOf(node: SystemNode, state: NodeState) {
    if (state.down) return 0;
    return (node.replicas ?? 1) * (node.capacity ?? DEFAULT_CAPACITY[node.kind]) * state.degraded;
  }

  private hitRatio(node: SystemNode) {
    if (node.kind !== 'cache') return 0;
    const cold = this.coldUntil.get(node.id);
    if (cold === undefined || this.tick >= cold) return CACHE_HIT;
    return CACHE_HIT * (1 - (cold - this.tick) / CACHE_WARMUP);
  }

  step() {
    for (const state of this.states.values()) state.inflow = 0;
    this.flows.clear();
    const jitter = 0.97 + this.rng.next() * 0.06;
    let total = 0;

    for (const id of this.order) {
      const node = this.node(id);
      const state = this.states.get(id);
      if (!node || !state) continue;
      if (node.kind === 'client') state.inflow = this.spec.traffic * this.trafficFactor * jitter;
      total += state.inflow;
      const out = this.spec.edges.filter((e) => e.from === id);
      state.capacity = this.capacityOf(node, state);

      if (node.kind === 'queue') {
        state.served = state.down ? 0 : state.inflow;
        state.backlog += state.served;
        const consumers = out.reduce((sum, e) => {
          const target = this.node(e.to);
          const targetState = this.states.get(e.to);
          return sum + (target && targetState && !this.cut.has(edgeKey(e)) ? this.capacityOf(target, targetState) : 0);
        }, 0);
        const drained = Math.min(state.backlog, consumers);
        state.backlog -= drained;
        for (const e of out) {
          const flow = out.length ? drained / out.length : 0;
          this.flows.set(edgeKey(e), flow);
          const target = this.states.get(e.to);
          if (target) target.inflow += flow;
        }
        continue;
      }

      state.served = Math.min(state.inflow, state.capacity);
      const pass = 1 - this.hitRatio(node);
      for (const e of out) {
        if (this.cut.has(edgeKey(e))) {
          this.flows.set(edgeKey(e), 0);
          continue;
        }
        const base = state.served * (e.calls ?? 1) * pass;
        const sync = (e.mode ?? 'sync') === 'sync';
        const lastSuccess = this.states.get(e.to)?.success ?? 1;
        const flow = base + (sync ? base * this.spec.retries * (1 - lastSuccess) : 0);
        this.flows.set(edgeKey(e), flow);
        const target = this.states.get(e.to);
        if (target) target.inflow += flow;
      }
    }

    for (const id of [...this.order].reverse()) {
      const node = this.node(id);
      const state = this.states.get(id);
      if (!node || !state) continue;
      const base = (node.latency ?? DEFAULT_LATENCY[node.kind]) / state.degraded;
      state.utilization = state.capacity === Infinity || !state.capacity ? (state.down ? 1 : 0) : state.inflow / state.capacity;
      if (node.kind === 'queue') {
        state.success = state.down ? 0 : 1;
        state.latency = state.down ? TIMEOUT_MS : base;
        continue;
      }
      if (state.down) {
        state.success = 0;
        state.latency = TIMEOUT_MS;
        continue;
      }
      const own = state.inflow > 0 ? state.served / state.inflow : 1;
      const hit = this.hitRatio(node);
      let downstream = 1;
      let latency = base / (1 - Math.min(state.utilization, 0.95));
      for (const e of this.spec.edges.filter((edge) => edge.from === id)) {
        if ((e.mode ?? 'sync') !== 'sync') continue;
        const dep = this.cut.has(edgeKey(e)) ? 0 : (this.states.get(e.to)?.success ?? 1);
        // A cache's failures are misses its own retries to the store behind it already covered;
        // retrying the cache misses again, so callers' retries add load but not success.
        const cached = this.node(e.to)?.kind === 'cache' && !this.cut.has(edgeKey(e));
        const withRetries = cached ? dep : 1 - Math.pow(1 - dep, this.spec.retries + 1);
        if (!e.optional) downstream *= withRetries;
        latency += (this.states.get(e.to)?.latency ?? 0) * (e.calls ?? 1) * (1 - hit);
      }
      let success = own * (hit + (1 - hit) * downstream);
      if (latency > TIMEOUT_MS) {
        success *= TIMEOUT_MS / latency;
        latency = TIMEOUT_MS;
      }
      state.success = success;
      state.latency = latency;
    }

    const clients = this.spec.nodes.filter((n) => n.kind === 'client').map((n) => this.states.get(n.id)!);
    const offered = clients.reduce((sum, s) => sum + s.inflow, 0) || 1;
    this.success = clients.reduce((sum, s) => sum + s.success * s.inflow, 0) / offered;
    this.latency = clients.reduce((sum, s) => sum + s.latency * s.inflow, 0) / offered;
    this.amplification = total / offered / Math.max(1, this.spec.nodes.length - 1);
    this.failed += offered * (1 - this.success);
    this.tick++;
    this.scoreSum += this.success * 100;
    if (this.tick % SERIES_STEP === 0) this.series.push({ t: this.tick, value: Math.round(this.success * 1000) / 10 });
  }

  inject(incident: Incident) {
    this.log.push({ at: this.tick, incident });
    const target = incident.target ?? '';
    const state = this.states.get(target);
    switch (incident.type) {
      case 'node_down':
        if (state) state.down = true;
        break;
      case 'node_slow':
        if (state) state.degraded = 1 / Math.max(1.5, incident.value ?? 5);
        break;
      case 'traffic_spike':
        this.trafficFactor = Math.max(1, incident.value ?? 3);
        break;
      case 'cut_link':
        this.cut.add(target);
        break;
      case 'cache_flush':
        this.coldUntil.set(target, this.tick + CACHE_WARMUP);
        break;
      case 'recover':
        if (state) {
          state.down = false;
          state.degraded = 1;
        }
        this.cut.delete(target);
        if (!target) this.trafficFactor = 1;
        break;
    }
  }

  apply(patches: unknown[]) {
    this.log.push({ at: this.tick, patches });
    for (const patch of patches as SystemPatch[]) this.applyPatch(patch);
    this.order = topoOrder(this.spec);
  }

  private applyPatch(patch: SystemPatch) {
    switch (patch.op) {
      case 'scale': {
        const node = this.node(patch.node);
        if (node) node.replicas = patch.replicas;
        break;
      }
      case 'failover': {
        const state = this.states.get(patch.node);
        if (state) {
          state.down = false;
          state.degraded = 0.6;
        }
        break;
      }
      case 'set_retries':
        this.spec.retries = patch.retries;
        break;
      case 'make_optional': {
        const edge = this.spec.edges.find((e) => e.from === patch.from && e.to === patch.to);
        if (edge) edge.optional = true;
        break;
      }
      case 'add_cache': {
        const id = `cache${++this.added}`;
        this.spec.nodes.push({ id, kind: 'cache', label: `${patch.before} cache` });
        this.states.set(id, this.blank());
        for (const e of this.spec.edges) if (e.to === patch.before) e.to = id;
        this.spec.edges.push({ from: id, to: patch.before, mode: 'sync' });
        break;
      }
      case 'add_queue': {
        const edge = this.spec.edges.find((e) => e.from === patch.from && e.to === patch.to);
        if (!edge) break;
        const id = `queue${++this.added}`;
        this.spec.nodes.push({ id, kind: 'queue', label: `${patch.to} queue` });
        this.states.set(id, this.blank());
        edge.to = id;
        edge.mode = 'async';
        this.spec.edges.push({ from: id, to: patch.to, mode: 'async' });
        break;
      }
    }
  }

  evaluation(): Evaluation {
    const backlog = [...this.states.values()].reduce((sum, s) => sum + s.backlog, 0);
    return {
      score: this.tick ? Math.round((this.scoreSum / this.tick) * 10) / 10 : 0,
      scoreLabel: '% of requests succeeding',
      metrics: [
        { label: 'requests failed', value: Math.round(this.failed) },
        { label: 'latency', value: `${Math.round(this.latency)} ms` },
        { label: 'queue backlog', value: Math.round(backlog) },
      ],
      series: this.series,
    };
  }

  telemetry(): Metric[] {
    const pct = Math.round(this.success * 1000) / 10;
    const down = [...this.states.values()].filter((s) => s.down).length;
    const backlog = [...this.states.values()].reduce((sum, s) => sum + s.backlog, 0);
    return [
      { label: 'requests succeeding', value: `${pct}%`, tone: pct < 90 ? 'danger' : pct < 99 ? 'warn' : undefined },
      { label: 'latency', value: `${Math.round(this.latency)} ms`, tone: this.latency > 500 ? 'warn' : undefined },
      { label: 'queue backlog', value: Math.round(backlog), tone: backlog > 1000 ? 'warn' : undefined },
      { label: 'services down', value: down, tone: down ? 'danger' : undefined },
    ];
  }

  breakables(): Breakable[] {
    const out: Breakable[] = [];
    const add = (node: SystemNode | undefined, verb: string, type: string, value?: number) => {
      if (node)
        out.push({
          label: `${verb} ${node.label ?? node.id}`,
          incident: { type, target: node.id, value },
          keywords: [node.id.toLowerCase(), (node.label ?? '').toLowerCase(), node.kind, verb.toLowerCase()].filter(Boolean),
        });
    };
    const live = this.spec.nodes.filter((n) => !this.states.get(n.id)?.down);
    add(
      live.find((n) => n.kind === 'database'),
      'Kill',
      'node_down',
    );
    add(
      live.find((n) => n.kind === 'service'),
      'Kill',
      'node_down',
    );
    add(live.find((n) => n.kind === 'external') ?? live.filter((n) => n.kind === 'service')[1], 'Slow', 'node_slow', 5);
    add(
      live.find((n) => n.kind === 'cache'),
      'Flush',
      'cache_flush',
    );
    out.push({ label: 'Traffic ×3', incident: { type: 'traffic_spike', value: 3 }, keywords: ['traffic', 'spike', 'surge', 'load', 'double'] });
    return out.slice(0, 5);
  }

  inspect(target: string): Inspection | null {
    const node = this.node(target);
    const state = this.states.get(target);
    if (!node || !state) return null;
    const broken = state.down || state.degraded !== 1;
    const rows: Array<[string, string | number]> = [
      ['Kind', node.kind],
      ['Status', state.down ? 'Down' : state.degraded !== 1 ? 'Degraded' : 'Up'],
      ['Replicas', node.replicas ?? 1],
      ['Load', `${Math.round(state.inflow)} rps`],
      ['Utilization', `${Math.round(state.utilization * 100)}%`],
      ['Success', `${Math.round(state.success * 1000) / 10}%`],
      ['Latency', `${Math.round(state.latency)} ms`],
    ];
    if (node.kind === 'queue') rows.push(['Backlog', Math.round(state.backlog)]);
    if (node.kind === 'client') return { title: node.label ?? node.id, rows, actions: [] };
    return {
      title: node.label ?? node.id,
      rows,
      actions: broken
        ? [{ label: 'Restore', incident: { type: 'recover', target }, destructive: false }]
        : [
            { label: 'Take it down', incident: { type: 'node_down', target }, destructive: true },
            { label: 'Slow it down', incident: { type: 'node_slow', target, value: 5 }, destructive: true },
          ],
    };
  }
}
