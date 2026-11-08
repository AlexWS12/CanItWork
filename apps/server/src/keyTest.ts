// Asks a provider whether a key works, with one read-only request, and forgets the key straight after: nothing is cached,
// logged or stored. Used by the API keys panel before someone relies on a key.

export type KeyService = 'gemini' | 'swarms' | 'typesafe';

export interface KeyTest {
  ok: boolean;
  /** Plain words for the panel */
  message: string;
}

const ENDPOINTS: Record<KeyService, (key: string) => [string, Record<string, string>]> = {
  gemini: (key) => ['https://generativelanguage.googleapis.com/v1beta/openai/models', { authorization: `Bearer ${key}` }],
  swarms: (key) => ['https://api.swarms.world/v1/account/credits', { 'x-api-key': key }],
  typesafe: (key) => [`${process.env.TYPESAFE_BASE_URL?.trim() || 'https://api.typesafe.ai'}/v1/models`, { authorization: `Bearer ${key}` }],
};

export async function testKey(service: KeyService, key: string): Promise<KeyTest> {
  const [url, headers] = ENDPOINTS[service](key);
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      if (service === 'swarms') {
        const body = (await res.json().catch(() => ({}))) as { total_credits?: number; credit?: number };
        const balance = body.total_credits ?? body.credit;
        if (typeof balance === 'number') return { ok: true, message: `Works, with $${balance.toFixed(2)} of credit` };
      }
      return { ok: true, message: 'Works' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'The provider rejected this key' };
    if (res.status === 429) return { ok: false, message: 'This key is out of quota right now' };
    return { ok: false, message: `The provider answered ${res.status}; try again in a moment` };
  } catch {
    return { ok: false, message: 'Could not reach the provider; try again in a moment' };
  }
}
