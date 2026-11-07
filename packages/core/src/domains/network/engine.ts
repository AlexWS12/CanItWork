import type { Breakable, DomainId, Evaluation, Incident, Inspection, Metric, Point, Run, TimedEvent } from '../../domain';
import { createRng, type Rng } from '../../rng';
import { linkKey, netOrder, type KindDef, type NetEdge, type NetNode, type NetPatch, type NetSpec, type Role } from './schema';

const SERIES_STEP = 5;
const TRIP_TICKS = 3;
const SMOOTHING = 0.15;
const EPS = 1e-6;
const BACKUP = 0.6;
const HEADROOM = 1.1;

export interface NetConfig {
  id: DomainId;
  kinds: Record<string, KindDef>;
  /**
   * flow: sources push arrivals; the score is how much of what arrives gets through.
   * demand: sinks ask for an amount each tick and sources dispatch to meet it; the score is demand served.
   */
  mode: 'flow' | 'demand';
  /** Links carry any flow but trip after a few ticks over capacity, so overloads cascade (power lines). */
  trips?: boolean;
  unit: string;
  scoreLabel: string;
  lostLabel: string;
  surge: { label: string; value: number; keywords: string[] };
  downVerb: string;
}

export interface NodeState {
  queue: number;
  inflow: number;
  served: number;
  capacity: number;
  utilization: number;
  demand: number;
  down: boolean;
  slow: number;
}

export interface LinkState {
  flow: number;
  down: boolean;
  tripped: boolean;
  overload: number;
  pipeline: number[];
}

export class NetRun implements Run {
  readonly log: TimedEvent[] = [];
  readonly spec: NetSpec;
  readonly states = new Map<string, NodeState>();
  readonly links = new Map<string, LinkState>();
  tick = 0;
  /** Share of demand (or arrivals) getting through right now. */
  ratio = 1;
  delivered = 0;
  lost = 0;
  /** Flow mode: everything that has arrived at a source since tick 0, for conservation checks. */
  arrived = 0;
  spike = 1;
  shedding = 0;

  private rng: Rng;
  private order: string[] = [];
  private need = new Map<string, number>();
  private held = new Map<string, number>();
  /** Demand mode: what each stage planned to receive this tick, and how much of it arrived recently (0.05-1). */
  private planned = new Map<string, number>();
  private fill = new Map<string, number>();
  private avgIn = 0;
  private avgOut = 0;
  private series: Point[] = [];
  private scoreSum = 0;

  constructor(
    readonly config: NetConfig,
    spec: NetSpec,
    seed: number,
  ) {
    this.spec = structuredClone(spec);
    this.rng = createRng(seed);
    for (const node of this.spec.nodes) this.states.set(node.id, this.blank());
    for (const edge of this.spec.edges) this.links.set(linkKey(edge), this.blankLink(edge));
    this.order = netOrder(this.spec);
    // Start in steady state, so tick 0 isn't scored while queues and pipelines fill.
    const warmup = 30 + 2 * Math.max(0, ...this.spec.edges.map((e) => e.delay ?? 0));
    for (let i = 0; i < warmup; i++) this.advance();
    this.delivered = 0;
    this.lost = 0;
    this.arrived = 0;
  }

  /** Everything in the network right now: queued, held for a next step, or in transit. */
  stock() {
    let total = 0;
    for (const node of this.spec.nodes) total += this.states.get(node.id)!.queue + this.heldAt(node.id);
    for (const link of this.links.values()) total += link.pipeline.reduce((a, b) => a + b, 0);
    return total;
  }

  private blank(): NodeState {
    return { queue: 0, inflow: 0, served: 0, capacity: 0, utilization: 0, demand: 0, down: false, slow: 1 };
  }

  private blankLink(edge: NetEdge): LinkState {
    return { flow: 0, down: false, tripped: false, overload: 0, pipeline: new Array(edge.delay ?? 0).fill(0) };
  }

  node(id: string) {
    return this.spec.nodes.find((n) => n.id === id);
  }

  role(node: NetNode): Role {
    return this.config.kinds[node.kind]?.role ?? 'stage';
  }

