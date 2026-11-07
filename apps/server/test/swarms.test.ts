import type { Usage } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { runCouncil } from '../src/swarms';
import { isolateEnv, json, mockFetch } from './helpers';

isolateEnv();

describe('Swarms council', () => {
  it('reads proposals and the exact cost from a swarm response', async () => {
    process.env.SWARMS_API_KEY = 'key';
    let body: { swarm_type?: string; agents?: unknown[] } = {};
    mockFetch((_, init) => {
      body = JSON.parse(init.body as string);
      return json({
        job_id: 'swarm-1',
        status: 'success',
        output: [
          { role: 'User', content: 'Incident at tick 100' },
          { role: 'DispatchLead', content: '```json\n{"title":"Rezone"}\n```' },
          { role: 'CapacityLead', content: [{ text: '{"title":"Spare"}' }] },
        ],
        usage: { input_tokens: 900, output_tokens: 300, total_cost: 0.0123 },
      });
    });
    const usage: Usage[] = [];
    const replies = await runCouncil({
      name: 'council',
      task: 't',
      model: 'm',
      feature: 'f',
      onUsage: (u) => usage.push(u),
      agents: [
        { agent_name: 'DispatchLead', system_prompt: 'a' },
        { agent_name: 'CapacityLead', system_prompt: 'b' },
      ],
    });
    expect(body.swarm_type).toBe('ConcurrentWorkflow');
    expect(body.agents).toHaveLength(2);
    expect(replies).toEqual([
      { agent: 'DispatchLead', json: { title: 'Rezone' } },
      { agent: 'CapacityLead', json: { title: 'Spare' } },
    ]);
    expect(usage[0]).toMatchObject({ engine: 'swarms', costUsd: 0.0123, inputTokens: 900 });
  });
});
