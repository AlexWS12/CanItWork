# CanItWork

Describe a system in plain English and get an interactive model of it. Run it, break it, and compare fixes by what they actually do.

CanItWork is a general environment builder. It works out what kind of system you described, designs it, checks it, and runs it in a simulator built for that kind of system. If it can't model something, it says so.

Built at SharkByte 2026.

## What it can build

| Domain | Simulator | View |
|---|---|---|
| Electronics | Anything from a battery and a bulb to logic chips to microcontroller projects, over time: voltages and currents, diodes and Zeners, op-amps solved exactly (amplifiers, buffers, comparators), digital logic and chip state (gates, adders, counters, flip-flops, 555 timers), PWM, capacitors, motor spin-up, board brownout, sensors, pots, LDRs, thermistors, servos, 7-segment and text displays, and quantities such as soil moisture, room temperature or distance to a wall, with ratings that burn out overloaded parts. Any named chip or board (a 74HC08, a Seeed XIAO, a Pico) is modelled from its real pins | Workbench or a real breadboard with chips straddling the channel, live wires and readings, clickable switches, and a build guide that names every hole |
| Software systems | Traffic, capacity, latency, retries, timeouts and cascading failures | Racks, databases and queues with live packets |
| Databases | Query cost, indexes, data growth, locks and broken dependencies | Table cards with keys and relationships |
| Warehouses | Robots, routing, conveyors, charging and order flow | 3D warehouse floor |

Each domain lists what it doesn't model, and the app shows that list next to every environment.

Try the first example on the landing page, a 2-bit calculator on a breadboard. It wires three logic chips, proves all 16 sums in simulation, and lights the binary result when you click the switches. The landing examples are designs that already passed every check, so they open instantly and cost no model calls. A self-watering planter shows the physical world and sketches: it keeps the soil inside its target band and recovers when you burn out the pump. [docs/DEMO.md](docs/DEMO.md) is the full walkthrough.

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
| `DESIGN_COUNCIL` | `on` has three Swarms architects design each request in parallel; the simulator builds the best design. Off by default, since each build then costs a Swarms run |
| `DESIGN_CACHE` | `off` disables the verified-design cache. On by default |
| `GEMINI_RPM` | Paces direct Gemini calls under a free-tier key's per-minute limit, such as `12` |
| `ARCHITECT_MODEL` | Model for the Architect. It falls back to `GEMINI_MODEL` when this one is busy or out of quota |

`GEMINI_API_KEY` takes several comma-separated keys and moves to the next on a quota error. Every billed Gemini call is logged to `apps/server/.spend/ledger.jsonl`.

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
- **Design Council** (optional): three Swarms architects (Literalist, Engineer, Builder) design the same request in parallel. The simulator validates and runs each design, and the best one is built. The leaderboard shows in the agent trace.
- **Proof:** once a design passes, the trace states what the simulator showed, such as "16 of 16 behaviour tests pass, no part over its rating at any of 9 input settings".
- **Verified cache:** a design that passed every check is remembered under its exact prompt and rebuilt with no model calls. It is checked again before use. Exact matching only, because a semantic cache once returned five robots when nine were asked for.

Agents propose and the simulators decide. Simulators are deterministic, so an environment, seed and event log always replay to the same result.

**Share** copies a link that holds the whole run (environment, seed and event log, deflated into the URL, about 2 KB for a 2-bit calculator), so no server is needed. Opening it replays the run tick by tick and recomputes its provenance hash, a SHA-256 of the environment, scenario and result. The app then says whether the hash matches the link. Edit one event in the link and it reports the mismatch.

## Electronics in brief

- **Parts** are built in (boards, resistors, capacitors, LEDs, buttons, motors, H-bridges, ultrasonic sensors, batteries) or defined by the Architect from pins, electrical paths, ratings, a sensor reading or an actuator output, so any board, sensor, relay, display or driver can be modelled.
- **Sketches** are rules over variables, time since start and sensor readings, with expressions such as `"angle + step"` or `"t % 30 < 3"`, run every tick. Sweeps, timers, state machines and control loops all work.
- **The world** holds physical quantities that drift, settle toward an ambient value and are pushed by the parts that act on them. Sensors read them, and a target says what the design is meant to hold.
- **Scoring** compares each run with a fault-free copy of the same design, so a change in conditions isn't a failure but a stuck sensor running a pump is.
- **Logic and chips:** a chip's outputs follow expressions over its pins (`A1 && B1`, `A1 != B1` for XOR), and chips can keep state that changes on a clock edge. Gates, adders, counters, flip-flops and the 555 all simulate from this one mechanism. They settle within the solver's fixed point, so chained gates resolve in one tick.
- **Behaviour tests:** a design carries its own truth table (inputs set, outputs on or off), and the validator runs every row. A failing row is traced to its cause, such as "LED_S1 is driven by U3.Y1 = A1 || B1 with A1=0 from U1.Y2" or "Q1's C-E switch is open: B is 0.43 V above E, needs 0.65 V". The Architect gets that as its repair note.
- **Red Team setups:** a claim can set inputs first, so an attack is judged in a state where its damage shows. On a 2-bit calculator, burning the XOR chip with 0 + 3 on the switches drops outputs from 100% to 49%.
- **Packages and breadboards:** parts are drawn by package (DIP, module, TO-92, TO-220, axial, radial, bulb, display), so any chip or board looks right from its pin count and label, with its part number printed on top. Low-voltage signal circuits go on a breadboard: chips straddle the channel in datasheet pin order, leads sit in holes, and each wire is a jumper.
- **Build guide:** the Build tab lists the parts and gives numbered steps that name breadboard holes (pin 1 of U1 in f3, R2 from d5 to the top − rail), taken from the same layout the view draws.

## Measuring it

`npm run eval:suite -w @tv/server -- [domain | case id | new | routing]` sends standalone prompts through the whole pipeline against the live API and scores the result. The checks cover parts and counts, whether the design's own behaviour tests pass, and whether it shipped with checks still failing. It bypasses the cache, logs every call to the spend ledger, and stops at `EVAL_DAILY_CAP` calls a day (default 500) to protect a free-tier key's quota.

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
