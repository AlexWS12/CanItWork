import { Grid, Traffic } from './planner';
import { createRng, type Rng } from '../../rng';
import { robotName } from './compile';
import type { Cell, Charger, Metrics, Patch, Policy, SeriesPoint, Shelf, SimEvent, SimScenario, World } from './schema';
import { validateWorld } from './validate';

export const SERIES_STEP = 20;
const THROUGHPUT_WINDOW = 5;
const SORTER_QUEUE = 6;
const STALL_LIMIT = 10;
const RETRY_TICKS = 4;
const LOW_BATTERY = 0.08;

export type RobotMode = 'idle' | 'to_shelf' | 'picking' | 'to_drop' | 'dropping' | 'to_charger' | 'charging' | 'to_home' | 'failed';

export type OrderState = 'queued' | 'assigned' | 'carried' | 'belt' | 'sorting' | 'chute' | 'done' | 'stranded' | 'cancelled';

export interface Order {
  id: number;
  shelf: Shelf;
  dock: number;
  createdAt: number;
  state: OrderState;
}

export interface RobotState {
  id: string;
  name: string;
  index: number;
  x: number;
  y: number;
  px: number;
  py: number;
  mode: RobotMode;
  battery: number;
  order: Order | null;
  carrying: boolean;
  failReason: 'fault' | 'battery' | null;
  /** Taken out of service by a patch, so a repair can't bring it back. */
  removed?: boolean;
  /** Deleted by hand: off the floor entirely, so it neither works nor stands in anyone's way. */
  gone?: boolean;
  home: number;
  goal: number | null;
  path: number[];
  pathStart: number;
  timer: number;
  stall: number;
  retryAt: number;
  charger: number;
  drop: { conveyor: number; slot: number } | 'bypass' | null;
}

export interface BeltState {
  id: string;
  blocked: boolean;
  slots: Array<Order | null>;
}

export interface ChuteItem {
  order: Order;
  left: number;
}

export interface ChargerState {
  id: string;
  offline: boolean;
  claimedBy: string | null;
}

export class Sim {
  readonly grid: Grid;
  readonly traffic: Traffic;
  readonly world: World;
  readonly policy: Policy;
  readonly robots: RobotState[] = [];
  readonly belts: BeltState[];
  readonly chargers: ChargerState[];
  readonly orders: Order[] = [];
  readonly queue: Order[] = [];
  readonly sorterQueue: Order[] = [];
  readonly chutes: ChuteItem[] = [];
  readonly shelfOwner = new Map<string, string>();
  readonly series: SeriesPoint[] = [];
  readonly log: SimEvent[] = [];

  tick = 0;
  delivered = 0;
  /** Orders whose shelf was deleted before anyone picked them; they leave the backlog. */
  cancelled = 0;
  demandFactor = 1;
  orderEvery: number;

  private rng: Rng;
  private pending: SimEvent[] = [];
  private nextOrderAt = 0;
  private sortTimer = 0;
  private latencySum = 0;
  private busyTicks = 0;
  private robotTicks = 0;
  private waitTicks = 0;
  private chargeWaitTicks = 0;
  private spawnedRobots = 0;
  // Ids for shelves and chargers added by hand carry on from the compiled ones, so a deleted id is never reused.
  private spawnedShelves = 0;
  private spawnedChargers = 0;
  private shelfWeights: number[] | null;

  constructor(compiled: World, seed: number, events: SimEvent[] = []) {
    // Hand edits move things on this run's floor, so it gets its own copy: runs compiled from one design never share a layout.
    const world = structuredClone(compiled);
    this.shelfWeights = orderWeights(world);
    this.world = world;
    this.policy = { ...world.policy };
    this.orderEvery = world.params.orderEvery;
    this.rng = createRng(seed);
    this.grid = new Grid(world);
    this.traffic = new Traffic(this.grid);
    this.belts = world.conveyors.map((c) => ({
      id: c.id,
      blocked: false,
      slots: new Array(c.path.length).fill(null),
    }));
    this.chargers = world.chargers.map((c) => ({ id: c.id, offline: false, claimedBy: null }));
    for (const shelf of world.shelves) this.shelfOwner.set(shelf.id, shelf.owner);
    for (const def of world.robots) this.addRobot(def.id, def.name, this.grid.idx(def.home.x, def.home.y));
    this.spawnedRobots = world.robots.length;
    const last = (ids: string[]) => Math.max(0, ...ids.map((id) => Number(id.replace(/\D/g, '')) || 0));
    this.spawnedShelves = last(world.shelves.map((s) => s.id));
    this.spawnedChargers = last(world.chargers.map((c) => c.id));
    for (const e of events) this.schedule(e);
  }

  private addRobot(id: string, name: string, home: number) {
    const robot: RobotState = {
      id,
      name,
      index: this.robots.length,
      x: this.grid.x(home),
      y: this.grid.y(home),
      px: this.grid.x(home),
      py: this.grid.y(home),
      mode: 'idle',
      battery: this.world.params.batteryCapacity,
      order: null,
      carrying: false,
      failReason: null,
      home,
      goal: null,
      path: [],
      pathStart: 0,
      timer: 0,
      stall: 0,
      retryAt: 0,
      charger: -1,
      drop: null,
    };
    this.robots.push(robot);
    this.traffic.parked.set(home, robot.index);
    return robot;
  }

