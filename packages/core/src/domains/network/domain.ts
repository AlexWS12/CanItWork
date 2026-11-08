import type { Domain, DomainId, Hypothesis, Incident, Issue, RecoveryOption, Variant } from '../../domain';
import { NetRun, type NetConfig } from './engine';
import { NetPatchSchema, linkKey, netOrder, netSpecSchema, type KindDef, type NetEdge, type NetNode, type NetSpec } from './schema';

/** What a flow-network domain supplies; everything else is shared. */
export interface NetDomainDef {
  id: DomainId;
  label: string;
  blurb: string;
  capabilities: string;
  limits: string[];
  examples: string[];
  suggestions: string[];
  keywords: RegExp;
  kinds: Record<string, KindDef>;
  mode: NetConfig['mode'];
  trips?: boolean;
  unit: string;
  /** What one tick stands for, e.g. "one minute". */
  tick: string;
  scoreLabel: string;
  lostLabel: string;
  /** Extra sentence for the Architect about sizing this kind of system. */
  guidance: string;
  council: Domain['council'];
  surge: NetConfig['surge'] & { claim: string };
  downVerb: string;
  words: {
    restore: (name: string) => string;
    reroute: (name: string, to: string) => string;
    scale: (name: string) => string;
    shed?: string;
    buffer?: (name: string) => string;
  };
  template(prompt: string): NetSpec;
}

const name = (node: NetNode) => node.label ?? node.id;
const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Sinks that no source can reach once `without` is removed. */
function cutOff(spec: NetSpec, role: (n: NetNode) => string, without?: string) {
  const reached = new Set(spec.nodes.filter((n) => role(n) === 'source' && n.id !== without).map((n) => n.id));
  for (const id of netOrder(spec)) {
    if (!reached.has(id)) continue;
    for (const e of spec.edges) if (e.from === id && e.to !== without) reached.add(e.to);
  }
  return spec.nodes.filter((n) => role(n) === 'sink' && n.id !== without && !reached.has(n.id));
}

/** Where extra storage helps most: the busiest stage that already stores something, else the busiest stage. */
function storeFor(run: NetRun, spec: NetSpec) {
  const stages = spec.nodes.filter((n) => run.role(n) === 'stage');
  const load = (n: NetNode) => run.states.get(n.id)!.utilization;
  const storing = stages.filter((n) => run.bufferOf(n) > 0).sort((a, b) => load(b) - load(a))[0];
  return storing ?? run.busiest();
}

