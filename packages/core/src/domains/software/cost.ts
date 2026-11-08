import { SECONDS_PER_MONTH, usd } from '../../cost';
import type { MonthlyCost } from '../../domain';
import { DEFAULT_CAPACITY, type NodeKind, type SystemNode, type SystemSpec } from './schema';

// A month of one replica at its default capacity: a 2 vCPU instance for a service, a managed load balancer for a gateway, a
// mid-size managed database, a managed cache node. A replica sized for more traffic costs proportionally more, within reason.
const REPLICA_USD: Record<NodeKind, number> = { client: 0, gateway: 25, service: 30, database: 140, cache: 50, queue: 5, external: 0 };
// Usage-priced kinds: a managed queue per million messages, a third-party API per million calls.
const PER_MILLION_USD: Partial<Record<NodeKind, number>> = { queue: 0.4, external: 1 };

const size = (node: SystemNode) => Math.min(8, Math.max(0.5, (node.capacity ?? DEFAULT_CAPACITY[node.kind]) / DEFAULT_CAPACITY[node.kind] || 1));

/** The month's cost of a design with `inflow` requests per second reaching each component. */
export function softwareCost(spec: SystemSpec, inflow: (id: string) => number): MonthlyCost {
  const lines: MonthlyCost['lines'] = [];
  let ceiling = 0;
  for (const node of spec.nodes) {
    if (node.kind === 'client') continue;
    const each = REPLICA_USD[node.kind] * (Number.isFinite(DEFAULT_CAPACITY[node.kind]) ? size(node) : 1);
    const replicas = node.replicas ?? 1;
    const usage = ((PER_MILLION_USD[node.kind] ?? 0) * inflow(node.id) * SECONDS_PER_MONTH) / 1e6;
    const total = each * replicas + usage;
    ceiling += each * Math.max(replicas, node.autoscale?.max ?? replicas) + usage;
    if (total > 0) lines.push({ label: node.label ?? node.id, usd: usd(total) });
  }
  lines.sort((a, b) => b.usd - a.usd);
  const total = usd(lines.reduce((sum, l) => sum + l.usd, 0));
  return { usd: total, lines, ...(spec.nodes.some((n) => n.autoscale) ? { ceiling: usd(ceiling) } : {}) };
}