  name(node: NetNode) {
    return node.label ?? node.id;
  }

  capacityOf(node: NetNode) {
    const kind = this.config.kinds[node.kind];
    return (node.capacity ?? kind?.capacity ?? Infinity) * (node.count ?? 1);
  }

  private live(node: NetNode, state: NodeState) {
    return state.down ? 0 : this.capacityOf(node) * state.slow;
  }

  rateOf(node: NetNode) {
    return node.rate ?? this.config.kinds[node.kind]?.rate ?? 0;
  }

  bufferOf(node: NetNode) {
    return node.buffer ?? this.config.kinds[node.kind]?.buffer ?? 0;
  }

  private room(edge: NetEdge) {
    const link = this.links.get(linkKey(edge))!;
    const target = this.node(edge.to);
    const state = this.states.get(edge.to);
    if (link.down || !target || !state) return 0;
    const linkRoom = edge.capacity ? Math.max(0, edge.capacity - link.flow) : Infinity;
    const demand = this.config.mode === 'demand';
    if (edge.delay && !demand) return linkRoom;
    if (state.down) return 0;
    let targetRoom: number;
    if (this.role(target) === 'sink') targetRoom = demand ? Math.max(0, state.demand - state.queue) : Infinity;
    else targetRoom = demand ? (this.need.get(edge.to) ?? 0) : Math.max(0, this.bufferOf(target) + this.live(target, state) - state.queue - this.heldAt(edge.to));
    return Math.min(linkRoom, targetRoom);
  }

  /**
   * Demand mode: what each stage still wants this tick, worked back from the end points: enough to
   * cover its live downstream demand, plus whatever tops its storage back up, so nothing ships
   * power or goods nobody asked for.
   */
  private planNeed() {
    this.need.clear();
    for (const id of [...this.order].reverse()) {
      const node = this.node(id);
      const state = this.states.get(id);
      if (!node || !state || this.role(node) === 'source') continue;
      if (this.role(node) === 'sink') {
        this.need.set(id, state.demand);
        continue;
      }
      if (state.down) {
        this.need.set(id, 0);
        continue;
      }
      let downstream = 0;
      for (const e of this.spec.edges) {
        if (e.from !== id || this.links.get(linkKey(e))!.down) continue;
        downstream += Math.min(e.capacity ?? Infinity, (this.need.get(e.to) ?? 0) * this.share(e));
      }
      let inbound = 0;
      for (const e of this.spec.edges) if (e.to === id && e.delay) inbound += this.links.get(linkKey(e))!.pipeline.reduce((a, b) => a + b, 0);
      // The steady flow is always asked for; only the storage top-up counts what is already on the way.
      this.need.set(id, Math.min(this.live(node, state), downstream) + Math.max(0, this.bufferOf(node) - state.queue - inbound));
      this.planned.set(id, this.need.get(id)!);
    }
  }

  /**
   * Demand mode: each source generates what its own links are asked for, with headroom; whatever a
   * source can't cover is spread over the others' spare capacity.
   */
  private dispatch(sources: NetNode[]) {
    this.planNeed();
    const asked = new Map<string, number>();
    for (const e of this.spec.edges) {
      if (!sources.some((s) => s.id === e.from) || this.links.get(linkKey(e))!.down || this.states.get(e.from)!.down) continue;
      asked.set(e.from, (asked.get(e.from) ?? 0) + (this.need.get(e.to) ?? 0) * this.share(e) * HEADROOM);
    }
    let deficit = 0;
    let spare = 0;
    const give = new Map<string, number>();
    for (const node of sources) {
      const cap = this.live(node, this.states.get(node.id)!);
      const want = asked.get(node.id) ?? 0;
      give.set(node.id, Math.min(want, cap));
      deficit += Math.max(0, want - cap);
      spare += Math.max(0, cap - want);
    }
    for (const node of sources) {
      const state = this.states.get(node.id)!;
      const room = Math.max(0, this.live(node, state) - give.get(node.id)!);
      state.queue += give.get(node.id)! + (spare ? Math.min(room, (deficit * room) / spare) : 0);
    }
  }

