import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Finding, StreamEvent } from '@tv/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build } from '../src/agents';
import { FINDINGS_VERSION, normalize, resetStale } from '../src/design-cache';
import { DEFAULT_SPEC, isolateEnv, json, mockFetch, openAiReply } from './helpers';

describe('verified design cache', () => {
  isolateEnv();
  let file = '';
  beforeEach(() => {
    file = path.join(mkdtempSync(path.join(tmpdir(), 'tv-cache-')), 'designs.json');
    process.env.DESIGN_CACHE = 'test';
    process.env.DESIGN_CACHE_FILE = file;
  });
  afterEach(() => {
    delete process.env.DESIGN_CACHE;
    delete process.env.DESIGN_CACHE_FILE;
    resetStale();
  });

  const collect = () => {
    const events: StreamEvent[] = [];
    return { events, emit: (e: StreamEvent) => void events.push(e) };
  };
  const draft = { name: 'Six robots', summary: 's', unmodelled: [], spec: { ...DEFAULT_SPEC, robots: 6 } };

  it('remembers a design that passed every check and rebuilds it with no model calls', async () => {
    process.env.GEMINI_API_KEY = 'g';
    const first = mockFetch((_url, init) =>
      String(init.body).includes('You route requests') ? json(openAiReply(JSON.stringify({ domain: 'warehouse', reason: 'r' }))) : json(openAiReply(JSON.stringify(draft))),
    );
    await build('A warehouse with six robots', collect().emit);
    expect(first.length).toBeGreaterThan(0);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['a warehouse with six robots']);

    const second = mockFetch(() => {
      throw new Error('no model should be called');
    });
    const { events, emit } = collect();
    await build('  a WAREHOUSE with six robots. ', emit);
    expect(second).toEqual([]);
    const environment = events.find((e) => e.type === 'environment');
    expect(environment?.type === 'environment' && (environment.environment.spec as { robots: number }).robots).toBe(6);
    expect(events.some((e) => e.type === 'step' && e.engine === 'cache' && e.status === 'done')).toBe(true);
  });

  it('reuses the tested claims stored with a cached design instead of simulating them again', async () => {
    const findings: Finding[] = [{ claim: 'The belt stops', incident: { type: 'node_down', target: 'belt' }, verdict: 'confirmed', evidence: 'Block conveyor: Conveyor C1' }];
    writeFileSync(file, JSON.stringify({ [normalize('A warehouse with six robots')]: { domain: 'warehouse', draft, findings, findingsVersion: FINDINGS_VERSION } }));
    const { events, emit } = collect();
    await build('A warehouse with six robots', emit);
    const event = events.find((e) => e.type === 'findings');
    expect(event?.type === 'findings' && event.findings).toEqual(findings);
    expect(events.some((e) => e.type === 'step' && e.title === 'Testing each claim')).toBe(false);
  });

  it('ignores a cached entry that no longer fits the schema and asks the Architect', async () => {
    process.env.GEMINI_API_KEY = 'g';
    writeFileSync(file, JSON.stringify({ [normalize('A warehouse with six robots')]: { domain: 'warehouse', draft: { name: 'x', spec: { robots: 'many' } } } }));
    const calls = mockFetch((_url, init) =>
      String(init.body).includes('You route requests') ? json(openAiReply(JSON.stringify({ domain: 'warehouse', reason: 'r' }))) : json(openAiReply(JSON.stringify(draft))),
    );
    const { events, emit } = collect();
    await build('A warehouse with six robots', emit);
    expect(calls.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'environment')).toBe(true);
  });

  it('sends a cached design that no longer passes the checks to the Architect, without spending repairs on it', async () => {
    process.env.GEMINI_API_KEY = 'g';
    // Parses fine, but the validator rejects it: a wire goes to a pin the LED doesn't have.
    const broken = {
      name: 'Old circuit',
      summary: 's',
      unmodelled: [],
      spec: {
        parts: [
          { id: 'B1', type: 'battery', volts: 9 },
          { id: 'D1', type: 'led' },
        ],
        wires: [{ from: 'B1.pos', to: 'D1.nope' }],
        drive: [],
      },
    };
    writeFileSync(file, JSON.stringify({ [normalize('A warehouse with six robots')]: { domain: 'electronics', draft: broken } }));
    const features: string[] = [];
    mockFetch((_url, init) => {
      const body = String(init.body);
      features.push(body.includes('You route requests') ? 'interpreter' : body.includes('previous design') ? 'repair' : 'architect');
      return body.includes('You route requests') ? json(openAiReply(JSON.stringify({ domain: 'warehouse', reason: 'r' }))) : json(openAiReply(JSON.stringify(draft)));
    });
    const { events, emit } = collect();
    await build('A warehouse with six robots', emit);
    expect(events.some((e) => e.type === 'step' && e.engine === 'cache')).toBe(false);
    expect(features).toEqual(['interpreter', 'architect']);
    const environment = events.find((e) => e.type === 'environment');
    expect(environment?.type === 'environment' && (environment.environment.spec as { robots: number }).robots).toBe(6);
  });

  it('is off in tests unless asked for, and off everywhere with DESIGN_CACHE=off', async () => {
    process.env.DESIGN_CACHE = 'off';
    writeFileSync(file, JSON.stringify({ [normalize('A warehouse')]: { domain: 'warehouse', draft } }));
    const { events, emit } = collect();
    await build('A warehouse', emit);
    expect(events.some((e) => e.type === 'step' && e.engine === 'cache')).toBe(false);
  });
});
