import { describe, expect, it } from 'vitest';
import { DOMAINS, evaluate, type Domain } from '../src';
import { NetRun, networkDomain, type NetSpec } from '../src/domains/network';

/** A small line to test the shared engine directly: arrivals, two parallel stations, a step after them, an end point. */
const line = networkDomain({
  id: 'factory',
  label: 'Test line',
  blurb: 'test',
  capabilities: 'test line',
  limits: ['test'],
  examples: ['test line'],
  suggestions: ['test'],
  keywords: /test line/,
  kinds: {
    feed: { role: 'source', rate: 6, buffer: 0, doc: 'feed' },
    station: { role: 'stage', capacity: 4, buffer: 5, doc: 'station' },
    finish: { role: 'stage', capacity: 10, buffer: 5, doc: 'finish' },
    out: { role: 'sink', doc: 'out' },
  },
  mode: 'flow',
  unit: 'units',
  tick: 'one minute',
  scoreLabel: '% through',
  lostLabel: 'lost',
  guidance: '',
  council: [
    { name: 'A', brief: 'a' },
    { name: 'B', brief: 'b' },
    { name: 'C', brief: 'c' },
  ],
  surge: { label: 'Surge', value: 2, keywords: ['surge'], claim: 'A surge hurts.' },
  downVerb: 'Stop',
  words: { restore: (n) => `Fix ${n}`, reroute: (n, to) => `Move ${n} to ${to}`, scale: (n) => `Grow ${n}`, buffer: (n) => `Buffer ${n}` },
  template: () => lineSpec(),
});

const lineSpec = (): NetSpec => ({
  nodes: [
    { id: 'in', kind: 'feed' },
    { id: 'a', kind: 'station' },
    { id: 'b', kind: 'station' },
    { id: 'f', kind: 'finish' },
    { id: 'out', kind: 'out' },
  ],
  edges: [
    { from: 'in', to: 'a' },
    { from: 'in', to: 'b' },
    { from: 'a', to: 'f' },
    { from: 'b', to: 'f' },
    { from: 'f', to: 'out' },
  ],
});

const run = (spec: NetSpec, domain: Domain = line, seed = 1) => domain.createRun(spec, seed) as NetRun;
const steps = (r: NetRun, n: number) => {
  for (let i = 0; i < n; i++) r.step();
  return r;
};
const messages = (spec: NetSpec, domain: Domain = line) => domain.validate(spec).map((i) => i.message);

