import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEC, compileWorld } from '../src/domains/warehouse/compile';
import type { Patch } from '../src/domains/warehouse/schema';
import { DOMAINS, WarehouseRun, evaluate } from '../src';

const world = compileWorld(DEFAULT_SPEC);
const domain = DOMAINS.warehouse;

function stepped(ticks: number) {
  const run = new WarehouseRun(world, 1);
  for (let i = 0; i < ticks; i++) run.step();
  return run;
}

type Cell = { x: number; y: number };

// The open cell nearest `near` that the run accepts the edit to, other than where the thing already is
function openCell(run: WarehouseRun, from: Cell, patch: (to: Cell) => Patch, near: Cell = from) {
  const { cols, rows } = run.world;
  const cells = Array.from({ length: cols * rows }, (_, i) => ({ x: i % cols, y: Math.floor(i / cols) }));
  cells.sort((a, b) => Math.abs(a.x - near.x) + Math.abs(a.y - near.y) - (Math.abs(b.x - near.x) + Math.abs(b.y - near.y)));
  return cells.find((to) => (to.x !== from.x || to.y !== from.y) && run.check([patch(to)]) === null)!;
}

function assertSane(run: WarehouseRun, ticks: number) {
  const { sim } = run;
  for (let t = 0; t < ticks; t++) {
    run.step();
    const cells = new Set<string>();
    for (const r of sim.robots) {
      const key = `${r.x},${r.y}`;
      expect(cells.has(key), `two robots on ${key} at tick ${sim.tick}`).toBe(false);
      cells.add(key);
      expect(sim.grid.blocked[sim.grid.idx(r.x, r.y)], `${r.id} on an obstacle at tick ${sim.tick}`).toBe(0);
    }
  }
}

