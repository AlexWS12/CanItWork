# Live eval of #16 and #17

Tested 2026-11-07 on a scratch merge of `main` + #16 + #17 (+ `alex/circuits-beyond-arduino` for the eval suite). Nothing was pushed to either branch.

## Summary

- Both PRs merge cleanly in order (#16 then #17). All 401 tests pass and typecheck is clean.
- Routing across 11 domains held up on prompts that borrow another domain's words: "a web app for booking airline flights" went to software, "a clinic database with patients" to database, "a solar panel charging a battery" to electronics, "a production line with CNC machines" to factory.
- **#16:** no problems found.
- **#17:** one engine bug blocks power and water. The other five domains baseline at about 100% as expected.

## #17 findings

### 1. Demand mode loses about half the flow when edges have a delay (blocker)

The Architect often adds `delay` to lines. In demand mode that roughly halves the share of demand served, even when supply covers demand with room to spare:

| design (live Gemini) | as built | same design, delays removed |
|---|---|---|
| power grid: gas 250 MW + solar 120 MW → 2 substations → city 200 MW | 53.6% | 100% |
| water: reservoir → treatment → tower → district | 50% | 100% |
| supply chain: 2 suppliers → port → DC → 5 stores | 83.5% | 83.5% |

Minimal repro (fails at 51.5%):

```ts
import { describe, expect, it } from 'vitest';
import { DOMAINS, evaluate } from '../src';

describe('demand mode with line delays', () => {
  const grid = (delay?: number) => ({
    nodes: [
      { id: 'gas', kind: 'gas', capacity: 400 },
      { id: 'sub', kind: 'substation', capacity: 900 },
      { id: 'city', kind: 'city', rate: 200 },
    ],
    edges: [
      { from: 'gas', to: 'sub', delay },
      { from: 'sub', to: 'city', delay },
    ],
  });
  const score = (spec: unknown) => {
    const d = DOMAINS.power;
    return evaluate(d, d.compile(spec), { seed: 1, ticks: d.horizon, events: [] }).score;
  };
  it('serves all demand without delays', () => expect(score(grid())).toBeGreaterThan(98));
  it('serves all demand with one-tick delays', () => expect(score(grid(1))).toBeGreaterThan(95));
});
```

**Root cause:** in `room()` (`network/engine.ts`), a sink's room is `state.demand - state.queue`. Over a delayed link, this tick's arrivals are already in the sink's queue when the upstream stage decides what to send, so it sends `demand - arriving = 0`. Next tick nothing arrives, so it sends everything. The flow alternates full and empty every tick, which is the 50%. What's sent now lands `delay` ticks later, so it should only be sized against what's already landing on that same future tick (the pipeline's last slot).

**Fix:** [`pr17-demand-delay-fix.patch`](pr17-demand-delay-fix.patch) (a 3-line change plus the repro test). On the scratch merge, all 413 tests pass, including all of #17's own, and the live designs recover:

| design | before | after |
|---|---|---|
| power grid | 53.6% | 97.9% |
| water | 50% | 98.6% |
| supply chain | 83.5% | 83.5% (12- and 15-tick shipping lead times leave stores empty at the start, which looks like real warm-up) |
| hospital, airport, factory, call center | about 100% | unchanged |

Apply with `git apply docs/reviews/pr17-demand-delay-fix.patch` on the #17 branch.

### 2. A demand domain that serves half its demand gets no warning

The validator reported only single points of failure for the 50% water design. A baseline-service check (warn with `repair: true` when normal demand isn't met) would have let the Architect fix the design, and would have exposed bug 1.

### 3. Airport runways are split into arrival and departure nodes

For "an airport with two runways and 20 gates", the Architect made `rwy1`, `rwy2`, `dep_rwy1` and `dep_rwy2`: four runway nodes for two runways. The `runway` kind's doc should say one node is one physical runway handling both landings and take-offs, or the model should give departures a separate kind.

### 4. The camera crops the sources

In the hospital view, the ambulance and walk-in sources sit off the left edge of the frame.

## Fixed on `alex/circuits-beyond-arduino` (affects every domain)

- Repairs were overwriting numbers the user stated to clear capacity warnings ("20 gates" became 50, "25 agents" 100, "one CT scanner" 2). Stated numbers are now locked, and unstated values such as arrival rates are sized to fit them.
