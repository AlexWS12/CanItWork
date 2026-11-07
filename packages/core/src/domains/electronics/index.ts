import type { Domain, Hypothesis, Incident, Issue, RecoveryOption } from '../../domain';
import { countOf } from '../warehouse';
import { CircuitPatchSchema, CircuitRun, wireId } from './circuit';
import { CircuitSpecSchema, PINS, isOutput, pinsOf, type CircuitSpec, type Part } from './parts';

const pinExists = (spec: CircuitSpec, key: string) => {
  const [id, pin] = key.split('.');
  const part = spec.parts.find((p) => p.id === id);
  return Boolean(part && pinsOf(part).includes(pin));
};

function validateCircuit(spec: CircuitSpec): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  for (const part of spec.parts) {
    if (ids.has(part.id)) issues.push({ severity: 'error', message: `Duplicate part id ${part.id}`, target: part.id });
    ids.add(part.id);
    if (part.type !== 'custom') continue;
    const custom = part.custom;
    if (!custom) {
      issues.push({ severity: 'error', message: `${part.id} is custom but has no definition`, target: part.id });
      continue;
    }
    const named = [...custom.paths.flatMap((p) => [p.a, p.b]), ...custom.switches.flatMap((s) => [s.a, s.b, s.when, s.ref]), ...custom.drivers.flatMap((d) => [d.pin, d.high, d.low, d.when, d.ref]), ...custom.sources.flatMap((s) => [s.pos, s.neg]), ...custom.gpio, ...(custom.supply ? [custom.supply.pos, custom.supply.neg] : [])];
    const unknown = named.find((pin) => !custom.pins.includes(pin));
    if (unknown) issues.push({ severity: 'error', message: `${part.id} uses pin ${unknown}, which isn't in its pin list`, target: part.id });
  }
  spec.wires.forEach((wire, i) => {
    for (const end of [wire.from, wire.to]) {
      if (!pinExists(spec, end)) issues.push({ severity: 'error', message: `${wireId(i)} connects to ${end}, which doesn't exist`, target: wireId(i) });
    }
  });
  for (const drive of spec.drive) {
    if (!pinExists(spec, drive.pin)) issues.push({ severity: 'error', message: `Program drives ${drive.pin}, which doesn't exist` });
  }
  if (!spec.parts.some((p) => p.type === 'arduino' || p.type === 'battery' || p.custom?.sources.length)) {
    issues.push({ severity: 'error', message: 'There is no power source' });
  }
  if (issues.some((i) => i.severity === 'error')) return issues;
  if (!spec.parts.some(isOutput)) {
    issues.push({ severity: 'warning', message: 'Nothing in this circuit does anything observable, so there is nothing to simulate', repair: true });
  }

  const run = new CircuitRun(spec, 1);
  for (let i = 0; i < 70; i++) run.step();
  for (const key of run.burned) {
    const cause = run.burnCauses.get(key);
    issues.push({ severity: 'warning', message: `${key} burns out when powered${cause ? `: ${cause}` : ''}`, target: key.split('.')[0], repair: true });
  }
  for (const part of spec.parts) {
    const overload = run.burned.has(part.id) ? null : describeOverload(part, run);
    if (overload) {
      issues.push({ severity: 'warning', message: overload, target: part.id, repair: true });
    } else if (isOutput(part) && !run.burned.has(part.id) && !run.isHealthy(part)) {
      issues.push({ severity: 'warning', message: `${part.id} never turns on with this wiring`, target: part.id, repair: true });
    }
    if (part.type === 'resistor' || part.type === 'led' || part.type === 'motor' || part.type === 'buzzer') {
      const open = PINS[part.type].filter((pin) => !spec.wires.some((w) => w.from === `${part.id}.${pin}` || w.to === `${part.id}.${pin}`));
      if (open.length) issues.push({ severity: 'warning', message: `${part.id} has an unconnected pin: ${open.join(', ')}`, target: part.id });
    }
  }
  return issues;
}

function describeOverload(part: Part, run: CircuitRun) {
  const reading = run.readings.get(part.id);
  if (!reading || reading.load <= 1) return null;
  const maxVolts = part.custom?.supply?.maxVolts;
  if (maxVolts && reading.volts > maxVolts) {
    return `${part.id} gets ${reading.volts.toFixed(1)} V, above its ${maxVolts} V maximum`;
  }
  if (part.type === 'resistor') return `${part.id} dissipates more than its ${reading.rated} rating`;
  return `${part.id} carries ${Math.round(reading.amps * 1000)} mA, above its ${reading.rated} rating`;
}

