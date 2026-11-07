import { describe, expect, it } from 'vitest';
import { evaluate } from '../src';
import { software } from '../src/domains/software';
import { SystemPatchSchema, type SystemSpec } from '../src/domains/software/schema';
import { SystemRun } from '../src/domains/software/system';

const ZONES = ['east-a', 'east-b'];

const zoned = (dbZones = ['east-a']): SystemSpec => ({
  traffic: 300,
  retries: 2,
  nodes: [
    { id: 'users', kind: 'client' },
    { id: 'gateway', kind: 'gateway', replicas: 2, zones: ZONES },
    { id: 'api', kind: 'service', replicas: 4, zones: ZONES },
    { id: 'db', kind: 'database', replicas: dbZones.length, zones: dbZones },
  ],
  edges: [
    { from: 'users', to: 'gateway' },
    { from: 'gateway', to: 'api' },
    { from: 'api', to: 'db' },
  ],
});

const ticks = 120;
const loseEast = [{ at: 30, incident: { type: 'zone_down', target: 'east-a' } }];

describe('software zones', () => {
  it('changes nothing for a design without zones', () => {
    const spec = zoned();
    const plain: SystemSpec = { ...spec, nodes: spec.nodes.map(({ zones: _, ...n }) => n) };
    const run = new SystemRun(plain, 1);
    run.inject({ type: 'zone_down', target: 'east-a' });
    for (let i = 0; i < 30; i++) run.step();
    expect(run.success).toBeGreaterThan(0.99);
  });

  it('takes down whatever runs only in the lost zone, and halves what is spread', () => {
    const run = new SystemRun(zoned(), 1);
    run.inject({ type: 'zone_down', target: 'east-a' });
    expect(run.states.get('db')!.alive).toBe(0);
    expect(run.states.get('api')!.alive).toBe(0.5);
    for (let i = 0; i < 30; i++) run.step();
    expect(run.success).toBeLessThan(0.1);
    run.inject({ type: 'recover', target: 'east-a' });
    for (let i = 0; i < 30; i++) run.step();
    expect(run.success).toBeGreaterThan(0.99);
  });

  it('rides out a zone loss when the database runs in both zones', () => {
    const fragile = evaluate(software, zoned(), { seed: 1, ticks, events: loseEast });
    const spread = evaluate(software, zoned(ZONES), { seed: 1, ticks, events: loseEast });
    expect(fragile.score).toBeLessThan(80);
    expect(spread.score).toBeGreaterThan(99);
  });

  it('recovers when a stranded node is added to the surviving zone', () => {
    const lost = evaluate(software, zoned(), { seed: 1, ticks, events: loseEast });
    const options = software.rules.recoveries(zoned(), loseEast[0].incident);
    expect(options[0].title).toContain('east-b');
    const fixed = evaluate(software, zoned(), { seed: 1, ticks, events: [...loseEast, { at: 40, patches: options[0].patches }] });
    expect(fixed.score).toBeGreaterThan(lost.score + 20);
    for (const option of options) for (const patch of option.patches) expect(SystemPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('warns about co-located replicas and a zone list longer than the replicas', () => {
    const spec = zoned();
    spec.nodes[2] = { id: 'api', kind: 'service', replicas: 3, zones: ['east-a'] };
    spec.nodes[3] = { id: 'db', kind: 'database', replicas: 1, zones: ZONES };
    const messages = software.validate(spec).map((i) => i.message);
    expect(messages).toContain('api runs only in east-a: losing that zone takes it down');
    expect(messages).toContain('db lists 2 zones but has 1 replica, so it only runs in east-a');
  });

  it('leads the Red Team with the zone that strands the most', () => {
    const [first] = software.rules.hypotheses(zoned());
    expect(first.incident).toEqual({ type: 'zone_down', target: 'east-a' });
    expect(first.claim).toContain('db');
  });

  it('offers a zone outage to break, and replays it exactly', () => {
    const live = software.createRun(zoned(), 1);
    const zone = live.breakables().find((b) => b.incident.type === 'zone_down');
    expect(zone).toBeDefined();
    for (let i = 0; i < 20; i++) live.step();
    live.inject(zone!.incident);
    for (let i = 0; i < 40; i++) live.step();
    expect(evaluate(software, zoned(), { seed: 1, ticks: live.tick, events: live.log })).toEqual(live.evaluation());
  });

  it('builds a zoned fallback when the prompt mentions regions', () => {
    const spec = software.rules.spec('A payment system running in two availability zones');
    expect(spec.nodes.find((n) => n.kind === 'service')?.zones).toEqual(['zone-a', 'zone-b']);
    expect(software.validate(spec).filter((i) => i.severity === 'error')).toEqual([]);
    expect(software.rules.hypotheses(spec)[0].incident.type).toBe('zone_down');
  });
});
