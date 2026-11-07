import { DOMAINS, type Usage } from '@tv/core';
import { afterEach, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { chatJson } from '../src/llm';
import { resetCouncil } from '../src/swarms';

const ENV = ['PRUNE_API_KEY', 'GEMINI_API_KEY', 'SWARMS_API_KEY', 'SWARMS_MODEL', 'REDTEAM_MODEL', 'SWARMS_KEEP_USD'];
export const schema = z.object({ ok: z.boolean() });
export const DEFAULT_SPEC = DOMAINS.warehouse.rules.spec('a warehouse');
export const openAiReply = (content: string, extra: object = {}) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
  ...extra,
});
export const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

export function mockFetch(handler: (url: string, init: RequestInit) => Response, balance: number | Response = 9) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/account/credits')) return typeof balance === 'number' ? json({ total_credits: balance }) : balance;
    calls.push(url);
    return handler(url, init);
  });
  return calls;
}

export const ask = (usage: Usage[] = []) =>
  chatJson({ system: 's', user: 'u', schema, feature: 'test', onUsage: (u) => usage.push(u) });

export function isolateEnv() {
  beforeEach(() => {
    ENV.forEach((k) => delete process.env[k]);
    resetCouncil();
  });
  afterEach(() => vi.unstubAllGlobals());
}
