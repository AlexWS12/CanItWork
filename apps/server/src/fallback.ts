import { domainList, type Breakable, type Domain, type DomainId, type Incident } from '@tv/core';

export function routePrompt(prompt: string): DomainId | null {
  const scored = domainList()
    .map((domain) => ({ id: domain.id, score: prompt.match(new RegExp(domain.keywords, 'gi'))?.length ?? 0 }))
    .sort((a, b) => b.score - a.score);
  return scored[0].score ? scored[0].id : null;
}

export type RuleIntent =
  { intent: 'patch'; patches: unknown[]; reply: string } | { intent: 'inject' | 'whatif'; incident: Incident } | { intent: 'optimize' } | { intent: 'answer' };

function matchIncident(text: string, options: Breakable[]) {
  const scored = options
    .map((option) => ({
      option,
      score: (option.keywords ?? [option.label.toLowerCase()]).filter((k) => k && text.includes(k)).length,
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].option : null;
}

export function ruleChat(message: string, domain: Domain, model: unknown, options: Breakable[]): RuleIntent {
  const text = message.toLowerCase();
  if (/reorgani[sz]e|congestion|optimi[sz]e|efficien|improve|better setup/.test(text)) return { intent: 'optimize' };
  const patch = domain.rules.patch?.(text, model);
  if (patch) return { intent: 'patch', ...patch };
  const match = matchIncident(text, options);
  if (!match) return { intent: 'answer' };
  const hypothetical = /what (happens|if)|what would|would happen/.test(text);
  const breaks = /fail|stop|die|break|broke|down|crash|offline|kill|block|jam|stuck|loose|short|burn|spike|surge|lock|drop/.test(text);
  if (hypothetical) return { intent: 'whatif', incident: match.incident };
  return breaks ? { intent: 'inject', incident: match.incident } : { intent: 'answer' };
}
