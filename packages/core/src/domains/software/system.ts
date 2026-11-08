import { SYSTEM, checkPatches, type Breakable, type Evaluation, type Incident, type Inspection, type Metric, type Point, type Run, type TimedEvent } from '../../domain';
import { money } from '../../cost';
import { createRng, type Rng } from '../../rng';
import { softwareCost } from './cost';
import { DEFAULT_CAPACITY, DEFAULT_LATENCY, SystemPatchSchema, replicaZones, zonesOf, type SystemEdge, type SystemNode, type SystemPatch, type SystemSpec } from './schema';

const TIMEOUT_MS = 1000;
const CACHE_HIT = 0.8;
const CACHE_WARMUP = 40;
const SERIES_STEP = 5;
/** A queue keeps about 15 s (at 8 ticks a second) of its traffic; older messages expire and their requests count as failed. */
const RETENTION_TICKS = 120;
// A breaker opens when its callee succeeds less than this, stays open this long (5 s), then lets a share through as a trial.
const BREAKER_TRIP = 0.5;
const BREAKER_COOLDOWN = 40;
const BREAKER_PROBE = 0.1;
const BREAKER_CLOSE = 0.9;
// Autoscaling adds replicas past 70% load, aiming for 60%; they take 3 s to boot. Below 30% it removes them, more slowly.
const SCALE_UP_AT = 0.7;
const SCALE_DOWN_AT = 0.3;
const SCALE_TARGET = 0.6;
const BOOT_TICKS = 24;

interface Breaker {
  open: boolean;
  probing: boolean;
  until: number;
}

export interface NodeState {
  /** What it admits past its rate limit; the rest of its inflow was turned away at once. */
  admitted: number;
  /** Share of its inflow it admitted last tick, which callers read to tell a 429 from a failure. */
  share: number;
  inflow: number;
  served: number;
  capacity: number;
  utilization: number;
  success: number;
  latency: number;
  backlog: number;
  down: boolean;
  degraded: number;
  /** Fraction of replicas whose zone is up. */
  alive: number;
}

