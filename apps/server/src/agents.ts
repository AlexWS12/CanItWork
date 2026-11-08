import {
  DOMAINS,
  IncidentSchema,
  defaultCompare,
  domainList,
  evaluate,
  type AgentId,
  type Candidate,
  type Domain,
  type DomainId,
  type Engine,
  type Environment,
  type Evaluation,
  type Finding,
  type Hypothesis,
  type Incident,
  type RecoveryReport,
  type StepEvent,
  type StreamEvent,
  type TimedEvent,
  type Usage,
} from '@tv/core';
import { choice, noul, type Questions } from '@typesafe-ai/sdk';
import { z } from 'zod';
import { routePrompt, ruleChat } from './fallback';
import { askJev, hasJev } from './jev';
import { NoCredentials, ShieldBlock, architectModel, chatJson, hasGemini, repairModel } from './llm';
import { forget, lookup, markStale, remember } from './design-cache';
import { designCouncilOn, leaderboard, runDesignCouncil } from './design-council';
import { councilModel, redTeamModel, runCouncil, swarmsConfigured } from './swarms';

export type Emit = (event: StreamEvent) => void;
type Step = ReturnType<typeof stepper>;

const MAX_REPAIRS = 3;
const DOMAIN_IDS = domainList().map((d) => d.id) as [DomainId, ...DomainId[]];

// Starting points for Jev's routing; tune them with `npm run eval:interpreter`.
const JEV = {
  routeConfidence: 0.6, // the Choice is concentrated enough on one domain
  routeFits: 0.7, // and that domain's simulator likely models the request
  refuseFits: 0.3, // no domain reaches this, so nothing fits; otherwise an unconfident pick is unsure
  closestFits: 0.2, // worth naming as the nearest domain in a refusal
  aloneFits: 0.5, // without Gemini to ask, route the best-fitting domain only above this
};

type StepExtra = Pick<StepEvent, 'odds'>;

function stepper(emit: Emit) {
  let n = 0;
  return async function step<T>(
    agent: AgentId,
    engine: Engine,
    title: string,
    work: (setDetail: (d: string) => void, setExtra: (extra: StepExtra) => void) => Promise<T>,
  ): Promise<T> {
    const id = `${agent}-${++n}`;
    const start = performance.now();
    const ms = () => Math.round(performance.now() - start);
    emit({ type: 'step', id, agent, engine, title, status: 'running' });
    await new Promise((resolve) => setImmediate(resolve));
    let detail: string | undefined;
    let extra: StepExtra = {};
    try {
      const result = await work(
        (d) => (detail = d),
        (e) => (extra = { ...extra, ...e }),
      );
      emit({ type: 'step', id, agent, engine, title, status: 'done', detail, ms: ms(), ...extra });
      return result;
    } catch (error) {
      emit({ type: 'step', id, agent, engine, title, status: 'failed', detail: shortError(error), ms: ms(), ...extra });
      throw error;
    }
  };
}

function shortError(error: unknown) {
  const message = String((error as Error)?.message ?? error);
  return message.match(/^.*?HTTP \d+/)?.[0] ?? message.slice(0, 120);
}

async function orRules<T>(live: () => Promise<T>, rules: () => Promise<T>): Promise<T> {
  try {
    return await live();
  } catch (error) {
    if (error instanceof ShieldBlock) throw error;
    return rules();
  }
}

const onUsage = (emit: Emit) => (usage: Usage) => emit({ type: 'usage', usage });

function baselineOf(domain: Domain, model: unknown, ticks: number, events: TimedEvent[]): Evaluation {
  const runs = Array.from({ length: domain.seeds }, (_, i) => evaluate(domain, model, { seed: i + 1, ticks, events }));
  const score = runs.reduce((sum, r) => sum + r.score, 0) / runs.length;
  return { ...runs[0], score: Math.round(score * 10) / 10 };
}

