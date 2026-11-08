# Handoff: Ship lane

_Written 2026-11-07 against commit e136422. Devpost is due Sunday, Nov 8._

## 1. Current state

You own deployment, sponsor integrations, `README.md` and the Devpost submission. Put new code in new folders: `deploy/` and `apps/server/src/integrations/`. That way your work rarely touches anyone else's files.

- **Nothing is deployed yet.** The app runs locally only.
- **Production build:**
  - `npm run build -w @tv/web` writes `apps/web/dist`.
  - `npm start -w @tv/server` then serves both the API and that folder on `PORT` (default 8787).
  - The server runs TypeScript directly through `tsx`, so it has no compile step. It needs Node 20 or newer.
- **`.env` lives at the repo root.** The server resolves it from `apps/server/src` and re-reads it on every API request.
- **Sponsors already in the product:**
  - Gemini runs the Interpreter, Architect, Analyst and chat Editor.
  - Prune is the gateway for Gemini calls; its receipts appear in the Usage tab.
  - Swarms runs the Red Team and the recovery council.
- **Planned in `README.md`, none started:** Vultr hosting, Tiger Data storage, Auth0 sign-in, Solana publishing and an M5Stack controller.
- **Code to build on:**
  - `packages/core/src/hash.ts` exports `provenanceHash(environment, scenario, evaluation)`, a SHA-256 of a run. Nothing uses it yet.
  - Simulators are deterministic, so anyone holding a run's environment, seed and event log can replay it and check the hash.

## 2. Decisions made and rationale

- **Product before hosting.** The team held off on Vultr while the product was still weak. It is close enough now to deploy.
- **Only the sponsor tracks that fit the product.** Each integration should do something a user would notice. Drop any that would be a logo with no purpose.
- **Commits** are by their real authors, with no co-author lines.

## 3. Done vs pending

**Done:**
- The README covers what CanItWork is, how to run it, configuration, the pipeline and how to add a domain.

**Pending, roughly in order:**
- **Vultr deploy from main.**
  - A public deploy with keys lets anyone spend the team's Gemini and Swarms credits, so set `REQUIRE_SIGN_IN=1` (Auth0) and `RATE_LIMIT_PER_HOUR` before sharing the URL.
- **GoDaddy domain** pointed at the deploy.
- **Auth0 sign-in.** Done: `REQUIRE_SIGN_IN=1` keeps the agents for signed-in people, and limits count per account. See [docs/AUTH0.md](../AUTH0.md).
- **Tiger Data:**
  - Store environments, event logs and scores so a run can be shared by link and replayed.
  - Replays are exact because the simulators are deterministic.
- **Solana:**
  - Publish a run's `provenanceHash` so anyone can replay the run and check the result wasn't edited.
  - Do this only if there's time after the items above.
- **M5Stack controller** (Best Use of Hardware): physical buttons that break or fix parts in the running scene. A stretch goal.
- **Devpost:** write-up, a 2–3 minute demo video, and screenshots of each domain.
  - Show a design breaking, the Red Team's claims Confirmed or Refuted, and the council's fixes ranked by simulation.
- **DEV post** about building it, if that track is entered.

## 4. Exact next action

1. Run the production build locally and check it works end to end at http://localhost:8787 (commands below).
2. Write `deploy/README.md` with the exact Vultr steps: server size, Node 20 install, `npm ci`, build, a process manager such as `pm2` or a systemd unit, and HTTPS. Then follow it.
3. Before posting the URL anywhere, set `REQUIRE_SIGN_IN=1` and `RATE_LIMIT_PER_HOUR` in the deploy's `.env`, so only signed-in people can make the agents spend credits.

## 5. Gotchas

- **The deploy needs its own `.env`.** Copy it to the server by hand and never commit it.
- **Set `PORT` in `.env`, not as an environment variable.** The server loads `.env` with `override: true`, so its `PORT` wins. Running `PORT=8790 npm start` still binds 8787, and it crashes if a dev server already holds that port.
- **The production build hasn't been tested end to end yet.** Do that first, per section 4.
- **Leave `SWARMS_KEEP_USD` set** so the deploy stops spending at the floor.
- **Swarms refuses runs at $1 or less,** and free credits don't count. Watch the balance before the demo.
- **Gemini rate limits are per key.** If the whole team and the deploy share one key, 429s will show up mid-demo. Give the deploy its own key.
- **The Vite dev proxy only exists in development.** In production the server serves `apps/web/dist` itself, so the web app and API must stay on the same origin, or the API needs CORS.
- **Without keys the app still works** using built-in templates. That's a safe fallback for a public demo, but every build says "built-in template".
- **Record the demo video from a stable build.** Do it before the feature freeze, and re-record only if something important changes.

## 6. Running commands and background processes

```bash
npm install
npm run build -w @tv/web
npm start -w @tv/server
```

Open http://localhost:8787 to see the production build: one process serves both the API and the web app. For development, use `npm run dev` (web 5173, API 8787). Nothing is running in the background for this lane.
