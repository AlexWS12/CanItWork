import { describe, expect, it } from 'vitest';
import { domainList, evaluate, type Domain, type Evaluation, type Incident, type Metric, type Run } from '../src';

/** Edge cases every domain, old and new, has to survive. */

const finite = (n: unknown) => typeof n !== 'number' || Number.isFinite(n);

function expectSane(evaluation: Evaluation) {
  expect(Number.isFinite(evaluation.score)).toBe(true);
  expect(evaluation.score).toBeGreaterThanOrEqual(0);
  expect(evaluation.score).toBeLessThanOrEqual(100);
  for (const m of evaluation.metrics) expect(finite(m.value), `${m.label} is ${m.value}`).toBe(true);
  for (const p of evaluation.series) expect(Number.isFinite(p.value) && Number.isFinite(p.t)).toBe(true);
}

function expectSaneTelemetry(metrics: Metric[]) {
  for (const m of metrics) {
    expect(finite(m.value), `${m.label} is ${m.value}`).toBe(true);
    expect(String(m.value)).not.toContain('NaN');
  }
}

/** Every incident a domain offers anywhere: breakables, inspector actions on everything, and Red Team claims. */
function allIncidents(domain: Domain, model: unknown, run: Run): Incident[] {
  const out: Incident[] = run.breakables().map((b) => b.incident);
  for (const h of domain.rules.hypotheses(model)) out.push(h.incident);
  const targets = new Set(out.map((i) => i.target).filter(Boolean) as string[]);
  for (const target of targets) for (const action of run.inspect(target)?.actions ?? []) out.push(action.incident);
  return out;
}

describe.each(domainList().map((d) => [d.id, d] as [string, Domain]))('%s edge cases', (_, domain) => {
  const spec = domain.rules.spec(domain.examples[0]);
  const model = domain.compile(spec);

  it('scores a zero-tick run without dividing by zero', () => {
    const result = evaluate(domain, model, { seed: 1, ticks: 0, events: [] });
    expectSane(result);
  });

  it('runs every offered failure, every recovery and every variant without breaking', () => {
    const probe = domain.createRun(model, 1);
    for (let i = 0; i < 10; i++) probe.step();
    const incidents = allIncidents(domain, model, probe);
    expect(incidents.length).toBeGreaterThan(0);
    for (const incident of incidents) {
      const options = domain.rules.recoveries(model, incident);
      const events = [{ at: 10, incident }, ...options.map((o, i) => ({ at: 20 + i * 5, patches: o.patches }))];
      const result = evaluate(domain, model, { seed: 2, ticks: 80, events });
      expectSane(result);
    }
    for (const variant of domain.variants(model, spec)) {
      const variantModel = variant.spec ? domain.compile(variant.spec as never) : model;
      expectSane(evaluate(domain, variantModel, { seed: 1, ticks: 60, events: variant.patches ? [{ at: 0, patches: variant.patches }] : [] }));
    }
  });

  it('replays a long, mixed log exactly, including recoveries', () => {
    const live = domain.createRun(model, 4);
    const incidents = allIncidents(domain, model, live);
    incidents.forEach((incident, i) => {
      for (let t = 0; t < 7; t++) live.step();
      live.inject(incident);
      const fix = domain.rules.recoveries(model, incident)[0];
      if (fix && i % 2 === 0) live.apply(fix.patches);
    });
    for (let t = 0; t < 15; t++) live.step();
    expectSane(live.evaluation());
    expectSaneTelemetry(live.telemetry());
    expect(evaluate(domain, model, { seed: 4, ticks: live.tick, events: live.log })).toEqual(live.evaluation());
  });

  it('ignores incidents and patches aimed at things that do not exist', () => {
    const run = domain.createRun(model, 1);
    const before = evaluate(domain, model, { seed: 1, ticks: 30, events: [] });
    run.inject({ type: 'no_such_incident', target: 'ghost' });
    for (const type of domain.incidentTypes) run.inject({ type, target: 'ghost-node-that-is-not-there' });
    run.apply([]);
    for (let i = 0; i < 30; i++) run.step();
    expectSane(run.evaluation());
    expectSaneTelemetry(run.telemetry());
    expect(run.inspect('ghost-node-that-is-not-there')).toBeNull();
    expect(run.inspect('')).toBeNull();
    expectSane(before);
  });

  it('applies the same failure twice, and its recovery twice, without drifting', () => {
    const run = domain.createRun(model, 1);
    const [first] = run.breakables();
    for (let i = 0; i < 5; i++) run.step();
    run.inject(first.incident);
    run.inject(first.incident);
    const fix = domain.rules.recoveries(model, first.incident)[0];
    if (fix) {
      run.apply(fix.patches);
      run.apply(fix.patches);
    }
    for (let i = 0; i < 40; i++) run.step();
    expectSane(run.evaluation());
  });

  it('gives a different but valid result for other seeds', () => {
    for (const seed of [0, 7, 2 ** 31 - 1]) expectSane(evaluate(domain, model, { seed, ticks: 50, events: [] }));
  });

  it('describes its model as JSON and keeps prompt docs non-empty', () => {
    expect(() => JSON.parse(domain.describe(model))).not.toThrow();
    for (const doc of [domain.specDoc, domain.incidentDoc, domain.patchDoc, domain.capabilities, domain.blurb]) expect(doc.trim().length).toBeGreaterThan(10);
    expect(domain.examples.length).toBeGreaterThan(0);
    expect(domain.suggestions.length).toBeGreaterThan(0);
    expect(domain.council).toHaveLength(3);
  });

  it('builds a valid keyless design from an empty or unrelated prompt', () => {
    for (const prompt of ['', 'something completely different', domain.examples[0].toUpperCase()]) {
      const fallback = domain.rules.spec(prompt);
      expect(domain.specSchema.safeParse(fallback).success).toBe(true);
      expect(domain.validate(domain.compile(fallback)).filter((i) => i.severity === 'error')).toEqual([]);
    }
  });

  it('recognises its own example as its domain', () => {
    expect(domain.keywords.test(domain.examples[0])).toBe(true);
  });
});
