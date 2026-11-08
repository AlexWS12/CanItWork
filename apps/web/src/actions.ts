import { componentIds, type Candidate, type Environment, type Incident, type ProviderStatus, type SpecEdit, type SpendSummary, type StreamEvent } from '@tv/core';
import { matchEntities } from './entities';
import { runner } from './runner';
import { MAX_SHARED_TICKS, decodeRun, encodeRun, isSharedLink, runHash, shortHash } from './share';
import { useStore, type Message } from './store';

const store = () => useStore.getState();

async function stream(path: string, body: unknown, onEvent: (e: StreamEvent) => void) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`Server replied ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
      const chunk = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}

function common(event: StreamEvent) {
  switch (event.type) {
    case 'step':
      store().addStep(event);
      if (event.odds) store().set({ domainOdds: event.odds });
      break;
    case 'usage':
      store().set({ usage: [...store().usage, event.usage] });
      void fetchSpend();
      break;
    case 'findings':
      store().set({ findings: event.findings });
      break;
    case 'explanation': {
      // Later answers add wording for new labels without losing what was already explained
      const before = store().explanation;
      const next = event.explanation;
      store().set({
        explanation: before ? { ...before, ...next, metrics: { ...before.metrics, ...next.metrics }, findings: next.findings.length ? next.findings : before.findings } : next,
      });
      break;
    }
    case 'error':
      store().addMessage({ role: 'app', text: event.message });
      break;
  }
}

// Credits a reply to the step that just ran, which is the one that produced it
function reply(text: string) {
  const last = store().steps[store().steps.length - 1];
  const message: Message = { role: 'app', text };
  if (last) message.source = { agent: last.agent, engine: last.engine };
  store().addMessage(message);
}

function loadEnvironment(environment: Environment) {
  runner.load(environment);
  store().set({ environment, environmentKey: store().environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null, explanation: null });
}

const FRESH_MS = 6000;
let freshTimer: ReturnType<typeof setTimeout> | null = null;

// A structural change from chat or the 3D view: the run restarts on the new design, but the camera stays where the user left it.
function rebuildInPlace(environment: Environment, added: string[]) {
  const ids = new Set(componentIds(environment.domain, environment.spec));
  const layout = environment.layout && Object.fromEntries(Object.entries(environment.layout).filter(([id]) => ids.has(id)));
  const next: Environment = { ...environment, layout: layout && Object.keys(layout).length ? layout : undefined };
  if (!next.layout) delete next.layout;
  runner.load(next);
  const { selected, rebuilds } = store();
  const fresh = added.filter((id) => ids.has(id));
  store().set({
    environment: next,
    rebuilds: rebuilds + 1,
    report: null,
    appliedId: null,
    refusal: null,
    selected: fresh[0] ?? (selected && ids.has(selected) ? selected : null),
    fresh,
  });
  if (freshTimer) clearTimeout(freshTimer);
  if (fresh.length) freshTimer = setTimeout(() => store().set({ fresh: [] }), FRESH_MS);
}

/** Deletes or duplicates a component from the 3D view; the agents check the change before it lands. */
export async function editComponent(edit: SpecEdit) {
  const { environment, editing, chatting } = store();
  if (!environment || editing || chatting) return;
  const title = runner.run?.inspect(edit.id)?.title ?? edit.id;
  store().addMessage({ role: 'user', text: `${edit.op === 'remove' ? 'Delete' : 'Duplicate'} ${title}` });
  store().set({ editing: true, chatting: true });
  try {
    await stream('/api/edit', { environment, edit }, (event) => {
      common(event);
      if (event.type !== 'reply') return;
      reply(event.text);
      // Another change may have landed while the agents were checking this one
      if (event.action.kind === 'rebuild' && store().environment?.spec === environment.spec) {
        rebuildInPlace({ ...event.action.environment, layout: store().environment?.layout }, event.action.added ?? []);
      }
    });
  } catch (error) {
    store().addMessage({ role: 'app', text: String(error) });
  }
  store().set({ editing: false, chatting: false });
}

/** Moves a component while it's dragged. Layout lives on the environment, so a shared link keeps it. */
export function moveComponent(id: string, at: [number, number]) {
  const environment = store().environment;
  if (!environment) return;
  store().set({ environment: { ...environment, layout: { ...environment.layout, [id]: at } } });
}

let movedBefore = false;
export function finishMove(id: string) {
  if (movedBefore) return;
  movedBefore = true;
  const title = runner.run?.inspect(id)?.title ?? id;
  store().addMessage({
    role: 'app',
    text: `Moved ${title}. Where things sit is only for the view: the simulator doesn't read positions, so the numbers stay the same. Select a component to duplicate or delete it, and the agents will check what that does.`,
  });
}

export async function shareRun() {
  const environment = store().environment;
  const history = runner.history();
  if (!environment || !history) return null;
  const shared = await encodeRun({ environment, seed: history.seed, tick: history.tick, events: history.events });
  window.history.replaceState(null, '', shared.url);
  return shared;
}

// Opens a run from a shared link and checks it replays to the hash the link carries.
export async function openSharedRun() {
  if (!isSharedLink()) return;
  const shared = await decodeRun();
  if (!shared) {
    store().addMessage({ role: 'app', text: `This shared link couldn't be opened: it is damaged, or asks to replay more than ${MAX_SHARED_TICKS.toLocaleString('en-US')} ticks.` });
    return;
  }
  runner.replay(shared.environment, shared.seed, shared.tick, shared.events);
  store().set({ environment: shared.environment, environmentKey: store().environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null });
  const replayed = runHash(shared.environment, shared.seed, shared.tick, shared.events);
  store().addMessage({
    role: 'app',
    text:
      replayed === shared.hash
        ? `Replayed a shared run exactly: ${shared.tick} ticks and ${shared.events.length} event${shared.events.length === 1 ? '' : 's'}. Its provenance hash ${shortHash(replayed)} matches the link.`
        : `This link doesn't replay to its own provenance hash (${shortHash(shared.hash)} in the link, ${shortHash(replayed)} replayed), so something in it was changed.`,
  });
}

