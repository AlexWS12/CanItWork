import { defaultCompare, type Breakable, type Domain, type Evaluation, type Incident, type Inspection, type Metric, type Run, type TimedEvent } from '../../domain';
import { DEFAULT_SPEC, compileWorld } from './compile';
import { PatchSchema, WorldSpecSchema, type Patch, type SimEvent, type World, type WorldSpec } from './schema';
import { Sim } from './sim';
import { validateWorld } from './validate';

function toEvent(incident: Incident, at: number): SimEvent | null {
  const target = incident.target ?? '';
  switch (incident.type) {
    case 'fail_robot':
    case 'repair_robot':
      return { type: incident.type, at, robotId: target };
    case 'block_conveyor':
    case 'unblock_conveyor':
      return { type: incident.type, at, conveyorId: target };
    case 'offline_charger':
    case 'online_charger':
      return { type: incident.type, at, chargerId: target };
    case 'surge':
      return { type: 'surge', at, factor: Math.max(0.25, Math.min(5, incident.value ?? 2)) };
    default:
      return null;
  }
}

export class WarehouseRun implements Run {
  readonly sim: Sim;
  readonly log: TimedEvent[] = [];

  constructor(world: World, seed: number) {
    this.sim = new Sim(world, seed);
  }

  /** This run's own floor, which hand edits change as it goes. */
  get world() {
    return this.sim.world;
  }

  get tick() {
    return this.sim.tick;
  }

  step() {
    this.sim.step();
  }

  inject(incident: Incident) {
    const event = toEvent(incident, this.tick);
    if (!event) return;
    this.log.push({ at: this.tick, incident });
    this.sim.schedule(event);
  }

  apply(patches: unknown[]) {
    this.log.push({ at: this.tick, patches });
    this.sim.applyNow(patches as Patch[]);
  }

  check(patches: unknown[]) {
    for (const patch of patches as Patch[]) {
      const reason = this.sim.checkPatch(patch);
      if (reason) return reason;
    }
    return null;
  }

  evaluation(): Evaluation {
    const m = this.sim.metrics();
    return {
      score: m.delivered,
      scoreLabel: 'packages delivered',
      metrics: [
        { label: 'backlog', value: m.backlog },
        { label: 'avg latency', value: m.avgLatency },
        { label: 'utilization', value: `${Math.round(m.utilization * 100)}%` },
      ],
      series: this.sim.series.map((p) => ({ t: p.t, value: p.delivered })),
    };
  }

  telemetry(): Metric[] {
    const sim = this.sim;
    const last = sim.series[sim.series.length - 1];
    const online = sim.robots.filter((r) => r.mode !== 'failed').length;
    const backlog = sim.orders.length - sim.delivered;
    return [
      { label: 'delivered', value: sim.delivered },
      { label: 'per 100 ticks', value: last?.throughput ?? 0 },
      { label: 'backlog', value: backlog, tone: backlog > 25 ? 'warn' : undefined },
      { label: 'robots online', value: `${online}/${sim.robots.length}`, tone: online < sim.robots.length ? 'danger' : undefined },
    ];
  }

  breakables(): Breakable[] {
    const robot = this.sim.robots.find((r) => r.mode !== 'failed');
    const out: Breakable[] = [];
    if (robot) out.push({ label: `Robot ${robot.name}`, incident: { type: 'fail_robot', target: robot.id }, keywords: ['robot', robot.id.toLowerCase()] });
    out.push({ label: 'Belt', incident: { type: 'block_conveyor', target: this.world.conveyors[0].id }, keywords: ['conveyor', 'belt'] });
    out.push({ label: 'Charger', incident: { type: 'offline_charger', target: this.world.chargers[0].id }, keywords: ['charger', 'charging'] });
    out.push({ label: 'Surge', incident: { type: 'surge', value: 2 }, keywords: ['surge', 'spike', 'double', 'rush'] });
    return out;
  }