  schedule(event: SimEvent) {
    this.pending.push(event);
    this.pending.sort((a, b) => a.at - b.at);
  }

  /**
   * Applies patches at this tick straight away, after anything already due, so a paused floor shows an edit at once
   * and lands it in the order a replay does.
   */
  applyNow(patches: Patch[]) {
    while (this.pending.length && this.pending[0].at <= this.tick) this.applyEvent(this.pending.shift()!);
    this.applyEvent({ type: 'apply_patch', at: this.tick, patches });
  }

  private cell(r: RobotState) {
    return this.grid.idx(r.x, r.y);
  }

  backlog() {
    return this.orders.length - this.delivered - this.cancelled;
  }

  private live() {
    return this.robots.filter((r) => r.mode !== 'failed');
  }

  private resetTraffic() {
    this.traffic.clear();
    for (const r of this.robots) {
      if (r.gone) continue;
      r.path = [];
      r.stall = 0;
      r.retryAt = 0;
      this.traffic.parked.set(this.cell(r), r.index);
    }
  }

  private heldByFailed(cell: number) {
    return this.robots.some((r) => r.mode === 'failed' && !r.gone && this.cell(r) === cell);
  }

  private redirectAround(cell: number) {
    for (const r of this.robots) {
      if (r.mode === 'failed' || r.goal !== cell) continue;
      if (r.mode === 'to_shelf') {
        r.order!.state = 'queued';
        this.queue.unshift(r.order!);
        r.order = null;
        r.mode = 'idle';
        this.setGoal(r, null);
      } else if (r.mode === 'to_drop') {
        this.chooseDrop(r);
      } else if (r.mode === 'to_charger') {
        this.releaseCharger(r);
        r.mode = 'idle';
        this.setGoal(r, null);
      } else {
        r.mode = 'idle';
        this.setGoal(r, null);
      }
    }
  }

  private fail(robot: RobotState, reason: 'fault' | 'battery') {
    if (robot.mode === 'failed') return;
    if (robot.order && !robot.carrying) {
      robot.order.state = 'queued';
      this.queue.unshift(robot.order);
      robot.order = null;
    } else if (robot.order) {
      robot.order.state = 'stranded';
    }
    this.releaseCharger(robot);
    robot.mode = 'failed';
    robot.failReason = reason;
    robot.goal = null;
    robot.drop = null;
    this.resetTraffic();
    this.redirectAround(this.cell(robot));
  }

  private releaseCharger(robot: RobotState) {
    if (robot.charger >= 0) this.chargers[robot.charger].claimedBy = null;
    robot.charger = -1;
  }

  private rebalanceZones() {
    const live = this.live();
    if (!live.length) return;
    const shelves = this.world.shelves;
    shelves.forEach((shelf, i) => {
      this.shelfOwner.set(shelf.id, live[Math.floor((i / shelves.length) * live.length)].id);
    });
  }

  applyPatch(patch: Patch) {
    switch (patch.op) {
      case 'set_policy':
        if (patch.dispatch) this.policy.dispatch = patch.dispatch;
        if (patch.chargeThreshold !== undefined) this.policy.chargeThreshold = patch.chargeThreshold;
        if (patch.conveyorBypass !== undefined) this.policy.conveyorBypass = patch.conveyorBypass;
        break;
      case 'add_robot': {
        if (this.checkPatch(patch)) break;
        const free = patch.at ? this.grid.idx(patch.at.x, patch.at.y) : this.freeParkingCell();
        if (free === null) break;
        const n = ++this.spawnedRobots;
        this.addRobot(`R${n}`, robotName(n - 1), free);
        this.rebalanceZones();
        break;
      }
      case 'remove_robot': {
        const robot = this.robots.find((r) => r.id === patch.robotId);
        if (robot) {
          this.fail(robot, 'fault');
          robot.removed = true;
          if (robot.order) robot.order.state = 'stranded';
          this.rebalanceZones();
        }
        break;
      }
      case 'reassign_zone':
        this.rebalanceZones();
        break;
      case 'set_demand':
        this.orderEvery = patch.orderEvery;
        break;
      case 'move_robot': {
        const robot = this.robots.find((r) => r.id === patch.robotId);
        if (robot && !this.checkPatch(patch)) this.moveRobot(robot, this.grid.idx(patch.to.x, patch.to.y));
        break;
      }
      case 'move_shelf': {
        const shelf = this.world.shelves.find((s) => s.id === patch.shelfId);
        if (shelf && !this.checkPatch(patch)) this.moveShelf(shelf, this.grid.idx(patch.to.x, patch.to.y));
        break;
      }
      case 'move_charger': {
        const charger = this.world.chargers.findIndex((c) => c.id === patch.chargerId);
        if (charger >= 0 && !this.checkPatch(patch)) this.moveCharger(charger, this.grid.idx(patch.to.x, patch.to.y));
        break;
      }
      case 'delete_robot': {
        const robot = this.robots.find((r) => r.id === patch.robotId);
        if (robot && !this.checkPatch(patch)) this.deleteRobot(robot);
        break;
      }
      case 'add_shelf': {
        const shelf = this.checkPatch(patch) ? null : this.newShelf(this.grid.idx(patch.at.x, patch.at.y));
        if (shelf) this.addShelf(shelf);
        break;
      }
      case 'add_charger': {
        const charger = this.checkPatch(patch) ? null : this.newCharger(this.grid.idx(patch.at.x, patch.at.y));
        if (charger) this.addCharger(charger);
        break;
      }
      case 'delete_shelf': {
        const shelf = this.world.shelves.find((s) => s.id === patch.shelfId);
        if (shelf && !this.checkPatch(patch)) this.deleteShelf(shelf);
        break;
      }
      case 'delete_charger': {
        const charger = this.world.chargers.findIndex((c) => c.id === patch.chargerId);
        if (charger >= 0 && !this.checkPatch(patch)) this.deleteCharger(charger);
        break;
      }
    }
  }

