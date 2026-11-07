// Runs the Interpreter's Jev request on labelled prompts against the live API, to tune the thresholds in agents.ts.
// Every prompt is a billed request, so this stays out of CI. Run with `npm run eval:interpreter`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DomainId } from '@tv/core';
import { config } from 'dotenv';
import { askDomain, decideDomain } from '../src/agents';
import { hasJev } from '../src/jev';

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

// null means tv should refuse.
const CASES: Array<[string, DomainId | null]> = [
  ['An Arduino with a motor driver, two motors and an ultrasonic sensor', 'electronics'],
  ['An ESP32 reading a temperature sensor and showing it on an OLED display', 'electronics'],
  ['A servo that sweeps when a button is pressed', 'electronics'],
  ['A distributed payment system with a load balancer and microservices', 'software'],
  ['A web app with a cache in front of Postgres and a job queue', 'software'],
  ['What happens to checkout when the auth service gets slow?', 'software'],
  ['A university database schema with students and courses', 'database'],
  ['An orders table that gets slow as it grows past a million rows', 'database'],
  ['An e-commerce schema with products, carts and reviews', 'database'],
  ['An autonomous warehouse with five robots and two conveyors', 'warehouse'],
  ['A fulfilment centre where robots pick orders and recharge at docks', 'warehouse'],
  ['Plan a three course dinner menu for my parents', null],
  ['Simulate aerodynamics over a wing', null],
  ['Model the spread of a flu outbreak in a city', null],
  ['Write me a poem about the sea', null],
  ['Predict next quarter stock prices for my portfolio', null],
  // Borderline: no fixed expectation, they show where the thresholds sit.
  ['A CI pipeline with build agents and a test queue', 'software'],
  ['A smart home with sensors, a hub and a phone app', 'electronics'],
  ['A factory line with a conveyor and a robot arm', 'warehouse'],
  ['A bank account ledger with transactions and balances', 'database'],
];

if (!hasJev()) {
  console.error('Set TYPESAFE_API_KEY in .env first.');
  process.exit(1);
}

const pct = (p: number) => `${Math.round(p * 100)}%`.padStart(4);
let right = 0;
for (const [prompt, expected] of CASES) {
  const read = await askDomain(prompt, () => {});
  const alone = decideDomain(read, false);
  const withGemini = decideDomain(read, true);
  const got = alone.kind === 'route' ? alone.id : null;
  if (got === expected) right++;
  const fits = Object.entries(read.fits)
    .map(([id, p]) => `${id}${pct(p)}`)
    .join(' ');
  console.log(`${got === expected ? 'ok  ' : 'MISS'} ${prompt}`);
  console.log(`     pick ${read.pick ?? 'none'} conf ${pct(read.confidence)} | fits ${fits}`);
  console.log(`     expected ${expected ?? 'refuse'} | alone: ${alone.detail} | with Gemini: ${withGemini.kind}`);
}
console.log(`\n${right}/${CASES.length} decided as labelled without Gemini.`);
