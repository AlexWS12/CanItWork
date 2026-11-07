# Demo: the self-watering planter

A two-to-three minute walkthrough that shows the whole idea:

1. describe a system in plain English;
2. watch agents design it while a simulator checks their work;
3. break it;
4. watch fixes get proposed, simulated and ranked.

`packages/core/test/demo.test.ts` locks in everything the demo relies on, so a failing test means the demo changed.

## Before you present

- [ ] Pull main, then `npm install` and `npm run dev`. Open http://localhost:5173 full screen at 1440×900 or larger.
- [ ] The status chips at the top read Gemini, Jev, Swarms and Prune as working, not just set.
- [ ] The Swarms balance is well above `SWARMS_KEEP_USD`, since each build and recovery costs about $0.03–0.04.
- [ ] Do one dry run of the whole script on the presenting machine.
- [ ] If keys or the network fail on the day, blank `PRUNE_API_KEY`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY` and `SWARMS_API_KEY` in `.env`. The server re-reads it on every request. The same planter then builds instantly from the built-in template, and the rest of the script still works, with the Agents panel tagged `Local rules`.

## Script

**1. Describe it.** On the landing page, click "A self-watering planter that keeps the soil between 30 and 70 percent".

> "There's no planter template here. It works out what kind of system this is and designs it."

- The Agents panel shows each step:
  - the Interpreter picks Electronics;
  - the Architect designs the circuit and the sketch;
  - the Validator simulates it before anyone sees it.
- If the Validator sends a design back, point at it: "it caught its own mistake in simulation and fixed it". With keys, a build takes 30–50 s, so talk through the panel while it works.
- The Red Team then states how it should break. Each claim shows Confirmed or Refuted with a measured score. A typical one: "If S1 sticks at 100%, the sketch acts on a false reading". It's confirmed because the plant never gets watered.

**2. Show it working.** Point at the bench.

- The soil sensor reads the soil, the sketch switches the relay, and the pump spins.
- The LCD shows the live reading.
- The world panel shows soil moisture cycling between about 35% and 60% inside the shaded 30–70% target band.

> "This isn't an animation. Voltages, currents, motor spin-up, the sketch and the soil drying out are all simulated every tick."

**3. Change the conditions, not the circuit.** Click the soil sensor, then "Reading low".

- The pump kicks in and the soil recovers.
- The score stays high, because a change in conditions isn't a failure. The simulator compares against a fault-free copy of the same design.

**4. Break it.** Click "Burn P1" in the Break bar.

- The pump stops and the soil dries out of its band. The world panel turns red and the score drops.
- The recovery council proposes fixes, and the simulator replays each one and ranks it. The expected winner is "Replace P1".
- A generic option, such as adding a resistor, scores lower, because the simulator measured it rather than trusting the agent.

> "Agents propose. The simulator decides."

- Apply the winner. The pump restarts and the soil climbs back into the band.

**5. Show it's general.** Click New system and use one of these:

- "A robot car with an Arduino, an L298N, two DC motors and an HC-SR04 that drives toward a wall and stops before it gets closer than 15 cm". The validator tracks distance to the wall and rejects a car that can't stop in time.
- "A room thermostat: an ESP32 reads a DS18B20 temperature sensor and switches a 12V heater through a relay to hold the room between 20 and 23 C on a cold day".
- A non-electronics example from the landing page, such as the payment system or the university database.

## If something goes wrong

- **Build refused:** say "it refuses rather than show something wrong", then use the planter example or blank the keys.
- **Recovery slow:** the council runs on Swarms, so give it 15–30 s. If Swarms is down, recovery falls back to labelled local rules and still ranks the fixes by simulation.
- **A live design shows "Still failing the checks":** this is honest output. Point at it as the system refusing to overclaim, then use the planter.