/** Down by itself, or every replica sits in a zone that is down. */
export const isOut = (state: NodeState) => state.down || state.alive === 0;

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
  readonly downZones = new Set<string>();
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
  /** Queued messages that waited past retention, so their requests never really completed. */
  expired = 0;
  private added = 0;

  constructor(spec: SystemSpec, seed: number) {
    this.spec = structuredClone(spec);
    this.rng = createRng(seed);
    for (const node of this.spec.nodes) this.states.set(node.id, this.blank());
    this.order = topoOrder(this.spec);
    this.refreshZones();
  }

  private blank(): NodeState {
    return { admitted: 0, share: 1, inflow: 0, served: 0, capacity: 0, utilization: 0, success: 1, latency: 0, backlog: 0, down: false, degraded: 1, alive: 1 };
  }

  private refreshZones() {
    for (const node of this.spec.nodes) {
      const state = this.states.get(node.id);
      if (!state) continue;
      const placed = replicaZones(node);
      state.alive = placed.length ? placed.filter((z) => !this.downZones.has(z)).length / placed.length : 1;
    }
  }

  zones() {
    return zonesOf(this.spec);
  }

  private node(id: string) {
    return this.spec.nodes.find((n) => n.id === id);
  }

  private capacityOf(node: SystemNode, state: NodeState) {
    if (isOut(state)) return 0;
    return (node.replicas ?? 1) * (node.capacity ?? DEFAULT_CAPACITY[node.kind]) * state.degraded * state.alive;
  }

  private hitRatio(node: SystemNode) {
    if (node.kind !== 'cache') return 0;
    const cold = this.coldUntil.get(node.id);
    if (cold === undefined || this.tick >= cold) return CACHE_HIT;
    return CACHE_HIT * (1 - (cold - this.tick) / CACHE_WARMUP);
  }

  /** Circuit breakers by call, and the counts the scoreboard shows. */
  readonly breakers = new Map<string, Breaker>();
  trips = 0;
  rejected = 0;
  scaledUp = 0;
  /** Replicas booting for an autoscaled node, and when they're ready; and the replicas each autoscaled node started with. */
  private booting = new Map<string, { replicas: number; at: number }>();
  private floor = new Map<string, number>();

  private breakerOf(e: SystemEdge) {
    if (!e.breaker) return null;
    const key = edgeKey(e);
    if (!this.breakers.has(key)) this.breakers.set(key, { open: false, probing: false, until: 0 });
    return this.breakers.get(key)!;
  }

  // Each tick an autoscaled node finishes booting what it asked for, or asks for more (or fewer) from last tick's load.
  private autoscale() {
    for (const node of this.spec.nodes) {
      if (!node.autoscale) continue;
      const state = this.states.get(node.id)!;
      if (!this.floor.has(node.id)) this.floor.set(node.id, node.replicas ?? 1);
      const replicas = node.replicas ?? 1;
      const pending = this.booting.get(node.id);
      if (pending) {
        if (this.tick >= pending.at) {
          if (pending.replicas > replicas) this.scaledUp += pending.replicas - replicas;
          node.replicas = pending.replicas;
          this.booting.delete(node.id);
        }
        continue;
      }
      if (isOut(state)) continue;
      const max = Math.max(node.autoscale.max, this.floor.get(node.id)!);
      const wanted = Math.ceil((replicas * state.utilization) / SCALE_TARGET);
      if (state.utilization > SCALE_UP_AT && replicas < max) this.booting.set(node.id, { replicas: Math.min(max, wanted), at: this.tick + BOOT_TICKS });
      else if (state.utilization < SCALE_DOWN_AT && replicas > this.floor.get(node.id)!)
        this.booting.set(node.id, { replicas: Math.max(this.floor.get(node.id)!, wanted), at: this.tick + BOOT_TICKS * 2 });
    }
  }

  // After a tick, each breaker looks at how its callee did: trip on failures, wait out the pause, then close on a good trial.
  private updateBreakers() {
    for (const e of this.spec.edges) {
      const breaker = this.breakerOf(e);
      if (!breaker) continue;
      const success = this.states.get(e.to)?.success ?? 1;
      if (!breaker.open) {
        if (success < BREAKER_TRIP) {
          Object.assign(breaker, { open: true, probing: false, until: this.tick + BREAKER_COOLDOWN });
          this.trips++;
        }
      } else if (!breaker.probing) {
        if (this.tick >= breaker.until) breaker.probing = true;
      } else if (success >= BREAKER_CLOSE) Object.assign(breaker, { open: false, probing: false });
      else Object.assign(breaker, { probing: false, until: this.tick + BREAKER_COOLDOWN });
    }
  }

  step() {
    this.autoscale();
    for (const state of this.states.values()) state.inflow = 0;
    this.flows.clear();
    const jitter = 0.97 + this.rng.next() * 0.06;
    let total = 0;
    let expiredNow = 0;
    let rejectedNow = 0;

    for (const id of this.order) {
      const node = this.node(id);
      const state = this.states.get(id);
      if (!node || !state) continue;
      if (node.kind === 'client') state.inflow = this.spec.traffic * this.trafficFactor * jitter;
      total += state.inflow;
      const out = this.spec.edges.filter((e) => e.from === id);
      state.capacity = this.capacityOf(node, state);

      if (node.kind === 'queue') {
        state.served = isOut(state) ? 0 : state.inflow;
        state.backlog += state.served;
        const consumers = out.reduce((sum, e) => {
          const target = this.node(e.to);
          const targetState = this.states.get(e.to);
          return sum + (target && targetState && !this.cut.has(edgeKey(e)) ? this.capacityOf(target, targetState) : 0);
        }, 0);
        const drained = Math.min(state.backlog, consumers);
        state.backlog -= drained;
        // A dead or swamped consumer can't hide behind the queue for ever: work past the retention window expires.
        const kept = state.served * RETENTION_TICKS;
        if (state.served > 0 && state.backlog > kept) {
          expiredNow += state.backlog - kept;
          state.backlog = kept;
        }
        for (const e of out) {
          const flow = out.length ? drained / out.length : 0;
          this.flows.set(edgeKey(e), flow);
          const target = this.states.get(e.to);
          if (target) target.inflow += flow;
        }
        continue;
      }

      // A rate limit turns the excess away before it costs anything, so what it admits is all the node and those behind it see.
      state.admitted = node.rateLimit ? Math.min(state.inflow, node.rateLimit) : state.inflow;
      rejectedNow += state.inflow - state.admitted;
      state.share = state.inflow > 0 ? state.admitted / state.inflow : 1;
      state.served = Math.min(state.admitted, state.capacity);
      const pass = 1 - this.hitRatio(node);
      for (const e of out) {
        if (this.cut.has(edgeKey(e))) {
          this.flows.set(edgeKey(e), 0);
          continue;
        }
        const base = state.served * (e.calls ?? 1) * pass;
        const sync = (e.mode ?? 'sync') === 'sync';
        // Callers back off from a 429, so only the callee's other failures are retried, not what its rate limit turned away.
        const callee = this.states.get(e.to);
        const admittedShare = callee?.share ?? 1;
        const lastSuccess = callee ? Math.min(1, admittedShare > 0 ? callee.success / admittedShare : 1) : 1;
        // An open breaker sends nothing (a trial share while it probes) and nothing is retried through it.
        const breaker = this.breakerOf(e);
        const flow = breaker?.open ? (breaker.probing ? base * BREAKER_PROBE : 0) : base + (sync ? base * this.spec.retries * (1 - lastSuccess) : 0);
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
      const out = isOut(state);
      const load = node.kind === 'queue' ? state.inflow : state.admitted;
      state.utilization = state.capacity === Infinity || !state.capacity ? (out ? 1 : 0) : load / state.capacity;
      if (node.kind === 'queue') {
        state.success = out ? 0 : 1;
        state.latency = out ? TIMEOUT_MS : base;
        continue;
      }
      if (out) {
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
        // Behind an open breaker the call fails at once: no waiting on the callee, though a required call still fails.
        const breaker = this.breakerOf(e);
        if (breaker?.open && !breaker.probing) {
          if (!e.optional) downstream = 0;
          continue;
        }
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
    // Requests whose queued work expired failed too, even though the caller got an answer at the time.
    this.expired += expiredNow;
    this.rejected += rejectedNow;
    this.updateBreakers();
    this.success = Math.max(0, clients.reduce((sum, s) => sum + s.success * s.inflow, 0) / offered - expiredNow / offered);
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
      case 'zone_down':
        this.downZones.add(target);
        break;
      case 'recover':
        if (state) {
          state.down = false;
          state.degraded = 1;
        }
        this.cut.delete(target);
        this.downZones.delete(target);
        if (!target) this.trafficFactor = 1;
        break;
    }
    this.refreshZones();
  }

  apply(patches: unknown[]) {
    this.log.push({ at: this.tick, patches });
    for (const patch of patches as SystemPatch[]) this.applyPatch(patch);
    this.order = topoOrder(this.spec);
    this.refreshZones();
  }

  check(patches: unknown[]) {
    return checkPatches(SystemPatchSchema, patches, (patch: SystemPatch) => {
      const id = 'node' in patch ? patch.node : patch.op === 'add_cache' ? patch.before : null;
      if (id !== null && !this.node(id)) return `There is no ${id} here.`;
      if (patch.op === 'add_cache') {
        const node = this.node(patch.before)!;
        if (node.kind === 'client' || node.kind === 'cache' || node.kind === 'queue') return `A cache can't go in front of a ${node.kind}.`;
        if (this.spec.edges.some((e) => e.to === node.id && this.node(e.from)?.kind === 'cache')) return `There is already a cache in front of ${node.label ?? node.id}.`;
      }
      if ((patch.op === 'make_optional' || patch.op === 'add_queue') && !this.spec.edges.some((e) => e.from === patch.from && e.to === patch.to))
        return `There is no call from ${patch.from} to ${patch.to}.`;
      return null;
    });
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
      case 'add_zone': {
        const node = this.node(patch.node);
        if (!node || node.zones?.includes(patch.zone)) break;
        node.zones = [...(node.zones ?? []), patch.zone];
        node.replicas = Math.max(node.replicas ?? 1, node.zones.length);
        break;
      }
      case 'add_breaker': {
        const edge = this.spec.edges.find((e) => e.from === patch.from && e.to === patch.to);
        if (edge) edge.breaker = true;
        break;
      }
      case 'rate_limit': {
        const node = this.node(patch.node);
        if (node && node.kind !== 'client') node.rateLimit = patch.rps;
        break;
      }
      case 'autoscale': {
        const node = this.node(patch.node);
        if (node && node.kind !== 'client') node.autoscale = { max: patch.max };
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
        ...(this.expired >= 0.5 ? [{ label: 'messages expired', value: Math.round(this.expired) }] : []),
        ...(this.rejected >= 0.5 ? [{ label: 'requests rate-limited', value: Math.round(this.rejected) }] : []),
        ...(this.trips ? [{ label: 'breaker trips', value: this.trips }] : []),
        ...(this.scaledUp ? [{ label: 'replicas autoscaled', value: this.scaledUp }] : []),
        { label: 'monthly cost', value: money(this.cost().usd) },
      ],
      series: this.series,
    };
  }

  telemetry(): Metric[] {
    const pct = Math.round(this.success * 1000) / 10;
    const down = [...this.states.values()].filter(isOut).length;
    const backlog = [...this.states.values()].reduce((sum, s) => sum + s.backlog, 0);
    return [
      { label: 'requests succeeding', value: `${pct}%`, tone: pct < 90 ? 'danger' : pct < 99 ? 'warn' : undefined },
      { label: 'latency', value: `${Math.round(this.latency)} ms`, tone: this.latency > 500 ? 'warn' : undefined },
      { label: 'queue backlog', value: Math.round(backlog), tone: backlog > 1000 ? 'warn' : undefined },
      { label: 'services down', value: down, tone: down ? 'danger' : undefined },
      ...this.resilience(),
      this.costMetric(),
    ];
  }

  /** The month's cost of the system as it runs now: replicas autoscaling and fixes move it, and so does traffic through queues and APIs. */
  cost() {
    return softwareCost(this.spec, (id) => this.states.get(id)?.inflow ?? 0);
  }

  private costMetric(): Metric {
    const cost = this.cost();
    return {
      label: 'monthly cost',
      value: money(cost.usd),
      detail: [
        ...cost.lines.slice(0, 6).map((l) => ({ label: l.label, value: money(l.usd) })),
        ...(cost.ceiling ? [{ label: 'at full autoscale', value: money(cost.ceiling) }] : []),
      ],
    };
  }

  /** Breakers, rate limits and autoscaling, shown only for a design that has them. */
  private resilience(): Metric[] {
    const out: Metric[] = [];
    if (this.spec.edges.some((e) => e.breaker)) {
      const open = [...this.breakers.values()].filter((b) => b.open).length;
      out.push({ label: 'breakers open', value: open, tone: open ? 'warn' : undefined });
    }
    if (this.spec.nodes.some((n) => n.rateLimit)) {
      const now = [...this.states.values()].reduce((sum, s) => sum + Math.max(0, s.inflow - s.admitted), 0);
      out.push({ label: 'rate-limited', value: `${Math.round(now)} rps`, tone: now >= 1 ? 'warn' : undefined });
    }
    const scaled = this.spec.nodes.filter((n) => n.autoscale);
    if (scaled.length) {
      const extra = scaled.reduce((sum, n) => sum + (n.replicas ?? 1) - (this.floor.get(n.id) ?? n.replicas ?? 1), 0);
      out.push({ label: 'autoscaled replicas', value: `+${extra}${this.booting.size ? ' (booting)' : ''}` });
    }
    return out;
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
    const zone = this.busiestZone();
    if (zone)
      out.push({ label: `Lose ${zone}`, incident: { type: 'zone_down', target: zone }, keywords: ['zone', 'region', 'outage', 'data center', 'datacenter', zone.toLowerCase()] });
    add(live.find((n) => n.kind === 'external') ?? live.filter((n) => n.kind === 'service')[1], 'Slow', 'node_slow', 5);
    if (!zone)
      add(
        live.find((n) => n.kind === 'cache'),
        'Flush',
        'cache_flush',
      );
    out.push({ label: 'Traffic ×3', incident: { type: 'traffic_spike', value: 3 }, keywords: ['traffic', 'spike', 'surge', 'load', 'double'] });
    return out.slice(0, 5);
  }

  /** The live zone running the most replicas, or null when the design uses fewer than two zones. */
  busiestZone(): string | null {
    const zones = this.zones().filter((z) => !this.downZones.has(z));
    if (zones.length + this.downZones.size < 2 || !zones.length) return null;
    const count = (z: string) => this.spec.nodes.reduce((sum, n) => sum + replicaZones(n).filter((r) => r === z).length, 0);
    return zones.reduce((best, z) => (count(z) > count(best) ? z : best));
  }

  /**
   * A database opened as a schema of its own: the request names the services that call it, so the tables fit what they
   * store, and the load it carries now, so the schema's workload matches the traffic this design sends it.
   */
  private schemaDrill(node: SystemNode, state: NodeState): NonNullable<Inspection['drill']> {
    const name = node.label ?? node.id;
    const callers = this.spec.edges
      .filter((e) => e.to === node.id)
      .map((e) => this.node(e.from))
      .filter((n): n is SystemNode => Boolean(n) && n!.kind !== 'client')
      .map((n) => n.label ?? n.id);
    const rps = Math.max(1, Math.round(state.inflow || state.served || 1));
    const used = callers.length ? `, used by ${callers.slice(0, 4).join(', ')},` : '';
    return {
      label: 'Open its schema',
      prompt: `The database schema behind ${name}${used} with tables, keys and indexes for what those services store, and a query workload of about ${rps} queries per second in total`,
      node: node.id,
      rps,
    };
  }

  inspect(target: string): Inspection | null {
    if (target === SYSTEM) {
      return {
        title: 'System settings',
        rows: [
          ['Services', this.spec.nodes.length],
          ['Traffic', `${Math.round(this.spec.traffic)} rps`],
        ],
        actions: [],
        settings: [
          {
            kind: 'number',
            label: 'Retries',
            hint: 'How often a failed call is tried again. More retries ride out blips but pile load on a struggling service.',
            value: this.spec.retries,
            min: 0,
            max: 5,
            step: 1,
            unit: '',
            patch: { op: 'set_retries' },
            key: 'retries',
          },
        ],
      };
    }
    const node = this.node(target);
    const state = this.states.get(target);
    if (!node || !state) return null;
    const broken = state.down || state.degraded !== 1;
    const lostZones = (node.zones ?? []).filter((z) => this.downZones.has(z));
    const status = state.down
      ? 'Down'
      : state.alive === 0
        ? 'Zone down'
        : state.degraded !== 1
          ? 'Degraded'
          : state.alive < 1
            ? `${Math.round(state.alive * 100)}% of replicas up`
            : 'Up';
    const rows: Array<[string, string | number]> = [
      ['Kind', node.kind],
      ['Status', status],
      ['Replicas', node.replicas ?? 1],
      ['Load', `${Math.round(state.inflow)} rps`],
      ['Utilization', `${Math.round(state.utilization * 100)}%`],
      ['Success', `${Math.round(state.success * 1000) / 10}%`],
      ['Latency', `${Math.round(state.latency)} ms`],
    ];
    if (node.kind === 'queue') rows.push(['Backlog', Math.round(state.backlog)]);
    if (node.zones?.length) rows.push(['Zones', node.zones.map((z) => (this.downZones.has(z) ? `${z} (down)` : z)).join(', ')]);
    const restoreZones = lostZones.map((z) => ({ label: `Restore ${z}`, incident: { type: 'recover', target: z }, destructive: false }));
    if (node.kind === 'client') return { title: node.label ?? node.id, rows, actions: restoreZones };
    const replicas = node.replicas ?? 1;
    const cacheable = node.kind !== 'cache' && node.kind !== 'queue' && !this.check([{ op: 'add_cache', before: node.id }]);
    return {
      title: node.label ?? node.id,
      rows,
      settings: [
        {
          kind: 'number',
          label: 'Replicas',
          hint: 'Copies sharing its load.',
          value: replicas,
          min: Math.max(1, node.zones?.length ?? 1),
          max: Math.min(50, Math.max(10, replicas * 3)),
          step: 1,
          unit: '',
          patch: { op: 'scale', node: node.id },
          key: 'replicas',
        },
      ],
      edits: cacheable ? [{ label: 'Put a cache in front', patches: [{ op: 'add_cache', before: node.id }] }] : [],
      ...(node.kind === 'database' ? { drill: this.schemaDrill(node, state) } : {}),
      actions: broken
        ? [{ label: 'Restore', incident: { type: 'recover', target }, destructive: false }, ...restoreZones]
        : [
            ...restoreZones,
            { label: 'Take it down', incident: { type: 'node_down', target }, destructive: true },
            { label: 'Slow it down', incident: { type: 'node_slow', target, value: 5 }, destructive: true },
          ],
    };
  }
}
