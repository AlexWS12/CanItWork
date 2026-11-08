import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpendSummary, Usage } from '@tv/core';

// Every billed Gemini call is appended here, so spend can be audited across server runs and eval runs.
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.spend');
const LEDGER = path.join(DIR, 'ledger.jsonl');

// Estimates per million tokens when the gateway doesn't report a cost. Flash-Lite list prices.
const PRICE = { input: 0.1, output: 0.4 };

export const estimate = (u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'costUsd'>) => u.costUsd ?? (u.inputTokens * PRICE.input + u.outputTokens * PRICE.output) / 1e6;

export function record(usage: Usage) {
  if (process.env.VITEST) return;
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(
      LEDGER,
      JSON.stringify({
        at: new Date().toISOString(),
        run: process.env.SPEND_RUN ?? 'server',
        feature: usage.feature,
        model: usage.model,
        via: usage.via,
        in: usage.inputTokens,
        out: usage.outputTokens,
        usd: estimate(usage),
        // Prune's receipt, so savings can be totalled across runs
        without: usage.costWithoutUsd ?? null,
        saved: usage.costSavedUsd ?? null,
        tokensSaved: usage.tokensSaved ?? null,
        cacheHit: usage.cacheHit ?? null,
        routed: usage.routedModel ?? null,
      }) + '\n',
    );
  } catch {
    // The ledger is best effort; a read-only disk must not break a build.
  }
}

interface Row {
  at: string;
  run: string;
  via?: string;
  usd: number;
  in: number;
  out: number;
  without?: number | null;
  saved?: number | null;
  tokensSaved?: number | null;
  cacheHit?: boolean | null;
  routed?: string | null;
}

function rows(): Row[] {
  try {
    return readFileSync(LEDGER, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row);
  } catch {
    return [];
  }
}

// What Prune has saved on every call this server made, for the Usage tab's showcase.
export function summary(bypass: string | null): SpendSummary {
  const out: SpendSummary = { calls: 0, viaPrune: 0, direct: 0, tokens: 0, tokensSaved: 0, costUsd: 0, costWithoutUsd: 0, savedUsd: 0, cacheHits: 0, routed: 0, bypass };
  for (const row of rows()) {
    out.calls++;
    out.tokens += row.in + row.out;
    out.costUsd += row.usd;
    const saved = row.saved ?? 0;
    out.savedUsd += saved;
    out.costWithoutUsd += row.without ?? row.usd + saved;
    out.tokensSaved += row.tokensSaved ?? 0;
    if (row.via === 'prune') out.viaPrune++;
    else out.direct++;
    if (row.cacheHit) out.cacheHits++;
    if (row.routed) out.routed++;
  }
  return out;
}

export function totals() {
  const all = rows();
  // Free-tier daily quotas reset at midnight Pacific time, so "today" is counted on that clock.
  const pacificDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const day = pacificDay(new Date());
  const byRun: Record<string, { calls: number; usd: number }> = {};
  let usd = 0;
  let today = 0;
  for (const row of all) {
    usd += row.usd;
    if (pacificDay(new Date(row.at)) === day) today++;
    const r = (byRun[row.run] ??= { calls: 0, usd: 0 });
    r.calls++;
    r.usd += row.usd;
  }
  return { calls: all.length, today, usd, byRun };
}
