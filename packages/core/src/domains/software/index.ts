import type { Domain, Hypothesis, Incident, Issue, RecoveryOption } from '../../domain';
import { SystemPatchSchema, SystemSpecSchema, type SystemSpec } from './schema';
import { SystemRun, topoOrder } from './system';

function validateSystem(spec: SystemSpec): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set(spec.nodes.map((n) => n.id));
  if (ids.size !== spec.nodes.length) issues.push({ severity: 'error', message: 'Two components share an id' });
  for (const e of spec.edges) {
    for (const end of [e.from, e.to]) if (!ids.has(end)) issues.push({ severity: 'error', message: `A connection uses ${end}, which doesn't exist` });
  }
  if (!spec.nodes.some((n) => n.kind === 'client')) issues.push({ severity: 'error', message: 'Nothing sends traffic: add a client' });
  if (issues.length) return issues;
  if (topoOrder(spec).length !== spec.nodes.length) {
    issues.push({ severity: 'error', message: "The call graph has a cycle, which this model can't simulate" });
    return issues;
  }

  const reached = new Set(spec.nodes.filter((n) => n.kind === 'client').map((n) => n.id));
  for (const id of topoOrder(spec)) if (reached.has(id)) for (const e of spec.edges) if (e.from === id) reached.add(e.to);
  for (const node of spec.nodes) {
    if (!reached.has(node.id)) issues.push({ severity: 'warning', message: `${node.label ?? node.id} never receives traffic`, target: node.id });
  }
  for (const node of spec.nodes) {
    if ((node.kind === 'database' || node.kind === 'service') && (node.replicas ?? 1) === 1 && reached.has(node.id)) {
      issues.push({ severity: 'warning', message: `${node.label ?? node.id} is a single point of failure`, target: node.id });
    }
  }
  for (const node of spec.nodes) {
    if (node.kind === 'queue' && !spec.edges.some((e) => e.from === node.id)) {
      issues.push({ severity: 'warning', message: `${node.label ?? node.id} has no consumer, so its backlog grows forever`, target: node.id, repair: true });
    }
  }
  const run = new SystemRun(spec, 1);
  for (let i = 0; i < 30; i++) run.step();
  for (const [id, state] of run.states) {
    const node = spec.nodes.find((n) => n.id === id);
    if (node?.kind !== 'client' && state.utilization > 1) {
      issues.push({ severity: 'warning', message: `${node?.label ?? id} is over capacity at ${Math.round(state.utilization * 100)}% load`, target: id, repair: true });
    }
  }
  return issues;
}

function buildSystem(prompt: string): SystemSpec {
  const text = prompt.toLowerCase();
  const payments = /payment|checkout|billing|bank/.test(text);
  const main = payments ? 'payments' : 'api';
  const spec: SystemSpec = {
    traffic: 300,
    retries: 2,
    nodes: [
      { id: 'users', label: 'Users', kind: 'client' },
      { id: 'gateway', label: 'API gateway', kind: 'gateway', replicas: 2 },
      { id: main, label: payments ? 'Payment service' : 'API service', kind: 'service', replicas: 3 },
      { id: 'auth', label: 'Auth service', kind: 'service', replicas: 2 },
      { id: 'redis', label: 'Cache', kind: 'cache' },
      { id: 'postgres', label: 'Primary database', kind: 'database' },
      { id: 'events', label: 'Event queue', kind: 'queue' },
      { id: 'worker', label: 'Worker', kind: 'service', replicas: 2 },
    ],
    edges: [
      { from: 'users', to: 'gateway' },
      { from: 'gateway', to: main },
      { from: main, to: 'auth' },
      { from: main, to: 'redis' },
      { from: 'redis', to: 'postgres' },
      { from: main, to: 'events', mode: 'async' },
      { from: 'events', to: 'worker', mode: 'async' },
      { from: 'worker', to: 'postgres' },
    ],
  };
  if (payments) {
    spec.nodes.push({ id: 'processor', label: 'Card processor', kind: 'external' });
    spec.edges.push({ from: main, to: 'processor' });
  }
  return spec;
}

function hypotheses(spec: SystemSpec): Hypothesis[] {
  const out: Hypothesis[] = [];
  const database = spec.nodes.find((n) => n.kind === 'database' && (n.replicas ?? 1) === 1);
  if (database) out.push({ claim: `${database.label ?? database.id} has no replica: losing it takes the system down.`, incident: { type: 'node_down', target: database.id } });
  const external = spec.nodes.find((n) => n.kind === 'external');
  if (external) out.push({ claim: `A slow ${external.label ?? external.id} backs up every caller waiting on it.`, incident: { type: 'node_slow', target: external.id, value: 8 } });
  out.push({ claim: 'Three times the normal traffic overloads the busiest service.', incident: { type: 'traffic_spike', value: 3 } });
  return out.slice(0, 3);
}