  /**
   * This link's part of what its target needs, split over the target's live feeds by weight or rating,
   * scaled by how well each feed delivered last tick, so a starved substation's load moves to its neighbours.
   */
  private share(edge: NetEdge) {
    const weight = (e: NetEdge) => (e.weight ?? e.capacity ?? 1) * (this.fill.get(e.from) ?? 1);
    let total = 0;
    for (const e of this.spec.edges) {
      if (e.to !== edge.to || this.links.get(linkKey(e))!.down || this.states.get(e.from)?.down) continue;
      total += weight(e);
    }
    return total ? weight(edge) / total : 0;
  }

  private deliver(edge: NetEdge, amount: number) {
    const link = this.links.get(linkKey(edge))!;
    link.flow += amount;
    if (this.config.mode === 'demand' && this.need.has(edge.to)) this.need.set(edge.to, Math.max(0, this.need.get(edge.to)! - amount));
    if (edge.delay) {
      link.pipeline[link.pipeline.length - 1] += amount;
      return;
    }
    const state = this.states.get(edge.to)!;
    state.queue += amount;
    state.inflow += amount;
  }

  /** Offers work bound for one link to its target, then to open siblings of the same kind. */
  private offer(edge: NetEdge, amount: number) {
    let left = amount;
    const first = Math.min(left, this.room(edge));
    if (first > EPS) this.deliver(edge, first);
    left -= Math.max(0, first);
    if (left <= EPS) return amount;
    const kind = this.node(edge.to)?.kind;
    for (const e of this.spec.edges) {
      if (left <= EPS) break;
      if (e === edge || e.from !== edge.from || this.node(e.to)?.kind !== kind) continue;
      const flow = Math.min(left, this.room(e));
      if (flow > EPS) {
        this.deliver(e, flow);
        left -= flow;
      }
    }
    return amount - left;
  }

  /**
   * Flow mode: finished work keeps its destination. Work a full target refuses waits at this node,
   * bound for that link (a patient boarding in the ER for a ward bed), and is offered first next tick,
   * so it never leaks into a different step such as discharge.
   */
  private pushFlow(node: NetNode, amount: number) {
    const outs = this.spec.edges.filter((e) => e.from === node.id);
    for (const e of outs) {
      const key = linkKey(e);
      const waiting = this.held.get(key) ?? 0;
      if (waiting > EPS) this.held.set(key, waiting - this.offer(e, waiting));
    }
    const open = outs.filter((e) => !this.links.get(linkKey(e))!.down);
    if (!open.length || amount <= EPS) return 0;
    const total = open.reduce((sum, e) => sum + (e.weight ?? 1), 0);
    let sent = 0;
    for (const e of open) {
      const share = (amount * (e.weight ?? 1)) / total;
      const moved = this.offer(e, share);
      sent += moved;
      if (share - moved > EPS) this.held.set(linkKey(e), (this.held.get(linkKey(e)) ?? 0) + share - moved);
    }
    return sent;
  }

  /** Arrivals a source can't hand on or hold are turned away: diverted ambulances, abandoned calls. */
  private turnAway(node: NetNode, state: NodeState) {
    let over = state.queue + this.heldAt(node.id) - this.bufferOf(node);
    if (over <= EPS) return;
    this.lost += over;
    for (const e of this.spec.edges) {
      if (e.from !== node.id || over <= EPS) continue;
      const key = linkKey(e);
      const cut = Math.min(over, this.held.get(key) ?? 0);
      this.held.set(key, (this.held.get(key) ?? 0) - cut);
      over -= cut;
    }
    state.queue = Math.max(0, state.queue - over);
  }

  /** Work finished at a node but stuck waiting for its next step. */
  heldAt(id: string) {
    let total = 0;
    for (const e of this.spec.edges) if (e.from === id) total += this.held.get(linkKey(e)) ?? 0;
    return total;
  }

