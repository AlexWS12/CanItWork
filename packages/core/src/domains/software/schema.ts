import { z } from 'zod';

const KINDS = ['client', 'gateway', 'service', 'database', 'cache', 'queue', 'external'] as const;
export type NodeKind = (typeof KINDS)[number];

export const SystemNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(KINDS),
  replicas: z.number().int().min(1).max(50).optional(),
  capacity: z.number().positive().optional(),
  latency: z.number().positive().optional(),
});
export type SystemNode = z.infer<typeof SystemNodeSchema>;

export const SystemEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.enum(['sync', 'async']).optional(),
  calls: z.number().positive().max(10).optional(),
  optional: z.boolean().optional(),
});
export type SystemEdge = z.infer<typeof SystemEdgeSchema>;

export const SystemSpecSchema = z.object({
  traffic: z.number().positive().max(100000),
  retries: z.number().int().min(0).max(5).default(1),
  nodes: z.array(SystemNodeSchema).min(2).max(24),
  edges: z.array(SystemEdgeSchema).min(1).max(60),
});
export type SystemSpec = z.infer<typeof SystemSpecSchema>;

export const SystemPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('scale'), node: z.string(), replicas: z.number().int().min(1).max(50) }),
  z.object({ op: z.literal('failover'), node: z.string() }),
  z.object({ op: z.literal('set_retries'), retries: z.number().int().min(0).max(5) }),
  z.object({ op: z.literal('make_optional'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('add_cache'), before: z.string() }),
  z.object({ op: z.literal('add_queue'), from: z.string(), to: z.string() }),
]);
export type SystemPatch = z.infer<typeof SystemPatchSchema>;

export const DEFAULT_CAPACITY: Record<NodeKind, number> = {
  client: Infinity,
  gateway: 2000,
  service: 200,
  database: 500,
  cache: 5000,
  queue: 5000,
  external: 300,
};

export const DEFAULT_LATENCY: Record<NodeKind, number> = {
  client: 0,
  gateway: 2,
  service: 20,
  database: 8,
  cache: 1,
  queue: 2,
  external: 120,
};
