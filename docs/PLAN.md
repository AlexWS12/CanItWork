# Team plan

Four lanes, each owning its own folders. Everything reaches main through small pull requests that pass typecheck and tests, and every shared file has one owner.

Devpost is due Sunday, Nov 8, so main has to stay demo-ready the whole time.

## Lanes

Put your name on one lane. You own its folders: nobody else edits them without asking you first. Each lane has a handoff with its current state, decisions so far and first tasks. Read yours before you start.

| Lane | Who | Owns | Handoff |
|---|---|---|---|
| 1. Electronics | | `packages/core/src/domains/electronics/`, `apps/web/src/domains/electronics/` | [electronics](handoffs/electronics.md) |
| 2. Other domains | | `packages/core/src/domains/` software, database and warehouse, their folders in `apps/web/src/domains/`, any new domain | [domains](handoffs/domains.md) |
| 3. Platform | | `apps/server/src/`, `apps/web/src/ui/`, `apps/web/src/scene/`, `store.ts`, `actions.ts`, `runner.ts`, `main.tsx`, `packages/core/src/domain.ts`, `protocol.ts` | [platform](handoffs/platform.md) |
| 4. Ship | | New folders only (`deploy/`, `apps/server/src/integrations/`), `README.md`, Devpost | [ship](handoffs/ship.md) |

With three people, Lane 1 also takes Lane 2.

## How the code fits together

- `packages/core` holds the `Domain` contract (`domain.ts`), one folder per domain (schema, validator, deterministic simulator, failures and fixes) and the events the server streams (`protocol.ts`). It has no network code.
- `apps/server` is a Hono API on port 8787. `agents.ts` runs build, recover and chat as server-sent event streams. `llm.ts` is the Gemini gateway (Prune first, then direct), `swarms.ts` runs the Red Team and recovery council, and `fallback.ts` handles keyless routing.
- `apps/web` is React with react-three-fiber. `runner.ts` steps the domain's `Run` every frame, `actions.ts` talks to the API, `ui/` is the shell every domain shares, and `domains/<id>/` holds each domain's 3D scene.

Simulators run in both places. The server uses them to test the Red Team's claims and rank fixes, and the browser runs the live view. They are deterministic: the same spec, seed and event log always replay to the same result.

## Shared files

These are where two lanes will collide. Each has an owner and one rule.

| File | Owner | Rule |
|---|---|---|
| `packages/core/src/domain.ts`, `protocol.ts` | Platform | The contract every domain and the UI depend on. Change it in a tiny PR on its own, merge it first, then tell everyone to rebase. |
| `packages/core/src/domains/index.ts`, `packages/core/src/index.ts`, `apps/web/src/domains/index.tsx` | Anyone | Registries: add your one line, never reorder or reformat. |
| `apps/server/src/agents.ts` (520 lines) | Platform | Put new logic in a new file under `apps/server/src/` and ask Platform to call it. |
| `apps/web/src/ui/Panels.tsx`, `apps/web/src/styles.css` (1,011 lines) | Platform | New UI gets its own component file and its own CSS file imported by that component. Don't reformat existing rules. |
| `packages/core/test/domains.test.ts`, `apps/server/test/adapters.test.ts` | Anyone | New tests go in a new file per area, such as `packages/core/test/electronics.test.ts`. |
| `package-lock.json` | Anyone | Touch it only when adding a dependency. On a conflict, take main's copy, run `npm install`, commit. |
| `.env.example` | Anyone | Append only, and say in the team chat when a new key is needed. |
| `README.md` | Ship | Everyone else puts README notes in their PR description. |

## Git workflow

Nobody pushes to main. Every change is a short-lived branch and a pull request.

1. Start from fresh main: `git switch main`, `git pull`, `git switch -c yourname/topic`.
2. Keep a branch under half a day of work. Smaller PRs merge without conflicts.
3. Before pushing: `git fetch`, `git rebase origin/main`, then `npm run typecheck` and `npm test`. Both must pass.
4. Open a PR to main and describe what changed in a line or two. A PR inside your own lane can merge as soon as checks pass. One that touches another lane waits for that owner's OK.
5. Squash-merge and delete the branch.
6. When main moves, rebase your branch within a couple of hours, not at the end.
7. Never force-push main. Force-push only your own branch, after a rebase.

## Setup before anyone branches

One small PR, merged before the lanes start. The repo has none of these today.

- [ ] `.gitattributes` with `* text=auto eol=lf`, so Windows and Mac don't produce whole-file line-ending diffs.
- [ ] A Prettier config that reproduces today's formatting with zero diff, so format-on-save stops rewriting other people's lines.
- [ ] A GitHub Actions check that runs typecheck and tests on every PR.
- [ ] Branch protection on main: PR required and the check must pass. The repo owner sets this in GitHub settings.
- [ ] GitHub secret scanning with push protection, so a key can't land in a commit.
- [ ] Split the two large test files by area, so new tests don't all land in the same two files.

## Keys and credits

The Swarms balance and the Prune key are shared. One person's testing shouldn't drain them or rate-limit everyone.

- Copy `.env.example` to `.env`. `.env` is gitignored: never commit it or paste keys into chat.
- Use your own free Gemini key locally. The shared keys are for the demo and for work on those integrations.
- Leave `SWARMS_API_KEY` empty unless you are working on the council or Red Team. `SWARMS_KEEP_USD` stops runs before the balance hits its floor.
- Tests never call paid APIs: use mocks or saved responses.
- Ask in the team chat before any run that spends shared credits, and say roughly what it costs.

## Rhythm

- Merge to main at least every three hours, and post a one-line "main moved: what changed" in the team chat.
- Check in every four hours for five minutes: what merged, what's next, any change to the shared files.
- Pick a feature-freeze time a few hours before the deadline. After it, only fixes and demo prep.
- The deployed demo builds from main only, and Ship owns it.
- When you stop for the night or hand your lane to someone, update your handoff in `docs/handoffs/` in the same PR as your last change.
