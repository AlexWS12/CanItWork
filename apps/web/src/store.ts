import type {
  AgentId,
  Breakable,
  DomainId,
  Engine,
  Environment,
  Explanation,
  Finding,
  Metric,
  ProviderStatus,
  RecoveryReport,
  Refusal,
  SpendSummary,
  StepEvent,
  Usage,
} from '@tv/core';
import { create } from 'zustand';

export interface Message {
  role: 'user' | 'app';
  text: string;
  source?: { agent: AgentId; engine: Engine };
  /** The server turned the request away until someone signs in, so the message offers the button. */
  signIn?: boolean;
}

export interface Telemetry {
  tick: number;
  stats: Metric[];
  breakables: Breakable[];
  running: boolean;
  speed: number;
  statHistory: Record<string, number[]>;
}

const EMPTY_TELEMETRY: Telemetry = { tick: 0, stats: [], breakables: [], running: false, speed: 1, statHistory: {} };

interface State {
  environment: Environment | null;
  environmentKey: number;
  // Bumped when a design is rebuilt in place, which remounts the scene but keeps the camera
  rebuilds: number;
  structure: number;
  // Components just added by an edit or from chat, highlighted for a moment
  fresh: string[];
  editing: boolean;
  refusal: Refusal | null;
  building: boolean;
  prompt: string;
  entities: string[];
  domainOdds: Partial<Record<DomainId, number>> | null;
  chatting: boolean;
  recovering: boolean;
  // undefined until the first status check answers, null when the server can't be reached.
  status: ProviderStatus | null | undefined;
  steps: StepEvent[];
  findings: Finding[];
  explanation: Explanation | null;
  usage: Usage[];
  spend: SpendSummary | null;
  messages: Message[];
  report: RecoveryReport | null;
  reportOpen: boolean;
  appliedId: string | null;
  selected: string | null;
  tab: 'agents' | 'usage' | 'build';
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
  rebuilds: 0,
  structure: 0,
  fresh: [],
  editing: false,
  refusal: null,
  building: false,
  prompt: '',
  entities: [],
  domainOdds: null,
  chatting: false,
  recovering: false,
  status: undefined,
  steps: [],
  findings: [],
  explanation: null,
  usage: [],
  spend: null,
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
  reset: () =>
    set({
      environment: null,
      refusal: null,
      steps: [],
      findings: [],
      explanation: null,
      messages: [],
      report: null,
      appliedId: null,
      selected: null,
      entities: [],
      domainOdds: null,
      fresh: [],
      telemetry: EMPTY_TELEMETRY,
    }),
}));

export const select = (id: string | null) => useStore.getState().set({ selected: id });
