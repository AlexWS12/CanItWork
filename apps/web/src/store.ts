import type { Breakable, Environment, Finding, Metric, ProviderStatus, RecoveryReport, Refusal, StepEvent, Usage } from '@tv/core';
import { create } from 'zustand';

export interface Message {
  role: 'user' | 'app';
  text: string;
}

export interface Telemetry {
  tick: number;
  stats: Metric[];
  breakables: Breakable[];
  running: boolean;
  speed: number;
  history: number[];
}

const EMPTY_TELEMETRY: Telemetry = { tick: 0, stats: [], breakables: [], running: false, speed: 1, history: [] };

interface State {
  environment: Environment | null;
  environmentKey: number;
  structure: number;
  refusal: Refusal | null;
  building: boolean;
  chatting: boolean;
  recovering: boolean;
  status: ProviderStatus | null;
  steps: StepEvent[];
  findings: Finding[];
  usage: Usage[];
  messages: Message[];
  report: RecoveryReport | null;
  reportOpen: boolean;
  appliedId: string | null;
  selected: string | null;
  tab: 'agents' | 'usage';
  view: 'scene' | 'chat' | 'agents';
  telemetry: Telemetry;
  set: (partial: Partial<State>) => void;
  setTelemetry: (t: Telemetry) => void;
  bumpStructure: () => void;
  addStep: (step: StepEvent) => void;
  addMessage: (message: Message) => void;
  reset: () => void;
}

export const useStore = create<State>((set) => ({
  environment: null,
  environmentKey: 0,
  structure: 0,
  refusal: null,
  building: false,
  chatting: false,
  recovering: false,
  status: null,
  steps: [],
  findings: [],
  usage: [],
  messages: [],
  report: null,
  reportOpen: true,
  appliedId: null,
  selected: null,
  tab: 'agents',
  view: 'scene',
  telemetry: EMPTY_TELEMETRY,
  set: (partial) => set(partial),
  setTelemetry: (telemetry) => set({ telemetry }),
  bumpStructure: () => set((s) => ({ structure: s.structure + 1 })),
  addStep: (step) =>
    set((s) => {
      const i = s.steps.findIndex((x) => x.id === step.id);
      if (i < 0) return { steps: [...s.steps, step] };
      const steps = s.steps.slice();
      steps[i] = step;
      return { steps };
    }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  reset: () => set({ environment: null, refusal: null, steps: [], findings: [], messages: [], report: null, appliedId: null, selected: null, telemetry: EMPTY_TELEMETRY }),
}));

export const select = (id: string | null) => useStore.getState().set({ selected: id });
