import type { Issue } from '../../domain';
import { Grid } from './planner';
import type { World } from './schema';

export function validateWorld(world: World): Issue[] {
  const issues: Issue[] = [];
  const grid = new Grid(world);
  const start = grid.idx(world.robots[0].home.x, world.robots[0].home.y);
  const reach = (x: number, y: number) => grid.reachable(start, grid.idx(x, y));

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
