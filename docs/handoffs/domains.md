# Handoff: Other domains lane

_Written 2026-11-07 against commit e136422. Check `git log -- packages/core/src/domains` for anything newer._

## 1. Current state

You own the software, database and warehouse folders in `packages/core/src/domains/` and `apps/web/src/domains/`, plus any new domain.

Every domain implements the `Domain` interface in `packages/core/src/domain.ts`. That covers:

- a zod spec schema, plus `specDoc`: the text the Architect reads;
- `validate`, which returns `Issue[]`; issues marked `repair: true` go back to the Architect;
- `createRun`, a deterministic `Run` with `step`, `inject`, `apply`, `evaluation`, `telemetry`, `breakables` and `inspect`;
- incident and patch schemas, with the docs the agents read;
- a council of three expert briefs, and keyless `rules`: a template spec, Red Team hypotheses and fixes.

The three domains:

- **Software** (`software/schema.ts`, `system.ts`, `index.ts`):
  - **Spec:** nodes (`client`, `gateway`, `service`, `database`, `cache`, `queue`, `external`), sync or async edges, traffic and retries.
  - **Simulator:** `SystemRun` is a flow model with capacity, latency, retries, timeouts and queue backlog. Score is "% of requests succeeding".
  - **Incidents:** `node_down`, `node_slow`, `traffic_spike`, `cut_link`, `cache_flush`.
  - **Patches:** `scale`, `failover`, `set_retries`, `make_optional`, `add_cache`, `add_queue`.
  - **Validator:** refuses cycles and names single points of failure.
  - **View:** `apps/web/src/domains/software/Topology.tsx`.
- **Database** (`database/schema.ts`, `engine.ts`, `index.ts`):
  - **Spec:** tables, columns and foreign keys, indexes, and a query workload.
  - **Simulator:** `SchemaRun` models scan and seek cost, row growth from writes, and locks. Score is "% of queries within 100 ms".
  - **Incidents:** `drop_index`, `drop_column`, `lock_table`, `row_surge`, `workload_spike`.
  - **View:** `apps/web/src/domains/database/Schema.tsx`.
- **Warehouse** (`warehouse/schema.ts`, `compile.ts`, `planner.ts`, `sim.ts`, `validate.ts`, `index.ts`):
  - **Spec:** the Architect sets only 8 values: robots, aisles, shelvesPerAisle, conveyors, chargers, docks, demand and dispatch.
  - **Layout:** `compile.ts` generates the floor from those values.
  - **Simulator:** `planner.ts` routes robots with space-time A*. Score is packages delivered.
  - **View:** `apps/web/src/domains/warehouse/` (`Warehouse.tsx`, `Facility.tsx`, `Actors.tsx`, `palette.ts`).

Tests:

- `packages/core/test/domains.test.ts` covers software and database. Its "meets the platform contract" block runs automatically for every registered domain, new ones included.
- `packages/core/test/sim.test.ts` covers the warehouse compiler and simulator.
- All 102 tests pass at e136422.

## 2. Decisions made and rationale

- **The platform is general.** Warehouses are one example, not the product. A request that no domain can model is refused with an explanation, never forced into the closest domain.
- **Agents propose and simulators decide.** Every Red Team claim and every fix is scored by running the simulator. Nothing an agent says is shown as a result unless the simulator confirms it.
- **Simulators must be deterministic.** Use the seeded RNG in `packages/core/src/rng.ts`, never `Math.random`. Replays of an event log have to match the live run exactly, and the contract tests check this.
- **Electronics separates condition changes from failures** by scoring against a fault-free copy (see `handoffs/electronics.md`). That fits designs meant to react to their surroundings.
  - In software, a traffic spike that overloads the system is a real finding. It should probably keep counting against the score.
  - Decide per domain. Don't copy the electronics approach by default.

## 3. Done vs pending

**Done:**
- Software, database and warehouse domains with scenes, validators, incidents, fixes and tests: see the files above.

**Pending:**
- **Warehouse layout.** The Architect can only set counts, so it can't build an L-shaped floor, named zones, people or forklifts. Those land in "Not modelled in this design". Making the layout part of the spec is the biggest gain in this lane.
- **New domains.** Each one is additive: a folder in `packages/core/src/domains/`, one line in `domains/index.ts`, a scene in `apps/web/src/domains/<id>/` and one line in `apps/web/src/domains/index.tsx`. The new id also goes in the `DomainId` union in `domain.ts`, which Platform owns: one-line PR, merged first.
- **Systems outside every domain.** Today these are refused. A general engine for them was proposed but never agreed on. Decide as a team before starting it.

## 4. Exact next action

1. Run `npm run dev` with no keys and build each example from the landing page. Break things from the Break bar and the inspector to get a feel for each simulator.
2. Agree on warehouse layout versus a new domain at the next check-in. If layout:
   - extend `WorldSpecSchema` in `warehouse/schema.ts` with optional layout fields;
   - teach `compile.ts` to use them and fall back to today's generator when they're missing;
   - update `specDoc` in `warehouse/index.ts`.
3. Add tests in a new file per domain, such as `packages/core/test/warehouse-layout.test.ts`.

## 5. Gotchas

- **`specDoc`, `incidentDoc` and `patchDoc` go straight into the agents' prompts.** Every sentence costs tokens and latency on every build.
- **Issue text matters.** A validator message with `repair: true` is sent to the Architect word for word. Say what is wrong and why, such as "db is a single point of failure", not just "invalid".
- **`limits` is shown behind a hover** in the chat panel, so keep it to three or four genuine limits. Request-specific gaps go in the Architect's `unmodelled` list.
- **Runs execute in the browser every frame,** and on the server many times per build to rank fixes. Keep `step()` cheap.
- **Don't edit the shared registries beyond your one line,** and don't change `domain.ts` yourself: ask Platform.

## 6. Running commands and background processes

```bash
npm install
npm run dev
npx vitest run packages/core
npm run typecheck
```

The web app is at http://localhost:5173. Tests and the keyless app need no keys. Nothing runs in the background for this lane.