  /**
   * Why a hand edit can't land on the floor as it stands, or null when it can. Applying runs the same check,
   * so a replay refuses exactly what the live run refused.
   */
  checkPatch(patch: Patch): string | null {
    switch (patch.op) {
      case 'delete_robot': {
        const robot = this.robots.find((r) => r.id === patch.robotId && !r.removed);
        if (!robot) return `There is no robot ${patch.robotId}.`;
        return this.robots.some((r) => r !== robot && !r.removed) ? null : 'The floor needs at least one robot.';
      }
      case 'delete_shelf':
        if (!this.world.shelves.some((s) => s.id === patch.shelfId)) return `There is no shelf ${patch.shelfId}.`;
        return this.world.shelves.length > 1 ? null : 'The floor needs at least one shelf.';
      case 'delete_charger':
        if (!this.world.chargers.some((c) => c.id === patch.chargerId)) return `There is no charger ${patch.chargerId}.`;
        return this.world.chargers.length > 1 ? null : 'The floor needs at least one charger.';
      case 'move_robot':
      case 'move_shelf':
      case 'move_charger':
        return this.checkMove(patch);
      case 'add_robot':
        return patch.at ? this.checkAdd('robot', patch.at) : null;
      case 'add_shelf':
        return this.checkAdd('shelf', patch.at);
      case 'add_charger':
        return this.checkAdd('charger', patch.at);
      default:
        return null;
    }
  }

  private checkAdd(kind: 'robot' | 'shelf' | 'charger', at: Cell): string | null {
    if (at.x < 0 || at.y < 0 || at.x >= this.world.cols || at.y >= this.world.rows) return "That's off the floor.";
    const cell = this.grid.idx(at.x, at.y);
    const why = this.blockedBy(cell) ?? this.keptClear(cell) ?? this.robotAt(cell);
    if (why) return why;
    if (kind === 'robot') {
      // Robots don't block cells, so a new one only needs a way out to the rest of the floor.
      const other = this.robots.find((r) => !r.removed);
      return !other || this.grid.reachable(this.cell(other), cell) ? null : 'A robot there would be boxed in.';
    }
    const world = structuredClone(this.world);
    if (kind === 'shelf') {
      const shelf = this.newShelf(cell);
      if (!shelf) return 'There would be no open side for robots to reach it from.';
      world.shelves.push(shelf);
    } else {
      const charger = this.newCharger(cell);
      if (!charger) return 'There would be no open side for robots to reach it from.';
      world.chargers.push(charger);
    }
    return this.layoutCheck(world, new Map());
  }

