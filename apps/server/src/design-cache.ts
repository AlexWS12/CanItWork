import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function read(file: string): Record<string, CachedDesign> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, CachedDesign>;
  } catch {
    return {};
  }
}

export function lookup(prompt: string): CachedDesign | null {
  if (!cacheOn()) return null;
  const key = normalize(prompt);
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
