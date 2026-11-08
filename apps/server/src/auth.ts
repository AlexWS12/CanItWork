import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

// Sign-in through Auth0. The browser signs in with Auth0's own page and sends its access token with each request;
// the server checks the token against the tenant's published keys. With no tenant configured, everything works as
// before and nobody is signed in.

export interface User {
  sub: string;
  /** Only a verified email is kept, so nobody can claim access to a run shared with someone else's address. */
  email?: string;
  name?: string;
  picture?: string;
}

export function authConfig() {
  const domain = process.env.AUTH0_DOMAIN?.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const clientId = process.env.AUTH0_CLIENT_ID?.trim();
  const audience = process.env.AUTH0_AUDIENCE?.trim() || undefined;
  return domain && clientId ? { domain, clientId, audience } : null;
}

let keys: { domain: string; get: JWTVerifyGetKey } | null = null;
let testKeys: JWTVerifyGetKey | null = null;

/** Tests sign their own tokens with a local key pair instead of Auth0's. */
export function useKeysForTests(get: JWTVerifyGetKey | null) {
  testKeys = get;
  profiles.clear();
}

const profiles = new Map<string, { user: User; until: number }>();

export async function userFrom(header: string | undefined): Promise<User | null> {
  const config = authConfig();
  if (!config || !header?.startsWith('Bearer ')) return null;
  try {
    if (!testKeys && keys?.domain !== config.domain) keys = { domain: config.domain, get: createRemoteJWKSet(new URL(`https://${config.domain}/.well-known/jwks.json`)) };
    const { payload } = await jwtVerify(header.slice(7), testKeys ?? keys!.get, {
      issuer: `https://${config.domain}/`,
      ...(config.audience ? { audience: config.audience } : {}),
    });
    const sub = String(payload.sub);
    const cached = profiles.get(sub);
    if (cached && cached.until > Date.now()) return cached.user;
    let user: User = { sub, ...profileOf(payload) };
    // An access token doesn't carry the email or name, so the profile comes from Auth0 once and is kept for ten minutes.
    if (!user.email && !testKeys) {
      const res = await fetch(`https://${config.domain}/userinfo`, { headers: { authorization: header } }).catch(() => null);
      if (res?.ok) user = { sub, ...profileOf((await res.json()) as Record<string, unknown>) };
    }
    profiles.set(sub, { user, until: Date.now() + 10 * 60_000 });
    return user;
  } catch {
    return null;
  }
}

function profileOf(claims: Record<string, unknown>): Omit<User, 'sub'> {
  const email = typeof claims.email === 'string' && claims.email_verified === true ? claims.email.toLowerCase() : undefined;
  const name = typeof claims.name === 'string' ? claims.name : typeof claims.nickname === 'string' ? claims.nickname : undefined;
  const picture = typeof claims.picture === 'string' ? claims.picture : undefined;
  return { ...(email ? { email } : {}), ...(name ? { name } : {}), ...(picture ? { picture } : {}) };
}
