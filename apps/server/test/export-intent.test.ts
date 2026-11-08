import { DOMAINS, type Environment, type StreamEvent } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { chat } from '../src/agents';
import { asksForExport } from '../src/exportIntent';
import { isolateEnv } from './helpers';

describe('a chat message asking for the design as a file', () => {
  it('is recognised however it is phrased', () => {
    for (const m of [
      'export',
      'Export this as SQL',
      'please export the schema',
      'can you export it',
      'download the design',
      'Download',
      'give me the SQL',
      'send me the docker compose file',
      'I want a compose file',
      'I need the yaml',
      'generate the DDL',
      'save this as a .sql file',
      'turn it into docker compose',
      'convert my schema to SQL',
      'get me the postgres sql for this',
    ])
      expect(asksForExport(m), m).toBe(true);
  });

  it('is not confused with a part of the system or another request', () => {
    for (const m of [
      'kill the export service',
      'what if the export queue fills up?',
      'add an export worker',
      'export service goes down',
      'triple the traffic',
      'add a cache in front of the database',
      'what happens if the database goes down?',
      'is the SQL fast enough for 5 million rows?',
      'why is the compose service slow',
      'scale the download service to 5 replicas',
      'show me the slow SQL queries',
      'why do I get SQL errors under load?',
      'give me the slowest query in the SQL',
      'make the compose service faster',
      '',
    ])
      expect(asksForExport(m), m).toBe(false);
  });
});

describe('asking the chat for the design as a file', () => {
  isolateEnv();
  const collect = () => {
    const events: StreamEvent[] = [];
    return { events, emit: (e: StreamEvent) => void events.push(e) };
  };
  const ask = async (domain: 'database' | 'software' | 'electronics', prompt: string, message: string) => {
    const spec = DOMAINS[domain].rules.spec(prompt);
    const environment: Environment = { domain, name: 'n', summary: 's', spec, unmodelled: [] };
    const { events, emit } = collect();
    await chat({ environment, seed: 1, tick: 10, events: [], metrics: {}, message }, emit);
    return events;
  };

  it('opens the export for a database or a software system, settled by code', async () => {
    for (const [domain, prompt, message] of [
      ['database', 'a university database', 'export this as SQL'],
      ['software', 'a web app with a cache', 'give me the docker compose file'],
    ] as const) {
      const events = await ask(domain, prompt, message);
      const reply = events.find((e) => e.type === 'reply');
      expect(reply?.type === 'reply' && reply.action, domain).toEqual({ kind: 'export' });
      const step = events.find((e) => e.type === 'step' && e.status === 'done');
      expect(step?.type === 'step' && step.engine, domain).toBe('rules');
      expect(
        events.some((e) => e.type === 'usage'),
        domain,
      ).toBe(false);
    }
  });

  it('says plainly when a kind of system has no file format', async () => {
    const events = await ask('electronics', 'a blinking LED', 'export this');
    const reply = events.find((e) => e.type === 'reply');
    expect(reply?.type === 'reply' && reply.action).toEqual({ kind: 'none' });
    expect(reply?.type === 'reply' && reply.text).toContain('no file format');
  });
});
