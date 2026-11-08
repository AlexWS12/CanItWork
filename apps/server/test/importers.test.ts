import { DOMAINS, type DatabaseSpec, type SystemSpec } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { fileIn, importFile } from '../src/importers';

const errors = (domain: 'database' | 'software', spec: unknown) =>
  DOMAINS[domain]
    .validate(spec as never)
    .filter((i) => i.severity === 'error')
    .map((i) => i.message);

const POSTGRES = `
-- An online shop, as pg_dump writes it
CREATE TABLE public.users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE "products" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  price numeric(10, 2) CHECK (price > 0)
);
CREATE TABLE orders (
  id bigserial,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text,
  placed_at timestamp,
  CONSTRAINT orders_pkey PRIMARY KEY (id)
);
CREATE TABLE order_items (
  order_id bigint,
  product_id uuid,
  quantity int,
  PRIMARY KEY (order_id, product_id),
  FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_product FOREIGN KEY (product_id) REFERENCES products
);
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_user_idx ON public.orders USING btree (user_id, placed_at DESC);
CREATE UNIQUE INDEX ON products (title);
`;

const MYSQL = `
CREATE TABLE \`customers\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(100) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE \`invoices\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`customer_id\` int(11) NOT NULL,
  \`total\` decimal(10,2),
  PRIMARY KEY (\`id\`),
  KEY \`idx_customer\` (\`customer_id\`)
) ENGINE=InnoDB PARTITION BY HASH(id) PARTITIONS 8;
ALTER TABLE \`invoices\` ADD CONSTRAINT \`fk_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`) ON DELETE RESTRICT;
`;

const COMPOSE = `
services:
  proxy:
    image: nginx:1.27
    ports: ["80:80"]
    depends_on: [web]
  web:
    build: ./web
    environment:
      DATABASE_URL: postgres://app@db:5432/app
      REDIS_URL: redis://cache:6379
      BROKER_URL: amqp://rabbit
    deploy:
      replicas: 3
  worker:
    build: ./web
    command: celery -A app worker
    depends_on:
      rabbit:
        condition: service_healthy
      db:
        condition: service_started
  db:
    image: postgres:16
  cache:
    image: redis:7-alpine
  rabbit:
    image: rabbitmq:3-management
  pgadmin:
    image: dpage/pgadmin4
    depends_on: [db]
`;

const K8S = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  replicas: 6
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:2.1
          env:
            - { name: MONGO_URL, value: "mongodb://mongo-svc:27017/app" }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: mongo }
spec:
  replicas: 3
  template:
    metadata: { labels: { app: mongo } }
    spec:
      containers: [{ name: mongo, image: mongo:7 }]
---
apiVersion: v1
kind: Service
metadata: { name: mongo-svc }
spec: { selector: { app: mongo } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: web-ingress }
spec:
  rules:
    - http:
        paths:
          - path: /
            backend: { service: { name: api, port: { number: 80 } } }
`;

