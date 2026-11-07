import { describe, expect, it } from 'vitest';
import { DOMAINS, SystemRun, evaluate, type SystemSpec } from '../src';

const { software } = DOMAINS;

const threeTier = (overrides: Partial<SystemSpec> = {}): SystemSpec => ({
  traffic: 300,
  retries: 2,
  nodes: [
    { id: 'users', kind: 'client' },
    { id: 'gateway', kind: 'gateway', replicas: 2 },
    { id: 'api', kind: 'service', replicas: 3 },
    { id: 'db', kind: 'database' },
    { id: 'events', kind: 'queue' },
    { id: 'worker', kind: 'service', replicas: 2 },
  ],
  edges: [
    { from: 'users', to: 'gateway' },
    { from: 'gateway', to: 'api' },
    { from: 'api', to: 'db' },
    { from: 'api', to: 'events', mode: 'async' },
    { from: 'events', to: 'worker', mode: 'async' },
  ],
  ...overrides,
});

describe('software', () => {
  const ticks = 120;
  const healthy = evaluate(software, threeTier(), { seed: 1, ticks, events: [] });

  it('serves everything when healthy', () => {
    expect(healthy.score).toBeGreaterThan(99);
  });

  it('cascades a database failure to the client, and failover restores it', () => {
    const events = [{ at: 30, incident: { type: 'node_down', target: 'db' } }];
    const down = evaluate(software, threeTier(), { seed: 1, ticks, events });
    expect(down.score).toBeLessThan(60);
    const failedOver = evaluate(software, threeTier(), { seed: 1, ticks, events: [...events, { at: 45, patches: [{ op: 'failover', node: 'db' }] }] });
    expect(failedOver.score).toBeGreaterThan(down.score + 20);
  });

  it('keeps serving through a queue when the consumer dies, while the backlog grows', () => {
    const run = new SystemRun(threeTier(), 1);
    run.inject({ type: 'node_down', target: 'worker' });
    for (let i = 0; i < 60; i++) run.step();
    expect(run.success).toBeGreaterThan(0.95);
    expect(run.states.get('events')!.backlog).toBeGreaterThan(1000);
  });

  it('amplifies load with retries when a dependency is failing', () => {
    const load = (retries: number) => {
      const run = new SystemRun(threeTier({ retries }), 1);
      run.inject({ type: 'node_down', target: 'db' });
      for (let i = 0; i < 20; i++) run.step();
      return run.states.get('db')!.inflow;
    };
    expect(load(3)).toBeGreaterThan(load(0) * 2);
  });

  it('refuses a cycle rather than simulating nonsense', () => {
    const spec = threeTier();
    spec.edges.push({ from: 'db', to: 'api' });
    expect(software.validate(spec).some((i) => i.severity === 'error' && i.message.includes('cycle'))).toBe(true);
  });

  it('names a single point of failure', () => {
    expect(software.validate(threeTier()).some((i) => i.message.includes('db is a single point of failure'))).toBe(true);
  });
});
