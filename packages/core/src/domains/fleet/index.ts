import type { Domain, Hypothesis, Incident, Issue, RecoveryOption } from '../../domain';
import { FleetPatchSchema, FleetSpecSchema, RoleSchema, type FleetSpec } from './schema';
import { FleetRun, SECONDS_PER_TICK } from './sim';

export { FleetRun } from './sim';
export type { FleetSpec, Role } from './schema';

const HORIZON = 450;
const minutes = (ticks: number) => Math.round((ticks * SECONDS_PER_TICK) / 60);

const farthestCorner = (spec: FleetSpec) => {
  const { width, depth } = spec.area;
  const { x, y } = spec.base;
  return Math.max(
    ...[
      [0, 0],
      [width, 0],
      [0, depth],
      [width, depth],
    ].map(([cx, cy]) => Math.hypot(cx - x, cy - y)),
  );
};

function validateFleet(spec: FleetSpec): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  for (const role of spec.roles) {
    if (ids.has(role.id)) issues.push({ severity: 'error', repair: true, message: `Two roles are called ${role.id}` });
    ids.add(role.id);
  }
  const { width, depth } = spec.area;
  if (spec.base.x < 0 || spec.base.x > width || spec.base.y < 0 || spec.base.y > depth)
    issues.push({ severity: 'error', repair: true, message: `The base at ${spec.base.x}, ${spec.base.y} is outside the ${width} x ${depth} m area` });
  if (issues.some((i) => i.severity === 'error')) return issues;

  const behaviors = new Set(spec.roles.map((r) => r.behavior));
  if (behaviors.has('deliver') && spec.deliveriesPerTarget > 0) {
    if (!spec.targets) issues.push({ severity: 'warning', repair: true, message: 'Deliverers have nothing to deliver to: give "targets" for the places that need supplies' });
    else if (!behaviors.has('search'))
      issues.push({ severity: 'warning', repair: true, message: 'Nothing finds the targets, so deliverers never learn where to go: add a role with behavior "search"' });
  }
  if (spec.targets && !behaviors.has('search') && !behaviors.has('deliver'))
    issues.push({ severity: 'warning', repair: true, message: `There are ${spec.targets} targets but no role searches for them` });

  const far = farthestCorner(spec);
  for (const role of spec.roles) {
    if (role.behavior === 'idle' || role.behavior === 'relay') continue;
    // How far out a unit can go and still get home on one charge, keeping its reserve.
    const usable = (role.endurance * 60 * (1 - spec.reserve / 100)) / (1 + spec.wind / 20);
    const reach = (usable * role.speed) / 2;
    if (reach < far * 0.95)
      issues.push({
        severity: 'warning',
        repair: true,
        message: `${role.label ?? role.id} can only fly ${Math.round(reach)} m out and back on one charge, short of the far corner ${Math.round(far)} m from base: raise its endurance or speed, or put the base nearer the middle`,
      });
  }
  const baseRange = spec.base.range ?? Math.max(...spec.roles.map((r) => r.range));
  if (!behaviors.has('relay')) {
    for (const role of spec.roles.filter((r) => r.behavior === 'search')) {
      const range = Math.min(role.range, baseRange);
      if (range < far * 0.9)
        issues.push({
          severity: 'warning',
          repair: true,
          message: `${role.label ?? role.id} lose contact past ${Math.round(range)} m but the area reaches ${Math.round(far)} m from base, so finds go unreported until they fly back: add a "relay" role or longer-range radios`,
        });
    }
  }
  const units = spec.roles.reduce((s, r) => s + r.count, 0);
  if (units / spec.base.chargers > 8) issues.push({ severity: 'warning', message: `${units} units share ${spec.base.chargers} chargers, so many will queue to recharge` });

  // Fly the mission and report what went wrong in terms the Architect can act on.
  const run = new FleetRun(spec, 1);
  for (let i = 0; i < HORIZON; i++) run.step();
  const lost = run.units.filter((u) => u.status === 'lost');
  if (lost.length) {
    const roles = [...new Set(lost.map((u) => u.role.label ?? u.role.id))];
    issues.push({
      severity: 'warning',
      repair: true,
      message: `${lost.length} unit${lost.length > 1 ? 's' : ''} (${roles.join(', ')}) ran out of battery mid-flight: raise their endurance or the battery "reserve", or cut the wind`,
    });
  }
  const unreported = run.targets.filter((t) => t.found && !t.reported).length;
  if (unreported)
    issues.push({ severity: 'warning', repair: true, message: `${unreported} targets were found but never reported, because the unit that found them was out of radio contact` });
  return issues;
}

