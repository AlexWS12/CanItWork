# Handoff: Platform lane

_Updated 2026-11-07 with PR #7 (status checks); first written against e136422. Check `git log -- apps/server apps/web/src/ui packages/core/src/domain.ts` for anything newer._

## 1. Current state

You own `apps/server/src/`, the shared web shell, and the contract every lane depends on.

The web shell is `apps/web/src/ui/`, `scene/`, `store.ts`, `actions.ts`, `runner.ts` and `main.tsx`. The contract is `packages/core/src/domain.ts` and `protocol.ts`.

Server:

- **`index.ts`** is a Hono app on port 8787.
  - Routes: `GET /api/status` (provider routing plus key checks, from `status.ts`), and `POST /api/build`, `/api/recover` and `/api/chat`, which stream server-sent events.
  - It re-reads `.env` on every `/api/*` request, so changing a key needs no restart.
  - It serves `apps/web/dist` as static files.
- **`agents.ts` `build`** runs the design pipeline:
  1. The Interpreter (`interpret`) picks a domain or refuses.
  2. The Architect (`architect`) writes the spec.
  3. The domain validator checks it. Up to `MAX_REPAIRS = 2` repair rounds follow, for errors and `repair: true` issues.
  4. A baseline simulation runs.
  5. The Red Team (`hypotheses`) states how the design should break.
  6. `testClaim` runs each claim in the simulator.
  - Every step goes through `stepper()`, which emits `ms` (wall-clock duration) on done and failed events.
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
  - **Key checks:** `probe` calls a free endpoint (a model list) and caches the result per URL and key for 60 s; `routeChecks` probes each route.
- **`swarms.ts` `runCouncil`:**
  - **Budget:** it checks the balance first (`assertBudget` against `SWARMS_KEEP_USD`, default 5).
  - **Crashes:** a model that crashes is halted until restart (`haltModel`).
  - **Model:** both roles default to `gemini/gemini-3.5-flash-lite`.
  - **Key check:** `swarmsCheck` probes the free `/account/credits` endpoint.
- **`fallback.ts`:** keyless domain routing (`routePrompt`) and chat (`ruleChat`).
- **`status.ts` `checkedStatus`:** combines the routing with the key checks, waiting at most 300 ms so the page never shows "Server offline" while Prune answers.

Web:

- **`actions.ts`** parses the event stream and loads environments.
- **`store.ts`** is the zustand store.
- **`runner.ts`** steps the domain's `Run` every frame and applies injects and patches.
- **`ui/`** has one file per component, each importing its own CSS: `Landing`, `ChatPanel`, `RightPanel` (agent trace with step durations, usage ledger), `StatusBar` (chips turn red when a key is rejected), `Transport`, `Inspector`, `RecoveryCard` and `Charts` (sparkline and recovery chart).
- **`styles.css`** holds only tokens, element defaults, the shared panel surface and scene tags. New UI gets its own CSS file.

Tests: `apps/server/test/` has `llm`, `swarms`, `pipelines` and `status` tests, with the shared `fetch` mock in `helpers.ts`. All 110 tests pass.

Repo: CI (`.github/workflows/ci.yml`) runs typecheck, tests and `npm run format:check` on every PR. Prettier is set to single quotes and width 180, and ignores Markdown.

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
- **The whole repo was reformatted once** (commit `00df7dd`, listed in `.git-blame-ignore-revs`). No Prettier config reproduced the hand formatting, and no branches existed yet.
- **A key check counts only 401 and 403 as a bad key.** A 404 or other unexpected reply is `unchecked`, so a missing endpoint never shows as a broken key.
- **Measure before optimising.** One timed keyed build (warehouse example, through Prune and Swarms) took 25.1 s:
  - Interpreter 12.7 s, for 631 + 35 tokens.
  - Architect 7.4 s.
  - Red Team (Swarms) 4.2 s.
  - All simulator steps together under 0.8 s.
  - Cost was about $0.0104, nearly all Swarms.
  - The Interpreter is the smallest call but the slowest, which points to call latency rather than generation. It's one sample.

## 3. Done vs pending

**Done:**
- Build, recover and chat pipelines with labelled local fallbacks: `agents.ts`, pipeline tests.
- Gateway with Prune receipts, fallback, rate-limit retry and JSON repair: `llm.ts`, "LLM gateway" tests.
- Swarms budget floor and crash halt: `swarms.ts`, "Swarms council" tests.
- Repo setup: `.gitattributes`, Prettier, CI, test-file split (PR #1, plus #2 for blame).
- `Panels.tsx` and `styles.css` split by component, with no computed-style change in 27 UI states (PR #3).
- Step durations in the protocol, server and trace (PRs #4 and #5).
- Status chips that check each key against a free endpoint (PRs #6 and #7). All three keys checked `ok` live.

**Pending:**
- **Builds take about 25 s, mostly the Interpreter.** Compare the same build with Gemini direct (blank `PRUNE_API_KEY` for one run) before changing anything. If direct is much faster, route the Interpreter direct.
- **The Prune vault's Gemini key is unconfirmed.** The Prune key check only lists models, so it can't see which Gemini key Prune forwards. A keyed build through Prune did succeed today. To be sure, check the Prune dashboard (Connect > Providers).
- **A fix that disables a broken output can score the same as a real repair** in electronics ranking. Agree any tie-break with the Electronics lane.
- **Chat edits of electronics sketches** (`set_program` in its `patchDoc`) haven't been tried live.
- **`README.md` says a rejected design goes back to the Architect "once";** the code allows two rounds. Tell Ship.
- **Branch protection and secret scanning on main** are for the repo owner to turn on in GitHub settings.

## 4. Exact next action

1. Run one build with Gemini direct (`PRUNE_API_KEY` blank for that run) and compare its step times with the 25.1 s Prune build above. Ask in team chat first, since the Red Team still spends Swarms credit. Then decide whether to route the Interpreter direct.
2. Tell Ship about the README's "once" (it's up to two repair rounds).
3. Agree the electronics ranking tie-break with the Electronics lane.
4. Try a chat edit of an electronics sketch live.

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
npm run format
```

The web app is at http://localhost:5173 and proxies `/api` to 8787 (`apps/web/vite.config.ts`). To try a build, set a Gemini key or `PRUNE_API_KEY` in `.env`. Step durations show in the Agents tab. `curl localhost:8787/api/status` shows the key checks without spending anything. Nothing runs in the background for this lane.
