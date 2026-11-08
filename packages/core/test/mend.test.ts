import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../src';
import type { CircuitSpec } from '../src/domains/electronics/parts';
import type { FleetSpec } from '../src/domains/fleet/schema';

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
});