export function networkDomain(def: NetDomainDef): Domain<NetSpec, NetSpec> {
  const config: NetConfig = {
    id: def.id,
    kinds: def.kinds,
    mode: def.mode,
    trips: def.trips,
    unit: def.unit,
    scoreLabel: def.scoreLabel,
    lostLabel: def.lostLabel,
    surge: def.surge,
    downVerb: def.downVerb,
  };
  const kindNames = Object.keys(def.kinds) as [string, ...string[]];
  const role = (n: NetNode) => def.kinds[n.kind]?.role ?? 'stage';
  const steady = (spec: NetSpec, incident?: Incident) => {
    const run = new NetRun(config, spec, 1);
    for (let i = 0; i < 20; i++) run.step();
    if (incident) {
      run.inject(incident);
      for (let i = 0; i < 20; i++) run.step();
    }
    return run;
  };

  function validate(spec: NetSpec): Issue[] {
    const issues: Issue[] = [];
    const ids = new Set(spec.nodes.map((n) => n.id));
    if (ids.size !== spec.nodes.length) issues.push({ severity: 'error', repair: true, message: 'Two nodes share an id' });
    for (const e of spec.edges) {
      for (const end of [e.from, e.to]) if (!ids.has(end)) issues.push({ severity: 'error', repair: true, message: `A link uses ${end}, which doesn't exist` });
    }
    if (issues.length) return issues;
    const byId = (id: string) => spec.nodes.find((n) => n.id === id)!;
    for (const e of spec.edges) {
      if (role(byId(e.from)) === 'sink') issues.push({ severity: 'error', repair: true, message: `${name(byId(e.from))} is an end point, so nothing can flow out of it` });
      if (role(byId(e.to)) === 'source') issues.push({ severity: 'error', repair: true, message: `${name(byId(e.to))} is a source, so nothing can flow into it` });
    }
    if (!spec.nodes.some((n) => role(n) === 'source')) issues.push({ severity: 'error', repair: true, message: 'Nothing supplies the network: add a source' });
    if (!spec.nodes.some((n) => role(n) === 'sink')) issues.push({ severity: 'error', repair: true, message: 'Nothing consumes the flow: add an end point' });
    if (issues.length) return issues;
    if (netOrder(spec).length !== spec.nodes.length)
      return [{ severity: 'error', repair: true, message: 'The links form a loop; flow must run one way, from sources to end points' }];

    const unreached = cutOff(spec, role);
    if (unreached.length) issues.push({ severity: 'error', repair: true, message: `${list(unreached.map(name))} can't be reached from any source` });
    for (const node of spec.nodes) {
      if (role(node) === 'stage' && !spec.edges.some((e) => e.from === node.id)) {
        issues.push({ severity: 'warning', repair: true, target: node.id, message: `${name(node)} has nowhere to send its output` });
      }
    }
    if (issues.some((i) => i.severity === 'error')) return issues;

    for (const node of spec.nodes) {
      if (role(node) !== 'stage') continue;
      const stranded = cutOff(spec, role, node.id);
      if (stranded.length) issues.push({ severity: 'warning', target: node.id, message: `${name(node)} is a single point of failure for ${list(stranded.map(name))}` });
    }
    const run = steady(spec);
    if (def.mode === 'demand') {
      const supply = spec.nodes.filter((n) => role(n) === 'source').reduce((sum, n) => sum + run.capacityOf(n), 0);
      const demand = spec.nodes.filter((n) => role(n) === 'sink').reduce((sum, n) => sum + run.rateOf(n), 0);
      if (supply < demand)
        issues.push({ severity: 'warning', repair: true, message: `Sources can supply ${Math.round(supply)} ${def.unit} per tick but demand is ${Math.round(demand)}` });
      else {
        // Enough supply on paper can still arrive short: link ratings, splits or delays. Judge it once the longest delay has filled.
        const settled = new NetRun(config, spec, 1);
        const warmup = 20 + 3 * Math.max(0, ...spec.edges.map((e) => e.delay ?? 0));
        for (let i = 0; i < warmup; i++) settled.step();
        if (settled.ratio < 0.9)
          issues.push({
            severity: 'warning',
            repair: true,
            message: `Only ${Math.round(settled.ratio * 100)}% of demand is met in normal running, although sources can supply ${Math.round(supply)} ${def.unit} per tick against ${Math.round(demand)}: check link ratings, weights and delays on the way to the end points`,
          });
      }
    }
    for (const node of spec.nodes) {
      const state = run.states.get(node.id)!;
      if (role(node) === 'stage' && state.utilization > 1.05) {
        issues.push({ severity: 'warning', repair: true, target: node.id, message: `${name(node)} is over capacity at ${Math.round(state.utilization * 100)}% load` });
      }
    }
    if (def.trips) {
      for (const e of spec.edges) {
        const link = run.links.get(linkKey(e))!;
        if (e.capacity && (link.tripped || link.flow >= e.capacity * 0.999)) {
          issues.push({
            severity: 'warning',
            repair: true,
            message: `${name(byId(e.from))} → ${name(byId(e.to))} is at its full ${e.capacity} ${def.unit} rating in normal running and will trip`,
          });
        }
      }
    }
    return issues;
  }

  function hypotheses(spec: NetSpec): Hypothesis[] {
    const out: Hypothesis[] = [];
    const stages = spec.nodes.filter((n) => role(n) === 'stage');
    const worst = stages.map((n) => ({ n, cut: cutOff(spec, role, n.id) })).sort((a, b) => b.cut.length - a.cut.length)[0];
    if (worst?.cut.length) {
      out.push({ claim: `${name(worst.n)} is the only route to ${list(worst.cut.map(name))}: losing it cuts them off.`, incident: { type: 'node_down', target: worst.n.id } });
    }
    const run = steady(spec);
    if (def.trips) {
      const line = spec.edges.filter((e) => e.capacity).sort((a, b) => run.links.get(linkKey(b))!.flow / b.capacity! - run.links.get(linkKey(a))!.flow / a.capacity!)[0];
      if (line) {
        const from = name(spec.nodes.find((n) => n.id === line.from)!);
        const to = name(spec.nodes.find((n) => n.id === line.to)!);
        out.push({ claim: `Losing the ${from} → ${to} line pushes its load onto the others, which trip in turn.`, incident: { type: 'link_down', target: linkKey(line) } });
      }
    }
    // The stage carrying the most flow, such as the main port, is worth testing even when it isn't the only route.
    const total = stages.reduce((sum, n) => sum + run.states.get(n.id)!.served, 0);
    const carrier = stages.filter((n) => !out.some((h) => h.incident.target === n.id)).sort((a, b) => run.states.get(b.id)!.served - run.states.get(a.id)!.served)[0];
    const carried = carrier && total ? run.states.get(carrier.id)!.served : 0;
    if (carrier && carried > 0 && !def.trips) {
      out.push({ claim: `${name(carrier)} handles more than any other step: losing it starves everything after it.`, incident: { type: 'node_down', target: carrier.id } });
    }
    out.push({ claim: def.surge.claim, incident: { type: 'surge', value: def.surge.value } });
    const busiest = run.busiest();
    if (busiest && !out.some((h) => h.incident.target === busiest.id)) {
      out.push({
        claim: `${name(busiest)} already runs at ${Math.round(run.states.get(busiest.id)!.utilization * 100)}% load: if it slows down, everything behind it backs up.`,
        incident: { type: 'node_slow', target: busiest.id, value: 2.5 },
      });
    }
    return out.slice(0, 3);
  }

  function recoveries(spec: NetSpec, incident: Incident | undefined): RecoveryOption[] {
    const target = incident?.target ?? '';
    const node = spec.nodes.find((n) => n.id === target);
    const run = steady(spec);
    const busiest = run.busiest();
    const out: RecoveryOption[] = [];
    const scaleUp = (n: NetNode, author = 'Capacity rules'): RecoveryOption => ({
      author,
      title: def.words.scale(name(n)),
      rationale: 'Add units so it can carry more.',
      patches: [{ op: 'scale', node: n.id, count: Math.min(100, (n.count ?? 1) * 2) }],
    });
    // On a grid that trips, shedding only helps if the lines that already tripped are re-closed with it.
    const reclose = def.trips ? spec.edges.filter((e) => e.capacity).map((e) => ({ op: 'restore_link', from: e.from, to: e.to })) : [];
    const shed: RecoveryOption | null = def.words.shed
      ? { author: 'Operations rules', title: def.words.shed, rationale: 'Take load off the network until it stabilises.', patches: [{ op: 'shed', fraction: 0.25 }, ...reclose] }
      : null;

    if ((incident?.type === 'node_down' || incident?.type === 'node_slow') && node) {
      out.push({ author: 'Operations rules', title: def.words.restore(name(node)), rationale: 'Bring it back on backup capacity.', patches: [{ op: 'restore', node: node.id }] });
      const linked = (from: string, to: string) => spec.edges.some((e) => e.from === from && e.to === to);
      const alternative = spec.nodes.find((n) => n.id !== node.id && n.kind === node.kind && role(n) === role(node));
      if (alternative) {
        // Wire the sibling into both sides of the failed node, skipping links that exist or would loop back.
        // Copy each original link's weight, capacity and delay so the sibling takes on the same split and limits.
        const copy = (e: NetEdge, from: string, to: string) => ({
          from,
          to,
          ...(e.weight ? { weight: e.weight } : {}),
          ...(e.capacity ? { capacity: e.capacity } : {}),
          ...(e.delay ? { delay: e.delay } : {}),
        });
        const candidates = [
          ...spec.edges.filter((e) => e.to === node.id).map((e) => copy(e, e.from, alternative.id)),
          ...spec.edges.filter((e) => e.from === node.id).map((e) => copy(e, alternative.id, e.to)),
        ];
        const patches = candidates
          .filter((l) => l.from !== l.to && !linked(l.from, l.to) && netOrder({ ...spec, edges: [...spec.edges, l] }).length === spec.nodes.length)
          .map((l) => ({ op: 'add_link', ...l }));
        if (patches.length)
          out.push({ author: 'Routing rules', title: def.words.reroute(name(node), name(alternative)), rationale: 'Send its work to a sibling instead.', patches });
        out.push(scaleUp(alternative));
      } else if (incident.type === 'node_slow') out.push(scaleUp(node));
    } else if (incident?.type === 'link_down') {
      const [from, to] = target.split('->');
      out.push({ author: 'Operations rules', title: 'Restore the link', rationale: 'Re-close it once the fault is clear.', patches: [{ op: 'restore_link', from, to }] });
      if (shed) out.push(shed);
    } else if (incident?.type === 'surge') {
      // Judge what runs hot during the surge itself: a stage with room to spare on a normal day can be the one that overflows.
      const surging = steady(spec, incident);
      const hot = spec.nodes
        .filter((n) => role(n) === 'stage' && surging.states.get(n.id)!.utilization > 0.7)
        .sort((a, b) => surging.states.get(b.id)!.utilization - surging.states.get(a.id)!.utilization);
      if (hot.length)
        out.push({
          author: 'Capacity rules',
          title: `Scale up ${list(hot.slice(0, 3).map(name))}`,
          rationale: 'Double what is already running hot.',
          patches: hot.map((n) => ({ op: 'scale', node: n.id, count: Math.min(100, (n.count ?? 1) * 2) })),
        });
      // Where demand is scored, the peak can outrun supply: bring one more unit online at the source with the most unused line room.
      if (def.mode === 'demand') {
        const room = (n: NetNode) =>
          spec.edges.filter((e) => e.from === n.id).reduce((sum, e) => sum + (e.capacity ? Math.max(0, e.capacity - surging.links.get(linkKey(e))!.flow) : Infinity), 0);
        const reserve = spec.nodes.filter((n) => role(n) === 'source' && !surging.states.get(n.id)!.down && room(n) > 0).sort((a, b) => room(b) - room(a))[0];
        if (reserve)
          out.push({
            author: 'Capacity rules',
            title: def.words.scale(name(reserve)),
            rationale: 'Bring a reserve unit online to cover the peak.',
            patches: [{ op: 'scale', node: reserve.id, count: Math.min(100, (reserve.count ?? 1) + 1) }],
          });
      }
      // Turning arrivals away counts against a flow score, so only offer shedding where demand is what's scored.
      if (shed && def.mode === 'demand') out.push(shed);
      const store = storeFor(run, spec);
      if (store && def.words.buffer)
        out.push({
          author: 'Operations rules',
          title: def.words.buffer(name(store)),
          rationale: 'Give the peak somewhere to wait.',
          patches: [{ op: 'set_buffer', node: store.id, buffer: Math.max(50, run.bufferOf(store) * 4) }],
        });
    }
    if (!out.length && busiest) out.push(scaleUp(busiest));
    if (shed && !out.includes(shed) && def.mode === 'demand') out.push(shed);
    return out;
  }

  function variants(spec: NetSpec): Variant[] {
    const run = steady(spec);
    const busiest = run.busiest();
    const out: Variant[] = [];
    if (busiest) out.push({ title: def.words.scale(name(busiest)), patches: [{ op: 'scale', node: busiest.id, count: Math.min(100, (busiest.count ?? 1) * 2) }] });
    const source = spec.nodes.find((n) => role(n) === 'source');
    if (source && def.mode === 'demand')
      out.push({ title: def.words.scale(name(source)), patches: [{ op: 'scale', node: source.id, count: Math.min(100, (source.count ?? 1) + 1) }] });
    const store = storeFor(run, spec);
    if (store && def.words.buffer)
      out.push({ title: def.words.buffer(name(store)), patches: [{ op: 'set_buffer', node: store.id, buffer: Math.max(50, run.bufferOf(store) * 4) }] });
    return out;
  }

  const kindDoc = Object.entries(def.kinds)
    .map(([kind, k]) => `${kind} (${k.role}): ${k.doc}`)
    .join('\n');

  return {
    id: def.id,
    label: def.label,
    blurb: def.blurb,
    capabilities: def.capabilities,
    limits: def.limits,
    examples: def.examples,
    suggestions: def.suggestions,
    keywords: def.keywords,
    ticksPerSecond: 8,
    horizon: 300,
    seeds: 1,
    responseDelay: 15,
    specSchema: netSpecSchema(kindNames),
    specDoc: `{
  "nodes": [{"id": string, "label": string, "kind": ${kindNames.map((k) => `"${k}"`).join('|')}, "count"?: units, "capacity"?: ${def.unit} per unit per tick, "rate"?: ${def.mode === 'demand' ? 'demand per tick (end points)' : 'arrivals per tick (sources)'}, "buffer"?: ${def.unit} that can wait}],
  "edges": [{"from": node id, "to": node id, "weight"?: share of flow, "capacity"?: ${def.unit} per tick, "delay"?: ticks in transit}]
}
Kinds and defaults:
${kindDoc}
One tick is ${def.tick}. Flow runs one way from sources to end points, with no loops. ${def.guidance}`,
    incidentTypes: ['node_down', 'node_slow', 'link_down', 'surge'],
    incidentDoc: `{"type":"node_down","target":"node id"}
{"type":"node_slow","target":"node id","value":slowdown factor}
{"type":"link_down","target":"from->to"}
{"type":"surge","value":multiplier 1.2-5}`,
    patchSchema: NetPatchSchema,
    patchDoc: `{"op":"scale","node":"id","count":units}
{"op":"restore","node":"id"} (back at reduced capacity)
{"op":"add_link","from":"id","to":"id","capacity"?:number,"delay"?:ticks}
{"op":"restore_link","from":"id","to":"id"}
{"op":"set_buffer","node":"id","buffer":number}
{"op":"shed","fraction":0-0.9} (${def.mode === 'demand' ? 'cut demand' : 'turn away arrivals'})`,
    council: def.council,
    compile: (spec) => spec,
    validate,
    describe: (spec) => JSON.stringify(spec),
    createRun: (spec, seed) => new NetRun(config, spec, seed),
    variants,
    rules: { spec: def.template, hypotheses, recoveries },
  };
}