function wireTouching(spec: CircuitSpec, id: string) {
  const index = spec.wires.findIndex((w) => w.from.startsWith(`${id}.`) || w.to.startsWith(`${id}.`));
  return index >= 0 ? wireId(index) : null;
}

function buildCircuit(prompt: string): CircuitSpec {
  const text = prompt.toLowerCase();
  const parts: Part[] = [{ id: 'U1', type: 'arduino' }];
  const wires: CircuitSpec['wires'] = [];
  const drive: CircuitSpec['drive'] = [];
  const pins = ['D13', 'D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2'];
  const wire = (from: string, to: string) => wires.push({ from, to });

  const bare = /(no|without( a| any)?) resistors?/.test(text);
  const motors = Math.min(2, countOf(text, 'motors?') ?? (/\bmotor/.test(text) ? 1 : 0));
  const leds = Math.min(6, countOf(text, '(?:leds?|lights?)') ?? (/\bleds?\b|blink/.test(text) ? 1 : motors ? 0 : 1));

  for (let i = 1; i <= leds; i++) {
    const pin = `U1.${pins.shift()}`;
    const color = (['red', 'green', 'blue', 'yellow', 'white'] as const)[(i - 1) % 5];
    parts.push({ id: `D${i}`, type: 'led', color });
    drive.push({ pin, mode: 'blink', period: 20 + i * 6 });
    if (bare) {
      wire(pin, `D${i}.anode`);
    } else {
      parts.push({ id: `R${i}`, type: 'resistor', ohms: 220 });
      wire(pin, `R${i}.a`);
      wire(`R${i}.b`, `D${i}.anode`);
    }
    wire(`D${i}.cathode`, 'U1.GND');
  }

  if (motors) {
    parts.push({ id: 'B1', type: 'battery', volts: 9 }, { id: 'M1', type: 'motor_driver' });
    wire('B1.pos', 'M1.VS');
    wire('B1.neg', 'M1.GND');
    wire('B1.neg', 'U1.GND');
    wire('U1.5V', 'M1.VCC');
    for (let i = 0; i < motors; i++) {
      const [a, b, out1, out2] = i === 0 ? ['IN1', 'IN2', 'OUT1', 'OUT2'] : ['IN3', 'IN4', 'OUT3', 'OUT4'];
      const high = `U1.${pins.shift()}`;
      const low = `U1.${pins.shift()}`;
      parts.push({ id: `MOT${i + 1}`, type: 'motor' });
      wire(high, `M1.${a}`);
      wire(low, `M1.${b}`);
      wire(`M1.${out1}`, `MOT${i + 1}.a`);
      wire(`M1.${out2}`, `MOT${i + 1}.b`);
      drive.push({ pin: high, mode: 'high' }, { pin: low, mode: 'low' });
    }
  }
  if (/ultrasonic|distance sensor/.test(text)) {
    parts.push({ id: 'S1', type: 'ultrasonic' });
    wire('U1.5V', 'S1.VCC');
    wire('U1.GND', 'S1.GND');
    wire(`U1.${pins.shift()}`, 'S1.TRIG');
    wire(`U1.${pins.shift()}`, 'S1.ECHO');
  }
  if (/buzzer/.test(text)) {
    const pin = `U1.${pins.shift()}`;
    parts.push({ id: 'BZ1', type: 'buzzer' });
    wire(pin, 'BZ1.pos');
    wire('BZ1.neg', 'U1.GND');
    drive.push({ pin, mode: 'high' });
  }
  return { parts, wires, drive };
}

function hypotheses(spec: CircuitSpec): Hypothesis[] {
  const out: Hypothesis[] = [];
  const run = new CircuitRun(spec, 1);
  for (let i = 0; i < 10; i++) run.step();
  for (const part of spec.parts.filter(isOutput).slice(0, 2)) {
    const wire = wireTouching(spec, part.id);
    if (wire) out.push({ claim: `${part.id} depends on ${wire}: one loose wire takes it out.`, incident: { type: 'loose_wire', target: wire } });
  }
  const resistor = spec.parts.find((p) => p.type === 'resistor');
  if (resistor) out.push({ claim: `If ${resistor.id} shorts, nothing limits the current through its LED and pin.`, incident: { type: 'short_part', target: resistor.id } });
  const battery = spec.parts.find((p) => p.type === 'battery');
  if (battery) out.push({ claim: `A sagging ${battery.id} drops the motors below their working voltage.`, incident: { type: 'low_supply', target: battery.id, value: (battery.volts ?? 9) / 3 } });
  return out.slice(0, 3);
}

