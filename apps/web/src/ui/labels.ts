import type { Engine, StepEvent } from '@tv/core';

export const ENGINE_LABEL: Record<Engine, string> = {
  gemini: 'Gemini',
  jev: 'Jev',
  swarms: 'Swarms',
  simulator: 'Simulator',
  rules: 'Local rules',
  cache: 'Verified cache',
};

// What each agent does, in words anyone can follow: a nurse planning a ward or a teacher building a circuit shouldn't need
// to know what a "red team" is. The technical names stay in the code and the README.
export const AGENT_LABEL: Record<StepEvent['agent'], string> = {
  interpreter: 'Understands your request',
  architect: 'Designs it',
  validator: 'Tests it',
  reviewer: 'Checks it matches',
  simulator: 'Runs it',
  redteam: 'Looks for weak spots',
  council: 'Finds fixes',
  editor: 'Makes your change',
  analyst: 'Answers your question',
  explainer: 'Explains the results',
};

// The server's step titles, said plainly. Anything not listed shows as it is.
const PLAIN_STEP: Record<string, string> = {
  'Identifying the domain': 'Working out what kind of system this is',
  'Designing the environment': 'Designing your system',
  'Fixing what the checks found': 'Fixing what the tests found',
  'Drafting from a template': 'Starting from a ready-made design',
  'Convening the design council': 'Asking three designers for their version',
  'Reusing a verified design': 'Reusing a design that already passed every test',
  'Checking the design': 'Testing the design in the simulator',
  'Rechecking the design': 'Testing it again',
  'Settling what the repairs left': 'Tidying up after the fixes',
  'Reviewing it against your request': 'Checking it is what you asked for',
  'Running the baseline': 'Running it as designed',
  'Attacking the design': 'Looking for ways it could fail',
  'Looking for weak points': 'Looking for ways it could fail',
  'Testing each claim': 'Trying each one for real',
  'Convening the recovery council': 'Asking for ways to recover',
  'Listing recovery options': 'Listing ways to recover',
  'Interpreting your request': 'Working out what you want changed',
};
export const stepTitle = (title: string) => PLAIN_STEP[title] ?? title;

// The usage ledger's feature names ("red-team", "architect-import"), as what the money was spent on
const PLAIN_FEATURE: Array<[RegExp, string]> = [
  [/^red.?team/i, 'Looking for weak spots'],
  [/^architect.?import/i, 'Reading your file'],
  [/^architect|^design/i, 'Designing'],
  [/^repair/i, 'Fixing failed tests'],
  [/^interpret|^route|^jev/i, 'Understanding your request'],
  [/^review/i, 'Checking it matches'],
  [/^council|^recover/i, 'Finding fixes'],
  [/^explain/i, 'Plain-word explanations'],
  [/^chat|^edit/i, 'Your changes and questions'],
];
export const featureLabel = (feature: string) => {
  for (const [pattern, label] of PLAIN_FEATURE) if (pattern.test(feature)) return label;
  const words = feature.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export const ticks = (t: number) => t.toLocaleString('en-US');

// "Simulator · 38 ms", or just the engine while the step is still running
export const engineLine = (step: StepEvent) => `${ENGINE_LABEL[step.engine]}${step.ms !== undefined ? ` · ${seconds(step.ms)}` : ''}`;
