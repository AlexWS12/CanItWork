// Runs one build with the Swarms design council on and prints the trace, findings and spend. Spends real Swarms credit: run deliberately.
// Usage: npx tsx scripts/try-council.ts "your prompt"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });
process.env.DESIGN_COUNCIL = 'on';
process.env.DESIGN_CACHE = 'off';
process.env.SPEND_RUN ??= 'try-council';

const { build } = await import('../src/agents');
const prompt = process.argv.slice(2).join(' ') || 'A 4-bit binary counter clocked by a 555 timer, with four LEDs, on a breadboard';
const balance = async () => {
  const res = await fetch('https://api.swarms.world/v1/account/credits', { headers: { 'x-api-key': process.env.SWARMS_API_KEY ?? '' } });
  const body = (await res.json()) as { total_credits?: number; credit?: number };
  return body.total_credits ?? body.credit ?? NaN;
};

const before = await balance();
const started = Date.now();
const events: Array<Record<string, any>> = [];
await build(prompt, (e) => events.push(e as Record<string, any>));
const after = await balance();

for (const e of events)
  if (e.type === 'step' && e.status !== 'running') console.log(`${String(e.engine).padEnd(9)} ${e.status.padEnd(6)} ${e.title}: ${String(e.detail ?? '').slice(0, 300)}`);
const env = events.find((e) => e.type === 'environment')?.environment;
const refusal = events.find((e) => e.type === 'refusal')?.refusal;
console.log(env ? `\nBuilt: ${env.name}; unmodelled: ${JSON.stringify(env.unmodelled).slice(0, 300)}` : `\nRefused: ${refusal?.reason}`);
for (const f of events.find((e) => e.type === 'findings')?.findings ?? []) console.log(`${f.verdict.toUpperCase()}: ${f.claim}\n   ${f.evidence}`);
const swarmsUsage = events.filter((e) => e.type === 'usage' && e.usage.engine === 'swarms').map((e) => e.usage.costUsd);
console.log(
  `\n${Math.round((Date.now() - started) / 1000)} s. Swarms balance $${before.toFixed(4)} -> $${after.toFixed(4)} (spent $${(before - after).toFixed(4)}); Swarms runs reported: ${JSON.stringify(swarmsUsage)}`,
);
process.exit(0);
