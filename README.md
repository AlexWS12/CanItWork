# tv

Describe a system in plain English and get an interactive model of it. Run it, break it, and compare fixes by what they actually do.

tv is a general environment builder. It works out what kind of system you described, designs it, checks it, and runs it in a simulator built for that kind of system. If it can't model something, it says so.

Built at SharkByte 2026.

## What it can build

| Domain | Simulator | View |
|---|---|---|
| Electronics | Circuits, sketches and the physical world they act on, over time: voltages and currents, PWM, capacitors, motor spin-up, board brownout, sensors, servos, displays, and quantities such as soil moisture, room temperature or distance to a wall, with ratings that burn out overloaded parts | Workbench with boards, parts, live wires, live readings and a world panel |
| Software systems | Traffic, capacity, latency, retries, timeouts and cascading failures | Racks, databases and queues with live packets |
| Databases | Query cost, indexes, data growth, locks and broken dependencies | Table cards with keys and relationships |
| Warehouses | Robots, routing, conveyors, charging and order flow | 3D warehouse floor |

Each domain lists what it doesn't model, and the app shows that list next to every environment.

Try the first example on the landing page, a self-watering planter. It designs the circuit and its sketch, keeps the soil inside its target band, and recovers when you burn out the pump. [docs/DEMO.md](docs/DEMO.md) is the full walkthrough.

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
npm run format:check
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
- **Validator** checks the design with the domain's own rules and by simulating it. In electronics it runs the design for a simulated minute at each sensor's extremes and rejects anything that burns out, never turns on or fails to hold its targets, saying why in terms the Architect can act on. A rejected design goes back to the Architect up to twice. Anything still failing is listed next to the environment, and a design with errors is refused instead of shown.
- **Red Team** states how the design should break, as failures the simulator can run. Each claim is shown as Confirmed or Refuted with the measurement.
- **Recovery Council** proposes fixes after a failure, and the simulator ranks them.

Agents propose and the simulators decide. Simulators are deterministic, so an environment, seed and event log always replay to the same result.

## Electronics in brief

- **Parts** are built in (boards, resistors, capacitors, LEDs, buttons, motors, H-bridges, ultrasonic sensors, batteries) or defined by the Architect from pins, electrical paths, ratings, a sensor reading or an actuator output, so any board, sensor, relay, display or driver can be modelled.
- **Sketches** are rules over variables, time since start and sensor readings, with expressions such as `"angle + step"` or `"t % 30 < 3"`, run every tick. Sweeps, timers, state machines and control loops all work.
- **The world** holds physical quantities that drift, settle toward an ambient value and are pushed by the parts that act on them. Sensors read them, and a target says what the design is meant to hold.
- **Scoring** compares each run with a fault-free copy of the same design, so a change in conditions isn't a failure but a stuck sensor running a pump is.

## Adding a domain

A domain is a folder in `packages/core/src/domains` that implements the `Domain` interface in `domain.ts`: its schema, validation, simulator, failures and fixes. Add it to `domains/index.ts`, add a scene in `apps/web/src/domains`, and register the scene in `apps/web/src/domains/index.tsx`. The agents, chat, charts and panels work without changes.

| Path | Contents |
|---|---|
| `packages/core` | Domain contract, the four domains, hashing, stream protocol |
| `apps/server` | Agent pipelines, Prune and Gemini gateway, Jev client, Swarms client, keyless routing |
| `apps/web` | Shared shell and one scene per domain |

## Known limits

- Prune's response cache is off, because semantic matches ignored numbers in prompts.
- The usage ledger leaves out Jev's cost, because TypeSafe's per-token price isn't known yet.
- Electronics time runs in 1/12 s steps, so radio, audio and fast signal waveforms are averaged.
- Without keys, only the built-in templates are available.

## Working on it

[docs/PLAN.md](docs/PLAN.md) has the team's lanes, shared-file rules and git workflow, and [docs/handoffs](docs/handoffs) has the current state of each lane.

## Planned

More domains, Vultr hosting, Tiger Data storage, Auth0 sign-in, Solana publishing and an M5Stack controller.
