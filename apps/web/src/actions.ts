import { componentIds, type Candidate, type Environment, type Incident, type ProviderStatus, type SpecEdit, type SpendSummary, type StreamEvent } from '@tv/core';
import { matchEntities } from './entities';
import { runner } from './runner';
import { snapshotView } from './scene/snapshot';
import { ownKeyHeaders } from './ownKeys';
import { authFetch, useAuth } from './auth';
import { joinLive, leaveLive, liveIdOf, relayAgent, useLive } from './live';
import { MAX_SHARED_TICKS, decodeRun, encodeRun, isSharedLink, runHash, sane, savedIdOf, savedRunLink, shortHash, type SharedRun } from './share';
import { useStore, type Message } from './store';

const store = () => useStore.getState();

// Carries the sign-in token, so the server counts a signed-in person by their account and lets them past a sign-in gate.
async function stream(path: string, body: unknown, onEvent: (e: StreamEvent) => void) {
  const res = await authFetch(path, {
    method: 'POST',
    // A signed-in person's own API keys ride along with agent requests; the server uses them for this request alone
    headers: { 'content-type': 'application/json', ...ownKeyHeaders() },
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
      store().addMessage({ role: 'app', text: event.message, ...(event.signIn ? { signIn: true } : {}) });
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
  // A new design starts over, so it leaves any live session around the old one.
  if (useLive.getState().id) leaveLive();
  runner.load(environment);
  store().set({ environment, showcase: null, environmentKey: store().environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null, explanation: null });
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

/**
 * A hand edit to the running floor, such as moving a robot or a shelf. It goes in like any fix, so it's logged at its tick
 * and replays; the run checks it first and the reason comes back when it can't land.
 */
export function editFloor(patches: unknown[]): string | null {
  const run = runner.run;
  if (!run) return 'Nothing is running.';
  const reason = run.check?.(patches) ?? null;
  if (reason) return reason;
  runner.applyPatches(patches);
  return null;
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
  const run = { environment, seed: history.seed, tick: history.tick, events: history.events };
  const shared = await encodeRun(run);
  window.history.replaceState(null, '', shared.url);
  return { ...shared, run: { ...run, hash: shared.hash } as SharedRun };
}

export type Visibility = 'public' | 'listed' | 'private' | 'people';

/** Saves the open run to the signed-in user's account and returns its short link. */
export async function saveRun(run: SharedRun, visibility: Visibility, people: string[], name?: string) {
  // A picture of the view as it is now, for the system's card in My systems
  const thumb = snapshotView() ?? undefined;
  const res = await authFetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run, visibility, people, name, thumb }) });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? 'The run could not be saved');
  window.history.replaceState(null, '', savedRunLink(body.id));
  return { id: body.id, url: savedRunLink(body.id), thumb: thumb ?? null };
}

function replayShared(shared: SharedRun, from: string) {
  runner.replay(shared.environment, shared.seed, shared.tick, shared.events);
  store().set({ environment: shared.environment, showcase: null, environmentKey: store().environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null });
  const replayed = runHash(shared.environment, shared.seed, shared.tick, shared.events);
  store().addMessage({
    role: 'app',
    text:
      replayed === shared.hash
        ? `Replayed ${from} exactly: ${shared.tick} ticks and ${shared.events.length} event${shared.events.length === 1 ? '' : 's'}. Its provenance hash ${shortHash(replayed)} matches.`
        : `This run doesn't replay to its own provenance hash (${shortHash(shared.hash)} saved, ${shortHash(replayed)} replayed), so something in it was changed.`,
  });
}

// Opens a showcase design straight away: it already passed every check, so no agent runs and nothing is spent.
export async function openShowcase(domain: string) {
  const res = await fetch(`/api/examples/${encodeURIComponent(domain)}`).catch(() => null);
  if (!res?.ok) return null;
  const { prompt, environment } = (await res.json()) as { prompt: string; environment: Environment };
  runner.replay(environment, 1, 0, []);
  store().set({
    environment,
    prompt,
    showcase: null,
    environmentKey: store().environmentKey + 1,
    report: null,
    appliedId: null,
    selected: null,
    refusal: null,
    steps: [],
    findings: [],
  });
  return environment;
}

/** Opens one verified design by the prompt it answers, as it was verified: no agents, no model calls. */
export async function openVerified(prompt: string) {
  const res = await fetch(`/api/verified?prompt=${encodeURIComponent(prompt)}`).catch(() => null);
  if (!res?.ok) {
    // No longer verified (the simulator changed under it): build it fresh instead
    return buildEnvironment(prompt);
  }
  const { environment } = (await res.json()) as { prompt: string; environment: Environment };
  runner.replay(environment, 1, 0, []);
  store().set({
    environment,
    prompt,
    showcase: null,
    environmentKey: store().environmentKey + 1,
    report: null,
    appliedId: null,
    selected: null,
    refusal: null,
    steps: [],
    findings: [],
  });
}

