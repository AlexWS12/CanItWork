import type { SystemNode, SystemSpec } from './schema';

// A software design as a docker-compose.yml: every container the design runs, with replicas, who it depends on and which
// ones take outside traffic. Written by code from the design as it runs now (fixes included), never by a model. What Compose
// has no field for (traffic, autoscaling, rate limits, breakers, zones, outside APIs) is kept under x-canitwork, which
// Compose allows and ignores.

/** A Compose service name: letters, digits, dots, dashes and underscores, starting with a letter or digit. */
export function serviceName(id: string): string {
  const name = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '');
  return name || 'service';
}

// A real image for each kind of infrastructure, picked from the label when it names one ("Postgres", "Kafka")
function image(node: SystemNode): string | null {
  const hay = `${node.label ?? ''} ${node.id}`.toLowerCase();
  switch (node.kind) {
    case 'database':
      if (/mysql/.test(hay)) return 'mysql:8.4';
      if (/maria/.test(hay)) return 'mariadb:11';
      if (/mongo/.test(hay)) return 'mongo:7';
      if (/cassandra/.test(hay)) return 'cassandra:5';
      if (/elastic|search/.test(hay)) return 'elasticsearch:8.15.0';
      return 'postgres:16';
    case 'cache':
      return /memcache/.test(hay) ? 'memcached:1.6' : 'redis:7';
    case 'queue':
      if (/kafka/.test(hay)) return 'apache/kafka:3.8.0';
      if (/nats/.test(hay)) return 'nats:2.10';
      return 'rabbitmq:3-management';
    case 'gateway':
      return 'nginx:1.27';
    default:
      return null;
  }
}

/** A plain YAML scalar: double-quoted, which YAML reads exactly like JSON. */
const q = (text: string) => JSON.stringify(text);
const plain = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

export interface ComposeExportOptions {
  name?: string;
}

/** The design as a docker-compose.yml. */
export function toCompose(spec: SystemSpec, options: ComposeExportOptions = {}): string {
  const containers = spec.nodes.filter((n) => n.kind !== 'client' && n.kind !== 'external');
  const external = spec.nodes.filter((n) => n.kind === 'external');
  const clients = new Set(spec.nodes.filter((n) => n.kind === 'client').map((n) => n.id));
  const kindOf = new Map(spec.nodes.map((n) => [n.id, n.kind]));

  // Compose names must be unique after cleaning, so a clash gets a number
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const n of containers) {
    let name = serviceName(n.id);
    for (let i = 2; taken.has(name); i++) name = `${serviceName(n.id)}-${i}`;
    taken.add(name);
    names.set(n.id, name);
  }

  // Who waits on whom. A caller depends on what it calls; a queue's consumer depends on the queue it reads from.
  const dependsOn = new Map<string, Set<string>>(containers.map((n) => [n.id, new Set()]));
  const calls = new Map<string, string[]>();
  for (const e of spec.edges) {
    if (!names.has(e.to) && kindOf.get(e.to) === 'external' && names.has(e.from)) calls.set(e.from, [...(calls.get(e.from) ?? []), e.to]);
    if (!names.has(e.from) || !names.has(e.to) || e.from === e.to) continue;
    if (kindOf.get(e.from) === 'queue' && e.mode === 'async') dependsOn.get(e.to)!.add(e.from);
    else dependsOn.get(e.from)!.add(e.to);
  }
  // Break cycles: Compose refuses a depends_on loop, so the edge that closes one is dropped (the call still happens)
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    visiting.add(id);
    for (const d of [...dependsOn.get(id)!]) {
      if (visiting.has(d)) dependsOn.get(id)!.delete(d);
      else visit(d);
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const n of containers) visit(n.id);

  const entries = new Set(spec.edges.filter((e) => clients.has(e.from) && names.has(e.to)).map((e) => e.to));
  const breakersFrom = new Map<string, string[]>();
  for (const e of spec.edges) if (e.breaker && names.has(e.from)) breakersFrom.set(e.from, [...(breakersFrom.get(e.from) ?? []), names.get(e.to) ?? e.to]);

  const lines: string[] = [
    `# ${plain(options.name ?? 'System')}, exported from CanItWork`,
    '# Written from the design the simulator tested, including any fixes applied. Run it with: docker compose up',
    '# Your own services use placeholder images: replace "<name>:latest" with your image or a build: folder.',
    '',
    'x-canitwork:',
    `  traffic_per_second: ${spec.traffic}`,
    `  retries: ${spec.retries}`,
  ];
  if (external.length) {
    lines.push('  outside_apis:');
    for (const n of external) lines.push(`    - ${q(plain(n.label ?? n.id))}`);
  }
  lines.push('', 'services:');
  let port = 8080;
  for (const n of containers) {
    const name = names.get(n.id)!;
    const img = image(n);
    lines.push(`  ${name}:`);
    lines.push(`    image: ${q(img ?? `${name}:latest`)}`);
    if (n.label && n.label !== n.id) lines.push(`    labels:`, `      canitwork.label: ${q(plain(n.label))}`);
    if (entries.has(n.id)) lines.push('    ports:', `      - ${q(`${port++}:${n.kind === 'gateway' ? 80 : 8080}`)}`);
    const deps = [...dependsOn.get(n.id)!].map((d) => names.get(d)!).sort();
    if (deps.length) {
      lines.push('    depends_on:');
      for (const d of deps) lines.push(`      - ${d}`);
    }
    // One variable per outside API, however many times it is called; two that clean to the same name get a number
    const outside = [...new Set(calls.get(n.id) ?? [])];
    if (outside.length) {
      lines.push('    environment:');
      const keys = new Set<string>();
      for (const o of outside) {
        const node = spec.nodes.find((x) => x.id === o)!;
        const base = `${serviceName(o).replace(/[.-]/g, '_').toUpperCase()}_URL`;
        let key = base;
        for (let i = 2; keys.has(key); i++) key = base.replace(/_URL$/, `_${i}_URL`);
        keys.add(key);
        lines.push(`      ${key}: ${q(`https://${serviceName(node.label ?? o).replace(/[._]/g, '-')}.example.com`)}`);
      }
    }
    if ((n.replicas ?? 1) > 1) lines.push('    deploy:', `      replicas: ${n.replicas}`);
    const extra: string[] = [];
    if (n.autoscale) extra.push(`      autoscale_max_replicas: ${n.autoscale.max}`);
    if (n.rateLimit) extra.push(`      rate_limit_per_second: ${n.rateLimit}`);
    if (n.capacity) extra.push(`      capacity_per_replica: ${n.capacity}`);
    if (n.latency) extra.push(`      latency_ms: ${n.latency}`);
    if (n.zones?.length) extra.push(`      zones: [${n.zones.map((z) => q(z)).join(', ')}]`);
    const breakers = breakersFrom.get(n.id);
    if (breakers?.length) extra.push(`      circuit_breakers_on: [${breakers.map((b) => q(b)).join(', ')}]`);
    if (extra.length) lines.push('    x-canitwork:', ...extra);
  }
  return `${lines.join('\n')}\n`;
}