  /**
   * Demand mode: splits supply over open links by weight. What a full target refuses is offered only
   * to targets of the same kind (another feeder), never to a different kind of step.
   */
  private push(node: NetNode, amount: number) {
    const outs = this.spec.edges.filter((e) => e.from === node.id && !this.links.get(linkKey(e))?.down);
    const kindOf = (e: NetEdge) => this.node(e.to)?.kind;
    let left = amount;
    let spill: Set<string | undefined> | null = null;
    for (let pass = 0; pass < 3 && left > EPS; pass++) {
      const candidates = spill ? outs.filter((e) => spill!.has(kindOf(e))) : outs;
      const open = candidates.map((e) => ({ e, room: this.room(e) })).filter((o) => o.room > EPS);
      if (!open.length) break;
      const total = candidates.reduce((sum, e) => sum + (e.weight ?? 1), 0);
      const offered = spill ? open.reduce((sum, o) => sum + (o.e.weight ?? 1), 0) : total;
      const refused = new Set<string | undefined>();
      let moved = 0;
      for (const { e, room } of open) {
        const want = (left * (e.weight ?? 1)) / offered;
        const flow = Math.min(want, room);
        if (want - flow > EPS) refused.add(kindOf(e));
        this.deliver(e, flow);
        moved += flow;
      }
      for (const e of candidates) if (!open.some((o) => o.e === e)) refused.add(kindOf(e));
      // What's left is exactly the refused shares; it waits unless a sibling of the same kind has room.
      left -= moved;
      spill = refused;
      if (!refused.size) break;
    }
    return amount - left;
  }

  private advance() {
    const { mode } = this.config;
    const jitter = 0.96 + this.rng.next() * 0.08;
    for (const state of this.states.values()) {
      state.inflow = 0;
      state.served = 0;
    }
    for (const edge of this.spec.edges) {
      const link = this.links.get(linkKey(edge))!;
      link.flow = 0;
      if (!edge.delay) continue;
      const arrived = link.pipeline.shift() ?? 0;
      link.pipeline.push(0);
      const state = this.states.get(edge.to);
      if (state && !state.down) {
        state.queue += arrived;
        state.inflow += arrived;
      } else this.lost += arrived;
    }

    // A sink that is down still counts its demand, so cutting off a district shows as unserved.
    let wanted = 0;
    for (const node of this.spec.nodes) {
      if (this.role(node) !== 'sink') continue;
      const state = this.states.get(node.id)!;
      const want = this.rateOf(node) * this.spike * jitter;
      wanted += want;
      state.demand = mode !== 'demand' ? Infinity : state.down ? 0 : want * (1 - this.shedding);
    }

    const sources = this.spec.nodes.filter((n) => this.role(n) === 'source');
    if (mode === 'demand') this.dispatch(sources);
    let created = 0;
    for (const node of sources) {
      const state = this.states.get(node.id)!;
      const cap = this.live(node, state);
      if (mode === 'demand') continue;
      const arriving = this.rateOf(node) * this.spike * jitter;
      created += arriving;
      this.arrived += arriving;
      if (state.down) {
        this.lost += arriving;
        continue;
      }
      const admitted = arriving * (1 - this.shedding);
      this.lost += arriving - admitted;
      state.queue += Math.min(admitted, cap);
      this.lost += Math.max(0, admitted - cap);
    }

    let served = 0;
    for (const id of this.order) {
      const node = this.node(id);
      const state = this.states.get(id);
      if (!node || !state) continue;
      const role = this.role(node);
      if (role === 'sink') {
        const take = mode === 'demand' ? Math.min(state.queue, state.demand) : Math.min(state.queue, this.live(node, state));
        state.served = take;
        state.queue = mode === 'demand' ? 0 : state.queue - take;
        served += take;
        continue;
      }
      const cap = role === 'source' ? Infinity : this.live(node, state);
      state.capacity = role === 'source' ? this.live(node, state) : cap;
      if (mode === 'flow') {
        // Finished work stuck waiting for its next step still occupies a bed, machine or agent.
        const ready = Math.min(state.queue, Math.max(0, cap - this.heldAt(id)));
        state.queue -= ready;
        const sent = this.pushFlow(node, ready);
        state.served = sent;
        const waiting = state.queue + this.heldAt(id);
        state.utilization = cap === Infinity || cap === 0 ? (state.down ? 1 : 0) : (waiting + sent) / cap;
        if (role === 'source') this.turnAway(node, state);
        continue;
      }
      const ready = Math.min(state.queue, cap);
      const sent = this.push(node, ready);
      state.served = sent;
      state.queue -= sent;
      // In demand mode a full store is not load, only what goes out is.
      state.utilization = cap === Infinity || cap === 0 ? (state.down ? 1 : 0) : sent / cap;
      // Power can't wait and stores only hold their buffer; anything over it is curtailed.
      state.queue = Math.min(state.queue, this.bufferOf(node));
    }

    if (mode === 'demand') {
      for (const node of this.spec.nodes) {
        if (this.role(node) !== 'stage') continue;
        const state = this.states.get(node.id)!;
        const planned = this.planned.get(node.id) ?? 0;
        const got = state.down ? 0 : planned > EPS ? Math.min(1, state.inflow / planned) : 1;
        this.fill.set(node.id, Math.max(0.05, 0.5 * (this.fill.get(node.id) ?? 1) + 0.5 * got));
      }
    }

    if (this.config.trips) {
      // A line at its rating while the area it feeds is still short is overloaded; held for a few ticks, it trips.
      for (const edge of this.spec.edges) {
        const link = this.links.get(linkKey(edge))!;
        if (!edge.capacity || link.down) continue;
        const target = this.node(edge.to);
        const state = this.states.get(edge.to)!;
        const short = target && this.role(target) === 'sink' ? state.demand - state.served : (this.need.get(edge.to) ?? 0);
        link.overload = link.flow >= edge.capacity * 0.999 && short > 0.5 && served < wanted * 0.995 ? link.overload + 1 : 0;
        if (link.overload >= TRIP_TICKS) {
          link.down = true;
          link.tripped = true;
        }
      }
    }

    this.delivered += served;
    if (mode === 'demand') {
      this.ratio = wanted > EPS ? Math.min(1, served / wanted) : 1;
      this.lost += Math.max(0, wanted - served);
    } else {
      this.avgIn += (created - this.avgIn) * SMOOTHING;
      this.avgOut += (served - this.avgOut) * SMOOTHING;
      this.ratio = this.avgIn > EPS ? Math.min(1, this.avgOut / this.avgIn) : 1;
    }
  }

