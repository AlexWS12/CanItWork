# Handoff: Electronics lane

_Updated 2026-11-07 on branch `alex/physical-world`. Check `git log -- packages/core/src/domains/electronics` for anything newer._

## 1. Current state

You own `packages/core/src/domains/electronics/` and `apps/web/src/domains/electronics/`.

- `parts.ts`: the spec schema. It covers:
  - built-in parts and custom parts (`paths`, `switches`, `drivers`, `sources`, `gpio`, `supply`, `sensor`, `actuator`, `visual`);
  - the sketch: `drive`, `vars` and `program`;
  - the physical `world`;
  - `measures` on sensors, `sensorOf`, and the ratings.
- `sketch.ts`: the expression parser and evaluator used by sketch rules. It's a safe recursive-descent parser, never `eval`.
- `circuit.ts`: `CircuitRun`, the simulator, plus `CircuitPatchSchema`.
- `index.ts`: the `electronics` domain. It holds:
  - the validator (`validateCircuit`, `explore`, `checkProgram`, `checkWorld`);
  - the Architect's instructions (`specDoc`) and the keyless template (`buildCircuit`);
  - the Red Team and fix rules.
- `apps/web/src/domains/electronics/Bench.tsx` and `Bench.css`: the 3D bench, live tags on parts, and the world panel. The panel shows each quantity's value, a trace and the target band.

How the simulator works:

- **Timing:** a tick is 1/12 s of real time (`DT`).
- **Solving:** DC nodal analysis, with a fixed point over LED conduction and logic thresholds. PWM is split into its high and low phases. Motors have back-EMF. Capacitors use 4 substeps.
- **Boards:** an Arduino runs from USB unless VIN is wired. Below 4.3 V on VIN it browns out, its pins reset, and the sketch restarts. The sketch starts two ticks after boot.
- **Sensors:**
  - A sensor reads its world quantity when it `measures` one. Otherwise it reads a value you can set.
  - Reading a sensor's id, one of its pins, or the board pin wired to it gives the value in its own unit. An Arduino analog pin wired to an analog output gives 0–1023.
  - Built-in ultrasonic sensors read distance in cm. Buttons are 0/1 inputs, released until pressed.
- **Sketch:**
  - `vars` keep their values between ticks; `t` is seconds since the sketch started.
  - A rule can run `every` so many seconds, or `when` an expression holds.
  - Actions set pins, variables, or display text with `{expression}` placeholders.
- **World:**
  - Each quantity changes by its `drift`, plus a pull `toward` an ambient value, plus each effect's rate × its part's output level.
  - The output level is a motor's speed, an actuator's level, an LED's brightness, or 1/0 for anything else.
  - An actuator whose control pin no board pin drives runs at full output while powered.

How scoring works:

- Every `CircuitRun` builds a fault-free copy of itself (`twin`).
- Condition changes (`set_reading`, also on a world id) and all patches go to both copies. Failures go only to the live run.
- An output is healthy when it isn't broken or over its rating and it behaves like the copy.
- A world quantity with a `target` counts as healthy while it's inside the target. With targets, the score is "% of outputs and targets OK".

What the validator does:

- **Structure:** pins, the program (expression syntax and that every name exists), and the world (ids, ranges, effects, `measures`).
- **Simulation:** it runs the design once at default readings and once at each sensor's minimum and maximum. Timed sketches and designs with targets get a 60 s base run.
- **What it reports:**
  - burns, and overloads that persist for 10 or more ticks;
  - outputs that never turn on, and displays nothing writes to;
  - relay switches that never close, with the voltage they need and the most they got;
  - targets held less than 80% of the time, with when the quantity left the range and each part's level at that moment.

What's verified:

- 143 tests pass. The electronics ones are in `electronics.test.ts`, `sensors.test.ts`, `sketch.test.ts` and `world.test.ts` under `packages/core/test/`.
- Live Gemini builds pass end to end:
  - a servo sweep with an LCD;
  - a traffic light with a pedestrian button;
  - watering every 30 s;
  - a self-watering planter, a robot that stops before a wall, and an ESP32 thermostat.
- Checked in the browser with a mocked build: the planter holds its soil in range, and burning the pump turns the world panel red and drops the score.

## 2. Decisions made and rationale

- **Scoring against a fault-free copy.** It separates "off because conditions changed" from "off because broken", and it catches stuck sensors.
- **Patches go to both copies,** so a deliberate change isn't scored as a failure. A fix that just disables an output can tie with a real repair.
- **World effects add up.** That's correct for two pumps filling a tank, so a vehicle's speed is split across its wheel motors in the spec doc.
- **Targets are checked by simulation, not trusted.** The Architect has to write a working control loop. The diagnostics are written so it can fix its own design, for example "motors take a moment to stop, so slow down or stop earlier".
- **Expressions use a small safe parser.** Any expression the sketch uses is validated before a design is accepted.

## 3. Done vs pending

**Done:**
- Sensor reads in real units, the sketch language, buttons, the physical world with targets, diagnostics and the world panel.

**Pending:**
- **The world panel shows values and traces only.** There's no 3D picture of the world: soil, a room, the robot moving.
- **The keyless template (`buildCircuit`)** has no sensors, sketch logic or world.
- **A fix that disables a broken output can tie with a real repair** in council ranking. Agree any tie-break with Platform.
- **Four MG996R servos on a 9 V PP3 battery** weren't flagged as overloading it. Check the servos' current draw and the battery's limit.
- **Custom parts with no `visual`** render as a grey box.

## 4. Exact next action

1. Merge the stacked branches into main, in this order: `alex/sensor-reads`, `alex/sketch-language`, `alex/physical-world`.
2. Prepare the demo: a planter or thermostat with a target, broken from the Break bar, showing the world panel go red and the council's fix bring it back.
3. Then choose between a 3D view of the world and a richer keyless template.

## 5. Gotchas

- **`circuit.ts` runs in two places:** in the browser and on the server (validation, Red Team, council ranking). Keep it deterministic: no `Math.random`, no `Date`.
- **Every `CircuitRun` builds its copy,** so it costs double. Pass `reference = true` when you don't need scoring.
- **Validation is slower for timed designs.** It takes up to about a second when a design is timed or has targets, because of the 60 s base run.
- **`inject` and `apply` invalidate the cached wiring.** Any other way of changing the wiring leaves the cache stale.
- **Validator messages go to the Architect word for word.** Say what is wrong and why.
- **`specDoc` costs tokens on every build.** Keep it tight.

## 6. Running commands and background processes

```bash
npm install
npm run dev
npx vitest run packages/core
npm run typecheck
npm run format:check
```

The web app is at http://localhost:5173 and the API at 8787. Tests need no keys. Nothing runs in the background for this lane.
