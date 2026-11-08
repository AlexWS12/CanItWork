import type { Environment, Incident, StreamEvent, TimedEvent } from '@tv/core';
import { create } from 'zustand';
import { authFetch } from './auth';
import { runner } from './runner';
import { useStore } from './store';

// Live sessions: everyone in a room sees the same run. Each action taken here goes to the room; actions from others are
// replayed into this screen's run at their tick. Simulators are deterministic, so every screen lands on the same state.

export interface Member {
  client: string;
  name: string;
  picture?: string;
  color: string;
}

type Message =
  | {
      type: 'snapshot';
      environment: Environment;
      seed: number;
      events: TimedEvent[];
      tick: number;
      running: boolean;
      speed: number;
      members: Member[];
      agents: AgentEvent[];
    }
  | { type: 'event'; event: TimedEvent; by: Member }
  | { type: 'transport'; running: boolean; speed: number; tick: number; by: Member }
  | { type: 'presence'; members: Member[]; joined?: Member; left?: Member }
  | { type: 'agent'; event: AgentEvent; by: Member };

/** Agent work relayed between screens: the stream events the server sends, plus what a person said and which fix they applied. */
export type AgentEvent = StreamEvent | { type: 'said'; text: string } | { type: 'applied'; id: string; title: string };

interface LiveState {
  id: string | null;
  members: Member[];
  status: 'idle' | 'connecting' | 'live' | 'ended';
}

export const useLive = create<LiveState>(() => ({ id: null, members: [], status: 'idle' }));

export const client = crypto.randomUUID();
const LIVE = '#live=';
export const liveLink = (id: string) => `${location.origin}${location.pathname}${LIVE}${id}`;
export const liveIdOf = (hash = location.hash) => (hash.startsWith(LIVE) ? hash.slice(LIVE.length).replace(/[^a-z0-9]/g, '') : null);

let room: { environment: Environment; seed: number; events: TimedEvent[] } | null = null;
let abort: AbortController | null = null;

const note = (text: string) => useStore.getState().addMessage({ role: 'app', text });

// "Ana cut the link from Pump 2 to Tower A", from the action alone.
export function describe(event: TimedEvent) {
  if (!('incident' in event)) return 'applied a fix';
  const { type, target, value } = event.incident as Incident & { value?: number };
  const what = target ? target.replace('->', ' → ') : '';
  switch (type) {
    case 'set_reading':
      return value === 1 || value === 0 ? `switched ${what} ${value ? 'on' : 'off'}` : `set ${what} to ${value}`;
    case 'recover':
      return what ? `brought ${what} back` : 'ended the surge';
    case 'surge':
      return `started a surge (×${value ?? 2})`;
    case 'node_down':
      return `took ${what} down`;
    case 'unit_down':
      return `failed one unit of ${what}`;
    case 'node_slow':
      return `slowed ${what}`;
    case 'link_down':
      return `cut ${what}`;
    case 'burn_part':
      return `burned out ${what}`;
    case 'short_part':
      return `shorted ${what}`;
    case 'loose_wire':
      return `pulled ${what} loose`;
    case 'low_supply':
      return `ran ${what} down to ${value} V`;
    case 'sensor_fault':
      return `jammed sensor ${what}`;
    case 'fail_robot':
      return `took robot ${what} out of service`;
    case 'block_conveyor':
      return `blocked conveyor ${what}`;
    case 'offline_charger':
      return `took charger ${what} offline`;
    case 'lose_unit':
      return `lost unit ${what}`;
    case 'jam_comms':
      return 'jammed the radio';
    case 'wind':
      return 'brought in a strong wind';
    case 'charger_down':
      return `took charger ${what} down`;
    case 'new_targets':
      return 'added new targets';
    case 'traffic_spike':
      return `sent a traffic spike (×${value ?? 2})`;
    case 'cut_link':
      return `cut the link ${what}`;
    case 'cache_flush':
      return `flushed the cache ${what}`.trim();
    case 'zone_down':
      return `took zone ${what} down`;
    case 'drop_index':
      return `dropped the index ${what}`;
    case 'drop_column':
      return `dropped the column ${what}`;
    case 'lock_table':
      return `locked table ${what}`;
    case 'row_surge':
    case 'workload_spike':
      return `sent a workload spike${what ? ` to ${what}` : ''}`;
    case 'hot_partition':
      return `made ${what} a hot partition`;
    default:
      return `${type.replace(/_/g, ' ')}${what ? ` ${what}` : ''}`;
  }
}

// Shows agent work that ran on someone else's screen as if it had run here: the same trace, findings, recovery card and replies.
function showAgent(event: AgentEvent, by: Member | null) {
  const store = useStore.getState();
  switch (event.type) {
    case 'step':
      store.addStep(event);
      break;
    case 'findings':
      store.set({ findings: event.findings });
      break;
    case 'recovery':
      store.set({ report: event.report, reportOpen: true, appliedId: null, tab: 'agents' });
      break;
    case 'reply': {
      const last = store.steps[store.steps.length - 1];
      store.addMessage({ role: 'app', text: event.text, ...(last ? { source: { agent: last.agent, engine: last.engine } } : {}) });
      break;
    }
    case 'error':
      store.addMessage({ role: 'app', text: event.message });
      break;
    case 'said':
      store.addMessage({ role: 'user', text: by ? `${by.name}: ${event.text}` : event.text });
      break;
    case 'applied':
      store.set({ appliedId: event.id, reportOpen: false });
      store.addMessage({ role: 'app', text: `${by?.name ?? 'Someone'} applied: ${event.title}.` });
      break;
  }
}

