import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { MAX_REPLAY_TICKS } from '@tv/core';
import { describe, expect, it, vi } from 'vitest';
import { flushRoomsForTests, forgetRoomsForTests, mountRooms } from '../src/rooms';

// Sessions are saved to a scratch file here, never the app's own.
process.env.ROOMS_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'rooms-')), 'rooms.json');
delete process.env.DATABASE_URL;
import { DEFAULT_SPEC } from './helpers';

const app = new Hono();
mountRooms(app);
const environment = { domain: 'warehouse', name: 'Live test', summary: 's', spec: DEFAULT_SPEC, unmodelled: [] };
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Reads server-sent messages from a live stream as they arrive.
function listen(res: Response) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const next = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const i = buffer.indexOf('\n\n');
      if (i >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const data = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) return JSON.parse(data);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += value;
    }
  };
  return { next, close: () => reader.cancel() };
}

describe('live rooms', () => {
  it('relays one person’s action to everyone else in the room, and keeps a shared clock', async () => {
    const started = await app.request('/api/rooms', json({ environment, seed: 1, tick: 30, events: [] }));
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };

    const ana = listen(await app.request(`/api/rooms/${id}/stream?client=ana-1&name=Ana`));
    const first = await ana.next();
    expect(first).toMatchObject({ type: 'snapshot', seed: 1, events: [] });
    expect((first.tick as number) >= 30).toBe(true);

    const ben = listen(await app.request(`/api/rooms/${id}/stream?client=ben-2&name=Ben`));
    expect(await ben.next()).toMatchObject({ type: 'snapshot' });
    expect(await ana.next()).toMatchObject({ type: 'presence', joined: { name: 'Ben' } });

    const event = { at: 42, incident: { type: 'block_conveyor', target: 'C1' } };
    expect((await app.request(`/api/rooms/${id}/events`, json({ client: 'ana-1', event }))).status).toBe(200);
    expect(await ben.next()).toMatchObject({ type: 'event', event, by: { name: 'Ana' } });

    expect((await app.request(`/api/rooms/${id}/transport`, json({ client: 'ben-2', running: false, speed: 2, tick: 50 }))).status).toBe(200);
    expect(await ana.next()).toMatchObject({ type: 'transport', running: false, speed: 2, by: { name: 'Ben' } });
    expect(await (await app.request(`/api/rooms/${id}/clock`)).json()).toEqual({ tick: 50, running: false, speed: 2 });

    // Someone who joins later starts from the whole log.
    const cleo = listen(await app.request(`/api/rooms/${id}/stream?client=cleo-3`));
    expect(await cleo.next()).toMatchObject({ type: 'snapshot', events: [event], tick: 50 });
    await Promise.all([ana.close(), ben.close(), cleo.close()]);
  });

  it('shares the agents’ work with everyone, including people who join later', async () => {
    const step = { type: 'step', id: 'architect-1', agent: 'architect', engine: 'gemini', title: 'Designing the environment', status: 'done' };
    const started = await app.request('/api/rooms', json({ environment, seed: 1, tick: 0, events: [], agents: [step] }));
    const { id } = (await started.json()) as { id: string };
    const ana = listen(await app.request(`/api/rooms/${id}/stream?client=ana-1&name=Ana`));
    expect(await ana.next()).toMatchObject({ type: 'snapshot', agents: [step] });
    const ben = listen(await app.request(`/api/rooms/${id}/stream?client=ben-2&name=Ben`));
    await ben.next();
    await ana.next();

    const recovery = { type: 'recovery', report: { incident: { type: 'block_conveyor', target: 'C1' }, candidates: [] } };
    expect((await app.request(`/api/rooms/${id}/agents`, json({ client: 'ana-1', event: recovery }))).status).toBe(200);
    expect(await ben.next()).toMatchObject({ type: 'agent', event: recovery, by: { name: 'Ana' } });
    expect((await app.request(`/api/rooms/${id}/agents`, json({ client: 'ana-1', event: { type: 'usage' } }))).status).toBe(400);

    const cleo = listen(await app.request(`/api/rooms/${id}/stream?client=cleo-3`));
    expect(await cleo.next()).toMatchObject({ type: 'snapshot', agents: [step, recovery] });
    await Promise.all([ana.close(), ben.close(), cleo.close()]);
  });

  it('comes back after a server restart with its whole history', async () => {
    const { id } = (await (await app.request('/api/rooms', json({ environment, seed: 7, tick: 10, events: [] }))).json()) as { id: string };
    const ana = listen(await app.request(`/api/rooms/${id}/stream?client=ana-1&name=Ana`));
    await ana.next();
    const event = { at: 12, incident: { type: 'fail_robot', target: 'R1' } };
    await app.request(`/api/rooms/${id}/events`, json({ client: 'ana-1', event }));
    await ana.close();
    await flushRoomsForTests();
    forgetRoomsForTests();

    const back = listen(await app.request(`/api/rooms/${id}/stream?client=ana-2&name=Ana`));
    expect(await back.next()).toMatchObject({ type: 'snapshot', seed: 7, events: [event] });
    await back.close();
  });

  it('refuses actions and clock changes stamped past what a screen can replay', async () => {
    expect((await app.request('/api/rooms', json({ environment, seed: 1, tick: MAX_REPLAY_TICKS + 1, events: [] }))).status).toBe(400);
    expect((await app.request('/api/rooms', json({ environment, seed: 1, tick: 10, events: [{ at: 1e12 }] }))).status).toBe(400);
    const { id } = (await (await app.request('/api/rooms', json({ environment, seed: 1, tick: 30, events: [] }))).json()) as { id: string };
    const ana = listen(await app.request(`/api/rooms/${id}/stream?client=ana-1&name=Ana`));
    await ana.next();
    const send = (event: unknown) => app.request(`/api/rooms/${id}/events`, json({ client: 'ana-1', event }));
    // A crafted far-future tick, and one past the replay limit, would send every screen chasing a tick it can't replay.
    expect((await send({ at: 1e12, incident: { type: 'surge', value: 5 } })).status).toBe(409);
    expect((await send({ at: MAX_REPLAY_TICKS + 1, incident: { type: 'surge', value: 5 } })).status).toBe(409);
    // A screen a few seconds ahead of the server, as clocks drift between re-syncs, is fine.
    expect((await send({ at: 60, incident: { type: 'surge', value: 2 } })).status).toBe(200);
    const transport = (tick: number) => app.request(`/api/rooms/${id}/transport`, json({ client: 'ana-1', running: true, speed: 16, tick }));
    expect((await transport(1e9)).status).toBe(409);
    expect((await (await app.request(`/api/rooms/${id}/clock`)).json()).tick).toBeLessThan(1000);
    expect((await transport(40)).status).toBe(200);
    await ana.close();
  });

  it('stops the clock while nobody is connected, and at the replay limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const clock = async (id: string) => ((await (await app.request(`/api/rooms/${id}/clock`)).json()) as { tick: number }).tick;
      const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
      const { id } = (await (await app.request('/api/rooms', json({ environment, seed: 1, tick: 100, events: [] }))).json()) as { id: string };
      // Nobody has opened it yet: an hour later it is still where it started.
      vi.setSystemTime(Date.now() + 3600_000);
      expect(await clock(id)).toBe(100);
      // Ana is in it for ten seconds at 1x: the warehouse runs ten ticks a second.
      const ana = listen(await app.request(`/api/rooms/${id}/stream?client=ana-1&name=Ana`));
      await ana.next();
      vi.setSystemTime(Date.now() + 10_000);
      expect(await clock(id)).toBe(200);
      await ana.close();
      await settle();
      // She leaves, and the session waits for her instead of running on all night.
      vi.setSystemTime(Date.now() + 8 * 3600_000);
      expect(await clock(id)).toBe(200);
      // Back for a long stretch: the clock stops at the replay limit, where every screen's run pauses too.
      const back = listen(await app.request(`/api/rooms/${id}/stream?client=ana-2&name=Ana`));
      const snapshot = await back.next();
      expect(snapshot.tick).toBe(200);
      vi.setSystemTime(Date.now() + 3 * 3600_000);
      expect(await clock(id)).toBe(MAX_REPLAY_TICKS);
      await back.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('only takes actions from people in the room, and says when a session has ended', async () => {
    const { id } = (await (await app.request('/api/rooms', json({ environment, seed: 1, tick: 0, events: [] }))).json()) as { id: string };
    expect((await app.request(`/api/rooms/${id}/events`, json({ client: 'stranger', event: { at: 1 } }))).status).toBe(403);
    expect((await app.request('/api/rooms/nosuchroom/stream?client=abcd')).status).toBe(404);
    expect((await app.request('/api/rooms', json({ environment: { domain: 'nope', name: 'x' }, seed: 1, tick: 0, events: [] }))).status).toBe(400);
  });
});
