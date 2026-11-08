// Runs simple, standalone requests through the full build pipeline against the live API and scores what comes back.
// Every case is several billed calls, so this stays out of CI. Run with `npm run eval:suite -- [domain|case-id ...]`.
// Results land in apps/server/.spend/eval-<timestamp>.json, and every call is in the spend ledger.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamEvent } from '@tv/core';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
// The eval measures design quality, so it leaves Swarms (Red Team, councils) off unless asked: set before .env loads, which never overrides it.
if (process.env.EVAL_SWARMS !== 'on') process.env.SWARMS_API_KEY = '';
config({ path: path.resolve(here, '../../../.env') });
process.env.SPEND_RUN ??= `eval-${new Date().toISOString().slice(0, 16)}`;
// The eval measures the Architect, so it never reuses a cached design.
process.env.DESIGN_CACHE = 'off';

const { build } = await import('../src/agents');
const { runTests } = await import('@tv/core');
const { totals, estimate } = await import('../src/spend');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Spec = any;
type Check = [label: string, test: (spec: Spec) => boolean];
interface Case {
  id: string;
  // The domain that should model it; a list when more than one is a fair fit.
  domain: string | string[];
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
// Fleets: how many units have a behaviour.
const roleCount = (s: Spec, behavior: string) =>
  (s.roles ?? []).filter((r: { behavior: string }) => r.behavior === behavior).reduce((a: number, r: { count: number }) => a + r.count, 0);
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
  // Wide arithmetic: far too many gates to wire by hand, so the design has to scale up rather than shrink the request.
  {
    id: 'e-wide-16',
    domain: 'electronics',
    prompt: 'Build a 16 bit calculator on a breadboard with logical gates',
    checks: [
      noMcu,
      breadboard,
      ['logic gate chips', has(/74|xor|and|gate/)],
      ['32 input switches', (s) => parts(s).filter((p) => p.type === 'switch').length >= 32],
      ['17 output LEDs', (s) => parts(s).filter((p) => p.type === 'led').length >= 17],
      selfTested(8),
    ],
  },
  {
    id: 'e-wide-8',
    domain: 'electronics',
    prompt: 'An 8-bit adder built from logic gates with switches and LEDs',
    checks: [
      noMcu,
      ['16 input switches', (s) => parts(s).filter((p) => p.type === 'switch').length >= 16],
      ['9 output LEDs', (s) => parts(s).filter((p) => p.type === 'led').length >= 9],
      selfTested(8),
    ],
  },
  {
    id: 'e-wide-sub',
    domain: 'electronics',
    prompt: 'A 4-bit calculator that can add and subtract, made from logic chips on a breadboard',
    checks: [
      noMcu,
      breadboard,
      ['8 number switches and a mode switch', (s) => parts(s).filter((p) => p.type === 'switch').length >= 9],
      ['5 output LEDs', (s) => parts(s).filter((p) => p.type === 'led').length >= 5],
      selfTested(8),
    ],
  },
  {
    id: 'e-wide-mul',
    domain: 'electronics',
    prompt: 'A 4-bit multiplier made from logic gates on a breadboard',
    checks: [
      noMcu,
      ['8 input switches', (s) => parts(s).filter((p) => p.type === 'switch').length >= 8],
      ['8 product LEDs', (s) => parts(s).filter((p) => p.type === 'led').length >= 8],
      selfTested(8),
    ],
  },
  {
    id: 'e-wide-cmp',
    domain: 'electronics',
    prompt: 'An 8-bit comparator that lights one LED when A is bigger than B, one when they are equal and one when A is smaller',
    checks: [
      noMcu,
      ['16 input switches', (s) => parts(s).filter((p) => p.type === 'switch').length >= 16],
      ['3 result LEDs', (s) => parts(s).filter((p) => p.type === 'led').length >= 3],
      selfTested(8),
    ],
  },
  {
    id: 'e-wide-alu',
    domain: 'electronics',
    prompt: 'A 4-bit ALU from logic chips that can add, subtract, AND and OR two numbers',
    checks: [
      noMcu,
      ['8 number switches and 2 select switches', (s) => parts(s).filter((p) => p.type === 'switch').length >= 10],
      ['result LEDs', (s) => parts(s).filter((p) => p.type === 'led').length >= 4],
      selfTested(8),
    ],
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
  {
    id: 'e3-opamp',
    domain: 'electronics',
    prompt: 'A non-inverting amplifier with an LM358 and a gain of 11, fed from a potentiometer',
    checks: [noMcu, ['op-amp stage', (s) => parts(s).some((p: any) => p.custom?.amplifiers?.length)], ['pot', has(/pot/)]],
  },
  {
    id: 'e3-zener',
    domain: 'electronics',
    prompt: 'A 5.1V Zener regulator powered from a 9V battery driving an LED',
    checks: [noMcu, ['zener', (s) => parts(s).some((p: any) => p.zener)]],
  },
  {
    id: 'e3-buffer',
    domain: 'electronics',
    prompt: 'An op-amp voltage follower buffering a light sensor divider into an LED bar of three comparators',
    checks: [noMcu, ['ldr', has(/ldr/)], ['three leds', (s) => count(/led/)(s) >= 3]],
  },
  // Breadth: systems of every kind, phrased the way people ask. Several have no obvious home, to find the gaps.
  { id: 'b-drones', domain: 'fleet', prompt: 'A swarm of organized drones with different roles', checks: [['2+ roles', (s) => (s.roles ?? []).length >= 2]] },
  {
    id: 'b-sar',
    domain: 'fleet',
    prompt: 'Search and rescue over a 2 km forest with 6 scout drones, 2 relay drones and 3 supply drones',
    checks: [
      ['6 searchers', (s) => (s.roles ?? []).filter((r: { behavior: string }) => r.behavior === 'search').reduce((a: number, r: { count: number }) => a + r.count, 0) === 6],
      ['2 relays', (s) => (s.roles ?? []).filter((r: { behavior: string }) => r.behavior === 'relay').reduce((a: number, r: { count: number }) => a + r.count, 0) === 2],
      ['3 deliverers', (s) => (s.roles ?? []).filter((r: { behavior: string }) => r.behavior === 'deliver').reduce((a: number, r: { count: number }) => a + r.count, 0) === 3],
    ],
  },
  {
    id: 'b-rovers',
    domain: 'fleet',
    prompt: 'A team of 5 Mars rovers exploring a crater from a lander',
    checks: [['ground units', (s) => (s.roles ?? []).some((r: { ground?: boolean }) => r.ground)]],
  },
  {
    id: 'b-sidewalk',
    domain: 'fleet',
    prompt: 'Sidewalk delivery robots bringing parcels from a hub to 12 houses',
    checks: [
      ['known targets', (s) => s.known === true],
      ['12 targets', (s) => s.targets === 12],
    ],
  },
  {
    id: 'b-patrol',
    domain: 'fleet',
    prompt: 'Security drones patrolling the perimeter of a solar farm in shifts',
    checks: [['patrol role', (s) => (s.roles ?? []).some((r: { behavior: string }) => r.behavior === 'patrol')]],
  },
  { id: 'b-spray', domain: 'fleet', prompt: 'Crop-spraying drones covering a 50 hectare farm', checks: [] },
  { id: 'b-streaming', domain: 'software', prompt: 'A video streaming platform with a CDN, an encoding pipeline and a recommendation service', checks: [] },
  { id: 'b-k8s', domain: 'software', prompt: 'A Kubernetes cluster running a web service that gets a traffic spike', checks: [] },
  { id: 'b-smarthome', domain: ['electronics', 'software'], prompt: 'A smart home with sensors and a cloud backend', checks: [] },
  { id: 'b-bank', domain: 'database', prompt: 'A banking schema with accounts, transfers and audit logs', checks: [] },
  { id: 'b-friday-er', domain: 'hospital', prompt: 'An emergency room on a busy Friday night', checks: [] },
  { id: 'b-kitchen', domain: ['factory', 'queues', 'callcenter'], prompt: 'A restaurant kitchen during the dinner rush', checks: [] },
  { id: 'b-microgrid', domain: 'power', prompt: 'A neighbourhood microgrid with rooftop solar and a battery', checks: [] },
  { id: 'b-satellites', domain: 'fleet', prompt: 'A constellation of satellites relaying data to ground stations', checks: [] },
  { id: 'b-ants', domain: 'fleet', prompt: 'An ant colony foraging for food and carrying it back to the nest', checks: [] },
  { id: 'b-security-lines', domain: ['queues', 'airport', 'callcenter'], prompt: 'Airport security lines with 6 scanners at peak hour', checks: [] },
  { id: 'b-fulfilment', domain: ['supply', 'warehouse'], prompt: 'Online orders flowing from suppliers through a fulfilment centre to customers', checks: [] },
  { id: 'b-intersection', domain: ['queues', 'fleet', 'factory'], prompt: 'A city intersection with traffic lights and cars', checks: [] },
  { id: 'b-elevators', domain: ['queues', 'callcenter', 'factory'], prompt: 'An elevator bank in a 20 floor office building at 9am', checks: [] },
  { id: 'b-coffee', domain: 'queues', prompt: 'A coffee shop with two baristas and a long morning line', checks: [] },
  { id: 'b-toll', domain: 'queues', prompt: 'A highway toll plaza with 6 booths, 2 of them electronic, at rush hour', checks: [] },
  // Fleets and queues, asked the way people ask.
  {
    id: 'fq-wildfire',
    domain: 'fleet',
    prompt: 'Firefighting drones: 3 thermal scouts find hotspots in a 1.5 km forest and 4 water drones drop water on them',
    checks: [
      ['3 scouts', (s) => roleCount(s, 'search') === 3],
      ['4 deliverers', (s) => roleCount(s, 'deliver') === 4],
    ],
  },
  { id: 'fq-warehouse-drones', domain: ['fleet', 'warehouse'], prompt: 'Indoor drones scanning inventory shelves at night', checks: [] },
  {
    id: 'fq-ocean',
    domain: 'fleet',
    prompt: 'Autonomous boats searching a bay for an oil spill, with a mothership as base',
    checks: [['search role', (s) => roleCount(s, 'search') > 0]],
  },
  {
    id: 'fq-campus',
    domain: 'fleet',
    prompt: 'A campus food delivery robot fleet: 8 robots, 20 dorms, one kitchen',
    checks: [
      ['8 robots', (s) => (s.roles ?? []).reduce((a: number, r: { count: number }) => a + r.count, 0) === 8],
      ['20 targets', (s) => s.targets === 20],
      ['known', (s) => s.known === true],
    ],
  },
  {
    id: 'fq-no-relay',
    domain: 'fleet',
    prompt: 'Five survey drones mapping a 3 km quarry with short-range radios and no relay',
    checks: [['no relay as asked', (s) => roleCount(s, 'relay') === 0]],
    stressed: true,
  },
  {
    id: 'fq-escort',
    domain: 'fleet',
    prompt: 'Medical supply drones delivering to field hospitals, each escorted by a security drone',
    checks: [['escort role', (s) => roleCount(s, 'escort') > 0]],
  },
  { id: 'fq-wind', domain: 'fleet', prompt: 'Delivery drones in a 15 m/s wind over the city', checks: [['wind 15', (s) => s.wind === 15]] },
  {
    id: 'fq-patrol-rovers',
    domain: 'fleet',
    prompt: 'Four security rovers patrolling a factory yard around three warehouses',
    checks: [
      ['ground', (s) => (s.roles ?? []).some((r: { ground?: boolean }) => r.ground)],
      ['obstacles', (s) => (s.area?.obstacles ?? []).length >= 3],
    ],
  },
  {
    id: 'fq-supermarket',
    domain: 'queues',
    prompt: 'A supermarket on Saturday: 8 checkouts, 4 self-service tills and one customer service desk',
    checks: [['8 checkouts', (s) => (s.nodes ?? []).some((n: { count?: number }) => n.count === 8)]],
  },
  {
    id: 'fq-dmv',
    domain: 'queues',
    prompt: 'A DMV office with a ticket kiosk, 5 service windows and a long waiting room',
    checks: [['5 windows', (s) => (s.nodes ?? []).some((n: { count?: number }) => n.count === 5)]],
  },
  { id: 'fq-stadium', domain: 'queues', prompt: 'Stadium entrance before kickoff: ticket scanners then bag checks for 40,000 fans', checks: [] },
  { id: 'fq-drive-thru', domain: 'queues', prompt: 'A fast food drive-thru with an order window and a pickup window', checks: [] },
  { id: 'fq-clinic', domain: ['queues', 'hospital'], prompt: 'A walk-in clinic front desk with 2 receptionists and 3 doctors', checks: [] },
  {
    id: 'fq-roundabout',
    domain: 'queues',
    prompt: 'A four-way intersection where the north road gets twice the traffic',
    checks: [['lanes', (s) => (s.nodes ?? []).some((n: { kind: string }) => n.kind === 'lane')]],
  },
  { id: 'fq-elevators-down', domain: 'queues', prompt: 'A 30 floor office tower with 6 elevators where 2 are out of service', checks: [] },
  { id: 'fq-bank', domain: 'queues', prompt: 'A bank branch at lunch hour with 3 tellers and an ATM', checks: [] },
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
  // The flow graph runs one way, so a physical runway appears once for landings and again for take-offs: count the ones taking arrivals.
  {
    id: 'a-gates',
    domain: 'airport',
    prompt: 'An airport with two runways and 20 gates',
    checks: [
      [
        '2 runways',
        (s) => {
          const runways = (s.nodes ?? []).filter((n: { kind: string }) => n.kind === 'runway');
          const landing = runways.filter(
            (r: { id: string }) =>
              !(s.edges ?? []).some(
                (e: { from: string; to: string }) => e.to === r.id && (s.nodes ?? []).find((n: { id: string; kind: string }) => n.id === e.from)?.kind === 'gates',
              ),
          );
          return units('runway')(s) === 2 || landing.reduce((a: number, n: { count?: number }) => a + (n.count ?? 1), 0) === 2;
        },
      ],
      exactly('gates', 20),
    ],
  },
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
const domainsOf = (c: Case) => (Array.isArray(c.domain) ? c.domain : [c.domain]);
const installed = CASES.filter((c) => domainsOf(c).some((d) => d in DOMAINS));
const chosen = filters.length
  ? installed.filter((c) =>
      filters.some(
        (f) =>
          c.id === f ||
          domainsOf(c).includes(f) ||
          (f === 'new' && !domainsOf(c).some((d) => ['electronics', 'software', 'database', 'warehouse'].includes(d))) ||
          (f === 'routing' && c.id.startsWith('x-')) ||
          (f === 'breadth' && c.id.startsWith('b-')) ||
          (f.endsWith('-') && c.id.startsWith(f)),
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
  // Score the circuit as built: a design's building blocks expand into their real parts first.
  const spec = env ? (DOMAINS[env.domain].compile(env.spec) as Spec) : (undefined as unknown as Spec);
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
    passed: Boolean(spec) && domainsOf(c).includes(env?.domain ?? '') && results.every((r) => r.ok) && (c.stressed || !env?.unmodelled.some((u) => u.startsWith('Still failing'))),
    domain: env?.domain,
    wanted: domainsOf(c).join('|'),
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
          : !r.wanted.split('|').includes(r.domain ?? '')
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
