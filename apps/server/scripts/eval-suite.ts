// Runs simple, standalone requests through the full build pipeline against the live API and scores what comes back.
// Every case is several billed calls, so this stays out of CI. Run with `npm run eval:suite -- [domain|case-id ...]`.
// Results land in apps/server/.spend/eval-<timestamp>.json, and every call is in the spend ledger.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamEvent } from '@tv/core';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });
process.env.SPEND_RUN ??= `eval-${new Date().toISOString().slice(0, 16)}`;

const { build } = await import('../src/agents');
const { runTests } = await import('@tv/core');
const { totals, estimate } = await import('../src/spend');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Spec = any;
type Check = [label: string, test: (spec: Spec) => boolean];
interface Case {
  id: string;
  domain: string;
  prompt: string;
  checks: Check[];
  // The user asked for a stressed system, so checks still failing at the end are what they wanted to see.
  stressed?: boolean;
}

interface LoosePart {
  id: string;
  type: string;
  custom?: { label: string; pins: string[] };
}
const parts = (s: Spec): LoosePart[] => s.parts ?? [];
const label = (p: LoosePart) => `${p.type} ${p.id} ${p.custom?.label ?? ''}`.toLowerCase();
const has = (re: RegExp) => (s: Spec) => parts(s).some((p) => re.test(label(p)));
const count = (re: RegExp) => (s: Spec) => parts(s).filter((p) => re.test(label(p))).length;
const MCU = /arduino|esp32|esp8266|microcontroller|atmega|pico|stm32|xiao|rp2040/;
const noMcu: Check = ['no microcontroller', (s) => !parts(s).some((p) => p.type === 'arduino' || MCU.test(label(p)))];
const noProgram: Check = ['no sketch program', (s) => !s.program?.length && !s.drive?.length];
const breadboard: Check = ['on a breadboard', (s) => s.layout === 'breadboard' || has(/breadboard/)(s)];
// The design's own behaviour tests: at least n of them, and every one passes in simulation.
const selfTested = (n: number): Check => [
  `${n}+ passing behaviour tests`,
  (s) => {
    const r = runTests(s);
    return r.total >= n && r.passed === r.total;
  },
];
const nodes = (s: Spec): Array<{ kind: string; label: string }> => s.nodes ?? [];
const tables = (s: Spec): Array<{ name: string; rows: number }> => s.tables ?? [];
// Flow-network domains: how many units of a kind the design has (count, default 1, summed over nodes).
const units = (kind: string) => (s: Spec) => (s.nodes ?? []).filter((n: { kind: string }) => n.kind === kind).reduce((a: number, n: { count?: number }) => a + (n.count ?? 1), 0);
const kind = (k: string): Check => [k, (s) => units(k)(s) > 0];
const atLeast = (k: string, n: number): Check => [`${n}+ ${k}`, (s) => units(k)(s) >= n];
const exactly = (k: string, n: number): Check => [`${n} ${k}`, (s) => units(k)(s) === n];

