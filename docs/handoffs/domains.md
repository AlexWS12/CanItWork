# Handoff: Other domains lane

_Written 2026-11-07 against commit e136422; layout, zones and partitions added on branch `nickolas/domain-layouts`. Check `git log -- packages/core/src/domains` for anything newer._

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
  - **Zones:** a node's optional `zones` list spreads its replicas round-robin (`replicaZones` in `schema.ts`). Losing a zone removes those replicas; a node with none left is out (`isOut` in `system.ts`). Nodes without zones never feel a zone outage.
  - **Incidents:** `node_down`, `node_slow`, `traffic_spike`, `cut_link`, `cache_flush`, `zone_down` (`recover` with a zone name brings it back).
  - **Patches:** `scale`, `failover`, `set_retries`, `make_optional`, `add_cache`, `add_queue`, `add_zone` (also raises replicas so one runs there).
  - **Validator:** refuses cycles and names single points of failure, replicated nodes stuck in one zone, and nodes listing more zones than replicas.
  - **View:** `apps/web/src/domains/software/Topology.tsx`.
- **Database** (`database/schema.ts`, `engine.ts`, `index.ts`):
  - **Spec:** tables, columns and foreign keys, indexes, optional `partitions` + `partitionBy` per table, optional `replicas`, and a query workload.
  - **Simulator:** `SchemaRun` models scan and seek cost, row growth from writes, and locks. Score is "% of queries within 100 ms".
    - Unpartitioned tables share the primary. Each partition is its own node with the same capacity (times replicas), tracked in `partitionLoad`.
    - Queries filtering on the key, and all writes, hit one partition; other reads hit every partition and pay `GATHER_MS` per partition.
    - A hot key (`hot` map) sends a share of keyed traffic to partition 0; the score counts only the share that stays in budget.
  - **Incidents:** `drop_index`, `drop_column`, `lock_table`, `row_surge`, `workload_spike`, `hot_partition` (`cool_partition` undoes it).
  - **Patches:** adds `repartition`; a new key clears a hot key, more partitions on the same key don't.
  - **View:** `apps/web/src/domains/database/Schema.tsx`.
- **Warehouse** (`warehouse/schema.ts`, `compile.ts`, `planner.ts`, `sim.ts`, `validate.ts`, `index.ts`):
  - **Spec:** robots, aisles, shelvesPerAisle, conveyors, chargers, docks, demand and dispatch, plus optional `shape` (`rect`, `L`, `U`, `T`) and `zones` (`name`, `aisles`, optional `share` of orders).
  - **Layout:** `compile.ts` generates the floor from those values.
    - A shape shifts whole aisle blocks south and walls off the rows they leave (`World.walls`), so every shape holds the same shelves; only travel changes. U and T need 3+ aisles and fall back to a rectangle below that.
    - Zones claim aisle blocks from the west (`World.zones`, `Shelf.zone`). A zone `share` weights which shelves orders come from (`orderWeights` in `sim.ts`); with no shares the draw is the original uniform one.
    - With no shape and no zones the world is identical to before, and a test pins that.
  - **Simulator:** `planner.ts` routes robots with space-time A*. Score is packages delivered.
  - **View:** `apps/web/src/domains/warehouse/` (`Warehouse.tsx`, `Facility.tsx`, `Actors.tsx`, `palette.ts`).

### Flow-network domains (branch `nickolas/new-domains`)

Seven domains share one engine, so each is mostly configuration:

| Domain | Folder | Mode | Score |
|---|---|---|---|
| Power grids | `power/` | demand, lines trip | % of demand served |
| Water networks | `water/` | demand | % of demand supplied |
| Supply chains | `supply/` | demand, shipping delays | % of store demand filled |
| Hospitals | `hospital/` | flow | % of patients treated |
| Factory lines | `factory/` | flow | % of planned output |
| Airports | `airport/` | flow | % of flights turned around |
| Call centres | `callcenter/` | flow | % of calls answered |