function recoveries(spec: CircuitSpec, incident: Incident | undefined): RecoveryOption[] {
  const target = incident?.target ?? '';
  const replace = { author: 'Bench rules', title: `Replace ${target}`, rationale: 'Swap in a working part.', patches: [{ op: 'replace_part', part: target }] };
  const wire = wireTouching(spec, target);
  const limited = wire
    ? { author: 'Bench rules', title: `Replace ${target} and add 220 Ω`, rationale: 'A new part plus a series resistor keeps the current inside its rating.', patches: [{ op: 'replace_part', part: target }, { op: 'insert_resistor', wire, ohms: 220 }] }
    : null;
  switch (incident?.type) {
    case 'loose_wire':
      return [{ author: 'Bench rules', title: `Reseat ${target}`, rationale: 'Reconnect the loose wire.', patches: [{ op: 'secure_wire', wire: target }] }];
    case 'low_supply':
      return [{ author: 'Bench rules', title: 'Fit a fresh battery', rationale: 'Restore the rated supply voltage.', patches: [{ op: 'set_volts', part: target, volts: spec.parts.find((p) => p.id === target)?.volts ?? 9 }] }];
    case 'burn_part':
    case 'short_part':
      return limited ? [replace, limited] : [replace];
    default:
      return [];
  }
}

