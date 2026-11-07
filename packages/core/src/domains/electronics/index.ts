import type { Domain, Hypothesis, Incident, Issue, RecoveryOption } from '../../domain';
import { countOf } from '../warehouse';
import { CircuitPatchSchema, CircuitRun, wireId } from './circuit';
import { CircuitSpecSchema, GPIO, PINS, isOutput, pinsOf, sensorOf, type CircuitSpec, type Part } from './parts';
import { compile, namesIn, type Expr } from './sketch';

const CHECK_TICKS = 70;
const TIMED_CHECK_TICKS = 720;
const WARMUP_TICKS = 20;
const SUSTAINED_TICKS = 10;
const TWO_PINS = new Set(['resistor', 'capacitor', 'led', 'motor', 'buzzer']);

const pinExists = (spec: CircuitSpec, key: string) => {
  const [id, pin] = key.split('.');
  const part = spec.parts.find((p) => p.id === id);
  return Boolean(part && pinsOf(part).includes(pin));
};

const drivable = (spec: CircuitSpec, key: string) => {
  const [id, pin] = key.split('.');
  const part = spec.parts.find((p) => p.id === id);
  return part?.type === 'arduino' ? GPIO.includes(pin) : Boolean(part?.custom?.gpio.includes(pin));
};

const actionsOf = (spec: CircuitSpec) => (spec.program ?? []).flatMap((rule) => [...rule.then, ...(rule.else ?? [])]);

function checkProgram(spec: CircuitSpec): Issue[] {
  const issues: Issue[] = [];
  const sensorIds = new Set(spec.parts.filter((p) => sensorOf(p)).map((p) => p.id));
  for (const drive of spec.drive) {
    if (!drivable(spec, drive.pin)) issues.push({ severity: 'error', message: `The sketch drives ${drive.pin}, which isn't a pin a board can drive` });
  }
  const variables = new Set([...Object.keys(spec.vars ?? {}), ...actionsOf(spec).flatMap((a) => ('set' in a ? [a.set] : []))]);
  const known = (name: string) => name === 't' || name === 'dt' || variables.has(name) || sensorIds.has(name) || pinExists(spec, name);
  const checkExpr = (expr: Expr | undefined) => {
    if (expr === undefined || typeof expr === 'number') return;
    try {
      for (const name of namesIn(compile(expr))) {
        if (!known(name)) issues.push({ severity: 'error', message: `The program uses ${name} in "${expr}", which isn't a variable, sensor or pin` });
      }
    } catch (error) {
      issues.push({ severity: 'error', message: `The program can't read "${expr}": ${(error as Error).message}` });
    }
  };
  for (const rule of spec.program ?? []) {
    const read = rule.if?.read;
    if (read && !sensorIds.has(read) && !pinExists(spec, read)) issues.push({ severity: 'error', message: `The program reads ${read}, which isn't a sensor or a pin` });
    checkExpr(rule.when);
  }
  for (const action of actionsOf(spec)) {
    if ('show' in action) {
      if (!spec.parts.some((p) => p.id === action.show && p.custom?.actuator?.quantity === 'text'))
        issues.push({ severity: 'error', message: `The program shows text on ${action.show}, which isn't a display` });
      for (const [, inner] of action.text.matchAll(/\{([^}]+)\}/g)) checkExpr(inner.trim());
    } else if ('set' in action) {
      checkExpr(action.to);
    } else {
      if (!drivable(spec, action.pin)) issues.push({ severity: 'error', message: `The program drives ${action.pin}, which isn't a pin a board can drive` });
      checkExpr(action.value);
    }
  }
  return issues;
}

const timed = (spec: CircuitSpec) => (spec.program ?? []).some((rule) => rule.every || JSON.stringify(rule).match(/\bt\b/));

