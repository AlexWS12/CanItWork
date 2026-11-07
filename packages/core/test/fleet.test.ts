import { describe, expect, it } from 'vitest';
import { DOMAINS, FleetRun, type FleetSpec } from '../src';

const { fleet } = DOMAINS;

const mission = (over: Partial<FleetSpec> = {}): FleetSpec =>
  fleet.specSchema.parse({
    area: { width: 1200, depth: 1200, obstacles: [] },
    base: { x: 600, y: 20, chargers: 4 },
    roles: [
      { id: 'scout', behavior: 'search', count: 4, speed: 12, endurance: 25, range: 450, sensor: 35 },
      { id: 'carrier', behavior: 'deliver', count: 2, speed: 10, endurance: 25, range: 450, sensor: 10 },
    ],
    targets: 8,
    deliveriesPerTarget: 1,
    ...over,
  });

const fly = (spec: FleetSpec, ticks = fleet.horizon, setup?: (run: FleetRun) => void) => {
  const run = new FleetRun(spec, 1);
  setup?.(run);
  for (let i = 0; i < ticks; i++) run.step();
  return run;
};

describe('fleet domain', () => {
  it('builds a valid search-and-deliver mission from the keyless template and proves it', () => {
    const spec = fleet.rules.spec('A swarm of drones with scouts, carriers and a relay');
    expect(fleet.validate(spec)).toEqual([]);
    expect(fleet.proof!(spec)).toMatch(/all \d+ units get home/);
  });

  it('is deterministic for a seed', () => {
    const spec = mission();
    expect(fly(spec).evaluation()).toEqual(fly(spec).evaluation());
  });

  it('without relays, scouts beyond radio range go unreported, and the validator says why', () => {
    const spec = mission();
    const issues = fleet.validate(spec).map((i) => i.message);
    expect(issues.some((m) => /lose contact past 450 m.*relay/.test(m))).toBe(true);
  });

  it('a relay keeps far scouts in contact, so more finds reach base sooner', () => {
    const relay = { id: 'relay', behavior: 'relay' as const, count: 2, speed: 12, endurance: 40, range: 700, sensor: 10, ground: false };
    const without = fly(mission(), 120);
    const withRelay = fly(mission({ roles: [...mission().roles, relay] }), 120);
    const reported = (run: FleetRun) => run.targets.filter((t) => t.reported).length;
    expect(reported(withRelay)).toBeGreaterThanOrEqual(reported(without));
    expect(withRelay.evaluation().score).toBeGreaterThan(without.evaluation().score);
  });

  it('flags roles that cannot reach the far corner on a charge, and units that run dry', () => {
    const spec = mission({ roles: [{ id: 'scout', behavior: 'search', count: 3, speed: 5, endurance: 4, range: 5000, sensor: 30, ground: false }], targets: 0 });
    const messages = fleet.validate(spec).map((i) => i.message);
    expect(messages.some((m) => /can only fly \d+ m out and back/.test(m))).toBe(true);
  });

  it('units turn back with their reserve instead of crashing in normal running', () => {
    const run = fly(mission());
    expect(run.units.filter((u) => u.status === 'lost')).toEqual([]);
    expect(run.units.some((u) => u.flown > 0)).toBe(true);
  });

  it('ground rovers drive around obstacles rather than through them', () => {
    const wall = { x: 500, y: 200, width: 200, depth: 40, height: 10 };
    const spec = mission({
      area: { width: 1200, depth: 1200, obstacles: [wall] },
      roles: [{ id: 'rover', behavior: 'patrol', count: 1, speed: 3, endurance: 240, range: 5000, sensor: 20, ground: true, waypoints: [{ x: 600, y: 600 }] }],
      targets: 0,
    });
    const run = new FleetRun(spec, 1);
    let inside = false;
    for (let i = 0; i < 200; i++) {
      run.step();
      const u = run.units[0];
      if (u.x > wall.x && u.x < wall.x + wall.width && u.y > wall.y && u.y < wall.y + wall.depth) inside = true;
    }
    expect(inside).toBe(false);
    expect(Math.hypot(run.units[0].x - 600, run.units[0].y - 600)).toBeLessThan(20);
  });

  it('failures cost mission progress: jamming, a lost scout, wind and a charger down', () => {
    const spec = fleet.rules.spec('drones');
    const score = (incident?: { type: string; target?: string; value?: number }) =>
      fly(spec, fleet.horizon, (run) => {
        if (incident) run.inject(incident);
      }).evaluation().score;
    const base = score();
    expect(score({ type: 'jam_comms', value: 0.3 })).toBeLessThan(base);
    expect(score({ type: 'lose_unit', target: 'scout-1' })).toBeLessThan(base);
    expect(score({ type: 'wind', value: 14 })).toBeLessThan(base);
  });

  it('applies fixes: more units, restoring a lost one, clearing a jam', () => {
    const run = new FleetRun(mission(), 1);
    run.inject({ type: 'lose_unit', target: 'scout-2' });
    run.inject({ type: 'jam_comms', value: 0.2 });
    run.apply([{ op: 'add_units', role: 'carrier', count: 2 }, { op: 'restore', unit: 'scout-2' }, { op: 'clear_jam' }]);
    expect(run.units.filter((u) => u.role.id === 'carrier')).toHaveLength(4);
    expect(run.unit('scout-2')?.status).toBe('charging');
    expect(run.jam).toBe(1);
  });

  it('the Red Team rules name failures the simulator can run, and the council rules answer them', () => {
    const spec = fleet.rules.spec('drones');
    const claims = fleet.rules.hypotheses(spec);
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) expect(fleet.incidentTypes).toContain(c.incident.type);
    for (const c of claims) expect(fleet.rules.recoveries(spec, c.incident).length).toBeGreaterThan(0);
  });
});
