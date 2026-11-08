import type { Context } from 'hono';
import { authConfig, userFrom } from '../auth';

// Caps how many credit-spending requests one visitor can make an hour, so a public deploy can't drain the team's Gemini or Swarms balance.
// Off unless RATE_LIMIT_PER_HOUR is set. Requests that cost nothing (a verified-cache hit) are never counted.
// With Auth0 configured, a signed-in person is counted by their account rather than their address, and REQUIRE_SIGN_IN=1
// keeps the AI for signed-in people, apart from GUEST_LIMIT_PER_HOUR builds a guest may try first.

const WINDOW_MS = 60 * 60 * 1000;
const seen = new Map<string, number[]>();

const perHour = (name: string) => Math.max(0, Number(process.env[name] ?? 0) || 0);
export const limitPerHour = () => perHour('RATE_LIMIT_PER_HOUR');
export const guestLimitPerHour = () => perHour('GUEST_LIMIT_PER_HOUR');
/** Only means anything with a tenant to sign in to; without one, guests keep the plain per-address limit. */
export const signInRequired = () => process.env.REQUIRE_SIGN_IN?.trim() === '1' && !!authConfig();

// Forwarding headers are written by whoever sends the request, so they only count behind a proxy we run (TRUST_PROXY=1).
// The proxy appends the address it saw, so the last entry is the one it vouches for; earlier ones may be forged.
export function visitorOf(c: Context) {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  if (process.env.TRUST_PROXY?.trim() !== '1') return socket || 'unknown';
  const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  return forwarded || socket || 'unknown';
}

// Records one request for this visitor if they are under the limit. Returns how long until they may try again, or 0 if allowed.
export function take(visitor: string, now = Date.now(), limit = limitPerHour()): number {
  if (!limit) return 0;
  const recent = (seen.get(visitor) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    seen.set(visitor, recent);
    return WINDOW_MS - (now - recent[0]);
  }
  recent.push(now);
  seen.set(visitor, recent);
  if (seen.size > 10_000) for (const [key, times] of seen) if (!times.some((t) => now - t < WINDOW_MS)) seen.delete(key);
  return 0;
}

export function resetLimits() {
  seen.clear();
}

export const limitMessage = (waitMs: number) =>
  `This demo allows ${limitPerHour()} AI builds per visitor an hour, to keep the shared credits alive. Try again in ${Math.ceil(waitMs / 60000)} min, or pick one of the examples, which are verified and free.`;

export const signInMessage = (guestAllowance: number) =>
  guestAllowance
    ? `You've used the ${guestAllowance} AI ${guestAllowance === 1 ? 'build' : 'builds'} a guest gets an hour. Sign in to keep building, or pick one of the examples, which are verified and free.`
    : 'Sign in to build new systems with the AI, which keeps the shared credits for real visitors. The examples are verified and free without signing in.';

export interface Refused {
  message: string;
  /** True when signing in would let the request through. */
  signIn?: true;
}

// Decides whether a credit-spending request may go ahead: null to allow it (and count it), or why not.
export async function admit(c: Context, now = Date.now()): Promise<Refused | null> {
  const user = authConfig() ? await userFrom(c.req.header('authorization')) : null;
  if (user) {
    const wait = take(`user:${user.sub}`, now);
    return wait ? { message: limitMessage(wait) } : null;
  }
  if (signInRequired()) {
    const allowance = guestLimitPerHour();
    if (allowance && !take(`guest:${visitorOf(c)}`, now, allowance)) return null;
    return { message: signInMessage(allowance), signIn: true };
  }
  const wait = take(visitorOf(c), now);
  return wait ? { message: limitMessage(wait) } : null;
}
