import { describe, expect, it } from 'vitest';
import { domainList, evaluate } from '../src';
import type { Domain } from '../src';

describe.each(domainList().map((d) => [d.id, d] as [string, Domain]))('%s meets the platform contract', (_, domain) => {
  const spec = domain.rules.spec(domain.examples[0]);
  const model = domain.compile(spec);
  const ticks = Math.min(domain.horizon, 300);

  it('parses, compiles and validates its own fallback spec', () => {
    expect(domain.specSchema.safeParse(spec).success).toBe(true);
    expect(domain.validate(model).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('is deterministic for a seed', () => {
    expect(evaluate(domain, model, { seed: 3, ticks, events: [] })).toEqual(evaluate(domain, model, { seed: 3, ticks, events: [] }));
  });

  it('offers working failures, and replaying its log reproduces a live run', () => {
    const live = domain.createRun(model, 1);
    const options = live.breakables();
    expect(options.length).toBeGreaterThan(1);
    for (let i = 0; i < 20; i++) live.step();
    live.inject(options[0].incident);
    for (let i = 0; i < 40; i++) live.step();
    const replay = evaluate(domain, model, { seed: 1, ticks: live.tick, events: live.log });
    expect(replay).toEqual(live.evaluation());
  });

  it('proposes hypotheses and recoveries the schemas accept', () => {
    const claims = domain.rules.hypotheses(model);
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(domain.incidentTypes).toContain(claim.incident.type);
      for (const option of domain.rules.recoveries(model, claim.incident)) {
        for (const patch of option.patches) expect(domain.patchSchema.safeParse(patch).success).toBe(true);
      }
    }
  });

  it('explains what it does not model', () => {
    expect(domain.limits.length).toBeGreaterThan(0);
  });
});
