import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEC, compileWorld } from '../src/domains/warehouse/compile';
import { WorldSpecSchema, type SimEvent, type WorldSpec } from '../src/domains/warehouse/schema';
import { Sim, runScenario } from '../src/domains/warehouse/sim';
import { validateWorld } from '../src/domains/warehouse/validate';
import { DOMAINS, evaluate, provenanceHash, type Environment } from '../src';

const world = compileWorld(DEFAULT_SPEC);
const TICKS = 1500;

function assertNoCollisions(sim: Sim, ticks: number) {
  for (let t = 0; t < ticks; t++) {
    const before = new Map(sim.robots.map((r) => [r.id, `${r.x},${r.y}`]));
    sim.step();
    const cells = new Map<string, string>();
    for (const r of sim.robots) {
      const key = `${r.x},${r.y}`;
      expect(cells.get(key), `tick ${t}: ${r.id} and ${cells.get(key)} share ${key}`).toBeUndefined();
      cells.set(key, r.id);
      expect(sim.grid.blocked[sim.grid.idx(r.x, r.y)], `${r.id} on an obstacle at tick ${t}`).toBe(0);
    }
    for (const a of sim.robots) {
      for (const b of sim.robots) {
        if (a === b) continue;
        const swapped = before.get(a.id) === `${b.x},${b.y}` && before.get(b.id) === `${a.x},${a.y}`;
        expect(swapped, `${a.id} and ${b.id} swapped at tick ${t}`).toBe(false);
      }
    }
  }
}

describe('world compiler', () => {
  it('produces a valid world across the whole spec range', () => {
    const specs: WorldSpec[] = [];
    for (const robots of [1, 3, 12]) {
      for (const aisles of [1, 3, 6]) {
        for (const conveyors of [1, 2]) {
          specs.push({ ...DEFAULT_SPEC, robots, aisles, conveyors, shelvesPerAisle: Math.min(12, robots + 2), chargers: 2, docks: 4 });
        }
      }
    }
    for (const spec of specs) {
      expect(WorldSpecSchema.safeParse(spec).success).toBe(true);
      const issues = validateWorld(compileWorld(spec)).filter((i) => i.severity === 'error');
      expect(issues).toEqual([]);
    }
  });
});

describe('simulator', () => {
  it('is deterministic for a seed', () => {
    const a = runScenario(world, { seed: 7, ticks: TICKS, events: [] });
    const b = runScenario(world, { seed: 7, ticks: TICKS, events: [] });
    expect(a).toEqual(b);
    const c = runScenario(world, { seed: 8, ticks: TICKS, events: [] });
    expect(c.metrics).not.toEqual(a.metrics);
  });

  it('never collides, in the default world or a crowded one', () => {
    assertNoCollisions(new Sim(world, 1), TICKS);
    const crowded = compileWorld({ ...DEFAULT_SPEC, robots: 12, aisles: 3, demand: 'heavy', dispatch: 'pooled' });
    assertNoCollisions(new Sim(crowded, 2), 600);
  });

  it('keeps moving after a robot fails mid-aisle', () => {
    const events: SimEvent[] = [{ type: 'fail_robot', at: 200, robotId: 'R2' }];
    assertNoCollisions(new Sim(world, 3, events), TICKS);
  });

  it('delivers steadily and every robot does real work', () => {
    const { metrics, series } = runScenario(world, { seed: 1, ticks: TICKS, events: [] });
    expect(metrics.delivered).toBeGreaterThan(TICKS / world.params.orderEvery / 2);
    expect(metrics.utilization).toBeGreaterThan(0.4);
    const late = series.at(-1)!;
    expect(late.throughput).toBeGreaterThan(0);
  });

  it('makes a robot failure hurt, and a zone rebalance help', () => {
    const scenario = { seed: 1, ticks: TICKS };
    const baseline = runScenario(world, { ...scenario, events: [] }).metrics;
    const fail: SimEvent = { type: 'fail_robot', at: 300, robotId: 'R2' };
    const broken = runScenario(world, { ...scenario, events: [fail] }).metrics;
    const recovered = runScenario(world, {
      ...scenario,
      events: [fail, { type: 'apply_patch', at: 340, patches: [{ op: 'reassign_zone', fromRobotId: 'R2' }] }],
    }).metrics;
    expect(broken.delivered).toBeLessThan(baseline.delivered);
    expect(recovered.delivered).toBeGreaterThan(broken.delivered);
  });

  it('stops delivering when the only belt blocks, and bypass restores flow', () => {
    const scenario = { seed: 1, ticks: TICKS };
    const block: SimEvent = { type: 'block_conveyor', at: 300, conveyorId: 'C1' };
    const blocked = runScenario(world, { ...scenario, events: [block] }).metrics;
    const bypassed = runScenario(world, {
      ...scenario,
      events: [block, { type: 'apply_patch', at: 340, patches: [{ op: 'set_policy', conveyorBypass: true }] }],
    }).metrics;
    expect(bypassed.delivered).toBeGreaterThan(blocked.delivered * 1.5);
  });

  it('moves work to the other belt when one of two blocks', () => {
    const twoBelts = compileWorld({ ...DEFAULT_SPEC, robots: 6, conveyors: 2 });
    const scenario = { seed: 1, ticks: TICKS };
    const baseline = runScenario(twoBelts, { ...scenario, events: [] }).metrics;
    const blocked = runScenario(twoBelts, {
      ...scenario,
      events: [{ type: 'block_conveyor', at: 300, conveyorId: 'C1' }],
    }).metrics;
    expect(blocked.delivered).toBeGreaterThan(baseline.delivered * 0.7);
  });

  it('charges robots rather than letting them die in normal running', () => {
    const sim = new Sim(world, 1);
    let charged = false;
    for (let i = 0; i < 2500; i++) {
      sim.step();
      if (sim.robots.some((r) => r.mode === 'charging')) charged = true;
    }
    expect(charged).toBe(true);
    expect(sim.robots.filter((r) => r.mode === 'failed')).toEqual([]);
  });

  it('adds a robot mid-run', () => {
    const sim = new Sim(world, 1, [{ type: 'apply_patch', at: 100, patches: [{ op: 'add_robot' }] }]);
    for (let i = 0; i < 400; i++) sim.step();
    expect(sim.robots).toHaveLength(4);
  });

  it('hashes a run so a tampered environment is detectable', () => {
    const scenario = { seed: 1, ticks: 300, events: [] };
    const domain = DOMAINS.warehouse;
    const environment: Environment = { domain: 'warehouse', name: 'a', summary: 'b', spec: DEFAULT_SPEC, unmodelled: [] };
    const result = evaluate(domain, domain.compile(DEFAULT_SPEC), scenario);
    const original = provenanceHash(environment, scenario, result);
    expect(provenanceHash(environment, scenario, result)).toBe(original);
    const tampered = { ...environment, spec: { ...DEFAULT_SPEC, chargers: 2 } };
    expect(provenanceHash(tampered, scenario, result)).not.toBe(original);
  });
});