  step() {
    this.advance();
    this.tick++;
    this.scoreSum += this.ratio * 100;
    if (this.tick % SERIES_STEP === 0) this.series.push({ t: this.tick, value: Math.round(this.ratio * 1000) / 10 });
  }

  inject(incident: Incident) {
    this.log.push({ at: this.tick, incident });
    const target = incident.target ?? '';
    const state = this.states.get(target);
    const link = this.links.get(target);
    switch (incident.type) {
      case 'node_down':
        if (state) state.down = true;
        break;
      case 'node_slow':
        if (state) state.slow = 1 / Math.max(1.5, incident.value ?? 3);
        break;
      case 'link_down':
        if (link) link.down = true;
        break;
      case 'surge':
        this.spike = Math.max(1, Math.min(5, incident.value ?? this.config.surge.value));
        break;
      case 'recover':
        if (state) {
          state.down = false;
          state.slow = 1;
        }
        if (link) Object.assign(link, { down: false, tripped: false, overload: 0 });
        if (!target) this.spike = 1;
        break;
    }
  }

  apply(patches: unknown[]) {
    this.log.push({ at: this.tick, patches });
    for (const patch of patches as NetPatch[]) this.applyPatch(patch);
  }

  private applyPatch(patch: NetPatch) {
    switch (patch.op) {
      case 'scale': {
        const node = this.node(patch.node);
        if (node) node.count = patch.count;
        break;
      }
      case 'restore': {
        const state = this.states.get(patch.node);
        if (state?.down) Object.assign(state, { down: false, slow: Math.min(state.slow, BACKUP) });
        else if (state) state.slow = 1;
        break;
      }
      case 'add_link': {
        if (!this.node(patch.from) || !this.node(patch.to) || this.links.has(linkKey(patch))) break;
        const edge: NetEdge = { from: patch.from, to: patch.to };
        if (patch.weight !== undefined) edge.weight = patch.weight;
        if (patch.capacity !== undefined) edge.capacity = patch.capacity;
        if (patch.delay !== undefined) edge.delay = patch.delay;
        this.spec.edges.push(edge);
        if (netOrder(this.spec).length !== this.spec.nodes.length) {
          this.spec.edges.pop();
          break;
        }
        this.links.set(linkKey(edge), this.blankLink(edge));
        this.order = netOrder(this.spec);
        break;
      }
      case 'restore_link': {
        const link = this.links.get(linkKey(patch));
        if (link) Object.assign(link, { down: false, tripped: false, overload: 0 });
        break;
      }
      case 'set_buffer': {
        const node = this.node(patch.node);
        if (node) node.buffer = patch.buffer;
        break;
      }
      case 'shed':
        this.shedding = patch.fraction;
        break;
    }
  }

