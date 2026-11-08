import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEC, compileWorld } from '../src/domains/warehouse/compile';
import type { Patch } from '../src/domains/warehouse/schema';
import { DOMAINS, FLOOR, WarehouseRun, evaluate, settingPatch } from '../src';

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
      if (r.gone) continue;
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

// Two chargers, so one can go; and robots that want charging early, so chargers are busy.
const roomy = compileWorld({ ...DEFAULT_SPEC, chargers: 2, robots: 4 });

function busy(ticks: number) {
  const run = new WarehouseRun(roomy, 2);
  run.apply([{ op: 'set_policy', chargeThreshold: 0.8 }]);
  for (let i = 0; i < ticks; i++) run.step();
  return run;
}

function until(run: WarehouseRun, found: () => boolean, limit = 2000) {
  for (let i = 0; i < limit && !found(); i++) run.step();
  expect(found()).toBe(true);
}

describe('moving chargers and deleting things on a running floor', () => {
  it('moves a charger: robots on their way follow it, and one plugged in unplugs and finds a charger again', () => {
    const run = busy(0);
    until(run, () => run.sim.robots.some((r) => r.mode === 'to_charger'));
    const coming = run.sim.robots.find((r) => r.mode === 'to_charger')!;
    const charger = run.world.chargers[coming.charger];
    const to = openCell(run, charger, (to) => ({ op: 'move_charger', chargerId: charger.id, to }), { x: charger.x + 2, y: charger.y + 4 });
    run.apply([{ op: 'move_charger', chargerId: charger.id, to }]);
    expect([charger.x, charger.y]).toEqual([to.x, to.y]);
    expect(run.sim.grid.blocked[run.sim.grid.idx(to.x, to.y)]).toBe(1);
    expect(Math.abs(charger.bay.x - to.x) + Math.abs(charger.bay.y - to.y)).toBe(1);
    expect(coming.goal).toBe(run.sim.grid.idx(charger.bay.x, charger.bay.y));

    until(run, () => run.sim.robots.some((r) => r.mode === 'charging'));
    const plugged = run.sim.robots.find((r) => r.mode === 'charging')!;
    const station = run.world.chargers[plugged.charger];
    const spot = openCell(run, station, (to) => ({ op: 'move_charger', chargerId: station.id, to }), { x: station.x + 3, y: station.y });
    run.apply([{ op: 'move_charger', chargerId: station.id, to: spot }]);
    expect(plugged.mode).toBe('idle');
    expect(plugged.charger).toBe(-1);
    assertSane(run, 600);
    expect(run.sim.robots.filter((r) => r.mode === 'failed')).toEqual([]);
  });

  it('refuses a charger move onto anything that stands or works there', () => {
    const run = busy(10);
    const charger = run.world.chargers[0];
    const shelf = run.world.shelves[0];
    const to = (cell: Cell): Patch => ({ op: 'move_charger', chargerId: charger.id, to: { x: cell.x, y: cell.y } });
    expect(run.check([to(shelf)])).toMatch(/shelf already stands/);
    expect(run.check([to(shelf.access)])).toMatch(/pick a shelf from there/);
    expect(run.check([to(run.world.chargers[1].bay)])).toMatch(/charge there/);
    expect(run.check([to(run.world.sorter.bypass)])).toMatch(/sorter there/);
  });

  it('deletes a robot: its unpicked order goes back, it leaves the floor, and the others carry on', () => {
    const run = busy(0);
    until(run, () => run.sim.robots.some((r) => r.mode === 'to_shelf'));
    const robot = run.sim.robots.find((r) => r.mode === 'to_shelf')!;
    const order = robot.order!;
    const where = { x: robot.x, y: robot.y };
    run.apply([{ op: 'delete_robot', robotId: robot.id }]);
    expect(robot.gone).toBe(true);
    expect(order.state).toBe('queued');
    expect(run.sim.queue).toContain(order);
    expect(run.inspect(robot.id)).toBeNull();
    expect(run.telemetry().find((m) => m.label === 'robots online')?.value).toBe('3/3');
    expect([...run.sim.shelfOwner.values()]).not.toContain(robot.id);
    // Its old cell is free for anyone else.
    const other = run.sim.robots.find((r) => !r.gone)!;
    expect(run.check([{ op: 'move_robot', robotId: other.id, to: where }])).toBeNull();
    const before = run.sim.delivered;
    assertSane(run, 800);
    expect(run.sim.delivered).toBeGreaterThan(before);
  });

  it('keeps at least one robot, shelf and charger', () => {
    const run = busy(5);
    const robots = run.sim.robots.map((r) => r.id);
    for (const id of robots.slice(1)) run.apply([{ op: 'delete_robot', robotId: id }]);
    expect(run.check([{ op: 'delete_robot', robotId: robots[0] }])).toMatch(/at least one robot/);
    run.apply([{ op: 'delete_charger', chargerId: run.world.chargers[0].id }]);
    expect(run.check([{ op: 'delete_charger', chargerId: run.world.chargers[0].id }])).toMatch(/at least one charger/);
    while (run.world.shelves.length > 1) run.apply([{ op: 'delete_shelf', shelfId: run.world.shelves[0].id }]);
    expect(run.check([{ op: 'delete_shelf', shelfId: run.world.shelves[0].id }])).toMatch(/at least one shelf/);
    expect(run.check([{ op: 'delete_shelf', shelfId: 'S999' }])).toMatch(/no shelf S999/);
    assertSane(run, 300);
  });

  it('deletes a shelf: its unpicked orders are cancelled and leave the backlog, picked ones still go out', () => {
    const run = busy(0);
    until(run, () => run.sim.robots.some((r) => r.mode === 'to_shelf'));
    const robot = run.sim.robots.find((r) => r.mode === 'to_shelf')!;
    const shelf = robot.order!.shelf;
    const waiting = run.sim.queue.filter((o) => o.shelf === shelf).length;
    const backlog = run.sim.backlog();
    run.apply([{ op: 'delete_shelf', shelfId: shelf.id }]);
    expect(run.world.shelves).not.toContain(shelf);
    expect(run.sim.grid.blocked[run.sim.grid.idx(shelf.x, shelf.y)]).toBe(0);
    expect(robot.order).toBeNull();
    expect(robot.mode).toBe('idle');
    expect(run.sim.cancelled).toBe(waiting + 1);
    expect(run.sim.backlog()).toBe(backlog - waiting - 1);
    expect(run.sim.queue.some((o) => o.shelf === shelf)).toBe(false);
    expect(run.inspect(shelf.id)).toBeNull();
    assertSane(run, 800);
    expect(run.sim.orders.filter((o) => o.shelf === shelf && o.state !== 'cancelled' && o.state !== 'done')).toEqual([]);
  });

  it('deletes a charger: a robot charging there looks for another, and robots on later chargers keep theirs', () => {
    const run = busy(0);
    until(run, () => run.sim.robots.some((r) => r.charger === 0 && r.mode === 'charging') && run.sim.robots.some((r) => r.charger === 1));
    const first = run.sim.robots.find((r) => r.charger === 0 && r.mode === 'charging')!;
    const second = run.sim.robots.find((r) => r.charger === 1)!;
    const kept = run.world.chargers[1];
    const removed = run.world.chargers[0];
    run.apply([{ op: 'delete_charger', chargerId: removed.id }]);
    expect(run.world.chargers).toEqual([kept]);
    expect(run.sim.chargers.map((c) => c.id)).toEqual([kept.id]);
    expect(run.sim.grid.blocked[run.sim.grid.idx(removed.x, removed.y)]).toBe(0);
    expect(first.charger).toBe(-1);
    expect(first.mode).toBe('idle');
    expect(second.charger).toBe(0);
    expect(run.sim.chargers[0].claimedBy).toBe(second.id);
    assertSane(run, 800);
  });

  it('replays moves and deletes to the same result, and never changes the compiled design', () => {
    const before = JSON.stringify(roomy);
    const live = busy(150);
    const charger = live.world.chargers[1];
    const to = openCell(live, charger, (to) => ({ op: 'move_charger', chargerId: charger.id, to }), { x: charger.x + 3, y: charger.y + 3 });
    live.apply([{ op: 'move_charger', chargerId: charger.id, to }]);
    for (let i = 0; i < 80; i++) live.step();
    live.apply([{ op: 'delete_robot', robotId: 'R2' }]);
    for (let i = 0; i < 80; i++) live.step();
    live.apply([{ op: 'delete_shelf', shelfId: 'S7' }]);
    live.apply([{ op: 'delete_charger', chargerId: live.world.chargers[0].id }]);
    // Refused, and refused the same way in the replay.
    live.apply([{ op: 'delete_charger', chargerId: live.world.chargers[0].id }]);
    for (let i = 0; i < 400; i++) live.step();

    const replay = evaluate(domain, roomy, { seed: 2, ticks: live.tick, events: live.log });
    expect(replay).toEqual(live.evaluation());
    expect(JSON.stringify(roomy)).toBe(before);
  });
});

