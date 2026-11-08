import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useKeysForTests } from '../src/auth';
import { mountRuns } from '../src/runs';

const DOMAIN = 'canitwork-test.auth0.com';
const AUDIENCE = 'https://canitwork.api';
let sign: (claims: Record<string, unknown>) => Promise<string>;
const dir = mkdtempSync(path.join(tmpdir(), 'runs-'));

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  useKeysForTests(createLocalJWKSet({ keys: [jwk] }));
  sign = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(`https://${DOMAIN}/`)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
});
afterAll(() => {
  useKeysForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
beforeEach(() => {
  process.env.AUTH0_DOMAIN = DOMAIN;
  process.env.AUTH0_CLIENT_ID = 'client';
  process.env.AUTH0_AUDIENCE = AUDIENCE;
  delete process.env.DATABASE_URL;
  process.env.RUNS_FILE = path.join(dir, `runs-${++n}.json`);
});

const app = new Hono();
mountRuns(app);
const alice = () => sign({ sub: 'auth0|alice', email: 'alice@example.com', email_verified: true, name: 'Alice' });
const bob = () => sign({ sub: 'auth0|bob', email: 'bob@example.com', email_verified: true });
const mallory = () => sign({ sub: 'auth0|mallory', email: 'bob@example.com', email_verified: false });
const call = async (method: string, url: string, token?: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const run = { environment: { domain: 'electronics', name: '16-bit adder', summary: 's', spec: {}, unmodelled: [] }, seed: 1, tick: 40, events: [], hash: 'abc123' };
const save = async (visibility: string, people: string[] = []) => (await (await call('POST', '/api/runs', await alice(), { run, visibility, people })).json()) as { id: string };

describe('saved runs', () => {
  it('needs a signed-in user to save, and rejects a token from anywhere else', async () => {
    expect((await call('POST', '/api/runs', undefined, { run, visibility: 'public' })).status).toBe(401);
    expect((await call('POST', '/api/runs', 'not-a-token', { run, visibility: 'public' })).status).toBe(401);
    const res = await call('POST', '/api/runs', await alice(), { run, visibility: 'public' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toMatch(/^[A-Za-z0-9]{10}$/);
  });

  it('opens a public run for anyone, with or without signing in', async () => {
    const { id } = await save('public');
    const anyone = await call('GET', `/api/runs/${id}`);
    expect(anyone.status).toBe(200);
    expect(((await anyone.json()) as { run: typeof run; mine: boolean }).run.hash).toBe('abc123');
  });

  it('keeps a private run to its owner: others are asked to sign in or told it is private', async () => {
    const { id } = await save('private');
    expect((await call('GET', `/api/runs/${id}`)).status).toBe(401);
    expect((await call('GET', `/api/runs/${id}`, await bob())).status).toBe(403);
    const mine = await call('GET', `/api/runs/${id}`, await alice());
    expect(((await mine.json()) as { mine: boolean }).mine).toBe(true);
  });

  it('lets named people in by their verified email only', async () => {
    const { id } = await save('people', ['BOB@example.com']);
    expect((await call('GET', `/api/runs/${id}`, await bob())).status).toBe(200);
    expect((await call('GET', `/api/runs/${id}`, await mallory())).status).toBe(403);
  });

  it('lists only your own runs, and only the owner can change or delete one', async () => {
    const { id } = await save('private');
    const mine = (await (await call('GET', '/api/runs', await alice())).json()) as { runs: Array<{ id: string; name: string }> };
    expect(mine.runs.map((r) => r.id)).toEqual([id]);
    expect(((await (await call('GET', '/api/runs', await bob())).json()) as { runs: unknown[] }).runs).toEqual([]);
    expect((await call('PATCH', `/api/runs/${id}`, await bob(), { visibility: 'public' })).status).toBe(403);
    expect((await call('PATCH', `/api/runs/${id}`, await alice(), { visibility: 'public' })).status).toBe(200);
    expect((await call('GET', `/api/runs/${id}`)).status).toBe(200);
    expect((await call('DELETE', `/api/runs/${id}`, await bob())).status).toBe(403);
    expect((await call('DELETE', `/api/runs/${id}`, await alice())).status).toBe(200);
    expect((await call('GET', `/api/runs/${id}`, await alice())).status).toBe(404);
  });

  it('turns sign-in off entirely when no Auth0 tenant is configured', async () => {
    delete process.env.AUTH0_DOMAIN;
    expect((await call('POST', '/api/runs', await alice(), { run, visibility: 'public' })).status).toBe(401);
  });
});
