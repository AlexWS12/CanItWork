import { dipRows, layoutBreadboard, STRADDLES, type Spot } from './breadboard';
import { pinsOf, type CircuitSpec, type Part } from './parts';

// Turns a verified design into what a person needs to build it: a bill of materials and numbered steps.
// On a breadboard the steps name real holes (columns 1-N, rows a-e above the channel and f-j below), taken from the same layout the 3D view draws.

export interface BomLine {
  qty: number;
  item: string;
}

export interface BuildGuide {
  bom: BomLine[];
  steps: string[];
}

const si = (value: number, unit: string) => {
  const steps: Array<[number, string]> = [
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
    [1e-9, 'n'],
    [1e-12, 'p'],
  ];
  const [scale, prefix] = steps.find(([s]) => Math.abs(value) >= s) ?? steps[steps.length - 1];
  const n = Math.round((value / scale) * 100) / 100;
  return `${n} ${prefix}${unit}`;
};

export function describeForBom(part: Part): string {
  switch (part.type) {
    case 'resistor':
      return `${si(part.ohms ?? 1000, 'Ω')} resistor`;
    case 'capacitor':
      return `${si(part.farads ?? 1e-4, 'F')} capacitor${(part.farads ?? 1e-4) >= 1e-6 ? ' (electrolytic)' : ''}`;
    case 'led':
      return `${part.color ?? 'red'} LED (5 mm)`;
    case 'battery':
      return `${part.volts ?? 9} V battery with clip leads`;
    case 'switch':
      return 'slide switch';
    case 'button':
      return 'push button';
    case 'diode':
      return (part.volts ?? 0.7) < 0.5 ? 'Schottky diode (1N5819)' : 'diode (1N4001)';
    case 'pot':
      return `${si(part.ohms ?? 10000, 'Ω')} potentiometer`;
    case 'ldr':
      return 'light-dependent resistor (photoresistor)';
    case 'thermistor':
      return `${si(part.ohms ?? 10000, 'Ω')} NTC thermistor`;
    case 'seven_segment':
      return `common-${part.common ?? 'cathode'} 7-segment display`;
    case 'arduino':
      return 'Arduino Uno';
    case 'motor':
      return `${part.volts ?? 6} V DC motor`;
    case 'motor_driver':
      return 'L298N motor driver module';
    case 'ultrasonic':
      return 'HC-SR04 ultrasonic sensor';
    case 'buzzer':
      return 'piezo buzzer';
    case 'custom': {
      const label = part.custom?.label ?? part.id;
      return part.package === 'dip' ? `${label} (DIP-${dipSize(part)})` : label;
    }
  }
}

const DIP_SIZES = [8, 14, 16, 18, 20, 24, 28, 40];
const dipSize = (part: Part) => DIP_SIZES.find((n) => n >= pinsOf(part).length) ?? pinsOf(part).length;
// A pin list that isn't a whole real package wasn't written in datasheet order, so its holes can't be trusted against the real chip.
const realPinout = (part: Part) => part.type !== 'custom' || part.package !== 'dip' || DIP_SIZES.includes(pinsOf(part).length);

const ROWS_A = 'abcde';
const ROWS_B = 'fghij';

function hole(spot: Spot) {
  if (spot.kind === 'rail') return `the ${spot.side} ${spot.rail === '+' ? '+' : '−'} rail`;
  return `${spot.half === 'A' ? ROWS_A[spot.row] : ROWS_B[spot.row]}${spot.col}`;
}

const LEG_NAMES: Partial<Record<Part['type'], Record<string, string>>> = {
  led: { anode: 'anode (long leg)', cathode: 'cathode (short leg)' },
  diode: { anode: 'anode', cathode: 'cathode (banded end)' },
  capacitor: { a: '+ leg', b: '− leg' },
  pot: { a: 'one end', wiper: 'wiper (middle)', b: 'other end' },
};

function bomOf(spec: CircuitSpec, jumpers: number): BomLine[] {
  const counts = new Map<string, number>();
  for (const part of spec.parts) counts.set(describeForBom(part), (counts.get(describeForBom(part)) ?? 0) + 1);
  const lines = [...counts].map(([item, qty]) => ({ qty, item })).sort((a, b) => a.item.localeCompare(b.item));
  if (spec.layout === 'breadboard') lines.unshift({ qty: 1, item: 'solderless breadboard' });
  if (jumpers) lines.push({ qty: jumpers, item: 'jumper wires' });
  return lines;
}

