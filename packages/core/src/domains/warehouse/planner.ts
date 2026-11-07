import type { World } from './schema';

const HORIZON = 64;
const MAX_EXPANSIONS = 700;
const UNREACHABLE = 1 << 20;

export class Grid {
  readonly cols: number;
  readonly rows: number;
  readonly size: number;
  readonly blocked: Uint8Array;
  private fields = new Map<number, Int32Array>();

  constructor(world: World) {
    this.cols = world.cols;
    this.rows = world.rows;
    this.size = world.cols * world.rows;
    this.blocked = new Uint8Array(this.size);
    const block = (x: number, y: number) => {
      if (x >= 0 && y >= 0 && x < this.cols && y < this.rows) this.blocked[this.idx(x, y)] = 1;
    };
    for (const s of world.shelves) block(s.x, s.y);
    for (const c of world.chargers) block(c.x, c.y);
    for (const c of world.conveyors) for (const p of c.path) block(p.x, p.y);
    for (let x = world.sorter.x; x < this.cols; x++) {
      for (let y = world.sorter.y; y < this.rows; y++) block(x, y);
    }
  }

  idx(x: number, y: number) {
    return y * this.cols + x;
  }

  x(i: number) {
    return i % this.cols;
  }

  y(i: number) {
    return Math.floor(i / this.cols);
  }

  neighbors(i: number): number[] {
    const out: number[] = [];
    const x = this.x(i);
    const y = this.y(i);
    if (y > 0) out.push(i - this.cols);
    if (x < this.cols - 1) out.push(i + 1);
    if (y < this.rows - 1) out.push(i + this.cols);
    if (x > 0) out.push(i - 1);
    return out;
  }

  distanceField(goal: number): Int32Array {
    const cached = this.fields.get(goal);
    if (cached) return cached;
    const dist = new Int32Array(this.size).fill(UNREACHABLE);
    dist[goal] = 0;
    const queue = [goal];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (const n of this.neighbors(cur)) {
        if (this.blocked[n] || dist[n] !== UNREACHABLE) continue;
        dist[n] = dist[cur] + 1;
        queue.push(n);
      }
    }
    this.fields.set(goal, dist);
    return dist;
  }

  reachable(from: number, to: number) {
    return this.distanceField(to)[from] < UNREACHABLE;
  }
}

interface Node {
  cell: number;
  t: number;
  g: number;
  f: number;
  h: number;
  order: number;
  parent: Node | null;
}

function better(a: Node, b: Node) {
  return a.f !== b.f ? a.f < b.f : a.h !== b.h ? a.h < b.h : a.order < b.order;
}

class Heap {
  private items: Node[] = [];
  get size() {
    return this.items.length;
  }
  push(n: Node) {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!better(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): Node {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && better(a[l], a[m])) m = l;
        if (r < a.length && better(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export class Traffic {
  private reservations = new Map<number, number>();
  readonly parked = new Map<number, number>();

  constructor(readonly grid: Grid) {}

  private key(cell: number, t: number) {
    return t * this.grid.size + cell;
  }

  private holder(cell: number, t: number) {
    return this.reservations.get(this.key(cell, t));
  }

  private canRest(cell: number, t: number, robot: number) {
    for (let dt = 1; dt <= HORIZON + 1; dt++) {
      const holder = this.holder(cell, t + dt);
      if (holder !== undefined && holder !== robot) return false;
    }
    return true;
  }

  plan(robot: number, start: number, goal: number, t0: number): number[] | null {
    const grid = this.grid;
    if (!grid.reachable(start, goal)) return null;
    const field = grid.distanceField(goal);
    const heap = new Heap();
    const closed = new Set<number>();
    let order = 0;
    const rootH = field[start];
    let best: Node = { cell: start, t: t0, g: 0, f: rootH, h: rootH, order: order++, parent: null };
    heap.push(best);
    let expansions = 0;
    let found: Node | null = null;

    while (heap.size && expansions < MAX_EXPANSIONS) {
      const cur = heap.pop();
      const stateKey = cur.cell * (HORIZON + 2) + (cur.t - t0);
      if (closed.has(stateKey)) continue;
      closed.add(stateKey);
      expansions++;

      const improves = cur.h < best.h || (cur.h === best.h && cur.t < best.t);
      if (improves && this.canRest(cur.cell, cur.t, robot)) {
        if (cur.cell === goal) {
          found = cur;
          break;
        }
        best = cur;
      }
      if (cur.t - t0 >= HORIZON) continue;

      const moves = [cur.cell, ...grid.neighbors(cur.cell)];
      for (const next of moves) {
        if (grid.blocked[next]) continue;
        const parkedBy = this.parked.get(next);
        if (parkedBy !== undefined && parkedBy !== robot) continue;
        const t = cur.t + 1;
        const taken = this.holder(next, t);
        if (taken !== undefined && taken !== robot) continue;
        if (next !== cur.cell) {
          const swap = this.holder(next, cur.t);
          if (swap !== undefined && swap !== robot && this.holder(cur.cell, t) === swap) continue;
        }
        const h = field[next];
        if (h >= UNREACHABLE) continue;
        const g = cur.g + 1;
        heap.push({ cell: next, t, g, f: g + h, h, order: order++, parent: cur });
      }
    }

    const end = found ?? best;
    const path: number[] = [];
    for (let n: Node | null = end; n && n.parent; n = n.parent) path.push(n.cell);
    path.reverse();
    if (!path.length) return null;
    path.forEach((cell, i) => this.reservations.set(this.key(cell, t0 + i + 1), robot));
    return path;
  }

  release(robot: number, path: number[], t0: number) {
    path.forEach((cell, i) => {
      const k = this.key(cell, t0 + i + 1);
      if (this.reservations.get(k) === robot) this.reservations.delete(k);
    });
  }

  clear() {
    this.reservations.clear();
    this.parked.clear();
  }

  prune(t: number) {
    if (t % 256 !== 0) return;
    const cutoff = t * this.grid.size;
    for (const k of this.reservations.keys()) if (k < cutoff) this.reservations.delete(k);
  }
}