describe('moving things on a running warehouse floor', () => {
  it('moves a robot mid-run, makes the new spot its parking place and keeps delivering', () => {
    const run = stepped(200);
    const robot = run.sim.robots[0];
    const to = openCell(run, robot, (to) => ({ op: 'move_robot', robotId: robot.id, to }), { x: robot.x, y: robot.y + 3 });
    run.apply([{ op: 'move_robot', robotId: robot.id, to }]);
    expect([robot.x, robot.y]).toEqual([to.x, to.y]);
    expect(robot.home).toBe(run.sim.grid.idx(to.x, to.y));
    const before = run.sim.delivered;
    assertSane(run, 600);
    expect(run.sim.delivered).toBeGreaterThan(before);
  });

  it('puts a moved robot’s unpicked order back in the queue, and lets a carrier keep its package', () => {
    const run = stepped(1);
    let robot = run.sim.robots.find((r) => r.mode === 'to_shelf');
    for (let i = 0; !robot && i < 200; i++) {
      run.step();
      robot = run.sim.robots.find((r) => r.mode === 'to_shelf');
    }
    const order = robot!.order!;
    const to = openCell(run, robot!, (to) => ({ op: 'move_robot', robotId: robot!.id, to }));
    run.apply([{ op: 'move_robot', robotId: robot!.id, to }]);
    expect(robot!.order).toBeNull();
    expect(order.state).toBe('queued');
    expect(run.sim.queue).toContain(order);

    let carrier = run.sim.robots.find((r) => r.carrying);
    for (let i = 0; !carrier && i < 400; i++) {
      run.step();
      carrier = run.sim.robots.find((r) => r.carrying);
    }
    const parcel = carrier!.order;
    const spot = openCell(run, carrier!, (to) => ({ op: 'move_robot', robotId: carrier!.id, to }));
    run.apply([{ op: 'move_robot', robotId: carrier!.id, to: spot }]);
    expect(carrier!.order).toBe(parcel);
    expect(carrier!.mode).toBe('to_drop');
    assertSane(run, 300);
  });

  it('moves a shelf, gives it an open face to pick from, and its orders follow it', () => {
    const run = stepped(150);
    const shelf = run.world.shelves[0];
    const waiting = run.sim.orders.filter((o) => o.shelf === shelf && o.state !== 'done');
    const to = openCell(run, shelf, (to) => ({ op: 'move_shelf', shelfId: shelf.id, to }), { x: shelf.x, y: shelf.y + 2 });
    const from = run.sim.grid.idx(shelf.x, shelf.y);
    run.apply([{ op: 'move_shelf', shelfId: shelf.id, to }]);
    expect([shelf.x, shelf.y]).toEqual([to.x, to.y]);
    expect(run.sim.grid.blocked[from]).toBe(0);
    expect(run.sim.grid.blocked[run.sim.grid.idx(to.x, to.y)]).toBe(1);
    expect(Math.abs(shelf.access.x - to.x) + Math.abs(shelf.access.y - to.y)).toBe(1);
    expect(run.sim.grid.blocked[run.sim.grid.idx(shelf.access.x, shelf.access.y)]).toBe(0);
    for (const order of waiting) expect(order.shelf).toBe(shelf);
    assertSane(run, 800);
    expect(run.sim.orders.filter((o) => o.shelf === shelf && o.state === 'done').length).toBeGreaterThan(0);
  });

  it('refuses a move onto anything that stands or works there, and leaves the floor alone', () => {
    const run = stepped(50);
    const shelf = run.world.shelves[0];
    const other = run.world.shelves[1];
    const robot = run.sim.robots[0];
    const shelfTo = (to: { x: number; y: number }): Patch => ({ op: 'move_shelf', shelfId: shelf.id, to });
    expect(run.check([shelfTo({ x: other.x, y: other.y })])).toMatch(/shelf already stands/);
    expect(run.check([shelfTo(other.access)])).toMatch(/pick a shelf from there/);
    expect(run.check([shelfTo(run.world.chargers[0].bay)])).toMatch(/charge there/);
    expect(run.check([shelfTo(run.world.conveyors[0].path[0])])).toMatch(/conveyor runs there/);
    const home = { x: run.sim.grid.x(robot.home), y: run.sim.grid.y(robot.home) };
    expect(run.check([shelfTo(home)])).toMatch(/parks there/);
    expect(run.check([shelfTo({ x: -1, y: 0 })])).toMatch(/off the floor/);
    expect(run.check([{ op: 'move_robot', robotId: robot.id, to: { x: shelf.x, y: shelf.y } }])).toMatch(/shelf already stands/);

    const before = JSON.stringify(run.world);
    run.apply([shelfTo({ x: other.x, y: other.y })]);
    expect(JSON.stringify(run.world)).toBe(before);
  });

  it('applies exactly the edits the check allows, everywhere on the floor', () => {
    const base = stepped(80);
    const { cols, rows } = base.world;
    let allowed = 0;
    for (let i = 0; i < cols * rows; i++) {
      const to = { x: i % cols, y: Math.floor(i / cols) };
      const patch: Patch = { op: 'move_shelf', shelfId: 'S3', to };
      const run = stepped(80);
      const reason = run.check([patch]);
      run.apply([patch]);
      const shelf = run.world.shelves.find((s) => s.id === 'S3')!;
      const moved = shelf.x === to.x && shelf.y === to.y;
      expect(moved, `${to.x},${to.y}: ${reason}`).toBe(reason === null);
      if (reason === null && base.world.shelves[2].x !== to.x) allowed++;
    }
    expect(allowed).toBeGreaterThan(10);
  });

  it('refuses the shelf move that would wall a charger off, and keeps the floor as it was', () => {
    const run = new WarehouseRun(world, 1);
    const { bay } = run.world.chargers[0];
    // Shelves on two sides of the charging bay are fine; the third side would shut the last way in.
    const sides = [
      { x: bay.x, y: bay.y - 1 },
      { x: bay.x + 1, y: bay.y },
      { x: bay.x, y: bay.y + 1 },
    ];
    for (const [i, to] of sides.slice(0, 2).entries()) {
      const patch: Patch = { op: 'move_shelf', shelfId: run.world.shelves[i * 2].id, to };
      expect(run.check([patch])).toBeNull();
      run.apply([patch]);
    }
    const last: Patch = { op: 'move_shelf', shelfId: run.world.shelves[4].id, to: sides[2] };
    expect(run.check([last])).toMatch(/Charger E1 can't be reached/);
    const before = JSON.stringify(run.world);
    run.apply([last]);
    expect(JSON.stringify(run.world)).toBe(before);
  });

  it('replays a run with hand edits to the same result, and never changes the compiled design', () => {
    const before = JSON.stringify(world);
    const live = stepped(120);
    const robot = live.sim.robots[1];
    const to = openCell(live, robot, (to) => ({ op: 'move_robot', robotId: robot.id, to }), { x: robot.x + 4, y: robot.y });
    live.apply([{ op: 'move_robot', robotId: robot.id, to }]);
    for (let i = 0; i < 100; i++) live.step();
    const shelf = live.world.shelves[5];
    const spot = openCell(live, shelf, (to) => ({ op: 'move_shelf', shelfId: shelf.id, to }));
    live.apply([{ op: 'move_shelf', shelfId: shelf.id, to: spot }]);
    // A refused edit is logged too, and the replay refuses it the same way.
    live.apply([{ op: 'move_shelf', shelfId: shelf.id, to: { x: live.world.shelves[0].x, y: live.world.shelves[0].y } }]);
    for (let i = 0; i < 300; i++) live.step();

    const replay = evaluate(domain, world, { seed: 1, ticks: live.tick, events: live.log });
    expect(replay).toEqual(live.evaluation());
    expect(JSON.stringify(world)).toBe(before);
  });

  it('shows an edit on a paused floor at once, in the order a replay applies it', () => {
    const live = stepped(60);
    live.inject({ type: 'fail_robot', target: 'R2' });
    const robot = live.sim.robots[0];
    const to = openCell(live, robot, (to) => ({ op: 'move_robot', robotId: robot.id, to }), { x: robot.x, y: robot.y + 2 });
    live.apply([{ op: 'move_robot', robotId: robot.id, to }]);
    expect([robot.x, robot.y]).toEqual([to.x, to.y]);
    expect(live.sim.robots[1].mode).toBe('failed');
    for (let i = 0; i < 200; i++) live.step();
    expect(evaluate(domain, world, { seed: 1, ticks: live.tick, events: live.log })).toEqual(live.evaluation());
  });
});
