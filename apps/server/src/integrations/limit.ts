import type { Context } from 'hono';

// Caps how many credit-spending requests one visitor can make an hour, so a public deploy can't drain the team's Gemini or Swarms balance.
// Off unless RATE_LIMIT_PER_HOUR is set. Requests that cost nothing (a verified-cache hit) are never counted.

const WINDOW_MS = 60 * 60 * 1000;
const seen = new Map<string, number[]>();

export const limitPerHour = () => Math.max(0, Number(process.env.RATE_LIMIT_PER_HOUR ?? 0) || 0);

export function visitorOf(c: Context) {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return forwarded || c.req.header('x-real-ip') || socket || 'unknown';
}

// Records one request for this visitor if they are under the limit. Returns how long until they may try again, or 0 if allowed.
export function take(visitor: string, now = Date.now()): number {
  const limit = limitPerHour();
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
