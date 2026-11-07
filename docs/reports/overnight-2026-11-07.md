# Overnight report, Nov 7–8

All work is on the local branch `alex/circuits-beyond-arduino`: about 30 commits. The full list is in `git log main..alex/circuits-beyond-arduino`. **Nothing is pushed and nothing is merged.** `main` and Nickolas's PRs are untouched.

Checks: 188 tests pass, typecheck and Prettier are clean, and the web production build passes and is served correctly by the API server (the same setup the container runs).

## Where it started

`2 bit calculator on a breadboard` built an Arduino with four buttons: no gates and no breadboard. The cause wasn't templates. The LLM writes a spec in a parts vocabulary, and that vocabulary had no logic, no breadboard and an Arduino-first prompt.

## What it does now

`2 bit calculator on a breadboard` builds a real breadboard with a 74HC86, 74HC08 and 74HC32 in datasheet pin order, four switches with pull-downs and three LEDs. I checked all 16 input combinations independently: every one lights the correct binary sum.

The agent trace says it outright:

> Proving it works · 16 of 16 behaviour tests pass, no part over its rating at any of 9 input settings, checked in simulation
> Red Team · 3 of 3 claims confirmed, e.g. "With SW_B1, SW_B0 at 1: burn IC_XOR: 100 → 49.1 % of outputs working"

## What was built

**Simulator (core)**
- **Logic and chip state.** A chip output can follow any boolean expression over its pins, and chips can keep state that changes on clock edges. One mechanism covers gates, adders, decoders, counters, flip-flops and the 555, all tested.
- **New built-in parts:** diode (plus Zener), potentiometer, LDR, NTC thermistor, toggle switch and 7-segment display.
- **Op-amps** (LM358, TL072) are solved exactly as voltage-controlled sources in the nodal matrix. Tests confirm a non-inverting amplifier's gain of 11, a buffer, rail saturation and open-loop comparator switching. Comparators (LM393) also work as chips that compare pin voltages.
- **Pot direction fixed:** 100% now raises the voltage. All 41 seeds still pass.
- **Named boards** (Seeed XIAO, Pico, ESP32) are modelled from their real pins, and run from USB when nothing feeds their regulator.

**Checking (the "simulator decides" story)**
- **Behaviour tests.** Designs carry their own truth table, which the validator runs. A circuit with inputs must include one, with every combination when there are 4 inputs or fewer.
- **Failure traces** tell the repair exactly where the signal breaks, e.g. "LED_S1 is driven by U3.Y1 = A1 || B1 with A1=0 from U1.Y2" or "Q1's C-E switch is open: B is 0.43 V above E, needs 0.65 V".
- **New diagnostics:**
  - a sensor scaled from 0–1023 twice (the thermostat bug);
  - a world quantity that drifts out of its target with nothing to push it back (the robot bug);
  - a board told to drive pins with chip logic.
- **Red Team setups.** A claim can set inputs first, so attacks happen in a state where the damage shows. On logic circuits the rules attack from the test case that lights the most outputs.
- **Proof step.** The trace states what was verified, and each repair step names what it fixed.

**Pipeline and agents**
- **Swarms Design Council** (`DESIGN_COUNCIL=on`, off by default). Three Swarms architects (Literalist, Engineer, Builder) design in parallel. The simulator scores each design, the winner is built, and the leaderboard shows in the trace. A failure falls back to the single Architect. This is tested with mocks only: no Swarms key was available, so it has never run live.
- **Verified-design cache.** A design that passed every check is reused for the exact same prompt with **zero model calls**, after being validated again. It ships with **41 seeds**, each re-verified tonight: the calculator, 555, 4017 traffic light, flip-flop, LM393 alarm, XIAO and Pico projects, plus software, database and warehouse examples. I confirmed this on the real server: a full build ran with the ledger unchanged.
- **Numbers the user states are locked** through repairs. Before, "20 gates" became 50. Values the user didn't state, such as arrival rates, are sized to fit the stated ones.
- **Gemini:**
  - Keys rotate when given comma-separated.
  - `GEMINI_RPM` paces free-tier keys under their per-minute limit.
  - The Architect falls back to `GEMINI_MODEL` when its own model is busy.
  - Every call goes to a spend ledger.

**3D view and UI**
- **A real breadboard** for low-voltage signal circuits: chips straddle the channel, leads go into holes, jumpers run hole to hole, and switches flip when clicked. Heaters, motors and board projects stay on the bench.
- **Package renderers** (DIP, module, TO-92, TO-220, axial, radial, bulb, display and more) draw any chip or board from its pin count, with its part number printed on top. A 7-segment display lights its segments from the simulation.
- **Build tab:** a parts list plus numbered steps naming exact holes ("pin 1 sits in f3", "R2 from d5 to the top − rail"), with Copy and Markdown download.
- **Share:** copies a link of about 2 KB that replays the run exactly, recomputes its SHA-256 provenance hash and says whether it matches. An edited link is reported.
- **Fixes:** the software camera cropped long chains, and the database and electronics suggestions named things that weren't in the design.
- I checked this with real clicks in the browser: clicking two breadboard switches (A=2, B=2) lit only the 4s LED.
- **Verified landing examples:** the landing page offers seven showcase prompts the cache can serve: the calculator, the 555 + 4017 traffic light, the LM393 alarm, the Arduino 7-segment counter, a chat app, an e-commerce schema and a warehouse. A judge's first click is instant and costs nothing.
- **Fixed:** "Server offline" flashed on every first load before the status check answered.

