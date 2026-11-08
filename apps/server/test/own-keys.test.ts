import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useKeysForTests } from '../src/auth';
import { chatJson, hasGemini } from '../src/llm';
import { ownKeys, ownKeysOf, paysOwnWay, withOwnKeys } from '../src/ownKeys';
import { isolateEnv } from './helpers';

const DOMAIN = 'canitwork-test.auth0.com';
const AUDIENCE = 'https://canitwork.api';
let token: string;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  useKeysForTests(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] }));
  token = await new SignJWT({ sub: 'auth0|alex', email: 'a@example.com', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://${DOMAIN}/`)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
});
afterAll(() => useKeysForTests(null));

describe('a person bringing their own API keys', () => {
  isolateEnv();
  beforeEach(() => {
    process.env.AUTH0_DOMAIN = DOMAIN;
    process.env.AUTH0_CLIENT_ID = 'client';
    process.env.AUTH0_AUDIENCE = AUDIENCE;
  });

  // A tiny app that reports which keys a request would run with
  const app = new Hono();
  app.post('/keys', async (c) => c.json((await ownKeysOf(c)) ?? { none: true }));
  const send = (headers: Record<string, string>) => app.request('/keys', { method: 'POST', headers });
  const GEMINI = 'AIzaOwnGeminiKey-1234567890';

  it('uses keys only from a signed-in person, and ignores a guest', async () => {
    expect(await (await send({ 'x-own-gemini-key': GEMINI })).json()).toEqual({ none: true });
    expect(await (await send({ 'x-own-gemini-key': GEMINI, authorization: `Bearer ${token}` })).json()).toEqual({ gemini: GEMINI });
    expect(await (await send({ 'x-own-gemini-key': GEMINI, authorization: 'Bearer forged' })).json()).toEqual({ none: true });
  });

  it('drops anything that is not a plausible key', async () => {
    const res = await send({
      authorization: `Bearer ${token}`,
      'x-own-gemini-key': 'short',
      'x-own-swarms-key': 'has spaces in it and more',
      'x-own-typesafe-key': 'ts-ok-key-1234567890',
    });
    expect(await res.json()).toEqual({ typesafe: 'ts-ok-key-1234567890' });
  });

  it('sends Gemini calls only with their key while their request runs, never the server keys', async () => {
    process.env.PRUNE_API_KEY = 'server-prune-key-000000';
    process.env.GEMINI_API_KEY = 'server-gemini-key-000000';
    const seen: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, auth: String((init.headers as Record<string, string>).authorization ?? (init.headers as Record<string, string>).Authorization) });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });
    await withOwnKeys({ gemini: GEMINI }, () => chatJson({ feature: 'test', schema: z.object({ ok: z.boolean() }), system: 's', user: 'u', onUsage: () => {} }));
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('generativelanguage.googleapis.com');
    expect(seen[0].auth).toBe(`Bearer ${GEMINI}`);
    // Outside their request, the server's own routes are used again
    seen.length = 0;
    await chatJson({ feature: 'test', schema: z.object({ ok: z.boolean() }), system: 's', user: 'u', onUsage: () => {} });
    expect(seen[0].auth).toBe('Bearer server-prune-key-000000');
    vi.unstubAllGlobals();
  });

  it('keeps two people’s keys apart when their requests run at the same time', async () => {
    const seenBy = async (key: string) =>
      withOwnKeys({ gemini: key }, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        return ownKeys()?.gemini;
      });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => seenBy(`key-number-${i}-abcdefgh`)));
    results.forEach((k, i) => expect(k).toBe(`key-number-${i}-abcdefgh`));
    expect(ownKeys()).toBeUndefined();
  });

  it('lets someone with no server keys at all still use the agents with their own', async () => {
    expect(hasGemini()).toBe(false);
    expect(withOwnKeys({ gemini: GEMINI }, () => hasGemini())).toBe(true);
  });

  it('only skips the hourly allowance when the request pays its own way', () => {
    expect(paysOwnWay(null)).toBe(false);
    expect(paysOwnWay({ swarms: 's'.repeat(20) })).toBe(false);
    process.env.SWARMS_API_KEY = 'server-swarms-key-000000';
    expect(paysOwnWay({ gemini: GEMINI })).toBe(false);
    expect(paysOwnWay({ gemini: GEMINI, swarms: 's'.repeat(20) })).toBe(true);
    delete process.env.SWARMS_API_KEY;
    expect(paysOwnWay({ gemini: GEMINI })).toBe(true);
  });
});
