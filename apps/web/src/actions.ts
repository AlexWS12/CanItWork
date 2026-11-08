import type { Candidate, Environment, Incident, ProviderStatus, StreamEvent } from '@tv/core';
import { matchEntities } from './entities';
import { runner } from './runner';
import { authFetch, useAuth } from './auth';
import { MAX_SHARED_TICKS, decodeRun, encodeRun, isSharedLink, runHash, sane, savedIdOf, savedRunLink, shortHash, type SharedRun } from './share';
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
      break;
    case 'findings':
      store().set({ findings: event.findings });
      break;
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
  store().set({ environment, environmentKey: store().environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null });
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

export type Visibility = 'public' | 'private' | 'people';

/** Saves the open run to the signed-in user's account and returns its short link. */
export async function saveRun(run: SharedRun, visibility: Visibility, people: string[]) {
  const res = await authFetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run, visibility, people }) });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? 'The run could not be saved');
  window.history.replaceState(null, '', savedRunLink(body.id));
  return { id: body.id, url: savedRunLink(body.id) };
}

function replayShared(shared: SharedRun, from: string) {
  runner.replay(shared.environment, shared.seed, shared.tick, shared.events);
  store().set({ environment: shared.environment, environmentKey: store().environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null });
  const replayed = runHash(shared.environment, shared.seed, shared.tick, shared.events);
  store().addMessage({
    role: 'app',
    text:
      replayed === shared.hash
        ? `Replayed ${from} exactly: ${shared.tick} ticks and ${shared.events.length} event${shared.events.length === 1 ? '' : 's'}. Its provenance hash ${shortHash(replayed)} matches.`
        : `This run doesn't replay to its own provenance hash (${shortHash(shared.hash)} saved, ${shortHash(replayed)} replayed), so something in it was changed.`,
  });
}

// Opens a run from a shared link and checks it replays to the hash the link carries.
export async function openSharedRun() {
  if (!isSharedLink()) return;
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
      if (action.kind === 'rebuild') loadEnvironment(action.environment);
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
