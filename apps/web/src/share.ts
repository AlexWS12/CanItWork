import { DOMAINS, MAX_REPLAY_TICKS, evaluate, provenanceHash, type Environment, type TimedEvent } from '@tv/core';

// A run fits in a link: the environment, seed and event log, deflated into the URL hash. Simulators are deterministic,
// so whoever opens it replays exactly the same run, and the provenance hash shows whether anything in the link was edited.

export interface SharedRun {
  environment: Environment;
  seed: number;
  tick: number;
  events: TimedEvent[];
  hash: string;
}

const PREFIX = '#run=';
// Replaying runs on the page's main thread, so a link can't ask for more than this; a crafted one could otherwise freeze the tab.
// Runs pause when they reach it (see runner.ts), so every run on screen fits in a link.
export const MAX_SHARED_TICKS = MAX_REPLAY_TICKS;
const MAX_SHARED_EVENTS = 2_000;

const toBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string) => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

async function squeeze(bytes: Uint8Array, mode: 'compress' | 'decompress') {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(mode === 'compress' ? new CompressionStream('deflate-raw') : new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The hash covers the environment, the scenario and the result of replaying it, so it changes if any of them do.
export function runHash(environment: Environment, seed: number, tick: number, events: TimedEvent[]) {
  const domain = DOMAINS[environment.domain];
  const scenario = { seed, ticks: tick, events };
  return provenanceHash(environment, scenario, evaluate(domain, domain.compile(environment.spec), scenario));
}

export async function encodeRun(run: Omit<SharedRun, 'hash'>): Promise<{ url: string; hash: string }> {
  const hash = runHash(run.environment, run.seed, run.tick, run.events);
  const packed = await squeeze(new TextEncoder().encode(JSON.stringify({ ...run, hash })), 'compress');
  const url = `${location.origin}${location.pathname}${PREFIX}${toBase64Url(packed)}`;
  return { url, hash };
}

export async function decodeRun(hash = location.hash): Promise<SharedRun | null> {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const bytes = await squeeze(fromBase64Url(hash.slice(PREFIX.length)), 'decompress');
    const run = JSON.parse(new TextDecoder().decode(bytes)) as SharedRun;
    return sane(run) ? run : null;
  } catch {
    return null;
  }
}

export const shortHash = (hash: string) => hash.slice(0, 12);

// A saved run's link is just its id; the run lives on the server, which decides who may open it.
const SAVED = '#s=';
export const savedRunLink = (id: string) => `${location.origin}${location.pathname}${SAVED}${id}`;
export const savedIdOf = (hash = location.hash) => (hash.startsWith(SAVED) ? hash.slice(SAVED.length).replace(/[^A-Za-z0-9]/g, '') : null);

export const isSharedLink = (hash = location.hash) => hash.startsWith(PREFIX) || hash.startsWith(SAVED) || hash.startsWith('#live=');

export function sane(run: SharedRun | null | undefined): run is SharedRun {
  return Boolean(
    run &&
    Number.isInteger(run.tick) &&
    run.tick >= 0 &&
    run.tick <= MAX_SHARED_TICKS &&
    Array.isArray(run.events) &&
    run.events.length <= MAX_SHARED_EVENTS &&
    run.environment?.domain in DOMAINS,
  );
}
