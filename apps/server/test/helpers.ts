import { DOMAINS, type Usage } from '@tv/core';
import { afterEach, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { chatJson } from '../src/llm';
import { resetCouncil } from '../src/swarms';

const ENV = ['PRUNE_API_KEY', 'GEMINI_API_KEY', 'SWARMS_API_KEY', 'SWARMS_MODEL', 'REDTEAM_MODEL', 'SWARMS_KEEP_USD', 'TYPESAFE_API_KEY'];
export const schema = z.object({ ok: z.boolean() });
export const DEFAULT_SPEC = DOMAINS.warehouse.rules.spec('a warehouse');
export const openAiReply = (content: string, extra: object = {}) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
  ...extra,
});
export const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

// A /v1/systemone reply for the Interpreter: the domain Choice and one fit Noul per domain.
export function jevDomainReply(pick: string, probabilities: Record<string, number>, fits: Record<string, number>) {
  const confidence = Math.max(...Object.values(probabilities));
  const answers: Record<string, unknown> = { domain: { type: 'choice', choice: pick, confidence, probabilities } };
  for (const [id, p] of Object.entries(fits)) answers[`fits_${id}`] = { type: 'noul', noul: p };
  return json({ model: 'jev-latest', answers, usage: { input_tokens: 400, output_tokens: 5 } });
}

export function mockFetch(handler: (url: string, init: RequestInit) => Response, balance: number | Response = 9) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/account/credits')) return typeof balance === 'number' ? json({ total_credits: balance }) : balance;
    calls.push(url);
    return handler(url, init);
  });
  return calls;
}

export const ask = (usage: Usage[] = []) => chatJson({ system: 's', user: 'u', schema, feature: 'test', onUsage: (u) => usage.push(u) });

export function isolateEnv() {
  beforeEach(() => {
    ENV.forEach((k) => delete process.env[k]);
    resetCouncil();
  });
  afterEach(() => vi.unstubAllGlobals());
}