describe('network validator', () => {
  it('accepts a sound line', () => {
    expect(line.validate(lineSpec()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('rejects duplicate ids and links to nodes that do not exist', () => {
    const dup = lineSpec();
    dup.nodes.push({ id: 'a', kind: 'station' });
    expect(messages(dup)).toContain('Two nodes share an id');
    const ghost = lineSpec();
    ghost.edges.push({ from: 'a', to: 'nowhere' });
    expect(messages(ghost)).toContain("A link uses nowhere, which doesn't exist");
  });

  it('rejects flow out of an end point or into a source', () => {
    const spec = lineSpec();
    spec.edges.push({ from: 'out', to: 'f' }, { from: 'a', to: 'in' });
    const found = messages(spec);
    expect(found.some((m) => m.includes('end point, so nothing can flow out'))).toBe(true);
    expect(found.some((m) => m.includes('is a source, so nothing can flow into it'))).toBe(true);
  });

  it('needs at least one source and one end point', () => {
    const noSource = lineSpec();
    noSource.nodes[0].kind = 'station';
    expect(messages(noSource)).toContain('Nothing supplies the network: add a source');
    const noSink = lineSpec();
    noSink.nodes[4].kind = 'finish';
    expect(messages(noSink)).toContain('Nothing consumes the flow: add an end point');
  });

  it('rejects a loop', () => {
    const spec = lineSpec();
    spec.edges.push({ from: 'f', to: 'a' });
    expect(messages(spec)[0]).toContain('form a loop');
  });

  it('flags an end point no source reaches, and a stage with nowhere to send', () => {
    const spec = lineSpec();
    spec.nodes.push({ id: 'lonely', kind: 'out' }, { id: 'dead', kind: 'station' });
    spec.edges.push({ from: 'in', to: 'dead' });
    const found = messages(spec);
    expect(found).toContain("lonely can't be reached from any source");
    const deadEnd = lineSpec();
    deadEnd.nodes.push({ id: 'dead', kind: 'station' });
    deadEnd.edges.push({ from: 'in', to: 'dead' });
    expect(messages(deadEnd)).toContain('dead has nowhere to send its output');
  });

  it('names single points of failure and overloaded stages', () => {
    const found = messages(lineSpec());
    expect(found).toContain('f is a single point of failure for out');
    expect(found.some((m) => m.startsWith('a '))).toBe(false);
    const hot = lineSpec();
    hot.nodes[0].rate = 20;
    expect(messages(hot).some((m) => m.includes('over capacity'))).toBe(true);
  });

  it('warns when sources cannot cover demand, and when a line would trip', () => {
    const grid = DOMAINS.power.rules.spec('');
    for (const node of grid.nodes) if (node.kind === 'city') node.rate = 900;
    const found = messages(grid, DOMAINS.power);
    expect(found.some((m) => m.startsWith('Sources can supply'))).toBe(true);
    expect(found.some((m) => m.includes('will trip'))).toBe(true);
  });
});

describe('network engine', () => {
  it('conserves work in flow mode: everything that arrives is delivered, turned away or still inside', () => {
    for (const events of [
      [],
      [{ type: 'node_down', target: 'a' }],
      [{ type: 'node_down', target: 'f' }],
      [{ type: 'surge', value: 4 }],
      [{ type: 'link_down', target: 'in->b' }],
    ]) {
      const r = run(lineSpec());
      const start = r.stock();
      for (const incident of events) r.inject(incident);
      steps(r, 120);
      expect(r.arrived).toBeGreaterThan(0);
      expect(r.delivered + r.lost + r.stock() - start).toBeCloseTo(r.arrived, 6);
    }
  });

  it('conserves patients, flights and calls in every flow domain, even with failures', () => {
    for (const domain of [DOMAINS.hospital, DOMAINS.factory, DOMAINS.airport, DOMAINS.callcenter]) {
      const spec = domain.rules.spec(domain.examples[0]) as NetSpec;
      for (const incident of domain
        .createRun(spec, 1)
        .breakables()
        .map((b) => b.incident)) {
        const r = run(spec, domain);
        const start = r.stock();
        steps(r, 10);
        r.inject(incident);
        steps(r, 150);
        expect(r.delivered + r.lost + r.stock() - start, `${domain.id} after ${incident.type}`).toBeCloseTo(r.arrived, 4);
      }
    }
  });

  it('never serves more than was asked for in demand mode', () => {
    for (const domain of [DOMAINS.power, DOMAINS.water, DOMAINS.supply]) {
      const r = run(domain.rules.spec('') as NetSpec, domain);
      for (let t = 0; t < 100; t++) {
        r.step();
        for (const node of r.spec.nodes) {
          const state = r.states.get(node.id)!;
          if (r.role(node) === 'sink') expect(state.served).toBeLessThanOrEqual(state.demand + 1e-6);
          expect(state.queue).toBeGreaterThanOrEqual(-1e-9);
        }
      }
    }
  });

  it('holds work bound for a stopped step instead of leaking it to another step', () => {
    const spec: NetSpec = {
      nodes: [
        { id: 'in', kind: 'feed', rate: 4 },
        { id: 'a', kind: 'station', capacity: 10 },
        { id: 'f', kind: 'finish' },
        { id: 'out', kind: 'out' },
      ],
      edges: [
        { from: 'in', to: 'a' },
        { from: 'a', to: 'f' },
        { from: 'a', to: 'out' },
        { from: 'f', to: 'out' },
      ],
    };
    const r = run(spec);
    r.inject({ type: 'node_down', target: 'f' });
    steps(r, 60);
    // Half of a's work is bound for f; it waits at a rather than spilling into out.
    expect(r.heldAt('a')).toBeGreaterThan(0);
    expect(r.links.get('a->out')!.flow).toBeLessThanOrEqual(r.capacityOf(r.node('a')!) / 2 + 1e-6);
  });

  it('turns arrivals away once there is nowhere to wait', () => {
    const r = run(lineSpec());
    r.inject({ type: 'node_down', target: 'a' });
    r.inject({ type: 'node_down', target: 'b' });
    steps(r, 30);
    expect(r.lost).toBeGreaterThan(0);
    expect(r.ratio).toBeLessThan(0.2);
  });

  it('delivers through a delayed link only after the delay', () => {
    const spec = lineSpec();
    spec.edges = spec.edges.map((e) => (e.from === 'f' ? { ...e, delay: 6 } : e));
    const r = run(spec);
    r.inject({ type: 'node_down', target: 'in' });
    const inTransit = r.links.get('f->out')!.pipeline.reduce((a, b) => a + b, 0);
    expect(inTransit).toBeGreaterThan(0);
    steps(r, 6);
    expect(r.links.get('f->out')!.pipeline.reduce((a, b) => a + b, 0)).toBeLessThan(inTransit);
  });

  it('cascades: losing one power line overloads and trips the other', () => {
    // Two 100 MW lines feed a 150 MW town; either alone is too small.
    const grid: NetSpec = {
      nodes: [
        { id: 'plant', kind: 'coal' },
        { id: 's1', kind: 'substation' },
        { id: 's2', kind: 'substation' },
        { id: 'town', kind: 'city', rate: 150 },
      ],
      edges: [
        { from: 'plant', to: 's1', capacity: 100 },
        { from: 'plant', to: 's2', capacity: 100 },
        { from: 's1', to: 'town' },
        { from: 's2', to: 'town' },
      ],
    };
    const healthy = steps(run(grid, DOMAINS.power), 50);
    expect(healthy.ratio).toBeGreaterThan(0.99);
    const r = run(grid, DOMAINS.power);
    r.inject({ type: 'link_down', target: 'plant->s1' });
    steps(r, 30);
    expect(r.links.get('plant->s1')!.tripped).toBe(false);
    expect(r.links.get('plant->s2')!.tripped).toBe(true);
    expect(r.ratio).toBeLessThan(0.05);
  });

  it('reroutes around a lost line when the rest of the grid has room', () => {
    // Downtown's feeder is also fed from the south, with room to spare.
    const r = run(DOMAINS.power.rules.spec('') as NetSpec, DOMAINS.power);
    r.inject({ type: 'link_down', target: 'north->downtownFeed' });
    steps(r, 60);
    expect([...r.links.values()].filter((l) => l.tripped)).toEqual([]);
    // Loads split by line rating rather than an optimal power flow, so a tight grid can fall a few percent short.
    expect(r.ratio).toBeGreaterThan(0.95);
  });

  it('strands a plant whose only line is cut, and serves what the rest can generate', () => {
    const r = run(DOMAINS.power.rules.spec('') as NetSpec, DOMAINS.power);
    r.inject({ type: 'link_down', target: 'coal->north' });
    steps(r, 60);
    expect(r.links.get('gas->north')!.flow).toBeGreaterThan(0);
    expect(r.ratio).toBeGreaterThan(0.7);
    expect(r.ratio).toBeLessThan(0.85);
  });

  it('keeps a healthy grid from tripping on its own', () => {
    const r = steps(run(DOMAINS.power.rules.spec('') as NetSpec, DOMAINS.power), 300);
    expect([...r.links.values()].some((l) => l.down)).toBe(false);
  });

  it('lets storage carry demand through an outage until it runs dry', () => {
    const town = DOMAINS.water.rules.spec('') as NetSpec;
    const r = run(town, DOMAINS.water);
    r.inject({ type: 'node_down', target: 'pumpEast' });
    steps(r, 3);
    expect(r.ratio).toBeGreaterThan(0.99);
    steps(r, 40);
    expect(r.ratio).toBeLessThan(0.9);
  });

  it('counts a cut-off end point as unserved demand', () => {
    const r = run(DOMAINS.power.rules.spec('') as NetSpec, DOMAINS.power);
    r.inject({ type: 'node_down', target: 'downtown' });
    steps(r, 5);
    expect(r.ratio).toBeLessThan(0.8);
  });
});

describe('network patches', () => {
  it('scales, restores at reduced capacity and restores a slowed node fully', () => {
    const r = run(lineSpec());
    r.inject({ type: 'node_down', target: 'a' });
    r.apply([{ op: 'restore', node: 'a' }]);
    expect(r.states.get('a')).toMatchObject({ down: false, slow: 0.6 });
    r.inject({ type: 'node_slow', target: 'b', value: 4 });
    r.apply([{ op: 'restore', node: 'b' }]);
    expect(r.states.get('b')!.slow).toBe(1);
    r.apply([{ op: 'scale', node: 'a', count: 3 }]);
    expect(r.capacityOf(r.node('a')!)).toBe(12);
  });

  it('adds a link, but refuses a loop, a duplicate, or an unknown node', () => {
    const r = run(lineSpec());
    const edges = () => r.spec.edges.length;
    const before = edges();
    r.apply([{ op: 'add_link', from: 'f', to: 'a' }]);
    r.apply([{ op: 'add_link', from: 'a', to: 'f' }]);
    r.apply([{ op: 'add_link', from: 'a', to: 'ghost' }]);
    expect(edges()).toBe(before);
    r.apply([{ op: 'add_link', from: 'in', to: 'f', weight: 2 }]);
    expect(edges()).toBe(before + 1);
    expect(r.links.has('in->f')).toBe(true);
    steps(r, 20);
    expect(r.links.get('in->f')!.flow).toBeGreaterThan(0);
  });

  it('re-closes a tripped line and clears its overload count', () => {
    const r = run(DOMAINS.power.rules.spec('') as NetSpec, DOMAINS.power);
    r.inject({ type: 'link_down', target: 'coal->north' });
    r.apply([{ op: 'restore_link', from: 'coal', to: 'north' }]);
    expect(r.links.get('coal->north')).toMatchObject({ down: false, tripped: false, overload: 0 });
  });

  it('clamps surges, and recover with no target ends one', () => {
    const r = run(lineSpec());
    r.inject({ type: 'surge', value: 99 });
    expect(r.spike).toBe(5);
    r.inject({ type: 'surge', value: 0.1 });
    expect(r.spike).toBe(1);
    r.inject({ type: 'surge' });
    expect(r.spike).toBe(2);
    r.inject({ type: 'recover' });
    expect(r.spike).toBe(1);
  });

  it('sheds demand and grows buffers', () => {
    const r = run(DOMAINS.power.rules.spec('') as NetSpec, DOMAINS.power);
    r.apply([{ op: 'shed', fraction: 0.5 }]);
    steps(r, 5);
    expect(r.ratio).toBeLessThan(0.6);
    r.apply([{ op: 'set_buffer', node: 'south', buffer: 50 }]);
    expect(r.bufferOf(r.node('south')!)).toBe(50);
  });

  it('survives every node and every link going down at once', () => {
    for (const domain of [DOMAINS.power, DOMAINS.water, DOMAINS.supply, DOMAINS.hospital, DOMAINS.factory, DOMAINS.airport, DOMAINS.callcenter]) {
      const spec = domain.rules.spec('') as NetSpec;
      const r = run(spec, domain);
      for (const node of spec.nodes) r.inject({ type: 'node_down', target: node.id });
      for (const edge of spec.edges) r.inject({ type: 'link_down', target: `${edge.from}->${edge.to}` });
      steps(r, 40);
      const result = r.evaluation();
      expect(Number.isFinite(result.score), domain.id).toBe(true);
      expect(r.ratio).toBeLessThan(0.05);
    }
  });

  it('handles a stage with zero capacity without dividing by zero', () => {
    const spec = lineSpec();
    spec.nodes[1].capacity = 0;
    spec.nodes[2].capacity = 0;
    const result = evaluate(line, spec, { seed: 1, ticks: 50, events: [] });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeLessThan(5);
  });
});

describe('new domain presets', () => {
  const ids = ['power', 'water', 'supply', 'hospital', 'factory', 'airport', 'callcenter'] as const;

  it.each(ids)('%s runs healthy, its first claim hurts, and some recovery beats it', (id) => {
    const domain = DOMAINS[id];
    const spec = domain.rules.spec(domain.examples[0]);
    const ticks = 300;
    expect(evaluate(domain, spec, { seed: 1, ticks, events: [] }).score).toBeGreaterThan(99);
    const [claim] = domain.rules.hypotheses(spec);
    const events = [{ at: 30, incident: claim.incident }];
    const hurt = evaluate(domain, spec, { seed: 1, ticks, events }).score;
    expect(hurt).toBeLessThan(95);
    const best = Math.max(
      ...domain.rules.recoveries(spec, claim.incident).map((r) => evaluate(domain, spec, { seed: 1, ticks, events: [...events, { at: 45, patches: r.patches }] }).score),
    );
    expect(best).toBeGreaterThan(hurt + 10);
  });
});

describe('stations with several units', () => {
  const banked = (count: number, capacity = 10) => {
    const spec = lineSpec();
    spec.nodes[3] = { id: 'f', kind: 'finish', count, capacity };
    return spec;
  };

  it('loses one unit at a time: the rest keep serving, and losing the last stops the station', () => {
    const r = steps(run(banked(4)), 20);
    r.inject({ type: 'unit_down', target: 'f' });
    steps(r, 1);
    expect(r.states.get('f')!.capacity).toBeCloseTo(30);
    expect(r.states.get('f')!.down).toBe(false);
    expect(r.inspect('f')!.rows).toContainEqual(['Units', '3 of 4 running']);
    r.inject({ type: 'unit_down', target: 'f', value: 3 });
    expect(r.states.get('f')!.down).toBe(true);
    r.inject({ type: 'recover', target: 'f' });
    steps(r, 1);
    expect(r.states.get('f')!.capacity).toBeCloseTo(40);
  });

  it('hurts only when the units left cannot carry the load', () => {
    const roomy = steps(run(banked(4)), 20);
    roomy.inject({ type: 'unit_down', target: 'f' });
    expect(steps(roomy, 40).ratio).toBeGreaterThan(0.99);
    const tight = steps(run(banked(3, 2.2)), 20);
    tight.inject({ type: 'unit_down', target: 'f' });
    expect(steps(tight, 40).ratio).toBeLessThan(0.9);
  });

  it('only calls a lone unit a single point of failure', () => {
    expect(messages(banked(2)).some((m) => m.includes('single point of failure'))).toBe(false);
    expect(messages(banked(1))).toContain('f is a single point of failure for out');
  });

  it('offers to repair the failed unit or add more after losing one', () => {
    const titles = line.rules.recoveries(banked(3), { type: 'unit_down', target: 'f' }).map((r) => r.title);
    expect(titles).toEqual(['Fix f', 'Grow f']);
  });

  it('counts people between stations as moving, not waiting, in flow mode', () => {
    const spec = lineSpec();
    spec.edges = spec.edges.map((e) => (e.from === 'f' ? { ...e, delay: 6 } : e));
    const r = steps(run(spec), 30);
    expect(r.links.get('f->out')!.pipeline.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const queued = spec.nodes.filter((n) => r.role(n) === 'stage').reduce((sum, n) => sum + r.states.get(n.id)!.queue + r.heldAt(n.id), 0);
    expect(r.backlog()).toBeCloseTo(queued);
  });
});

describe('mending what repairs left', () => {
  it('drops the link that closes a loop', () => {
    const spec = lineSpec();
    spec.edges.push({ from: 'f', to: 'a' });
    const issues = line.validate(spec);
    expect(issues.some((i) => /loop/.test(i.message))).toBe(true);
    const mended = line.rules.mend!(spec, issues, [])!;
    expect(mended.notes[0]).toMatch(/dropped the link f → a/);
    expect(line.validate(mended.spec).some((i) => i.severity === 'error')).toBe(false);
  });

  it('fits an overload to about 90% when the user never stated the arrival rate', () => {
    const spec = lineSpec();
    spec.nodes[0].rate = 40;
    const issues = line.validate(spec);
    expect(issues.some((i) => /over capacity/.test(i.message))).toBe(true);
    const mended = line.rules.mend!(spec, issues, [])!;
    expect(mended.notes[0]).toMatch(/runs at about 90%/);
    expect(line.validate(mended.spec).some((i) => /over capacity/.test(i.message))).toBe(false);
  });

  it('leaves an arrival rate the user wrote down as it is', () => {
    const spec = lineSpec();
    spec.nodes[0].rate = 40;
    expect(line.rules.mend!(spec, line.validate(spec), [40])).toBeNull();
  });
});
