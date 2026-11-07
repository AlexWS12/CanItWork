import { z } from 'zod';

// Autonomous fleets: drones, rovers or robots with roles, sharing an area, a base with chargers, and a radio network.

export const BEHAVIORS = ['search', 'deliver', 'relay', 'patrol', 'escort', 'idle'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

const ID = /^[A-Za-z_][\w-]*$/;

export const RoleSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().max(40).optional(),
  behavior: z.enum(BEHAVIORS),
  count: z.number().int().min(1).max(40),
  // Metres per second while moving.
  speed: z.number().positive().max(60).default(10),
  // Minutes of travel on a full charge.
  endurance: z.number().positive().max(240).default(20),
  // Radio range in metres: two units, or a unit and the base, can talk within the smaller of their ranges.
  range: z.number().positive().max(20000).default(300),
  // How far the unit can see, in metres: what a scout explores and finds as it passes.
  sensor: z.number().positive().max(1000).default(25),
  // Ground units can't cross obstacles; air units fly over them, though obstacles still block radio.
  ground: z.boolean().default(false),
  // Points a patroller visits in a loop, in metres from the area's corner.
  waypoints: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .max(20)
    .optional(),
});
export type Role = z.infer<typeof RoleSchema>;

export const FleetSpecSchema = z.object({
  area: z.object({
    width: z.number().min(20).max(20000),
    depth: z.number().min(20).max(20000),
    // Buildings, trees or terrain: they block radio line of sight, and ground units must go around them.
    obstacles: z
      .array(z.object({ x: z.number(), y: z.number(), width: z.number().positive(), depth: z.number().positive(), height: z.number().positive().default(15) }))
      .max(24)
      .default([]),
  }),
  base: z.object({ x: z.number(), y: z.number(), chargers: z.number().int().min(1).max(40).default(2), range: z.number().positive().max(20000).optional() }),
  roles: z.array(RoleSchema).min(1).max(8),
  // Things to find, hidden in the area: survivors, fires, leaks, parcels to collect.
  targets: z.number().int().min(0).max(60).default(0),
  // True when the targets' places are known from the start (addresses to deliver to, sites to inspect), so nothing has to find them first.
  known: z.boolean().default(false),
  // What a deliverer brings each found target; 0 if nothing is delivered.
  deliveriesPerTarget: z.number().int().min(0).max(5).default(1),
  // Wind in metres per second: it drains batteries faster.
  wind: z.number().min(0).max(30).default(0),
  // Battery share a unit keeps in hand for the trip home before turning back.
  reserve: z.number().min(5).max(60).default(20),
});
export type FleetSpec = z.infer<typeof FleetSpecSchema>;

export const FleetPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_units'), role: z.string(), count: z.number().int().min(1).max(20) }),
  z.object({
    op: z.literal('set_role'),
    role: z.string(),
    speed: z.number().positive().max(60).optional(),
    endurance: z.number().positive().max(240).optional(),
    range: z.number().positive().max(20000).optional(),
    sensor: z.number().positive().max(1000).optional(),
  }),
  z.object({ op: z.literal('add_chargers'), count: z.number().int().min(1).max(20) }),
  z.object({ op: z.literal('set_reserve'), percent: z.number().min(5).max(60) }),
  z.object({ op: z.literal('add_role'), role: RoleSchema }),
  z.object({ op: z.literal('restore'), unit: z.string() }),
  z.object({ op: z.literal('clear_jam') }),
]);
export type FleetPatch = z.infer<typeof FleetPatchSchema>;