**Ready to deploy**
- **Rate limit:** `RATE_LIMIT_PER_HOUR` caps AI builds, chats and recoveries per visitor, so a public URL can't drain the Gemini or Swarms credits. Cached example prompts are free and never count. Over the limit, a visitor gets a friendly refusal pointing to the examples. I tested it on the real server.
- **Dockerfile and [`deploy/README.md`](../../deploy/README.md):** Vultr instance, Docker, HTTPS through Caddy, and the env settings to make before sharing the URL. Docker isn't installed on this machine, so I haven't tried building the image itself.

## Scores (live Gemini, strict rubric: a design shipped with any check still failing counts as a fail)

| Run | Result |
|---|---|
| Baseline at the start (lenient rubric) | 18/21; all 3 failures were circuits (the calculator, the 555 and the AND gate used an Arduino or no gates) |
| All 11 domains, combined tree (main + #16 + #17 + this branch) | 27/34 |
| 20 new varied circuit prompts, first try | 16/19, plus 1/1 rerun = 17/20 |

The wide set passed the dimmer, flyback relay, reverse-polarity diode, **555 + 4017 traffic light**, **D flip-flop toggle**, **LM393 thermistor alarm**, OR/XOR gates, half adder, capacitor hold-on, doorbell, H-bridge, ESP32 + OLED, Arduino 7-segment counter, servo following a pot, MOSFET fan, Pico + LDR relay and two resistors in series.

Fixes made after those runs that haven't been re-run live yet:
- the night light, via the transistor trace;
- the 7-segment decoder, since tests can now name pins;
- the AND gate built from series buttons, which now uses the chip;
- the robot's world model, via the drift check;
- the call center overload, by fitting unstated loads.

## Quota

**Gemini** used 491 calls on the free-tier key today, about $0.33 at list price and $0 actual. The free tier allows `gemini-3.5-flash` only **20 requests a day**, which explains why flash-lite is the default Architect. The eval stops at 500 calls a day (`EVAL_DAILY_CAP`), so the rest of today's quota was left alone. Live runs stopped once the cap was reached. One slip afterwards: testing the rate limit sent one uncached prompt to the real server, which cost 1 Interpreter call (490 to 491) before I stopped it. After that I only sent cached prompts to the server.

**Swarms:** $0. No key was set.

## Nickolas's PRs

See [`docs/reviews/pr16-pr17-live-eval.md`](../reviews/pr16-pr17-live-eval.md).

- **#16:** no problems found.
- **#17:** one real engine bug. In demand mode, a delayed link sent nothing every other tick, so power and water designs served about 50%.
  - The root cause is found, and a 3-line fix plus a test is in [`docs/reviews/pr17-demand-delay-fix.patch`](../reviews/pr17-demand-delay-fix.patch).
  - With the fix, all 413 tests pass and those designs reach 97.9% and 98.6%.
  - Smaller notes: no warning when service is low, airport runways split into two nodes, and the camera crops the hospital sources.
  - Routing across all 11 domains held up on collision prompts.

## Decisions waiting for you

1. **Push** `alex/circuits-beyond-arduino` and open a PR. I didn't push without your OK.
2. **Merge #16**, which looks clean.
3. **Apply the patch to #17**, then merge it.
4. **Re-run the strict eval** once the free-tier quota resets at midnight Pacific: `npm run eval:suite -w @tv/server -- electronics`. It stops at the daily cap by itself.
5. **Deploying:** set `RATE_LIMIT_PER_HOUR` before sharing the URL. See `deploy/README.md`.
6. Turn on **`DESIGN_COUNCIL=on`** for the demo only if the Swarms balance allows it. Each build then costs one Swarms run.
7. `README.md` belongs to the Ship lane in the team plan. I updated it on this branch, so whoever owns it should review it.

## Suggested demo flow

1. Type `2 bit calculator on a breadboard`. The cache makes it instant: the breadboard, the chips with part numbers and the trace showing 16/16 tests.
2. Click two switches. The sum LEDs light in binary.
3. Open the Red Team claims. All three are confirmed with measurements.
4. Open the Build tab: a parts list plus hole-by-hole steps.
5. Share the run, open the link in a new tab, and point out "provenance hash matches".
6. Switch domains (a hospital ER, a payment system or a database schema) to show the breadth.
