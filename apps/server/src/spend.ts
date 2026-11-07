import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Usage } from '@tv/core';

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
      }) + '\n',
    );
  } catch {
    // The ledger is best effort; a read-only disk must not break a build.
  }
}

export function totals() {
  let lines: string[] = [];
  try {
    lines = readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return { calls: 0, usd: 0, in: 0, out: 0, byRun: {} as Record<string, { calls: number; usd: number }> };
  }
  const byRun: Record<string, { calls: number; usd: number }> = {};
  let usd = 0,
    inTok = 0,
    outTok = 0;
  for (const line of lines) {
    const row = JSON.parse(line) as { run: string; usd: number; in: number; out: number };
    usd += row.usd;
    inTok += row.in;
    outTok += row.out;
    const r = (byRun[row.run] ??= { calls: 0, usd: 0 });
    r.calls++;
    r.usd += row.usd;
  }
  return { calls: lines.length, usd, in: inTok, out: outTok, byRun };
}