  /** A shelf for `cell`, picked from the west like the compiled ones where it can be, in the zone it stands in. */
  private newShelf(cell: number): Shelf | null {
    const x = this.grid.x(cell);
    const y = this.grid.y(cell);
    const access = this.sideFor({ id: '', x, y, access: { x: x - 1, y }, owner: '' }, { x: x - 1, y }, cell);
    if (!access) return null;
    const shelf: Shelf = { id: `S${this.spawnedShelves + 1}`, x, y, access, owner: '' };
    const zone = this.world.zones.find((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
    if (zone) shelf.zone = zone.name;
    return shelf;
  }

  /** A charger for `cell`, charging from the east like the compiled ones where it can be. */
  private newCharger(cell: number): Charger | null {
    const x = this.grid.x(cell);
    const y = this.grid.y(cell);
    const bay = this.sideFor({ id: '', x, y, bay: { x: x + 1, y } }, { x: x + 1, y }, cell);
    return bay ? { id: `E${this.spawnedChargers + 1}`, x, y, bay } : null;
  }

  private checkMove(patch: Extract<Patch, { to: Cell }>): string | null {
    const { to } = patch;
    if (to.x < 0 || to.y < 0 || to.x >= this.world.cols || to.y >= this.world.rows) return "That's off the floor.";
    const cell = this.grid.idx(to.x, to.y);
    if (patch.op === 'move_robot') {
      const robot = this.robots.find((r) => r.id === patch.robotId && !r.removed);
      if (!robot) return `There is no robot ${patch.robotId}.`;
      if (this.cell(robot) === cell) return null;
      const why = this.blockedBy(cell) ?? this.keptClear(cell) ?? this.robotAt(cell, robot);
      return why ?? this.layoutCheck(this.world, new Map([[robot.id, cell]]));
    }
    if (patch.op === 'move_shelf') {
      const shelf = this.world.shelves.find((s) => s.id === patch.shelfId);
      if (!shelf) return `There is no shelf ${patch.shelfId}.`;
      return this.checkPlace(shelf, shelf.access, cell, (world, access) =>
        Object.assign(
          world.shelves.find((s) => s.id === shelf.id)!,
          { ...to, access },
        ),
      );
    }
    const charger = this.world.chargers.find((c) => c.id === patch.chargerId);
    if (!charger) return `There is no charger ${patch.chargerId}.`;
    return this.checkPlace(charger, charger.bay, cell, (world, bay) =>
      Object.assign(
        world.chargers.find((c) => c.id === charger.id)!,
        { ...to, bay },
      ),
    );
  }

  /** Whether a shelf or charger can stand on `cell`, with an open side for robots to work it from. */
  private checkPlace(thing: Shelf | Charger, face: Cell, cell: number, place: (world: World, side: Cell) => void): string | null {
    if (this.grid.idx(thing.x, thing.y) === cell) return null;
    const why = this.blockedBy(cell) ?? this.keptClear(cell, thing) ?? this.robotAt(cell);
    if (why) return why;
    const side = this.sideFor(thing, face, cell);
    if (!side) return 'There would be no open side for robots to reach it from.';
    const world = structuredClone(this.world);
    place(world, side);
    return this.layoutCheck(world, new Map());
  }

  /** What stands on a blocked cell, as the reason nothing else can go there. */
  private blockedBy(cell: number): string | null {
    if (!this.grid.blocked[cell]) return null;
    const x = this.grid.x(cell);
    const y = this.grid.y(cell);
    const at = (c: { x: number; y: number }) => c.x === x && c.y === y;
    const { world } = this;
    if (world.walls.some(at)) return "That's outside the floor.";
    if (world.shelves.some(at)) return 'A shelf already stands there.';
    if (world.chargers.some(at)) return 'A charger stands there.';
    if (world.conveyors.some((c) => c.path.some(at))) return 'The conveyor runs there.';
    if (x >= world.sorter.x && y >= world.sorter.y) return 'The sorter stands there.';
    return 'Something already stands there.';
  }

  /** Cells robots must be able to stand on to work, which nothing may cover. `own` may cover its own working cell. */
  private keptClear(cell: number, own?: Shelf | Charger): string | null {
    const { world } = this;
    const here = (c: { x: number; y: number }) => this.grid.idx(c.x, c.y) === cell;
    if (world.shelves.some((s) => s !== own && here(s.access))) return 'Robots pick a shelf from there.';
    if (world.chargers.some((c) => c !== own && here(c.bay))) return 'Robots charge there.';
    if (world.conveyors.some((c) => c.stations.some(here))) return 'Robots load the conveyor there.';
    if (here(world.sorter.bypass)) return 'Robots hand packages to the sorter there.';
    return null;
  }

  private robotAt(cell: number, except?: RobotState): string | null {
    for (const r of this.robots) {
      if (r === except || r.removed) continue;
      if (this.cell(r) === cell) return `${r.name} is standing there.`;
      if (r.home === cell) return `${r.name} parks there.`;
    }
    return null;
  }

  /**
   * Where robots work a shelf or charger placed on `cell` from: the side it faces now if that's open, else the first
   * open side. Its old cell counts as open, since it leaves it.
   */
  private sideFor(thing: Shelf | Charger, face: Cell, cell: number): Cell | null {
    const x = this.grid.x(cell);
    const y = this.grid.y(cell);
    const from = this.grid.idx(thing.x, thing.y);
    const facing = { x: x + face.x - thing.x, y: y + face.y - thing.y };
    const sides = [facing, { x: x - 1, y }, { x: x + 1, y }, { x, y: y - 1 }, { x, y: y + 1 }];
    return (
      sides.find((side) => {
        if (side.x < 0 || side.y < 0 || side.x >= this.world.cols || side.y >= this.world.rows) return false;
        const c = this.grid.idx(side.x, side.y);
        if (this.grid.blocked[c] && c !== from) return false;
        return !this.keptClear(c, thing) && !this.robots.some((r) => !r.removed && r.home === c);
      }) ?? null
    );
  }

  /**
   * Runs the layout validator on a floor after an edit, with every robot where it stands now (or at `placed`),
   * and returns the first problem the edit would add.
   */
  private layoutCheck(world: World, placed: Map<string, number>): string | null {
    const robots = this.robots.filter((r) => !r.removed);
    if (!robots.length) return null;
    const cellOf = (r: RobotState) => placed.get(r.id) ?? this.cell(r);
    const after: World = { ...world, robots: robots.map((r) => ({ id: r.id, name: r.name, home: { x: this.grid.x(cellOf(r)), y: this.grid.y(cellOf(r)) } })) };
    const grid = new Grid(after);
    const start = cellOf(robots[0]);
    // A robot must still reach where it parks; the validator only sees where each one stands.
    for (const r of robots) {
      const home = placed.get(r.id) ?? r.home;
      if (!grid.reachable(cellOf(r), home) || !grid.reachable(start, cellOf(r))) return `${r.name} would be boxed in.`;
    }
    const before: World = { ...this.world, robots: robots.map((r) => ({ id: r.id, name: r.name, home: { x: r.x, y: r.y } })) };
    const errors = (w: World) =>
      validateWorld(w)
        .filter((i) => i.severity === 'error')
        .map((i) => i.message);
    const known = new Set(errors(before));
    const added = errors(after).find((message) => !known.has(message));
    return added ? `${added}.` : null;
  }

  private moveRobot(r: RobotState, cell: number) {
    if (r.order && !r.carrying) {
      r.order.state = 'queued';
      this.queue.unshift(r.order);
      r.order = null;
    }
    this.releaseCharger(r);
    r.x = r.px = this.grid.x(cell);
    r.y = r.py = this.grid.y(cell);
    r.home = cell;
    r.goal = null;
    r.timer = 0;
    // A carrier keeps its package and picks the nearest drop from its new spot; anyone else starts afresh.
    if (r.mode !== 'failed') {
      r.mode = r.carrying ? 'to_drop' : 'idle';
      r.drop = null;
    }
    this.resetTraffic();
  }

  private moveShelf(shelf: Shelf, cell: number) {
    const access = this.sideFor(shelf, shelf.access, cell)!;
    this.grid.setBlocked(this.grid.idx(shelf.x, shelf.y), false);
    shelf.x = this.grid.x(cell);
    shelf.y = this.grid.y(cell);
    shelf.access = access;
    this.grid.setBlocked(cell, true);
    // Orders hold the shelf itself, so queued ones follow it; robots on their way turn to its new face.
    for (const r of this.robots) {
      if (r.mode === 'to_shelf' && r.order?.shelf === shelf) this.setGoal(r, this.grid.idx(access.x, access.y));
    }
    this.resetTraffic();
  }

  private moveCharger(index: number, cell: number) {
    const charger = this.world.chargers[index];
    const bay = this.sideFor(charger, charger.bay, cell)!;
    this.grid.setBlocked(this.grid.idx(charger.x, charger.y), false);
    charger.x = this.grid.x(cell);
    charger.y = this.grid.y(cell);
    charger.bay = bay;
    this.grid.setBlocked(cell, true);
    // A robot on its way follows the charger; one plugged in at the old bay unplugs and looks for a charger again.
    for (const r of this.robots) {
      if (r.charger !== index) continue;
      if (r.mode === 'to_charger') this.setGoal(r, this.grid.idx(bay.x, bay.y));
      else if (r.mode === 'charging') {
        this.releaseCharger(r);
        r.mode = 'idle';
      }
    }
    this.resetTraffic();
  }

  private deleteRobot(robot: RobotState) {
    // As with remove_robot, an unpicked order goes back to the queue and a carried one is stranded; then it leaves the floor.
    this.fail(robot, 'fault');
    robot.removed = true;
    robot.gone = true;
    this.resetTraffic();
    this.rebalanceZones();
  }

  private addShelf(shelf: Shelf) {
    this.spawnedShelves++;
    this.world.shelves.push(shelf);
    this.grid.setBlocked(this.grid.idx(shelf.x, shelf.y), true);
    this.shelfWeights = orderWeights(this.world);
    this.rebalanceZones();
    this.resetTraffic();
  }

  private addCharger(charger: Charger) {
    this.spawnedChargers++;
    this.world.chargers.push(charger);
    this.chargers.push({ id: charger.id, offline: false, claimedBy: null });
    this.grid.setBlocked(this.grid.idx(charger.x, charger.y), true);
    this.resetTraffic();
  }

  private deleteShelf(shelf: Shelf) {
    this.world.shelves.splice(this.world.shelves.indexOf(shelf), 1);
    this.grid.setBlocked(this.grid.idx(shelf.x, shelf.y), false);
    this.shelfOwner.delete(shelf.id);
    this.shelfWeights = orderWeights(this.world);
    // Orders nobody has picked yet can't be filled any more, and a robot on its way gives up. Picked ones still go out.
    for (const r of this.robots) {
      if (r.order?.shelf !== shelf || r.carrying) continue;
      r.order.state = 'cancelled';
      this.cancelled++;
      r.order = null;
      if (r.mode === 'to_shelf' || r.mode === 'picking') r.mode = 'idle';
      this.setGoal(r, null);
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].shelf !== shelf) continue;
      this.queue[i].state = 'cancelled';
      this.cancelled++;
      this.queue.splice(i, 1);
    }
    this.resetTraffic();
  }

