// Builds from a pasted file against the live API and prints the trace, to see an import end to end. Not part of CI.
// Run with `npx tsx scripts/try-import.ts <file>`; the file is read as the whole request.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamEvent } from '@tv/core';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });
process.env.DESIGN_CACHE = 'off';
const { build } = await import('../src/agents');

const prompt = readFileSync(process.argv[2], 'utf8');
await build(prompt, (e: StreamEvent) => {
  if (e.type === 'step' && e.status !== 'running') console.log(`  [${e.agent}/${e.engine}] ${e.title}${e.detail ? ` — ${e.detail}` : ''}`);
  if (e.type === 'environment') {
    const { name, summary, unmodelled, spec } = e.environment;
    const s = spec as { workload?: unknown; traffic?: unknown; tables?: Array<{ name: string; rows: number }> };
    const load = s.workload ? `rows ${JSON.stringify(s.tables?.map((t) => [t.name, t.rows]))}\n  workload ${JSON.stringify(s.workload)}` : `traffic ${String(s.traffic)}`;
    console.log(`\n${name}: ${summary}\n  not modelled: ${unmodelled.join(' | ')}\n  ${load}\n`);
  }
  if (e.type === 'refusal') console.log(`REFUSED: ${e.refusal.reason}`);
  if (e.type === 'findings') for (const f of e.findings) console.log(`  claim: ${f.claim} -> ${f.verdict}`);
});
process.exit(0);