function proofOf(spec: FleetSpec) {
  const run = new FleetRun(spec, 1);
  for (let i = 0; i < HORIZON; i++) run.step();
  const facts: string[] = [];
  if (!run.units.some((u) => u.status === 'lost')) facts.push(`all ${run.units.length} units get home before their batteries run out`);
  if (spec.roles.some((r) => r.behavior === 'search')) facts.push(`${Math.round(run.coverage() * 100)}% of the area searched`);
  if (run.targets.length) facts.push(`${run.targets.filter((t) => t.reported).length} of ${run.targets.length} targets reported`);
  const needed = run.targets.length * spec.deliveriesPerTarget;
  if (needed && spec.roles.some((r) => r.behavior === 'deliver'))
    facts.push(`${run.targets.reduce((s, t) => s + Math.min(t.served, spec.deliveriesPerTarget), 0)} of ${needed} deliveries made`);
  return facts.length ? `${facts.join(', ')} within ${minutes(HORIZON)} simulated minutes` : null;
}

function hypotheses(spec: FleetSpec): Hypothesis[] {
  const out: Hypothesis[] = [];
  const relay = spec.roles.find((r) => r.behavior === 'relay');
  if (relay)
    out.push({
      claim: `If ${relay.id}-1 goes down, units far from base lose contact and their finds stop reaching the base.`,
      incident: { type: 'lose_unit', target: `${relay.id}-1` },
    });
  out.push({ claim: 'Jamming cuts radio range to 30%, so most of the fleet works blind and reports nothing.', incident: { type: 'jam_comms', value: 0.3 } });
  out.push({ claim: 'A 14 m/s wind drains batteries faster, so units turn back early and the mission falls behind.', incident: { type: 'wind', value: 14 } });
  if (spec.base.chargers <= 2) out.push({ claim: 'With a charger down, units queue at base and fewer are flying at once.', incident: { type: 'charger_down', value: 1 } });
  return out.slice(0, 3);
}

function recoveries(spec: FleetSpec, incident: Incident | undefined): RecoveryOption[] {
  const author = 'Fleet rules';
  const busiest = spec.roles.find((r) => r.behavior === 'search') ?? spec.roles.find((r) => r.behavior === 'deliver') ?? spec.roles[0];
  const relay = spec.roles.find((r) => r.behavior === 'relay');
  const addRelay = relay
    ? { op: 'add_units', role: relay.id, count: 1 }
    : {
        op: 'add_role',
        role: RoleSchema.parse({ id: 'relay', label: 'Relay', behavior: 'relay', count: 1, speed: busiest.speed, endurance: busiest.endurance * 1.5, range: busiest.range * 1.5 }),
      };
  switch (incident?.type) {
    case 'lose_unit': {
      const target = incident.target ?? '';
      const roleId = target.replace(/-\d+$/, '');
      return [
        { author, title: `Launch a spare ${roleId}`, rationale: 'Replace the lost unit from the base.', patches: [{ op: 'add_units', role: roleId, count: 1 }] },
        { author, title: `Recover ${target}`, rationale: 'Bring the unit back into service after a recharge.', patches: [{ op: 'restore', unit: target }] },
        { author, title: 'Add a relay', rationale: 'Keep the rest of the fleet in contact.', patches: [addRelay] },
      ];
    }
    case 'jam_comms':
      return [
        { author, title: 'Add a relay', rationale: 'A relay closer to the fleet bridges the shortened links.', patches: [addRelay] },
        {
          author,
          title: 'Fit longer-range radios',
          rationale: "Double every role's radio range.",
          patches: spec.roles.map((r) => ({ op: 'set_role', role: r.id, range: r.range * 2 })),
        },
        { author, title: 'Clear the jamming', rationale: 'Find and stop the interference.', patches: [{ op: 'clear_jam' }] },
      ];
    case 'wind':
      return [
        { author, title: 'Keep more battery in reserve', rationale: 'Turn back earlier so no unit runs dry against the wind.', patches: [{ op: 'set_reserve', percent: 35 }] },
        { author, title: `Add two ${busiest.id} units`, rationale: 'More units make up for shorter trips.', patches: [{ op: 'add_units', role: busiest.id, count: 2 }] },
      ];
    case 'charger_down':
      return [
        { author, title: 'Add two chargers', rationale: 'Shorten the queue at base.', patches: [{ op: 'add_chargers', count: 2 }] },
        {
          author,
          title: 'Keep more battery in reserve',
          rationale: 'Units arrive with charge to spare and need less time on a charger.',
          patches: [{ op: 'set_reserve', percent: 30 }],
        },
      ];
    default:
      return [
        { author, title: `Add two ${busiest.id} units`, rationale: 'More units cover the mission faster.', patches: [{ op: 'add_units', role: busiest.id, count: 2 }] },
        { author, title: 'Add a relay', rationale: 'Keep the fleet in contact with the base.', patches: [addRelay] },
        { author, title: 'Add a charger', rationale: 'Get units back in the air sooner.', patches: [{ op: 'add_chargers', count: 1 }] },
      ];
  }
}

