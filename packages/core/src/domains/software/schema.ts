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
  zones: z.array(z.string().min(1).max(40)).min(1).max(6).optional(),
  // Requests per second it admits; the rest are turned away at once (HTTP 429) instead of piling onto it and everything behind it.
  rateLimit: z.number().positive().max(1_000_000).optional(),
  // Adds replicas up to max when busy, after they boot, and removes them when quiet, never below the replicas it starts with.
  autoscale: z.object({ max: z.number().int().min(1).max(50) }).optional(),
});
export type SystemNode = z.infer<typeof SystemNodeSchema>;

/** Replica i runs in zones[i % zones.length]; a node with no zones is unaffected by zone outages. */
export function replicaZones(node: Pick<SystemNode, 'replicas' | 'zones'>): string[] {
  if (!node.zones?.length) return [];
  return Array.from({ length: node.replicas ?? 1 }, (_, i) => node.zones![i % node.zones!.length]);
}

export function zonesOf(spec: { nodes: Array<Pick<SystemNode, 'zones'>> }): string[] {
  return [...new Set(spec.nodes.flatMap((n) => n.zones ?? []))];
}

export const SystemEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.enum(['sync', 'async']).optional(),
  calls: z.number().positive().max(10).optional(),
  optional: z.boolean().optional(),
  // A circuit breaker on this call: when the callee keeps failing it stops calling, fails fast, and tries again after a pause.
  breaker: z.boolean().optional(),
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
  z.object({ op: z.literal('add_zone'), node: z.string(), zone: z.string().min(1) }),
  z.object({ op: z.literal('add_breaker'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('rate_limit'), node: z.string(), rps: z.number().positive().max(1_000_000) }),
  z.object({ op: z.literal('autoscale'), node: z.string(), max: z.number().int().min(1).max(50) }),
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