export const electronics: Domain<CircuitSpec, CircuitSpec> = {
  id: 'electronics',
  label: 'Electronics',
  blurb: 'Arduino projects and DC circuits, with real voltages and currents',
  capabilities: 'DC power and wiring of any electronics project. Built-in parts cover Arduino-style boards, resistors, LEDs, buttons, buzzers, DC motors, H-bridge drivers, ultrasonic sensors and batteries, and any other component or board (servos, ESP32s, relays, displays, sensors, regulators, drivers) can be defined from its pins, electrical paths, voltage range and current rating. Solves voltages and currents, checks ratings and burns out overloaded parts.',
  limits: ['DC only: no AC, capacitors, inductors or transients', 'Boards are assumed powered', 'Sketches are modelled as pin states, not real code', 'Custom parts model power and wiring, not their internal logic or signals', 'Motor back-EMF is ignored'],
  examples: ['An Arduino with a motor driver, two motors and an ultrasonic sensor', 'A blinking LED wired to an Arduino with no resistor'],
  suggestions: ['What happens if the battery runs low?', 'Is anything over its rating?', 'What happens if a wire comes loose?'],
  keywords: /arduino|circuit|breadboard|\bleds?\b|resistor|motor driver|h-bridge|ultrasonic|buzzer|electronic|robotic system/i,
  ticksPerSecond: 12,
  horizon: 300,
  seeds: 1,
  responseDelay: 10,
  specSchema: CircuitSpecSchema,
  specDoc: `{
  "parts": [{"id": unique string, "type": type, "ohms"?: number, "volts"?: number, "maxAmps"?: number, "color"?: "red"|"yellow"|"green"|"blue"|"white"}],
  "wires": [{"from": "PartId.pin", "to": "PartId.pin"}],
  "drive": [{"pin": "U1.D13", "mode": "high"|"low"|"blink", "period"?: ticks}]
}
Types and their pins:
${Object.entries(PINS).filter(([type]) => type !== 'custom').map(([type, pins]) => `${type}: ${pins.join(', ')}`).join('\n')}
Give every motor, pump or fan its winding "ohms" and rated "maxAmps" for the voltage it runs at: a 12 V pump drawing 1 A is 12 ohms and maxAmps 1.5, a small 6 V hobby motor is 6 ohms and 1.2. Give every battery the "maxAmps" it can really supply: a 9 V PP3 is about 0.5, AA packs about 2, LiPo packs and 12 V adapters 3 to 10. Size it for everything it powers at once.
motor_driver is only an L298N-style dual H-bridge; any other driver chip (A4988, DRV8825, TB6612, ULN2003) is custom.
custom: any other component or board. Never leave out a component the user named: if it isn't a type above, define it with type "custom" and a "custom" object, using realistic datasheet values:
{"label": name, "pins": [names], "paths": [{"a": pin, "b": pin, "ohms": number}], "switches": [{"a": pin, "b": pin, "ohms": number, "when": control pin, "ref": its reference pin, "aboveVolts": number}], "drivers": [{"pin": output pin, "high": pin, "low": pin, "when": control pin, "ref": its reference pin, "aboveVolts": number, "ohms": number, "invert": boolean}], "sources": [{"pos": pin, "neg": pin, "volts": number, "ohms": number}], "gpio": [pins the program can drive], "gpioVolts": number, "supply": {"pos": pin, "neg": pin, "minVolts": number, "maxVolts": number}, "maxAmps": number, "output": true if it does something observable, "visual": [{"shape": "box"|"cylinder"|"sphere", "size": [x,y,z], "at": [x,y,z], "color": "#rrggbb", "moves": true for a moving part}]}
"paths" are its resistive paths: model what it draws as a path between its power pins (a part drawing 100 mA at 5 V is 50 ohms), and a pass-through such as a driver's power rail as a very low value. "switches" are paths that only conduct when a control pin is high, for relay contacts and transistors. A relay is {"a":"COM","b":"NO","ohms":0.05,"when":"IN","ref":"GND","aboveVolts":2}. "drivers" are outputs that swing between two rails from a control pin, for motor drivers, H-bridges and stepper drivers. A coil or motor needs its two ends on opposite rails, so give each pair one normal and one inverted output: {"pin":"1A","high":"VMOT","low":"GND","when":"STEP","ref":"GND","aboveVolts":2,"ohms":1} and {"pin":"1B","high":"VMOT","low":"GND","when":"STEP","ref":"GND","aboveVolts":2,"ohms":1,"invert":true}. "maxAmps" is the part's highest rated current, including what its outputs carry. "sources" are voltages it produces, such as a regulator or a board's 3.3 V rail. "visual" must use 3 to 8 shapes in units where the part is about 2 wide, so it looks like the real thing: y is up and sits on the bench at 0. A servo is [{"shape":"box","size":[1.6,0.9,0.8],"at":[0,0.45,0],"color":"#1f2937"},{"shape":"box","size":[2.2,0.08,0.8],"at":[0,0.65,0],"color":"#111827"},{"shape":"cylinder","size":[0.3,0.3,0.3],"at":[0.4,1.05,0],"color":"#e5e7eb"},{"shape":"box","size":[1.1,0.08,0.22],"at":[0.4,1.22,0],"color":"#f8fafc","moves":true}]. For another board such as an ESP32, use custom with sources for its rails and gpio for its pins. Use Part "custom" field only with type "custom".
"drive" lists what the sketch does to each output pin, and every pin that controls something must appear in it, including motor driver IN and EN pins. Wire electrically real circuits: use a current-limiting resistor with LEDs (220 ohms is typical), drive motors through motor_driver with a battery on VS, and share ground between the board and any battery. A battery powers a board through VIN, never its 5V or 3V3 pins. Signals on bus and data pins (I2C, SPI, PWM, UART) aren't simulated, so never make a part's power depend on them: a servo driver passes its V+ power straight through to the servo with low-ohm "paths", and its outputs need no switches. Wire exactly what the user asks for, even if it is a mistake: the checks that follow will catch it. "unmodelled" is only for behaviour this can't capture, such as a servo's angle or a display's contents, never for leaving a part out.`,
  incidentTypes: ['burn_part', 'short_part', 'loose_wire', 'low_supply'],
  incidentDoc: `{"type":"burn_part","target":"D1"}
{"type":"short_part","target":"R1"}
{"type":"loose_wire","target":"W3"} (wires are numbered from W1 in spec order)
{"type":"low_supply","target":"B1","value":volts}`,
  patchSchema: CircuitPatchSchema,
  patchDoc: `{"op":"set_ohms","part":"R1","ohms":number}
{"op":"insert_resistor","wire":"W1","ohms":number}
{"op":"set_volts","part":"B1","volts":number}
{"op":"replace_part","part":"D1"}
{"op":"secure_wire","wire":"W3"}
{"op":"rewire","wire":"W3","from":"PartId.pin","to":"PartId.pin"}
{"op":"set_drive","pin":"U1.D13","mode":"high"|"low"|"blink","period":ticks}
A burned part stays dead until replace_part, and that includes the board (use its part id) if a pin burned. Combine patches when a fix needs both a replacement and a design change.`,
  council: [
    { name: 'CircuitDesigner', brief: 'current limiting, wiring and part values' },
    { name: 'PowerEngineer', brief: 'supply voltage, current budget and motor power' },
    { name: 'BenchTechnician', brief: 'replacing or reseating what actually failed' },
  ],
  compile: (spec) => spec,
  validate: validateCircuit,
  describe: (spec) =>
    JSON.stringify({
      parts: spec.parts,
      wires: spec.wires.map((w, i) => `${wireId(i)}: ${w.from} -> ${w.to}`),
      drive: spec.drive,
    }),
  createRun: (spec, seed) => new CircuitRun(spec, seed),
  variants: (spec) =>
    spec.parts
      .filter((p) => p.type === 'resistor')
      .slice(0, 3)
      .map((p) => ({ title: `${p.id} at 1 kΩ`, patches: [{ op: 'set_ohms', part: p.id, ohms: 1000 }] })),
  rules: {
    spec: buildCircuit,
    hypotheses,
    recoveries,
  },
};
