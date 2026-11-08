import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../src';
import type { CircuitSpec } from '../src/domains/electronics/parts';
import type { FleetSpec } from '../src/domains/fleet/schema';
import type { SystemSpec } from '../src/domains/software/schema';

describe('mends for what repairs leave', () => {
  it('gives a board’s repeated pins their own names, keeping wires on the first', () => {
    const e = DOMAINS.electronics;
    const spec = e.specSchema.parse({
      parts: [
        { id: 'batt', type: 'battery', volts: 5, maxAmps: 1 },
        {
          id: 'pico',
          type: 'custom',
          package: 'module',
          custom: { label: 'Raspberry Pi Pico', pins: ['VBUS', 'GND', 'GP15', 'GND'], paths: [{ a: 'VBUS', b: 'GND', ohms: 100 }], output: false },
        },
      ],
      wires: [
        { from: 'batt.pos', to: 'pico.VBUS' },
        { from: 'batt.neg', to: 'pico.GND' },
      ],
    }) as CircuitSpec;
    expect(e.validate(spec).some((i) => /more than once/.test(i.message))).toBe(true);
    const mended = e.rules.mend!(spec, e.validate(spec), [])!;
    expect(mended.notes[0]).toMatch(/pico's repeated GND pins/);
    expect((mended.spec as CircuitSpec).parts[1].custom!.pins).toEqual(['VBUS', 'GND', 'GP15', 'GND_2']);
    expect(e.validate(mended.spec).some((i) => /more than once/.test(i.message))).toBe(false);
  });

  it('adds relays when searchers fly out of radio range', () => {
    const f = DOMAINS.fleet;
    const base = f.rules.spec('a swarm of drones searching a disaster area') as FleetSpec;
    const spec: FleetSpec = { ...base, roles: base.roles.filter((r) => r.behavior !== 'relay').map((r) => (r.behavior === 'search' ? { ...r, range: 300 } : r)) };
    const issues = f.validate(spec);
    expect(issues.some((i) => /lose contact past/.test(i.message))).toBe(true);
    const mended = f.rules.mend!(spec, issues, [])!;
    expect(mended.notes[0]).toMatch(/added \d+ relay drone/);
    expect(f.validate(mended.spec).some((i) => /lose contact past/.test(i.message))).toBe(false);
  });
  describe('software', () => {
    const sw = DOMAINS.software;
    const repairable = (spec: SystemSpec) => sw.validate(spec).filter((i) => i.severity === 'error' || i.repair);
    const base = (over: Partial<SystemSpec> = {}): SystemSpec =>
      sw.specSchema.parse({
        traffic: 1000,
        nodes: [
          { id: 'users', kind: 'client' },
          { id: 'api', kind: 'service', replicas: 2 },
          { id: 'db', kind: 'database', replicas: 2 },
        ],
        edges: [
          { from: 'users', to: 'api' },
          { from: 'api', to: 'db' },
        ],
        ...over,
      }) as SystemSpec;

    it('sizes an overloaded service to about 70% load', () => {
      const spec = base();
      expect(repairable(spec).some((i) => /api is over capacity/.test(i.message))).toBe(true);
      const mended = sw.rules.mend!(spec, sw.validate(spec), [1000])!;
      expect(mended.notes.join()).toMatch(/sized api/);
      expect((mended.spec as SystemSpec).nodes.find((n) => n.id === 'api')!.replicas).toBe(8);
      expect(repairable(mended.spec as SystemSpec)).toEqual([]);
    });

    it('keeps a replica count the user stated and raises per-replica capacity instead', () => {
      const spec = base();
      const mended = sw.rules.mend!(spec, sw.validate(spec), [1000, 2])!;
      const api = (mended.spec as SystemSpec).nodes.find((n) => n.id === 'api')!;
      expect(api.replicas).toBe(2);
      expect(api.capacity).toBeGreaterThan(700);
      expect(repairable(mended.spec as SystemSpec)).toEqual([]);
    });

    it('drops a call that closes a loop and drains a queue nobody reads', () => {
      const spec = base({
        traffic: 50,
        nodes: [
          { id: 'users', kind: 'client' },
          { id: 'api', kind: 'service', replicas: 2 },
          { id: 'db', kind: 'database', replicas: 2 },
          { id: 'jobs', kind: 'queue' },
        ],
        edges: [
          { from: 'users', to: 'api' },
          { from: 'api', to: 'db' },
          { from: 'db', to: 'api' },
          { from: 'api', to: 'jobs', mode: 'async' },
        ],
      });
      const mended = sw.rules.mend!(spec, sw.validate(spec), [])!;
      expect(mended.notes.join()).toMatch(/closed a loop/);
      expect(mended.notes.join()).toMatch(/jobs a worker/);
      expect(repairable(mended.spec as SystemSpec)).toEqual([]);
    });

    it('runs a node in every zone it lists', () => {
      const spec = base({
        traffic: 50,
        nodes: [
          { id: 'users', kind: 'client' },
          { id: 'api', kind: 'service', replicas: 2, zones: ['a', 'b', 'c'] },
          { id: 'db', kind: 'database', replicas: 2, zones: ['a', 'b'] },
        ],
      });
      const mended = sw.rules.mend!(spec, sw.validate(spec), [])!;
      expect((mended.spec as SystemSpec).nodes.find((n) => n.id === 'api')!.replicas).toBe(3);
      expect(repairable(mended.spec as SystemSpec)).toEqual([]);
    });
  });
});
