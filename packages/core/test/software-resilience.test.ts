import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../src';
import { SystemPatchSchema, type SystemSpec } from '../src/domains/software/schema';
import type { SystemRun } from '../src/domains/software/system';

const software = DOMAINS.software;

// Users through a gateway to a checkout service that calls a payment provider and a database.
const shop = (edit: (spec: SystemSpec) => void = () => {}): SystemSpec => {
  const spec = software.specSchema.parse({
    traffic: 300,
    retries: 2,
    nodes: [
      { id: 'users', kind: 'client' },
      { id: 'gateway', kind: 'gateway', replicas: 2 },
      { id: 'checkout', kind: 'service', replicas: 3 },
      { id: 'payments', kind: 'external', capacity: 1000 },
      { id: 'db', kind: 'database', replicas: 2 },
    ],
    edges: [
      { from: 'users', to: 'gateway' },
      { from: 'gateway', to: 'checkout' },
      { from: 'checkout', to: 'payments' },
      { from: 'checkout', to: 'db' },
    ],
  }) as SystemSpec;
  edit(spec);
  return spec;
};

const run = (spec: SystemSpec, ticks = 20) => {
  const r = software.createRun(spec, 1) as SystemRun;
  for (let i = 0; i < ticks; i++) r.step();
  return r;
};
const steps = (r: SystemRun, n: number) => {
  for (let i = 0; i < n; i++) r.step();
  return r;
};
const edge = (spec: SystemSpec, from: string, to: string) => spec.edges.find((e) => e.from === from && e.to === to)!;

describe('circuit breakers', () => {
  it('a breaker on an optional call keeps checkout answering, and fast, while the payment provider is down', () => {
    const plain = run(shop((s) => (edge(s, 'checkout', 'payments').optional = true)));
    const guarded = run(
      shop((s) => {
        edge(s, 'checkout', 'payments').optional = true;
        edge(s, 'checkout', 'payments').breaker = true;
      }),
    );
    for (const r of [plain, guarded]) {
      r.inject({ type: 'node_slow', target: 'payments', value: 50 });
      steps(r, 20);
    }
    expect(guarded.trips).toBe(1);
    expect(guarded.breakers.get('checkout->payments')!.open).toBe(true);
    expect(guarded.latency).toBeLessThan(plain.latency / 3);
    expect(guarded.success).toBeGreaterThan(0.99);
    expect(guarded.telemetry().find((m) => m.label === 'breakers open')?.value).toBe(1);
  });

  it('stops sending traffic and retries through an open breaker, then closes after a good trial once the callee recovers', () => {
    const r = run(shop((s) => (edge(s, 'checkout', 'payments').breaker = true)));
    r.inject({ type: 'node_down', target: 'payments' });
    steps(r, 3);
    expect(r.breakers.get('checkout->payments')!.open).toBe(true);
    expect(r.flows.get('checkout->payments')).toBe(0);
    r.inject({ type: 'recover', target: 'payments' });
    steps(r, 60);
    expect(r.breakers.get('checkout->payments')!.open).toBe(false);
    expect(r.success).toBeGreaterThan(0.99);
  });
});

describe('rate limiting', () => {
  it('turns a spike away at the door so checkout stays fast for the traffic it admits', () => {
    const plain = run(shop());
    // Just under what checkout's three replicas serve (600 rps): a limit protects latency, it doesn't add capacity.
    const limited = run(shop((s) => (s.nodes.find((n) => n.id === 'gateway')!.rateLimit = 550)));
    expect(limited.rejected).toBe(0);
    for (const r of [plain, limited]) {
      r.inject({ type: 'traffic_spike', value: 4 });
      steps(r, 20);
    }
    expect(limited.rejected).toBeGreaterThan(0);
    expect(limited.states.get('checkout')!.utilization).toBeLessThan(1);
    expect(plain.states.get('checkout')!.utilization).toBeGreaterThan(1);
    expect(limited.latency).toBeLessThan(plain.latency * 0.8);
    expect(limited.success).toBeGreaterThan(plain.success * 0.9);
  });

  it('turns away exactly the excess: callers back off from a 429 instead of retrying it', () => {
    const r = run(shop((s) => (s.nodes.find((n) => n.id === 'gateway')!.rateLimit = 200)));
    const gateway = r.states.get('gateway')!;
    expect(gateway.inflow - gateway.admitted).toBeCloseTo(100, -1);
  });

  it('brings unstated traffic under a rate limit the user gave, but leaves traffic they stated', () => {
    const over = shop((s) => (s.nodes.find((n) => n.id === 'gateway')!.rateLimit = 200));
    const issues = software.validate(over);
    expect(issues.find((i) => /rate limit of 200 rps turns away/.test(i.message))?.repair).toBe(true);
    expect((software.rules.mend!(over, issues, [200])!.spec as SystemSpec).traffic).toBe(160);
    expect(software.rules.mend!(over, issues, [200, 300])).toBeNull();
  });

  it('warns about a limit below normal traffic', () => {
    const tight = shop((s) => (s.nodes.find((n) => n.id === 'gateway')!.rateLimit = 100));
    expect(software.validate(tight).some((i) => /rate limit of 100 rps turns away/.test(i.message))).toBe(true);
  });
});