  backlog() {
    let total = 0;
    for (const node of this.spec.nodes) if (this.role(node) === 'stage') total += this.states.get(node.id)!.queue + this.heldAt(node.id);
    for (const link of this.links.values()) total += link.pipeline.reduce((a, b) => a + b, 0);
    return total;
  }

  /** Work queued in flow mode is waiting; in demand mode it is stock held in storage or in transit. */
  backlogLabel() {
    return this.config.mode === 'flow' ? 'waiting' : 'in storage or transit';
  }

  busiest() {
    return this.spec.nodes
      .filter((n) => this.role(n) === 'stage' && !this.states.get(n.id)!.down)
      .sort((a, b) => this.states.get(b.id)!.utilization - this.states.get(a.id)!.utilization)[0];
  }

  private outages() {
    return [...this.states.values()].filter((s) => s.down).length + [...this.links.values()].filter((l) => l.down).length;
  }

  evaluation(): Evaluation {
    const busiest = this.busiest();
    return {
      score: this.tick ? Math.round((this.scoreSum / this.tick) * 10) / 10 : 0,
      scoreLabel: this.config.scoreLabel,
      metrics: [
        { label: `${this.config.unit} delivered`, value: Math.round(this.delivered) },
        { label: this.config.lostLabel, value: Math.round(this.lost) },
        { label: this.backlogLabel(), value: Math.round(this.backlog()) },
        { label: 'busiest', value: busiest ? `${this.name(busiest)} ${Math.round(this.states.get(busiest.id)!.utilization * 100)}%` : 'none' },
      ],
      series: this.series,
    };
  }

  telemetry(): Metric[] {
    const pct = Math.round(this.ratio * 1000) / 10;
    const busiest = this.busiest();
    const load = busiest ? Math.round(this.states.get(busiest.id)!.utilization * 100) : 0;
    const backlog = Math.round(this.backlog());
    const out = this.outages();
    return [
      { label: this.config.scoreLabel, value: `${pct}%`, tone: pct < 90 ? 'danger' : pct < 99 ? 'warn' : undefined },
      { label: busiest ? `${this.name(busiest)} load` : 'load', value: `${load}%`, tone: load > 100 ? 'danger' : load > 85 ? 'warn' : undefined },
      { label: this.backlogLabel(), value: backlog, tone: this.config.mode === 'flow' && backlog > 0 && this.ratio < 0.99 ? 'warn' : undefined },
      { label: 'outages', value: out, tone: out ? 'danger' : undefined },
    ];
  }