function breadboardSteps(spec: CircuitSpec) {
  const layout = layoutBreadboard(spec);
  const steps: string[] = [];
  const label = (id: string) => {
    const part = spec.parts.find((p) => p.id === id);
    return part ? `${id} (${describeForBom(part)})` : id;
  };
  steps.push(`Lay the breadboard with columns numbered 1 to ${layout.columns} left to right, rows a-e above the centre channel and f-j below it.`);

  for (const part of spec.parts.filter(STRADDLES)) {
    const chip = layout.chips.get(part.id);
    if (!chip) continue;
    const { near, far } = dipRows(part);
    const pinMap = [...near.map((pin) => `${hole(layout.spots.get(`${part.id}.${pin}`)!)} ${pin}`), ...far.map((pin) => `${hole(layout.spots.get(`${part.id}.${pin}`)!)} ${pin}`)];
    steps.push(
      `Press ${label(part.id)} across the centre channel, notch to the left, so pin 1 sits in f${chip.col} and it spans columns ${chip.col}-${chip.col + chip.half - 1}. Pins: ${pinMap.join(', ')}.${
        realPinout(part) ? '' : ` This design lists only ${pinsOf(part).length} of its pins, so check the datasheet pinout and move each wire to the real pin before powering it.`
      }`,
    );
  }

  for (const part of spec.parts) {
    if (STRADDLES(part) || layout.offBoard.includes(part.id)) continue;
    const legs = pinsOf(part).map((pin) => {
      const spot = layout.spots.get(`${part.id}.${pin}`);
      const name = LEG_NAMES[part.type]?.[pin] ?? pin;
      return spot ? `${name} in ${hole(spot)}` : `${name} unplaced`;
    });
    steps.push(`Place ${label(part.id)}: ${legs.join(', ')}.`);
  }

  spec.wires.forEach((wire, i) => {
    const ends = layout.wireEnds[i];
    if (!ends) return;
    const where = (end: Spot | string) => (typeof end === 'string' ? `${end} on ${label(end.split('.')[0])}` : hole(end));
    steps.push(`Jumper W${i + 1}: ${where(ends[0])} to ${where(ends[1])} (${wire.from} to ${wire.to}).`);
  });

  // The supply's own leads go to the rails it feeds.
  const supplyPart = spec.parts.find((p) => layout.offBoard.includes(p.id) && (p.type === 'battery' || p.type === 'arduino'));
  if (supplyPart) {
    const [pos, neg] = supplyPart.type === 'battery' ? ['+ lead', '− lead'] : ['5V pin', 'GND pin'];
    for (const side of ['top', 'bottom'] as const) {
      const sides = [layout.railsUsed.has(`${side}+`) && `${pos} to the ${side} + rail`, layout.railsUsed.has(`${side}-`) && `${neg} to the ${side} − rail`].filter(Boolean);
      if (sides.length) steps.push(`Connect ${label(supplyPart.id)}: ${sides.join(', ')}.`);
    }
  }
  if (supplyPart?.type === 'battery') steps.push(`Connect ${label(supplyPart.id)} last, once everything else is in place.`);
  return { steps, jumpers: layout.wireEnds.filter(Boolean).length };
}

function benchSteps(spec: CircuitSpec) {
  const steps: string[] = [];
  const byPart = new Map<string, string[]>();
  for (const wire of spec.wires) {
    const id = wire.from.split('.')[0];
    byPart.set(id, [...(byPart.get(id) ?? []), `${wire.from} to ${wire.to}`]);
  }
  for (const [id, list] of byPart) {
    const part = spec.parts.find((p) => p.id === id);
    steps.push(`From ${id}${part ? ` (${describeForBom(part)})` : ''}: connect ${list.join('; ')}.`);
  }
  if (spec.program?.length) steps.push('Upload the sketch, then power the board.');
  return { steps, jumpers: spec.wires.length };
}

export function buildGuide(spec: CircuitSpec): BuildGuide {
  const { steps, jumpers } = spec.layout === 'breadboard' ? breadboardSteps(spec) : benchSteps(spec);
  return { bom: bomOf(spec, jumpers), steps };
}

export function guideText(name: string, guide: BuildGuide) {
  return [`# ${name}`, '', '## Parts', ...guide.bom.map((l) => `- ${l.qty} × ${l.item}`), '', '## Steps', ...guide.steps.map((s, i) => `${i + 1}. ${s}`), ''].join('\n');
}
