# Big circuits for real, a Reviewer agent, live sessions, accounts and Tiger Data

Everything on `alex/queues-and-polish` since #22, with main merged in (no conflicts left).

## Building and checking designs

- **16-bit calculators build for real.** "A 16 bit calculator on a breadboard with logical gates" used to come back as one AND gate. A design can now name a building block that compiles into real 74HC chips, switches, LEDs, wiring and its own behaviour tests: adders and adder-subtractors (up to 32 bits), comparators (32), multipliers (8), ALUs (16) and counters (3 to 16, 74HC161s on a 555 clock, proven by reset and preset). A 16-bit calculator is 20 chips on 4 breadboards and passes 10 of 10 tests, including 65535 + 1.
- **The solver settles long gate chains**, so a carry ripples through all 16 stages.
- **A Reviewer agent** compares each fresh design, as built, with the request and sends back anything it shrank or left out.
- **Repairs** keep every stated number (including "a" or "one"), add capacity before cutting unstated loads, and overload warnings now carry the numbers that fix them (the load that runs a station at 90%, or the units it needs).
- **Multi-board breadboards:** big circuits continue on full-size 63-column boards with rail jumpers; a part's signal lead is placed before its supply lead, so switches and LEDs sit beside their chips. The build guide names each hole's board.
- **Flow domains:** a station with several units can lose one (new `unit_down` incident), a bank of six elevators is no longer flagged as a single point of failure, and "waiting" no longer counts people in transit.

## Working together and sharing

- **Live sessions:** Share can start a session; everyone with the invite sees the same run, and every break, fix and switch flip shows up for all of them. The agents work for the whole room: everyone watches the Recovery Council and can apply its fixes. Sessions survive a server restart.
- **Accounts (Auth0):** sign in, save runs as public, private or shared with named people by verified email, and manage them in My systems. Works without an Auth0 API.
- **Tiger Data:** saved runs and live sessions go to Postgres when `DATABASE_URL` is set; a Tiger Data chip in the top bar shows the database answering.
- **Share panel:** link, QR code (shown on open, drawn in the browser), saved short links, live sessions.

## Product and reliability

- Landing page shows the agent team behind every build, all 13 domains grouped (with an instant verified example each), merged with main's circuit wordmark and animations.
- Prune sits out a per-minute Gemini limit instead of being benched for ten minutes.
- The first page load is a third of its old size (3D scene, Auth0 and QR load on demand).

## Testing

- 580 tests pass; typecheck and formatting clean.
- All 88 shipped verified designs still pass on this code (the 88th is the deliberate LED-with-no-resistor demo).
- Full eval: 90 of 100 cases pass, with Gemini quota outages rerun. The remaining failures are mostly logic-circuit repairs that need `gemini-3.5-flash` quota. See `docs/reports/eval-2026-11-08.md`.

## Since the last PR

- Each domain settles, without a model, what the repairs leave: loops dropped, unstated arrivals fitted to about 90% load, fleet relays added, repeated circuit pins renamed. The trace shows it as "Settling what the repairs left".
- The eval compiles only electronics designs, so warehouses are no longer misread.
- The dictation mic is gone: browser speech recognition struggled with accents.
- Checked in the browser: the 16-bit calculator (12345 + 54321 lights 66666), two-tab live sessions with shared Recovery Council, Auth0 sign-in and private links against the real tenant, and saved runs and sessions in Tiger Data.
