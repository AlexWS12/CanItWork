import type { ZodType } from 'zod';
import { z } from 'zod';

export type DomainId = 'warehouse' | 'electronics' | 'software' | 'database' | 'power' | 'water' | 'supply' | 'hospital' | 'factory' | 'airport' | 'callcenter' | 'fleet';

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
}

export interface Run {
  readonly tick: number;
  readonly log: TimedEvent[];
  step(): void;
  inject(incident: Incident): void;
  apply(patches: unknown[]): void;
  evaluation(): Evaluation;
  telemetry(): Metric[];
  breakables(): Breakable[];
  inspect(target: string): Inspection | null;
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
  };
}

export interface Environment {
  domain: DomainId;
  name: string;
  summary: string;
  spec: unknown;
  unmodelled: string[];
}

export function evaluate(domain: Domain, model: unknown, scenario: Scenario): Evaluation {
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
  return run.evaluation();
}

export function defaultCompare(base: Evaluation, after: Evaluation): { hurt: boolean; evidence: string } {
  const delta = base.score ? (after.score - base.score) / base.score : 0;
  const pct = Math.round(delta * 1000) / 10;
  return {
    hurt: -delta >= 0.05,
    evidence: `${base.score} → ${after.score} ${base.scoreLabel} (${pct > 0 ? '+' : ''}${pct}%)`,
  };
}
