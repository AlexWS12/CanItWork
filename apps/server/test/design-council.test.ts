import type { StreamEvent } from '@tv/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { build } from '../src/agents';
import { resetDesignCouncil } from '../src/design-council';
import { DEFAULT_SPEC, isolateEnv, json, mockFetch, openAiReply } from './helpers';

describe('design council', () => {
  isolateEnv();
  beforeEach(() => {
    delete process.env.DESIGN_COUNCIL;
    resetDesignCouncil();
  });

  const collect = () => {
    const events: StreamEvent[] = [];
    return { events, emit: (e: StreamEvent) => void events.push(e) };
  };
  const draft = (robots: number) => JSON.stringify({ name: `${robots} robots`, summary: 's', spec: { ...DEFAULT_SPEC, robots, demand: 'heavy' } });

  // Swarms answers the design council with three designs, one unreadable, and the Red Team with one claim.
  const swarms = (councilCalls: { n: number }, councilStatus = 200) =>
    mockFetch((url, init) => {
      const body = String(init.body);
      if (url.includes('swarms') && body.includes('Design Council')) {
        councilCalls.n++;
        if (councilStatus !== 200) return new Response('boom', { status: councilStatus });
        return json({
          output: [
            { role: 'Literalist', content: draft(1) },
            { role: 'Engineer', content: draft(6) },
            { role: 'Builder', content: 'I think a warehouse is nice' },
          ],
          usage: { total_cost: 0.02 },
        });
      }
      if (url.includes('swarms')) {
        const claim = { claim: 'The belt is a choke point', incident: { type: 'block_conveyor', target: 'C1' } };
        return json({ output: [{ role: 'RedTeam', content: JSON.stringify({ hypotheses: [claim] }) }], usage: { total_cost: 0.01 } });
      }
      if (body.includes('You route requests')) return json(openAiReply(JSON.stringify({ domain: 'warehouse', reason: 'r' })));
      return json(openAiReply(draft(2)));
    });

  const steps = (events: StreamEvent[]) => events.flatMap((e) => (e.type === 'step' && e.status === 'done' ? [e] : []));
  const environment = (events: StreamEvent[]) => events.flatMap((e) => (e.type === 'environment' ? [e.environment] : []))[0];

  it('builds the design the simulator scores best, and shows the leaderboard', async () => {
    process.env.GEMINI_API_KEY = 'g';
    process.env.SWARMS_API_KEY = 'key';
    process.env.DESIGN_COUNCIL = 'on';
    const calls = { n: 0 };
    swarms(calls);
    const { events, emit } = collect();
    await build('a busy warehouse', emit);
    expect(calls.n).toBe(1);
    const council = steps(events).find((s) => s.title === 'Convening the design council');
    expect(council?.engine).toBe('swarms');
    expect(council?.detail).toMatch(/Engineer \d+/);
    expect(council?.detail).toMatch(/Builder no design/);
    expect(council?.detail).toMatch(/picked the Engineer's design/);
    expect((environment(events)?.spec as { robots: number }).robots).toBe(6);
  });

  it('mends a design that misses the schema instead of dropping that architect', async () => {
    process.env.GEMINI_API_KEY = 'g';
    process.env.SWARMS_API_KEY = 'key';
    process.env.DESIGN_COUNCIL = 'on';
    let mends = 0;
    mockFetch((url, init) => {
      const body = String(init.body);
      if (url.includes('swarms') && body.includes('Design Council')) {
        const slipped = JSON.stringify({ name: 'Slipped', summary: 's', spec: { ...DEFAULT_SPEC, robots: 'nine' } });
        return json({
          output: [
            { role: 'Literalist', content: draft(1) },
            { role: 'Engineer', content: slipped },
          ],
          usage: { total_cost: 0.02 },
        });
      }
      if (url.includes('swarms'))
        return json({ output: [{ role: 'RedTeam', content: JSON.stringify({ hypotheses: [{ claim: 'c', incident: { type: 'block_conveyor', target: 'C1' } }] }) }] });
      if (body.includes('You route requests')) return json(openAiReply(JSON.stringify({ domain: 'warehouse', reason: 'r' })));
      if (body.includes("doesn't match the schema")) {
        mends++;
        return json(openAiReply(draft(9)));
      }
      return json(openAiReply(draft(2)));
    });
    const { events, emit } = collect();
    await build('a busy warehouse', emit);
    expect(mends).toBe(1);
    const council = steps(events).find((s) => s.title === 'Convening the design council');
    expect(council?.detail).toMatch(/Engineer \d+, mended/);
  });

  it('falls back to the single Architect when the council fails', async () => {
    process.env.GEMINI_API_KEY = 'g';
    process.env.SWARMS_API_KEY = 'key';
    process.env.DESIGN_COUNCIL = 'on';
    swarms({ n: 0 }, 500);
    const { events, emit } = collect();
    await build('a busy warehouse', emit);
    expect((environment(events)?.spec as { robots: number }).robots).toBe(2);
  });

  it('stays off unless DESIGN_COUNCIL is on, so ordinary builds spend nothing extra', async () => {
    process.env.GEMINI_API_KEY = 'g';
    process.env.SWARMS_API_KEY = 'key';
    const calls = { n: 0 };
    swarms(calls);
    const { emit } = collect();
    await build('a busy warehouse', emit);
    expect(calls.n).toBe(0);
  });
});
