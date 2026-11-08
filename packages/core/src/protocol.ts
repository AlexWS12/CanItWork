import type { DomainId, Environment, Evaluation, Incident } from './domain';

export type Engine = 'gemini' | 'jev' | 'swarms' | 'simulator' | 'rules' | 'cache';

export interface Usage {
  engine: Engine;
  model: string;
  via: 'prune' | 'direct' | 'swarms' | 'typesafe';
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costSavedUsd: number | null;
  cacheHit: boolean | null;
  routedModel: string | null;
  receipt: unknown;
  feature: string;
  // Prune's receipt: tokens its prompt cleanup and output caps removed, the cost the call would have had without Prune, and what it did.
  tokensSaved?: number | null;
  costWithoutUsd?: number | null;
  optimizations?: string[];
  signed?: boolean;
}

// Every Gemini call this server has made, from the spend ledger, so savings outlive one page.
export interface SpendSummary {
  calls: number;
  viaPrune: number;
  direct: number;
  tokens: number;
  tokensSaved: number;
  costUsd: number;
  costWithoutUsd: number;
  savedUsd: number;
  cacheHits: number;
  routed: number;
  // Why calls skipped Prune, when they did, such as the vaulted Gemini key being rejected.
  bypass: string | null;
}

export type AgentId = 'interpreter' | 'architect' | 'validator' | 'reviewer' | 'simulator' | 'redteam' | 'council' | 'editor' | 'analyst' | 'explainer';

export interface StepEvent {
  type: 'step';
  id: string;
  agent: AgentId;
  engine: Engine;
  title: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
  ms?: number;
  progress?: number;
  odds?: Partial<Record<DomainId, number>>;
}

export interface Finding {
  claim: string;
  incident: Incident;
  verdict: 'confirmed' | 'refuted';
  evidence: string;
}

export interface Candidate {
  id: string;
  author: string;
  title: string;
  rationale: string;
  patches: unknown[];
  evaluation: Evaluation;
  // The Analyst's estimate of what this fix asks of whoever runs the system
  effort?: 'low' | 'medium' | 'high';
  cost?: string;
  // What the fix adds to the system's monthly running cost, from the simulator's price list (negative when it saves)
  monthly?: number;
}

export interface RecoveryReport {
  tick: number;
  incident: string;
  reference: Evaluation;
  unmitigated: Evaluation;
  candidates: Candidate[];
  winnerId: string | null;
  summary: string;
  // The Analyst's plain-language verdict and what the fix costs, when Gemini is connected
  headline?: string;
  tradeoff?: string;
  // The recommended fix: the cheapest of those scoring within a point or so of the best. Null or missing means the top scorer
  valueId?: string | null;
}

// The Explainer's plain-language reading of a run, in the words of whoever would run this system
export interface ExplainedFinding {
  claim: string;
  title: string;
  impact: string;
  advice: string;
}

export interface Explanation {
  audience: string;
  headline: string;
  metrics: Record<string, string>;
  findings: ExplainedFinding[];
}

export interface Refusal {
  reason: string;
  closest: DomainId | null;
  /** Set when the request was turned away only because nobody is signed in. */
  signIn?: true;
}

export type ChatAction =
  { kind: 'patch'; patches: unknown[] } | { kind: 'rebuild'; environment: Environment; added?: string[] } | { kind: 'inject'; incident: Incident } | { kind: 'none' };

export type StreamEvent =
  | StepEvent
  /** Which simulator the build will use, as soon as the Interpreter decides, so the view can set the stage. */
  | { type: 'domain'; domain: DomainId }
  /**
   * The design as it stands after each round (the first design, each repair, a mend), before it has passed every check.
   * The view draws it as a blueprint; only `environment` is the design to run. `issues` is what the checks still found.
   */
  | { type: 'draft'; attempt: number; environment: Environment; issues: string[] }
  | { type: 'environment'; environment: Environment }
  | { type: 'refusal'; refusal: Refusal }
  | { type: 'findings'; findings: Finding[] }
  | { type: 'recovery'; report: RecoveryReport }
  | { type: 'explanation'; explanation: Explanation }
  | { type: 'usage'; usage: Usage }
  | { type: 'reply'; text: string; action: ChatAction }
  | { type: 'error'; message: string; signIn?: true }
  | { type: 'done' };

export type KeyCheck = 'ok' | 'failing' | 'unchecked';

export interface ProviderStatus {
  gemini: 'prune' | 'direct' | 'off';
  swarms: boolean;
  prune: boolean;
  typesafe: boolean;
  /** Where saved runs and live sessions are kept: Tiger Data's Postgres, or a local file. */
  storage?: 'postgres' | 'file';
  checks?: Record<'gemini' | 'swarms' | 'prune' | 'typesafe', KeyCheck> & { storage?: KeyCheck };
}
