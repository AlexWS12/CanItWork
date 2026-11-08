// Opening a part of a design as a system of its own, and coming back with what was learned: a software design's database
// becomes a schema sized to the traffic it carries, and on the way back the database takes on that schema's real capacity
// and latency. Kept apart from actions.ts so the two can change independently.
import { asDatabaseNode, sizeWorkload, type DatabaseSpec, type Environment, type Explanation, type Finding, type Inspection, type StepEvent, type SystemSpec } from '@tv/core';
import { create } from 'zustand';
import { buildEnvironment } from './actions';
import { leaveLive, useLive } from './live';
import { runner } from './runner';
import { useStore } from './store';

interface Parent {
  environment: Environment;
  node: string;
  label: string;
  rps: number;
  // What the agents found and said about the design, shown again on the way back.
  steps: StepEvent[];
  findings: Finding[];
  explanation: Explanation | null;
}

export const useDrill = create<{ parent: Parent | null }>(() => ({ parent: null }));

const store = () => useStore.getState();

// Starting over, or building something that isn't the schema, leaves the part behind: there's nothing to go back with.
useStore.subscribe((s) => {
  if (!useDrill.getState().parent || s.building) return;
  if (!s.environment || s.environment.domain !== 'database') useDrill.setState({ parent: null });
});

// Loads a design the way a fresh build does, without a build.
function load(environment: Environment) {
  if (useLive.getState().id) leaveLive();
  runner.load(environment);
  store().set({ environment, environmentKey: store().environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null, explanation: null });
}

/** Builds the part as a design of its own, remembering the design it came from. */
export async function drillInto(drill: NonNullable<Inspection['drill']>) {
  const environment = store().environment;
  if (!environment) return;
  const label = environment.name;
  const { steps, findings, explanation } = store();
  useDrill.setState({ parent: { environment, node: drill.node, label, rps: drill.rps, steps, findings, explanation } });
  await buildEnvironment(drill.prompt);
  const built = store().environment;
  if (!built || built === environment || built.domain !== 'database') {
    // Nothing came of it, so there's nothing to link back.
    if (!built || built === environment) useDrill.setState({ parent: null });
    return;
  }
  // Whatever workload the Architect chose, it carries exactly the traffic the design sends this database.
  load({ ...built, spec: sizeWorkload(built.spec as DatabaseSpec, drill.rps) });
}

/** What going back would change: the database's capacity and latency from the schema as it stands now. */
export function linkBack() {
  const { parent } = useDrill.getState();
  const current = store().environment;
  if (!parent || current?.domain !== 'database') return null;
  const node = (parent.environment.spec as SystemSpec).nodes.find((n) => n.id === parent.node);
  if (!node) return null;
  // The schema as it runs now, so an index dropped or a table locked inside it is what the services feel.
  const live = (runner.run as unknown as { spec?: DatabaseSpec } | null)?.spec ?? (current.spec as DatabaseSpec);
  return { node, ...asDatabaseNode(live, node.replicas ?? 1) };
}

/** Returns to the design the schema came from, with its database behaving like the schema. */
export function backToParent() {
  const { parent } = useDrill.getState();
  const link = linkBack();
  useDrill.setState({ parent: null });
  if (!parent) return;
  const restore = () => store().set({ steps: parent.steps, findings: parent.findings, explanation: parent.explanation });
  if (!link) {
    load(parent.environment);
    return restore();
  }
  const spec = structuredClone(parent.environment.spec) as SystemSpec;
  const node = spec.nodes.find((n) => n.id === parent.node)!;
  node.capacity = link.capacity;
  node.latency = link.latency;
  load({ ...parent.environment, spec });
  restore();
  store().addMessage({
    role: 'app',
    text: `${node.label ?? node.id} now runs as its schema does: about ${link.capacity.toLocaleString('en-US')} queries a second per replica before it's full, ${link.latency} ms a query.`,
  });
}
