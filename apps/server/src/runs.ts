import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import postgres from 'postgres';
import { z } from 'zod';
import { userFrom, type User } from './auth';

// Saved runs. A share link that holds the whole run is public by nature; a saved run lives here instead, so its link
// is a short id and the owner decides who can open it: anyone with the link, only themselves, or people they name by email.
// "Listed" is anyone with the link plus a place on the landing page, beside the verified designs of its kind; a run is
// listed only when its owner chooses it, so a link-shared run never shows up anywhere by itself.
// Runs go to Postgres (Tiger Data) when DATABASE_URL is set, otherwise to a local file for development.

export type Visibility = 'public' | 'listed' | 'private' | 'people';

export interface SavedRun {
  id: string;
  owner: string;
  ownerName: string | null;
  name: string;
  domain: string;
  visibility: Visibility;
  people: string[];
  run: unknown;
  hash: string;
  /** A small JPEG of the 3D view taken when it was saved, as a data URL, for its card in My systems */
  thumb?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Store {
  save(run: SavedRun): Promise<void>;
  get(id: string): Promise<SavedRun | null>;
  list(owner: string): Promise<SavedRun[]>;
  /** Runs their owners chose to list, newest first. */
  listed(domain: string): Promise<SavedRun[]>;
  update(id: string, change: Pick<SavedRun, 'visibility' | 'people'>): Promise<void>;
  remove(id: string): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function fileStore(): Store {
  const file = () => process.env.RUNS_FILE || path.resolve(here, '../.data/runs.json');
  const read = (): Record<string, SavedRun> => {
    try {
      return JSON.parse(readFileSync(file(), 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (all: Record<string, SavedRun>) => {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(all));
  };
  return {
    async save(run) {
      write({ ...read(), [run.id]: run });
    },
    async get(id) {
      return read()[id] ?? null;
    },
    async list(owner) {
      return Object.values(read())
        .filter((r) => r.owner === owner)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async listed(domain) {
      return Object.values(read())
        .filter((r) => r.visibility === 'listed' && r.domain === domain)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50);
    },
    async update(id, change) {
      const all = read();
      if (all[id]) write({ ...all, [id]: { ...all[id], ...change, updatedAt: new Date().toISOString() } });
    },
    async remove(id) {
      const all = read();
      delete all[id];
      write(all);
    },
  };
}

function postgresStore(url: string): Store {
  const sql = postgres(url, { max: 4, onnotice: () => undefined });
  let ready: Promise<unknown> | null = null;
  const table = () =>
    (ready ??= sql`
      create table if not exists runs (
        id text primary key,
        owner text not null,
        owner_name text,
        name text not null,
        domain text not null,
        visibility text not null,
        people text[] not null default '{}',
        run jsonb not null,
        hash text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`
      .then(() => sql`create index if not exists runs_owner on runs (owner, updated_at desc)`)
      // Added after the first saves, so older tables gain it here
      .then(() => sql`alter table runs add column if not exists thumb text`));
  const row = (r: Record<string, unknown>): SavedRun => ({
    id: r.id as string,
    owner: r.owner as string,
    ownerName: (r.owner_name as string) ?? null,
    name: r.name as string,
    domain: r.domain as string,
    visibility: r.visibility as Visibility,
    people: (r.people as string[]) ?? [],
    run: r.run,
    hash: r.hash as string,
    thumb: (r.thumb as string) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  });
  return {
    async save(run) {
      await table();
      await sql`insert into runs (id, owner, owner_name, name, domain, visibility, people, run, hash, thumb)
        values (${run.id}, ${run.owner}, ${run.ownerName}, ${run.name}, ${run.domain}, ${run.visibility}, ${run.people}, ${sql.json(run.run as never)}, ${run.hash}, ${run.thumb ?? null})`;
    },
    async get(id) {
      await table();
      const [r] = await sql`select * from runs where id = ${id}`;
      return r ? row(r) : null;
    },
    async list(owner) {
      await table();
      return (await sql`select * from runs where owner = ${owner} order by updated_at desc limit 200`).map(row);
    },
    async listed(domain) {
      await table();
      return (await sql`select * from runs where visibility = 'listed' and domain = ${domain} order by updated_at desc limit 50`).map(row);
    },
    async update(id, change) {
      await table();
      await sql`update runs set visibility = ${change.visibility}, people = ${change.people}, updated_at = now() where id = ${id}`;
    },
    async remove(id) {
      await table();
      await sql`delete from runs where id = ${id}`;
    },
  };
}

let store: { key: string; store: Store } | null = null;
const runs = () => {
  const url = process.env.DATABASE_URL?.trim();
  const key = url || `file:${process.env.RUNS_FILE ?? ''}`;
  if (store?.key !== key) store = { key, store: url ? postgresStore(url) : fileStore() };
  return store.store;
};

export const storageKind = () => (process.env.DATABASE_URL?.trim() ? 'postgres' : 'file');

/** Who may open a run: anyone when public, its owner always, and named people by their verified email. */
export function canOpen(run: SavedRun, user: User | null) {
  if (run.visibility === 'public' || run.visibility === 'listed') return true;
  if (user?.sub === run.owner) return true;
  return run.visibility === 'people' && Boolean(user?.email) && run.people.includes(user!.email!);
}

const id = () => {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join('');
};

const Sharing = z.object({
  visibility: z.enum(['public', 'listed', 'private', 'people']),
  people: z.array(z.string().trim().toLowerCase().email()).max(20).default([]),
});
const Body = Sharing.extend({
  // What it is called in My systems; the system's own name when left out
  name: z.string().trim().min(1).max(120).optional(),
  run: z.object({
    environment: z.object({ domain: z.string(), name: z.string() }).passthrough(),
    seed: z.number(),
    tick: z.number(),
    events: z.array(z.unknown()),
    hash: z.string(),
  }),
  // The picture for its card: a JPEG or WebP data URL the browser made from the 3D view, kept small
  thumb: z
    .string()
    .max(150_000)
    .regex(/^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/]+=*$/)
    .optional(),
});
const MAX_BYTES = 1_000_000;

// What a card in My systems shows: the run's picture, its description and how far it ran, without the run itself
const summary = (r: SavedRun) => {
  const run = r.run as { environment?: { summary?: unknown }; tick?: unknown; events?: unknown[] } | null;
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    visibility: r.visibility,
    people: r.people,
    updatedAt: r.updatedAt,
    description: typeof run?.environment?.summary === 'string' ? run.environment.summary : '',
    ticks: typeof run?.tick === 'number' ? run.tick : 0,
    events: Array.isArray(run?.events) ? run.events.length : 0,
    hash: r.hash,
    thumb: r.thumb ?? null,
  };
};

/** The runs listed for a kind of system: what anyone may see of them, which leaves out the owner's account and the run itself. */
export async function listedRuns(domain: string) {
  return (await runs().listed(domain)).map((r) => ({ id: r.id, name: r.name, ownerName: r.ownerName, updatedAt: r.updatedAt }));
}

export function mountRuns(app: Hono) {
  app.get('/api/me', async (c) => {
    const user = await userFrom(c.req.header('authorization'));
    return user ? c.json(user) : c.json({ error: 'Sign in first' }, 401);
  });

  app.post('/api/runs', async (c) => {
    const user = await userFrom(c.req.header('authorization'));
    if (!user) return c.json({ error: 'Sign in to save a run' }, 401);
    const text = await c.req.text();
    if (text.length > MAX_BYTES) return c.json({ error: 'This run is too large to save' }, 413);
    const parsed = Body.safeParse(JSON.parse(text || '{}'));
    if (!parsed.success) return c.json({ error: 'That is not a run' }, 400);
    const { run, visibility, people, name, thumb } = parsed.data;
    const now = new Date().toISOString();
    const saved: SavedRun = {
      id: id(),
      owner: user.sub,
      ownerName: user.name ?? null,
      name: name ?? run.environment.name.slice(0, 120),
      domain: run.environment.domain,
      visibility,
      people: visibility === 'people' ? people : [],
      run,
      hash: run.hash,
      thumb: thumb ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await runs().save(saved);
    return c.json(summary(saved), 201);
  });

  app.get('/api/runs', async (c) => {
    const user = await userFrom(c.req.header('authorization'));
    if (!user) return c.json({ error: 'Sign in to see your runs' }, 401);
    return c.json({ runs: (await runs().list(user.sub)).map(summary) });
  });

  app.get('/api/runs/:id', async (c) => {
    const run = await runs().get(c.req.param('id'));
    if (!run) return c.json({ error: 'No run with that link' }, 404);
    const user = await userFrom(c.req.header('authorization'));
    if (!canOpen(run, user)) return user ? c.json({ error: 'This run is private', reason: 'private' }, 403) : c.json({ error: 'Sign in to open this run', reason: 'sign-in' }, 401);
    return c.json({ ...summary(run), ownerName: run.ownerName, mine: user?.sub === run.owner, run: run.run });
  });

  app.patch('/api/runs/:id', async (c) => {
    const user = await userFrom(c.req.header('authorization'));
    const run = await runs().get(c.req.param('id'));
    if (!run) return c.json({ error: 'No run with that link' }, 404);
    if (user?.sub !== run.owner) return c.json({ error: 'Only its owner can change who sees it' }, 403);
    const parsed = Sharing.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Choose public, listed, private or people' }, 400);
    const change = { visibility: parsed.data.visibility, people: parsed.data.visibility === 'people' ? parsed.data.people : [] };
    await runs().update(run.id, change);
    return c.json(summary({ ...run, ...change }));
  });

  app.delete('/api/runs/:id', async (c) => {
    const user = await userFrom(c.req.header('authorization'));
    const run = await runs().get(c.req.param('id'));
    if (!run) return c.json({ error: 'No run with that link' }, 404);
    if (user?.sub !== run.owner) return c.json({ error: 'Only its owner can delete it' }, 403);
    await runs().remove(run.id);
    return c.json({ ok: true });
  });
}
