import { z } from 'zod';

/**
 * Shared model for domains that are networks of flows: sources make or receive work,
 * stages process it at a capacity, sinks consume it. Each domain picks its own kinds.
 */
export type Role = 'source' | 'stage' | 'sink';

export interface KindDef {
  role: Role;
  /** One line for the Architect, e.g. "gas plant, 300 MW per unit". */
  doc: string;
  /** Work one unit handles per tick. Sources: most it can produce. */
  capacity?: number;
  /** Sources in flow mode: work arriving per tick. Sinks in demand mode: demand per tick. */
  rate?: number;
  /** Work that can wait here. */
  buffer?: number;
}

export interface NetNode {
  id: string;
  label?: string;
  kind: string;
  count?: number;
  capacity?: number;
  rate?: number;
  buffer?: number;
}

export interface NetEdge {
  from: string;
  to: string;
  weight?: number;
  capacity?: number;
  delay?: number;
}

export interface NetSpec {
  nodes: NetNode[];
  edges: NetEdge[];
}

export function netSpecSchema(kinds: [string, ...string[]]) {
  const node = z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    kind: z.enum(kinds),
    count: z.number().int().min(1).max(100).optional(),
    capacity: z.number().min(0).max(1e6).optional(),
    rate: z.number().min(0).max(1e6).optional(),
    buffer: z.number().min(0).max(1e7).optional(),
  });
  const edge = z.object({
    from: z.string(),
    to: z.string(),
    weight: z.number().positive().max(100).optional(),
    capacity: z.number().positive().max(1e6).optional(),
    delay: z.number().int().min(0).max(60).optional(),
  });
  return z.object({ nodes: z.array(node).min(2).max(30), edges: z.array(edge).min(1).max(80) });
}

export const NetPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('scale'), node: z.string(), count: z.number().int().min(1).max(100) }),
  z.object({ op: z.literal('restore'), node: z.string() }),
  z.object({
    op: z.literal('add_link'),
    from: z.string(),
    to: z.string(),
    weight: z.number().positive().max(100).optional(),
    capacity: z.number().positive().optional(),
    delay: z.number().int().min(0).max(60).optional(),
  }),
  z.object({ op: z.literal('restore_link'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('set_buffer'), node: z.string(), buffer: z.number().min(0) }),
  z.object({ op: z.literal('shed'), fraction: z.number().min(0).max(0.9) }),
]);
export type NetPatch = z.infer<typeof NetPatchSchema>;

export const linkKey = (e: Pick<NetEdge, 'from' | 'to'>) => `${e.from}->${e.to}`;

export function netOrder(spec: NetSpec): string[] {
  const indegree = new Map(spec.nodes.map((n) => [n.id, 0]));
  for (const e of spec.edges) if (indegree.has(e.to)) indegree.set(e.to, indegree.get(e.to)! + 1);
  const ready = spec.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    order.push(id);
    for (const e of spec.edges) {
      if (e.from !== id || !indegree.has(e.to)) continue;
      indegree.set(e.to, indegree.get(e.to)! - 1);
      if (indegree.get(e.to) === 0) ready.push(e.to);
    }
  }
  return order;
}
