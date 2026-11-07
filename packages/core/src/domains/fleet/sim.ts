import type { Breakable, Evaluation, Incident, Inspection, Metric, Point, Run, TimedEvent } from '../../domain';
import { createRng, type Rng } from '../../rng';
import { FleetPatchSchema, type FleetSpec, type Role } from './schema';

// Agent-based fleet simulator. Every tick is two simulated seconds. Units act by role, drain batteries (faster in wind), turn back
// while they can still make it home, queue for chargers, and only report what they find while the radio network links them to base.

export const SECONDS_PER_TICK = 2;
const CHARGE_MINUTES = 8;
const SERIES_STEP = 5;

export type UnitStatus = 'ready' | 'out' | 'returning' | 'charging' | 'lost';

export interface Unit {
  id: string;
  role: Role;
  x: number;
  y: number;
  battery: number;
  status: UnitStatus;
  carrying: boolean;
  task: { kind: 'cell'; cell: number } | { kind: 'target'; index: number } | { kind: 'waypoint'; index: number } | null;
  pending: number[];
  flown: number;
}

export interface Target {
  x: number;
  y: number;
  found: boolean;
  reported: boolean;
  served: number;
  claimedBy: string | null;
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

// Does the segment from a to b cross the rectangle? Liang-Barsky clipping.
function crosses(ax: number, ay: number, bx: number, by: number, r: { x: number; y: number; width: number; depth: number }) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const edges: Array<[number, number]> = [
    [-dx, ax - r.x],
    [dx, r.x + r.width - ax],
    [-dy, ay - r.y],
    [dy, r.y + r.depth - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

export class FleetRun implements Run {
  readonly log: TimedEvent[] = [];
  readonly spec: FleetSpec;
  readonly units: Unit[] = [];
  readonly targets: Target[] = [];
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly explored: Uint8Array;
  connected = new Set<string>();
  links: Array<[string, string]> = [];
  tick = 0;
  jam = 1;
  chargersDown = 0;

  private rng: Rng;
  private claims = new Map<number, string>();
  private series: Point[] = [];
  private connectedSum = 0;
  private connectedTicks = 0;
  private patrolAirborne = 0;
  private patrolTicks = 0;
  private progressSum = 0;

  constructor(spec: FleetSpec, seed: number) {
    this.spec = structuredClone(spec);
    this.rng = createRng(seed);
    const { width, depth } = this.spec.area;
    this.cell = Math.max(5, Math.max(width, depth) / 40);
    this.cols = Math.ceil(width / this.cell);
    this.rows = Math.ceil(depth / this.cell);
    this.explored = new Uint8Array(this.cols * this.rows);
    for (const role of this.spec.roles) this.addUnits(role, role.count);
    this.placeTargets(this.spec.targets);
    this.updateNetwork();
  }

  private addUnits(role: Role, count: number) {
    const existing = this.units.filter((u) => u.role.id === role.id).length;
    for (let i = 0; i < count; i++) {
      this.units.push({
        id: `${role.id}-${existing + i + 1}`,
        role,
        x: this.spec.base.x,
        y: this.spec.base.y,
        battery: 1,
        status: 'ready',
        carrying: false,
        task: null,
        pending: [],
        flown: 0,
      });
    }
  }

  private placeTargets(n: number) {
    const { width, depth, obstacles } = this.spec.area;
    for (let i = 0; i < n; i++) {
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 30; tries++) {
        x = this.rng.next() * width;
        y = this.rng.next() * depth;
        const inside = obstacles.some((o) => x >= o.x && x <= o.x + o.width && y >= o.y && y <= o.y + o.depth);
        if (!inside && dist(x, y, this.spec.base.x, this.spec.base.y) > this.cell * 2) break;
      }
      const known = this.spec.known;
      this.targets.push({ x, y, found: known, reported: known, served: 0, claimedBy: null });
    }
  }

  role(id: string) {
    return this.spec.roles.find((r) => r.id === id);
  }

  unit(id: string) {
    return this.units.find((u) => u.id === id);
  }

  private baseRange() {
    return (this.spec.base.range ?? Math.max(...this.spec.roles.map((r) => r.range))) * this.jam;
  }

  private airborne(u: Unit) {
    return u.status === 'out' || u.status === 'returning';
  }

  // Air-to-air links fly over obstacles; a link touching the ground (the base or a rover) is blocked by any obstacle in the way.
  private canTalk(ax: number, ay: number, aGround: boolean, bx: number, by: number, bGround: boolean, range: number) {
    if (dist(ax, ay, bx, by) > range) return false;
    if (!aGround && !bGround) return true;
    return !this.spec.area.obstacles.some((o) => crosses(ax, ay, bx, by, o));
  }

  private updateNetwork() {
    const { x: bx, y: by } = this.spec.base;
    const live = this.units.filter((u) => u.status !== 'lost');
    const connected = new Set<string>(live.filter((u) => !this.airborne(u)).map((u) => u.id));
    const links: Array<[string, string]> = [];
    const frontier: Array<{ id: string; x: number; y: number; ground: boolean; range: number }> = [{ id: 'base', x: bx, y: by, ground: true, range: this.baseRange() }];
    const reached = new Set<string>(['base']);
    while (frontier.length) {
      const from = frontier.shift()!;
      for (const u of live) {
        if (reached.has(u.id) || !this.airborne(u)) continue;
        const ground = u.role.ground;
        if (this.canTalk(from.x, from.y, from.ground, u.x, u.y, ground, Math.min(from.range, u.role.range * this.jam))) {
          reached.add(u.id);
          connected.add(u.id);
          links.push([from.id, u.id]);
          frontier.push({ id: u.id, x: u.x, y: u.y, ground, range: u.role.range * this.jam });
        }
      }
    }
    this.connected = connected;
    this.links = links;
  }

  private cellCenter(cell: number) {
    return { x: ((cell % this.cols) + 0.5) * this.cell, y: (Math.floor(cell / this.cols) + 0.5) * this.cell };
  }

  private nearestOpenCell(u: Unit) {
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < this.explored.length; c++) {
      if (this.explored[c] || this.claims.has(c)) continue;
      const p = this.cellCenter(c);
      const d = dist(u.x, u.y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  private sense(u: Unit) {
    const r = u.role.sensor;
    const c0 = Math.max(0, Math.floor((u.x - r) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.floor((u.x + r) / this.cell));
    const r0 = Math.max(0, Math.floor((u.y - r) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.floor((u.y + r) / this.cell));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const p = this.cellCenter(row * this.cols + col);
        if (dist(u.x, u.y, p.x, p.y) <= r + this.cell * 0.5) this.explored[row * this.cols + col] = 1;
      }
    }
    // A target is found when the cell it lies in has been searched, so a fully searched area has found everything in it.
    this.targets.forEach((t, i) => {
      if (t.found) return;
      const col = Math.min(this.cols - 1, Math.max(0, Math.floor(t.x / this.cell)));
      const row = Math.min(this.rows - 1, Math.max(0, Math.floor(t.y / this.cell)));
      if (this.explored[row * this.cols + col] || dist(u.x, u.y, t.x, t.y) <= r) {
        t.found = true;
        u.pending.push(i);
      }
    });
  }

  private drainPerTick(u: Unit) {
    return (SECONDS_PER_TICK / (u.role.endurance * 60)) * (1 + this.spec.wind / 20);
  }

  // Battery needed to fly home from here, plus the reserve.
  private needToReturn(u: Unit) {
    const d = dist(u.x, u.y, this.spec.base.x, this.spec.base.y);
    return (d / u.role.speed / SECONDS_PER_TICK) * this.drainPerTick(u) + this.spec.reserve / 100;
  }

  private release(u: Unit) {
    if (u.task?.kind === 'cell') this.claims.delete(u.task.cell);
    if (u.task?.kind === 'target' && this.targets[u.task.index]?.claimedBy === u.id) this.targets[u.task.index].claimedBy = null;
    u.task = null;
  }

  // Moves toward a point; ground units step around an obstacle in the way by heading for its nearest outside corner.
  private moveToward(u: Unit, x: number, y: number) {
    let tx = x;
    let ty = y;
    if (u.role.ground) {
      const block = this.spec.area.obstacles.find((o) => crosses(u.x, u.y, x, y, o));
      if (block) {
        const pad = 2;
        const corners = [
          [block.x - pad, block.y - pad],
          [block.x + block.width + pad, block.y - pad],
          [block.x - pad, block.y + block.depth + pad],
          [block.x + block.width + pad, block.y + block.depth + pad],
        ].filter(([cx, cy]) => dist(u.x, u.y, cx, cy) > 0.5 && !this.spec.area.obstacles.some((o) => crosses(u.x, u.y, cx, cy, o)));
        const pick = corners.sort((a, b) => dist(u.x, u.y, a[0], a[1]) + dist(a[0], a[1], x, y) - (dist(u.x, u.y, b[0], b[1]) + dist(b[0], b[1], x, y)))[0];
        if (pick) [tx, ty] = pick;
      }
    }
    const d = dist(u.x, u.y, tx, ty);
    const step = u.role.speed * SECONDS_PER_TICK;
    if (d <= step) {
      u.x = tx;
      u.y = ty;
      u.flown += d;
      return tx === x && ty === y;
    }
    u.x += ((tx - u.x) / d) * step;
    u.y += ((ty - u.y) / d) * step;
    u.flown += step;
    return false;
  }

  private relayPoint(u: Unit, relays: Unit[]) {
    const { x: bx, y: by } = this.spec.base;
    const workers = this.units.filter((w) => w.role.behavior !== 'relay' && w.status === 'out');
    if (!workers.length) return { x: bx, y: by };
    // Head for the workers furthest from base, so the chain reaches out where contact is weakest.
    const far = [...workers].sort((a, b) => dist(b.x, b.y, bx, by) - dist(a.x, a.y, bx, by)).slice(0, Math.max(1, Math.ceil(workers.length / 2)));
    const fx = far.reduce((s, w) => s + w.x, 0) / far.length;
    const fy = far.reduce((s, w) => s + w.y, 0) / far.length;
    const i = relays.indexOf(u);
    const share = (i + 1) / (relays.length + 1);
    return { x: bx + (fx - bx) * share, y: by + (fy - by) * share };
  }

  private launch(u: Unit) {
    const behavior = u.role.behavior;
    if (behavior === 'idle') return;
    if (behavior === 'search') {
      const cell = this.nearestOpenCell(u);
      if (cell < 0) return;
      this.claims.set(cell, u.id);
      u.task = { kind: 'cell', cell };
    } else if (behavior === 'deliver') {
      if (!this.spec.deliveriesPerTarget) return;
      const index = this.targets.findIndex((t) => t.reported && t.served < this.spec.deliveriesPerTarget && !t.claimedBy);
      if (index < 0) return;
      this.targets[index].claimedBy = u.id;
      u.task = { kind: 'target', index };
      u.carrying = true;
    } else if (behavior === 'patrol') {
      u.task = { kind: 'waypoint', index: 0 };
    } else if (behavior === 'relay' || behavior === 'escort') {
      if (!this.units.some((w) => w.role.behavior !== 'relay' && w.role.behavior !== 'escort' && w.status === 'out')) return;
    }
    u.status = 'out';
  }

  private patrolPoints(u: Unit) {
    const { width, depth } = this.spec.area;
    const m = Math.min(width, depth) * 0.1;
    return u.role.waypoints?.length
      ? u.role.waypoints
      : [
          { x: m, y: m },
          { x: width - m, y: m },
          { x: width - m, y: depth - m },
          { x: m, y: depth - m },
        ];
  }

  private act(u: Unit, relays: Unit[]) {
    const { x: bx, y: by } = this.spec.base;
    if (u.status === 'lost') return;
    if (u.status === 'charging' || u.status === 'ready') {
      if (u.status === 'ready' && u.battery >= 0.95) this.launch(u);
      return;
    }
    u.battery -= this.drainPerTick(u);
    if (u.battery <= 0) {
      u.battery = 0;
      u.status = 'lost';
      this.release(u);
      return;
    }
    if (u.status === 'out' && u.battery < this.needToReturn(u)) {
      this.release(u);
      u.status = 'returning';
    }
    if (u.status === 'returning') {
      if (this.moveToward(u, bx, by)) {
        u.status = 'charging';
        u.carrying = false;
      }
      return;
    }
    const behavior = u.role.behavior;
    if (behavior === 'search' || behavior === 'patrol') this.sense(u);
    if (behavior === 'search') {
      if (u.task?.kind !== 'cell' || this.explored[u.task.cell]) {
        this.release(u);
        const cell = this.nearestOpenCell(u);
        if (cell < 0) {
          u.status = 'returning';
          return;
        }
        this.claims.set(cell, u.id);
        u.task = { kind: 'cell', cell };
      }
      const p = this.cellCenter(u.task.cell);
      if (this.moveToward(u, p.x, p.y)) this.sense(u);
    } else if (behavior === 'deliver') {
      if (u.task?.kind !== 'target') {
        u.status = 'returning';
        return;
      }
      const t = this.targets[u.task.index];
      if (this.moveToward(u, t.x, t.y)) {
        t.served += 1;
        t.claimedBy = null;
        u.carrying = false;
        u.task = null;
        u.status = 'returning';
      }
    } else if (behavior === 'relay') {
      const p = this.relayPoint(u, relays);
      this.moveToward(u, p.x, p.y);
    } else if (behavior === 'escort') {
      const carriers = this.units.filter((w) => w.role.behavior === 'deliver' && w.status === 'out');
      if (!carriers.length) {
        u.status = 'returning';
        return;
      }
      const near = carriers.sort((a, b) => dist(u.x, u.y, a.x, a.y) - dist(u.x, u.y, b.x, b.y))[0];
      this.moveToward(u, near.x, near.y);
    } else if (behavior === 'patrol') {
      const points = this.patrolPoints(u);
      const index = u.task?.kind === 'waypoint' ? u.task.index % points.length : 0;
      if (this.moveToward(u, points[index].x, points[index].y)) u.task = { kind: 'waypoint', index: (index + 1) % points.length };
    }
  }

  private charge() {
    const slots = Math.max(0, this.spec.base.chargers - this.chargersDown);
    const waiting = this.units.filter((u) => u.status === 'charging').sort((a, b) => a.battery - b.battery);
    waiting.slice(0, slots).forEach((u) => {
      u.battery = Math.min(1, u.battery + SECONDS_PER_TICK / (CHARGE_MINUTES * 60));
      if (u.battery >= 0.98) u.status = 'ready';
    });
  }

  step() {
    this.updateNetwork();
    // Whatever a connected unit found reaches the base now.
    for (const u of this.units) {
      if (!this.connected.has(u.id) || !u.pending.length) continue;
      for (const i of u.pending) this.targets[i].reported = true;
      u.pending = [];
    }
    const relays = this.units.filter((u) => u.role.behavior === 'relay' && u.status === 'out');
    for (const u of this.units) this.act(u, relays);
    this.charge();
    this.updateNetwork();
    const live = this.units.filter((u) => this.airborne(u));
    if (live.length) {
      this.connectedSum += live.filter((u) => this.connected.has(u.id)).length / live.length;
      this.connectedTicks++;
    }
    const patrollers = this.units.filter((u) => u.role.behavior === 'patrol');
    if (patrollers.length) {
      this.patrolAirborne += patrollers.filter((u) => u.status === 'out').length / patrollers.length;
      this.patrolTicks++;
    }
    this.tick++;
    this.progressSum += this.progress();
    if (this.tick % SERIES_STEP === 0) this.series.push({ t: this.tick, value: Math.round(this.progress() * 1000) / 10 });
  }

  coverage() {
    let n = 0;
    for (const e of this.explored) n += e;
    return n / this.explored.length;
  }

  private has(behavior: Role['behavior']) {
    return this.spec.roles.some((r) => r.behavior === behavior);
  }

  // The mission's progress from 0 to 1: area searched, targets found and reported, deliveries made, patrols kept airborne,
  // less a penalty for every unit lost.
  progress() {
    const parts: Array<[number, number]> = [];
    const total = this.targets.length;
    if (this.has('search')) {
      parts.push([this.coverage(), 1]);
      if (total && !this.spec.known) parts.push([this.targets.filter((t) => t.reported).length / total, 1]);
    }
    if (this.has('deliver') && total && this.spec.deliveriesPerTarget)
      parts.push([this.targets.reduce((s, t) => s + Math.min(t.served, this.spec.deliveriesPerTarget), 0) / (total * this.spec.deliveriesPerTarget), 2]);
    if (this.has('patrol')) parts.push([this.patrolTicks ? this.patrolAirborne / this.patrolTicks : 0, 1]);
    if (!parts.length) parts.push([this.connectedTicks ? this.connectedSum / this.connectedTicks : 1, 1]);
    const weight = parts.reduce((s, [, w]) => s + w, 0);
    const done = parts.reduce((s, [v, w]) => s + v * w, 0) / weight;
    const lost = this.units.filter((u) => u.status === 'lost').length;
    return done * (1 - (0.5 * lost) / Math.max(1, this.units.length));
  }

  inject(incident: Incident) {
    this.log.push({ at: this.tick, incident });
    switch (incident.type) {
      case 'lose_unit': {
        const target = incident.target ?? '';
        const u = this.unit(target) ?? this.units.find((w) => w.role.id === target && w.status !== 'lost') ?? this.units.find((w) => w.status === 'out');
        if (u) {
          this.release(u);
          u.status = 'lost';
        }
        break;
      }
      case 'jam_comms':
        this.jam = Math.min(1, Math.max(0.05, incident.value ?? 0.3));
        break;
      case 'wind':
        this.spec.wind = Math.min(30, Math.max(0, incident.value ?? 12));
        break;
      case 'charger_down':
        this.chargersDown = Math.min(this.spec.base.chargers, this.chargersDown + Math.max(1, Math.round(incident.value ?? 1)));
        break;
      case 'new_targets':
        this.placeTargets(Math.max(1, Math.round(incident.value ?? 3)));
        break;
      case 'repair': {
        const u = this.unit(incident.target ?? '');
        if (u && u.status === 'lost') this.restoreUnit(u);
        break;
      }
    }
    this.updateNetwork();
  }

  private restoreUnit(u: Unit) {
    u.status = 'charging';
    u.x = this.spec.base.x;
    u.y = this.spec.base.y;
    u.battery = Math.max(u.battery, 0.2);
  }

  apply(patches: unknown[]) {
    this.log.push({ at: this.tick, patches });
    for (const raw of patches) {
      const parsed = FleetPatchSchema.safeParse(raw);
      if (!parsed.success) continue;
      const p = parsed.data;
      if (p.op === 'add_units') {
        const role = this.role(p.role);
        if (role) {
          role.count += p.count;
          this.addUnits(role, p.count);
        }
      } else if (p.op === 'set_role') {
        const role = this.role(p.role);
        if (role) {
          if (p.speed) role.speed = p.speed;
          if (p.endurance) role.endurance = p.endurance;
          if (p.range) role.range = p.range;
          if (p.sensor) role.sensor = p.sensor;
        }
      } else if (p.op === 'add_chargers') this.spec.base.chargers += p.count;
      else if (p.op === 'set_reserve') this.spec.reserve = p.percent;
      else if (p.op === 'add_role') {
        if (!this.role(p.role.id)) {
          this.spec.roles.push(p.role);
          this.addUnits(p.role, p.role.count);
        }
      } else if (p.op === 'restore') {
        const u = this.unit(p.unit);
        if (u && u.status === 'lost') this.restoreUnit(u);
      } else if (p.op === 'clear_jam') this.jam = 1;
    }
    this.updateNetwork();
  }

  private counts() {
    const total = this.targets.length;
    return {
      lost: this.units.filter((u) => u.status === 'lost').length,
      found: this.targets.filter((t) => t.reported).length,
      total,
      served: this.targets.reduce((s, t) => s + Math.min(t.served, this.spec.deliveriesPerTarget), 0),
      needed: total * this.spec.deliveriesPerTarget,
      connected: this.connectedTicks ? this.connectedSum / this.connectedTicks : 1,
    };
  }

  evaluation(): Evaluation {
    const c = this.counts();
    const metrics: Metric[] = [];
    if (this.has('search')) metrics.push({ label: 'area searched', value: `${Math.round(this.coverage() * 100)}%` });
    if (c.total && this.has('search')) metrics.push({ label: 'targets reported', value: `${c.found}/${c.total}` });
    if (c.needed && this.has('deliver')) metrics.push({ label: 'deliveries', value: `${c.served}/${c.needed}` });
    metrics.push({ label: 'units lost', value: c.lost }, { label: 'time in contact', value: `${Math.round(c.connected * 100)}%` });
    // Progress averaged over the run, so finishing sooner scores higher and a delay shows even when the mission ends up complete.
    const score = this.tick ? this.progressSum / this.tick : this.progress();
    metrics.unshift({ label: 'mission done', value: `${Math.round(this.progress() * 100)}%` });
    return { score: Math.round(score * 1000) / 10, scoreLabel: '% mission progress, averaged over time', metrics, series: this.series };
  }

  telemetry(): Metric[] {
    const c = this.counts();
    const pct = Math.round(this.progress() * 1000) / 10;
    const out: Metric[] = [{ label: 'mission done', value: `${pct}%` }];
    if (c.total && this.has('search')) out.push({ label: 'targets reported', value: `${c.found}/${c.total}` });
    if (c.needed && this.has('deliver')) out.push({ label: 'delivered', value: `${c.served}/${c.needed}` });
    const airborne = this.units.filter((u) => this.airborne(u));
    const inContact = airborne.length ? airborne.filter((u) => this.connected.has(u.id)).length / airborne.length : 1;
    out.push({ label: 'in contact', value: `${Math.round(inContact * 100)}%`, tone: inContact < 0.6 ? 'danger' : inContact < 0.9 ? 'warn' : undefined });
    out.push({ label: 'units lost', value: c.lost, tone: c.lost ? 'danger' : undefined });
    return out;
  }

  breakables(): Breakable[] {
    const out: Breakable[] = [];
    const first = (behavior: Role['behavior']) => this.units.find((u) => u.role.behavior === behavior && u.status !== 'lost');
    const relay = first('relay');
    if (relay) out.push({ label: `Lose ${relay.id}`, incident: { type: 'lose_unit', target: relay.id }, keywords: ['relay', relay.id, 'lose', 'crash'] });
    const scout = first('search') ?? first('deliver') ?? first('patrol');
    if (scout) out.push({ label: `Lose ${scout.id}`, incident: { type: 'lose_unit', target: scout.id }, keywords: [scout.role.id, scout.id, 'lose', 'crash', 'drone', 'down'] });
    out.push({ label: 'Jam radios', incident: { type: 'jam_comms', value: 0.3 }, keywords: ['jam', 'radio', 'comms', 'signal', 'interference'] });
    out.push({ label: 'Wind 14 m/s', incident: { type: 'wind', value: 14 }, keywords: ['wind', 'gust', 'storm', 'weather'] });
    out.push({ label: 'Charger down', incident: { type: 'charger_down', value: 1 }, keywords: ['charger', 'charging', 'battery', 'dock'] });
    return out;
  }

  inspect(target: string): Inspection | null {
    if (target === 'base') {
      return {
        title: 'Base',
        rows: [
          ['Chargers working', `${this.spec.base.chargers - this.chargersDown} of ${this.spec.base.chargers}`],
          ['Charging now', this.units.filter((u) => u.status === 'charging').length],
          ['Radio range', `${Math.round(this.baseRange())} m`],
        ],
        actions: [{ label: 'Take a charger down', incident: { type: 'charger_down', value: 1 }, destructive: true }],
      };
    }
    const u = this.unit(target);
    if (!u) return null;
    const rows: Array<[string, string | number]> = [
      ['Role', `${u.role.label ?? u.role.id} (${u.role.behavior})`],
      ['Status', u.status],
      ['Battery', `${Math.round(u.battery * 100)}%`],
      ['In contact', this.connected.has(u.id) ? 'Yes' : 'No'],
      ['Position', `${Math.round(u.x)} m, ${Math.round(u.y)} m`],
      ['Distance flown', `${Math.round(u.flown)} m`],
    ];
    if (u.pending.length) rows.push(['Unreported finds', u.pending.length]);
    const actions: Inspection['actions'] =
      u.status === 'lost'
        ? [{ label: 'Bring it back', incident: { type: 'repair', target: u.id }, destructive: false }]
        : [{ label: `Lose ${u.id}`, incident: { type: 'lose_unit', target: u.id }, destructive: true }];
    return { title: u.id, rows, actions };
  }
}
