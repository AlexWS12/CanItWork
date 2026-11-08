import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useKeysForTests } from '../src/auth';
import { admit, limitMessage, resetLimits, take } from '../src/integrations/limit';

describe('per-visitor rate limit', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_PER_HOUR;
    resetLimits();
  });

  it('is off unless RATE_LIMIT_PER_HOUR is set', () => {
    for (let i = 0; i < 100; i++) expect(take('a')).toBe(0);
  });

  it('allows the limit per hour, then says how long to wait, per visitor', () => {
    process.env.RATE_LIMIT_PER_HOUR = '2';
    const t0 = 1_000_000;
    expect(take('a', t0)).toBe(0);
    expect(take('a', t0 + 1000)).toBe(0);
    const wait = take('a', t0 + 2000);
    expect(wait).toBe(60 * 60 * 1000 - 2000);
    expect(take('b', t0 + 2000)).toBe(0);
    // An hour after the first request, one slot frees up.
    expect(take('a', t0 + 60 * 60 * 1000 + 1)).toBe(0);
  });

  it('explains the limit and points to the free examples', () => {
    process.env.RATE_LIMIT_PER_HOUR = '20';
    expect(limitMessage(5 * 60 * 1000)).toMatch(/20 AI builds per visitor an hour.*5 min.*examples/);
  });
});

describe('who counts as a visitor', () => {
  const ctx = (headers: Record<string, string>, remoteAddress = '10.0.0.9') =>
    ({ req: { header: (name: string) => headers[name.toLowerCase()] }, env: { incoming: { socket: { remoteAddress } } } }) as never;

  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it('ignores X-Forwarded-For unless the server is behind a trusted proxy, so it cannot be spoofed', async () => {
    const { visitorOf } = await import('../src/integrations/limit');
    expect(visitorOf(ctx({ 'x-forwarded-for': '1.2.3.4' }))).toBe('10.0.0.9');
  });

  it('behind a trusted proxy, uses the address the proxy appended, not one the client wrote', async () => {
    const { visitorOf } = await import('../src/integrations/limit');
    process.env.TRUST_PROXY = '1';
    expect(visitorOf(ctx({ 'x-forwarded-for': 'forged, 203.0.113.7' }))).toBe('203.0.113.7');
  });
});

describe('signing in to spend credits', () => {
  const DOMAIN = 'canitwork-test.auth0.com';
  let sign: (sub: string) => Promise<string>;
  const ctx = (token?: string, remoteAddress = '10.0.0.9') =>
    ({
      req: { header: (name: string) => (name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined) },
      env: { incoming: { socket: { remoteAddress } } },
    }) as never;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    useKeysForTests(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] }));
    sign = (sub) => new SignJWT({ sub }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(`https://${DOMAIN}/`).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  });
  afterAll(() => useKeysForTests(null));
  beforeEach(() => {
    process.env.AUTH0_DOMAIN = DOMAIN;
    process.env.AUTH0_CLIENT_ID = 'client';
  });
  afterEach(() => {
    for (const name of ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'REQUIRE_SIGN_IN', 'GUEST_LIMIT_PER_HOUR', 'RATE_LIMIT_PER_HOUR']) delete process.env[name];
    resetLimits();
  });

  it('lets guests through as before unless REQUIRE_SIGN_IN is on', async () => {
    expect(await admit(ctx())).toBeNull();
  });

  it('with REQUIRE_SIGN_IN, turns guests away with an offer to sign in, and lets a signed-in person through', async () => {
    process.env.REQUIRE_SIGN_IN = '1';
    expect(await admit(ctx())).toMatchObject({ signIn: true, message: expect.stringMatching(/Sign in/) });
    expect(await admit(ctx('not-a-real-token'))).toMatchObject({ signIn: true });
    expect(await admit(ctx(await sign('auth0|alice')))).toBeNull();
  });

  it('gives guests GUEST_LIMIT_PER_HOUR tries before asking them to sign in', async () => {
    process.env.REQUIRE_SIGN_IN = '1';
    process.env.GUEST_LIMIT_PER_HOUR = '2';
    expect(await admit(ctx())).toBeNull();
    expect(await admit(ctx())).toBeNull();
    expect(await admit(ctx())).toMatchObject({ signIn: true, message: expect.stringMatching(/2 AI builds a guest gets/) });
    expect(await admit(ctx(undefined, '10.0.0.10'))).toBeNull();
  });

  it('counts a signed-in person by their account, not their address', async () => {
    process.env.RATE_LIMIT_PER_HOUR = '1';
    const alice = await sign('auth0|alice');
    expect(await admit(ctx(alice, '10.0.0.1'))).toBeNull();
    // A new network doesn't reset Alice's allowance...
    const again = await admit(ctx(alice, '10.0.0.2'));
    expect(again?.message).toMatch(/Try again/);
    expect(again?.signIn).toBeUndefined();
    // ...and Bob on Alice's network has his own.
    expect(await admit(ctx(await sign('auth0|bob'), '10.0.0.1'))).toBeNull();
    expect(await admit(ctx(undefined, '10.0.0.1'))).toBeNull();
  });

  it('ignores REQUIRE_SIGN_IN when there is no tenant to sign in to', async () => {
    delete process.env.AUTH0_DOMAIN;
    process.env.REQUIRE_SIGN_IN = '1';
    expect(await admit(ctx())).toBeNull();
  });
});
