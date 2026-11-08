import type { Explanation, Finding, Metric } from '@tv/core';

export type Health = 'good' | 'watch' | 'problem';

// The domains already colour a metric when it's off; that tone is the verdict, in words
export const healthOf = (metric: Metric): Health => (metric.tone === 'danger' ? 'problem' : metric.tone === 'warn' ? 'watch' : 'good');

export const HEALTH_LABEL: Record<Health, string> = { good: 'Healthy', watch: 'Watch', problem: 'Problem' };

// Plain wording for the metrics every domain reports, used until the Explainer answers or when it can't
const RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // Specific readings first, so "worst part load" isn't read as a station's load
  [/worst part load/i, () => 'How close the most stressed part is to its limit. Over 100% it overheats and burns out.'],
  [
    /^monthly cost$/i,
    () =>
      'A rough estimate of what running this for a month would cost: a fixed price for each part of it, plus a usage charge where work flowing through it costs money. When that work varies, this shows the recent average. It is for comparing designs and fixes, not a quote.',
  ],
  [/^% of (.+?) within (.+)$/i, (m) => `Your main goal: the share of ${m[1]} answered in under ${m[2]}, which feels instant. Higher is better.`],
  [/^% of (.+)$/i, (m) => `Your main goal: the share of ${m[1]}. Higher is better; under 90% means people or work are being let down.`],
  [/^within (.+)$/i, (m) => `The share answered in under ${m[1]}, which feels instant. Higher is better.`],
  [/^average wait$/i, () => 'How long someone arriving now can expect to wait before being served. Lower is better.'],
  [/^(.+) load$/i, (m) => `How busy ${m[1]} is. Past about 85% lines start to build, and over 100% it can't keep up.`],
  [/^load$/i, () => `How busy the busiest step is. Past about 85% lines start to build, and over 100% it can't keep up.`],
  [
    /in storage or transit/i,
    () => 'How much is sitting in storage or on its way between sites. Some is a healthy buffer; a pile that keeps growing means something downstream is stuck.',
  ],
  [/^per \d+ ticks$/i, () => 'How fast work is getting done right now: deliveries in the last stretch of time. Higher is better.'],
  [/waiting|backlog|in line|queue/i, () => 'How many are stuck waiting right now. Lower is better; a number that keeps climbing means demand is outrunning you.'],
  [/outages|services down|units lost|queries broken|parts burned/i, () => 'How many things have broken. Anything above zero needs attention.'],
  [/full table scans/i, () => 'Slow lookups that read the whole table. Lower is better; an index usually fixes them.'],
  [/latency/i, () => 'How long each request takes. Lower is better.'],
  [/supply current/i, () => 'How much power the circuit is drawing from its supply.'],
  [/outputs working/i, () => 'How many of the things you wanted to light, move or show are actually working.'],
  [/robots online|in contact/i, () => 'How many units are working and reachable. Higher is better.'],
  [/delivered|mission done|targets reported|requests succeeding/i, () => 'Progress on the job you described. Higher is better.'],
  [/board$/i, () => 'A board lost power and stopped running its program.'],
];

// Labels that carry simulator jargon, in the words shown on screen
export const displayLabel = (label: string) =>
  label
    .replace(/^per (\d+) ticks$/i, 'delivery rate')
    .replace(/^within (.+)$/i, 'answered within $1')
    .replace(/^monthly cost$/i, 'estimated monthly cost');

function lookup(map: Record<string, string> | undefined, label: string) {
  if (!map) return undefined;
  const key = Object.keys(map).find((k) => k.toLowerCase() === label.toLowerCase());
  return key ? map[key] : undefined;
}

export function metricHelp(label: string, explanation: Explanation | null): string {
  // Cost always says what kind of number it is (an averaged estimate at list prices), which a generated line can leave out
  const [, costRule] = RULES.find(([pattern]) => pattern.test(label) && /cost/i.test(label)) ?? [];
  if (costRule) return costRule(label.match(/.*/)!);
  const told = lookup(explanation?.metrics, label);
  if (told) return told;
  for (const [pattern, say] of RULES) {
    const m = label.match(pattern);
    if (m) return say(m);
  }
  return 'A live reading from the simulator.';
}

// Where a reading's number comes from: a cost is added up from the app's price list, everything else is measured as the run plays
export const metricSource = (label: string) =>
  /cost/i.test(label)
    ? { kind: 'price' as const, text: 'the price list, added up part by part' }
    : { kind: 'simulator' as const, text: 'the simulator, measured as the run plays' };

// A one-line verdict for the dock, from the first metric (the score) and any problems
export function headline(stats: Metric[], explanation: Explanation | null, sameRun: boolean): { text: string; health: Health } {
  const worst = stats.find((s) => s.tone === 'danger') ?? stats.find((s) => s.tone === 'warn');
  const health = worst ? healthOf(worst) : 'good';
  if (explanation && sameRun && health === 'good') return { text: explanation.headline, health };
  const [main] = stats;
  if (!main) return { text: '', health };
  if (!worst) return { text: `Running smoothly: ${main.value} ${main.label.replace(/^%\s*/, '')}`, health };
  // "% of arrivals served" at "75.4%" reads as "only 75.4% of arrivals served"
  const reading = worst.label.startsWith('%') ? `only ${worst.value} ${worst.label.slice(1).trim()}` : `${worst.label} at ${worst.value}`;
  return { text: `${health === 'problem' ? 'Something is wrong' : 'Worth watching'}: ${reading}`, health };
}

export interface PlainFinding {
  title: string;
  impact: string;
  advice: string;
}

// "Surge: 100 → 73.8 % of arrivals served (-26.2%)" becomes a sentence a non-engineer can read
export function plainFinding(finding: Finding, explanation: Explanation | null): PlainFinding {
  const told = explanation?.findings.find((f) => f.claim === finding.claim);
  if (told) return { title: told.title, impact: told.impact, advice: told.advice };
  const broke = finding.verdict === 'confirmed';
  const impact = describeChange(finding.evidence, broke);
  return {
    title: finding.claim,
    impact,
    advice: broke ? 'Watch it happen, and the agents will propose fixes and test each one in the simulator.' : 'Your design held up. No action needed.',
  };
}

// The simulator's evidence ("Surge: 100 → 73.8 % of arrivals served (-26.2%)", "Backlog 16 → 259") as a sentence
function describeChange(evidence: string, broke: boolean) {
  const m = evidence.match(/(?:^|:\s*)([A-Za-z][\w ]*?)?\s*(-?[\d.]+)\s*→\s*(-?[\d.]+)\s*(.*?)\s*(?:\(([-+]?[\d.]+)%\))?\s*$/);
  if (!m) return evidence;
  const [, before, from, to, after, pct] = m;
  const percent = after.startsWith('%');
  const out100 = after.match(/^out of 100 for (.+)$/i);
  const what = out100 ? `the ${out100[1]} score` : percent ? `the share of ${after.replace(/^%\s*(of\s*)?/, '')}` : (after || before || 'the result').trim().toLowerCase();
  const unit = percent ? '%' : '';
  const range = `${from}${unit} to ${to}${unit}${out100 ? ' out of 100' : ''}`;
  if (!broke) return `In the simulation it barely mattered: ${what} went from ${range}.`;
  return `In the simulation, ${what} ${Number(to) < Number(from) ? 'fell' : 'rose'} from ${range}${pct ? ` (${pct}%)` : ''}.`;
}
