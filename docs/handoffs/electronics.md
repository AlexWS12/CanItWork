# Handoff: Electronics lane

_Written 2026-11-07 against commit e136422. Check `git log -- packages/core/src/domains/electronics` for anything newer._

## 1. Current state

You own `packages/core/src/domains/electronics/` and `apps/web/src/domains/electronics/`.

- `parts.ts`: the spec schema. Built-in part types, custom parts (pins, `paths`, `switches`, `drivers`, `sources`, `gpio`, `supply`, `maxAmps`, `sensor`, `actuator`, `visual`), the sketch (`drive` start states plus `program` rules), pin lists and ratings (`LIMITS`, `PIN_LIMIT`, `RAIL_LIMIT`, `RESISTOR_WATTS`).
- `circuit.ts`: `CircuitRun`, the simulator, plus `CircuitPatchSchema`.
- `index.ts`: the `electronics` domain. It holds the validator (`validateCircuit`), the Architect's instructions (`specDoc`), the keyless template (`buildCircuit`), Red Team rules (`hypotheses`), fix rules (`recoveries`), and the `limits` and `capabilities` strings.
- `apps/web/src/domains/electronics/Bench.tsx`: layout, part bodies, custom `visual` shapes, wires with moving current dots, and live tags. Tags show sensor readings, servo angles, display text, motor speed, capacitor charge and board brownout.

How the simulator works:

- **Timing.** A tick is 1/12 s (`DT`). Static circuits re-solve only when something changes. Circuits with motors, capacitors, VIN-powered boards or regulators re-solve every tick, and capacitors use 4 substeps.
- **Solving.** Each solve is DC nodal analysis, with a fixed point over LED conduction and logic thresholds (relay switches, push-pull drivers, L298N inputs).
- **PWM.** A tick is split into the phases where each PWM pin is high or low. Each phase is solved, then weighted by duty.
- **Motors.** Winding ohms plus back-EMF. Speed 1.0 is roughly the no-load speed at the motor's rated `volts`.
- **Capacitors.** Backward-Euler companion model.
- **Arduino power.** Runs from USB unless VIN is wired (or `usb: true`). On VIN the 5 V rail is VIN − 1.2 V. Below 4.3 V the board browns out and its pins reset to `drive`. The sketch starts two ticks after boot.
- **Sensors.** Each sensor has a value. One with an analog `pin` outputs (reading fraction) × supply volts through 1 kΩ. An unpowered sensor reads NaN, shown as "no reading".
- **Actuators.** Angle, speed and brightness follow the command on their control pin: `angle` mode takes degrees, `pwm` takes 0–1. Displays show text written by `show` actions, with `{S1}` replaced by that sensor's reading.

How scoring works:

- Every `CircuitRun` builds a fault-free copy of itself (`twin`).
- Condition changes (`set_reading`) and all patches go to both copies. Failures go only to the live run: `burn_part`, `short_part`, `loose_wire`, `low_supply`, `sensor_fault`.
- An output is healthy when it isn't burned, shorted or over its rating, and it behaves like the copy:
  - it runs at the same times, within a blink-period window;
  - a servo is within 5% of the copy's angle;
  - a display shows the same text;
  - a motor turns at least 50% of the copy's speed.

What the validator does:

- Structural errors first: unknown pins, a program that reads or drives something missing, no power source.
- Then it runs the design for 70 ticks: once at default readings, then at each sensor's minimum and maximum (at most 7 runs).
- It reports burns, overloads, outputs that never turn on, and displays nothing writes to. Issues marked `repair: true` go back to the Architect.

What's verified, and what isn't:

- **Verified:** typecheck and all 102 tests pass. The electronics tests are the "electronics over time" and "electronics" blocks in `packages/core/test/domains.test.ts`.
- **Verified offline:** a greenhouse design ran through the browser UI with a mocked build. A faulted soil sensor ran the pump and dropped the score to 1/3 working.
- **Not verified:** a live Architect build using sensors, actuators and `program`.

## 2. Decisions made and rationale