function testClaim(domain: Domain, model: unknown, base: Evaluation, claim: Hypothesis): Finding {
  const at = Math.floor(domain.horizon * 0.2);
  // A claim with a setup is judged against the same setup without the incident, so only the incident's own effect counts.
  const setup: TimedEvent[] = (claim.setup ?? []).map((incident) => ({ at: 0, incident }));
  const before = setup.length ? baselineOf(domain, model, domain.horizon, setup) : base;
  const after = baselineOf(domain, model, domain.horizon, [...setup, { at, incident: claim.incident }]);
  const { hurt, evidence } = domain.compare?.(before, after, claim.incident) ?? defaultCompare(before, after);
  const given = claim.setup?.length ? `With ${claim.setup.map((i) => `${i.target}${i.value !== undefined ? ` at ${i.value}` : ''}`).join(', ')}: ` : '';
  return { claim: claim.claim, incident: claim.incident, verdict: hurt ? 'confirmed' : 'refuted', evidence: `${given}${humanize(claim.incident)}: ${evidence}` };
}

const describeCapabilities = () =>
  domainList()
    .map((d) => `- ${d.id}: ${d.capabilities} It cannot do: ${d.limits.join('; ')}.`)
    .join('\n');

type Reading = { kind: 'route'; id: DomainId } | { kind: 'refuse'; reason: string; closest: DomainId | null } | { kind: 'defer' };

function refusalReason(closest: DomainId | null) {
  if (!closest)
    return `None of these simulators can model that. CanItWork builds ${domainList()
      .map((d) => d.label.toLowerCase())
      .join(', ')}.`;
  const domain = DOMAINS[closest];
  return `None of these simulators can model that. The closest is ${domain.label.toLowerCase()}, which can't model: ${domain.limits.slice(0, 2).join('; ')}.`;
}

export interface DomainAnswers {
  pick: DomainId | null;
  confidence: number;
  probabilities: Record<string, number>;
  fits: Record<DomainId, number>;
}

// One Jev request: a Choice of domain, plus a Noul per domain on whether its simulator fits, asked in parallel.
export async function askDomain(prompt: string, onUsage: (usage: Usage) => void): Promise<DomainAnswers> {
  const domains = domainList();
  const questions: Questions = {
    domain: choice(
      'Which simulator in `domains` can genuinely model the system the user describes in `request`? Judge by what the user wants to explore, not by words the request shares with a domain.',
      {
        ...Object.fromEntries(domains.map((d) => [d.id, `${d.label}: ${d.capabilities}`])),
        none: 'None of the simulators in `domains` can model what the user wants to explore, even if some words overlap with one of them.',
      },
    ),
    ...Object.fromEntries(
      domains.map((d) => [
        `fits_${d.id}`,
        noul(`Can the ${d.label} simulator in \`domains\` model the core of what the user wants to explore in \`request\`, even if some details would be left out?`),
      ]),
    ),
  };
  const answers = await askJev({
    feature: 'interpreter',
    onUsage,
    state: { request: prompt, domains: domains.map((d) => ({ id: d.id, name: d.label, can_model: d.capabilities, cannot_model: d.limits })) },
    questions,
  });
  const pick = answers.domain;
  if (pick?.type !== 'choice') throw new Error('Jev returned no domain choice');
  const fits = Object.fromEntries(
    DOMAIN_IDS.map((id) => {
      const answer = answers[`fits_${id}`];
      return [id, answer?.type === 'noul' ? answer.noul : 0];
    }),
  ) as Record<DomainId, number>;
  return { pick: pick.choice === 'none' ? null : (pick.choice as DomainId), confidence: pick.confidence, probabilities: pick.probabilities, fits };
}

// Routing policy over Jev's answers. With canDefer, unsure cases go to Gemini instead of being decided here.
export function decideDomain(read: DomainAnswers, canDefer: boolean): Reading & { detail: string } {
  const { pick: top, fits } = read;
  const percent = (p: number) => `${Math.round(p * 100)}%`;
  const best = [...DOMAIN_IDS].sort((a, b) => fits[b] - fits[a])[0];
  const closest = fits[best] >= JEV.closestFits ? best : null;
  const route = (id: DomainId, p: number) => ({ kind: 'route' as const, id, detail: `${DOMAINS[id].label} (${percent(p)})` });
  const refuse = () => ({
    kind: 'refuse' as const,
    reason: refusalReason(closest),
    closest,
    detail: closest ? `Nothing fits; closest is ${DOMAINS[closest].label} (${percent(fits[closest])})` : 'Nothing fits',
  });

  if (top && read.confidence >= JEV.routeConfidence && fits[top] >= JEV.routeFits) return route(top, read.probabilities[top] ?? 0);
  // A 'none' pick still defers when one domain partly fits: a factory line came back none at 69%, with warehouse at 42%.
  if (fits[best] < JEV.refuseFits) return refuse();
  if (canDefer) return { kind: 'defer', detail: `Unsure: ${DOMAINS[best].label} at ${percent(fits[best])}, asking Gemini` };
  return fits[best] >= JEV.aloneFits ? route(best, fits[best]) : refuse();
}

