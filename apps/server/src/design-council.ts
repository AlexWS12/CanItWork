import type { Domain, Issue, StreamEvent, Usage } from '@tv/core';
import type { z } from 'zod';
import { councilModel, runCouncil, swarmsConfigured } from './swarms';

// Several Swarms architects design the same request in parallel, each with its own priorities, and the simulator picks the winner.
// Agents propose and the simulator decides, at design time as well as in the Red Team and the recovery council.

export const STRATEGIES = [
  { name: 'Literalist', brief: 'Build exactly what was described, with the fewest parts and nodes that make it work. Add nothing the request does not need.' },
  { name: 'Engineer', brief: 'Build it the way an experienced engineer would: correct values, protection and headroom so it works the first time and survives faults.' },
  { name: 'Builder', brief: 'Build it the way a person would really put it together, from common parts, components and services they can get today.' },
] as const;

export interface Candidate<D> {
  author: string;
  draft: D;
  score: number;
  issues: Issue[];
  verdict: string;
}

export const designCouncilModel = () => process.env.DESIGN_COUNCIL_MODEL?.trim() || councilModel();

// Turned off after a run that yields nothing usable, separately from the Red Team and recovery council on the same model.
let off = false;
export const resetDesignCouncil = () => {
  off = false;
};

// Opt-in, since every build then costs a Swarms run.
export const designCouncilOn = () => !off && process.env.DESIGN_COUNCIL?.trim().toLowerCase() === 'on' && swarmsConfigured(designCouncilModel());

export function leaderboard<D>(candidates: Candidate<D>[]) {
  return candidates.map((c) => `${c.author} ${c.verdict}`).join(' · ');
}

export async function runDesignCouncil<D>(opts: {
  prompt: string;
  domain: Domain;
  system: string;
  schema: z.ZodType<D>;
  score: (draft: D) => { score: number; issues: Issue[] } | null;
  onUsage: (usage: Usage) => void;
  emit: (event: StreamEvent) => void;
}): Promise<{ winner: Candidate<D>; candidates: Candidate<D>[] }> {
  const model = designCouncilModel();
  const replies = await runCouncil({
    name: 'Design Council',
    description: 'Architects designing the same system in parallel; a simulator scores each design and the best one is built',
    feature: 'design-council',
    model,
    maxTokens: 8000,
    onUsage: opts.onUsage,
    agents: STRATEGIES.map((s) => ({
      agent_name: s.name,
      system_prompt: `${opts.system}\nYour priority as the ${s.name}: ${s.brief}\nOther architects are designing the same request; a simulator runs every design and only the best one is built.`,
    })),
    task: opts.prompt,
  });

  const candidates: Candidate<D>[] = [];
  for (const reply of replies) {
    const parsed = opts.schema.safeParse(reply.json);
    if (!parsed.success) {
      candidates.push({ author: reply.agent, draft: undefined as D, score: -Infinity, issues: [], verdict: 'unreadable' });
      continue;
    }
    let scored: { score: number; issues: Issue[] } | null = null;
    try {
      scored = opts.score(parsed.data);
    } catch {
      scored = null;
    }
    if (!scored) {
      candidates.push({ author: reply.agent, draft: parsed.data, score: -Infinity, issues: [], verdict: "couldn't be simulated" });
      continue;
    }
    const errors = scored.issues.filter((i) => i.severity === 'error').length;
    const open = scored.issues.filter((i) => i.repair).length;
    const verdict = errors ? `rejected (${errors} error${errors > 1 ? 's' : ''})` : `${Math.round(scored.score)}${open ? ` with ${open} to fix` : ''}`;
    candidates.push({ author: reply.agent, draft: parsed.data, score: errors ? -1e6 + scored.score : scored.score, issues: scored.issues, verdict });
  }
  for (const s of STRATEGIES) {
    if (!candidates.some((c) => c.author === s.name)) candidates.push({ author: s.name, draft: undefined as D, score: -Infinity, issues: [], verdict: 'no design' });
  }
  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates.find((c) => Number.isFinite(c.score) && c.draft !== undefined);
  if (!winner) {
    off = true;
    throw new Error('The design council returned no usable designs. It stays off until the server restarts.');
  }
  return { winner, candidates };
}
