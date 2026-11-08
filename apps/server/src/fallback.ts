import { componentIds, domainList, editSpec, isEditable, type Breakable, type Domain, type DomainId, type Incident } from '@tv/core';

export function routePrompt(prompt: string): DomainId | null {
  const scored = domainList()
    .map((domain) => ({ id: domain.id, score: prompt.match(new RegExp(domain.keywords, 'gi'))?.length ?? 0 }))
    .sort((a, b) => b.score - a.score);
  return scored[0].score ? scored[0].id : null;
}

export type RuleIntent =
  | { intent: 'patch'; patches: unknown[]; reply: string }
  | { intent: 'respec'; spec: unknown; reply: string }
  | { intent: 'inject' | 'whatif'; incident: Incident }
  | { intent: 'optimize' }
  | { intent: 'answer' };

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
const stem = (word: string) => word.replace(/(es|s)$/, '');

// "Add another barista" or "duplicate the cache" without Gemini: copies the component the message names, links and all.
// Naming a kind ("add a gate") copies the first component of that kind.
export function ruleAdd(text: string, domain: DomainId, spec: unknown): { spec: unknown; reply: string } | null {
  if (!isEditable(domain) || !/\b(add|another|extra|duplicate|copy|clone|second|one more|new)\b/.test(text)) return null;
  const said = new Set(words(text).map(stem));
  const ids = componentIds(domain, spec);
  const nodes: Array<{ id: string; label?: string; kind?: string }> =
    domain === 'database' ? ids.map((id) => ({ id })) : (spec as { nodes: Array<{ id: string; label?: string; kind?: string }> }).nodes;
  const named = (name: string | undefined) => {
    const parts = name ? words(name).map(stem) : [];
    return parts.length > 0 && parts.every((w) => said.has(w)) ? parts.length : 0;
  };
  const scored = nodes
    .map((n) => ({ node: n, score: Math.max(named(n.id), named(n.label)) * 2 + named(n.kind) }))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score);
  const target = scored[0]?.node;
  if (!target) return null;
  const result = editSpec(domain, spec, { op: 'duplicate', id: target.id });
  if (!result.ok) return null;
  return { spec: result.spec, reply: `Added ${result.label}, a copy of ${target.label ?? target.id} with the same links.` };
}

function matchIncident(text: string, options: Breakable[]) {
  const scored = options
    .map((option) => ({
      option,
      score: (option.keywords ?? [option.label.toLowerCase()]).filter((k) => k && text.includes(k)).length,
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].option : null;
}

export function ruleChat(message: string, domain: Domain, model: unknown, options: Breakable[], spec?: unknown): RuleIntent {
  const text = message.toLowerCase();
  if (/reorgani[sz]e|congestion|optimi[sz]e|efficien|improve|better setup/.test(text)) return { intent: 'optimize' };
  const patch = domain.rules.patch?.(text, model);
  if (patch) return { intent: 'patch', ...patch };
  const added = spec === undefined ? null : ruleAdd(text, domain.id, spec);
  if (added) return { intent: 'respec', ...added };
  const match = matchIncident(text, options);
  if (!match) return { intent: 'answer' };
  const hypothetical = /what (happens|if)|what would|would happen/.test(text);
  const breaks = /fail|stop|die|break|broke|down|crash|offline|kill|block|jam|stuck|loose|short|burn|spike|surge|lock|drop/.test(text);
  if (hypothetical) return { intent: 'whatif', incident: match.incident };
  return breaks ? { intent: 'inject', incident: match.incident } : { intent: 'answer' };
}
