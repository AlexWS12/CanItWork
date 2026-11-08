import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mountRooms } from '../src/rooms';
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

  it('only takes actions from people in the room, and says when a session has ended', async () => {
    const { id } = (await (await app.request('/api/rooms', json({ environment, seed: 1, tick: 0, events: [] }))).json()) as { id: string };
    expect((await app.request(`/api/rooms/${id}/events`, json({ client: 'stranger', event: { at: 1 } }))).status).toBe(403);
    expect((await app.request('/api/rooms/nosuchroom/stream?client=abcd')).status).toBe(404);
    expect((await app.request('/api/rooms', json({ environment: { domain: 'nope', name: 'x' }, seed: 1, tick: 0, events: [] }))).status).toBe(400);
  });
});