async function interpret(prompt: string, emit: Emit, step: Step): Promise<DomainId | null> {
  const refuse = (reason: string, closest: DomainId | null = null) => {
    emit({ type: 'refusal', refusal: { reason, closest } });
    return null;
  };
  const rules = () =>
    step('interpreter', 'rules', 'Identifying the domain', async (detail) => {
      const id = routePrompt(prompt);
      if (!id) return refuse("That isn't something the local rules recognise as a supported system.");
      detail(DOMAINS[id].label);
      return id;
    });
  const gemini = () => (hasGemini() ? orRules(() => geminiInterpret(prompt, emit, step, refuse), rules) : rules());
  if (!hasJev()) return gemini();
  const reading = await step('interpreter', 'jev', 'Identifying the domain', async (detail, extra) => {
    const answers = await askDomain(prompt, onUsage(emit));
    extra({ odds: Object.fromEntries(DOMAIN_IDS.map((id) => [id, answers.probabilities[id] ?? 0])) });
    const reading = decideDomain(answers, hasGemini());
    detail(reading.detail);
    return reading;
  }).catch(() => null);
  if (reading?.kind === 'route') return reading.id;
  if (reading?.kind === 'refuse') return refuse(reading.reason, reading.closest);
  return gemini();
}

function geminiInterpret(prompt: string, emit: Emit, step: Step, refuse: (reason: string, closest?: DomainId | null) => null) {
  const schema = z.object({
    domain: z.enum(DOMAIN_IDS).nullable(),
    reason: z.string(),
    closest: z.enum(DOMAIN_IDS).nullable().optional(),
  });
  return step('interpreter', 'gemini', 'Identifying the domain', async (detail) => {
    const result = await chatJson({
      feature: 'interpreter',
      schema,
      onUsage: onUsage(emit),
      system: `You route requests for a platform that turns descriptions of systems into working simulations. It has these domains:
${describeCapabilities()}
Pick the domain whose simulator can genuinely model what the user wants to explore. If the heart of the request fits a domain but parts of it don't, still pick that domain, because the next step records what was left out. People often describe a product by what it does rather than how it is built: an app, website, API or platform is a request to model its software architecture, a gadget or device is a request to model its circuit, and data to store is a request to model its schema, so route those to that domain. When no domain matches the words but one simulates the same dynamics, pick it and let the next step record what is abstracted: a satellite constellation relaying data is a fleet passing messages through a radio network, an ant colony foraging is a search-and-deliver swarm, and security lines, elevators, toll booths or an intersection are arrivals queuing to be served at stations. Refuse only when the dynamics themselves (physics, chemistry, biology, markets) are beyond every simulator. Never force a request into a domain just because a word overlaps: when the thing the user wants to explore can't be modelled at all, use domain null rather than a misleading model.
Reply with JSON only: {"domain": one of ${DOMAIN_IDS.join(', ')} or null, "reason": "one sentence", "closest": a domain id or null}.
When domain is null, "reason" says plainly what is missing and "closest" names the nearest domain, if any is useful.`,
      user: prompt,
    });
    if (!result.domain) return refuse(result.reason, result.closest ?? null);
    detail(`${DOMAINS[result.domain].label}: ${result.reason}`);
    return result.domain;
  });
}

interface Draft {
  name: string;
  summary: string;
  unmodelled: string[];
  spec: unknown;
}

const draftSchema = (domain: Domain) =>
  z.object({
    name: z.string().min(1).max(60),
    summary: z.string().max(280),
    unmodelled: z.array(z.string()).default([]),
    spec: domain.specSchema,
  });

const architectPrompt = (domain: Domain) => `You are the Architect. You turn descriptions into ${domain.label.toLowerCase()} environments that a simulator runs.
What it can do: ${domain.capabilities}
Reply with JSON only: {"name": a short title, "summary": one sentence, "unmodelled": [anything the user asked for that this cannot represent], "spec": Spec}
Spec:
${domain.specDoc}
Honour every number the user gives, and choose every unstated value to fit those numbers: a 30-bed ER gets the arrivals a 30-bed ER sees, not a city hospital's, unless the user says it is overwhelmed. Be honest in "unmodelled": never pretend to represent something you left out.`;

