import type { DomainId, Environment, Evaluation, Incident } from './domain';

export type Engine = 'gemini' | 'jev' | 'swarms' | 'simulator' | 'rules';

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
}

export type AgentId = 'interpreter' | 'architect' | 'validator' | 'simulator' | 'redteam' | 'council' | 'editor' | 'analyst';

export interface StepEvent {
  type: 'step';
  id: string;
  agent: AgentId;
  engine: Engine;
  title: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
  ms?: number;
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
}

export interface RecoveryReport {
  tick: number;
  incident: string;
  reference: Evaluation;
  unmitigated: Evaluation;
  candidates: Candidate[];
  winnerId: string | null;
  summary: string;
}

export interface Refusal {
  reason: string;
  closest: DomainId | null;
}

export type ChatAction = { kind: 'patch'; patches: unknown[] } | { kind: 'rebuild'; environment: Environment } | { kind: 'inject'; incident: Incident } | { kind: 'none' };

export type StreamEvent =
  | StepEvent
  | { type: 'environment'; environment: Environment }
  | { type: 'refusal'; refusal: Refusal }
  | { type: 'findings'; findings: Finding[] }
  | { type: 'recovery'; report: RecoveryReport }
  | { type: 'usage'; usage: Usage }
  | { type: 'reply'; text: string; action: ChatAction }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type KeyCheck = 'ok' | 'failing' | 'unchecked';

export interface ProviderStatus {
  gemini: 'prune' | 'direct' | 'off';
  swarms: boolean;
  prune: boolean;
  typesafe: boolean;
  checks?: Record<'gemini' | 'swarms' | 'prune' | 'typesafe', KeyCheck>;
}
