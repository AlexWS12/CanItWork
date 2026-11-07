import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from 'dotenv';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { StreamEvent } from '@tv/core';
import { build, chat, describeFailure, recover, type Emit } from './agents';
import { providerStatus } from './llm';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../../../.env');
config({ path: envFile, override: true });

const app = new Hono();

app.use('/api/*', async (_, next) => {
  config({ path: envFile, override: true });
  await next();
});

app.get('/api/status', (c) => c.json(providerStatus()));

function agentStream(run: (emit: Emit) => Promise<void>) {
  return (c: Context) =>
    streamSSE(c, async (stream) => {
      const queue: StreamEvent[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const emit: Emit = (event) => {
        queue.push(event);
        wake?.();
      };
      run(emit)
        .catch((error) => emit({ type: 'error', message: describeFailure(error) }))
        .finally(() => {
          emit({ type: 'done' });
          finished = true;
          wake?.();
        });
      for (;;) {
        while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
        if (finished) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    });
}

app.post('/api/build', async (c) => {
  const { prompt } = await c.req.json<{ prompt: string }>();
  return agentStream((emit) => build(prompt, emit))(c);
});

app.post('/api/recover', async (c) => {
  const input = await c.req.json();
  return agentStream((emit) => recover(input, emit))(c);
});

app.post('/api/chat', async (c) => {
  const input = await c.req.json();
  return agentStream((emit) => chat(input, emit))(c);
});

app.use('/*', serveStatic({ root: path.relative(process.cwd(), path.resolve(here, '../../web/dist')) || '.' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`Server on :${port}`, providerStatus());
