import type { Usage } from '@tv/core';
import { describe, expect, it, vi } from 'vitest';
import { ShieldBlock } from '../src/llm';
import { ask, isolateEnv, json, mockFetch, openAiReply } from './helpers';

isolateEnv();

describe('LLM gateway', () => {
  it('sends Gemini through Prune and keeps the receipt', async () => {
    process.env.PRUNE_API_KEY = 'prune_test';
    process.env.GEMINI_API_KEY = 'g';
    let sent: Record<string, string> = {};
    const calls = mockFetch((_, init) => {
      sent = init.headers as Record<string, string>;
      return json({
        candidates: [{ content: { parts: [{ text: '{"ok":' }, { text: 'true}' }] } }],
        usageMetadata: { promptTokenCount: 86, candidatesTokenCount: 34, totalTokenCount: 120 },
        prune_metadata: {
          cache_hit: false,
          cost_with_prune_usd: 0.000029,
          cost_saved_usd: 0.000004,
          route_applied: true,
          routed_model: 'gemini-3.5-flash-lite',
          receipt_signature: 'sig',
        },
      });
    });
    const usage: Usage[] = [];
    expect(await ask(usage)).toEqual({ ok: true });
    expect(calls[0]).toBe('https://api.withprune.com/v1/chat/completions');
    expect(sent.authorization).toBe('Bearer prune_test');
    expect(sent['X-Prune-Cache']).toBe('off');
    expect(usage[0]).toMatchObject({
      via: 'prune',
      inputTokens: 86,
      outputTokens: 34,
      cacheHit: false,
      costUsd: 0.000029,
      costSavedUsd: 0.000004,
      routedModel: 'gemini-3.5-flash-lite',
    });
    expect(usage[0].receipt).toMatchObject({ receipt_signature: 'sig' });
  });

  it('reports no model swap when Prune leaves the model alone', async () => {
    process.env.PRUNE_API_KEY = 'prune_test';
    mockFetch(() => json(openAiReply('{"ok":true}', { prune_metadata: { route_applied: false, routed_model: 'whatever' } })));
    const usage: Usage[] = [];
    await ask(usage);
    expect(usage[0].routedModel).toBeNull();
  });

  it('falls back to the direct key when Prune is down', async () => {
    process.env.PRUNE_API_KEY = 'prune_test';
    process.env.GEMINI_API_KEY = 'g';
    const calls = mockFetch((url) => (url.includes('withprune') ? new Response('down', { status: 503 }) : json(openAiReply('{"ok":true}'))));
    const usage: Usage[] = [];
    expect(await ask(usage)).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(usage[0].via).toBe('direct');
  });

  it('never routes around a Shield block', async () => {
    process.env.PRUNE_API_KEY = 'prune_test';
    process.env.GEMINI_API_KEY = 'g';
    const calls = mockFetch(() => new Response('blocked', { status: 403, headers: { 'x-prune-shield-code': 'prompt_injection' } }));
    await expect(ask()).rejects.toBeInstanceOf(ShieldBlock);
    expect(calls).toHaveLength(1);
  });

  it('waits out a rate limit for as long as Google asks, then retries', async () => {
    process.env.GEMINI_API_KEY = 'g';
    vi.useFakeTimers();
    let n = 0;
    mockFetch(() => (n++ ? json(openAiReply('{"ok":true}')) : new Response('{"error":{"code":429,"details":[{"retryDelay":"3s"}]}}', { status: 429 })));
    const pending = ask();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ ok: true });
    expect(n).toBe(2);
    vi.useRealTimers();
  });

  it('gives up straight away when the wait would be too long', async () => {
    process.env.GEMINI_API_KEY = 'g';
    let n = 0;
    mockFetch(() => {
      n++;
      return new Response('{"error":{"code":429,"details":[{"retryDelay":"300s"}]}}', { status: 429 });
    });
    await expect(ask()).rejects.toThrow('429');
    expect(n).toBe(1);
  });

  it('asks the model once to repair invalid JSON', async () => {
    process.env.GEMINI_API_KEY = 'g';
    let n = 0;
    mockFetch(() => json(openAiReply(n++ ? '{"ok":true}' : '{"ok":"nope"}')));
    expect(await ask()).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('reads JSON wrapped in a code fence', async () => {
    process.env.GEMINI_API_KEY = 'g';
    mockFetch(() => json(openAiReply('```json\n{"ok":true}\n```')));
    expect(await ask()).toEqual({ ok: true });
  });
});

describe('Prune rest period', () => {
  isolateEnv();
  it('skips Prune for a while after its upstream Gemini quota runs out, instead of failing through it on every call', async () => {
    process.env.PRUNE_API_KEY = 'p';
    process.env.GEMINI_API_KEY = 'g';
    const calls = mockFetch((url) =>
      url.includes('withprune')
        ? new Response(JSON.stringify({ error: 'gemini rejected the request (429)', code: 'provider_upstream_4xx' }), { status: 429 })
        : json(openAiReply(JSON.stringify({ ok: true }))),
    );
    await ask();
    await ask();
    expect(calls.filter((u) => u.includes('withprune')).length).toBe(1);
    expect(calls.filter((u) => u.includes('googleapis')).length).toBe(2);
  });
});

describe('Prune rest period on a rejected upstream key', () => {
  isolateEnv();
  it('also rests Prune when its upstream Gemini key is rejected', async () => {
    process.env.PRUNE_API_KEY = 'p';
    process.env.GEMINI_API_KEY = 'g';
    const calls = mockFetch((url) =>
      url.includes('withprune')
        ? new Response(JSON.stringify({ error: 'gemini rejected the API key or access', code: 'provider_upstream_4xx' }), { status: 401 })
        : json(openAiReply(JSON.stringify({ ok: true }))),
    );
    await ask();
    await ask();
    expect(calls.filter((u) => u.includes('withprune')).length).toBe(1);
  });
});