const CASES: Case[] = [
  // Electronics: standalone circuits a student would build, most with no microcontroller.
  {
    id: 'e-adder',
    domain: 'electronics',
    prompt: '2 bit calculator on a breadboard',
    checks: [noMcu, breadboard, ['logic gates', has(/74|xor|and|adder|logic|gate/)], ['input switches', has(/switch|button|dip/)], ['output leds', has(/led/)], selfTested(16)],
  },
  {
    id: 'e-led',
    domain: 'electronics',
    prompt: 'An LED with a resistor powered by a 9V battery',
    checks: [noMcu, noProgram, ['battery', has(/battery/)], ['led', has(/led/)], ['resistor', has(/resistor/)]],
  },
  { id: 'e-555', domain: 'electronics', prompt: 'A 555 timer blinking an LED', checks: [noMcu, ['555', has(/555/)], ['led', has(/led/)], ['capacitor', has(/capacitor/)]] },
  {
    id: 'e-transistor',
    domain: 'electronics',
    prompt: 'A transistor switch that turns on a motor when I press a button',
    checks: [noMcu, ['transistor', has(/transistor|npn|mosfet|2n2222|bc547|tip120/)], ['motor', has(/motor/)], ['button', has(/button|switch/)]],
  },
  {
    id: 'e-parallel',
    domain: 'electronics',
    prompt: 'Three bulbs in parallel on a 6V battery with a switch',
    checks: [noMcu, noProgram, ['switch', has(/switch|button/)], ['three loads', (s) => count(/bulb|lamp|led/)(s) >= 3]],
  },
  {
    id: 'e-and-gate',
    domain: 'electronics',
    prompt: 'An AND gate with two push buttons lighting an LED, on a breadboard',
    checks: [noMcu, breadboard, ['and gate', has(/and|7408|08/)], ['two buttons', (s) => count(/button|switch/)(s) >= 2], selfTested(4)],
  },
  {
    id: 'e-divider',
    domain: 'electronics',
    prompt: 'A voltage divider that turns 12V into 5V',
    checks: [noMcu, noProgram, ['two resistors', (s) => parts(s).filter((p) => p.type === 'resistor').length >= 2]],
  },
  {
    id: 'e-counter',
    domain: 'electronics',
    prompt: 'A binary counter with a 555 clock and four LEDs',
    checks: [noMcu, ['555', has(/555/)], ['counter', has(/counter|4040|93|161|4029|flip/)], ['four leds', (s) => count(/led/)(s) >= 4]],
  },
  {
    id: 'e-xiao',
    domain: 'electronics',
    prompt: 'A Seeed XIAO ESP32C3 blinking an LED',
    checks: [
      ['xiao board', has(/xiao/)],
      ['no arduino uno', (s) => !parts(s).some((p) => p.type === 'arduino')],
      ['led', has(/led/)],
    ],
  },
  {
    id: 'e-pico',
    domain: 'electronics',
    prompt: 'A Raspberry Pi Pico sweeping a servo',
    checks: [
      ['pico board', has(/pico|rp2040/)],
      ['no arduino uno', (s) => !parts(s).some((p) => p.type === 'arduino')],
      ['servo', has(/servo/)],
    ],
  },
  {
    id: 'e-robot',
    domain: 'electronics',
    prompt: 'An Arduino robot with two motors that stops before a wall',
    checks: [
      ['arduino', has(/arduino/)],
      ['ultrasonic', has(/ultrasonic|distance/)],
      ['motors', (s) => count(/motor/)(s) >= 2],
    ],
  },
  {
    id: 'e-thermostat',
    domain: 'electronics',
    prompt: 'A thermostat that turns a heater on below 20C',
    checks: [
      ['heater', has(/heat/)],
      ['temperature sensor', has(/temp|thermistor|ds18|dht|lm35/)],
    ],
  },
  // Wider coverage: parts and projects beyond the first set.
  {
    id: 'e2-nightlight',
    domain: 'electronics',
    prompt: 'A night light that turns an LED on when it gets dark, using an LDR and a transistor',
    checks: [noMcu, ['ldr', has(/ldr/)], ['transistor', has(/transistor|npn|2n2222|bc547|2n3904|mosfet/)], ['led', has(/led/)]],
  },
  { id: 'e2-dimmer', domain: 'electronics', prompt: 'An LED dimmer with a potentiometer', checks: [noMcu, ['pot', has(/pot/)], ['led', has(/led/)]] },
  {
    id: 'e2-flyback',
    domain: 'electronics',
    prompt: 'A relay switched by a transistor from a button, with a flyback diode, turning on a 12V lamp',
    checks: [noMcu, ['diode', has(/diode/)], ['relay', has(/relay/)], ['lamp', has(/lamp|bulb/)]],
  },
  { id: 'e2-rectifier', domain: 'electronics', prompt: 'A battery reverse polarity protection diode in front of an LED circuit', checks: [noMcu, ['diode', has(/diode/)]] },
  {
    id: 'e2-7seg',
    domain: 'electronics',
    prompt: 'Four switches setting a number shown on a 7-segment display through a CD4511 decoder',
    checks: [noMcu, ['7-segment', has(/seven_segment|7-seg|segment/)], ['decoder', has(/4511|decoder|7447|74hc47/)], ['four switches', (s) => count(/switch/)(s) >= 4]],
  },
  {
    id: 'e2-traffic',
    domain: 'electronics',
    prompt: 'A traffic light sequence with red, yellow and green LEDs using a 555 and a 4017 counter, no microcontroller',
    checks: [noMcu, ['555', has(/555/)], ['4017', has(/4017|counter|decade/)], ['three leds', (s) => count(/led/)(s) >= 3]],
  },
  {
    id: 'e2-flipflop',
    domain: 'electronics',
    prompt: 'A push button that toggles an LED on and off using a D flip-flop',
    checks: [noMcu, ['flip-flop', has(/flip|4013|7474|74hc74/)], ['button', has(/button/)]],
  },
  {
    id: 'e2-comparator',
    domain: 'electronics',
    prompt: 'A temperature alarm: a thermistor and an LM393 comparator sound a buzzer above 40C',
    checks: [noMcu, ['thermistor', has(/thermistor/)], ['comparator', has(/393|358|comparator/)], ['buzzer', has(/buzzer/)]],
  },
  {
    id: 'e2-hbridge',
    domain: 'electronics',
    prompt: 'A DC motor that an Arduino drives forwards and backwards through an L298N, reversing every 3 seconds',
    checks: [
      ['arduino', has(/arduino/)],
      ['driver', has(/motor_driver|l298/)],
      ['motor', has(/motor/)],
    ],
  },
  {
    id: 'e2-esp-oled',
    domain: 'electronics',
    prompt: 'An ESP32 reading a DHT22 and showing temperature on an OLED',
    checks: [
      ['esp32', has(/esp32/)],
      ['dht', has(/dht/)],
      ['oled', has(/oled|display/)],
    ],
  },
  {
    id: 'e2-uno-7seg',
    domain: 'electronics',
    prompt: 'An Arduino counting from 0 to 9 on a 7-segment display, one digit per second',
    checks: [
      ['arduino', has(/arduino/)],
      ['7-segment', has(/seven_segment|segment/)],
    ],
  },
  {
    id: 'e2-series',
    domain: 'electronics',
    prompt: 'Two resistors in series with an LED on a 5V supply',
    checks: [noMcu, noProgram, ['two resistors', (s) => parts(s).filter((p) => p.type === 'resistor').length >= 2]],
  },
  { id: 'e2-buzzer-btn', domain: 'electronics', prompt: 'A doorbell: a button sounds a buzzer', checks: [noMcu, ['button', has(/button/)], ['buzzer', has(/buzzer/)]] },
  {
    id: 'e2-or-gate',
    domain: 'electronics',
    prompt: 'An OR gate and an XOR gate side by side, each with two switches and an LED, on a breadboard',
    checks: [noMcu, breadboard, ['or', has(/or|7432|32/)], ['xor', has(/xor|7486|86/)], selfTested(4)],
  },
  {
    id: 'e2-servo-pot',
    domain: 'electronics',
    prompt: 'An Arduino moving a servo to follow a potentiometer',
    checks: [
      ['arduino', has(/arduino/)],
      ['pot', has(/pot/)],
      ['servo', has(/servo/)],
    ],
  },
  {
    id: 'e2-fan-temp',
    domain: 'electronics',
    prompt: 'A fan that switches on through a MOSFET when an Arduino reads the room above 28C',
    checks: [
      ['arduino', has(/arduino/)],
      ['mosfet', has(/mosfet|irf|irlz|transistor/)],
      ['fan', has(/fan|motor/)],
    ],
  },
  {
    id: 'e2-capacitor',
    domain: 'electronics',
    prompt: 'A capacitor that keeps an LED lit for a few seconds after the button is released',
    checks: [noMcu, ['capacitor', has(/capacitor/)], ['button', has(/button/)], ['led', has(/led/)]],
  },
  {
    id: 'e2-pico-ldr',
    domain: 'electronics',
    prompt: 'A Raspberry Pi Pico that turns on a lamp through a relay when an LDR reads dark',
    checks: [
      ['pico', has(/pico|rp2040/)],
      ['ldr', has(/ldr/)],
      ['relay', has(/relay/)],
    ],
  },
  {
    id: 'e2-half-adder',
    domain: 'electronics',
    prompt: 'A half adder from logic chips with two switches and two LEDs',
    checks: [noMcu, ['xor', has(/xor|86/)], ['and', has(/and|08/)], selfTested(4)],
  },
  {
    id: 'e2-wrong',
    domain: 'electronics',
    prompt: 'An LED connected straight to a 9V battery with no resistor',
    checks: [noMcu, ['no resistor (as asked)', (s) => !parts(s).some((p) => p.type === 'resistor')]],
    stressed: true,
  },
  // Software
  {
    id: 's-cache',
    domain: 'software',
    prompt: 'A web app with a cache in front of Postgres',
    checks: [
      ['cache', (s) => nodes(s).some((n) => n.kind === 'cache')],
      ['database', (s) => nodes(s).some((n) => n.kind === 'database')],
    ],
  },
  {
    id: 's-queue',
    domain: 'software',
    prompt: 'An image upload service that resizes images through a job queue',
    checks: [
      ['queue', (s) => nodes(s).some((n) => n.kind === 'queue')],
      ['worker', (s) => nodes(s).filter((n) => n.kind === 'service').length >= 2],
    ],
  },
  {
    id: 's-payments',
    domain: 'software',
    prompt: 'A payment system calling Stripe with retries',
    checks: [['external stripe', (s) => nodes(s).some((n) => n.kind === 'external')]],
  },
  {
    id: 's-chat',
    domain: 'software',
    prompt: 'A chat app with websockets, a message broker and a database',
    checks: [['broker', (s) => nodes(s).some((n) => n.kind === 'queue' || /broker|kafka|redis|rabbit/i.test(n.label))]],
  },
  // Database
  {
    id: 'd-uni',
    domain: 'database',
    prompt: 'A university database with students, courses and enrollments',
    checks: [
      ['three tables', (s) => tables(s).length >= 3],
      ['enrollment', (s) => tables(s).some((t) => /enrol/i.test(t.name))],
    ],
  },
  {
    id: 'd-shop',
    domain: 'database',
    prompt: 'An e-commerce schema with products, carts and reviews',
    checks: [
      ['products', (s) => tables(s).some((t) => /product/i.test(t.name))],
      ['reviews', (s) => tables(s).some((t) => /review/i.test(t.name))],
    ],
  },
  {
    id: 'd-slow',
    domain: 'database',
    prompt: 'An orders table with 5 million rows that is slow to query by customer',
    checks: [['orders 5M', (s) => tables(s).some((t) => /order/i.test(t.name) && t.rows >= 4_000_000)]],
  },
  // Flow-network domains (PR #17). Cases for a domain that isn't installed are skipped.
  { id: 'h-er', domain: 'hospital', prompt: 'An ER with 3 triage nurses, 30 beds and one CT scanner', checks: [exactly('triage', 3), atLeast('er', 30), exactly('imaging', 1)] },
  { id: 'h-full', domain: 'hospital', prompt: 'A hospital with an ICU that keeps filling up', checks: [kind('icu'), kind('triage')], stressed: true },
  { id: 'a-gates', domain: 'airport', prompt: 'An airport with two runways and 20 gates', checks: [exactly('runway', 2), exactly('gates', 20)] },
  { id: 'c-agents', domain: 'callcenter', prompt: 'A customer support call center with an IVR menu and 25 agents', checks: [kind('ivr'), exactly('agents', 25)] },
  { id: 'f-car', domain: 'factory', prompt: 'A car factory with welding, painting and final assembly', checks: [kind('welding'), kind('paint'), kind('assembly')] },
  {
    id: 'p-grid',
    domain: 'power',
    prompt: 'A power grid with a gas plant, a solar farm and two substations feeding a city',
    checks: [kind('gas'), kind('solar'), atLeast('substation', 2), kind('city')],
  },
  {
    id: 'sc-ports',
    domain: 'supply',
    prompt: 'A supply chain from two suppliers through a port to five retail stores',
    checks: [atLeast('supplier', 2), kind('port'), atLeast('store', 5)],
  },
  {
    id: 'wt-city',
    domain: 'water',
    prompt: 'A city water system with a reservoir, a treatment plant and a water tower',
    checks: [kind('reservoir'), kind('treatment'), kind('tank')],
  },
  // Routing collisions: words that belong to another domain's vocabulary.
  { id: 'x-flights-app', domain: 'software', prompt: 'A web app for booking airline flights with a payment service and a database', checks: [] },
  {
    id: 'x-patients-db',
    domain: 'database',
    prompt: 'A clinic database schema with patients, doctors and appointments',
    checks: [['patients table', (s) => tables(s).some((t) => /patient/i.test(t.name))]],
  },
  { id: 'x-solar-circuit', domain: 'electronics', prompt: 'A small solar panel charging a battery through a diode, lighting an LED', checks: [] },
  { id: 'x-pump-arduino', domain: 'electronics', prompt: 'An Arduino that runs a water pump when the tank level sensor reads low', checks: [] },
  {
    id: 'x-factory-conveyor',
    domain: 'factory',
    prompt: 'A production line with CNC machines, inspection and packing',
    checks: [kind('machine'), kind('inspection'), kind('packing')],
  },
  // Warehouse
  {
    id: 'w-basic',
    domain: 'warehouse',
    prompt: 'A warehouse with 6 robots and 3 aisles',
    checks: [
      ['6 robots', (s) => s.robots === 6],
      ['3 aisles', (s) => s.aisles === 3],
    ],
  },
  {
    id: 'w-heavy',
    domain: 'warehouse',
    prompt: 'A fulfilment centre under heavy demand with two chargers',
    checks: [
      ['heavy', (s) => s.demand === 'heavy'],
      ['2 chargers', (s) => s.chargers === 2],
    ],
  },
];

