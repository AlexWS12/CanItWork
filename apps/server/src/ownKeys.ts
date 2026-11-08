import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from 'hono';
import { userFrom } from './auth';

// A signed-in person can bring their own API keys. They stay in that person's browser: each agent request carries them in
// headers, the server uses them for that request alone, and never stores or logs them. While a request runs, the Gemini,
// Swarms and Jev clients reach for these before the server's own keys.

export interface OwnKeys {
  gemini?: string;
  swarms?: string;
  typesafe?: string;
}

export const OWN_KEY_HEADERS = { gemini: 'x-own-gemini-key', swarms: 'x-own-swarms-key', typesafe: 'x-own-typesafe-key' } as const;

const store = new AsyncLocalStorage<OwnKeys>();

/** The keys of the request being served, if its person brought any. */
export const ownKeys = (): OwnKeys | undefined => store.getStore();

/** Runs fn with these keys in force for every call it makes, however deep. */
export const withOwnKeys = <T>(keys: OwnKeys | null, fn: () => T): T => (keys ? store.run(keys, fn) : fn());

// An API key is one line of letters, digits and a few separators; anything else is not sent anywhere
const plausible = (value: string | undefined) => {
  const key = value?.trim();
  return key && key.length >= 12 && key.length <= 256 && /^[\w\-.:~+/=]+$/.test(key) ? key : undefined;
};

/** The keys in a request's headers, but only for a signed-in person; a guest's are ignored. */
export async function ownKeysOf(c: Context): Promise<OwnKeys | null> {
  const keys: OwnKeys = {
    gemini: plausible(c.req.header(OWN_KEY_HEADERS.gemini)),
    swarms: plausible(c.req.header(OWN_KEY_HEADERS.swarms)),
    typesafe: plausible(c.req.header(OWN_KEY_HEADERS.typesafe)),
  };
  if (!keys.gemini && !keys.swarms && !keys.typesafe) return null;
  const user = await userFrom(c.req.header('authorization')).catch(() => null);
  return user ? keys : null;
}

/**
 * Whether this request pays its own way, so it need not count against the hourly allowance: the person's own Gemini key, and
 * their own Swarms key too whenever the server would otherwise spend Swarms credits on it.
 */
export const paysOwnWay = (keys: OwnKeys | null) => Boolean(keys?.gemini && (keys.swarms || !process.env.SWARMS_API_KEY?.trim()));