// Scores a candidate design the way the pipeline judges it: errors disqualify, open problems cost points, the baseline decides the rest.
function scoreDraft(domain: Domain, draft: Draft) {
  const model = domain.compile(draft.spec);
  const issues = domain.validate(model);
  if (issues.some((i) => i.severity === 'error')) return { score: 0, issues };
  const open = issues.filter((i) => i.repair).length;
  return { score: baselineOf(domain, model, domain.horizon, []).score - 20 * open, issues };
}

async function councilDesign(prompt: string, domain: Domain, emit: Emit, step: Step): Promise<Draft | null> {
  if (!designCouncilOn()) return null;
  try {
    return await step('architect', 'swarms', 'Convening the design council', async (detail) => {
      const { winner, candidates } = await runDesignCouncil<Draft>({
        prompt,
        domain,
        system: architectPrompt(domain),
        schema: draftSchema(domain) as unknown as z.ZodType<Draft>,
        score: (draft) => scoreDraft(domain, draft),
        mend: hasGemini()
          ? async (raw, problem) =>
              (await chatJson({
                feature: 'design-council-mend',
                schema: draftSchema(domain),
                onUsage: onUsage(emit),
                system: architectPrompt(domain),
                user: `Another architect wrote this design for "${prompt}", but it doesn't match the schema: ${problem}
Design: ${JSON.stringify(raw).slice(0, 12000)}
Return the same design, corrected to match the schema exactly. Change nothing else.`,
              })) as Draft
          : undefined,
        onUsage: onUsage(emit),
        emit,
      });
      detail(`${leaderboard(candidates)}. The simulator picked the ${winner.author}'s design`);
      return winner.draft;
    });
  } catch (error) {
    if (error instanceof ShieldBlock) throw error;
    return null;
  }
}

async function architect(prompt: string, domain: Domain, emit: Emit, step: Step): Promise<Draft | null> {
  if (!hasGemini()) {
    return step('architect', 'rules', 'Drafting from a template', async (detail) => {
      detail(`Local ${domain.label.toLowerCase()} template`);
      return {
        name: `${domain.label} template`,
        summary: 'A built-in example, because no AI is connected to design what you described.',
        unmodelled: ['This is a built-in template, not a design of your request'],
        spec: domain.rules.spec(prompt),
      };
    });
  }
  try {
    return await step('architect', 'gemini', 'Designing the environment', async (detail) => {
      const draft = (await chatJson({
        feature: 'architect',
        model: architectModel(),
        schema: draftSchema(domain),
        onUsage: onUsage(emit),
        system: architectPrompt(domain),
        user: prompt,
      })) as Draft;
      detail(draft.name);
      return draft;
    });
  } catch (error) {
    if (error instanceof ShieldBlock) throw error;
    emit({
      type: 'refusal',
      refusal: { reason: "The design step failed, so I haven't built anything rather than show you the wrong thing. Please try again.", closest: domain.id },
    });
    return null;
  }
}

async function hypotheses(domain: Domain, model: unknown, baseline: Evaluation, issues: string[], emit: Emit, step: Step): Promise<Hypothesis[]> {
  const rules = () =>
    step('redteam', 'rules', 'Looking for weak points', async (detail) => {
      const found = domain.rules.hypotheses(model);
      detail(`${found.length} structural risks`);
      return found;
    });
  const redTeam = redTeamModel();
  if (!swarmsConfigured(redTeam)) return rules();
  const schema = z.object({
    hypotheses: z
      .array(z.object({ claim: z.string(), incident: IncidentSchema, setup: z.array(IncidentSchema).max(8).optional() }))
      .min(1)
      .max(3),
  });
  return orRules(
    () =>
      step('redteam', 'swarms', 'Attacking the design', async (detail) => {
        const replies = await runCouncil({
          name: 'Red Team',
          feature: 'red-team',
          model: redTeam,
          onUsage: onUsage(emit),
          agents: [
            {
              agent_name: 'RedTeam',
              system_prompt: `You are the Red Team. Another AI designed this ${domain.label.toLowerCase()} environment; your job is to find how it breaks. Be specific and sceptical.
Each hypothesis is tested in a real simulator, so a vague or wrong claim will be publicly refuted.
Only the incident is simulated, so state each claim as what happens when that incident occurs, such as "If R1 shorts, D1 burns out", never as a flaw the incident doesn't cause.
Reply with JSON only: {"hypotheses":[{"claim":"one sentence naming the specific weakness","incident":Incident,"setup"?:[Incident]}]} with 1-3 items. "setup" holds conditions applied from the start, before the incident, such as setting inputs or readings so the outputs you attack are active; leave it out when the default state already shows the failure.
Incident is one of:
${domain.incidentDoc}
Use only ids that exist in the system.`,
            },
          ],
          task: `System: ${domain.describe(model)}\n${baseline.scoreLabel}: ${baseline.score}\nKnown warnings: ${issues.join('; ') || 'none'}`,
        });
        const parsed = schema.safeParse(replies[0]?.json);
        // A malformed reply is a one-off slip, so this request falls back to rules and the next one tries again. Only crashes turn a model off.
        if (!parsed.success) throw new Error('Red Team returned no usable hypotheses');
        const claims = parsed.data.hypotheses.filter((h) => domain.incidentTypes.includes(h.incident.type));
        if (!claims.length) throw new Error('Red Team proposed no failures the simulator can run');
        detail(`${claims.length} hypotheses to test`);
        return claims;
      }),
    rules,
  );
}