function template(prompt: string): FleetSpec {
  const count = (word: RegExp, fallback: number) => {
    const m = prompt.match(new RegExp(`(\\d+)\\s+${word.source}`, 'i'));
    return m ? Math.min(40, Number(m[1])) : fallback;
  };
  const ground = /rover|ground robot|delivery robot|vehicle/i.test(prompt);
  const kind = ground ? 'rover' : 'drone';
  return FleetSpecSchema.parse({
    area: { width: 800, depth: 800, obstacles: [{ x: 350, y: 300, width: 80, depth: 120, height: 25 }] },
    base: { x: 400, y: 40, chargers: 3 },
    roles: [
      {
        id: 'scout',
        label: `Scout ${kind}s`,
        behavior: 'search',
        count: count(/scouts?/, 4),
        speed: ground ? 2 : 12,
        endurance: ground ? 120 : 25,
        range: 400,
        sensor: 30,
        ground,
      },
      {
        id: 'carrier',
        label: `Carrier ${kind}s`,
        behavior: 'deliver',
        count: count(/carriers?/, 2),
        speed: ground ? 1.5 : 10,
        endurance: ground ? 120 : 20,
        range: 400,
        sensor: 10,
        ground,
      },
      { id: 'relay', label: 'Relay drone', behavior: 'relay', count: count(/relays?/, 1), speed: 12, endurance: 40, range: 900, sensor: 10 },
    ],
    targets: 8,
    deliveriesPerTarget: 1,
  });
}