- **Engine** (`network/engine.ts`, `NetRun`): sources, stages and sinks with capacity, units (`count`), storage (`buffer`), link weights, ratings and delays.
  - **Demand mode** works each stage's need back from the end points, splits it over live feeds by rating and how well each fed last tick, and dispatches sources to match. A line at its rating while its area is short trips after three ticks, so overloads cascade.
  - **Flow mode** pushes arrivals through. Work a full step refuses waits at the node it finished at, bound for that step (ER boarding), and still occupies capacity there. Arrivals with nowhere to wait are lost (diverted, abandoned).
- **Factory** (`network/domain.ts`, `networkDomain`): builds a whole `Domain` from kinds, wording and a template: spec docs, validator, Red Team claims, recoveries and variants.
- **Shared incidents and patches:** `node_down`, `node_slow`, `link_down`, `surge`, `recover`; `scale`, `restore`, `add_link`, `restore_link`, `set_buffer`, `shed`.
- **View:** one scene, `apps/web/src/domains/network/Network.tsx`, with per-domain shapes and colours in `styles.ts`.
- **Adding another:** a folder with one `networkDomain({...})` call, a line in `domains/index.ts`, a style entry in `styles.ts`, a `network` entry in `apps/web/src/domains/index.tsx`, and the id in `DomainId`.
- **Tests:** `network.test.ts` (validator, conservation of flow, cascades, held work, every patch), `edge-cases.test.ts` (every domain through every failure, fix and variant, bad inputs, long replays, a healthy start) and `apps/server/test/routing.test.ts` (each preset routes to its own domain).

Tests:

- `packages/core/test/software.test.ts` and `database.test.ts` cover those domains. `contract.test.ts` runs automatically for every registered domain, new ones included.
- `packages/core/test/sim.test.ts` covers the warehouse compiler and simulator.
- `warehouse-layout.test.ts`, `software-zones.test.ts` and `database-partitions.test.ts` cover the new layout features.
- All 138 tests pass on `nickolas/domain-layouts`.

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
- Warehouse floor shapes and named zones with order shares; walls and zone labels in `Facility.tsx`.
- Software availability zones and `zone_down`; zone chips and a legend in `Topology.tsx`.
- Database partitions, read replicas in the spec and `hot_partition`; per-partition load strips in `Schema.tsx`.

**Pending:**
- **New scenes haven't been checked in a browser yet.** They typecheck, but walls, zone labels, zone chips and partition strips still need a look at `npm run dev`.
- **People and forklifts in the warehouse.** Still unmodelled. The cheapest route is a slower robot kind with no battery that shares the grid.
- **Zone incidents in the warehouse.** Zones only steer demand today; a `close_zone` incident (spill, power cut in cold storage) would make them breakable.
- **Hot partitions rarely bite with the fallback workloads.** Keyed seeks are cheap next to the 100 ms budget, so the Red Team's hot-key claim on a sharded fallback is often refuted. That's the simulator deciding, but a heavier fallback workload would demo better.
- **New domains.** Each one is additive: a folder in `packages/core/src/domains/`, one line in `domains/index.ts`, a scene in `apps/web/src/domains/<id>/` and one line in `apps/web/src/domains/index.tsx`. The new id also goes in the `DomainId` union in `domain.ts`, which Platform owns: one-line PR, merged first.
- **Systems outside every domain.** Today these are refused. A general engine for them was proposed but never agreed on. Decide as a team before starting it.

## 4. Exact next action

1. Run `npm run dev` with no keys and try these prompts. Check the new scenes, then break the zone or partition from the Break bar:
   - "An L-shaped warehouse with four robots, a cold storage zone and a hazmat area"
   - "A payment system running in two availability zones"
   - "A sharded e-commerce database with customers and orders"
2. Pick from the pending list above, or a new domain (which needs Platform's one-line `DomainId` PR first).

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