  inspect(target: string): Inspection | null {
    const { sim, world } = this;
    const robot = sim.robots.find((r) => r.id === target);
    if (robot) {
      const zone = [...sim.shelfOwner.values()].filter((o) => o === robot.id).length;
      const failed = robot.mode === 'failed';
      return {
        title: robot.name,
        rows: [
          ['State', robot.removed ? 'removed' : robot.mode.replace('_', ' ')],
          ['Battery', `${Math.round((robot.battery / world.params.batteryCapacity) * 100)}%`],
          ['Shelves owned', zone],
          ['Carrying', robot.carrying ? `Order ${robot.order?.id}` : 'Nothing'],
        ],
        actions: robot.removed
          ? []
          : [
              failed
                ? { label: 'Repair robot', incident: { type: 'repair_robot', target }, destructive: false }
                : { label: 'Fail this robot', incident: { type: 'fail_robot', target }, destructive: true },
            ],
      };
    }
    const belt = sim.belts.find((b) => b.id === target);
    if (belt) {
      return {
        title: `Conveyor ${belt.id}`,
        rows: [
          ['State', belt.blocked ? 'Blocked' : 'Running'],
          ['Packages on belt', belt.slots.filter(Boolean).length],
        ],
        actions: [
          belt.blocked
            ? { label: 'Clear blockage', incident: { type: 'unblock_conveyor', target }, destructive: false }
            : { label: 'Block this belt', incident: { type: 'block_conveyor', target }, destructive: true },
        ],
      };
    }
    const charger = sim.chargers.find((c) => c.id === target);
    if (charger) {
      return {
        title: `Charger ${charger.id}`,
        rows: [
          ['State', charger.offline ? 'Offline' : charger.claimedBy ? 'In use' : 'Free'],
          ['Reserved by', charger.claimedBy ?? 'Nobody'],
        ],
        actions: [
          charger.offline
            ? { label: 'Bring online', incident: { type: 'online_charger', target }, destructive: false }
            : { label: 'Take offline', incident: { type: 'offline_charger', target }, destructive: true },
        ],
      };
    }
    if (target === world.sorter.id) {
      return {
        title: 'Sorting station',
        rows: [
          ['Queue', sim.sorterQueue.length],
          ['On chutes', sim.chutes.length],
          ['Docks', world.docks.length],
        ],
        actions: [],
      };
    }
    if (world.shelves.some((s) => s.id === target)) {
      const owner = sim.robots.find((r) => r.id === sim.shelfOwner.get(target));
      return {
        title: `Shelf ${target}`,
        rows: [
          ['Zone', world.shelves.find((s) => s.id === target)?.zone ?? 'None'],
          ['Owned by', owner?.name ?? 'Nobody'],
          ['Orders waiting', sim.queue.filter((o) => o.shelf.id === target).length],
        ],
        actions: [],
      };
    }
    return null;
  }
}

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

