// A schema opened from a software design's database, linked both ways: going in, its workload is sized to the traffic that
// database carries; coming back, the database node takes on the schema's real capacity and latency, so a missing index or
// a scan inside the schema slows the services that call it.
import { SchemaRun } from './engine';
import type { DatabaseSpec } from './schema';

const total = (spec: DatabaseSpec) => spec.workload.reduce((sum, q) => sum + q.perSecond * (q.repeats ?? 1), 0);

/** The schema with its workload scaled, query by query in proportion, so it adds up to `rps` executions a second. */
export function sizeWorkload(spec: DatabaseSpec, rps: number): DatabaseSpec {
  const now = total(spec);
  if (!now || rps <= 0) return spec;
  const factor = rps / now;
  return {
    ...spec,
    workload: spec.workload.map((q) => ({ ...q, perSecond: Math.min(100000, Math.max(0.1, Math.round(q.perSecond * factor * 10) / 10)) })),
  };
}

/**
 * What the schema means for the database node that stands for it in a software design: the requests a second it serves
 * per replica before it is full, and how long a query takes on average. `replicas` is the node's own replica count.
 */
export function asDatabaseNode(spec: DatabaseSpec, replicas = 1): { capacity: number; latency: number } {
  const run = new SchemaRun(spec, 1);
  run.step();
  const rps = total(spec);
  // A query's own time, read at a trickle of load: the software model adds the queueing for how busy the node is itself.
  const idleSpec = sizeWorkload(spec, Math.max(1, rps * 0.01));
  const idle = new SchemaRun(idleSpec, 1);
  idle.step();
  const idleRps = total(idleSpec);
  const latency = idleRps > 0 ? idleSpec.workload.reduce((sum, q) => sum + (idle.queries.get(q.name)?.latency ?? 0) * q.perSecond * (q.repeats ?? 1), 0) / idleRps : 1;
  // Full when the busiest node of the schema reaches 100%: the load it carries now, scaled up to that point.
  const capacity = run.utilization > 0 ? rps / run.utilization / Math.max(1, replicas) : 100000;
  return { capacity: Math.max(1, Math.round(capacity)), latency: Math.max(1, Math.round(latency * 10) / 10) };
}
