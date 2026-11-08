import { describe, expect, it } from 'vitest';
import { DOMAINS, serviceName, toCompose } from '../src';
import type { SystemSpec } from '../src/domains/software/schema';
import type { SystemRun } from '../src/domains/software/system';

const software = DOMAINS.software;
const spec = (raw: unknown) => software.specSchema.parse(raw) as SystemSpec;

const shop = () =>
  spec({
    traffic: 120,
    nodes: [
      { id: 'users', kind: 'client' },
      { id: 'edge', kind: 'gateway', replicas: 2 },
      { id: 'api', kind: 'service', replicas: 3, label: 'Shop API', autoscale: { max: 9 }, rateLimit: 500 },
      { id: 'db', kind: 'database', label: 'Postgres' },
      { id: 'cache', kind: 'cache' },
      { id: 'jobs', kind: 'queue', label: 'Kafka topic' },
      { id: 'worker', kind: 'service' },
      { id: 'stripe', kind: 'external', label: 'Stripe' },
    ],
    edges: [
      { from: 'users', to: 'edge' },
      { from: 'edge', to: 'api' },
      { from: 'api', to: 'cache' },
      { from: 'api', to: 'db', breaker: true },
      { from: 'api', to: 'jobs', mode: 'async' },
      { from: 'jobs', to: 'worker', mode: 'async' },
      { from: 'api', to: 'stripe' },
    ],
  });

const block = (yaml: string, name: string) => {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  const rest = yaml.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}\S/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

describe('exporting a software design as docker-compose.yml', () => {
  it('runs every container, skipping the users and outside APIs', () => {
    const yaml = toCompose(shop(), { name: 'Shop' });
    for (const name of ['edge', 'api', 'db', 'cache', 'jobs', 'worker']) expect(yaml).toContain(`\n  ${name}:\n`);
    expect(yaml).not.toContain('\n  users:\n');
    expect(yaml).not.toContain('\n  stripe:\n');
    expect(yaml).toContain('outside_apis:\n    - "Stripe"');
  });

  it('picks real images for infrastructure, from the label when it names one', () => {
    const yaml = toCompose(shop());
    expect(block(yaml, 'edge')).toContain('image: "nginx:1.27"');
    expect(block(yaml, 'db')).toContain('image: "postgres:16"');
    expect(block(yaml, 'cache')).toContain('image: "redis:7"');
    expect(block(yaml, 'jobs')).toContain('image: "apache/kafka:3.8.0"');
    expect(block(yaml, 'api')).toContain('image: "api:latest"');
  });

  it('wires callers to what they call, and a consumer to its queue', () => {
    const yaml = toCompose(shop());
    expect(block(yaml, 'edge')).toContain('depends_on:\n      - api');
    expect(block(yaml, 'api')).toMatch(/depends_on:\n {6}- cache\n {6}- db\n {6}- jobs/);
    expect(block(yaml, 'worker')).toContain('depends_on:\n      - jobs');
    expect(block(yaml, 'jobs')).not.toContain('depends_on');
    expect(block(yaml, 'api')).toContain('STRIPE_URL: "https://stripe.example.com"');
  });

  it('publishes a port only on what takes outside traffic, and writes replicas', () => {
    const yaml = toCompose(shop());
    expect(block(yaml, 'edge')).toContain('ports:\n      - "8080:80"');
    expect(block(yaml, 'api')).not.toContain('ports:');
    expect(block(yaml, 'edge')).toContain('deploy:\n      replicas: 2');
    expect(block(yaml, 'api')).toContain('replicas: 3');
    expect(block(yaml, 'db')).not.toContain('replicas');
  });

  it('keeps what Compose cannot say under x-canitwork', () => {
    const yaml = toCompose(shop());
    expect(yaml).toContain('x-canitwork:\n  traffic_per_second: 120\n  retries: 1');
    expect(block(yaml, 'api')).toContain('autoscale_max_replicas: 9');
    expect(block(yaml, 'api')).toContain('rate_limit_per_second: 500');
    expect(block(yaml, 'api')).toContain('circuit_breakers_on: ["db"]');
  });

  it('drops the depends_on that would close a loop, which Compose refuses', () => {
    const loop = spec({
      traffic: 10,
      nodes: [
        { id: 'users', kind: 'client' },
        { id: 'a', kind: 'service' },
        { id: 'b', kind: 'service' },
      ],
      edges: [
        { from: 'users', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    });
    const yaml = toCompose(loop);
    const deps = (yaml.match(/depends_on/g) ?? []).length;
    expect(deps).toBe(1);
  });

  it('cleans names into ones Compose accepts, keeping them unique', () => {
    expect(serviceName('Auth Service')).toBe('auth-service');
    expect(serviceName('__x')).toBe('x');
    const clash = spec({
      traffic: 10,
      nodes: [
        { id: 'users', kind: 'client' },
        { id: 'Auth API', kind: 'service' },
        { id: 'auth-api', kind: 'service' },
      ],
      edges: [
        { from: 'users', to: 'Auth API' },
        { from: 'Auth API', to: 'auth-api' },
      ],
    });
    const yaml = toCompose(clash);
    expect(yaml).toContain('\n  auth-api:\n');
    expect(yaml).toContain('\n  auth-api-2:\n');
  });

  it('includes the fixes applied while it ran: scaling, a cache, a breaker, autoscaling', () => {
    const run = software.createRun(shop(), 1) as SystemRun;
    run.apply([
      { op: 'scale', node: 'api', replicas: 6 },
      { op: 'add_cache', before: 'db' },
      { op: 'add_breaker', from: 'edge', to: 'api' },
      { op: 'autoscale', node: 'worker', max: 4 },
    ]);
    const yaml = run.toCompose('Shop');
    expect(block(yaml, 'api')).toContain('replicas: 6');
    expect(yaml).toContain('\n  cache1:\n');
    expect(block(yaml, 'edge')).toContain('circuit_breakers_on: ["api"]');
    expect(block(yaml, 'worker')).toContain('autoscale_max_replicas: 4');
  });

  it('writes one environment variable per outside API, even when it is called twice or two names clash', () => {
    const twice = spec({
      traffic: 10,
      nodes: [
        { id: 'users', kind: 'client' },
        { id: 'api', kind: 'service' },
        { id: 'pay.v2', kind: 'external' },
        { id: 'pay-v2', kind: 'external' },
      ],
      edges: [
        { from: 'users', to: 'api' },
        { from: 'api', to: 'pay.v2' },
        { from: 'api', to: 'pay.v2', calls: 2 },
        { from: 'api', to: 'pay-v2' },
      ],
    });
    const yaml = toCompose(twice);
    expect(yaml.match(/PAY_V2_URL/g)).toHaveLength(1);
    expect(yaml.match(/PAY_V2_2_URL/g)).toHaveLength(1);
  });

  it('exports every shipped example without throwing', () => {
    for (const example of software.examples) {
      const design = software.compile(software.rules.spec(example)) as SystemSpec;
      expect(toCompose(design, { name: example })).toContain('services:');
    }
  });
});