/** Relays agent work that ran on this screen to everyone else in the live session. */
export function relayAgent(event: AgentEvent) {
  if (!useLive.getState().id || event.type === 'usage' || event.type === 'done') return;
  void post('agents', { event });
}

async function post(path: string, body: unknown) {
  const id = useLive.getState().id;
  if (!id) return;
  await authFetch(`/api/rooms/${id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client, ...(body as object) }) }).catch(
    () => undefined,
  );
}

function listen() {
  runner.onLocal = (event) => {
    if (!room) return;
    room.events.push(event);
    void post('events', { event });
  };
  runner.onTransport = (running, speed, tick) => void post('transport', { running, speed, tick });
}

function handle(message: Message) {
  switch (message.type) {
    case 'snapshot': {
      room = { environment: message.environment, seed: message.seed, events: [...message.events] };
      const last = Math.max(0, ...message.events.map((e) => e.at + 1));
      runner.replay(message.environment, message.seed, Math.max(message.tick, last), message.events);
      runner.setTransport(message.running, message.speed);
      useStore
        .getState()
        .set({ environment: message.environment, environmentKey: useStore.getState().environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null });
      useLive.setState({ members: message.members, status: 'live' });
      const others = message.members.filter((m) => m.client !== client);
      // Someone joining late sees the agents' work so far; the person who started the session already has it.
      if (others.length) {
        useStore.getState().set({ steps: [], findings: [] });
        for (const event of message.agents) showAgent(event, null);
      }
      note(
        others.length
          ? `Joined the live session with ${others.map((m) => m.name).join(', ')}.`
          : 'Live session started. Share the invite link and everyone who joins sees this run and every change.',
      );
      break;
    }
    case 'event':
      if (!room) return;
      room.events.push(message.event);
      runner.catchUp(room.environment, room.seed, room.events, message.event.at + 1);
      // A fix is announced by the agent event that comes with it ("Ana applied: ..."), so only breaks and flips get a note here.
      if ('patches' in message.event) useStore.getState().bumpStructure();
      else note(`${message.by.name} ${describe(message.event)}.`);
      break;
    case 'agent':
      showAgent(message.event, message.by);
      break;
    case 'transport': {
      runner.setTransport(message.running, message.speed);
      // A clock that drifted more than a couple of seconds behind jumps to where the others are.
      const perSecond = runner.domain?.ticksPerSecond ?? 10;
      if (room && message.tick - (runner.run?.tick ?? 0) > perSecond * 2) runner.catchUp(room.environment, room.seed, room.events, message.tick);
      note(`${message.by.name} ${message.running ? `played the run at ${message.speed}x` : 'paused the run'}.`);
      break;
    }
    case 'presence':
      useLive.setState({ members: message.members });
      if (message.joined) note(`${message.joined.name} joined the live session.`);
      if (message.left) note(`${message.left.name} left the live session.`);
      break;
  }
}

async function connect(id: string, attempt = 0): Promise<void> {
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  try {
    const res = await authFetch(`/api/rooms/${id}/stream?client=${client}`, { signal });
    if (res.status === 404) {
      useLive.setState({ status: 'ended' });
      note('This live session has ended. Its run stays open here.');
      return;
    }
    if (!res.ok || !res.body) throw new Error(`Server replied ${res.status}`);
    attempt = 0;
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
        if (data) handle(JSON.parse(data) as Message);
      }
    }
  } catch {
    if (signal.aborted) return;
  }
  // The stream dropped while still in the session: try again a few times.
  if (!signal.aborted && useLive.getState().id === id && attempt < 5) {
    useLive.setState({ status: 'connecting' });
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    if (useLive.getState().id === id) return connect(id, attempt + 1);
  }
}

// A hidden tab barely runs its clock, so on coming back into view, and every ten seconds, a screen more than two seconds
// behind the session jumps to where everyone else is. The action history is the same either way; this keeps the moment the same too.
async function resync() {
  const id = useLive.getState().id;
  if (!id || !room || document.hidden) return;
  const res = await fetch(`/api/rooms/${id}/clock`).catch(() => null);
  if (!res?.ok) return;
  const clock = (await res.json()) as { tick: number; running: boolean; speed: number };
  const perSecond = runner.domain?.ticksPerSecond ?? 10;
  if (clock.tick - (runner.run?.tick ?? 0) > perSecond * 2) runner.catchUp(room.environment, room.seed, room.events, clock.tick);
}
let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => void resync();

export async function joinLive(id: string) {
  useLive.setState({ id, status: 'connecting', members: [] });
  window.history.replaceState(null, '', liveLink(id));
  listen();
  if (!timer) {
    timer = setInterval(() => void resync(), 10_000);
    document.addEventListener('visibilitychange', onVisible);
  }
  await connect(id);
}

/** Starts a live session around the open run and joins it. */
export async function startLive() {
  const environment = useStore.getState().environment;
  const history = runner.history();
  if (!environment || !history) return null;
  // The build's trace and the Red Team's findings come along, so people who join see what the agents already did.
  const { steps, findings } = useStore.getState();
  const agents: AgentEvent[] = [...steps, ...(findings.length ? [{ type: 'findings', findings } as AgentEvent] : [])];
  const res = await authFetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environment, ...history, agents }) });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? 'The live session could not start');
  void joinLive(body.id);
  return liveLink(body.id);
}

export function leaveLive() {
  abort?.abort();
  abort = null;
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
  room = null;
  runner.onLocal = null;
  runner.onTransport = null;
  if (useLive.getState().id) note('You left the live session. The run stays open here.');
  useLive.setState({ id: null, members: [], status: 'idle' });
  if (liveIdOf()) window.history.replaceState(null, '', `${location.pathname}${location.search}`);
}
