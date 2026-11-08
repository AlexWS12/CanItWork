import { DOMAINS, componentIds } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { ruleAdd } from '../src/fallback';

describe('ruleAdd', () => {
  it('copies the component a message names', () => {
    const spec = DOMAINS.software.rules.spec('web app with an api and a database');
    const nodes = (spec as { nodes: Array<{ id: string; label?: string }> }).nodes;
    const target = nodes[1];
    const result = ruleAdd(`add another ${target.label ?? target.id}`, 'software', spec);
    expect(result).not.toBeNull();
    expect(componentIds('software', result!.spec).length).toBe(nodes.length + 1);
  });

  it('ignores messages that do not ask for a component', () => {
    const spec = DOMAINS.software.rules.spec('web app');
    expect(ruleAdd('what is the latency', 'software', spec)).toBeNull();
    expect(ruleAdd('add a unicorn', 'software', spec)).toBeNull();
  });
});
