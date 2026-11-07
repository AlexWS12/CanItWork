import type { Domain, Hypothesis, Incident, Issue, RecoveryOption } from '../../domain';
import { countOf } from '../warehouse';
import { CircuitPatchSchema, CircuitRun, wireId } from './circuit';
import { CircuitSpecSchema, OUTPUTS, PINS, type CircuitSpec, type Part } from './parts';

const pinExists = (spec: CircuitSpec, key: string) => {
  const [id, pin] = key.split('.');
  const part = spec.parts.find((p) => p.id === id);
  return Boolean(part && PINS[part.type].includes(pin));
};

function validateCircuit(spec: CircuitSpec): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  for (const part of spec.parts) {
    if (ids.has(part.id)) issues.push({ severity: 'error', message: `Duplicate part id ${part.id}`, target: part.id });
    ids.add(part.id);
  }
  spec.wires.forEach((wire, i) => {
    for (const end of [wire.from, wire.to]) {
      if (!pinExists(spec, end)) issues.push({ severity: 'error', message: `${wireId(i)} connects to ${end}, which doesn't exist`, target: wireId(i) });
    }
  });
  for (const drive of spec.drive) {
    if (!pinExists(spec, drive.pin)) issues.push({ severity: 'error', message: `Program drives ${drive.pin}, which doesn't exist` });
  }
  if (!spec.parts.some((p) => p.type === 'arduino' || p.type === 'battery')) {
    issues.push({ severity: 'error', message: 'There is no power source' });
  }
  if (issues.some((i) => i.severity === 'error')) return issues;

  const run = new CircuitRun(spec, 1);
  for (let i = 0; i < 70; i++) run.step();
  for (const key of run.burned) {
    issues.push({ severity: 'warning', message: `${key} burns out when powered`, target: key.split('.')[0] });
  }
  for (const part of spec.parts) {
    if (OUTPUTS.includes(part.type) && !run.burned.has(part.id) && !run.isHealthy(part)) {
      issues.push({ severity: 'warning', message: `${part.id} never turns on with this wiring`, target: part.id, repair: true });
    }
    if (part.type === 'resistor' || part.type === 'led' || part.type === 'motor' || part.type === 'buzzer') {
      const open = PINS[part.type].filter((pin) => !spec.wires.some((w) => w.from === `${part.id}.${pin}` || w.to === `${part.id}.${pin}`));
      if (open.length) issues.push({ severity: 'warning', message: `${part.id} has an unconnected pin: ${open.join(', ')}`, target: part.id });
    }
  }
  return issues;
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
  for (const part of spec.parts.filter((p) => OUTPUTS.includes(p.type)).slice(0, 2)) {
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
  capabilities: 'DC circuits on a 5 V Arduino-style board: resistors, LEDs, buttons, buzzers, DC motors, a dual H-bridge motor driver, ultrasonic sensors and batteries. Solves voltages and currents, checks ratings and burns out overloaded parts.',
  limits: ['DC only: no AC, capacitors, inductors or transients', 'The board is assumed USB powered', 'Sketches are modelled as pin states, not real code', 'Motor back-EMF is ignored'],
  examples: ['An Arduino with a motor driver, two motors and an ultrasonic sensor', 'A blinking LED wired to an Arduino with no resistor'],
  suggestions: ['What happens if the battery runs low?', 'Is anything over its rating?', 'What happens if a wire comes loose?'],
  keywords: /arduino|circuit|breadboard|\bleds?\b|resistor|motor driver|h-bridge|ultrasonic|buzzer|electronic|robotic system/i,
  ticksPerSecond: 12,
  horizon: 300,
  seeds: 1,
  responseDelay: 10,
  specSchema: CircuitSpecSchema,
  specDoc: `{
  "parts": [{"id": unique string, "type": type, "ohms"?: number, "volts"?: number, "color"?: "red"|"yellow"|"green"|"blue"|"white"}],
  "wires": [{"from": "PartId.pin", "to": "PartId.pin"}],
  "drive": [{"pin": "U1.D13", "mode": "high"|"low"|"blink", "period"?: ticks}]
}
Types and their pins:
${Object.entries(PINS).map(([type, pins]) => `${type}: ${pins.join(', ')}`).join('\n')}
"drive" lists what the sketch does to each output pin, and every pin that controls something must appear in it, including motor driver IN and EN pins. Wire electrically real circuits: use a current-limiting resistor with LEDs (220 ohms is typical), drive motors through motor_driver with a battery on VS, and share ground between the board and any battery. Wire exactly what the user asks for, even if it is a mistake: the checks that follow will catch it.`,
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