const filters = process.argv.slice(2);
const { DOMAINS } = await import('@tv/core');
const installed = CASES.filter((c) => c.domain in DOMAINS);
const chosen = filters.length
  ? installed.filter((c) =>
      filters.some(
        (f) =>
          c.id === f || c.domain === f || (f === 'new' && !['electronics', 'software', 'database', 'warehouse'].includes(c.domain)) || (f === 'routing' && c.id.startsWith('x-')),
      ),
    )
  : installed;
const BUDGET_USD = Number(process.env.EVAL_BUDGET_USD ?? 0.5);
const before = totals().usd;
// Protects the key's free-tier daily quota for the rest of the team: nothing starts once today's ledger reaches the cap.
const DAILY_CAP = Number(process.env.EVAL_DAILY_CAP ?? 500);
if (totals().today >= DAILY_CAP) {
  console.log(`Today's ledger already has ${totals().today} calls, at or over EVAL_DAILY_CAP=${DAILY_CAP}; not running.`);
  process.exit(0);
}

async function runCase(c: Case) {
  const events: StreamEvent[] = [];
  const started = Date.now();
  let crash: string | undefined;
  try {
    await build(c.prompt, (e) => events.push(e));
  } catch (error) {
    crash = String(error);
  }
  const find = <T extends StreamEvent['type']>(type: T) => events.find((e) => e.type === type) as Extract<StreamEvent, { type: T }> | undefined;
  const env = find('environment')?.environment;
  const refusal = crash ?? find('refusal')?.refusal.reason;
  const usage = events.flatMap((e) => (e.type === 'usage' ? [e.usage] : []));
  const spec = env?.spec as Spec;
  const results = spec
    ? c.checks.map(([name, test]) => {
        let ok = false;
        try {
          ok = test(spec);
        } catch {
          ok = false;
        }
        return { name, ok };
      })
    : [];
  return {
    id: c.id,
    prompt: c.prompt,
    // A design shipped with checks still failing is a failure, whatever parts it has.
    passed: Boolean(spec) && env?.domain === c.domain && results.every((r) => r.ok) && (c.stressed || !env?.unmodelled.some((u) => u.startsWith('Still failing'))),
    domain: env?.domain,
    wanted: c.domain,
    seconds: (Date.now() - started) / 1000,
    calls: usage.length,
    usd: usage.reduce((a, u) => a + estimate(u), 0),
    failed: results.filter((r) => !r.ok).map((r) => r.name),
    refusal,
    name: env?.name,
    unmodelled: env?.unmodelled,
    parts: parts(spec ?? {}).map((p) => `${p.id}:${p.type}${p.custom ? `(${p.custom.label})` : ''}`),
    spec,
  };
}