describe('importing pasted files', () => {
  it('reads a Postgres dump: tables, keys, composite keys, indexes and unique columns', () => {
    const got = importFile(POSTGRES)!;
    expect(got.domain).toBe('database');
    const spec = got.spec as DatabaseSpec;
    expect(spec.tables.map((t) => t.name)).toEqual(['users', 'products', 'orders', 'order_items']);
    const items = spec.tables[3];
    expect(items.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['order_id', 'product_id']);
    expect(items.columns.find((c) => c.name === 'product_id')!.references).toEqual({ table: 'products', column: 'id' });
    expect(spec.tables[2].columns.find((c) => c.name === 'user_id')!.references).toEqual({ table: 'users', column: 'id', onDelete: 'cascade' });
    expect(spec.tables[2].indexes).toEqual([['user_id', 'placed_at']]);
    expect(spec.tables[1].columns.find((c) => c.name === 'title')!.unique).toBe(true);
    expect(spec.tables[0].columns.map((c) => c.type)).toEqual(['bigint', 'text', 'timestamp']);
    expect(spec.tables[1].columns.find((c) => c.name === 'price')!.type).toBe('decimal');
    expect(got.found).toBe('4 tables, 3 foreign keys and 2 indexes');
    expect(spec.workload.length).toBeGreaterThan(1);
    expect(errors('database', DOMAINS.database.specSchema.parse(spec))).toEqual([]);
  });

  it('reads a MySQL dump with backticks, KEY lines, hash partitions and a key added by ALTER TABLE', () => {
    const spec = importFile(MYSQL)!.spec as DatabaseSpec;
    const invoices = spec.tables[1];
    expect(invoices.indexes).toEqual([['customer_id']]);
    expect(invoices).toMatchObject({ partitionBy: 'id', partitions: 8 });
    expect(invoices.columns[1].references).toEqual({ table: 'customers', column: 'id', onDelete: 'restrict' });
    expect(errors('database', DOMAINS.database.specSchema.parse(spec))).toEqual([]);
  });

  it('notes a foreign key to a table that is not in the file rather than failing', () => {
    const got = importFile('CREATE TABLE a (id int primary key, b_id int references b(id));')!;
    expect(got.notes).toEqual(["left out 1 foreign key to tables that aren't in the file"]);
    expect(errors('database', got.spec)).toEqual([]);
  });

  it('reads a Compose file: kinds from images, calls from depends_on and connection strings, a worker draining its queue', () => {
    const got = importFile(COMPOSE)!;
    expect(got).toMatchObject({ domain: 'software', format: 'Docker Compose' });
    const spec = got.spec as SystemSpec;
    const kinds = Object.fromEntries(spec.nodes.map((n) => [n.id, n.kind]));
    expect(kinds).toEqual({ users: 'client', proxy: 'gateway', web: 'service', worker: 'service', db: 'database', cache: 'cache', rabbit: 'queue' });
    expect(spec.nodes.find((n) => n.id === 'web')!.replicas).toBe(3);
    const edges = spec.edges.map((e) => `${e.from}>${e.to}${e.mode === 'async' ? '~' : ''}`);
    expect(edges).toEqual(expect.arrayContaining(['users>proxy', 'proxy>web', 'web>db', 'web>cache', 'web>rabbit~', 'rabbit>worker~', 'worker>db']));
    expect(got.notes[0]).toMatch(/left out pgadmin/);
    expect(errors('software', DOMAINS.software.specSchema.parse(spec))).toEqual([]);
  });

  it('reads a HorizontalPodAutoscaler as autoscaling from its minimum to its maximum', () => {
    const hpa = `${K8S}---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api-hpa }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 2
  maxReplicas: 12
`;
    const spec = importFile(hpa)!.spec as SystemSpec;
    expect(spec.nodes.find((n) => n.id === 'api')).toMatchObject({ replicas: 2, autoscale: { max: 12 } });
    expect(errors('software', DOMAINS.software.specSchema.parse(spec))).toEqual([]);
  });

  it('reads Kubernetes manifests: replicas, a Service alias in an env var, and an Ingress as the way in', () => {
    const got = importFile(K8S)!;
    expect(got.format).toBe('Kubernetes');
    const spec = got.spec as SystemSpec;
    expect(spec.nodes.find((n) => n.id === 'api')).toMatchObject({ kind: 'service', replicas: 6 });
    expect(spec.nodes.find((n) => n.id === 'mongo')).toMatchObject({ kind: 'database', replicas: 3 });
    const edges = spec.edges.map((e) => `${e.from}>${e.to}`);
    expect(edges).toEqual(expect.arrayContaining(['users>web-ingress', 'web-ingress>api', 'api>mongo']));
    expect(errors('software', DOMAINS.software.specSchema.parse(spec))).toEqual([]);
  });

  it('finds the file inside a fenced block and leaves plain requests alone', () => {
    expect(fileIn('Here is my schema:\n```sql\nCREATE TABLE t (id int);\n```\nIt has 5 million rows.')).toBe('CREATE TABLE t (id int);');
    expect(importFile('A university database where I create table rows for students')).toBeNull();
    expect(importFile('A web app with services and a cache')).toBeNull();
  });

  it('does not read ON DELETE SET NULL as the column being nullable', () => {
    const imported = importFile('CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a (id) ON DELETE SET NULL, note text NULL);');
    const b = (imported!.spec as DatabaseSpec).tables.find((t) => t.name === 'b')!;
    expect(b.columns.find((c) => c.name === 'a_id')).toMatchObject({ references: { table: 'a', column: 'id', onDelete: 'set_null' } });
    expect(b.columns.find((c) => c.name === 'a_id')!.nullable).toBeUndefined();
    expect(b.columns.find((c) => c.name === 'note')!.nullable).toBe(true);
  });
});