  private deleteCharger(index: number) {
    const charger = this.world.chargers[index];
    this.world.chargers.splice(index, 1);
    this.chargers.splice(index, 1);
    this.grid.setBlocked(this.grid.idx(charger.x, charger.y), false);
    // Robots hold chargers by position in the list, so those after it shift down; anyone using it looks for another.
    for (const r of this.robots) {
      if (r.charger > index) r.charger--;
      else if (r.charger === index) {
        r.charger = -1;
        if (r.mode === 'to_charger' || r.mode === 'charging') {
          r.mode = 'idle';
          this.setGoal(r, null);
        }
      }
    }
    this.resetTraffic();
  }

  private freeParkingCell(): number | null {
    for (let x = 0; x < this.world.cols; x++) {
      const cell = this.grid.idx(x, 0);
      if (!this.grid.blocked[cell] && !this.traffic.parked.has(cell) && !this.robots.some((r) => !r.gone && this.cell(r) === cell)) {
        return cell;
      }
    }
    return null;
  }

  private applyEvent(event: SimEvent) {
    this.log.push(event);
    switch (event.type) {
      case 'fail_robot': {
        const robot = this.robots.find((r) => r.id === event.robotId);
        if (robot) this.fail(robot, 'fault');
        break;
      }
      case 'repair_robot': {
        const robot = this.robots.find((r) => r.id === event.robotId);
        if (robot?.mode === 'failed' && !robot.removed) {
          robot.mode = 'idle';
          robot.failReason = null;
          robot.battery = Math.max(robot.battery, this.world.params.batteryCapacity * 0.5);
          if (robot.order) {
            robot.order.state = 'carried';
            robot.mode = 'to_drop';
            robot.drop = null;
          }
        }
        break;
      }
      case 'block_conveyor':
      case 'unblock_conveyor': {
        const belt = this.belts.find((b) => b.id === event.conveyorId);
        if (belt) belt.blocked = event.type === 'block_conveyor';
        break;
      }
      case 'offline_charger':
      case 'online_charger': {
        const charger = this.chargers.find((c) => c.id === event.chargerId);
        if (charger) charger.offline = event.type === 'offline_charger';
        break;
      }
      case 'surge':
        this.demandFactor = event.factor;
        break;
      case 'apply_patch':
        for (const patch of event.patches) this.applyPatch(patch);
        break;
    }
  }

