import type { KeyCheck, ProviderStatus, Usage } from '@tv/core';
import type { z } from 'zod';
import { record } from './spend';

const GEMINI_DIRECT = 'https://generativelanguage.googleapis.com/v1beta/openai';

const env = () => process.env;
const pruneKey = () => env().PRUNE_API_KEY?.trim() || '';
const pruneBase = () => env().PRUNE_BASE_URL?.trim() || 'https://api.withprune.com/v1';
const geminiModel = () => env().GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';

export class NoCredentials extends Error {}

const MAX_WAIT_MS = 20_000;

class ProviderBusy extends Error {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message);
  }
}

function waitFor(res: Response, body: string) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const delay = body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1];
  return delay ? Number(delay) * 1000 : 2000;
}

export class ShieldBlock extends Error {
  constructor(readonly code: string) {
    super(`Prune Shield blocked this request (${code})`);
  }
}

interface Route {
  url: string;
  key: string;
  via: 'prune' | 'direct';
}

// When Prune's own upstream Gemini key is out of quota, every call through it fails before falling back, so Prune rests for a while instead.
const PRUNE_REST_MS = 10 * 60 * 1000;
let pruneRestUntil = 0;
let pruneProblem: string | null = null;
export const resetPruneRest = () => {
  pruneRestUntil = 0;
  pruneProblem = null;
};
// Why calls are going direct instead of through Prune right now, or null when they aren't.
export const pruneBypass = () => (pruneResting() ? `Prune's vaulted Gemini ${(pruneProblem ?? 'key is failing').replace(/\s*\(.*\)$/, '')}` : null);
export const pruneResting = () => Boolean(pruneKey()) && Date.now() < pruneRestUntil;

// Prune itself answers, but the Gemini key vaulted in it is out of quota or rejected, so every call through it would fail.
function pruneUpstreamProblem(error: string): string | null {
  if (/HTTP 429/.test(error) && /provider_upstream|exceeded your current quota/.test(error)) return 'quota is exhausted';
  if (/HTTP 40[13]/.test(error) && /provider_upstream|rejected the API key/.test(error)) return 'key is rejected (vault a working key in the Prune dashboard)';
  return null;
}

function routes(): Route[] {
  const out: Route[] = [];
  if (pruneKey() && Date.now() >= pruneRestUntil) out.push({ url: pruneBase(), key: pruneKey(), via: 'prune' });
  // Several direct keys can be comma-separated; a quota error on one moves on to the next.
  for (const key of (env().GEMINI_API_KEY ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean))
    out.push({ url: GEMINI_DIRECT, key, via: 'direct' });
  return out;
}

export function geminiStatus(): Omit<ProviderStatus, 'typesafe' | 'checks'> {
  return {
    gemini: routes()[0]?.via ?? 'off',
    swarms: Boolean(env().SWARMS_API_KEY?.trim()),
    prune: Boolean(pruneKey()),
  };
}

export const hasGemini = () => routes().length > 0;

const CHECK_TTL_MS = 60_000;
const checked = new Map<string, { at: number; result: Promise<KeyCheck> }>();

// Calls a free endpoint to see whether a key works. Results are cached per URL and key, so a rotated key is checked afresh.
export function probe(url: string, key: string, headers: Record<string, string>): Promise<KeyCheck> {
  const id = `${url} ${key}`;
  const hit = checked.get(id);
  if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.result;
  const result = fetch(url, { headers, signal: AbortSignal.timeout(5_000) }).then(
    (res): KeyCheck => (res.ok ? 'ok' : res.status === 401 || res.status === 403 ? 'failing' : 'unchecked'),
    (): KeyCheck => 'failing',
  );
  checked.set(id, { at: Date.now(), result });
  return result;
}

export function resetChecks() {
  checked.clear();
}

export async function routeChecks(): Promise<Partial<Record<Route['via'], KeyCheck>>> {
  const entries = await Promise.all(routes().map(async (r) => [r.via, await probe(`${r.url}/models`, r.key, { authorization: `Bearer ${r.key}` })] as const));
  return Object.fromEntries(entries);
}

export const architectModel = () => env().ARCHITECT_MODEL?.trim() || geminiModel();
// Repairs are the hard cases (a miswired adder), so they can use a stronger model than first drafts; it falls back like the Architect's.
export const repairModel = () => env().ARCHITECT_REPAIR_MODEL?.trim() || architectModel();

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// Free-tier keys allow ~15 requests a minute per model. GEMINI_RPM spaces calls on each direct key so they stay under it.
const nextSlot = new Map<string, number>();
async function pace(route: Route) {
  const rpm = Number(env().GEMINI_RPM);
  if (route.via !== 'direct' || !(rpm > 0)) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(route.key) ?? 0);
  nextSlot.set(route.key, at + 60_000 / rpm);
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

async function complete(route: Route, model: string, messages: Array<{ role: string; content: string }>, feature: string): Promise<{ text: string; usage: Usage }> {
  await pace(route);
  const result = await send(route, model, messages, feature);
  record(result.usage);
  return result;
}