export async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) store().set({ status: (await res.json()) as ProviderStatus });
  } catch {
    store().set({ status: null });
  }
  void fetchSpend();
}

// Lifetime Prune savings from the server's spend ledger
export async function fetchSpend() {
  try {
    const res = await fetch('/api/spend');
    if (res.ok) store().set({ spend: (await res.json()) as SpendSummary });
  } catch {
    // The showcase keeps its last numbers when the server blips.
  }
}

export async function buildEnvironment(prompt: string) {
  store().set({ building: true, prompt, entities: [], domainOdds: null, steps: [], findings: [], report: null, appliedId: null, refusal: null });
  store().addMessage({ role: 'user', text: prompt });
  try {
    await stream('/api/build', { prompt }, (event) => {
      common(event);
      if (event.type === 'environment') {
        store().set({ entities: matchEntities(prompt, event.environment.spec) });
        loadEnvironment(event.environment);
      }
      if (event.type === 'refusal') store().set({ refusal: event.refusal });
      if (event.type === 'reply') reply(event.text);
    });
  } catch (error) {
    store().addMessage({ role: 'app', text: String(error) });
  }
  store().set({ building: false });
  if (store().environment && !store().refusal) void explainRun(prompt);
}

// Asks the Explainer to put this run in the words of whoever would run it. The rule-based wording shows until it answers.
let explaining: { key: number; asked: Set<string>; calls: number } = { key: -1, asked: new Set(), calls: 0 };
const MAX_EXPLAINS = 4;

async function explainRun(prompt: string) {
  const { environment, findings, environmentKey } = store();
  if (!environment) return;
  if (explaining.key !== environmentKey) explaining = { key: environmentKey, asked: new Set(), calls: 0 };
  if (explaining.calls >= MAX_EXPLAINS) return;
  explaining.calls++;
  // The dock's metrics appear once the runner has stepped
  for (let i = 0; i < 20 && !store().telemetry.stats.length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const stat of store().telemetry.stats) explaining.asked.add(stat.label);
  try {
    await stream('/api/explain', { prompt, environment, findings, metrics: store().telemetry.stats }, (event) => {
      // Dragging a component replaces the environment object, so compare the build instead
      if (store().environmentKey !== environmentKey) return;
      common(event);
    });
  } catch {
    // The rule-based wording stays.
  }
}

export function startOver() {
  runner.clear();
  store().reset();
  // A shared run's link would otherwise bring it back on the next reload.
  if (isSharedLink()) window.history.replaceState(null, '', `${location.pathname}${location.search}`);
}

export async function sendChat(message: string) {
  const { environment, telemetry } = store();
  const history = runner.history();
  if (!environment || !history) return;
  store().addMessage({ role: 'user', text: message });
  store().set({ chatting: true });
  try {
    await stream('/api/chat', { environment, message, ...history, metrics: telemetry.stats }, (event) => {
      common(event);
      if (event.type !== 'reply') return;
      reply(event.text);
      const { action } = event;
      if (action.kind === 'patch') runner.applyPatches(action.patches);
      if (action.kind === 'rebuild') rebuildInPlace(action.environment, action.added ?? []);
      if (action.kind === 'inject') void breakThing(action.incident);
    });
  } catch (error) {
    store().addMessage({ role: 'app', text: String(error) });
  }
  store().set({ chatting: false });
}

export async function breakThing(incident: Incident) {
  const { environment } = store();
  if (!environment || !runner.inject(incident)) return;
  const history = runner.history()!;
  store().set({ recovering: true, report: null, appliedId: null, tab: 'agents' });
  try {
    await stream('/api/recover', { environment, ...history }, (e) => {
      common(e);
      if (e.type === 'recovery') store().set({ report: e.report, reportOpen: true });
    });
  } catch (error) {
    store().addMessage({ role: 'app', text: String(error) });
  }
  store().set({ recovering: false });
}

export function applyCandidate(candidate: Candidate) {
  runner.applyPatches(candidate.patches);
  store().set({ appliedId: candidate.id, reportOpen: false });
  store().addMessage({ role: 'app', text: `Applied: ${candidate.title}.` });
}

// A stat label the Explainer hasn't seen (another station became the busiest, or the design was rebuilt from chat)
// gets its wording on the next quiet moment, a few calls at most per design.
let freshen: ReturnType<typeof setTimeout> | null = null;
function unexplained() {
  const state = store();
  if (!state.environment || state.building || state.status?.gemini === 'off') return false;
  if (explaining.key === state.environmentKey && explaining.calls >= MAX_EXPLAINS) return false;
  const asked = explaining.key === state.environmentKey ? explaining.asked : new Set<string>();
  const known = Object.keys(state.explanation?.metrics ?? {}).map((k) => k.toLowerCase());
  return state.telemetry.stats.some((m) => !asked.has(m.label) && !known.includes(m.label.toLowerCase()));
}
useStore.subscribe(() => {
  if (freshen || !unexplained()) return;
  freshen = setTimeout(() => {
    freshen = null;
    // The build's own request may have covered these labels in the meantime
    if (unexplained()) void explainRun(store().prompt);
  }, 2500);
});