function recoveries(spec: SystemSpec, incident: Incident | undefined): RecoveryOption[] {
  const target = incident?.target ?? '';
  const node = spec.nodes.find((n) => n.id === target);
  const callers = spec.edges.filter((e) => e.to === target);
  const stopRetries = {
    author: 'Resilience rules',
    title: 'Stop retrying',
    rationale: 'Retries multiply load on a struggling dependency.',
    patches: [{ op: 'set_retries', retries: 0 }],
  };
  if (incident?.type === 'traffic_spike') {
    const busiest = spec.nodes.filter((n) => n.kind === 'service').map((n) => ({ op: 'scale', node: n.id, replicas: (n.replicas ?? 1) * 3 }));
    return [{ author: 'Capacity rules', title: 'Scale every service', rationale: 'Add replicas to absorb the spike.', patches: busiest }, stopRetries];
  }
  if (!node) return [stopRetries];
  const options: RecoveryOption[] = [
    { author: 'Resilience rules', title: `Fail over ${node.label ?? node.id}`, rationale: 'Promote a standby at reduced capacity.', patches: [{ op: 'failover', node: target }] },
    stopRetries,
  ];
  if (callers.length) {
    options.push({
      author: 'Architecture rules',
      title: `Degrade gracefully without ${node.label ?? node.id}`,
      rationale: 'Treat the dependency as optional so callers keep working.',
      patches: callers.map((e) => ({ op: 'make_optional', from: e.from, to: e.to })),
    });
  }
  return options;
}

export const software: Domain<SystemSpec, SystemSpec> = {
  id: 'software',
  label: 'Software systems',
  blurb: 'Services, databases, caches and queues under live traffic',
  capabilities:
    'Distributed software: clients, gateways, services, databases, caches, queues and external APIs. Simulates traffic, capacity, latency, retries, timeouts, retry storms and how failures cascade.',
  limits: [
    'Models request volume, not individual requests or business logic',
    'The call graph must have no cycles',
    'No data consistency or partition modelling',
    'Latency comes from a simple queueing estimate',
  ],
  examples: ['A distributed payment system with an API gateway, payment service, card processor, database and event queue'],
  suggestions: ['What happens if the database goes down?', 'What happens if traffic triples?', 'Where is the single point of failure?'],
  keywords: /microservice|distributed|payment system|architecture|load balancer|kubernetes|backend|api gateway|message queue|\bkafka\b|services? (and|with|that)|web app/i,
  ticksPerSecond: 8,
  horizon: 300,
  seeds: 1,
  responseDelay: 15,
  specSchema: SystemSpecSchema,
  specDoc: `{
  "traffic": requests per second from clients,
  "retries": integer 0-5,
  "nodes": [{"id": string, "label": string, "kind": "client"|"gateway"|"service"|"database"|"cache"|"queue"|"external", "replicas"?: integer, "capacity"?: requests per second per replica, "latency"?: milliseconds}],
  "edges": [{"from": node id, "to": node id, "mode"?: "sync"|"async", "calls"?: calls per request, "optional"?: boolean}]
}
Include at least one client. The graph must have no cycles. Use async edges into and out of queues, and give every queue a consumer. Size replicas and capacity so normal traffic stays under 70% of capacity on every component, unless the user asks for an overloaded system.`,
  incidentTypes: ['node_down', 'node_slow', 'traffic_spike', 'cut_link', 'cache_flush'],
  incidentDoc: `{"type":"node_down","target":"node id"}
{"type":"node_slow","target":"node id","value":slowdown factor}
{"type":"traffic_spike","value":multiplier}
{"type":"cut_link","target":"from->to"}
{"type":"cache_flush","target":"cache node id"}`,
  patchSchema: SystemPatchSchema,
  patchDoc: `{"op":"scale","node":"id","replicas":integer}
{"op":"failover","node":"id"}
{"op":"set_retries","retries":integer}
{"op":"make_optional","from":"id","to":"id"}
{"op":"add_cache","before":"id"}
{"op":"add_queue","from":"id","to":"id"}`,
  council: [
    { name: 'SiteReliabilityLead', brief: 'failover and restoring the broken dependency' },
    { name: 'ResilienceEngineer', brief: 'retries, degradation and isolating the failure' },
    { name: 'CapacityPlanner', brief: 'scaling, caching and absorbing load' },
  ],
  compile: (spec) => spec,
  validate: validateSystem,
  describe: (spec) => JSON.stringify(spec),
  createRun: (spec, seed) => new SystemRun(spec, seed),
  variants: (spec) => {
    const out = spec.nodes
      .filter((n) => (n.kind === 'database' || n.kind === 'service') && (n.replicas ?? 1) < 3)
      .slice(0, 3)
      .map((n) => ({ title: `Scale ${n.label ?? n.id}`, patches: [{ op: 'scale', node: n.id, replicas: 3 }] }));
    return [...out, { title: 'Reduce retries', patches: [{ op: 'set_retries', retries: 1 }] }];
  },
  rules: {
    spec: buildSystem,
    hypotheses,
    recoveries,
  },
};
