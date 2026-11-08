import { describe, expect, it } from 'vitest';
import { DOMAINS, EDITABLE, componentDiff, componentIds, editSpec, evaluate, type DomainId } from '../src';

describe.each([...EDITABLE].map((id) => [id] as [DomainId]))('%s supports edits from the view', (id) => {
  const domain = DOMAINS[id];
  const spec = domain.rules.spec(domain.examples[0]);
  const ids = componentIds(id, spec);

  it('duplicates a component with its links, and the copy still simulates', () => {
    const target = ids[Math.min(1, ids.length - 1)];
    const result = editSpec(id, spec, { op: 'duplicate', id: target });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(componentDiff(id, spec, result.spec)).toEqual({ added: [result.id], removed: [] });
    const model = domain.compile(result.spec);
    expect(domain.validate(model).filter((i) => i.severity === 'error')).toEqual([]);
    expect(() => evaluate(domain, model, { seed: 1, ticks: 50, events: [] })).not.toThrow();
  });

  it('removes a component and every link to it', () => {
    const target = ids[ids.length - 1];
    const result = editSpec(id, spec, { op: 'remove', id: target });
    if (!result.ok) return expect(result.reason).toBeTruthy();
    expect(componentIds(id, result.spec)).not.toContain(target);
    expect(JSON.stringify(result.spec)).not.toMatch(new RegExp(`"(from|to|table)":"${target}"`));
  });

  it('refuses an unknown component', () => {
    expect(editSpec(id, spec, { op: 'remove', id: 'no-such-part' }).ok).toBe(false);
  });
});

describe('editSpec', () => {
  it('gives every copy a fresh id', () => {
    const spec = DOMAINS.queues.rules.spec('coffee shop');
    const node = componentIds('queues', spec)[1];
    const once = editSpec('queues', spec, { op: 'duplicate', id: node });
    if (!once.ok) throw new Error(once.reason);
    const twice = editSpec('queues', once.spec, { op: 'duplicate', id: node });
    if (!twice.ok) throw new Error(twice.reason);
    expect(new Set(componentIds('queues', twice.spec)).size).toBe(componentIds('queues', twice.spec).length);
    expect(twice.id).not.toBe(once.id);
  });

  it('refuses domains that are not drawn as a graph', () => {
    expect(editSpec('electronics', DOMAINS.electronics.rules.spec('a bulb'), { op: 'remove', id: 'B1' }).ok).toBe(false);
  });
});