function checkParts(spec: CircuitSpec): Issue[] {
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
    const named = [
      ...custom.paths.flatMap((p) => [p.a, p.b]),
      ...custom.switches.flatMap((s) => [s.a, s.b, s.when, s.ref]),
      ...custom.drivers.flatMap((d) => [d.pin, d.high, d.low, d.when, d.ref]),
      ...custom.sources.flatMap((s) => [s.pos, s.neg, ...(s.from ? [s.from] : [])]),
      ...custom.gpio,
      ...(custom.supply ? [custom.supply.pos, custom.supply.neg] : []),
      ...(custom.sensor?.pin ? [custom.sensor.pin] : []),
      ...(custom.actuator?.pin ? [custom.actuator.pin] : []),
    ];
    const unknown = named.find((pin) => !custom.pins.includes(pin));
    if (unknown) issues.push({ severity: 'error', message: `${part.id} uses pin ${unknown}, which isn't in its pin list`, target: part.id });
    if (custom.sensor && custom.sensor.max <= custom.sensor.min) issues.push({ severity: 'error', message: `${part.id}'s sensor range is empty`, target: part.id });
  }
  return issues;
}

function scenarios(spec: CircuitSpec) {
  const out: Array<{ incident?: Incident; when: string }> = [{ when: '' }];
  for (const part of spec.parts) {
    const sensor = sensorOf(part);
    if (!sensor) continue;
    for (const value of [sensor.min, sensor.max]) {
      out.push({ incident: { type: 'set_reading', target: part.id, value }, when: ` when ${part.id} reads ${value}${sensor.unit ? ` ${sensor.unit}` : ''}` });
    }
  }
  return out.slice(0, 7);
}

function explore(spec: CircuitSpec) {
  const burned = new Map<string, string>();
  const overloads = new Map<string, string>();
  const ran = new Set<string>();
  for (const { incident, when } of scenarios(spec)) {
    const run = new CircuitRun(spec, 1, true);
    if (incident) run.inject(incident);
    const over = new Map<string, { ticks: number; message: string }>();
    const ticks = !incident && timed(spec) ? TIMED_CHECK_TICKS : CHECK_TICKS;
    for (let i = 0; i < ticks; i++) {
      run.step();
      for (const part of spec.parts) {
        if (isOutput(part) && run.isRunning(part)) ran.add(part.id);
        const message = i >= WARMUP_TICKS && !run.burned.has(part.id) ? describeOverload(part, run) : null;
        if (message) over.set(part.id, { ticks: (over.get(part.id)?.ticks ?? 0) + 1, message: over.get(part.id)?.message ?? message });
      }
    }
    for (const key of run.burned) {
      const cause = run.burnCauses.get(key);
      if (!burned.has(key)) burned.set(key, `${key} burns out${when || ' when powered'}${cause ? `: ${cause}` : ''}`);
    }
    for (const [id, { ticks, message }] of over) {
      if (ticks >= SUSTAINED_TICKS && !overloads.has(id) && !run.burned.has(id)) overloads.set(id, `${message}${when}`);
    }
  }
  return { burned, overloads, ran };
}