  private spawnOrders() {
    while (this.tick >= this.nextOrderAt) {
      const shelf = this.pickShelf();
      const order: Order = {
        id: this.orders.length + 1,
        shelf,
        dock: this.rng.int(0, this.world.docks.length - 1),
        createdAt: this.tick,
        state: 'queued',
      };
      this.orders.push(order);
      this.queue.push(order);
      const gap = this.orderEvery / this.demandFactor;
      this.nextOrderAt += Math.max(1, gap * (0.6 + this.rng.next() * 0.8));
    }
  }

  private pickShelf(): Shelf {
    const { shelves } = this.world;
    const weights = this.shelfWeights;
    if (!weights) return this.rng.pick(shelves);
    const roll = this.rng.next() * weights[weights.length - 1];
    const i = weights.findIndex((w) => roll < w);
    return shelves[i < 0 ? shelves.length - 1 : i];
  }

  private wantsCharge(r: RobotState) {
    return r.battery / this.world.params.batteryCapacity < this.policy.chargeThreshold;
  }

  private canTakeOrder(r: RobotState) {
    if (r.mode !== 'idle' && r.mode !== 'to_home') return false;
    return r.battery / this.world.params.batteryCapacity >= LOW_BATTERY;
  }

  private dispatch() {
    const free = this.robots.filter((r) => this.canTakeOrder(r));
    if (!free.length) return;
    for (let i = 0; i < this.queue.length && free.length;) {
      const order = this.queue[i];
      const access = order.shelf.access;
      if (this.heldByFailed(this.grid.idx(access.x, access.y))) {
        i++;
        continue;
      }
      let chosen: RobotState | undefined;
      if (this.policy.dispatch === 'zoned') {
        const owner = this.shelfOwner.get(order.shelf.id);
        chosen = free.find((r) => r.id === owner);
      } else {
        let bestDist = Infinity;
        for (const r of free) {
          const d = Math.abs(r.x - access.x) + Math.abs(r.y - access.y);
          if (d < bestDist) {
            bestDist = d;
            chosen = r;
          }
        }
      }
      if (!chosen) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      free.splice(free.indexOf(chosen), 1);
      order.state = 'assigned';
      chosen.order = order;
      chosen.mode = 'to_shelf';
      this.setGoal(chosen, this.grid.idx(access.x, access.y));
    }
  }

  private setGoal(r: RobotState, goal: number | null) {
    if (r.goal === goal) return;
    this.clearPath(r);
    r.goal = goal;
    r.stall = 0;
    r.retryAt = 0;
  }

  private clearPath(r: RobotState) {
    if (!r.path.length) return;
    this.traffic.release(r.index, r.path, r.pathStart);
    r.path = [];
    this.traffic.parked.set(this.cell(r), r.index);
  }

  private canAvoidBlockedBelt() {
    return this.policy.conveyorBypass || this.belts.some((b) => !b.blocked);
  }

  private chooseDrop(r: RobotState) {
    let best: { conveyor: number; slot: number; cell: number } | null = null;
    let bestDist = Infinity;
    this.world.conveyors.forEach((c, conveyor) => {
      if (this.belts[conveyor].blocked && this.policy.conveyorBypass) return;
      for (const s of c.stations) {
        if (this.heldByFailed(this.grid.idx(s.x, s.y))) continue;
        const d = Math.abs(s.x - r.x) + Math.abs(s.y - r.y) + (this.belts[conveyor].blocked ? 1000 : 0);
        if (d < bestDist) {
          bestDist = d;
          best = { conveyor, slot: s.index, cell: this.grid.idx(s.x, s.y) };
        }
      }
    });
    if (!best) {
      r.drop = 'bypass';
      this.setGoal(r, this.grid.idx(this.world.sorter.bypass.x, this.world.sorter.bypass.y));
      return;
    }
    const b = best as { conveyor: number; slot: number; cell: number };
    r.drop = { conveyor: b.conveyor, slot: b.slot };
    this.setGoal(r, b.cell);
  }