// A cached design for this exact prompt that still parses and still passes every check, or null.
// One that no longer does is marked stale, so this request and later ones go to the Architect instead of repairing it.
export function servedFromCache(prompt: string): { id: DomainId; draft: Draft } | null {
  const hit = lookup(prompt);
  if (!hit) return null;
  const domain = DOMAINS[hit.domain];
  const parsed = draftSchema(domain).safeParse(hit.draft);
  let passes = false;
  try {
    passes = parsed.success && !domain.validate(domain.compile(parsed.data.spec)).some((i) => i.severity === 'error' || i.repair);
  } catch {
    passes = false;
  }
  if (!passes) {
    markStale(prompt);
    return null;
  }
  return { id: hit.domain, draft: parsed.data as Draft };
}

async function cachedDesign(prompt: string, step: Step): Promise<{ id: DomainId; draft: Draft } | null> {
  const served = servedFromCache(prompt);
  if (!served) return null;
  const { draft } = served;
  await step('architect', 'cache', 'Reusing a verified design', async (detail) => detail(`${draft.name}, which passed every check for this exact request before`));
  return served;
}

export async function build(prompt: string, emit: Emit) {
  const step = stepper(emit);
  const cached = await cachedDesign(prompt, step);
  const id = cached?.id ?? (await interpret(prompt, emit, step));
  if (!id) return;
  const domain = DOMAINS[id];
  const first = cached?.draft ?? (await councilDesign(prompt, domain, emit, step)) ?? (await architect(prompt, domain, emit, step));
  if (!first) return;
  let draft = first;

  const check = (candidate: Draft) => domain.validate(domain.compile(candidate.spec));
  let issues = await step('validator', 'simulator', 'Checking the design', async (detail) => {
    const found = check(draft);
    detail(
      found.length
        ? found
            .map((i) => i.message)
            .slice(0, 4)
            .join('; ')
        : 'No problems found',
    );
    return found;
  });
  const errorsOf = () => issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const toRepair = () => issues.filter((i) => i.severity === 'error' || i.repair).map((i) => i.message);

  for (let attempt = 0; attempt < MAX_REPAIRS && toRepair().length && hasGemini(); attempt++) {
    const previous = draft;
    const found = toRepair();
    draft = await orRules(
      () =>
        step('architect', 'gemini', 'Fixing what the checks found', async (detail) => {
          detail(`${found.length > 1 ? `${found.length} problems, first: ` : ''}${found[0].length > 160 ? `${found[0].slice(0, 157)}...` : found[0]}`);
          return (await chatJson({
            feature: 'architect-repair',
            model: repairModel(),
            schema: draftSchema(domain),
            onUsage: onUsage(emit),
            system: architectPrompt(domain),
            user: `Request: ${prompt}\nYour previous design: ${JSON.stringify(previous)}\nThe checks found: ${found.join('; ')}\nReturn a corrected design. Every number the user stated (counts, sizes, rates, voltages) is fixed: never change it to silence a check. Values the user did not state are yours to change. When a check finds overload, first add capacity the user didn't fix (more units, servers, lanes or lines, bigger buffers, a stronger supply). Lower unstated loads (arrival rates, demand, call volume, current draw) only when every size is stated, and when the user described a heavy load in words (a rush, peak hour, busy, Black Friday) keep it heavy: the busiest part should still run at 85-95%. Keep a problem only if the user asked to see it, such as a system they said is overwhelmed, or if nothing you may change can fix it. Fix everything else. The summary describes the system as built; don't mention the checks or what you changed.`,
          })) as Draft;
        }),
      async () => previous,
    );
    issues = await step('validator', 'simulator', 'Rechecking the design', async (detail) => {
      const result = check(draft);
      detail(
        result.length
          ? result
              .map((i) => i.message)
              .slice(0, 4)
              .join('; ')
          : 'No problems found',
      );
      return result;
    });
  }
  if (errorsOf().length) {
    if (cached) forget(prompt);
    emit({ type: 'refusal', refusal: { reason: `I couldn't build a valid design: ${errorsOf().slice(0, 3).join('; ')}.`, closest: id } });
    return;
  }

  const unresolved = issues.filter((i) => i.repair).map((i) => `Still failing the checks: ${i.message}`);
  const proof = !unresolved.length && domain.proof ? domain.proof(domain.compile(draft.spec)) : null;
  if (!unresolved.length && hasGemini() && draft !== cached?.draft) remember(prompt, { domain: id, draft });
  if (proof) await step('validator', 'simulator', 'Proving it works', async (detail) => detail(proof));
  const environment: Environment = { domain: id, name: draft.name, summary: draft.summary, spec: draft.spec, unmodelled: [...unresolved, ...draft.unmodelled] };
  emit({ type: 'environment', environment });
  const model = domain.compile(draft.spec);

  const baseline = await step('simulator', 'simulator', 'Running the baseline', async (detail) => {
    const result = baselineOf(domain, model, domain.horizon, []);
    detail(`${result.score} ${result.scoreLabel}`);
    return result;
  });
  const claims = await hypotheses(
    domain,
    model,
    baseline,
    issues.map((i) => i.message),
    emit,
    step,
  );
  const findings = await step('simulator', 'simulator', 'Testing each claim', async (detail) => {
    const tested = claims.map((c) => testClaim(domain, model, baseline, c));
    detail(`${tested.filter((f) => f.verdict === 'confirmed').length} of ${tested.length} confirmed`);
    return tested;
  });
  emit({ type: 'findings', findings });
}

