# Handoff: Platform lane

_Written 2026-11-07 against commit e136422. Check `git log -- apps/server apps/web/src/ui packages/core/src/domain.ts` for anything newer._

## 1. Current state

You own `apps/server/src/`, the shared web shell, and the contract every lane depends on.

The web shell is `apps/web/src/ui/`, `scene/`, `store.ts`, `actions.ts`, `runner.ts` and `main.tsx`. The contract is `packages/core/src/domain.ts` and `protocol.ts`.

Server:

- **`index.ts`** is a Hono app on port 8787.
  - Routes: `GET /api/status`, and `POST /api/build`, `/api/recover` and `/api/chat`, which stream server-sent events.
  - It re-reads `.env` on every `/api/*` request, so changing a key needs no restart.
  - It serves `apps/web/dist` as static files.
- **`agents.ts` `build`** runs the design pipeline:
  1. The Interpreter (`interpret`) picks a domain or refuses.
  2. The Architect (`architect`) writes the spec.
  3. The domain validator checks it. Up to `MAX_REPAIRS = 2` repair rounds follow, for errors and `repair: true` issues.
  4. A baseline simulation runs.
  5. The Red Team (`hypotheses`) states how the design should break.
  6. `testClaim` runs each claim in the simulator.
- **`agents.ts` `recover`:**
  1. The council (`proposals`) suggests fixes.
  2. Proposals are de-duplicated by their patches.
  3. Each is ranked by simulation.
  4. The Analyst explains the result.
- **`agents.ts` `chat`:** the Editor picks one intent: `patch`, `respec`, `inject`, `whatif`, `optimize` or `answer`.
- **`orRules`** falls back to local rules, labelled as such, but never routes around a Prune Shield block.
- **Keys present but the Architect fails:** the build refuses instead of showing a template. Keyless builds are labelled "built-in template".
- **`llm.ts` `chatJson`** sends one zod-validated JSON call.
  - **Routing:** Prune first (`X-Prune-Cache: off`), then Gemini direct.
  - **Response shape:** it parses Gemini's native `candidates` and `usageMetadata`.
  - **Rate limits:** a 429 or 503 on the direct route waits out Google's `retryDelay` (up to 20 s) and retries once.
  - **Timeout:** 45 s.
  - **Helpers:** `providerStatus`, `architectModel`.
- **`swarms.ts` `runCouncil`:**
  - **Budget:** it checks the balance first (`assertBudget` against `SWARMS_KEEP_USD`, default 5).
  - **Crashes:** a model that crashes is halted until restart (`haltModel`).
  - **Model:** both roles default to `gemini/gemini-3.5-flash-lite`.
- **`fallback.ts`:** keyless domain routing (`routePrompt`) and chat (`ruleChat`).

Web:

- **`actions.ts`** parses the event stream and loads environments.
- **`store.ts`** is the zustand store.
- **`runner.ts`** steps the domain's `Run` every frame and applies injects and patches.
- **`ui/Panels.tsx`** holds `Landing`, `ChatPanel`, `RightPanel` (agent trace and usage ledger), `StatusBar`, `Transport`, `Inspector` and `RecoveryCard`.
- **`ui/Charts.tsx`** holds the sparkline and recovery chart.

Tests: `apps/server/test/adapters.test.ts` covers the gateway, Swarms and full pipelines with a mocked `fetch`. All 102 tests pass at e136422.

## 2. Decisions made and rationale

- **Agents propose and simulators decide.** Red Team claims show as Confirmed or Refuted with the measurement, and fixes are ranked by simulated score, not by what a model says.
- **Refuse rather than mislead.**
  - An unmodellable request is refused with the reason.
  - A design that still fails validation after repairs is refused.
  - When keys are set and the Architect fails, there's no silent fallback to a template.
- **Prune's cache is off.** Its semantic matching returned answers for prompts that differed only in numbers.
- **Swarms stays cheap.**
  - `gemini-3.5-flash` and `xai/grok-4.20-beta` crashed on Swarms' side and were still billed, so both roles use flash-lite.
  - The halt guard stops a crashing model from being billed again.
  - The balance floor stops spending before the credits run out.
- **`.env` is re-read per request** because keys were rotated during the event and the old ones kept being used.

## 3. Done vs pending

**Done:**
- Build, recover and chat pipelines with labelled local fallbacks: `agents.ts`, pipeline tests.
- Gateway with Prune receipts, fallback, rate-limit retry and JSON repair: `llm.ts`, "LLM gateway" tests.
- Swarms budget floor and crash halt: `swarms.ts`, "Swarms council" tests.

**Pending:**
- **Builds take about 20 s,** and Prune adds about 5 s per call. Steps carry no timings today (`StepEvent` in `protocol.ts`), so measure each step first, then decide what to parallelise or route direct.
- **Status chips show a key is set, not that it works.** The Swarms balance endpoint is free to call, and so is a Gemini model list.
- **The Prune vault may still hold an old Gemini key** (Prune dashboard: Connect > Providers).
- **A fix that disables a broken output can score the same as a real repair** in electronics ranking. Agree any tie-break with the Electronics lane.
- **Chat edits of electronics sketches** (`set_program` in its `patchDoc`) haven't been tried live.
- **`README.md` says a rejected design goes back to the Architect "once";** the code allows two rounds. Tell Ship.
- **`Panels.tsx` and `styles.css`:** split them by component so the other lanes stop colliding there. This is a setup task in `docs/PLAN.md`.

## 4. Exact next action

1. Do the setup PR from `docs/PLAN.md` first, or confirm someone else has: line endings, formatter config, CI check, test-file split. Every other lane is waiting on it.
2. Split `apps/web/src/ui/Panels.tsx` into one file per exported component, each with its own CSS file. Move the rules out of `styles.css` with no visual change, then check every domain's scene in the browser.
3. Time a keyed build step by step (log `Date.now()` around each `step` in `agents.ts`, locally only) and post the numbers in the team chat before changing the pipeline.

## 5. Gotchas

- **Never print or log key values.** `.env` is gitignored. Tests mock `fetch` and must never reach a real API.
- **Swarms bills runs that fail,** and refuses runs when the balance is $1 or less. Free credits don't count toward that. Keep `SWARMS_API_KEY` blank unless you're working on the council or Red Team.
- **`domain.ts` and `protocol.ts` changes break every lane at once.** Make them in a tiny PR on their own, merge it first, and announce it.
- **`agents.ts` reads each domain's docs and schemas generically.** Nothing in it may name a specific domain. Use `domain.seeds`, `domain.horizon` and so on.
- **A Prune `ShieldBlock` must propagate.** Don't add a fallback that catches it.

## 6. Running commands and background processes

```bash
npm install
npm run dev
npx vitest run apps/server
npm run typecheck
```

The web app is at http://localhost:5173 and proxies `/api` to 8787 (`apps/web/vite.config.ts`). To try a build, set a Gemini key or `PRUNE_API_KEY` in `.env`. Nothing runs in the background for this lane.