function validateCircuit(spec: CircuitSpec): Issue[] {
  const issues = checkParts(spec);
  spec.wires.forEach((wire, i) => {
    for (const end of [wire.from, wire.to]) {
      if (!pinExists(spec, end)) issues.push({ severity: 'error', message: `${wireId(i)} connects to ${end}, which doesn't exist`, target: wireId(i) });
    }
  });
  issues.push(...checkProgram(spec));
  if (!spec.parts.some((p) => p.type === 'arduino' || p.type === 'battery' || p.custom?.sources.length)) {
    issues.push({ severity: 'error', message: 'There is no power source' });
  }
  if (issues.some((i) => i.severity === 'error')) return issues;
  if (!spec.parts.some(isOutput)) {
    issues.push({ severity: 'warning', message: 'Nothing in this circuit does anything observable, so there is nothing to simulate', repair: true });
  }

  const { burned, overloads, ran } = explore(spec);
  for (const [key, message] of burned) issues.push({ severity: 'warning', message, target: key.split('.')[0], repair: true });
  const shown = new Set(actionsOf(spec).flatMap((a) => ('show' in a ? [a.show] : [])));
  const sensed = spec.parts.some((p) => sensorOf(p));
  for (const part of spec.parts) {
    const overload = overloads.get(part.id);
    if (overload) {
      issues.push({ severity: 'warning', message: overload, target: part.id, repair: true });
    } else if (isOutput(part) && !burned.has(part.id) && !ran.has(part.id)) {
      const display = part.custom?.actuator?.quantity === 'text' && !shown.has(part.id);
      const message = display
        ? `${part.id} is a display, but no program rule shows anything on it`
        : `${part.id} never turns on with this wiring${sensed ? ' at any sensor reading' : ''}${timed(spec) ? ' in the first minute' : ''}`;
      issues.push({ severity: 'warning', message, target: part.id, repair: true });
    }
    if (TWO_PINS.has(part.type)) {
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
  if (maxVolts && reading.volts > maxVolts) return `${part.id} gets ${reading.volts.toFixed(1)} V, above its ${maxVolts} V maximum`;
  const rated = part.volts ?? 6;
  if (part.type === 'motor' && reading.volts > rated * 1.25) return `${part.id} gets ${reading.volts.toFixed(1)} V, too much for a ${rated} V motor`;
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
      parts.push({ id: `MOT${i + 1}`, type: 'motor', volts: 9 });
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
  const rules = spec.program ?? [];
  const sensed = spec.parts.filter((p) => sensorOf(p));
  const read = sensed.find((p) => rules.some((r) => r.if?.read === p.id || r.if?.read.startsWith(`${p.id}.`))) ?? (rules.some((r) => r.if) ? sensed[0] : undefined);
  const info = read && sensorOf(read);
  if (read && info)
    out.push({ claim: `If ${read.id} fails and reads ${info.min}, the program acts on a false reading.`, incident: { type: 'sensor_fault', target: read.id, value: info.min } });
  for (const part of spec.parts.filter(isOutput).slice(0, 2)) {
    const wire = wireTouching(spec, part.id);
    if (wire) out.push({ claim: `${part.id} depends on ${wire}: one loose wire takes it out.`, incident: { type: 'loose_wire', target: wire } });
  }
  const resistor = spec.parts.find((p) => p.type === 'resistor');
  if (resistor) out.push({ claim: `If ${resistor.id} shorts, nothing limits the current through its LED and pin.`, incident: { type: 'short_part', target: resistor.id } });
  const battery = spec.parts.find((p) => p.type === 'battery');
  if (battery)
    out.push({
      claim: `A sagging ${battery.id} drops everything it powers below working voltage.`,
      incident: { type: 'low_supply', target: battery.id, value: (battery.volts ?? 9) / 3 },
    });
  return out.slice(0, 3);
}

function recoveries(spec: CircuitSpec, incident: Incident | undefined): RecoveryOption[] {
  const target = incident?.target ?? '';
  const replace = { author: 'Bench rules', title: `Replace ${target}`, rationale: 'Swap in a working part.', patches: [{ op: 'replace_part', part: target }] };
  const wire = wireTouching(spec, target);
  const limited = wire
    ? {
        author: 'Bench rules',
        title: `Replace ${target} and add 220 Ω`,
        rationale: 'A new part plus a series resistor keeps the current inside its rating.',
        patches: [
          { op: 'replace_part', part: target },
          { op: 'insert_resistor', wire, ohms: 220 },
        ],
      }
    : null;
  switch (incident?.type) {
    case 'loose_wire':
      return [{ author: 'Bench rules', title: `Reseat ${target}`, rationale: 'Reconnect the loose wire.', patches: [{ op: 'secure_wire', wire: target }] }];
    case 'low_supply':
      return [
        {
          author: 'Bench rules',
          title: 'Fit a fresh battery',
          rationale: 'Restore the rated supply voltage.',
          patches: [{ op: 'set_volts', part: target, volts: spec.parts.find((p) => p.id === target)?.volts ?? 9 }],
        },
      ];
    case 'sensor_fault':
      return [replace];
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
  blurb: 'Arduino projects and circuits, with real voltages, currents and sketch logic over time',
  capabilities:
    'Electronics projects of any kind. Built-in parts cover Arduino-style boards, resistors, capacitors, LEDs, buttons, buzzers, DC motors, H-bridge drivers, ultrasonic sensors and batteries, and any other component or board (servos, ESP32s, relays, displays, sensors, regulators, drivers) is defined from its pins, electrical paths, ratings, sensor reading or actuator output. Simulates over time: voltages and currents, PWM, capacitor charging, motor spin-up and back-EMF, board power and brownout, sensor readings, servo angles, display text and the sketch as rules that react to readings. Checks ratings and burns out overloaded parts.',
  limits: [
    'Time runs in 1/12 s steps, so radio, audio and fast signal waveforms are averaged',
    'Sketches are rules over readings and pin states, not compiled code',
    'Mechanical load, heat and physical motion beyond rotation are not simulated',
  ],
  examples: ['An Arduino with a motor driver, two motors and an ultrasonic sensor', 'A blinking LED wired to an Arduino with no resistor'],
  suggestions: ['What happens if the battery runs low?', 'Is anything over its rating?', 'What happens if a wire comes loose?'],
  keywords: /arduino|esp32|raspberry pi pico|circuit|breadboard|\bleds?\b|resistor|capacitor|servo|sensor|motor driver|h-bridge|ultrasonic|buzzer|electronic|robotic system/i,
  ticksPerSecond: 12,
  horizon: 300,
  seeds: 1,
  responseDelay: 10,
  specSchema: CircuitSpecSchema,
  specDoc: `{
  "parts": [{"id": unique string, "type": type, "ohms"?: number, "volts"?: number, "maxAmps"?: number, "farads"?: number, "usb"?: boolean, "color"?: "red"|"yellow"|"green"|"blue"|"white"}],
  "wires": [{"from": "PartId.pin", "to": "PartId.pin"}],
  "drive": [{"pin": "U1.D13", "mode": "high"|"low"|"blink"|"pwm"|"angle", "value"?: number, "period"?: ticks}],
  "vars"?: {"name": starting number},
  "program": [{"every"?: seconds, "when"?: expression, "then": [Action], "else"?: [Action]}]
}
Types and their pins:
${Object.entries(PINS)
  .filter(([type]) => type !== 'custom')
  .map(([type, pins]) => `${type}: ${pins.join(', ')}`)
  .join('\n')}
Give every motor, pump or fan its rated "volts", winding "ohms" and rated "maxAmps": a 12 V pump drawing 1 A is volts 12, ohms 12, maxAmps 1.5; a small hobby motor is volts 6, ohms 6, maxAmps 1.2. Motors spin up over time and draw less once turning. Give every battery the "maxAmps" it can really supply: a 9 V PP3 is about 0.5, AA packs about 2, LiPo packs and 12 V adapters 3 to 10. Size it for everything it powers at once. A capacitor needs "farads" (100 uF is 0.0001) and charges and discharges over time.
An arduino runs from USB unless its VIN is wired; through VIN it needs about 6 V or more or it browns out and resets. Set "usb": true on a board that is plugged into USB as well. A battery powers a board through VIN, never its 5V or 3V3 pins.
motor_driver is only an L298N-style dual H-bridge; any other driver chip (A4988, DRV8825, TB6612, ULN2003) is custom.
custom: any other component or board. Never leave out a component the user named: if it isn't a type above, define it with type "custom" and a "custom" object, using realistic datasheet values:
{"label": name, "pins": [names], "paths": [{"a": pin, "b": pin, "ohms": number}], "switches": [{"a": pin, "b": pin, "ohms": number, "when": control pin, "ref": its reference pin, "aboveVolts": number}], "drivers": [{"pin": output pin, "high": pin, "low": pin, "when": control pin, "ref": its reference pin, "aboveVolts": number, "ohms": number, "invert": boolean}], "sources": [{"pos": pin, "neg": pin, "volts": number, "ohms": number, "from"?: input pin, "dropout"?: volts}], "gpio": [pins the program can drive], "gpioVolts": number, "supply": {"pos": pin, "neg": pin, "minVolts": number, "maxVolts": number}, "maxAmps": number, "output": true if it does something observable, "sensor"?: Sensor, "actuator"?: Actuator, "visual": [{"shape": "box"|"cylinder"|"sphere", "size": [x,y,z], "at": [x,y,z], "color": "#rrggbb", "moves": true for a moving part}]}
"paths" are its resistive paths: model what it draws as a path between its power pins (a part drawing 100 mA at 5 V is 50 ohms), and a pass-through such as a driver's power rail as a very low value. "switches" are paths that only conduct when a control pin is high, for relay contacts and transistors. A relay is {"a":"COM","b":"NO","ohms":0.05,"when":"IN","ref":"GND","aboveVolts":2}. "drivers" are outputs that swing between two rails from a control pin, for motor drivers, H-bridges and stepper drivers. A coil or motor needs its two ends on opposite rails, so give each pair one normal and one inverted output: {"pin":"1A","high":"VMOT","low":"GND","when":"STEP","ref":"GND","aboveVolts":2,"ohms":1} and {"pin":"1B","high":"VMOT","low":"GND","when":"STEP","ref":"GND","aboveVolts":2,"ohms":1,"invert":true}. "maxAmps" is the part's highest rated current, including what its outputs carry. "sources" are voltages it produces, such as a board's 3.3 V rail; a regulator takes "from" its input pin and "dropout", so it fails when its input sags. For another board such as an ESP32, use custom with sources for its rails and gpio for its pins.
Sensor: {"quantity": what it measures, "unit": "%"|"C"|"cm"|..., "min": number, "max": number, "value": a typical reading, "pin"?: its analog output pin}. With "pin" it outputs a voltage proportional to the reading (wire it to an analog pin); without, it is read over I2C, SPI or 1-wire by its id. Give it a "supply" so it only reads when powered.
Actuator: {"quantity": "angle"|"speed"|"brightness"|"text", "pin"?: its control pin, "min": number, "max": number}. A servo is angle, min 0, max 180, on its signal pin, which the sketch drives with mode "angle" and value in degrees. A display (LCD, OLED, 7-segment) is text and shows what the program writes to it.
"visual" must use 3 to 8 shapes in units where the part is about 2 wide, so it looks like the real thing: y is up and sits on the bench at 0. A servo is [{"shape":"box","size":[1.6,0.9,0.8],"at":[0,0.45,0],"color":"#1f2937"},{"shape":"box","size":[2.2,0.08,0.8],"at":[0,0.65,0],"color":"#111827"},{"shape":"cylinder","size":[0.3,0.3,0.3],"at":[0.4,1.05,0],"color":"#e5e7eb"},{"shape":"box","size":[1.1,0.08,0.22],"at":[0.4,1.22,0],"color":"#f8fafc","moves":true}]. Use Part "custom" field only with type "custom".
"drive" is each output pin's state at startup: "pwm" takes "value" from 0 to 1 for speed or brightness, "angle" takes degrees. "program" is the sketch's loop and runs every tick, rule by rule. A rule with "every" runs once per that many seconds; one with "when" runs "then" while the expression is true and "else" while it is false; one with neither runs every tick. Actions: {"pin": "U1.D9", "mode": ..., "value"?: expression}, {"set": variable, "to": expression}, {"show": display id, "text": "Angle {angle} deg"}, where each {expression} becomes its value. An expression is a number or a string using numbers, "vars", t (seconds since the sketch started), sensor ids, "PartId.pin" readings, + - * / %, < > <= >= == !=, && || !, a ? b : c, and min, max, abs, round, floor, ceil, sqrt, sin, cos, clamp(x, lo, hi). Variables keep their value between ticks and reset when the board resets. A servo sweep is "vars": {"angle": 0, "step": 5} with rules {"every": 0.05, "then": [{"set": "angle", "to": "angle + step"}]}, {"when": "angle >= 180", "then": [{"set": "step", "to": -5}]}, {"when": "angle <= 0", "then": [{"set": "step", "to": 5}]}, {"then": [{"pin": "U1.D9", "mode": "angle", "value": "angle"}]}. Use variables and t for anything timed: sequences, timers, debouncing and state machines. Read a sensor by its id. Reading one of its pins, or a board pin wired to it, gives the same reading in the sensor's own unit (an ultrasonic gives distance in cm, 2 to 400), except an arduino analog pin wired to a sensor's analog output, which gives 0 to 1023. Any other arduino digital pin reads 0 or 1, and any other board's pin its voltage. A button is released until someone presses it; wire it with a pull-down or pull-up resistor so its pin reads 0 or 1. Every pin that controls something must be in drive or the program, including motor driver IN and EN pins. Use the program for anything that reacts to a sensor.
Wire electrically real circuits: use a current-limiting resistor with LEDs (220 ohms is typical), drive motors through a driver with a battery on its motor supply, and share ground between the board and any battery. A servo driver passes its V+ power straight through to the servo with low-ohm "paths". Wire exactly what the user asks for, even if it is a mistake: the checks that follow will catch it. "unmodelled" is only for behaviour none of this can represent, such as a radio link or a mechanical load, never for leaving a part out.`,
  incidentTypes: ['burn_part', 'short_part', 'loose_wire', 'low_supply', 'sensor_fault', 'set_reading'],
  incidentDoc: `{"type":"burn_part","target":"D1"}
{"type":"short_part","target":"R1"}
{"type":"loose_wire","target":"W3"} (wires are numbered from W1 in spec order)
{"type":"low_supply","target":"B1","value":volts}
{"type":"sensor_fault","target":"S1","value":the wrong reading it gets stuck at}
{"type":"set_reading","target":"S1","value":reading} (a change in conditions, such as the soil drying out, not a failure)`,
  patchSchema: CircuitPatchSchema,
  patchDoc: `{"op":"set_ohms","part":"R1","ohms":number}
{"op":"insert_resistor","wire":"W1","ohms":number}
{"op":"set_volts","part":"B1","volts":number}
{"op":"set_farads","part":"C1","farads":number}
{"op":"set_usb","part":"U1","usb":boolean}
{"op":"replace_part","part":"D1"}
{"op":"secure_wire","wire":"W3"}
{"op":"rewire","wire":"W3","from":"PartId.pin","to":"PartId.pin"}
{"op":"set_drive","pin":"U1.D13","mode":"high"|"low"|"blink"|"pwm"|"angle","value"?:number,"period"?:ticks}
{"op":"set_program","program":[Rule],"vars"?:{"name":number}} (replaces the whole program)
A burned part stays dead until replace_part, and that includes the board (use its part id) if a pin burned. Combine patches when a fix needs both a replacement and a design change.`,
  council: [
    { name: 'CircuitDesigner', brief: 'current limiting, wiring and part values' },
    { name: 'PowerEngineer', brief: 'supply voltage, current budget and motor power' },
    { name: 'FirmwareEngineer', brief: 'the sketch logic, sensor handling and fail-safe behaviour' },
  ],
  compile: (spec) => spec,
  validate: validateCircuit,
  describe: (spec) =>
    JSON.stringify({
      parts: spec.parts,
      wires: spec.wires.map((w, i) => `${wireId(i)}: ${w.from} -> ${w.to}`),
      drive: spec.drive,
      vars: spec.vars ?? {},
      program: spec.program ?? [],
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