export function countOf(text: string, noun: string): number | null {
  const match = text.match(new RegExp(`\\b(\\d+|${Object.keys(WORDS).join('|')})\\s+(?:[a-z-]+\\s+){0,2}?${noun}`));
  if (!match) return null;
  return /\d/.test(match[1]) ? Number(match[1]) : WORDS[match[1]];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function specFromPrompt(prompt: string): WorldSpec {
  const text = prompt.toLowerCase();
  const spec: WorldSpec = { ...DEFAULT_SPEC };
  spec.robots = clamp(countOf(text, 'robots?') ?? spec.robots, 1, 12);
  spec.aisles = clamp(countOf(text, 'aisles?') ?? spec.aisles, 1, 6);
  spec.conveyors = clamp(countOf(text, '(?:conveyors?|belts?)') ?? spec.conveyors, 1, 2);
  spec.chargers = clamp(countOf(text, '(?:chargers?|charging stations?)') ?? spec.chargers, 1, 4);
  spec.docks = clamp(countOf(text, 'docks?') ?? spec.docks, 1, 4);
  if (/busy|heavy|peak|rush/.test(text)) spec.demand = 'heavy';
  if (/quiet|light|slow/.test(text)) spec.demand = 'light';
  if (/pool|any robot|shared/.test(text)) spec.dispatch = 'pooled';
  const shape = text.match(/\b([lut])[- ]shaped?\b/)?.[1];
  if (shape) spec.shape = shape.toUpperCase() as WorldSpec['shape'];
  const zones = ZONE_WORDS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
  if (zones.length) {
    spec.aisles = clamp(Math.max(spec.aisles, zones.length), 1, 6);
    spec.zones = zones.slice(0, spec.aisles).map((name) => ({ name, aisles: 1 }));
  }
  return spec;
}

const ZONE_WORDS: Array<[RegExp, string]> = [
  [/cold|frozen|freezer|chilled|refrigerat/, 'Cold storage'],
  [/hazmat|hazardous|chemical/, 'Hazmat'],
  [/fragile/, 'Fragile'],
  [/bulk|oversized/, 'Bulk'],
  [/\breturns\b/, 'Returns'],
];

export const warehouse: Domain<WorldSpec, World> = {
  id: 'warehouse',
  label: 'Warehouses',
  blurb: 'Fulfilment floors with robots, shelves, conveyors and chargers',
  capabilities:
    'Grid warehouses: autonomous mobile robots, shelf aisles, up to two conveyors, a sorter, chargers, docks, order demand and dispatch policy. Floors can be rectangular, L, U or T shaped, with named storage zones that take a set share of orders.',
  limits: ['One floor, shaped as a rectangle, L, U or T', 'Robots move one cell per tick', 'No human workers, forklifts or trucks'],
  examples: ['An autonomous warehouse with three robots, storage shelves, a conveyor belt, a sorting station and a charger'],
  suggestions: ['What happens if the conveyor belt gets blocked?', 'Add another robot', 'Can you reorganize this to reduce congestion?'],
  keywords: /warehouse|fulfil|logistic|depot|conveyor|shel(f|ves)|distribution (center|centre|hub)/i,
  ticksPerSecond: 10,
  horizon: 1500,
  seeds: 3,
  responseDelay: 40,
  specSchema: WorldSpecSchema,
  specDoc: `{
  "robots": integer 1-12,
  "aisles": integer 1-6,
  "shelvesPerAisle": integer 3-12,
  "conveyors": integer 1-2,
  "chargers": integer 1-4,
  "docks": integer 1-4,
  "demand": "light" | "steady" | "heavy",
  "dispatch": "zoned" | "pooled",
  "shape"?: "rect" | "L" | "U" | "T",
  "zones"?: [{"name": string, "aisles": integer, "share"?: fraction of orders 0-1}]
}
Use shape only when the user describes the floor outline; U and T need 3+ aisles. Zones claim aisles in order from the west, and their aisles must total "aisles" or less.`,
  incidentTypes: ['fail_robot', 'block_conveyor', 'offline_charger', 'surge'],
  incidentDoc: `{"type":"fail_robot","target":"R1"}
{"type":"block_conveyor","target":"C1"}
{"type":"offline_charger","target":"E1"}
{"type":"surge","value":number 1.1-5}`,
  patchSchema: PatchSchema,
  patchDoc: `{"op":"set_policy","dispatch":"zoned"|"pooled"} (optional: "chargeThreshold" 0.05-0.8, "conveyorBypass" boolean)
{"op":"add_robot"}
{"op":"remove_robot","robotId":"R1"}
{"op":"reassign_zone","fromRobotId":"R1"}
{"op":"set_demand","orderEvery":number}`,
  council: [
    { name: 'DispatchLead', brief: 'how orders are assigned to robots' },
    { name: 'ReliabilityLead', brief: 'keeping work flowing around the broken component' },
    { name: 'CapacityLead', brief: 'adding capacity or adjusting demand' },
  ],
  compile: compileWorld,
  validate: validateWorld,
  describe: (world) =>
    JSON.stringify({
      robots: world.robots.map((r) => ({ id: r.id, name: r.name })),
      shelves: world.shelves.length,
      conveyors: world.conveyors.map((c) => c.id),
      chargers: world.chargers.map((c) => c.id),
      docks: world.docks.length,
      policy: world.policy,
      shape: world.spec.shape ?? 'rect',
      zones: world.zones.map((z) => ({ name: z.name, shelves: world.shelves.filter((s) => s.zone === z.name).length, share: z.share })),
    }),
  createRun: (world, seed) => new WarehouseRun(world, seed),
  compare(base, after, incident) {
    if (incident.type !== 'surge') return defaultCompare(base, after);
    const backlog = (e: Evaluation) => Number(e.metrics.find((m) => m.label === 'backlog')?.value ?? 0);
    return { hurt: backlog(after) > backlog(base) * 2, evidence: `Backlog ${backlog(base)} → ${backlog(after)}` };
  },
  variants: (world, spec) => [
    { title: 'Pooled dispatch', patches: [{ op: 'set_policy', dispatch: 'pooled' }] },
    { title: 'Add one robot', patches: [{ op: 'add_robot' }] },
    { title: 'Second conveyor', spec: { ...spec, conveyors: 2 } },
    { title: 'Extra charger', spec: { ...spec, chargers: Math.min(4, world.chargers.length + 1) } },
    ...(world.walls.length ? [{ title: 'Rectangular floor', spec: { ...spec, shape: 'rect' as const } }] : []),
  ],
  rules: {
    spec: specFromPrompt,
    hypotheses(world) {
      const out = [];
      if (world.conveyors.length === 1) {
        out.push({ claim: 'The single conveyor is a choke point: if it blocks, deliveries stop.', incident: { type: 'block_conveyor', target: world.conveyors[0].id } });
      }
      if (world.policy.dispatch === 'zoned' && world.robots.length > 1) {
        const robot = world.robots[Math.floor(world.robots.length / 2)];
        out.push({ claim: `${robot.name} owns its shelves alone: if it fails, that zone starves.`, incident: { type: 'fail_robot', target: robot.id } });
      }
      if (world.chargers.length === 1) {
        out.push({ claim: 'With one charger, losing it strands robots as batteries run down.', incident: { type: 'offline_charger', target: world.chargers[0].id } });
      }
      out.push({ claim: 'Double the normal demand outruns the fleet.', incident: { type: 'surge', value: 2 } });
      return out.slice(0, 3);
    },
    recoveries(_, incident) {
      const spare = { author: 'Capacity rules', title: 'Bring a spare robot online', rationale: 'Restore fleet capacity and rebalance zones.', patches: [{ op: 'add_robot' }] };
      const pooled = {
        author: 'Dispatch rules',
        title: 'Switch to pooled dispatch',
        rationale: 'Let any free robot take any order.',
        patches: [{ op: 'set_policy', dispatch: 'pooled' }],
      };
      if (incident?.type === 'fail_robot') {
        return [
          {
            author: 'Dispatch rules',
            title: 'Split the zone across survivors',
            rationale: "Hand the failed robot's shelves to the remaining fleet.",
            patches: [{ op: 'reassign_zone', fromRobotId: incident.target }],
          },
          pooled,
          spare,
        ];
      }
      if (incident?.type === 'block_conveyor') {
        return [
          {
            author: 'Reliability rules',
            title: 'Hand packages straight to the sorter',
            rationale: 'Robots bypass the belt.',
            patches: [{ op: 'set_policy', conveyorBypass: true }],
          },
          {
            author: 'Reliability rules',
            title: 'Bypass with pooled dispatch',
            rationale: 'Combine the hand-off with pooled dispatch.',
            patches: [{ op: 'set_policy', conveyorBypass: true, dispatch: 'pooled' }],
          },
          spare,
        ];
      }
      if (incident?.type === 'offline_charger') {
        return [
          { author: 'Reliability rules', title: 'Lower the charge threshold', rationale: 'Keep robots working longer.', patches: [{ op: 'set_policy', chargeThreshold: 0.1 }] },
          pooled,
          spare,
        ];
      }
      return [pooled, spare];
    },
    patch(text) {
      if (/\b(add|another|more|extra|spare)\b.*\brobot/.test(text)) return { patches: [{ op: 'add_robot' }], reply: 'Adding a robot and rebalancing zones.' };
      if (/pooled|any robot/.test(text)) return { patches: [{ op: 'set_policy', dispatch: 'pooled' }], reply: 'Switched to pooled dispatch.' };
      if (/zoned|zones/.test(text)) return { patches: [{ op: 'set_policy', dispatch: 'zoned' }], reply: 'Switched to zoned dispatch.' };
      return null;
    },
  },
};
