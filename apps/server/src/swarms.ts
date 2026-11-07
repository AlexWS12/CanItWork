import type { Usage } from '@tv/core';
import { extractJson } from './llm';

const SWARMS_API = 'https://api.swarms.world/v1';
const DEFAULT_KEEP_USD = 5;

export interface SwarmAgent {
  agent_name: string;
  system_prompt: string;
}

const apiKey = () => process.env.SWARMS_API_KEY?.trim() ?? '';
export const councilModel = () => process.env.SWARMS_MODEL?.trim() || 'gemini/gemini-3.5-flash-lite';
export const redTeamModel = () => process.env.REDTEAM_MODEL?.trim() || 'gemini/gemini-3.5-flash-lite';

const halted = new Set<string>();

export const swarmsConfigured = (model: string) => Boolean(apiKey()) && !halted.has(model);

export function haltModel(model: string, reason: string) {
  halted.add(model);
  console.warn(`[swarms] ${model} off until restart:`, reason.slice(0, 300));
}

export function resetCouncil() {
  halted.clear();
}

async function assertBudget() {
  const keep = Number(process.env.SWARMS_KEEP_USD ?? DEFAULT_KEEP_USD);
  const res = await fetch(`${SWARMS_API}/account/credits`, {
    headers: { 'x-api-key': apiKey() },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Swarms balance unavailable: HTTP ${res.status}`);
  const body = (await res.json()) as { total_credits?: number; credit?: number };
  const balance = body.total_credits ?? body.credit ?? 0;
  if (balance <= keep) throw new Error(`Swarms budget floor reached: $${balance.toFixed(2)} left, keeping $${keep}`);
}

interface SwarmResponse {
  output?: unknown;
  execution_time?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_cost?: number;
    billing_info?: { total_cost?: number };
  };
}

function turns(output: unknown): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  const visit = (value: unknown, role: string) => {
    if (typeof value === 'string') out.push({ role, content: value });
    else if (Array.isArray(value)) value.forEach((v) => visit(v, role));
    else if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      const nextRole = typeof o.role === 'string' ? o.role : typeof o.agent_name === 'string' ? o.agent_name : role;
      if ('content' in o) visit(o.content, nextRole);
      else if ('text' in o) visit(o.text, nextRole);
      else Object.entries(o).forEach(([k, v]) => visit(v, role || k));
    }
  };
  visit(output, '');
  return out;
}

export async function runCouncil(opts: {
  name: string;
  task: string;
  model: string;
  agents: SwarmAgent[];
  feature: string;
  onUsage: (usage: Usage) => void;
}): Promise<Array<{ agent: string; json: unknown }>> {
  const { model } = opts;
  await assertBudget();
  const res = await fetch(`${SWARMS_API}/swarm/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey() },
    body: JSON.stringify({
      name: opts.name,
      description: 'Specialists proposing patches that a simulator scores',
      swarm_type: 'ConcurrentWorkflow',
      task: opts.task,
      max_loops: 1,
      agents: opts.agents.map((a) => ({
        agent_name: a.agent_name,
        system_prompt: a.system_prompt,
        model_name: model,
        max_tokens: 1200,
        temperature: 0.5,
        max_loops: 1,
      })),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Swarms: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as SwarmResponse;

  opts.onUsage({
    engine: 'swarms',
    model,
    via: 'swarms',
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    costUsd: body.usage?.total_cost ?? body.usage?.billing_info?.total_cost ?? null,
    costSavedUsd: null,
    cacheHit: null,
    routedModel: null,
    receipt: null,
    feature: opts.feature,
  });

  const names = opts.agents.map((a) => a.agent_name);
  const replies: Array<{ agent: string; json: unknown }> = [];
  const allTurns = turns(body.output);
  const crashed = allTurns.filter((t) => t.role.endsWith('(failed)'));
  if (crashed.length && crashed.length >= opts.agents.length) {
    haltModel(model, crashed[0].content);
    throw new Error(`Swarms agents crashed on ${model}. It stays off until the server restarts.`);
  }
  for (const turn of allTurns) {
    if (turn.role.endsWith('(failed)')) continue;
    const agent = names.find((n) => turn.role.includes(n)) ?? names.find((n) => turn.content.includes(n));
    try {
      const json = extractJson(turn.content);
      if (agent && !replies.some((r) => r.agent === agent)) replies.push({ agent, json });
      else if (!agent) replies.push({ agent: names[replies.length % names.length], json });
    } catch {
      continue;
    }
  }
  return replies;
}