const out: Array<Awaited<ReturnType<typeof runCase>>> = [];
const queue = [...chosen];
const workers = Array.from({ length: Number(process.env.EVAL_CONCURRENCY ?? 3) }, async () => {
  while (queue.length) {
    if (totals().today >= DAILY_CAP) {
      console.log(`daily cap of ${DAILY_CAP} calls reached, stopping`);
      return;
    }
    if (totals().usd - before > BUDGET_USD) {
      console.log(`budget of $${BUDGET_USD} reached, stopping`);
      return;
    }
    const c = queue.shift()!;
    const r = await runCase(c);
    out.push(r);
    const still = r.unmodelled?.filter((u) => u.startsWith('Still failing')) ?? [];
    const why = r.passed
      ? ''
      : still.length && !r.failed.length
        ? still.join('; ').slice(0, 220)
        : r.refusal
          ? `refused: ${r.refusal.slice(0, 160)}`
          : r.domain !== r.wanted
            ? `routed to ${r.domain}`
            : `missing: ${r.failed.join(', ')}`;
    console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.id.padEnd(14)} ${r.calls} calls $${r.usd.toFixed(4)} ${r.seconds.toFixed(0)}s  ${why}`);
    if (!r.passed && r.parts.length) console.log(`     parts: ${r.parts.join(' ')}`);
  }
});
await Promise.all(workers);

const passed = out.filter((r) => r.passed).length;
const after = totals();
console.log(`\n${passed}/${out.length} passed. This run ~$${(after.usd - before).toFixed(4)}; ledger total ~$${after.usd.toFixed(4)} over ${after.calls} calls.`);
const dir = path.resolve(here, '../.spend');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `eval-${Date.now()}.json`), JSON.stringify(out, null, 2));
process.exit(0);
