import type { DomainId } from './domain';
import { DOMAINS } from './domains';
import type { DatabaseSpec } from './domains/database/schema';

// Direct edits from the 3D view: removing or duplicating one component. Only domains drawn as a graph of
// components support them, since there a component is a node and its links are edges.

export interface SpecEdit {
  op: 'remove' | 'duplicate';
  /** The component's id, as the scene and the inspector use it */
  id: string;
}

export type EditResult = { ok: true; spec: unknown; id: string; label: string } | { ok: false; reason: string };

const NET: DomainId[] = ['power', 'water', 'supply', 'hospital', 'factory', 'airport', 'callcenter', 'queues'];

export const EDITABLE: ReadonlySet<DomainId> = new Set<DomainId>([...NET, 'software', 'database']);

export const isEditable = (domain: DomainId) => EDITABLE.has(domain);

/** The ids of the components a spec draws, for an editable domain */
export function componentIds(domain: DomainId, spec: unknown): string[] {
  if (domain === 'database') return (spec as DatabaseSpec).tables.map((t) => t.name);
  if (EDITABLE.has(domain)) return (spec as Graph).nodes.map((n) => n.id);
  return [];
}

function freshId(base: string, taken: Set<string>, joiner: string) {
  const stem = base.replace(new RegExp(`${joiner}\\d+$`), '');
  for (let i = 2; ; i++) {
    const id = `${stem}${joiner}${i}`;
    if (!taken.has(id)) return id;
  }
}

const freshLabel = (label: string | undefined, id: string) => (label ? `${label.replace(/ \d+$/, '')} ${id.match(/\d+$/)?.[0] ?? '2'}` : undefined);

// Both graph specs share this shape; anything else on a node or edge is copied as it is.
type Graph = { nodes: Array<{ id: string; label?: string }>; edges: Array<{ from: string; to: string }> };

function editGraph(spec: Graph, edit: SpecEdit): EditResult {
  const node = spec.nodes.find((n) => n.id === edit.id);
  if (!node) return { ok: false, reason: `There is no component called ${edit.id}` };
  const label = node.label ?? node.id;
  if (edit.op === 'remove') {
    const nodes = spec.nodes.filter((n) => n.id !== edit.id);
    const edges = spec.edges.filter((e) => e.from !== edit.id && e.to !== edit.id);
    if (nodes.length < 2) return { ok: false, reason: 'A design needs at least two components' };
    if (!edges.length) return { ok: false, reason: `Removing ${label} would leave nothing connected` };
    return { ok: true, spec: { ...spec, nodes, edges }, id: edit.id, label };
  }
  const id = freshId(node.id, new Set(spec.nodes.map((n) => n.id)), '-');
  const copy = { ...node, id, label: freshLabel(node.label, id) };
  if (copy.label === undefined) delete copy.label;
  const edges = spec.edges;
  const copies = edges.filter((e) => e.from === edit.id || e.to === edit.id).map((e) => ({ ...e, from: e.from === edit.id ? id : e.from, to: e.to === edit.id ? id : e.to }));
  const at = spec.nodes.indexOf(node) + 1;
  const nodes = [...spec.nodes.slice(0, at), copy, ...spec.nodes.slice(at)];
  return { ok: true, spec: { ...spec, nodes, edges: [...edges, ...copies] }, id, label: copy.label ?? id };
}

function editDatabase(spec: DatabaseSpec, edit: SpecEdit): EditResult {
  const table = spec.tables.find((t) => t.name === edit.id);
  if (!table) return { ok: false, reason: `There is no table called ${edit.id}` };
  if (edit.op === 'remove') {
    if (spec.tables.length < 2) return { ok: false, reason: 'A database needs at least one table' };
    // Keys into the removed table stay as plain columns; queries on it or joining it go with it.
    const tables = spec.tables
      .filter((t) => t !== table)
      .map((t) => ({
        ...t,
        columns: t.columns.map((c) => {
          if (c.references?.table !== table.name) return c;
          const { references: _, ...rest } = c;
          return rest;
        }),
      }));
    const workload = spec.workload.filter((q) => q.table !== table.name && !q.joins.some((j) => j.table === table.name));
    return { ok: true, spec: { ...spec, tables, workload }, id: edit.id, label: table.name };
  }
  const name = freshId(table.name, new Set(spec.tables.map((t) => t.name)), '_');
  const at = spec.tables.indexOf(table) + 1;
  const tables = [...spec.tables.slice(0, at), { ...table, name }, ...spec.tables.slice(at)];
  return { ok: true, spec: { ...spec, tables }, id: name, label: name };
}

/** Applies one edit and checks the result still fits the domain's spec schema. */
export function editSpec(domain: DomainId, spec: unknown, edit: SpecEdit): EditResult {
  if (!EDITABLE.has(domain)) return { ok: false, reason: `${DOMAINS[domain].label} designs can't be edited from the view yet` };
  const result = domain === 'database' ? editDatabase(spec as DatabaseSpec, edit) : editGraph(spec as Graph, edit);
  if (!result.ok) return result;
  const parsed = DOMAINS[domain].specSchema.safeParse(result.spec);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const tooMany = issue?.code === 'too_big';
    return { ok: false, reason: tooMany ? 'The design is already at its size limit' : `That edit doesn't fit the design: ${issue?.message ?? 'invalid spec'}` };
  }
  return { ...result, spec: parsed.data };
}

/** What a rebuilt spec added and removed, by component id */
export function componentDiff(domain: DomainId, before: unknown, after: unknown) {
  const a = new Set(componentIds(domain, before));
  const b = new Set(componentIds(domain, after));
  return { added: [...b].filter((id) => !a.has(id)), removed: [...a].filter((id) => !b.has(id)) };
}
