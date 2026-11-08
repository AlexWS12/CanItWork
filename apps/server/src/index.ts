import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from 'dotenv';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { StreamEvent } from '@tv/core';
import { build, chat, describeFailure, edit, explain, recover, servedFromCache, type Emit } from './agents';
import { authConfig } from './auth';
import { showcase } from './design-cache';
import { admit } from './integrations/limit';
import { hasGemini, pruneBypass } from './llm';
import { mountRooms } from './rooms';
import { mountRuns, storageKind } from './runs';
import { summary } from './spend';
import { checkedStatus, providerStatus } from './status';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../../../.env');
config({ path: envFile, override: true });

const app = new Hono();

app.use('/api/*', async (_, next) => {
  config({ path: envFile, override: true });
  await next();
});

app.get('/api/status', async (c) => c.json(await checkedStatus(300)));

app.get('/api/examples', (c) => c.json({ examples: showcase() }));

app.get('/api/spend', (c) => c.json(summary(pruneBypass())));

// What the browser needs to start Auth0 sign-in; none of it is secret. Without a tenant, sign-in stays hidden.
app.get('/api/auth/config', (c) => {
  const config = authConfig();
  return c.json(config ? { enabled: true, ...config, storage: storageKind() } : { enabled: false });
});

mountRuns(app);
mountRooms(app);

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

// Stops a visitor over their hourly allowance before anything is spent, with a message the app shows like any other error.
// Someone who could get through by signing in is told so, and the app offers the button.
const limited = async (c: Context, asRefusal = false) => {
  const refused = await admit(c);
  if (!refused) return null;
  const { message, signIn } = refused;
  const flag = signIn ? { signIn } : {};
  return agentStream(async (emit) => emit(asRefusal ? { type: 'refusal', refusal: { reason: message, closest: null, ...flag } } : { type: 'error', message, ...flag }))(c);
};

app.post('/api/build', async (c) => {
  const { prompt } = await c.req.json<{ prompt: string }>();
  // A verified-cache hit costs nothing, so it never counts against the allowance.
  const blocked = servedFromCache(prompt) ? null : await limited(c, true);
  return blocked ?? agentStream((emit) => build(prompt, emit))(c);
});

app.post('/api/recover', async (c) => {
  const input = await c.req.json();
  return (await limited(c)) ?? agentStream((emit) => recover(input, emit))(c);
});

// Part of every build, so it never counts against the allowance; it is one small call and skips itself without Gemini.
app.post('/api/explain', async (c) => {
  const input = await c.req.json();
  return agentStream((emit) => explain(input, emit))(c);
});

app.post('/api/chat', async (c) => {
  const input = await c.req.json();
  return (await limited(c)) ?? agentStream((emit) => chat(input, emit))(c);
});

// A delete or duplicate from the 3D view. Without Gemini it runs only the validator and simulator, so it never counts.
app.post('/api/edit', async (c) => {
  const input = await c.req.json();
  return (hasGemini() ? await limited(c) : null) ?? agentStream((emit) => edit(input, emit))(c);
});

app.use('/*', serveStatic({ root: path.relative(process.cwd(), path.resolve(here, '../../web/dist')) || '.' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`Server on :${port}`, providerStatus());