describe('placing new robots, shelves and chargers on a running floor', () => {
  it('adds a robot without a cell exactly as before, on the first free cell of the north wall', () => {
    const plain = stepped(50);
    const placedNowhere = stepped(50);
    plain.sim.applyNow([{ op: 'add_robot' }]);
    placedNowhere.apply([{ op: 'add_robot' }]);
    const a = plain.sim.robots.at(-1)!;
    const b = placedNowhere.sim.robots.at(-1)!;
    expect([b.id, b.x, b.y]).toEqual([a.id, a.x, 0]);
    expect(placedNowhere.check([{ op: 'add_robot' }])).toBeNull();
  });

  it('adds a robot on a chosen cell, gives it shelves, and it gets to work', () => {
    const run = stepped(100);
    const at = openCell(run, { x: -1, y: -1 }, (at) => ({ op: 'add_robot', at }), { x: 10, y: 2 });
    run.apply([{ op: 'add_robot', at }]);
    const robot = run.sim.robots.at(-1)!;
    expect([robot.id, robot.x, robot.y]).toEqual(['R4', at.x, at.y]);
    expect(robot.home).toBe(run.sim.grid.idx(at.x, at.y));
    expect([...run.sim.shelfOwner.values()]).toContain('R4');
    assertSane(run, 600);
    expect(run.sim.orders.some((o) => o.state === 'done')).toBe(true);
    expect(robot.mode === 'idle' && robot.battery === run.world.params.batteryCapacity).toBe(false);
  });

  it('adds a shelf with an open face, in the zone it stands in, and orders start coming from it', () => {
    const zoned = compileWorld({ ...DEFAULT_SPEC, zones: [{ name: 'Cold storage', aisles: 1 }] });
    const run = new WarehouseRun(zoned, 1);
    const zone = run.world.zones[0];
    const at = openCell(run, { x: -1, y: -1 }, (at) => ({ op: 'add_shelf', at }), { x: zone.x + 1, y: zone.y + zone.h });
    run.apply([{ op: 'add_shelf', at }]);
    const shelf = run.world.shelves.at(-1)!;
    expect(shelf.id).toBe(`S${zoned.shelves.length + 1}`);
    expect([shelf.x, shelf.y]).toEqual([at.x, at.y]);
    expect(run.sim.grid.blocked[run.sim.grid.idx(at.x, at.y)]).toBe(1);
    expect(Math.abs(shelf.access.x - at.x) + Math.abs(shelf.access.y - at.y)).toBe(1);
    expect(run.sim.shelfOwner.get(shelf.id)).toBeDefined();
    if (at.x >= zone.x && at.x < zone.x + zone.w && at.y >= zone.y && at.y < zone.y + zone.h) expect(shelf.zone).toBe(zone.name);
    until(run, () => run.sim.orders.some((o) => o.shelf === shelf && o.state === 'done'), 6000);
  });

  it('adds a charger that robots use, and never reuses a deleted id', () => {
    const run = busy(0);
    run.apply([{ op: 'delete_charger', chargerId: 'E2' }]);
    const at = openCell(run, { x: -1, y: -1 }, (at) => ({ op: 'add_charger', at }), { x: 3, y: 1 });
    run.apply([{ op: 'add_charger', at }]);
    const charger = run.world.chargers.at(-1)!;
    expect(charger.id).toBe('E3');
    expect(run.sim.chargers.map((c) => c.id)).toEqual(['E1', 'E3']);
    expect(Math.abs(charger.bay.x - at.x) + Math.abs(charger.bay.y - at.y)).toBe(1);
    until(run, () => run.sim.robots.some((r) => r.mode === 'charging' && r.charger === 1));
    assertSane(run, 300);
  });

  it('refuses a cell that is taken or worked from, with the same reasons as a move', () => {
    const run = stepped(20);
    const shelf = run.world.shelves[0];
    const robot = run.sim.robots[0];
    const home = { x: run.sim.grid.x(robot.home), y: run.sim.grid.y(robot.home) };
    for (const op of ['add_robot', 'add_shelf', 'add_charger'] as const) {
      const at = (cell: Cell) => ({ op, at: { x: cell.x, y: cell.y } }) as Patch;
      expect(run.check([at(shelf)])).toMatch(/shelf already stands/);
      expect(run.check([at(shelf.access)])).toMatch(/pick a shelf from there/);
      expect(run.check([at(run.world.chargers[0].bay)])).toMatch(/charge there/);
      expect(run.check([at(home)])).toMatch(/standing there|parks there/);
      expect(run.check([at({ x: run.world.cols, y: 0 })])).toMatch(/off the floor/);
    }
    const before = JSON.stringify(run.world);
    const robots = run.sim.robots.length;
    run.apply([{ op: 'add_shelf', at: { x: shelf.access.x, y: shelf.access.y } }]);
    run.apply([{ op: 'add_robot', at: { x: shelf.x, y: shelf.y } }]);
    expect(JSON.stringify(run.world)).toBe(before);
    expect(run.sim.robots.length).toBe(robots);
  });

  it('refuses a shelf that would wall a charger off', () => {
    const run = new WarehouseRun(world, 1);
    const { bay } = run.world.chargers[0];
    run.apply([{ op: 'add_shelf', at: { x: bay.x, y: bay.y - 1 } }]);
    run.apply([{ op: 'add_shelf', at: { x: bay.x + 1, y: bay.y } }]);
    expect(run.world.shelves.length).toBe(world.shelves.length + 2);
    expect(run.check([{ op: 'add_shelf', at: { x: bay.x, y: bay.y + 1 } }])).toMatch(/Charger E1 can't be reached/);
  });

  it('replays placed robots, shelves and chargers to the same result', () => {
    const live = busy(100);
    const add = (patch: (at: Cell) => Patch, near: Cell) => live.apply([patch(openCell(live, { x: -1, y: -1 }, patch, near))]);
    add((at) => ({ op: 'add_robot', at }), { x: 12, y: 2 });
    for (let i = 0; i < 60; i++) live.step();
    add((at) => ({ op: 'add_shelf', at }), { x: 16, y: 6 });
    add((at) => ({ op: 'add_charger', at }), { x: 2, y: 9 });
    // Refused, and refused the same way in the replay.
    live.apply([{ op: 'add_charger', at: { x: live.world.shelves[0].x, y: live.world.shelves[0].y } }]);
    for (let i = 0; i < 400; i++) live.step();
    expect(evaluate(domain, roomy, { seed: 2, ticks: live.tick, events: live.log })).toEqual(live.evaluation());
  });
});

describe('changing the floor settings mid-run', () => {
  const setting = (run: WarehouseRun, key: string) => run.inspect(FLOOR)!.settings!.find((s) => s.key === key)!;

  it('shows dispatch, charge threshold and demand as the run has them', () => {
    const run = stepped(10);
    expect(run.inspect(FLOOR)!.title).toBe('Floor settings');
    expect(setting(run, 'dispatch')).toMatchObject({ kind: 'choice', value: 'zoned' });
    expect(setting(run, 'chargeThreshold')).toMatchObject({ kind: 'number', value: 25, unit: '%' });
    expect(setting(run, 'orderEvery')).toMatchObject({ kind: 'number', value: Math.round(world.params.orderEvery) });
  });

  it('applies each setting through set_policy or set_demand, logged at its tick', () => {
    const run = stepped(120);
    run.apply([settingPatch(setting(run, 'dispatch'), 'pooled')]);
    run.apply([settingPatch(setting(run, 'chargeThreshold'), 40)]);
    run.apply([settingPatch(setting(run, 'orderEvery'), 4)]);
    expect(run.sim.policy).toMatchObject({ dispatch: 'pooled', chargeThreshold: 0.4 });
    expect(run.sim.orderEvery).toBe(4);
    expect(run.log.map((e) => ('patches' in e ? [e.at, e.patches[0]] : null))).toEqual([
      [120, { op: 'set_policy', dispatch: 'pooled' }],
      [120, { op: 'set_policy', chargeThreshold: 0.4 }],
      [120, { op: 'set_demand', orderEvery: 4 }],
    ]);
    for (const patch of run.log.flatMap((e) => ('patches' in e ? e.patches : []))) expect(domain.patchSchema.safeParse(patch).success).toBe(true);
    expect(setting(run, 'chargeThreshold').value).toBe(40);
    expect(setting(run, 'dispatch').value).toBe('pooled');
  });

  it('lets busier demand bring orders in faster from then on', () => {
    const steady = stepped(200);
    const busier = stepped(200);
    busier.apply([settingPatch(setting(busier, 'orderEvery'), 2)]);
    for (let i = 0; i < 300; i++) {
      steady.step();
      busier.step();
    }
    expect(busier.sim.orders.length).toBeGreaterThan(steady.sim.orders.length * 2);
  });

  it('replays setting changes to the same result', () => {
    const live = stepped(100);
    live.apply([settingPatch(setting(live, 'dispatch'), 'pooled')]);
    for (let i = 0; i < 150; i++) live.step();
    live.apply([settingPatch(setting(live, 'chargeThreshold'), 60)]);
    live.apply([settingPatch(setting(live, 'orderEvery'), 6)]);
    for (let i = 0; i < 300; i++) live.step();
    expect(evaluate(domain, world, { seed: 1, ticks: live.tick, events: live.log })).toEqual(live.evaluation());
  });
});
