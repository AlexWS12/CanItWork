import { describe, expect, it } from 'vitest';
import { DOMAINS, SYSTEM, evaluate, settingPatch, type DomainId, type Run, type Setting } from '../src';

// Hand edits beyond the warehouse: every domain whose fixes fit a slider, a choice or a button shows them in the Inspector,
// checks them before they land, and logs them so a replay ends where the live run did.

const PROMPTS: Partial<Record<DomainId, string>> = {
  power: 'A city grid with coal, gas and solar',
  water: 'A town water network',
  supply: 'A supply chain from factory to stores',
  hospital: 'A hospital emergency department',
  factory: 'A car factory line',
  airport: 'A regional airport',
  callcenter: 'A call centre with two tiers of agents',
  queues: 'A coffee shop with a till and baristas',
  software: 'A web app with an API, a database and a payment provider',
  fleet: 'Six drones searching a forest for survivors',
  electronics: 'An LED with a resistor on a 9 V battery',
};

function start(domain: DomainId) {
  const d = DOMAINS[domain];
  const model = d.compile(d.specSchema.parse(d.rules.spec(PROMPTS[domain]!)));
  const run = d.createRun(model, 7);
  for (let i = 0; i < 20; i++) run.step();
  return { d, model, run };
}

/** Every id a run can be inspected by that offers something to change by hand */
function editables(run: Run, ids: string[]) {
  return ids.map((id) => [id, run.inspect(id)] as const).filter(([, view]) => view && (view.settings?.length || view.edits?.length));
}

/** A value for a setting other than the one it has, so applying it is a real change */
function another(setting: Setting): string | number {
  if (setting.kind === 'choice') return setting.options.find((o) => o.value !== setting.value)!.value;
  return setting.value + setting.step <= setting.max ? setting.value + setting.step : setting.value - setting.step;
}

const idsOf = (domain: DomainId, run: Run): string[] => {
  const r = run as any;
  if (r.spec?.nodes) return r.spec.nodes.map((n: { id: string }) => n.id);
  if (domain === 'fleet') return ['base', ...r.units.map((u: { id: string }) => u.id)];
  if (domain === 'electronics') return r.spec.parts.map((p: { id: string }) => p.id);
  return [];
};

describe('hand edits in every domain', () => {
  for (const domain of Object.keys(PROMPTS) as DomainId[]) {
    describe(domain, () => {
      it('offers settings or edits somewhere, and each one checks and applies', () => {
        const { run } = start(domain);
        const found = editables(run, [SYSTEM, ...idsOf(domain, run)]);
        expect(found.length, `${domain} has nothing to edit by hand`).toBeGreaterThan(0);
        for (const [id, view] of found) {
          for (const setting of view!.settings ?? []) {
            const patch = settingPatch(setting, another(setting));
            expect(run.check!([patch]), `${domain} ${id} ${setting.label}`).toBeNull();
            run.apply([patch]);
            const after = run.inspect(id)!.settings!.find((s) => s.label === setting.label)!;
            expect(after.value, `${domain} ${id} ${setting.label} didn't change`).toBe(another(setting));
          }
          for (const edit of view!.edits ?? []) expect(run.check!(edit.patches), `${domain} ${id} ${edit.label}`).toBeNull();
        }
      });

      it('refuses an edit to something that is not there', () => {
        const { run } = start(domain);
        const [, view] = editables(run, [SYSTEM, ...idsOf(domain, run)]).find(([, v]) => v!.settings?.some((s) => Object.keys(s.patch).length > 1))!;
        const setting = view!.settings!.find((s) => Object.keys(s.patch).length > 1)!;
        const field = Object.keys(setting.patch).find((k) => k !== 'op')!;
        const reason = run.check!([{ ...settingPatch(setting, another(setting)), [field]: 'nothing-called-this' }]);
        expect(reason).toMatch(/no|only/i);
      });

      it('replays hand edits to the same result', () => {
        const { d, model, run } = start(domain);
        for (const [, view] of editables(run, [SYSTEM, ...idsOf(domain, run)]).slice(0, 3)) {
          const setting = view!.settings?.[0];
          if (setting) run.apply([settingPatch(setting, another(setting))]);
          for (let i = 0; i < 5; i++) run.step();
        }
        for (let i = 0; i < 40; i++) run.step();
        const replay = evaluate(d, model, { seed: 7, ticks: run.tick, events: run.log });
        expect(replay.score).toBe(run.evaluation().score);
      });
    });
  }

  it('software refuses a second cache in front of the same service', () => {
    const { run } = start('software');
    const id = idsOf('software', run).find((n) => run.inspect(n)?.edits?.length)!;
    const edit = run.inspect(id)!.edits![0];
    run.apply(edit.patches);
    expect(run.check!(edit.patches)).toMatch(/already a cache/);
    expect(run.inspect(id)!.edits).toEqual([]);
  });

  it('a graph network refuses a link that would make a loop', () => {
    const { run } = start('power');
    const spec = (run as any).spec as { edges: Array<{ from: string; to: string }> };
    const edge = spec.edges[0];
    expect(run.check!([{ op: 'add_link', from: edge.to, to: edge.from }])).toMatch(/loop|already/);
  });
});
