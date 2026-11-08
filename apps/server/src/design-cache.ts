import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, type DomainId } from '@tv/core';

// Designs that passed every check, keyed by the exact prompt (case and spacing aside). Asking again rebuilds instantly with no model calls.
// Matching is exact on purpose: a semantic cache returned five robots when nine were asked for, so near misses always go to the Architect.
// A hit is re-validated against the current simulator before it is used, so a stale design can't slip through.

export interface CachedDesign {
  domain: DomainId;
  draft: { name: string; summary: string; unmodelled: string[]; spec: unknown };
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Seeds verified ahead of time ship with the repo; designs verified while running are kept beside them, out of git.
const SEEDS = path.resolve(here, '../data/verified-designs.json');
const runtimeFile = () => process.env.DESIGN_CACHE_FILE?.trim() || path.resolve(here, '../.cache/designs.json');

// Tests see the cache only when they ask for it, so seeded prompts can't change their results.
export const cacheOn = () => {
  const setting = process.env.DESIGN_CACHE?.trim().toLowerCase();
  return process.env.VITEST ? setting === 'test' : setting !== 'off';
};

export const normalize = (prompt: string) =>
  prompt
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?\s]+$/, '')
    .trim();

// Parsed files stay in memory and are re-read only when they change on disk.
const memo = new Map<string, { mtime: number; data: Record<string, CachedDesign> }>();

function read(file: string): Record<string, CachedDesign> {
  try {
    const mtime = statSync(file).mtimeMs;
    const hit = memo.get(file);
    if (hit && hit.mtime === mtime) return hit.data;
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, CachedDesign>;
    memo.set(file, { mtime, data });
    return data;
  } catch {
    return {};
  }
}

// Entries that no longer pass the checks, seeds included, are skipped until the server restarts.
const stale = new Set<string>();

export function markStale(prompt: string) {
  stale.add(normalize(prompt));
  forget(prompt);
}

export function lookup(prompt: string): CachedDesign | null {
  if (!cacheOn()) return null;
  const key = normalize(prompt);
  if (stale.has(key)) return null;
  const hit = read(runtimeFile())[key] ?? read(SEEDS)[key];
  return hit && hit.domain in DOMAINS ? hit : null;
}

export function remember(prompt: string, design: CachedDesign) {
  if (!cacheOn()) return;
  try {
    const file = runtimeFile();
    const all = read(file);
    all[normalize(prompt)] = design;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all));
    stale.delete(normalize(prompt));
  } catch {
    // Best effort: a read-only disk only costs the next build a model call.
  }
}

export function forget(prompt: string) {
  try {
    const file = runtimeFile();
    const all = read(file);
    if (!(normalize(prompt) in all)) return;
    delete all[normalize(prompt)];
    writeFileSync(file, JSON.stringify(all));
  } catch {
    // Nothing to forget.
  }
}

// Landing-page examples: a spread of domains, offered only while the cache can serve them, so a click is instant and free.
const SHOWCASE = [
  '2 bit calculator on a breadboard',
  'A traffic light sequence with red, yellow and green LEDs using a 555 and a 4017 counter, no microcontroller',
  'A temperature alarm: a thermistor and an LM393 comparator sound a buzzer above 40C',
  'An Arduino counting from 0 to 9 on a 7-segment display, one digit per second',
  'A chat app with websockets, a message broker and a database',
  'An e-commerce schema with products, carts and reviews',
  'A warehouse with 6 robots and 3 aisles',
  'A swarm of organized drones with different roles',
  'Firefighting drones: 3 thermal scouts find hotspots in a 1.5 km forest and 4 water drones drop water on them',
  'A supermarket on Saturday: 8 checkouts, 4 self-service tills and one customer service desk',
  'An emergency room on a busy Friday night',
  'A neighbourhood microgrid with rooftop solar and a battery',
];

export const showcase = () =>
  SHOWCASE.flatMap((prompt) => {
    const hit = lookup(prompt);
    return hit ? [{ prompt, domain: hit.domain }] : [];
  });

export function resetStale() {
  stale.clear();
}
