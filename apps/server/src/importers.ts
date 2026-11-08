// Reads a file the user pasted instead of a description: SQL DDL becomes a database schema, and a Docker Compose file or Kubernetes
// manifests become a software architecture. The structure comes straight from the file, with no model involved, so the simulation
// is the user's real system. What a file never says (row counts, query load, traffic) is filled in afterwards.
import type { Column, DatabaseSpec, NodeKind, Query, SystemEdge, SystemNode, SystemSpec, Table } from '@tv/core';
import { parseAllDocuments } from 'yaml';

export type Imported =
  | { domain: 'database'; format: 'SQL'; name: string; spec: DatabaseSpec; found: string; notes: string[] }
  | { domain: 'software'; format: 'Docker Compose' | 'Kubernetes'; name: string; spec: SystemSpec; found: string; notes: string[] };

/** The file in a request: the first fenced code block if there is one, otherwise the whole request. */
export function fileIn(prompt: string): string {
  const fenced = prompt.match(/```[\w-]*\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : prompt).trim();
}

export function importFile(prompt: string): Imported | null {
  const text = fileIn(prompt);
  if (/\bcreate\s+table\b[^;(]*\(/i.test(text)) return importSql(text);
  if (/^\s*(services|apiVersion)\s*:/m.test(text)) return importYaml(text);
  return null;
}

// ---------------------------------------------------------------- SQL

const MAX_TABLES = 16;
const MAX_COLUMNS = 30;

/** Splits on commas outside parentheses and quotes. */
function splitTop(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** An identifier without quotes or schema: "public"."Orders" is orders. */
const ident = (raw: string) =>
  raw
    .trim()
    .split('.')
    .pop()!
    .replace(/^["`[]|["`\]]$/g, '')
    .toLowerCase();

const identList = (raw: string) => splitTop(raw).map((c) => ident(c.replace(/\s+(asc|desc)\b.*$/i, '').replace(/\(.*$/, '')));

function columnType(raw: string): Column['type'] {
  const t = raw.toLowerCase();
  if (/^(big ?int|bigserial|int8|serial8)/.test(t)) return 'bigint';
  if (/^(int|integer|smallint|tinyint|mediumint|serial|smallserial|int2|int4)/.test(t)) return 'int';
  if (/^(uuid|uniqueidentifier)/.test(t)) return 'uuid';
  if (/^(bool|boolean|bit)\b/.test(t)) return 'bool';
  if (/^(decimal|numeric|money|real|float|double|number)/.test(t)) return 'decimal';
  if (/^(timestamp|timestamptz|datetime|date|time)/.test(t)) return 'timestamp';
  return 'text';
}

const onDelete = (rest: string): NonNullable<Column['references']>['onDelete'] => {
  const m = rest.match(/on\s+delete\s+(cascade|restrict|set\s+null|no\s+action)/i);
  if (!m) return undefined;
  const v = m[1].toLowerCase().replace(/\s+/g, ' ');
  return v === 'cascade' ? 'cascade' : v === 'set null' ? 'set_null' : 'restrict';
};

const REFERENCE = /references\s+([\w."`[\]]+)\s*(?:\(([^)]*)\))?/i;

/** CREATE TABLE's name, the body inside its own parentheses, and what follows (engine, partitioning). */
function createTable(s: string): [string, string, string, string] | null {
  const head = s.match(/^create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)\s*\(/i);
  if (!head) return null;
  let depth = 0;
  for (let i = head[0].length - 1; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return [s, head[1], s.slice(head[0].length, i), s.slice(i + 1).trim()];
  }
  return null;
}

export function importSql(text: string): Imported | null {
  const sql = text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const tables: Table[] = [];
  const notes: string[] = [];
  const pendingRefs: Array<{ table: string; column: string; refTable: string; refColumn?: string; onDelete?: NonNullable<Column['references']>['onDelete'] }> = [];
  const partitionsOf = new Map<string, number>();
  const table = (name: string) => tables.find((t) => t.name === name);

  for (const statement of splitTop(sql, ';')) {
    const s = statement.replace(/\s+/g, ' ').trim();
    // A Postgres partition of a parent table counts towards the parent's partitions, not as a table of its own.
    const child = s.match(/^create\s+table\s+(?:if\s+not\s+exists\s+)?[\w."`[\]]+\s+partition\s+of\s+([\w."`[\]]+)/i);
    if (child) {
      partitionsOf.set(ident(child[1]), (partitionsOf.get(ident(child[1])) ?? 0) + 1);
      continue;
    }
    const create = createTable(s);
    if (create) {
      const name = ident(create[1]);
      if (table(name)) continue;
      const t: Table = { name, rows: 0, columns: [], indexes: [] };
      const unique: string[][] = [];
      for (const def of splitTop(create[2])) {
        const constraint = def.replace(/^constraint\s+[\w"`[\]]+\s+/i, '');
        const pk = constraint.match(/^primary\s+key\s*\(([^)]*)\)/i);
        const uq = constraint.match(/^unique(?:\s+(?:key|index))?\s*[\w"`]*\s*\(([^)]*)\)/i);
        const fk = constraint.match(/^foreign\s+key\s*\(([^)]*)\)\s*(.*)$/i);
        const ix = constraint.match(/^(?:key|index)\s+[\w"`]*\s*\(([^)]*)\)/i);
        if (pk) {
          const cols = identList(pk[1]);
          for (const c of t.columns) if (cols.includes(c.name)) c.primary = true;
          if (cols.length > 1) t.indexes.push(cols);
        } else if (uq) unique.push(identList(uq[1]));
        else if (fk) {
          const ref = fk[2].match(REFERENCE);
          if (ref) {
            const cols = identList(fk[1]);
            const refCols = ref[2] ? identList(ref[2]) : [];
            cols.forEach((column, i) => pendingRefs.push({ table: name, column, refTable: ident(ref[1]), refColumn: refCols[i], onDelete: onDelete(fk[2]) }));
          }
        } else if (ix) t.indexes.push(identList(ix[1]));
        else if (/^(check|exclude|fulltext|spatial|period)\b/i.test(constraint)) continue;
        else {
          const col = def.match(/^([\w"`[\]]+)\s+([\w ]+?(?:\s*\([^)]*\))?(?:\s*\[\])?)(?=\s|$)(.*)$/);
          if (!col) continue;
          if (t.columns.length >= MAX_COLUMNS) {
            if (t.columns.length === MAX_COLUMNS) notes.push(`kept the first ${MAX_COLUMNS} columns of ${name}`);
            continue;
          }
          const rest = col[3] ?? '';
          const column: Column = { name: ident(col[1]), type: columnType(col[2]) };
          if (/\bprimary\s+key\b/i.test(rest)) column.primary = true;
          if (/\bunique\b/i.test(rest)) column.unique = true;
          if (/\bnull\b/i.test(rest) && !/\bnot\s+null\b/i.test(rest)) column.nullable = true;
          const ref = rest.match(REFERENCE);
          if (ref) pendingRefs.push({ table: name, column: column.name, refTable: ident(ref[1]), refColumn: ref[2] ? identList(ref[2])[0] : undefined, onDelete: onDelete(rest) });
          t.columns.push(column);
        }
      }
      for (const cols of unique) {
        if (cols.length === 1) {
          const c = t.columns.find((x) => x.name === cols[0]);
          if (c) c.unique = true;
        } else t.indexes.push(cols);
      }
      const partition = create[3].match(/partition\s+by\s+(?:range|list|hash|key)?\s*(?:columns\s*)?\(\s*([\w"`]+)/i);
      if (partition) t.partitionBy = ident(partition[1]);
      const count = create[3].match(/partitions\s+(\d+)/i);
      if (count) t.partitions = Number(count[1]);
      if (!t.columns.length) continue;
      if (tables.length >= MAX_TABLES) {
        if (tables.length === MAX_TABLES) notes.push(`kept the first ${MAX_TABLES} tables`);
        continue;
      }
      tables.push(t);
      continue;
    }
    const index = s.match(
      /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:[\w."`[\]]+\s+)?on\s+(?:only\s+)?([\w."`[\]]+)\s*(?:using\s+\w+\s*)?\(([^)]*(?:\([^)]*\)[^)]*)*)\)/i,
    );
    if (index) {
      const t = table(ident(index[2]));
      if (!t) continue;
      const cols = identList(index[3]).filter((c) => t.columns.some((x) => x.name === c));
      if (!cols.length) continue;
      if (index[1] && cols.length === 1) t.columns.find((c) => c.name === cols[0])!.unique = true;
      else t.indexes.push(cols);
      continue;
    }
    const alter = s.match(/^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w."`[\]]+)\s+(.*)$/i);
    if (alter) {
      const t = table(ident(alter[1]));
      if (!t) continue;
      for (const action of splitTop(alter[2])) {
        const body = action.replace(/^add\s+(?:constraint\s+[\w"`[\]]+\s+)?/i, '');
        const fk = body.match(/^foreign\s+key\s*\(([^)]*)\)\s*(.*)$/i);
        const pk = body.match(/^primary\s+key\s*\(([^)]*)\)/i);
        const column = action.match(/^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\w"`[\]]+)\s+([\w ]+?(?:\([^)]*\))?)(?=\s|$)(.*)$/i);
        if (fk) {
          const ref = fk[2].match(REFERENCE);
          if (ref) {
            const refCols = ref[2] ? identList(ref[2]) : [];
            identList(fk[1]).forEach((c, i) => pendingRefs.push({ table: t.name, column: c, refTable: ident(ref[1]), refColumn: refCols[i], onDelete: onDelete(fk[2]) }));
          }
        } else if (pk) {
          const cols = identList(pk[1]);
          for (const c of t.columns) if (cols.includes(c.name)) c.primary = true;
        } else if (column && !/^add\s+(constraint|unique|check|index|key)\b/i.test(action) && t.columns.length < MAX_COLUMNS) {
          const c: Column = { name: ident(column[1]), type: columnType(column[2]) };
          const ref = (column[3] ?? '').match(REFERENCE);
          if (ref)
            pendingRefs.push({ table: t.name, column: c.name, refTable: ident(ref[1]), refColumn: ref[2] ? identList(ref[2])[0] : undefined, onDelete: onDelete(column[3]) });
          if (!t.columns.some((x) => x.name === c.name)) t.columns.push(c);
        }
      }
    }
  }
  if (!tables.length) return null;

  // References resolve once every table is read, since a key can point at a table created further down.
  let dangling = 0;
  for (const ref of pendingRefs) {
    const column = table(ref.table)?.columns.find((c) => c.name === ref.column);
    const parent = table(ref.refTable);
    const target = parent?.columns.find((c) => c.name === ref.refColumn) ?? parent?.columns.find((c) => c.primary);
    if (!column || !parent || !target) {
      dangling++;
      continue;
    }
    column.references = { table: parent.name, column: target.name, ...(ref.onDelete ? { onDelete: ref.onDelete } : {}) };
  }
  if (dangling) notes.push(`left out ${dangling} foreign key${dangling === 1 ? '' : 's'} to tables that aren't in the file`);
  for (const t of tables) {
    const parts = partitionsOf.get(t.name);
    if (t.partitionBy && !t.partitions) t.partitions = Math.min(32, Math.max(2, parts ?? 4));
    if (t.partitions) t.partitions = Math.min(32, Math.max(1, t.partitions));
    // The same index listed twice (a unique constraint and an index on one column) is kept once.
    t.indexes = t.indexes.filter((ix, i) => ix.length && t.indexes.findIndex((o) => o.join() === ix.join()) === i);
  }
  estimateRows(tables);
  const spec: DatabaseSpec = { tables, workload: defaultWorkload(tables) };
  const keys = tables.reduce((n, t) => n + t.columns.filter((c) => c.references).length, 0);
  const indexes = tables.reduce((n, t) => n + t.indexes.length, 0);
  return {
    domain: 'database',
    format: 'SQL',
    name: `Imported schema (${tables.length} table${tables.length === 1 ? '' : 's'})`,
    spec,
    found: `${tables.length} table${tables.length === 1 ? '' : 's'}, ${keys} foreign key${keys === 1 ? '' : 's'} and ${indexes} index${indexes === 1 ? '' : 'es'}`,
    notes,
  };
}

/**
 * Row counts a file never states, guessed from its shape: a table nothing points at is where activity lands (orders, events), and
 * the more tables point at one, the more of a catalogue it is (users, products).
 */
function estimateRows(tables: Table[]) {
  const referencedBy = (t: Table) => tables.filter((o) => o !== t && o.columns.some((c) => c.references?.table === t.name)).length;
  for (const t of tables) {
    const parents = t.columns.filter((c) => c.references).length;
    const children = referencedBy(t);
    t.rows = parents && !children ? 2_000_000 * Math.min(parents, 3) : parents ? 500_000 : children ? 50_000 : 10_000;
  }
}

/** A starting workload from the schema itself: look up each child by its parent, fetch rows by key, and write where activity lands. */
export function defaultWorkload(tables: Table[]): Query[] {
  const queries: Query[] = [];
  const byRows = [...tables].sort((a, b) => b.rows - a.rows);
  for (const t of byRows) {
    const fk = t.columns.find((c) => c.references);
    if (fk && queries.length < 4) {
      queries.push({
        name: `${t.name} by ${fk.references!.table}`,
        kind: 'read',
        table: t.name,
        where: [fk.name],
        joins: [{ table: fk.references!.table, local: fk.name, foreign: fk.references!.column }],
        perSecond: 100,
      });
    }
  }
  const lookup = byRows.find((t) => t.columns.some((c) => c.primary) && !queries.some((q) => q.table === t.name));
  if (lookup) queries.push({ name: `${lookup.name} by id`, kind: 'read', table: lookup.name, where: [lookup.columns.find((c) => c.primary)!.name], joins: [], perSecond: 200 });
  const busiest = byRows[0];
  queries.push({ name: `insert into ${busiest.name}`, kind: 'write', table: busiest.name, where: [], joins: [], perSecond: 20 });
  return queries.slice(0, 6);
}

// ---------------------------------------------------------------- Compose and Kubernetes

const MAX_NODES = 23;

const KIND_BY_IMAGE: Array<[RegExp, NodeKind]> = [
  [
    /postgres|postgis|timescale|mysql|mariadb|mongo|cassandra|scylla|cockroach|clickhouse|mssql|sqlserver|oracle|couchdb|neo4j|influx|dynamodb|elasticsearch|opensearch|minio|etcd/,
    'database',
  ],
  [/redis|memcache|valkey|keydb|dragonfly|varnish/, 'cache'],
  [/rabbitmq|kafka|redpanda|nats|activemq|pulsar|zeromq|sqs|elasticmq|mosquitto|emqx/, 'queue'],
  [/nginx|traefik|haproxy|envoy|caddy|kong|httpd|apache|ingress|gateway|istio/, 'gateway'],
];
// Tooling beside the request path: dashboards, admin panels, tracing and local mail catchers.
const TOOLING =
  /adminer|pgadmin|phpmyadmin|mongo-express|redis-?commander|redisinsight|grafana|prometheus|alertmanager|loki|promtail|jaeger|zipkin|otel|kibana|mailhog|mailpit|portainer|watchtower|cadvisor|node-exporter|zookeeper|schema-registry|kafka-ui|kafdrop|flower|localstack|certbot/;
const CONSUMER = /worker|consumer|processor|job|celery|sidekiq|handler|subscriber|listener|cron|scheduler|queue-?runner/;

interface Service {
  name: string;
  image: string;
  replicas: number;
  dependsOn: string[];
  text: string; // everything the service is configured with, searched for other services' names
  ports: boolean;
  // Built from source rather than a named image, so its "image" is only a folder and says nothing worth showing.
  built?: boolean;
  // A HorizontalPodAutoscaler's ceiling for it.
  autoscaleMax?: number;
}

const kindOf = (s: Service): NodeKind => {
  const hay = `${s.image} ${s.name}`.toLowerCase();
  return KIND_BY_IMAGE.find(([re]) => re.test(hay))?.[1] ?? 'service';
};

const nodeId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'service';

function composeServices(doc: Record<string, unknown>): Service[] {
  const services = doc.services as Record<string, Record<string, unknown> | null>;
  return Object.entries(services).map(([name, raw]) => {
    const s = raw ?? {};
    const deploy = (s.deploy ?? {}) as { replicas?: number };
    const depends = s.depends_on;
    const dependsOn = Array.isArray(depends) ? depends.map(String) : depends && typeof depends === 'object' ? Object.keys(depends) : [];
    const links = Array.isArray(s.links) ? s.links.map((l) => String(l).split(':')[0]) : [];
    const build = typeof s.build === 'string' ? s.build : (s.build as { context?: string } | undefined)?.context;
    return {
      name,
      image: String(s.image ?? build ?? name),
      replicas: Math.max(1, Math.min(50, Number(deploy.replicas ?? s.scale ?? 1) || 1)),
      dependsOn: [...new Set([...dependsOn, ...links])],
      text: JSON.stringify({ environment: s.environment, command: s.command, entrypoint: s.entrypoint, env_file: s.env_file, labels: s.labels }),
      ports: Boolean(s.ports),
      built: !s.image,
    };
  });
}

interface K8sDoc {
  kind?: string;
  metadata?: { name?: string };
  spec?: Record<string, unknown>;
}

function k8sServices(docs: K8sDoc[]): { services: Service[]; entries: string[] } {
  const services: Service[] = [];
  const workloads = docs.filter((d) => /^(Deployment|StatefulSet|DaemonSet|ReplicaSet|Pod|CronJob|Job)$/.test(d.kind ?? ''));
  for (const d of workloads) {
    const name = d.metadata?.name;
    if (!name) continue;
    const spec = d.spec ?? {};
    const pod = (
      d.kind === 'Pod'
        ? spec
        : ((spec.template as { spec?: Record<string, unknown> })?.spec ??
          (spec.jobTemplate as never as { spec?: { template?: { spec?: Record<string, unknown> } } })?.spec?.template?.spec ??
          {})
    ) as {
      containers?: Array<{ image?: string; env?: unknown; args?: unknown; command?: unknown; envFrom?: unknown }>;
    };
    const containers = pod.containers ?? [];
    services.push({
      name,
      image: containers.map((c) => c.image ?? '').join(' ') || name,
      replicas: Math.max(1, Math.min(50, Number(spec.replicas ?? 1) || 1)),
      dependsOn: [],
      text: JSON.stringify(containers.map((c) => [c.env, c.args, c.command, c.envFrom])),
      ports: false,
    });
  }
  // A Service named differently from its Deployment is still the way callers reach it: callers' configuration names the Service.
  const aliases = new Map<string, string>();
  for (const d of docs.filter((x) => x.kind === 'Service')) {
    const selector = Object.values((d.spec?.selector ?? {}) as Record<string, string>);
    const target = workloads.find((w) => {
      const labels = Object.values(((w.spec?.template as { metadata?: { labels?: Record<string, string> } })?.metadata?.labels ?? {}) as Record<string, string>);
      return selector.length && selector.every((v) => labels.includes(v));
    });
    if (d.metadata?.name && target?.metadata?.name && d.metadata.name !== target.metadata.name) aliases.set(d.metadata.name, target.metadata.name);
  }
  for (const s of services) {
    for (const [alias, target] of aliases) if (target !== s.name && new RegExp(`\\b${alias}\\b`).test(s.text)) s.dependsOn.push(target);
  }
  // A HorizontalPodAutoscaler starts its target at minReplicas and grows it to maxReplicas.
  for (const d of docs.filter((x) => x.kind === 'HorizontalPodAutoscaler')) {
    const spec = (d.spec ?? {}) as { scaleTargetRef?: { name?: string }; minReplicas?: number; maxReplicas?: number };
    const target = services.find((s) => s.name === spec.scaleTargetRef?.name);
    if (!target || !spec.maxReplicas) continue;
    if (spec.minReplicas) target.replicas = Math.max(1, Math.min(50, spec.minReplicas));
    target.autoscaleMax = Math.max(target.replicas, Math.min(50, spec.maxReplicas));
  }
  const entries: string[] = [];
  for (const d of docs.filter((x) => x.kind === 'Ingress')) {
    const name = d.metadata?.name ?? 'ingress';
    const backends = JSON.stringify(d.spec ?? {}).match(/"service":\{"name":"([^"]+)"/g) ?? [];
    const targets = backends.map((b) => b.match(/"name":"([^"]+)"/)![1]).map((n) => aliases.get(n) ?? n);
    services.push({ name, image: 'ingress', replicas: 2, dependsOn: [...new Set(targets)], text: '', ports: true });
    entries.push(name);
  }
  return { services, entries };
}

export function importYaml(text: string): Imported | null {
  let docs: unknown[];
  try {
    docs = parseAllDocuments(text)
      .filter((d) => !d.errors.length)
      .map((d) => d.toJS() as unknown)
      .filter((d) => d && typeof d === 'object');
  } catch {
    return null;
  }
  if (!docs.length) return null;
  const compose = docs.find((d) => typeof (d as { services?: unknown }).services === 'object' && (d as { services?: unknown }).services !== null) as
    Record<string, unknown> | undefined;
  const k8s = docs.filter((d) => typeof (d as K8sDoc).kind === 'string') as K8sDoc[];
  const format = compose ? 'Docker Compose' : k8s.length ? 'Kubernetes' : null;
  if (!format) return null;
  const read = compose ? { services: composeServices(compose), entries: [] as string[] } : k8sServices(k8s);
  const notes: string[] = [];
  const tooling = read.services.filter((s) => TOOLING.test(`${s.image} ${s.name}`.toLowerCase()) && !read.entries.includes(s.name));
  if (tooling.length) notes.push(`left out ${tooling.map((s) => s.name).join(', ')}, which ${tooling.length === 1 ? 'is' : 'are'} tooling beside the request path`);
  let services = read.services.filter((s) => !tooling.includes(s));
  if (services.length > MAX_NODES) {
    notes.push(`kept the first ${MAX_NODES} services`);
    services = services.slice(0, MAX_NODES);
  }
  if (!services.length) return null;

  const ids = new Map(services.map((s) => [s.name, nodeId(s.name)]));
  const nodes: SystemNode[] = [{ id: 'users', label: 'Users', kind: 'client' }];
  for (const s of services) {
    const image = s.image.split('/').pop()!.split(':')[0];
    nodes.push({
      id: ids.get(s.name)!,
      label: image && image !== s.name && !s.built ? `${s.name} (${image})` : s.name,
      kind: kindOf(s),
      replicas: s.replicas,
      ...(s.autoscaleMax ? { autoscale: { max: s.autoscaleMax } } : {}),
    });
  }
  const kind = (name: string) => nodes.find((n) => n.id === ids.get(name))?.kind;
  const edges: SystemEdge[] = [];
  const link = (from: string, to: string) => {
    const a = ids.get(from);
    const b = ids.get(to);
    if (!a || !b || a === b || edges.some((e) => e.from === a && e.to === b)) return;
    if (kind(to) === 'queue' && CONSUMER.test(from.toLowerCase())) edges.push({ from: b, to: a, mode: 'async' });
    else edges.push({ from: a, to: b, ...(kind(to) === 'queue' ? { mode: 'async' as const } : {}) });
  };
  for (const s of services) {
    for (const d of s.dependsOn) link(s.name, d);
    // Configuration naming another service (a DATABASE_URL pointing at "db") is a call to it, even without depends_on.
    for (const other of services) if (other !== s && new RegExp(`[^\\w-]${other.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\w-]`).test(s.text)) link(s.name, other.name);
  }
  // Users come in through the gateways, else through whatever publishes a port, else through whatever nothing else calls.
  const called = new Set(edges.map((e) => e.to));
  const gateways = services.filter((s) => kind(s.name) === 'gateway' && !called.has(ids.get(s.name)!));
  const published = services.filter((s) => (s.ports || read.entries.includes(s.name)) && kind(s.name) === 'service' && !called.has(ids.get(s.name)!));
  const roots = services.filter((s) => !called.has(ids.get(s.name)!) && kind(s.name) === 'service' && !CONSUMER.test(s.name.toLowerCase()));
  const entries = gateways.length ? gateways : published.length ? published : roots.length ? roots : services.slice(0, 1);
  for (const s of entries) edges.unshift({ from: 'users', to: ids.get(s.name)! });

  const spec: SystemSpec = { traffic: 200, retries: 1, nodes, edges };
  const count = services.length;
  return {
    domain: 'software',
    format,
    name: `Imported ${format === 'Kubernetes' ? 'cluster' : 'stack'} (${count} service${count === 1 ? '' : 's'})`,
    spec,
    found: `${count} service${count === 1 ? '' : 's'} and ${edges.length - entries.length} connection${edges.length - entries.length === 1 ? '' : 's'}`,
    notes,
  };
}