  private claimCharger(r: RobotState) {
    const free = this.chargers.findIndex((c, i) => {
      const bay = this.world.chargers[i].bay;
      return !c.offline && !c.claimedBy && !this.heldByFailed(this.grid.idx(bay.x, bay.y));
    });
    if (free < 0) return false;
    this.chargers[free].claimedBy = r.id;
    r.charger = free;
    r.mode = 'to_charger';
    const bay = this.world.chargers[free].bay;
    this.setGoal(r, this.grid.idx(bay.x, bay.y));
    return true;
  }

  private updateRobot(r: RobotState) {
    const { params } = this.world;
    const atGoal = r.goal !== null && this.cell(r) === r.goal;
    switch (r.mode) {
      case 'idle':
      case 'to_home':
        if (this.wantsCharge(r)) {
          if (this.claimCharger(r)) break;
          this.chargeWaitTicks++;
        }
        if (this.cell(r) !== r.home && !this.heldByFailed(r.home)) {
          r.mode = 'to_home';
          this.setGoal(r, r.home);
        } else {
          r.mode = 'idle';
          this.setGoal(r, null);
        }
        break;
      case 'to_shelf':
        if (atGoal) {
          r.mode = 'picking';
          r.timer = params.pickTicks;
          this.setGoal(r, null);
        }
        break;
      case 'picking':
        if (--r.timer <= 0) {
          r.carrying = true;
          r.order!.state = 'carried';
          r.mode = 'to_drop';
          this.chooseDrop(r);
        }
        break;
      case 'to_drop':
        if (!r.drop) this.chooseDrop(r);
        if (r.drop !== 'bypass' && r.drop && this.belts[r.drop.conveyor].blocked && this.canAvoidBlockedBelt()) {
          this.chooseDrop(r);
        }
        if (r.goal !== null && this.cell(r) === r.goal) {
          r.mode = 'dropping';
          r.timer = params.dropTicks;
          this.setGoal(r, null);
        }
        break;
      case 'dropping':
        if (r.timer > 0) {
          r.timer--;
          break;
        }
        this.tryDrop(r);
        break;
      case 'to_charger':
        if (atGoal) {
          r.mode = 'charging';
          this.setGoal(r, null);
        }
        break;
      case 'charging':
        r.battery = Math.min(params.batteryCapacity, r.battery + params.chargePerTick);
        if (r.battery >= params.batteryCapacity) {
          this.releaseCharger(r);
          r.mode = 'idle';
        }
        break;
      case 'failed':
        break;
    }
  }

  private tryDrop(r: RobotState) {
    const order = r.order!;
    const drop = r.drop;
    if (drop === 'bypass') {
      if (this.sorterQueue.length >= SORTER_QUEUE) return;
      order.state = 'sorting';
      this.sorterQueue.push(order);
    } else if (drop) {
      const belt = this.belts[drop.conveyor];
      if (belt.blocked && this.canAvoidBlockedBelt()) {
        r.mode = 'to_drop';
        this.chooseDrop(r);
        return;
      }
      if (belt.blocked || belt.slots[drop.slot]) return;
      belt.slots[drop.slot] = order;
      order.state = 'belt';
    }
    r.order = null;
    r.carrying = false;
    r.drop = null;
    r.mode = 'idle';
  }

  private planRoutes() {
    const { traffic, grid } = this;
    for (const r of this.robots) {
      if (r.mode === 'failed' || r.goal === null || r.path.length) continue;
      const here = this.cell(r);
      if (here === r.goal || this.tick < r.retryAt) continue;
      let target = r.goal;
      if (r.stall >= STALL_LIMIT) {
        const options = grid.neighbors(here).filter((n) => !grid.blocked[n] && !traffic.parked.has(n));
        if (options.length) target = options[this.tick % options.length];
        r.stall = 0;
      }
      traffic.parked.delete(here);
      const path = traffic.plan(r.index, here, target, this.tick);
      if (path) {
        r.path = path;
        r.pathStart = this.tick;
      } else {
        traffic.parked.set(here, r.index);
        r.retryAt = this.tick + RETRY_TICKS;
      }
    }
  }

