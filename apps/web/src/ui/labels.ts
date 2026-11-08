import type { Engine, StepEvent } from '@tv/core';

export const ENGINE_LABEL: Record<Engine, string> = {
  gemini: 'Gemini',
  jev: 'Jev',
  swarms: 'Swarms',
  simulator: 'Simulator',
  rules: 'Local rules',
  cache: 'Verified cache',
};

export const AGENT_LABEL: Record<StepEvent['agent'], string> = {
  interpreter: 'Interpreter',
  architect: 'Architect',
  validator: 'Validator',
  simulator: 'Simulator',
  redteam: 'Red Team',
  council: 'Recovery Council',
  editor: 'Editor',
  analyst: 'Analyst',
  explainer: 'Explainer',
};

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export const ticks = (t: number) => t.toLocaleString('en-US');

// "Simulator · 38 ms", or just the engine while the step is still running
export const engineLine = (step: StepEvent) => `${ENGINE_LABEL[step.engine]}${step.ms !== undefined ? ` · ${seconds(step.ms)}` : ''}`;
