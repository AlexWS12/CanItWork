# tv

Describe a system in plain English and get an interactive model of it. Run it, break it, and compare fixes by what they actually do.

tv is a general environment builder. It works out what kind of system you described, designs it, checks it, and runs it in a simulator built for that kind of system. If it can't model something, it says so.

Built at SharkByte 2026.

## What it can build

| Domain | Simulator | View |
|---|---|---|
| Electronics | Simulates circuits and sketches over time: voltages and currents, PWM, capacitors, motor spin-up, board brownout, sensor readings, servo angles and display text, with ratings that burn out overloaded parts | Workbench with boards, parts, live wires and live readings |
| Software systems | Traffic, capacity, latency, retries, timeouts and cascading failures | Racks, databases and queues with live packets |
| Databases | Query cost, indexes, data growth, locks and broken dependencies | Table cards with keys and relationships |
| Warehouses | Robots, routing, conveyors, charging and order flow | 3D warehouse floor |

Each domain lists what it doesn't model, and the app shows that list next to every environment.

## Run

Needs Node 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API runs on port 8787.

It runs with no keys. Without them, each step in the Agents panel is tagged `Local rules`, and environments come from small built-in templates.

```bash
npm test
npm run typecheck
```

## Configuration

Copy `.env.example` to `.env`. The server re-reads it on every request.

| Variable | Purpose |
|---|---|
| `PRUNE_API_KEY` | Sends Gemini calls through Prune. Store your Gemini key in the Prune dashboard under Connect > Providers |
| `GEMINI_API_KEY` | Direct Gemini access, used if Prune is unavailable |
| `TYPESAFE_API_KEY` | Lets Jev pick the domain. Gemini is only asked when Jev is unsure |
| `SWARMS_API_KEY` | Runs the Red Team and the recovery council |
| `SWARMS_MODEL` | Model for the recovery council |
| `REDTEAM_MODEL` | Model for the Red Team |
| `SWARMS_KEEP_USD` | Stops Swarms calls at this balance. Defaults to 5 |

Swarms bills every run, including runs that fail. Leave `SWARMS_API_KEY` blank while developing.

## How it works

```
prompt ─▶ Interpreter ─▶ Architect ─▶ Validator ─▶ Simulator ─▶ Red Team ─▶ Simulator tests each claim
          Jev, Gemini    Gemini       domain rules             Swarms

failure ─▶ Recovery Council ─▶ Simulator ranks each proposal ─▶ Analyst ─▶ Apply
           Swarms                                               Gemini
```

- **Interpreter** picks the domain, or refuses and explains why. Jev answers which domain fits and how likely each simulator is to model the request; code routes on those probabilities and hands unsure cases to Gemini.
- **Architect** writes a structured design and lists anything it couldn't represent.
- **Validator** checks the design with the domain's own rules. A rejected design goes back to the Architect once. If it still fails, tv refuses instead of showing something wrong.
- **Red Team** states how the design should break, as failures the simulator can run. Each claim is shown as Confirmed or Refuted with the measurement.
- **Recovery Council** proposes fixes after a failure, and the simulator ranks them.

Agents propose and the simulators decide. Simulators are deterministic, so an environment, seed and event log always replay to the same result.

## Adding a domain

A domain is a folder in `packages/core/src/domains` that implements the `Domain` interface in `domain.ts`: its schema, validation, simulator, failures and fixes. Add it to `domains/index.ts`, add a scene in `apps/web/src/domains`, and register the scene in `apps/web/src/domains/index.tsx`. The agents, chat, charts and panels work without changes.

| Path | Contents |
|---|---|
| `packages/core` | Domain contract, the four domains, hashing, stream protocol |
| `apps/server` | Agent pipelines, Prune and Gemini gateway, Jev client, Swarms client, keyless routing |
| `apps/web` | Shared shell and one scene per domain |

## Known limits

- Prune's response cache is off, because semantic matches ignored numbers in prompts.
- The status chips show that a key is set, not that it works.
- Without keys, only the built-in templates are available.

## Planned

More domains, Vultr hosting, Tiger Data storage, Auth0 sign-in, Solana publishing and an M5Stack controller.
