import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// Where live sessions are kept between server restarts: Postgres (Tiger Data) when DATABASE_URL is set, otherwise a local
// file beside the saved runs. A session is small (its design, seed, action log and the agents' work), so it is stored whole.

const here = path.dirname(fileURLToPath(import.meta.url));
const roomsFile = () => process.env.ROOMS_FILE || path.resolve(here, '../.data/rooms.json');

let pg: { url: string; sql: ReturnType<typeof postgres>; ready: Promise<unknown> } | null = null;
function database() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (pg?.url !== url) {
    const sql = postgres(url, { max: 2, onnotice: () => undefined });
    pg = { url, sql, ready: sql`create table if not exists live_rooms (id text primary key, state jsonb not null, updated_at timestamptz not null default now())` };
  }
  return pg;
}

const readFile = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(roomsFile(), 'utf8'));
  } catch {
    return {};
  }
};

export async function keepRoom(id: string, state: unknown) {
  const db = database();
  if (db) {
    await db.ready;
    await db.sql`insert into live_rooms (id, state) values (${id}, ${db.sql.json(state as never)})
      on conflict (id) do update set state = excluded.state, updated_at = now()`;
    return;
  }
  const all = readFile();
  all[id] = state;
  mkdirSync(path.dirname(roomsFile()), { recursive: true });
  writeFileSync(roomsFile(), JSON.stringify(all));
}

export async function loadRoom(id: string): Promise<unknown | null> {
  const db = database();
  if (db) {
    await db.ready;
    const [row] = await db.sql`select state from live_rooms where id = ${id}`;
    return row?.state ?? null;
  }
  return readFile()[id] ?? null;
}