async function proposals(domain: Domain, model: unknown, incident: string, last: Incident | undefined, tick: number, emit: Emit, step: Step) {
  const rules = () =>
    step('council', 'rules', 'Listing recovery options', async (detail) => {
      const found = domain.rules.recoveries(model, last);
      detail(`${found.length} options`);
      return found;
    });
  const council = councilModel();
  if (!swarmsConfigured(council)) return rules();
  const schema = z.object({ title: z.string(), rationale: z.string(), patches: z.array(domain.patchSchema).min(1).max(4) });
  return orRules(
    () =>
      step('council', 'swarms', 'Convening the recovery council', async (detail) => {
        const replies = await runCouncil({
          name: 'Recovery Council',
          feature: 'recovery-council',
          model: council,
          onUsage: onUsage(emit),
          agents: domain.council.map((c) => ({
            agent_name: c.name,
            system_prompt: `You are ${c.name} on a recovery council for this ${domain.label.toLowerCase()} environment. Your specialty is ${c.brief}.
Propose the single recovery you believe gives the best result. It will be simulated and ranked against the others, so don't overlap with them.
Reply with JSON only: {"title":"short name","rationale":"one sentence","patches":[Patch]}
Patch is one of:
${domain.patchDoc}`,
          })),
          task: `Incident at tick ${tick}: ${incident}\nSystem: ${domain.describe(model)}`,
        });
        const parsed = replies.flatMap((r) => {
          const proposal = schema.safeParse(r.json);
          return proposal.success ? [{ author: r.agent, ...proposal.data }] : [];
        });
        if (!parsed.length) throw new Error('Swarms returned no usable proposals');
        detail(`${parsed.length} proposals from ${replies.length} specialists`);
        return parsed;
      }),
    rules,
  );
}

const humanize = (incident: Incident | undefined) => {
  if (!incident) return 'A recovery plan was requested';
  const words = incident.type.replace(/_/g, ' ');
  const text = `${words}${incident.target ? `: ${incident.target}` : ''}`;
  return text[0].toUpperCase() + text.slice(1);
};

