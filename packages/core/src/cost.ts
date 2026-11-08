// What a design costs to run each month, and what a fix adds to that. Prices are rough on-demand cloud list prices (2026,
// one region, 730 hours a month); they are for comparing designs and fixes, not for a budget.
import { replay, type Domain, type MonthlyCost, type TimedEvent } from './domain';

export const HOURS_PER_MONTH = 730;
export const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;
// Ticks a design runs before its cost is read, so flows (queue messages, API calls) have settled.
const SETTLE_TICKS = 30;

export const usd = (n: number) => Math.round(n * 100) / 100;

/** "$1,240/mo", or "+$90/mo" and "−$30/mo" for a change. */
export function money(n: number, change = false) {
  const whole = Math.round(Math.abs(n));
  const text = `$${whole.toLocaleString('en-US')}/mo`;
  if (!change) return text;
  return whole === 0 ? 'no extra cost' : `${n > 0 ? '+' : '−'}${text}`;
}

function settled<M>(domain: Domain<unknown, M>, model: M, seed: number, patches?: unknown[]) {
  const run = domain.createRun(model, seed);
  if (patches) run.apply(patches);
  for (let i = 0; i < SETTLE_TICKS; i++) run.step();
  return run.cost?.() ?? null;
}

/** The design's monthly cost once its traffic has settled, or null for a domain with no price list. */
export function designCost<M>(domain: Domain<unknown, M>, model: M, seed = 1): MonthlyCost | null {
  return settled(domain, model, seed);
}

/**
 * What a fix adds to the monthly cost (negative when it saves), against the same design without it. Given the incident it
 * answers, the two are compared as that plays out, the way the fix is scored: autoscaling costs only the replicas it boots
 * for the spike, and a fix that cuts retries saves the calls they made.
 */
export function costOfFix<M>(domain: Domain<unknown, M>, model: M, patches: unknown[], seed = 1, during?: { events: TimedEvent[]; ticks: number; at: number }): number | null {
  if (!during) {
    const before = settled(domain, model, seed);
    const after = settled(domain, model, seed, patches);
    return before && after ? usd(after.usd - before.usd) : null;
  }
  const play = domain as unknown as Domain;
  const before = replay(play, model, { seed, ticks: during.ticks, events: during.events }).cost?.();
  const after = replay(play, model, { seed, ticks: during.ticks, events: [...during.events, { at: during.at, patches }] }).cost?.();
  return before && after ? usd(after.usd - before.usd) : null;
}