async function send(route: Route, model: string, messages: Array<{ role: string; content: string }>, feature: string): Promise<{ text: string; usage: Usage }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${route.key}`,
  };
  if (route.via === 'prune') {
    headers['X-Prune-Feature-Id'] = feature;
    // Semantic cache hits ignore numbers in prompts, so asking for nine returned a cached five.
    headers['X-Prune-Cache'] = 'off';
  }
  const res = await fetch(`${route.url}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, temperature: 0.4, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(90_000),
  });
  const shield = res.headers.get('x-prune-shield-code');
  if (shield) throw new ShieldBlock(shield);
  if (!res.ok) {
    const body = await res.text();
    const message = `gemini via ${route.via}: HTTP ${res.status} ${body.slice(0, 200)}`;
    if (res.status === 429 || res.status === 503) throw new ProviderBusy(message, res.status === 503 ? 1500 : waitFor(res, body));
    throw new Error(message);
  }

  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    prune_metadata?: Record<string, unknown>;
  };
  const text = body.choices?.[0]?.message?.content ?? body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
  if (!text) throw new Error(`gemini via ${route.via}: empty response`);
  const meta = body.prune_metadata;
  const original = num(meta?.original_tokens);
  const optimized = num(meta?.optimized_tokens);
  const withPrune = num(meta?.cost_with_prune_usd);
  const saved = num(meta?.cost_saved_usd ?? res.headers.get('x-prune-cost-saved'));
  const applied = meta?.optimizations_applied;
  return {
    text,
    usage: {
      engine: 'gemini',
      model,
      via: route.via,
      inputTokens: body.usage?.prompt_tokens ?? body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usage?.completion_tokens ?? body.usageMetadata?.candidatesTokenCount ?? 0,
      costUsd: withPrune,
      costSavedUsd: saved,
      cacheHit: meta?.cache_hit !== undefined ? Boolean(meta.cache_hit) : res.headers.has('x-prune-cache-hit') ? res.headers.get('x-prune-cache-hit') === 'true' : null,
      routedModel: meta?.route_applied ? String(meta.routed_model) : null,
      receipt: meta ?? null,
      feature,
      tokensSaved: num(meta?.tokens_saved) ?? (original !== null && optimized !== null ? Math.max(0, original - optimized) : null),
      costWithoutUsd: num(meta?.cost_without_prune_usd) ?? (withPrune !== null && saved !== null ? withPrune + saved : null),
      optimizations: Array.isArray(applied) ? applied.map(String) : typeof applied === 'string' ? applied.split(/[,\s]+/).filter(Boolean) : undefined,
      signed: Boolean(meta?.receipt_signature),
    },
  };
}

async function completeWithRetry(...args: Parameters<typeof complete>) {
  try {
    return await complete(...args);
  } catch (error) {
    if (args[0].via !== 'direct' || !(error instanceof ProviderBusy) || error.waitMs > MAX_WAIT_MS) throw error;
    await new Promise((resolve) => setTimeout(resolve, error.waitMs));
    return complete(...args);
  }
}

function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('No JSON found in model reply');
  return JSON.parse(trimmed.slice(start, end + 1));
}

export { extractJson };

interface ChatOptions<S extends z.ZodTypeAny> {
  system: string;
  user: string;
  schema: S;
  feature: string;
  model?: string;
  onUsage: (usage: Usage) => void;
}

// A stronger model can be asked for, such as the Architect's; when it is busy or failing, the default model answers instead of the build failing.
export async function chatJson<S extends z.ZodTypeAny>(opts: ChatOptions<S>): Promise<z.infer<S>> {
  try {
    return await chatOnce(opts);
  } catch (error) {
    if (error instanceof ShieldBlock || error instanceof NoCredentials || !opts.model || opts.model === geminiModel()) throw error;
    console.warn(`[llm] ${opts.model} failed, falling back to ${geminiModel()}`);
    return chatOnce({ ...opts, model: geminiModel() });
  }
}

async function chatOnce<S extends z.ZodTypeAny>(opts: ChatOptions<S>): Promise<z.infer<S>> {
  const available = routes();
  if (!available.length) throw new NoCredentials('Gemini has no credentials');
  const model = opts.model ?? geminiModel();
  const messages = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];

  let lastError: unknown;
  for (const route of available) {
    try {
      const first = await completeWithRetry(route, model, messages, opts.feature);
      opts.onUsage(first.usage);
      let problem = '';
      try {
        const parsed = opts.schema.safeParse(extractJson(first.text));
        if (parsed.success) return parsed.data;
        problem = JSON.stringify(parsed.error.issues.slice(0, 5));
      } catch (error) {
        problem = String(error);
      }
      const repair = await complete(
        route,
        model,
        [...messages, { role: 'assistant', content: first.text }, { role: 'user', content: `That JSON was invalid: ${problem}. Reply with corrected JSON only.` }],
        `${opts.feature}-repair`,
      );
      opts.onUsage(repair.usage);
      return opts.schema.parse(extractJson(repair.text));
    } catch (error) {
      if (error instanceof ShieldBlock) throw error;
      const upstream = route.via === 'prune' ? pruneUpstreamProblem(String(error)) : null;
      if (upstream) {
        pruneRestUntil = Date.now() + PRUNE_REST_MS;
        pruneProblem = upstream;
        console.warn(`[llm] Prune's upstream Gemini ${upstream}; going direct for 10 minutes`);
      } else console.warn(`[llm] gemini via ${route.via} failed:`, String(error));
      lastError = error;
    }
  }
  throw lastError;
}