interface LiveState {
  environment: Environment;
  seed: number;
  events: TimedEvent[];
  tick: number;
}

export async function recover(input: LiveState, emit: Emit) {
  const { environment, seed, tick, events } = input;
  const domain = DOMAINS[environment.domain];
  const model = domain.compile(environment.spec);
  const step = stepper(emit);
  const incidents = events.flatMap((e) => ('incident' in e ? [e.incident] : []));
  const last = incidents[incidents.length - 1];
  const incident = humanize(last);
  const ticks = Math.max(tick + Math.floor(domain.horizon * 0.6), domain.horizon);
  const applyAt = tick + domain.responseDelay;

  const proposed = await proposals(domain, model, incident, last, tick, emit, step);
  const distinct = proposed.filter((p, i) => proposed.findIndex((o) => JSON.stringify(o.patches) === JSON.stringify(p.patches)) === i);
  const ranked = await step('simulator', 'simulator', `Simulating ${distinct.length} recoveries`, async (detail) => {
    const candidates: Candidate[] = distinct.map((p, i) => ({
      id: `c${i + 1}`,
      author: p.author,
      title: p.title,
      rationale: p.rationale,
      patches: p.patches,
      evaluation: evaluate(domain, model, { seed, ticks, events: [...events, { at: applyAt, patches: p.patches }] }),
    }));
    candidates.sort((a, b) => b.evaluation.score - a.evaluation.score);
    detail(candidates.map((c) => `${c.title}: ${c.evaluation.score}`).join(' · '));
    return candidates;
  });

  const reference = evaluate(domain, model, { seed, ticks, events: [] });
  const unmitigated = evaluate(domain, model, { seed, ticks, events });
  const winner = ranked[0] ?? null;
  const unit = reference.scoreLabel;
  const fallback = winner
    ? `${winner.title} scores ${winner.evaluation.score} ${unit}, against ${unmitigated.score} doing nothing and ${reference.score} with no incident.`
    : 'No recovery options were available for this incident.';

  let summary = fallback;
  if (winner && hasGemini()) {
    summary = await step('analyst', 'gemini', 'Explaining the result', async () => {
      const result = await chatJson({
        feature: 'analyst',
        schema: z.object({ summary: z.string() }),
        onUsage: onUsage(emit),
        system:
          'You are the Analyst. Explain in two plain sentences why the winning recovery beat the others. Use only the numbers provided. Reply with JSON only: {"summary":"..."}',
        user: JSON.stringify({
          incident,
          measure: unit,
          noIncident: reference.score,
          doNothing: unmitigated.score,
          options: ranked.map((c) => ({ title: c.title, score: c.evaluation.score, metrics: c.evaluation.metrics })),
        }),
      });
      return result.summary;
    }).catch(() => fallback);
  }

  const report: RecoveryReport = { tick, incident, reference, unmitigated, candidates: ranked, winnerId: winner?.id ?? null, summary };
  emit({ type: 'recovery', report });
}

function optimize(domain: Domain, model: unknown, spec: unknown) {
  const ticks = domain.horizon;
  const baseline = baselineOf(domain, model, ticks, []);
  const results = domain.variants(model, spec).map((variant) => {
    const target = variant.spec ? domain.compile(variant.spec) : model;
    const events: TimedEvent[] = variant.patches ? [{ at: 0, patches: variant.patches }] : [];
    return { ...variant, score: baselineOf(domain, target, ticks, events).score };
  });
  results.sort((a, b) => b.score - a.score);
  return { baseline, results };
}

