import { DOMAINS, type Environment, type RecoveryReport, type StreamEvent } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { recover } from '../src/agents';
import { isolateEnv } from './helpers';

isolateEnv();

const spec = DOMAINS.software.specSchema.parse({
  traffic: 300,
  retries: 2,
  nodes: [
    { id: 'users', kind: 'client' },
    { id: 'gateway', kind: 'gateway', replicas: 2 },
    { id: 'api', kind: 'service', replicas: 3 },
    { id: 'db', kind: 'database', replicas: 2, capacity: 2000 },
  ],
  edges: [
    { from: 'users', to: 'gateway' },
    { from: 'gateway', to: 'api' },
    { from: 'api', to: 'db' },
  ],
});
const environment: Environment = { domain: 'software', name: 'shop', summary: 's', spec, unmodelled: [] };

const reportOf = (events: StreamEvent[]) => {
  const event = events.find((e) => e.type === 'recovery');
  return event?.type === 'recovery' ? event.report : null;
};

describe('what each fix costs', () => {
  it('prices every recovery and recommends the cheapest of those that tie on the result', async () => {
    const events: StreamEvent[] = [];
    await recover({ environment, seed: 1, tick: 60, events: [{ at: 40, incident: { type: 'traffic_spike', value: 3 } }] }, (e) => void events.push(e));
    const report = reportOf(events) as RecoveryReport;
    expect(report.candidates.length).toBeGreaterThan(1);
    for (const c of report.candidates) expect(typeof c.monthly, c.title).toBe('number');
    const scale = report.candidates.find((c) => c.title === 'Scale every service')!;
    // Three replicas to nine: six more at $30 a month.
    expect(scale.monthly).toBe(180);
    expect(report.candidates.find((c) => c.title === 'Stop retrying')!.monthly).toBeLessThanOrEqual(0);
    const best = report.candidates[0].evaluation.score;
    const tolerance = Math.max(1, report.reference.score * 0.01);
    const tied = report.candidates.filter((c) => c.evaluation.score >= best - tolerance);
    const cheapest = [...tied].sort((a, b) => a.monthly! - b.monthly!)[0];
    expect(report.valueId).toBe(cheapest.id);
  });
});
