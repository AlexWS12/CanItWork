import { DOMAINS, componentIds, type Environment, type StreamEvent } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { chat, edit } from '../src/agents';
import { isolateEnv } from './helpers';

isolateEnv();

const collect = () => {
  const events: StreamEvent[] = [];
  return { events, emit: (e: StreamEvent) => void events.push(e) };
};
const replyOf = (events: StreamEvent[]) => events.find((e) => e.type === 'reply') as Extract<StreamEvent, { type: 'reply' }>;

describe('edits from the 3D view', () => {
  const spec = DOMAINS.hospital.rules.spec('an emergency room');
  const environment: Environment = { domain: 'hospital', name: 'ER', summary: 's', spec, unmodelled: [], layout: { [componentIds('hospital', spec)[0]]: [3, 4] } };
  const stage = componentIds('hospital', spec)[1];

  it('checks a duplicate with the validator and simulator, then rebuilds with the copy', async () => {
    const { events, emit } = collect();
    await edit({ environment, edit: { op: 'duplicate', id: stage } }, emit);
    const agents = events.flatMap((e) => (e.type === 'step' && e.status === 'done' ? [e.agent] : []));
    expect(agents).toEqual(['validator', 'simulator']);
    const { action, text } = replyOf(events);
    expect(action.kind).toBe('rebuild');
    if (action.kind !== 'rebuild') return;
    expect(action.added).toHaveLength(1);
    expect(action.environment.layout).toEqual(environment.layout);
    expect(text).toMatch(/^Added /);
  });

  it('keeps the design when a delete would break it', async () => {
    const { events, emit } = collect();
    const nodes = (spec as { nodes: Array<{ id: string }> }).nodes;
    const edges = (spec as { edges: Array<{ from: string; to: string }> }).edges;
    // Two components and the link between them: deleting either leaves nothing to simulate
    const pair = { nodes: nodes.filter((n) => n.id === edges[0].from || n.id === edges[0].to), edges: [edges[0]] };
    await edit({ environment: { ...environment, spec: pair }, edit: { op: 'remove', id: edges[0].from } }, emit);
    const { action, text } = replyOf(events);
    expect(action.kind).toBe('none');
    expect(text).toMatch(/^I kept the design as it was/);
  });

  it('adds a component from chat without Gemini', async () => {
    const { events, emit } = collect();
    const node = (spec as { nodes: Array<{ id: string; label?: string }> }).nodes[1];
    await chat({ environment, seed: 1, tick: 10, events: [], metrics: {}, message: `add another ${node.label ?? node.id}` }, emit);
    const { action } = replyOf(events);
    expect(action.kind).toBe('rebuild');
    if (action.kind === 'rebuild') expect(action.added).toHaveLength(1);
  });
});
