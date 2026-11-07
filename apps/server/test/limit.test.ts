import { afterEach, describe, expect, it } from 'vitest';
import { limitMessage, resetLimits, take } from '../src/integrations/limit';

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
