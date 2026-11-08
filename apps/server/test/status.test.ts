import { beforeEach, describe, expect, it } from 'vitest';
import { resetChecks } from '../src/llm';
import { checkedStatus } from '../src/status';
import { isolateEnv, json, mockFetch } from './helpers';

isolateEnv();
beforeEach(() => resetChecks());

describe('key checks', () => {
  it('leaves everything unchecked when no keys are set', async () => {
    const calls = mockFetch(() => json({}));
    expect((await checkedStatus()).checks).toEqual({ gemini: 'unchecked', swarms: 'unchecked', prune: 'unchecked', typesafe: 'unchecked', storage: 'unchecked' });
    expect(calls).toEqual([]);
  });

  it('marks keys that the free endpoints accept as working', async () => {
    process.env.PRUNE_API_KEY = 'p';
    process.env.GEMINI_API_KEY = 'g';
    process.env.SWARMS_API_KEY = 's';
    process.env.TYPESAFE_API_KEY = 't';
    const calls = mockFetch(() => json({ data: [] }));
    expect((await checkedStatus()).checks).toEqual({ gemini: 'ok', swarms: 'ok', prune: 'ok', typesafe: 'ok', storage: 'unchecked' });
    expect(calls.every((url) => url.endsWith('/models'))).toBe(true);
  });

  it('flags a rejected key, and Gemini still works through the other route', async () => {
    process.env.PRUNE_API_KEY = 'p';
    process.env.GEMINI_API_KEY = 'g';
    mockFetch((url) => (url.includes('withprune') ? new Response('bad key', { status: 401 }) : json({ data: [] })));
    const { checks } = await checkedStatus();
    expect(checks?.prune).toBe('failing');
    expect(checks?.gemini).toBe('ok');
  });

  it('reports a rejected TypeSafe key as failing', async () => {
    process.env.TYPESAFE_API_KEY = 't';
    const calls = mockFetch(() => new Response('bad key', { status: 401 }));
    const status = await checkedStatus();
    expect(status.typesafe).toBe(true);
    expect(status.checks?.typesafe).toBe('failing');
    expect(calls).toEqual(['https://api.typesafe.ai/v1/models']);
  });

  it('reports a rejected Swarms key as failing', async () => {
    process.env.SWARMS_API_KEY = 's';
    mockFetch(() => json({}), new Response('nope', { status: 403 }));
    expect((await checkedStatus()).checks?.swarms).toBe('failing');
  });

  it('does not call a missing endpoint a failing key', async () => {
    process.env.PRUNE_API_KEY = 'p';
    mockFetch(() => new Response('not found', { status: 404 }));
    expect((await checkedStatus()).checks?.prune).toBe('unchecked');
  });

  it('answers without waiting on a slow check, then reports it on the next poll', async () => {
    process.env.SWARMS_API_KEY = 's';
    let release = () => {};
    mockFetch(() => json({}), new Promise<Response>((resolve) => (release = () => resolve(json({ total_credits: 9 })))) as unknown as Response);
    expect((await checkedStatus(10)).checks?.swarms).toBe('unchecked');
    release();
    expect((await checkedStatus(10)).checks?.swarms).toBe('ok');
  });

  it('checks each key once a minute, and again straight away after it changes', async () => {
    process.env.GEMINI_API_KEY = 'g';
    const calls = mockFetch(() => json({ data: [] }));
    await checkedStatus();
    await checkedStatus();
    expect(calls).toHaveLength(1);
    process.env.GEMINI_API_KEY = 'rotated';
    await checkedStatus();
    expect(calls).toHaveLength(2);
  });
});
