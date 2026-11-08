import { create } from 'zustand';
import { useAuth } from './auth';

// A signed-in person's own API keys. They live only in this browser, under that person's account, and go out as headers on
// agent requests. The server uses them for that one request and never stores them. Signing out deletes them here.

export type KeyService = 'gemini' | 'swarms' | 'typesafe';
export type OwnKeys = Partial<Record<KeyService, string>>;

export const SERVICES: Array<{ id: KeyService; name: string; powers: string; getUrl: string; placeholder: string }> = [
  { id: 'gemini', name: 'Gemini', powers: 'Designs, repairs, reviews and plain-word explanations', getUrl: 'https://aistudio.google.com/apikey', placeholder: 'AIza…' },
  { id: 'swarms', name: 'Swarms', powers: 'The Red Team and the Recovery Council', getUrl: 'https://swarms.world/platform/api-keys', placeholder: 'sk-…' },
  { id: 'typesafe', name: 'TypeSafe Jev', powers: 'Picking which simulator fits a request', getUrl: 'https://typesafe.ai', placeholder: 'ts_…' },
];

const HEADER: Record<KeyService, string> = { gemini: 'x-own-gemini-key', swarms: 'x-own-swarms-key', typesafe: 'x-own-typesafe-key' };

const slot = () => {
  const account = useAuth.getState().account;
  return account ? `canitwork.keys.${account.email ?? account.name ?? 'me'}` : null;
};

function read(): OwnKeys {
  const key = slot();
  if (!key) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as OwnKeys;
    return Object.fromEntries(Object.entries(parsed).filter(([s, v]) => s in HEADER && typeof v === 'string' && v)) as OwnKeys;
  } catch {
    return {};
  }
}

interface KeysState {
  keys: OwnKeys;
  /** Whether the API keys panel is open */
  open: boolean;
}

export const useOwnKeys = create<KeysState>(() => ({ keys: {}, open: false }));

/** Loads the keys of whoever is signed in now; called when the account changes. */
export const loadOwnKeys = () => useOwnKeys.setState({ keys: read() });

export function saveOwnKey(service: KeyService, value: string | null) {
  const key = slot();
  if (!key) return;
  const next = { ...read() };
  if (value?.trim()) next[service] = value.trim();
  else delete next[service];
  try {
    if (Object.keys(next).length) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked (a private window): the key still works until the page closes
  }
  useOwnKeys.setState({ keys: next });
}

/** Removes every key this browser holds for the signed-in person. */
export function forgetOwnKeys() {
  const key = slot();
  try {
    if (key) localStorage.removeItem(key);
  } catch {
    // Nothing to remove
  }
  useOwnKeys.setState({ keys: {} });
}

/** Headers carrying the person's keys, for agent requests only; none for a guest. */
export function ownKeyHeaders(): Record<string, string> {
  if (!useAuth.getState().account) return {};
  const keys = useOwnKeys.getState().keys;
  return Object.fromEntries((Object.entries(keys) as Array<[KeyService, string]>).map(([s, v]) => [HEADER[s], v]));
}

/** "AIza…7Qx4": enough to recognise a key without showing it. */
export const masked = (value: string) => (value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '••••');
