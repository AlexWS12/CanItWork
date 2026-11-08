import { randomBytes } from 'node:crypto';
import { DOMAINS, type Environment, type TimedEvent } from '@tv/core';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { userFrom } from './auth';

// Live sessions. Simulators are deterministic, so people working on one system together only need to share its action log:
// breaks, fixes, switch flips, play and pause. The room relays each action to everyone; each browser replays the log, with
// the new action at its tick, and lands on exactly the same state. Nothing about the 3D scene itself is sent.

export interface Member {
  client: string;
  name: string;
  picture?: string;
  color: string;
}

type Message =
  | { type: 'snapshot'; environment: Environment; seed: number; events: TimedEvent[]; tick: number; running: boolean; speed: number; members: Member[]; agents: AgentEvent[] }
  | { type: 'event'; event: TimedEvent; by: Member }
  | { type: 'transport'; running: boolean; speed: number; tick: number; by: Member }
  | { type: 'presence'; members: Member[]; joined?: Member; left?: Member }
  | { type: 'agent'; event: AgentEvent; by: Member };

/** What the agents did, relayed from whoever's screen ran them: steps, Red Team findings, the Recovery Council's report, chat. */
type AgentEvent = { type: string } & Record<string, unknown>;

interface Room {
  id: string;
  environment: Environment;
  seed: number;
  events: TimedEvent[];
  // Where the clock stood when it last changed, so someone joining starts at the tick everyone else is on.
  anchor: { tick: number; at: number; running: boolean; speed: number };
  members: Map<string, Member>;
  listeners: Map<string, (message: Message) => void>;
  // The agents' work so far, so someone joining late sees the same trace, findings and recovery as everyone else.
  agents: AgentEvent[];
  touched: number;
}

const rooms = new Map<string, Room>();
const COLORS = ['#f59e0b', '#22d3ee', '#a78bfa', '#34d399', '#f472b6', '#60a5fa', '#fb7185', '#facc15'];
const MAX_EVENTS = 2000;
const MAX_AGENT_EVENTS = 400;
const AGENT_TYPES = new Set(['step', 'findings', 'recovery', 'reply', 'error', 'said', 'applied']);
const IDLE_MS = 6 * 60 * 60 * 1000;

const tickOf = (room: Room) => {
  const { tick, at, running, speed } = room.anchor;
  if (!running) return tick;
  const perSecond = DOMAINS[room.environment.domain]?.ticksPerSecond ?? 10;
  return Math.floor(tick + ((Date.now() - at) / 1000) * perSecond * speed);
};

const broadcast = (room: Room, message: Message, except?: string) => {
  room.touched = Date.now();
  for (const [client, send] of room.listeners) if (client !== except) send(message);
};

function sweep() {
  for (const [id, room] of rooms) if (!room.listeners.size && Date.now() - room.touched > IDLE_MS) rooms.delete(id);
}

const roomId = () => {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('');
};

const Start = z.object({
  environment: z.object({ domain: z.string(), name: z.string() }).passthrough(),
  seed: z.number(),
  tick: z.number().min(0),
  events: z.array(z.object({ at: z.number() }).passthrough()).max(MAX_EVENTS),
  agents: z
    .array(z.object({ type: z.string() }).passthrough())
    .max(MAX_AGENT_EVENTS)
    .default([]),
});
const AgentBody = z.object({ client: z.string().min(4).max(40), event: z.object({ type: z.string() }).passthrough() });
const EventBody = z.object({ client: z.string().min(4).max(40), event: z.object({ at: z.number().min(0) }).passthrough() });
const TransportBody = z.object({ client: z.string().min(4).max(40), running: z.boolean(), speed: z.number().min(0.1).max(16), tick: z.number().min(0) });

// Signed-in people appear by their Auth0 name and picture; everyone else as a numbered guest.
async function memberFor(c: Context, room: Room, client: string): Promise<Member> {
  const known = room.members.get(client);
  if (known) return known;
  const user = await userFrom(c.req.header('authorization'));
  const color = COLORS[room.members.size % COLORS.length];
  const guest = (c.req.query('name') ?? '').trim().slice(0, 40);
  // An email sign-up's name is its address; the part before the @ reads better beside a face.
  const name = user ? (user.name ?? user.email ?? '').split('@')[0] || 'Someone' : guest || `Guest ${room.members.size + 1}`;
  return { client, name, ...(user?.picture ? { picture: user.picture } : {}), color };
}

export const roomCount = () => rooms.size;