  breakables(): Breakable[] {
    const out: Breakable[] = [];
    const words = (node: NetNode) => [node.id.toLowerCase(), this.name(node).toLowerCase(), node.kind.toLowerCase()];
    const busiest = this.busiest();
    if (busiest)
      out.push({ label: `${this.config.downVerb} ${this.name(busiest)}`, incident: { type: 'node_down', target: busiest.id }, keywords: [...words(busiest), 'down', 'fail'] });
    if (this.config.trips) {
      const line = this.spec.edges
        .filter((e) => e.capacity && !this.links.get(linkKey(e))!.down)
        .sort((a, b) => this.links.get(linkKey(b))!.flow / b.capacity! - this.links.get(linkKey(a))!.flow / a.capacity!)[0];
      if (line)
        out.push({
          label: `Trip ${this.name(this.node(line.from)!)} → ${this.name(this.node(line.to)!)}`,
          incident: { type: 'link_down', target: linkKey(line) },
          keywords: ['line', 'trip', 'link'],
        });
    }
    // Losing a source only hurts where sources supply demand; in flow mode it would just mean fewer arrivals.
    const source = this.spec.nodes.find((n) => this.role(n) === 'source' && !this.states.get(n.id)!.down);
    if (source && this.config.mode === 'demand' && this.spec.nodes.filter((n) => this.role(n) === 'source').length > 1) {
      out.push({ label: `${this.config.downVerb} ${this.name(source)}`, incident: { type: 'node_down', target: source.id }, keywords: [...words(source), 'down', 'fail'] });
    }
    if (busiest) out.push({ label: `Slow ${this.name(busiest)}`, incident: { type: 'node_slow', target: busiest.id, value: 2.5 }, keywords: [...words(busiest), 'slow'] });
    const { surge } = this.config;
    out.push({ label: surge.label, incident: { type: 'surge', value: surge.value }, keywords: surge.keywords });
    return out.slice(0, 5);
  }

  inspect(target: string): Inspection | null {
    const node = this.node(target);
    const state = this.states.get(target);
    if (node && state) {
      const role = this.role(node);
      const broken = state.down || state.slow !== 1;
      const rows: Inspection['rows'] = [
        ['Kind', node.kind],
        ['Status', state.down ? 'Down' : state.slow !== 1 ? 'Degraded' : 'Running'],
        ['Units', node.count ?? 1],
      ];
      if (role === 'sink') {
        rows.push([this.config.mode === 'demand' ? 'Demand' : 'Received', `${Math.round(this.config.mode === 'demand' ? state.demand : state.inflow)} ${this.config.unit}/tick`]);
        rows.push(['Served', `${Math.round(state.served)} ${this.config.unit}/tick`]);
      } else {
        const cap = this.capacityOf(node);
        rows.push(['Capacity', cap === Infinity ? 'Unlimited' : `${Math.round(cap)} ${this.config.unit}/tick`]);
        rows.push(['Load', `${Math.round(state.utilization * 100)}%`]);
        rows.push([this.config.mode === 'flow' ? 'Waiting' : 'Stored', Math.round(state.queue + this.heldAt(node.id))]);
      }
      return {
        title: this.name(node),
        rows,
        actions: broken
          ? [{ label: 'Bring it back', incident: { type: 'recover', target }, destructive: false }]
          : [
              { label: this.config.downVerb, incident: { type: 'node_down', target }, destructive: true },
              { label: 'Slow it down', incident: { type: 'node_slow', target, value: 2.5 }, destructive: true },
            ],
      };
    }
    const link = this.links.get(target);
    const edge = this.spec.edges.find((e) => linkKey(e) === target);
    if (!link || !edge) return null;
    return {
      title: `${this.name(this.node(edge.from)!)} → ${this.name(this.node(edge.to)!)}`,
      rows: [
        ['Status', link.tripped ? 'Tripped on overload' : link.down ? 'Cut' : 'Open'],
        ['Flow', `${Math.round(link.flow)} ${this.config.unit}/tick`],
        ['Capacity', edge.capacity ? `${edge.capacity} ${this.config.unit}/tick` : 'Unlimited'],
        ['In transit', Math.round(link.pipeline.reduce((a, b) => a + b, 0))],
      ],
      actions: link.down
        ? [{ label: 'Restore', incident: { type: 'recover', target }, destructive: false }]
        : [{ label: 'Cut this link', incident: { type: 'link_down', target }, destructive: true }],
    };
  }
}
