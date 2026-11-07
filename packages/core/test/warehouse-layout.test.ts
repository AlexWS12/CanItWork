import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEC, compileWorld } from '../src/domains/warehouse/compile';
import { WorldSpecSchema, type WorldSpec } from '../src/domains/warehouse/schema';
import { Sim, runScenario } from '../src/domains/warehouse/sim';
import { validateWorld } from '../src/domains/warehouse/validate';
import { warehouse } from '../src/domains/warehouse';

const SHAPES = ['rect', 'L', 'U', 'T'] as const;
const errors = (spec: WorldSpec) => validateWorld(compileWorld(spec)).filter((i) => i.severity === 'error');

describe('warehouse layout', () => {
  it('leaves the default floor exactly as it was', () => {
    const plain = compileWorld(DEFAULT_SPEC);
    const rect = compileWorld({ ...DEFAULT_SPEC, shape: 'rect' });
    expect(plain.walls).toEqual([]);
    expect(plain.zones).toEqual([]);
    expect({ ...rect, spec: plain.spec }).toEqual(plain);
    const scenario = { seed: 4, ticks: 800, events: [] };
    expect(runScenario(rect, scenario)).toEqual(runScenario(plain, scenario));
  });

  it('builds every shape across the spec range, fully reachable, with the same stock', () => {
    for (const shape of SHAPES) {
      for (const aisles of [1, 2, 3, 4, 6]) {
        for (const robots of [1, 6, 12]) {
          for (const chargers of [1, 4]) {
            const spec: WorldSpec = { ...DEFAULT_SPEC, shape, aisles, robots, chargers, shelvesPerAisle: 3, conveyors: 2 };
            expect(WorldSpecSchema.safeParse(spec).success).toBe(true);
            expect(errors(spec), `${shape} with ${aisles} aisles`).toEqual([]);
            const world = compileWorld(spec);
            expect(world.shelves).toHaveLength(compileWorld({ ...spec, shape: 'rect' }).shelves.length);
            const walls = new Set(world.walls.map((w) => `${w.x},${w.y}`));
            for (const r of world.robots) expect(walls.has(`${r.home.x},${r.home.y}`), `${r.id} starts inside a wall`).toBe(false);
          }
        }
      }
    }
  });

  it('cuts the outline each shape names', () => {
    const wallsAt = (shape: WorldSpec['shape'], x: number, y: number) => compileWorld({ ...DEFAULT_SPEC, aisles: 4, shape }).walls.some((w) => w.x === x && w.y === y);
    // Aisle blocks 0-3 span x 3-6, 7-10, 11-14 and 15-18; the sort hall starts at x 19.
    expect(wallsAt('L', 4, 0)).toBe(false);
    expect(wallsAt('L', 16, 0)).toBe(true);
    expect(wallsAt('L', 20, 0)).toBe(true);
    expect(wallsAt('U', 4, 0)).toBe(false);
    expect(wallsAt('U', 8, 0)).toBe(true);
    expect(wallsAt('U', 16, 0)).toBe(false);
    expect(wallsAt('T', 0, 0)).toBe(true);
    expect(wallsAt('T', 8, 0)).toBe(false);
    expect(wallsAt('T', 16, 0)).toBe(true);
  });

  it('never collides or drives into a wall, and still delivers', () => {
    for (const shape of ['L', 'U', 'T'] as const) {
      const world = compileWorld({ ...DEFAULT_SPEC, shape, aisles: 4, robots: 8, demand: 'heavy', dispatch: 'pooled' });
      const sim = new Sim(world, 2);
      for (let t = 0; t < 700; t++) {
        sim.step();
        const cells = new Set<number>();
        for (const r of sim.robots) {
          const cell = sim.grid.idx(r.x, r.y);
          expect(sim.grid.blocked[cell], `${shape}: ${r.id} on an obstacle at tick ${t}`).toBe(0);
          expect(cells.has(cell), `${shape}: robots share a cell at tick ${t}`).toBe(false);
          cells.add(cell);
        }
      }
      expect(sim.delivered, `${shape} delivered nothing`).toBeGreaterThan(0);
    }
  });

  it('tags shelves by zone and sends each zone its share of orders', () => {
    const spec: WorldSpec = {
      ...DEFAULT_SPEC,
      aisles: 3,
      zones: [
        { name: 'Cold storage', aisles: 1, share: 0.8 },
        { name: 'Ambient', aisles: 2 },
      ],
    };
    const world = compileWorld(spec);
    expect(world.zones.map((z) => z.name)).toEqual(['Cold storage', 'Ambient']);
    expect(world.shelves.filter((s) => s.zone === 'Cold storage')).toHaveLength(DEFAULT_SPEC.shelvesPerAisle * 2);
    expect(world.shelves.every((s) => s.zone)).toBe(true);
    const sim = new Sim(world, 5);
    for (let t = 0; t < 1500; t++) sim.step();
    const cold = sim.orders.filter((o) => o.shelf.zone === 'Cold storage').length / sim.orders.length;
    expect(cold).toBeGreaterThan(0.7);
    expect(cold).toBeLessThan(0.9);
  });

  it('is deterministic with zones and a shape', () => {
    const world = compileWorld({ ...DEFAULT_SPEC, shape: 'L', aisles: 4, zones: [{ name: 'Bulk', aisles: 2, share: 0.6 }] });
    const scenario = { seed: 9, ticks: 900, events: [] };
    expect(runScenario(world, scenario)).toEqual(runScenario(world, scenario));
  });

  it('sends layout mistakes back to the Architect in words it can act on', () => {
    const over = validateWorld(
      compileWorld({
        ...DEFAULT_SPEC,
        aisles: 2,
        zones: [
          { name: 'A', aisles: 2 },
          { name: 'B', aisles: 1 },
        ],
      }),
    );
    expect(over.some((i) => i.severity === 'error' && i.repair && i.message.includes('cover 3 aisles but the floor has 2'))).toBe(true);
    const narrowU = validateWorld(compileWorld({ ...DEFAULT_SPEC, aisles: 2, shape: 'U' }));
    expect(narrowU.some((i) => i.repair && i.message.includes('needs at least 3 aisles'))).toBe(true);
    const greedy = validateWorld(
      compileWorld({
        ...DEFAULT_SPEC,
        zones: [
          { name: 'A', aisles: 1, share: 0.7 },
          { name: 'B', aisles: 1, share: 0.6 },
        ],
      }),
    );
    expect(greedy.some((i) => i.message.includes('130%'))).toBe(true);
  });

  it('reads a shape and zones from a prompt without keys', () => {
    const spec = warehouse.rules.spec('An L-shaped warehouse with four robots, a cold storage zone and a hazmat area');
    expect(spec.shape).toBe('L');
    expect(spec.zones?.map((z) => z.name)).toEqual(['Cold storage', 'Hazmat']);
    expect(errors(spec)).toEqual([]);
  });

  it('offers the rectangle as a variant only when the floor has a shape', () => {
    const titles = (spec: WorldSpec) => warehouse.variants(compileWorld(spec), spec).map((v) => v.title);
    expect(titles(DEFAULT_SPEC)).not.toContain('Rectangular floor');
    expect(titles({ ...DEFAULT_SPEC, shape: 'L' })).toContain('Rectangular floor');
  });
});