// Room behind checkout and no retries, so checkout's own replicas are what a spike tests.
const roomy = (edit: (spec: SystemSpec) => void = () => {}) =>
  shop((s) => {
    s.retries = 0;
    s.nodes.find((n) => n.id === 'payments')!.capacity = 5000;
    s.nodes.find((n) => n.id === 'db')!.replicas = 8;
    edit(s);
  });

describe('autoscaling', () => {
  it('adds replicas after they boot when a spike lands, and recovers where a fixed fleet stays overloaded', () => {
    const fixed = run(roomy());
    const scaling = run(roomy((s) => (s.nodes.find((n) => n.id === 'checkout')!.autoscale = { max: 20 })));
    for (const r of [fixed, scaling]) r.inject({ type: 'traffic_spike', value: 3 });
    steps(scaling, 5);
    // Still booting: no new replicas yet.
    expect(scaling.spec.nodes.find((n) => n.id === 'checkout')!.replicas).toBe(3);
    steps(fixed, 80);
    steps(scaling, 75);
    expect(scaling.spec.nodes.find((n) => n.id === 'checkout')!.replicas).toBeGreaterThan(3);
    expect(scaling.scaledUp).toBeGreaterThan(0);
    expect(scaling.success).toBeGreaterThan(0.95);
    expect(fixed.success).toBeLessThan(0.8);
  });

  it('scales back down to where it started once the spike passes, never below it', () => {
    const r = run(roomy((s) => (s.nodes.find((n) => n.id === 'checkout')!.autoscale = { max: 20 })));
    r.inject({ type: 'traffic_spike', value: 3 });
    steps(r, 60);
    r.inject({ type: 'recover' });
    steps(r, 300);
    expect(r.spec.nodes.find((n) => n.id === 'checkout')!.replicas).toBe(3);
  });

  it("can't outrun a retry storm: retries multiply the load faster than replicas boot, and the load moves on to what checkout calls", () => {
    const r = run(shop((s) => (s.nodes.find((n) => n.id === 'checkout')!.autoscale = { max: 20 })));
    r.inject({ type: 'traffic_spike', value: 3 });
    steps(r, 80);
    expect(r.spec.nodes.find((n) => n.id === 'checkout')!.replicas).toBe(20);
    expect(r.states.get('payments')!.utilization).toBeGreaterThan(1);
    expect(r.success).toBeLessThan(0.5);
  });

  it('flags a max below the starting replicas, and the mend raises it', () => {
    const stuck = shop((s) => (s.nodes.find((n) => n.id === 'checkout')!.autoscale = { max: 2 }));
    const issues = software.validate(stuck);
    expect(issues.find((i) => /can never scale up/.test(i.message))?.repair).toBe(true);
    const mended = software.rules.mend!(stuck, issues, [])!;
    expect((mended.spec as SystemSpec).nodes.find((n) => n.id === 'checkout')!.autoscale!.max).toBe(6);
  });
});

describe('recoveries', () => {
  it('offers autoscaling and a rate limit for a spike, and breakers for a failing dependency, all patches the schema accepts', () => {
    const spec = shop();
    const spike = software.rules.recoveries(spec, { type: 'traffic_spike', value: 3 }).map((o) => o.title);
    expect(spike).toEqual(expect.arrayContaining(['Autoscale every service', 'Rate limit gateway']));
    const slow = software.rules.recoveries(spec, { type: 'node_slow', target: 'payments', value: 8 });
    expect(slow.map((o) => o.title)).toContain('Put circuit breakers on calls to payments');
    for (const incident of [
      { type: 'traffic_spike', value: 3 },
      { type: 'node_slow', target: 'payments', value: 8 },
      { type: 'node_down', target: 'db' },
    ])
      for (const option of software.rules.recoveries(spec, incident)) for (const p of option.patches) expect(SystemPatchSchema.safeParse(p).success, JSON.stringify(p)).toBe(true);
  });

  it('applies each new fix to a running system', () => {
    const r = run(shop());
    r.apply([
      { op: 'add_breaker', from: 'checkout', to: 'payments' },
      { op: 'rate_limit', node: 'gateway', rps: 500 },
      { op: 'autoscale', node: 'checkout', max: 10 },
    ]);
    expect(edge(r.spec, 'checkout', 'payments').breaker).toBe(true);
    expect(r.spec.nodes.find((n) => n.id === 'gateway')!.rateLimit).toBe(500);
    expect(r.spec.nodes.find((n) => n.id === 'checkout')!.autoscale).toEqual({ max: 10 });
  });
});
