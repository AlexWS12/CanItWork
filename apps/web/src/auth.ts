import { createAuth0Client, type Auth0Client } from '@auth0/auth0-spa-js';
import { create } from 'zustand';

// Sign-in with Auth0. The server says whether a tenant is configured; without one, nothing here shows and the app
// works exactly as before. Signing in goes through Auth0's own page and comes back to the run that was open.

export interface Account {
  name?: string;
  email?: string;
  picture?: string;
}

/** A saved run the visitor couldn't open: they need to sign in, or it wasn't shared with them. */
export interface LockedRun {
  id: string;
  reason: 'sign-in' | 'private' | 'missing';
}

interface AuthState {
  enabled: boolean;
  ready: boolean;
  account: Account | null;
  locked: LockedRun | null;
  mySystems: boolean;
}

export const useAuth = create<AuthState>(() => ({ enabled: false, ready: false, account: null, locked: null, mySystems: false }));

let client: Auth0Client | null = null;
// Auth0 matches its allowed URLs exactly, so the site root is sent as "http://localhost:5173" with no trailing slash.
const home = () => `${location.origin}${location.pathname === '/' ? '' : location.pathname}`;

export async function initAuth() {
  try {
    const res = await fetch('/api/auth/config');
    const config = res.ok ? ((await res.json()) as { enabled: boolean; domain?: string; clientId?: string; audience?: string }) : { enabled: false };
    if (!config.enabled || !config.domain || !config.clientId) return useAuth.setState({ ready: true });
    client = await createAuth0Client({
      domain: config.domain,
      clientId: config.clientId,
      cacheLocation: 'localstorage',
      useRefreshTokens: true,
      authorizationParams: { redirect_uri: home(), scope: 'openid profile email', ...(config.audience ? { audience: config.audience } : {}) },
    });
    // Coming back from Auth0's page: finish signing in, then put back the link that was open before.
    const params = new URLSearchParams(location.search);
    if (params.has('code') && params.has('state')) {
      const { appState } = await client.handleRedirectCallback<{ hash?: string }>();
      window.history.replaceState(null, '', `${location.pathname}${appState?.hash ?? ''}`);
    }
    const user = (await client.isAuthenticated()) ? await client.getUser() : null;
    useAuth.setState({ enabled: true, ready: true, account: user ? { name: user.name ?? user.nickname, email: user.email, picture: user.picture } : null });
  } catch {
    useAuth.setState({ ready: true });
  }
}

/** Signs in through Auth0, keeping the current link (which holds the open run) to come back to. */
export async function signIn() {
  await client?.loginWithRedirect({ appState: { hash: location.hash } });
}

export async function signOut() {
  await client?.logout({ logoutParams: { returnTo: home() } });
}

/** A fetch that carries the signed-in user's access token, so the server knows who is asking. */
export async function authFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (client && useAuth.getState().account) {
    try {
      headers.set('authorization', `Bearer ${await client.getTokenSilently()}`);
    } catch {
      // An expired session just asks as a signed-out visitor.
    }
  }
  return fetch(url, { ...init, headers });
}
