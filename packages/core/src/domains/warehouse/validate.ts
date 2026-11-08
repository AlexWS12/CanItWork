import type { Issue } from '../../domain';
import { MIN_AISLES_FOR_SHAPE } from './compile';
import { Grid } from './planner';
import type { World } from './schema';

function layoutIssues(world: World): Issue[] {
  const issues: Issue[] = [];
  const { spec } = world;
  const shape = spec.shape ?? 'rect';
  if (spec.aisles < MIN_AISLES_FOR_SHAPE[shape]) {
    issues.push({
      severity: 'warning',
      repair: true,
      message: `A ${shape}-shaped floor needs at least ${MIN_AISLES_FOR_SHAPE[shape]} aisles; with ${spec.aisles} it was built as a rectangle`,
    });
  }
  const zones = spec.zones ?? [];
  const names = new Set(zones.map((z) => z.name));
  if (names.size !== zones.length) issues.push({ severity: 'error', repair: true, message: 'Two zones share a name' });
  const covered = zones.reduce((sum, z) => sum + z.aisles, 0);
  if (covered > spec.aisles) {
    issues.push({ severity: 'error', repair: true, message: `The zones cover ${covered} aisles but the floor has ${spec.aisles}: zone aisles must add up to "aisles" or less` });
  }
  const shared = zones.reduce((sum, z) => sum + (z.share ?? 0), 0);
  if (shared > 1.001) {
    issues.push({ severity: 'warning', repair: true, message: `Zone order shares add up to ${Math.round(shared * 100)}%, more than all orders` });
  }
  return issues;
}

export function validateWorld(world: World): Issue[] {
  const issues: Issue[] = layoutIssues(world);
  const grid = new Grid(world);
  const start = grid.idx(world.robots[0].home.x, world.robots[0].home.y);
  const reach = (x: number, y: number) => grid.reachable(start, grid.idx(x, y));

  // Every robot, not just the first, must start on an open cell joined to the rest of the floor.
  const onFloor = (x: number, y: number) => x >= 0 && y >= 0 && x < world.cols && y < world.rows;
  const stuck = world.robots.filter((r) => !onFloor(r.home.x, r.home.y) || grid.blocked[grid.idx(r.home.x, r.home.y)] || !reach(r.home.x, r.home.y));
  // Both go back to the Architect, worded as what to change, like the Reviewer's shortfalls: a fleet that can't park or move is a smaller warehouse than was asked for.
  if (stuck.length) {
    issues.push({
      severity: 'error',
      repair: true,
      message: `${stuck.map((r) => r.id).join(', ')} start${stuck.length === 1 ? 's' : ''} somewhere it can't move from; add aisles or use a rectangular floor so every robot has an open place to park`,
    });
  }
  if (world.robots.length < world.spec.robots) {
    issues.push({
      severity: 'warning',
      repair: true,
      message: `Only ${world.robots.length} of the ${world.spec.robots} robots asked for fit on this floor; add aisles so the whole fleet has room`,
    });
  }

  const unreachableShelves = world.shelves.filter((s) => !reach(s.access.x, s.access.y));
  if (unreachableShelves.length) {
    issues.push({ severity: 'error', message: `${unreachableShelves.length} shelves can't be reached` });
  }
  for (const c of world.chargers) {
    if (!reach(c.bay.x, c.bay.y)) issues.push({ severity: 'error', message: `Charger ${c.id} can't be reached` });
  }
  for (const c of world.conveyors) {
    if (!c.stations.some((s) => reach(s.x, s.y))) {
      issues.push({ severity: 'error', message: `Conveyor ${c.id} has no reachable loading station` });
    }
  }
  if (world.chargers.length * 4 < world.robots.length) {
    issues.push({
      severity: 'warning',
      message: `${world.robots.length} robots share ${world.chargers.length} charger(s), so charging queues are likely`,
    });
  }
  if (world.conveyors.length === 1) {
    issues.push({ severity: 'warning', message: 'One conveyor is a single point of failure' });
  }
  if (world.robots.length === 1) {
    issues.push({ severity: 'warning', message: 'One robot leaves no redundancy' });
  }
  return issues;
}
