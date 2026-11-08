import type { ZodType } from 'zod';
import { z } from 'zod';

export type DomainId =
  'warehouse' | 'electronics' | 'software' | 'database' | 'power' | 'water' | 'supply' | 'hospital' | 'factory' | 'airport' | 'callcenter' | 'fleet' | 'queues';

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  target?: string;
  repair?: boolean;
}

export interface Metric {
  label: string;
  value: string | number;
  tone?: 'warn' | 'danger';
  // A breakdown behind the headline number, such as every station's load
  detail?: Array<{ label: string; value: string; tone?: 'warn' | 'danger' }>;
}

export const IncidentSchema = z.object({
  type: z.string(),
  target: z.string().optional(),
  value: z.number().optional(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export interface Point {
  t: number;
  value: number;
}

export interface Evaluation {
  score: number;
  scoreLabel: string;
  metrics: Metric[];
  series: Point[];
}

export type TimedEvent = { at: number; incident: Incident } | { at: number; patches: unknown[] };

export interface Scenario {
  seed: number;
  ticks: number;
  events: TimedEvent[];
}

export interface Breakable {
  label: string;
  incident: Incident;
  keywords?: string[];
}

export interface Inspection {
  title: string;
  rows: Array<[string, string | number]>;
  actions: Array<{ label: string; incident: Incident; destructive: boolean }>;
  /** Hand edits to the design as it runs, such as deleting this component; applied like any fix */
  edits?: Array<{ label: string; patches: unknown[]; destructive?: boolean }>;
  /** One line under the edits, such as how to move the thing by hand */
  editHint?: string;
  /** Settings the design runs with, changed by hand mid-run like any fix */
  settings?: Setting[];
}

/**
 * What the Inspector asks a run for to show the settings the whole system runs with, such as a warehouse's dispatch
 * policy or a service's retries. A run that has none returns null for it.
 */
export const SYSTEM = '@system';

/**
 * One setting, as plain data: changing it applies `{ ...patch, [key]: value }`. A number is shown as `value` with
 * `unit` and sent divided by `scale`, so a fraction can be shown as a percentage.
 */
export type Setting = { label: string; hint?: string; patch: Record<string, unknown>; key: string } & (
  | { kind: 'choice'; value: string | number; options: Array<{ label: string; value: string | number }> }
  | { kind: 'number'; value: number; min: number; max: number; step: number; unit: string; scale?: number }
);

/**
 * The check most domains need for a hand edit: the patch has to parse as one of the domain's fixes. Anything that
 * parses is left to the run to apply, as an agent's fix would be.
 */
export function checkPatches(schema: ZodType<any, any, any>, patches: unknown[], exists: (patch: any) => string | null = () => null): string | null {
  for (const patch of patches) {
    const parsed = schema.safeParse(patch);
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'That edit is not one this simulator can make.';
    const reason = exists(parsed.data);
    if (reason) return reason;
  }
  return null;
}

export const settingPatch = (setting: Setting, value: string | number) => ({
  ...setting.patch,
  [setting.key]: typeof value === 'number' && setting.kind === 'number' ? value / (setting.scale ?? 1) : value,
});

export interface Run {
  readonly tick: number;
  readonly log: TimedEvent[];
  step(): void;
  inject(incident: Incident): void;
  apply(patches: unknown[]): void;
  /** Why these patches can't be applied to the run as it stands, or null; for domains that check hand edits. */
  check?(patches: unknown[]): string | null;
  evaluation(): Evaluation;
  telemetry(): Metric[];
  breakables(): Breakable[];
  inspect(target: string): Inspection | null;
  /** What the system as it stands costs to run for a month, for domains with a price list. */
  cost?(): MonthlyCost;
}

/** An estimate from rough cloud list prices, line by line; `ceiling` is what it reaches with every autoscaler at its max. */
export interface MonthlyCost {
  usd: number;
  lines: Array<{ label: string; usd: number }>;
  ceiling?: number;
}

export interface Hypothesis {
  claim: string;
  incident: Incident;
  // Conditions applied from the start, before the incident, such as inputs set so the outputs under attack are active.
  setup?: Incident[];
}

export interface RecoveryOption {
  author: string;
  title: string;
  rationale: string;
  patches: unknown[];
}

export interface Variant {
  title: string;
  spec?: unknown;
  patches?: unknown[];
}

export interface Domain<Spec = any, Model = any> {
  id: DomainId;
  label: string;
  blurb: string;
  capabilities: string;
  limits: string[];
  examples: string[];
  suggestions: string[];
  keywords: RegExp;
  ticksPerSecond: number;
  horizon: number;
  responseDelay: number;
  seeds: number;
  specSchema: ZodType<Spec, any, any>;
  specDoc: string;
  incidentTypes: string[];
  incidentDoc: string;
  patchSchema: ZodType<any, any, any>;
  patchDoc: string;
  council: Array<{ name: string; brief: string }>;
  compile(spec: Spec): Model;
  validate(model: Model): Issue[];
  // One line saying what the simulator has proved about a valid design, such as every truth-table row passing. Shown as its own step.
  proof?(model: Model): string | null;
  describe(model: Model): string;
  createRun(model: Model, seed: number): Run;
  compare?(base: Evaluation, after: Evaluation, incident: Incident): { hurt: boolean; evidence: string };
  variants(model: Model, spec: Spec): Variant[];
  rules: {
    spec(prompt: string): Spec;
    hypotheses(model: Model): Hypothesis[];
    recoveries(model: Model, incident: Incident | undefined): RecoveryOption[];
    patch?(text: string, model: Model): { patches: unknown[]; reply: string } | null;
    /**
     * Deterministic fixes for what the Architect's repairs left, such as a loop in a flow or an overload whose arrival rate the
     * user never stated. `stated` is every number in the user's request, which a mend must leave as it is.
     */
    mend?(spec: Spec, issues: Issue[], stated: number[]): { spec: Spec; notes: string[] } | null;
  };
}

export interface Environment {
  domain: DomainId;
  name: string;
  summary: string;
  spec: unknown;
  unmodelled: string[];
  /** Where the user dragged components in the 3D view, as [x, z] by component id. Cosmetic: no simulator reads it. */
  layout?: Record<string, [number, number]>;
}

export function evaluate(domain: Domain, model: unknown, scenario: Scenario): Evaluation {
  return replay(domain, model, scenario).evaluation();
}

/** A scenario played out on a fresh run, which is left as it ends for anything else worth reading from it. */
export function replay(domain: Domain, model: unknown, scenario: Scenario): Run {
  const run = domain.createRun(model, scenario.seed);
  const events = [...scenario.events].sort((a, b) => a.at - b.at);
  let next = 0;
  for (let t = 0; t < scenario.ticks; t++) {
    while (next < events.length && events[next].at <= t) {
      const event = events[next++];
      if ('incident' in event) run.inject(event.incident);
      else run.apply(event.patches);
    }
    run.step();
  }
  return run;
}

export function defaultCompare(base: Evaluation, after: Evaluation): { hurt: boolean; evidence: string } {
  const delta = base.score ? (after.score - base.score) / base.score : 0;
  const pct = Math.round(delta * 1000) / 10;
  return {
    hurt: -delta >= 0.05,
    evidence: `${base.score} → ${after.score} ${base.scoreLabel} (${pct > 0 ? '+' : ''}${pct}%)`,
  };
}
