import type { ProviderStatus, Usage } from '@tv/core';
import type { z } from 'zod';

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

function routes(): Route[] {
  const out: Route[] = [];
  if (pruneKey()) out.push({ url: pruneBase(), key: pruneKey(), via: 'prune' });
  const direct = env().GEMINI_API_KEY?.trim();
  if (direct) out.push({ url: GEMINI_DIRECT, key: direct, via: 'direct' });
  return out;
}

export function providerStatus(): ProviderStatus {
  return {
    gemini: routes()[0]?.via ?? 'off',
    swarms: Boolean(env().SWARMS_API_KEY?.trim()),
    prune: Boolean(pruneKey()),
  };
}

export const hasGemini = () => routes().length > 0;

export const architectModel = () => env().ARCHITECT_MODEL?.trim() || geminiModel();

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

async function complete(route: Route, model: string, messages: Array<{ role: string; content: string }>, feature: string): Promise<{ text: string; usage: Usage }> {
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
    signal: AbortSignal.timeout(45_000),
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
  return {
    text,
    usage: {
      engine: 'gemini',
      model,
      via: route.via,
      inputTokens: body.usage?.prompt_tokens ?? body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usage?.completion_tokens ?? body.usageMetadata?.candidatesTokenCount ?? 0,
      costUsd: num(meta?.cost_with_prune_usd),
      costSavedUsd: num(meta?.cost_saved_usd ?? res.headers.get('x-prune-cost-saved')),
      cacheHit: meta?.cache_hit !== undefined ? Boolean(meta.cache_hit) : res.headers.has('x-prune-cache-hit') ? res.headers.get('x-prune-cache-hit') === 'true' : null,
      routedModel: meta?.route_applied ? String(meta.routed_model) : null,
      receipt: meta ?? null,
      feature,
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

export async function chatJson<S extends z.ZodTypeAny>(opts: {
  system: string;
  user: string;
  schema: S;
  feature: string;
  model?: string;
  onUsage: (usage: Usage) => void;
}): Promise<z.infer<S>> {
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
      console.warn(`[llm] gemini via ${route.via} failed:`, String(error));
      lastError = error;
    }
  }
  throw lastError;
}