  private moveRobots() {
    const { robots, grid, traffic } = this;
    const intent = robots.map((r) => {
      r.px = r.x;
      r.py = r.y;
      return r.path.length ? r.path[this.tick - r.pathStart] : grid.idx(r.x, r.y);
    });
    const here = robots.map((r) => this.cell(r));
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < robots.length; i++) {
        if (intent[i] === here[i]) continue;
        for (let j = 0; j < robots.length; j++) {
          if (i === j || robots[j].gone) continue;
          const sameTarget = intent[j] === intent[i] && (intent[j] === here[j] || j < i);
          const swap = here[j] === intent[i] && intent[j] === here[i];
          if (sameTarget || swap) {
            intent[i] = here[i];
            this.clearPath(robots[i]);
            changed = true;
            break;
          }
        }
      }
    }

    robots.forEach((r, i) => {
      if (!r.path.length) {
        if (r.mode !== 'failed' && r.goal !== null && here[i] !== r.goal) {
          this.waitTicks++;
          r.stall++;
        }
        return;
      }
      const step = this.tick - r.pathStart;
      r.x = grid.x(intent[i]);
      r.y = grid.y(intent[i]);
      if (intent[i] === here[i]) this.waitTicks++;
      else r.stall = 0;
      if (step === r.path.length - 1) {
        traffic.release(r.index, r.path, r.pathStart);
        r.path = [];
        traffic.parked.set(intent[i], r.index);
      }
    });
  }

  private advanceBelts() {
    const { beltTicks } = this.world.params;
    if (this.tick % beltTicks !== 0) return;
    for (const belt of this.belts) {
      if (belt.blocked) continue;
      const slots = belt.slots;
      const last = slots.length - 1;
      const head = slots[last];
      if (head && this.sorterQueue.length < SORTER_QUEUE) {
        head.state = 'sorting';
        this.sorterQueue.push(head);
        slots[last] = null;
      }
      for (let i = last - 1; i >= 0; i--) {
        if (slots[i] && !slots[i + 1]) {
          slots[i + 1] = slots[i];
          slots[i] = null;
        }
      }
    }
  }

  private advanceSorter() {
    const { sortTicks, chuteTicks } = this.world.params;
    if (this.sortTimer > 0) this.sortTimer--;
    if (this.sortTimer === 0 && this.sorterQueue.length) {
      const order = this.sorterQueue.shift()!;
      order.state = 'chute';
      this.chutes.push({ order, left: chuteTicks });
      this.sortTimer = sortTicks;
    }
    for (let i = this.chutes.length - 1; i >= 0; i--) {
      const item = this.chutes[i];
      if (--item.left <= 0) {
        item.order.state = 'done';
        this.delivered++;
        this.latencySum += this.tick - item.order.createdAt;
        this.chutes.splice(i, 1);
      }
    }
  }

  private drainBattery() {
    const capacity = this.world.params.batteryCapacity;
    for (const r of this.robots) {
      if (r.mode === 'failed' || r.mode === 'charging') continue;
      const moved = r.x !== r.px || r.y !== r.py;
      r.battery -= moved ? (r.carrying ? 1.3 : 1) : 0.15;
      if (r.battery <= 0) {
        r.battery = 0;
        this.fail(r, 'battery');
      } else if (r.battery / capacity < this.policy.chargeThreshold && r.mode === 'idle' && !this.chargers.some((c) => !c.offline && !c.claimedBy)) {
        this.chargeWaitTicks++;
      }
    }
  }

  private record() {
    for (const r of this.robots) {
      if (r.gone) continue;
      this.robotTicks++;
      if (r.mode !== 'idle' && r.mode !== 'failed' && r.mode !== 'to_home') this.busyTicks++;
    }
    if (this.tick % SERIES_STEP !== 0) return;
    const past = this.series[this.series.length - THROUGHPUT_WINDOW];
    const span = past ? this.tick - past.t : Math.max(this.tick, 1);
    const gained = this.delivered - (past?.delivered ?? 0);
    this.series.push({
      t: this.tick,
      delivered: this.delivered,
      backlog: this.backlog(),
      throughput: Math.round((gained / span) * 1000) / 10,
    });
  }

  step() {
    while (this.pending.length && this.pending[0].at <= this.tick) this.applyEvent(this.pending.shift()!);
    this.spawnOrders();
    this.dispatch();
    for (const r of this.robots) this.updateRobot(r);
    this.dispatch();
    this.planRoutes();
    this.moveRobots();
    this.drainBattery();
    this.advanceBelts();
    this.advanceSorter();
    this.traffic.prune(this.tick);
    this.tick++;
    this.record();
  }

  metrics(): Metrics {
    const stranded = this.orders.filter((o) => o.state === 'stranded').length;
    return {
      ticks: this.tick,
      created: this.orders.length,
      delivered: this.delivered,
      backlog: this.backlog(),
      stranded,
      avgLatency: this.delivered ? Math.round((this.latencySum / this.delivered) * 10) / 10 : 0,
      throughput: Math.round((this.delivered / Math.max(this.tick, 1)) * 1000) / 10,
      utilization: Math.round((this.busyTicks / Math.max(this.robotTicks, 1)) * 1000) / 1000,
      waitTicks: this.waitTicks,
      chargeWaitTicks: this.chargeWaitTicks,
    };
  }
}

/**
 * Cumulative order weights per shelf when any zone sets a share of orders, else null so the
 * draw stays uniform. Shelves outside a shared zone split whatever share is left over.
 */
export function orderWeights(world: World): number[] | null {
  const shared = world.zones.filter((z) => z.share !== undefined);
  if (!shared.length) return null;
  const shareOf = new Map(shared.map((z) => [z.name, z.share!]));
  const count = new Map<string, number>();
  for (const s of world.shelves) if (s.zone && shareOf.has(s.zone)) count.set(s.zone, (count.get(s.zone) ?? 0) + 1);
  const rest = world.shelves.length - [...count.values()].reduce((a, b) => a + b, 0);
  const left = Math.max(0, 1 - shared.reduce((sum, z) => sum + z.share!, 0));
  let total = 0;
  const weights = world.shelves.map((s) => {
    total += s.zone && shareOf.has(s.zone) ? shareOf.get(s.zone)! / count.get(s.zone)! : rest ? left / rest : 0;
    return total;
  });
  return total > 0 ? weights : null;
}

export function runScenario(world: World, scenario: SimScenario) {
  const sim = new Sim(world, scenario.seed, scenario.events);
  for (let i = 0; i < scenario.ticks; i++) sim.step();
  return { metrics: sim.metrics(), series: sim.series };
}