export function mountRooms(app: Hono) {
  app.post('/api/rooms', async (c) => {
    sweep();
    const text = await c.req.text();
    if (text.length > 1_000_000) return c.json({ error: 'This run is too large for a live session' }, 413);
    const parsed = Start.safeParse(JSON.parse(text || '{}'));
    if (!parsed.success || !(parsed.data.environment.domain in DOMAINS)) return c.json({ error: 'That is not a run' }, 400);
    const { environment, seed, tick, events, agents } = parsed.data;
    const id = roomId();
    rooms.set(id, {
      id,
      environment: environment as unknown as Environment,
      seed,
      events: events as unknown as TimedEvent[],
      anchor: { tick, at: Date.now(), running: true, speed: 1 },
      members: new Map(),
      listeners: new Map(),
      agents: agents.filter((a) => AGENT_TYPES.has(a.type)) as AgentEvent[],
      touched: Date.now(),
    });
    return c.json({ id }, 201);
  });

  app.get('/api/rooms/:id/stream', async (c) => {
    const room = rooms.get(c.req.param('id'));
    if (!room) return c.json({ error: 'This live session has ended' }, 404);
    const client = (c.req.query('client') ?? '').slice(0, 40);
    if (client.length < 4) return c.json({ error: 'Missing client id' }, 400);
    const member = await memberFor(c, room, client);
    return streamSSE(c, async (stream) => {
      const queue: Message[] = [];
      let wake: (() => void) | null = null;
      let open = true;
      room.listeners.set(client, (message) => {
        queue.push(message);
        wake?.();
      });
      room.members.set(client, member);
      const { running, speed } = room.anchor;
      queue.push({
        type: 'snapshot',
        environment: room.environment,
        seed: room.seed,
        events: room.events,
        tick: tickOf(room),
        running,
        speed,
        members: [...room.members.values()],
        agents: room.agents,
      });
      broadcast(room, { type: 'presence', members: [...room.members.values()], joined: member }, client);
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      // A comment every 20 seconds keeps proxies from closing a quiet stream.
      const ping = setInterval(() => void stream.write(': ping\n\n').catch(() => undefined), 20_000);
      try {
        while (open) {
          while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        clearInterval(ping);
        room.listeners.delete(client);
        room.members.delete(client);
        broadcast(room, { type: 'presence', members: [...room.members.values()], left: member });
      }
    });
  });

  // Where the session's clock stands now, so a screen that fell behind (a hidden tab, a slow laptop) can catch up.
  app.get('/api/rooms/:id/clock', (c) => {
    const room = rooms.get(c.req.param('id'));
    if (!room) return c.json({ error: 'This live session has ended' }, 404);
    return c.json({ tick: tickOf(room), running: room.anchor.running, speed: room.anchor.speed });
  });

  app.post('/api/rooms/:id/events', async (c) => {
    const room = rooms.get(c.req.param('id'));
    if (!room) return c.json({ error: 'This live session has ended' }, 404);
    const parsed = EventBody.safeParse(await c.req.json().catch(() => ({})));
    const by = parsed.success ? room.members.get(parsed.data.client) : undefined;
    if (!parsed.success || !by) return c.json({ error: 'Join the session first' }, 403);
    if (room.events.length >= MAX_EVENTS) return c.json({ error: 'This session has reached its limit of actions' }, 409);
    const event = parsed.data.event as unknown as TimedEvent;
    room.events.push(event);
    broadcast(room, { type: 'event', event, by }, by.client);
    return c.json({ ok: true });
  });

  // One person's agents ran (a break they made, a question they asked); everyone else sees the same steps and results.
  app.post('/api/rooms/:id/agents', async (c) => {
    const room = rooms.get(c.req.param('id'));
    if (!room) return c.json({ error: 'This live session has ended' }, 404);
    const text = await c.req.text();
    if (text.length > 200_000) return c.json({ error: 'Too large to relay' }, 413);
    const parsed = AgentBody.safeParse(JSON.parse(text || '{}'));
    const by = parsed.success ? room.members.get(parsed.data.client) : undefined;
    if (!parsed.success || !by) return c.json({ error: 'Join the session first' }, 403);
    const event = parsed.data.event as AgentEvent;
    if (!AGENT_TYPES.has(event.type)) return c.json({ error: 'Not an agent event' }, 400);
    room.agents.push(event);
    if (room.agents.length > MAX_AGENT_EVENTS) room.agents.splice(0, room.agents.length - MAX_AGENT_EVENTS);
    broadcast(room, { type: 'agent', event, by }, by.client);
    return c.json({ ok: true });
  });

  app.post('/api/rooms/:id/transport', async (c) => {
    const room = rooms.get(c.req.param('id'));
    if (!room) return c.json({ error: 'This live session has ended' }, 404);
    const parsed = TransportBody.safeParse(await c.req.json().catch(() => ({})));
    const by = parsed.success ? room.members.get(parsed.data.client) : undefined;
    if (!parsed.success || !by) return c.json({ error: 'Join the session first' }, 403);
    const { running, speed, tick } = parsed.data;
    room.anchor = { tick, at: Date.now(), running, speed };
    broadcast(room, { type: 'transport', running, speed, tick, by }, by.client);
    return c.json({ ok: true });
  });
}
