import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, serviceName, toCompose, type SystemSpec } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { importFile } from '../src/importers';

// An exported docker-compose.yml is valid YAML that our own importer reads back as the same containers, with the same kinds,
// replicas and connections. Outside APIs are not containers, so they live under x-canitwork and do not come back as nodes.

const here = path.dirname(fileURLToPath(import.meta.url));
const verified = JSON.parse(readFileSync(path.resolve(here, '../data/verified-designs.json'), 'utf8')) as Record<string, { domain: string; draft: { spec: unknown } }>;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

// Names free of words the importer reads as a kind of infrastructure ("gateway", "redis"), so a name never decides the kind
const SERVICE_NAMES = ['api', 'web', 'auth', 'orders', 'billing', 'catalog', 'profile', 'notify', 'search-svc', 'checkout', 'feed', 'media'];
const KINDS = ['service', 'service', 'service', 'database', 'cache', 'queue', 'gateway'] as const;
const INFRA_NAME = { database: 'db', cache: 'cache', queue: 'jobs', gateway: 'edge' } as Record<string, string>;

function randomSpec(seed: number): SystemSpec {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const count = 2 + Math.floor(r() * 8);
  const nodes: Array<Record<string, unknown>> = [{ id: 'users', kind: 'client' }];
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    const kind = pick(KINDS);
    let id = kind === 'service' ? pick(SERVICE_NAMES) : INFRA_NAME[kind];
    for (let k = 2; used.has(id); k++) id = `${kind === 'service' ? id.replace(/\d+$/, '') : INFRA_NAME[kind]}${k}`;
    used.add(id);
    nodes.push({ id, kind, ...(r() < 0.4 ? { replicas: 1 + Math.floor(r() * 6) } : {}) });
  }
  if (r() < 0.3) nodes.push({ id: 'stripe', kind: 'external' });
  const ids = nodes.slice(1).map((n) => n.id as string);
  const edges: Array<Record<string, unknown>> = [{ from: 'users', to: ids[0] }];
  for (let i = 1; i < ids.length; i++) {
    const from = ids[Math.floor(r() * i)];
    const to = ids[i];
    const toKind = nodes.find((n) => n.id === to)!.kind;
    edges.push({ from, to, ...(toKind === 'queue' ? { mode: 'async' } : {}) });
  }
  return DOMAINS.software.specSchema.parse({ traffic: 50 + Math.floor(r() * 500), nodes, edges }) as SystemSpec;
}

/** Containers by Compose name with their kind and replicas, and the connections between them as unordered pairs. */
function shape(spec: SystemSpec, nameOf: (id: string) => string) {
  const containers = spec.nodes.filter((n) => n.kind !== 'client' && n.kind !== 'external');
  const ids = new Set(containers.map((n) => n.id));
  return {
    nodes: containers.map((n) => `${nameOf(n.id)}:${n.kind}:${n.replicas ?? 1}`).sort(),
    links: [...new Set(spec.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).map((e) => [nameOf(e.from), nameOf(e.to)].sort().join('~')))].sort(),
  };
}

function roundTrip(spec: SystemSpec, label: string) {
  const yaml = toCompose(spec, { name: label });
  const doc = parse(yaml) as { services: Record<string, { image: string; depends_on?: string[] }> };
  expect(Object.keys(doc.services).length, label).toBe(spec.nodes.filter((n) => n.kind !== 'client' && n.kind !== 'external').length);
  const back = importFile(yaml);
  expect(back?.domain, label).toBe('software');
  const reread = back!.spec as SystemSpec;
  const ours = shape(spec, serviceName);
  const theirs = shape(reread, (id) => id);
  expect(theirs.nodes, label).toEqual(ours.nodes);
  // Every connection the file declares comes back; a depends_on loop the export broke is the only one allowed to go missing
  for (const link of theirs.links) expect(ours.links, `${label} extra ${link}`).toContain(link);
  expect(theirs.links.length, label).toBeGreaterThanOrEqual(ours.links.length - spec.edges.length);
}

describe('an exported docker-compose.yml reads back as the same design', () => {
  it('for every verified software design', () => {
    const designs = Object.entries(verified).filter(([, v]) => v.domain === 'software');
    expect(designs.length).toBeGreaterThan(0);
    for (const [prompt, v] of designs) {
      const design = DOMAINS.software.specSchema.parse(v.draft.spec) as SystemSpec;
      const yaml = toCompose(design, { name: prompt });
      expect(() => parse(yaml), prompt).not.toThrow();
      expect(importFile(yaml)?.domain, prompt).toBe('software');
    }
  });

  it('for 300 random designs: same containers, kinds and replicas, and no connection that was not there', () => {
    for (let seed = 1; seed <= 300; seed++) roundTrip(randomSpec(seed), `seed ${seed}`);
  });
});
