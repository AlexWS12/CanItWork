import { describe, expect, it } from 'vitest';
import { CircuitRun, DOMAINS, evaluate, type CircuitSpec } from '../src';

const electronics = DOMAINS.electronics;
const prompt = electronics.examples[0];
const spec = electronics.rules.spec(prompt) as CircuitSpec;

describe('the demo planter', () => {
  it('is the first electronics example and passes every check', () => {
    expect(prompt).toMatch(/self-watering planter/);
    expect(electronics.validate(spec)).toEqual([]);
  });

  it('cycles the soil inside its target band', () => {
    const run = new CircuitRun(spec, 1);
    const soil: number[] = [];
    for (let i = 0; i < 12 * 120; i++) {
      run.step();
      soil.push(run.world.get('soil')!);
    }
    const settled = soil.slice(12 * 10);
    expect(Math.min(...settled)).toBeGreaterThan(30);
    expect(Math.max(...settled)).toBeLessThan(70);
    expect(run.texts.get('L1')).toMatch(/^Soil [\d.]+% pump [01]$/);
  });

  it('gives the Red Team a stuck-sensor claim the simulator confirms', () => {
    const claim = electronics.rules.hypotheses(spec).find((h) => h.incident.type === 'sensor_fault');
    expect(claim?.claim).toBe('If S1 sticks at 100%, the sketch acts on a false reading.');
    const ticks = electronics.horizon;
    const base = evaluate(electronics, spec, { seed: 1, ticks, events: [] });
    const stuck = evaluate(electronics, spec, { seed: 1, ticks, events: [{ at: 60, incident: claim!.incident }] });
    expect(stuck.score).toBeLessThan(base.score - 10);
  });

  it('recovers when the burned pump is replaced, and ranks that fix first', () => {
    const ticks = 12 * 60;
    const events = [{ at: 120, incident: { type: 'burn_part', target: 'P1' } }];
    const broken = evaluate(electronics, spec, { seed: 1, ticks, events });
    const options = electronics.rules.recoveries(spec, events[0].incident);
    const scored = options.map((o) => ({ title: o.title, score: evaluate(electronics, spec, { seed: 1, ticks, events: [...events, { at: 240, patches: o.patches }] }).score }));
    scored.sort((a, b) => b.score - a.score);
    expect(scored[0].title).toBe('Replace P1');
    expect(scored[0].score).toBeGreaterThan(broken.score + 10);
  });
});