export const fleet: Domain<FleetSpec, FleetSpec> = {
  id: 'fleet',
  label: 'Autonomous fleets',
  blurb: 'Drone swarms, rovers and robot teams with roles, batteries and radio links',
  capabilities:
    'Multi-agent fleets of drones, rovers, delivery robots or other autonomous units, each with a role: search an area and find targets, deliver supplies, relay radio, patrol waypoints or escort. Simulates movement, coverage, battery drain and return-to-charge with limited chargers, wind, obstacles that block radio and ground units, and a radio network that decides what reaches the base. Breaks with lost units, jammed radios, wind and charger failures.',
  limits: [
    'Units move in 2D; altitude is only drawn',
    'Radio is range plus line of sight, with no bandwidth or latency',
    "Units don't avoid each other",
    'Behaviours come from a fixed set of roles, not custom code',
  ],
  examples: ['A swarm of drones with scouts searching a disaster area, carriers delivering supplies to survivors, and a relay drone keeping everyone connected to base'],
  suggestions: ['What happens if the relay drone goes down?', 'What if the radios get jammed?', 'Does a strong wind strand any drones?'],
  keywords:
    /drones?|\buavs?\b|quadcopters?|swarm of|fleet of|rovers?|robot (swarm|team|fleet)s?|multi-robot|search and rescue|delivery robots?|autonomous (vehicles|boats|robots)/i,
  ticksPerSecond: 10,
  horizon: HORIZON,
  responseDelay: 30,
  seeds: 1,
  specSchema: FleetSpecSchema,
  specDoc: `{
  "area": {"width": metres, "depth": metres, "obstacles": [{"x": metres from the left, "y": metres from the near edge, "width": m, "depth": m, "height": m}]},
  "base": {"x": m, "y": m, "chargers": integer, "range"?: base radio range in m},
  "roles": [{"id": short name, "label": what they are, "behavior": "search"|"deliver"|"relay"|"patrol"|"escort"|"idle", "count": integer, "speed": m/s, "endurance": minutes of travel per charge, "range": radio range in m, "sensor": how far it sees in m, "ground"?: true for rovers and robots that drive, "waypoints"?: [{"x": m, "y": m}] for patrols}],
  "targets": things to find (survivors, fires, leaks, parcels), "deliveriesPerTarget": supplies each found target needs (0 if nothing is delivered),
  "wind": m/s, "reserve": % battery kept for the trip home
}
Behaviours: "search" sweeps unexplored ground and finds targets within its sensor range; "deliver" loads at base and flies to each target that has been found and reported; "relay" positions itself between base and the units furthest out to keep them in radio contact; "patrol" loops its waypoints (or the area's edge) and watches as it goes; "escort" follows the deliverers; "idle" stays at base as a spare.
A unit can only report what it found while the radio network links it to base, directly or through other units, so give a large area relays or long-range radios. Obstacles block radio line of sight to the ground (the base and ground units) and ground units must drive around them; air units fly over them.
Use realistic numbers: a quadcopter flies 10-15 m/s for 20-30 minutes with a 300-1000 m radio and a 20-40 m camera footprint; a fixed-wing drone 18-25 m/s for 60-90 minutes; a ground rover or delivery robot 1-3 m/s for 2-6 hours with "ground": true. Honour every count, speed and role the user names. Size the area to the mission (a disaster site might be 1000 x 1000 m), put the base where the user says or near an edge, and make sure each role can reach the far corner and come back on one charge.`,
  incidentTypes: ['lose_unit', 'jam_comms', 'wind', 'charger_down', 'new_targets'],
  incidentDoc: `{"type":"lose_unit","target":"unit id such as scout-2, or a role id to lose one of that role"}
{"type":"jam_comms","value":share of radio range left, such as 0.3}
{"type":"wind","value":metres per second}
{"type":"charger_down","value":chargers lost}
{"type":"new_targets","value":how many more targets appear}`,
  patchSchema: FleetPatchSchema,
  patchDoc: `{"op":"add_units","role":"role id","count":integer}
{"op":"set_role","role":"role id","speed"?:m/s,"endurance"?:minutes,"range"?:m,"sensor"?:m}
{"op":"add_chargers","count":integer}
{"op":"set_reserve","percent":number}
{"op":"add_role","role":Role}
{"op":"restore","unit":"unit id"}
{"op":"clear_jam"}`,
  council: [
    { name: 'MissionCommander', brief: 'reassigning units and keeping the mission on schedule' },
    { name: 'CommsOfficer', brief: 'relays, radio range and keeping units in contact' },
    { name: 'FleetEngineer', brief: 'batteries, chargers, reserves and spare units' },
  ],
  compile: (spec) => spec,
  validate: validateFleet,
  proof: proofOf,
  describe: (spec) => JSON.stringify(spec),
  createRun: (spec, seed) => new FleetRun(spec, seed),
  variants: (spec) => {
    const search = spec.roles.find((r) => r.behavior === 'search');
    const out = [];
    if (search) out.push({ title: `Two more ${search.id} units`, patches: [{ op: 'add_units', role: search.id, count: 2 }] });
    out.push({ title: 'One more charger', patches: [{ op: 'add_chargers', count: 1 }] });
    const relay = spec.roles.find((r) => r.behavior === 'relay');
    if (relay) out.push({ title: 'One more relay', patches: [{ op: 'add_units', role: relay.id, count: 1 }] });
    return out;
  },
  rules: { spec: template, hypotheses, recoveries },
};