export async function chat(input: LiveState & { message: string; metrics: unknown }, emit: Emit) {
  const { environment, message } = input;
  const domain = DOMAINS[environment.domain];
  const model = domain.compile(environment.spec);
  const step = stepper(emit);
  const IntentSchema = z.object({
    intent: z.enum(['patch', 'respec', 'inject', 'whatif', 'optimize', 'answer']),
    reply: z.string().optional(),
    patches: z.array(domain.patchSchema).optional(),
    spec: domain.specSchema.optional(),
    incident: IncidentSchema.optional(),
  });
  type Intent = z.infer<typeof IntentSchema>;

  const rules = () =>
    step('editor', 'rules', 'Interpreting your request', async () => {
      const options = domain.createRun(model, 1).breakables();
      return ruleChat(message, domain, model, options) as Intent;
    });
  const intent: Intent = !hasGemini()
    ? await rules()
    : await orRules(
        () =>
          step('editor', 'gemini', 'Interpreting your request', async () =>
            chatJson({
              feature: 'editor',
              schema: IntentSchema,
              onUsage: onUsage(emit),
              system: `You are the Editor of a live ${domain.label.toLowerCase()} environment. Choose one intent and reply with JSON only:
{"intent":"patch","patches":[Patch],"reply":"one sentence"} to change the running environment now.
{"intent":"respec","spec":Spec,"reply":"one sentence"} for a structural change, with the complete new spec.
{"intent":"inject","incident":Incident} when the user tells you to break something now.
{"intent":"whatif","incident":Incident} when the user asks what would happen, without changing anything.
{"intent":"optimize"} when asked to improve or find the best setup.
{"intent":"answer","reply":"two sentences at most"} for questions, using only the data given. If the answer depends on something this environment doesn't model, say so.
It cannot model: ${domain.limits.join('; ')}.
Patch is one of:
${domain.patchDoc}
Incident is one of:
${domain.incidentDoc}
Spec:
${domain.specDoc}`,
              user: `System: ${domain.describe(model)}\nLive state: tick ${input.tick}, metrics ${JSON.stringify(input.metrics)}\nUser: ${message}`,
            }),
          ),
        rules,
      );

  const replyNone = (text: string) => emit({ type: 'reply', text, action: { kind: 'none' } });
  switch (intent.intent) {
    case 'patch':
      emit({ type: 'reply', text: intent.reply ?? 'Done.', action: { kind: 'patch', patches: intent.patches ?? [] } });
      return;
    case 'respec': {
      if (!intent.spec) break;
      const next = domain.compile(intent.spec);
      const errors = domain.validate(next).filter((i) => i.severity === 'error');
      if (errors.length) return replyNone(`That change doesn't work: ${errors[0].message}.`);
      await step('validator', 'simulator', 'Checking the change', async (detail) => {
        const before = baselineOf(domain, model, domain.horizon, []);
        const after = baselineOf(domain, next, domain.horizon, []);
        detail(`${before.score} → ${after.score} ${before.scoreLabel}`);
      });
      emit({ type: 'reply', text: intent.reply ?? 'Rebuilt.', action: { kind: 'rebuild', environment: { ...environment, spec: intent.spec } } });
      return;
    }
    case 'inject':
      if (!intent.incident) break;
      emit({ type: 'reply', text: 'Injecting that failure now.', action: { kind: 'inject', incident: intent.incident } });
      return;
    case 'whatif': {
      if (!intent.incident) break;
      const claim = intent.incident;
      const finding = await step('simulator', 'simulator', 'Running the what-if', async (detail) => {
        const base = baselineOf(domain, model, domain.horizon, []);
        const result = testClaim(domain, model, base, { claim: message, incident: claim });
        detail(result.evidence);
        return result;
      });
      return replyNone(`Tested without touching the live run: ${finding.evidence}.`);
    }
    case 'optimize': {
      const { baseline, results } = await step('simulator', 'simulator', 'Testing alternatives', async (detail) => {
        const out = optimize(domain, model, environment.spec);
        detail(out.results.map((r) => `${r.title}: ${r.score}`).join(' · '));
        return out;
      });
      const best = results[0];
      if (!best || best.score <= baseline.score) {
        return replyNone(`I tried ${results.length} alternatives and none beat the current ${baseline.score} ${baseline.scoreLabel}.`);
      }
      const text = `Best of ${results.length} alternatives: ${best.title}, ${baseline.score} → ${best.score} ${baseline.scoreLabel}.`;
      if (best.spec) emit({ type: 'reply', text, action: { kind: 'rebuild', environment: { ...environment, spec: best.spec } } });
      else emit({ type: 'reply', text, action: { kind: 'patch', patches: best.patches ?? [] } });
      return;
    }
    case 'answer':
      break;
  }
  replyNone(intent.reply ?? 'I can change this environment, inject failures, test what-ifs or look for a better setup. Try one of those.');
}

export function describeFailure(error: unknown) {
  if (error instanceof ShieldBlock) return error.message;
  if (error instanceof NoCredentials) return 'No credentials for that engine.';
  return shortError(error);
}
