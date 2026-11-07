import { describe, expect, it } from 'vitest';
import { DOMAINS, evaluate } from '../src';
describe('demand mode with line delays', () => {
  const grid = (delay?: number) => ({ nodes: [{ id: 'gas', kind: 'gas', capacity: 400 }, { id: 'sub', kind: 'substation', capacity: 900 }, { id: 'city', kind: 'city', rate: 200 }], edges: [{ from: 'gas', to: 'sub', delay }, { from: 'sub', to: 'city', delay }] });
  const score = (spec: unknown) => { const d = DOMAINS.power; return evaluate(d, d.compile(spec), { seed: 1, ticks: d.horizon, events: [] }).score; };
  it('no delays', () => expect(score(grid())).toBeGreaterThan(98));
  it('one-tick delays', () => expect(score(grid(1))).toBeGreaterThan(95));
  it('three-tick delays', () => expect(score(grid(3))).toBeGreaterThan(90));
});