- **Scoring against a fault-free copy, not an activity timer.** The old rule ("output active in the last 60 ticks") couldn't tell a pump that's off because the soil is wet from a pump that's off because it's broken. The copy can. It also catches a stuck sensor that runs a pump when it shouldn't.
- **Patches go to both copies.** A user saying "turn the buzzer off" shouldn't count as a failure. The trade-off: a fix that disables a broken output can score the same as a real repair.
- **PWM phases, not averaged voltage.** An averaged 50% PWM pin sits at 2.5 V. That fails logic thresholds, so an L298N enable pin would never turn on, and LED current comes out wrong.
- **Servo `angle` pins aren't split into phases.** They carry almost no current, and splitting them doubled solve time.
- **A two-tick boot delay, not a settle pass.** A settle with a near-zero time step made capacitors act as short circuits, so VIN boards never powered up.
- **`program` and `sources[].dropout` are optional** in the schema, so older specs and tests stay valid.
- **The UI lists only what the request asked for and the design leaves out.** The domain's three general `limits` sit behind a hover on "Electronics simulator limits".

## 3. Done vs pending

**Done:**
- Sensors, actuators, sketch rules, PWM, capacitors, back-EMF, VIN brownout, regulator dropout: `circuit.ts`, tests in "electronics over time".
- Validator explores sensor ranges and flags displays nothing writes to: `index.ts` `explore` and `validateCircuit`.
- Live tags on the bench, servo horns turning to their angle, capacitor body: `Bench.tsx`.

**Pending:**
- Live check that the Architect actually writes the new fields. Run three builds:
  - the servo prompt that used to list 7 unmodelled items;
  - a greenhouse with sensors, an LCD and a pump;
  - a robot with PWM speed control.
  It costs a little Gemini and no Swarms. Ask the team first.
- The keyless template (`buildCircuit`) has no sensors, servos or programs.
- Buttons are always closed. They could become a 0/1 sensor the program reads.
- The ultrasonic sensor only checks its power. It has no distance reading yet.
- Custom parts with no `visual` render as a grey box. Display text is a tag above the part, not drawn on it.
- The copy comparison ignores LED brightness.

## 4. Exact next action

1. Read the `specDoc` string in `packages/core/src/domains/electronics/index.ts`. It's exactly what the Architect sees.
2. Once the team OKs the spend, run the three builds above with keys set (`npm run dev`, http://localhost:5173). For each, note the "Not modelled in this design" list and any validator issues in the Agents panel.
3. Fix the spec doc or validator wherever the Architect goes wrong. Add a test for each fix in a new file, `packages/core/test/electronics.test.ts`, not in `domains.test.ts`.

## 5. Gotchas

- **`circuit.ts` runs in two places:** in the browser for the live view, and on the server for validation, Red Team claims and council ranking. Keep it fast and deterministic: no `Math.random`, no `Date`.
- **Cost:**
  - Every `CircuitRun` builds its copy, so each run costs double. Pass `reference = true` (the third constructor argument) when you don't need scoring, as the validator does.
  - A 9-part design with a capacitor validates in about 150 ms and steps in about 1.2 ms per tick, copy included.
- **Topology cache:** `inject` and `apply` invalidate the cached wiring. An op that changes wiring any other way leaves the cache stale.
- **Names:**
  - Pins are `PartId.pin`.
  - Wires are `W1`, `W2`… in spec order, and incidents and patches name them that way.
  - The validator's issue text goes back to the Architect word for word.
- **Prompt size:** `specDoc` goes straight into the prompt. Every sentence added costs tokens and latency on every build, so keep it tight.
- **Burning:** a part burns after 6 straight ticks at or above its `burnAt` load.

## 6. Running commands and background processes

```bash
npm install
npm run dev
npx vitest run packages/core
npm run typecheck
npm run build -w @tv/web
```

The web app is at http://localhost:5173 and the API at 8787. Tests need no keys. Without keys, the UI builds from `buildCircuit` and labels the result as a built-in template. Nothing runs in the background for this lane.