// The landing page's live hero: a showcase design running behind the page. It never becomes the user's system, so the landing
// stays up, and anything the user starts replaces it.
const heroDesigns = new Map<string, Environment>();
export async function showHero(domain: string) {
  let environment = heroDesigns.get(domain);
  if (!environment) {
    const res = await fetch(`/api/examples/${encodeURIComponent(domain)}`).catch(() => null);
    if (!res?.ok) return;
    environment = ((await res.json()) as { environment: Environment }).environment;
    heroDesigns.set(domain, environment);
  }
  // The user may have started something while the design loaded
  const s = store();
  if (s.building || (s.environment && !s.showcase)) return;
  runner.load(environment);
  s.set({ environment, showcase: domain as Environment['domain'], environmentKey: s.environmentKey + 1, selected: null });
}

// Opens a run from a shared link and checks it replays to the hash the link carries.
export async function openSharedRun() {
  if (!isSharedLink()) return;
  const live = liveIdOf();
  if (live) return live === useLive.getState().id ? undefined : joinLive(live);
  const id = savedIdOf();
  if (id) return openSavedRun(id);
  const shared = await decodeRun();
  if (!shared) {
    store().addMessage({ role: 'app', text: `This shared link couldn't be opened: it is damaged, or asks to replay more than ${MAX_SHARED_TICKS.toLocaleString('en-US')} ticks.` });
    return;
  }
  replayShared(shared, 'a shared run');
}

// A saved run comes from the server, which only hands it over to people allowed to see it.
export async function openSavedRun(id: string) {
  useAuth.setState({ locked: null, mySystems: false });
  const res = await authFetch(`/api/runs/${id}`).catch(() => null);
  if (!res?.ok) {
    const reason = res?.status === 401 ? 'sign-in' : res?.status === 403 ? 'private' : 'missing';
    useAuth.setState({ locked: { id, reason } });
    return;
  }
  const body = (await res.json()) as { run: SharedRun; name: string; ownerName: string | null; mine: boolean };
  if (!sane(body.run)) {
    store().addMessage({ role: 'app', text: 'This saved run is damaged and could not be replayed.' });
    return;
  }
  window.history.replaceState(null, '', savedRunLink(id));
  replayShared(body.run, body.mine ? 'your saved run' : `${body.ownerName ? `${body.ownerName}'s` : 'a'} saved run`);
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

// A draft is loaded so its view can draw it, but held still: it hasn't passed the checks, so nothing it does would mean anything yet.
function loadDraft(environment: Environment) {
  try {
    runner.load(environment);
  } catch {
    return; // A draft too broken to compile simply isn't drawn; the next round may be
  }
  runner.running = false;
  store().set({ environment, blueprint: true, environmentKey: store().environmentKey + 1, selected: null });
}

// Takes a draft off screen when the build ends without a design to run.
function dropBlueprint() {
  if (!store().blueprint) return;
  runner.clear();
  store().set({ environment: null, blueprint: false });
}

export async function buildEnvironment(prompt: string) {
  // A new request starts on an empty stage: the last design no longer sits behind the build
  if (useLive.getState().id) leaveLive();
  runner.clear();
  store().set({
    building: true,
    prompt,
    environment: null,
    stage: null,
    blueprint: false,
    showcase: null,
    entities: [],
    domainOdds: null,
    steps: [],
    findings: [],
    report: null,
    appliedId: null,
    refusal: null,
  });
  store().addMessage({ role: 'user', text: prompt });
  try {
    await stream('/api/build', { prompt }, (event) => {
      common(event);
      if (event.type === 'domain') store().set({ stage: event.domain });
      if (event.type === 'draft') loadDraft(event.environment);
      if (event.type === 'environment') {
        store().set({ entities: matchEntities(prompt, event.environment.spec), blueprint: false });
        loadEnvironment(event.environment);
      }
      if (event.type === 'refusal') {
        dropBlueprint();
        store().set({ refusal: event.refusal });
      }
      if (event.type === 'reply') reply(event.text);
    });
  } catch (error) {
    store().addMessage({ role: 'app', text: String(error) });
  }
  dropBlueprint();
  store().set({ building: false, stage: null });
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
  leaveLive();
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
  relayAgent({ type: 'said', text: message });
  store().set({ chatting: true });
  try {
    await stream('/api/chat', { environment, message, ...history, metrics: telemetry.stats }, (event) => {
      common(event);
      relayAgent(event);
      if (event.type !== 'reply') return;
      reply(event.text);
      const { action } = event;
      if (action.kind === 'patch') runner.applyPatches(action.patches);
      if (action.kind === 'rebuild') rebuildInPlace(action.environment, action.added ?? []);
      if (action.kind === 'inject') void breakThing(action.incident);
      if (action.kind === 'export') store().set({ exportOpen: true });
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
      relayAgent(e);
      if (e.type === 'recovery') store().set({ report: e.report, reportOpen: true });
    });
  } catch (error) {
    store().addMessage({ role: 'app', text: String(error) });
  }
  store().set({ recovering: false });
}

export function applyCandidate(candidate: Candidate) {
  runner.applyPatches(candidate.patches);
  relayAgent({ type: 'applied', id: candidate.id, title: candidate.title });
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
