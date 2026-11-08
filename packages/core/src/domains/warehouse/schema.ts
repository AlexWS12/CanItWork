import { z } from 'zod';

export const WorldSpecSchema = z.object({
  robots: z.number().int().min(1).max(12),
  aisles: z.number().int().min(1).max(6),
  shelvesPerAisle: z.number().int().min(3).max(12),
  conveyors: z.number().int().min(1).max(2),
  chargers: z.number().int().min(1).max(4),
  docks: z.number().int().min(1).max(4),
  demand: z.enum(['light', 'steady', 'heavy']),
  dispatch: z.enum(['zoned', 'pooled']),
  shape: z.enum(['rect', 'L', 'U', 'T']).optional(),
  zones: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        aisles: z.number().int().min(1).max(6),
        share: z.number().min(0).max(1).optional(),
      }),
    )
    .max(6)
    .optional(),
});
export type WorldSpec = z.infer<typeof WorldSpecSchema>;
export type FloorShape = NonNullable<WorldSpec['shape']>;

export interface Cell {
  x: number;
  y: number;
}

export interface Shelf extends Cell {
  id: string;
  access: Cell;
  owner: string;
  zone?: string;
}

export interface ZoneArea {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  share?: number;
}

export interface RobotDef {
  id: string;
  name: string;
  home: Cell;
}

export interface Conveyor {
  id: string;
  path: Cell[];
  stations: Array<Cell & { index: number }>;
}

export interface Charger extends Cell {
  id: string;
  bay: Cell;
}

export interface Sorter extends Cell {
  id: string;
  w: number;
  h: number;
  bypass: Cell;
}

export interface Dock extends Cell {
  id: string;
}

export interface Policy {
  dispatch: 'zoned' | 'pooled';
  chargeThreshold: number;
  conveyorBypass: boolean;
}

export interface WorldParams {
  orderEvery: number;
  pickTicks: number;
  dropTicks: number;
  beltTicks: number;
  sortTicks: number;
  chuteTicks: number;
  batteryCapacity: number;
  chargePerTick: number;
}

export interface World {
  schema: 1;
  spec: WorldSpec;
  cols: number;
  rows: number;
  walls: Cell[];
  zones: ZoneArea[];
  robots: RobotDef[];
  shelves: Shelf[];
  conveyors: Conveyor[];
  chargers: Charger[];
  sorter: Sorter;
  docks: Dock[];
  params: WorldParams;
  policy: Policy;
}

const CellSchema = z.object({ x: z.number().int(), y: z.number().int() });

// The move ops are hand edits from the floor view. They stay out of patchDoc, so the agents keep to the fixes above.
export const PatchSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set_policy'),
    dispatch: z.enum(['zoned', 'pooled']).optional(),
    chargeThreshold: z.number().min(0.05).max(0.8).optional(),
    conveyorBypass: z.boolean().optional(),
  }),
  z.object({ op: z.literal('add_robot') }),
  z.object({ op: z.literal('remove_robot'), robotId: z.string() }),
  z.object({ op: z.literal('reassign_zone'), fromRobotId: z.string() }),
  z.object({ op: z.literal('set_demand'), orderEvery: z.number().min(1).max(200) }),
  z.object({ op: z.literal('move_robot'), robotId: z.string(), to: CellSchema }),
  z.object({ op: z.literal('move_shelf'), shelfId: z.string(), to: CellSchema }),
]);
export type Patch = z.infer<typeof PatchSchema>;

export const SimEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fail_robot'), at: z.number().int(), robotId: z.string() }),
  z.object({ type: z.literal('repair_robot'), at: z.number().int(), robotId: z.string() }),
  z.object({ type: z.literal('block_conveyor'), at: z.number().int(), conveyorId: z.string() }),
  z.object({ type: z.literal('unblock_conveyor'), at: z.number().int(), conveyorId: z.string() }),
  z.object({ type: z.literal('offline_charger'), at: z.number().int(), chargerId: z.string() }),
  z.object({ type: z.literal('online_charger'), at: z.number().int(), chargerId: z.string() }),
  z.object({ type: z.literal('surge'), at: z.number().int(), factor: z.number().min(0.25).max(5) }),
  z.object({ type: z.literal('apply_patch'), at: z.number().int(), patches: z.array(PatchSchema) }),
]);
export type SimEvent = z.infer<typeof SimEventSchema>;

export interface SimScenario {
  seed: number;
  ticks: number;
  events: SimEvent[];
}

export interface SeriesPoint {
  t: number;
  delivered: number;
  backlog: number;
  throughput: number;
}

export interface Metrics {
  ticks: number;
  created: number;
  delivered: number;
  backlog: number;
  stranded: number;
  avgLatency: number;
  throughput: number;
  utilization: number;
  waitTicks: number;
  chargeWaitTicks: number;
}

export interface RunResult {
  metrics: Metrics;
  series: SeriesPoint[];
}
