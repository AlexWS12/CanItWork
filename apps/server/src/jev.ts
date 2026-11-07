import type { KeyCheck, Usage } from '@tv/core';
import { TypeSafeClient, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk';
import { probe } from './llm';

const env = () => process.env;
const apiKey = () => env().TYPESAFE_API_KEY?.trim() || '';
const baseURL = () => env().TYPESAFE_BASE_URL?.trim() || 'https://api.typesafe.ai';

export const hasJev = () => Boolean(apiKey());

export const jevCheck = (): Promise<KeyCheck> => (apiKey() ? probe(`${baseURL()}/v1/models`, apiKey(), { authorization: `Bearer ${apiKey()}` }) : Promise.resolve('unchecked'));

// A fresh client per call, so a key edited in .env applies on the next request. The SDK default of
// three 10s attempts would hold up the Gemini fallback for half a minute when Jev is down.
// Fetch is looked up at call time so tests can stub it.
const client = () => new TypeSafeClient({ apiKey: apiKey(), baseURL: baseURL(), timeout: 5_000, retry: { maxRetries: 1 }, fetch: (url, init) => fetch(url, init) });

export async function askJev<Q extends Questions>(opts: {
  state: SystemOneRequest['state'];
  questions: Q;
  feature: string;
  onUsage: (usage: Usage) => void;
}): Promise<SystemOneResult<Q>['answers']> {
  const result = await client().systemOne({ state: opts.state, questions: opts.questions });
  opts.onUsage({
    engine: 'jev',
    model: result.model,
    via: 'typesafe',
    inputTokens: result.usage.input_tokens ?? 0,
    outputTokens: result.usage.output_tokens ?? 0,
    costUsd: null,
    costSavedUsd: null,
    cacheHit: null,
    routedModel: null,
    receipt: null,
    feature: opts.feature,
  });
  return result.answers;
}
