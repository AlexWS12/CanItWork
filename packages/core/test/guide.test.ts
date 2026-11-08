import { describe, expect, it } from 'vitest';
import { DOMAINS, buildGuide, guideText, layoutBreadboard, pinsOf, type CircuitSpec, type Spot } from '../src';

type SpecPart = CircuitSpec['parts'][number];

// Builds the board as the guide says, with strips, rails, jumpers and the source's leads on its rails, then lists every pin pair
// the board shorts that the netlist keeps apart, and every net the board leaves split.
function physicalFaults(spec: CircuitSpec): string[] {
  const layout = layoutBreadboard(spec);
  const unionFind = () => {
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      if (!parent.has(k)) parent.set(k, k);
      while (parent.get(k) !== k) k = parent.get(k)!;
      return k;
    };
    return { find, join: (a: string, b: string) => parent.set(find(a), find(b)) };
  };
  const node = (s: Spot | string) => (typeof s === 'string' ? `pin ${s}` : s.kind === 'strip' ? `strip ${s.col}${s.half}` : `rail ${s.side}${s.rail}`);
  const board = unionFind();
  for (const ends of layout.wireEnds) if (ends) board.join(node(ends[0]), node(ends[1]));
  if (layout.source) {
    const { id, pos, neg } = layout.source;
    for (const side of ['top', 'bottom']) {
      if (layout.railsUsed.has(`${side}+`)) board.join(`pin ${id}.${pos}`, `rail ${side}+`);
      if (layout.railsUsed.has(`${side}-`)) board.join(`pin ${id}.${neg}`, `rail ${side}-`);
    }
  }
  const netlist = unionFind();
  for (const w of spec.wires) netlist.join(w.from, w.to);
  const pins = spec.parts.flatMap((p) => pinsOf(p).map((pin) => `${p.id}.${pin}`));
  const at = (k: string) => board.find(node(layout.spots.get(k) ?? k));
  const faults: string[] = [];
  for (const a of pins)
    for (const b of pins) {
      if (a >= b) continue;
      const wired = netlist.find(a) === netlist.find(b);
      const joined = at(a) === at(b);
      if (joined && !wired) faults.push(`short ${a} ${b}`);
      if (wired && !joined) faults.push(`open ${a} ${b}`);
    }
  return faults;
}

// A 74HC08 listed in datasheet order: pin 1 is A1, pin 7 GND, pin 14 VCC.
const DATASHEET = ['A1', 'B1', 'Y1', 'A2', 'B2', 'Y2', 'GND', 'Y3', 'A3', 'B3', 'Y4', 'A4', 'B4', 'VCC'];

const andGate = (pins: string[]): CircuitSpec => {
  const chip: SpecPart = {
    id: 'U1',
    type: 'custom',
    package: 'dip',
    custom: {
      label: '74HC08 quad AND',
      pins,
      paths: [{ a: 'VCC', b: 'GND', ohms: 5000 }],
      switches: [],
      drivers: [{ pin: 'Y1', high: 'VCC', low: 'GND', when: 'A1 && B1', ref: 'GND', aboveVolts: 2.5, ohms: 50, invert: false }],
      sources: [],
      gpio: [],
      output: false,
      visual: [],
    },
  };
  return {
    layout: 'breadboard',
    parts: [
      { id: 'B1', type: 'battery', volts: 5 },
      chip,
      { id: 'S1', type: 'switch' },
      { id: 'S2', type: 'switch' },
      { id: 'R1', type: 'resistor', ohms: 10000 },
      { id: 'R2', type: 'resistor', ohms: 10000 },
      { id: 'R3', type: 'resistor', ohms: 220 },
      { id: 'D1', type: 'led', color: 'green' },
    ],
    wires: [
      { from: 'B1.pos', to: 'U1.VCC' },
      { from: 'U1.GND', to: 'B1.neg' },
      { from: 'B1.pos', to: 'S1.a' },
      { from: 'S1.b', to: 'U1.A1' },
      { from: 'U1.A1', to: 'R1.a' },
      { from: 'R1.b', to: 'B1.neg' },
      { from: 'B1.pos', to: 'S2.a' },
      { from: 'S2.b', to: 'U1.B1' },
      { from: 'U1.B1', to: 'R2.a' },
      { from: 'R2.b', to: 'B1.neg' },
      { from: 'U1.Y1', to: 'R3.a' },
      { from: 'R3.b', to: 'D1.anode' },
      { from: 'D1.cathode', to: 'B1.neg' },
    ],
    drive: [],
  };
};

describe('build guide', () => {
  it('lists parts and puts a datasheet-order chip with pin 1 bottom left and VCC top left', () => {
    const spec = andGate(DATASHEET);
    const guide = buildGuide(spec);
    expect(guide.bom).toEqual(
      expect.arrayContaining([
        { qty: 1, item: '74HC08 quad AND (DIP-14)' },
        { qty: 2, item: '10 kΩ resistor' },
        { qty: 1, item: 'solderless breadboard' },
      ]),
    );
    const chipStep = guide.steps.find((s) => s.startsWith('Press U1'))!;
    expect(chipStep).toMatch(/pin 1 sits in f\d+/);
    const col = Number(chipStep.match(/pin 1 sits in f(\d+)/)![1]);
    // Pin 14 (VCC) is directly above pin 1, across the channel, as on the real chip.
    expect(chipStep).toContain(`e${col} VCC`);
    expect(chipStep).toContain(`f${col + 6} GND`);
    expect(chipStep).not.toMatch(/check the datasheet/);
  });

  it('names a hole or rail for every lead and one step per drawn jumper', () => {
    const spec = andGate(DATASHEET);
    const guide = buildGuide(spec);
    for (const id of ['S1', 'S2', 'R1', 'R2', 'R3', 'D1']) expect(guide.steps.find((s) => s.startsWith(`Place ${id}`))).toMatch(/in ([a-j]\d+|the (top|bottom) [+−] rail)/);
    const jumpers = layoutBreadboard(spec).wireEnds.filter(Boolean).length;
    expect(guide.steps.filter((s) => s.startsWith('Jumper')).length).toBe(jumpers);
    expect(guide.bom.find((l) => l.item === 'jumper wires')?.qty).toBe(jumpers);
    expect(guide.steps.find((s) => s.includes('anode (long leg)'))).toBeTruthy();
  });

  it('warns when a chip lists only some of its pins, since its holes would not match the real part', () => {
    const guide = buildGuide(andGate(['VCC', 'GND', 'A1', 'B1', 'Y1']));
    expect(guide.bom.some((l) => l.item === '74HC08 quad AND (DIP-8)')).toBe(true);
    expect(guide.steps.find((s) => s.startsWith('Press U1'))).toMatch(/check the datasheet pinout/);
  });

  it('places a 3-lead part when the free strip is boxed in on the right, instead of looping forever', () => {
    const custom = (pins: string[]) => ({ label: 'chip', pins, sources: [] });
    const spec = DOMAINS.electronics.specSchema.parse({
      layout: 'breadboard',
      parts: [
        { id: 'B1', type: 'battery' },
        { id: 'U1', type: 'custom', package: 'dip', custom: custom([...Array(12).keys()].map((i) => `P${i + 1}`).concat(['VCC', 'GND'])) },
        { id: 'U2', type: 'custom', package: 'dip', custom: custom([...Array(6).keys()].map((i) => `P${i + 1}`).concat(['VCC', 'GND'])) },
        { id: 'X0', type: 'nmos' },
        { id: 'X1', type: 'buzzer' },
        { id: 'X2', type: 'ldr' },
        { id: 'X3', type: 'switch' },
        { id: 'X4', type: 'nmos' },
      ],
      wires: [
        ['U1.P2', 'B1.pos'],
        ['X2.a', 'B1.pos'],
        ['U1.P5', 'U2.P6'],
        ['U2.P6', 'U2.GND'],
        ['U1.P10', 'U1.P8'],
        ['U1.P11', 'U1.P3'],
        ['B1.neg', 'U1.P8'],
        ['U2.P4', 'X2.b'],
        ['X4.D', 'U1.GND'],
        ['X3.a', 'X1.pos'],
        ['U2.P2', 'U1.VCC'],
        ['X4.D', 'U2.GND'],
        ['X4.S', 'X0.S'],
        ['U1.P1', 'X2.b'],
        ['U1.P12', 'B1.neg'],
        ['X2.b', 'X0.S'],
      ].map(([from, to]) => ({ from, to })),
    }) as CircuitSpec;
    const layout = layoutBreadboard(spec);
    const cols = ['D', 'G', 'S'].map((pin) => layout.spots.get(`X4.${pin}`)!).map((s) => (s.kind === 'strip' ? s.col : -1));
    expect(cols[1]).toBe(cols[0] + 1);
    expect(cols[2]).toBe(cols[0] + 2);
    expect(physicalFaults(spec)).toEqual([]);
  });

  it('wires every lead of a part beside the board, even one on the power net', () => {
    // A motor beside the board on the + net: its lead must be wired, not swapped for "the rail" and left loose.
    const spec: CircuitSpec = {
      layout: 'breadboard',
      parts: [
        { id: 'B1', type: 'battery', volts: 9 },
        { id: 'BTN1', type: 'button' },
        { id: 'R1', type: 'resistor', ohms: 1000 },
        { id: 'T1', type: 'npn' },
        { id: 'D1', type: 'diode' },
        { id: 'M1', type: 'motor' },
      ],
      wires: [
        { from: 'B1.pos', to: 'BTN1.a' },
        { from: 'BTN1.b', to: 'R1.a' },
        { from: 'R1.b', to: 'T1.B' },
        { from: 'T1.E', to: 'B1.neg' },
        { from: 'B1.pos', to: 'M1.a' },
        { from: 'M1.b', to: 'T1.C' },
        { from: 'M1.b', to: 'D1.anode' },
        { from: 'M1.a', to: 'D1.cathode' },
      ],
      drive: [],
    };
    const steps = buildGuide(spec).steps;
    expect(steps.filter((s) => s.includes('pin a of M1')).length).toBeGreaterThan(0);
    expect(physicalFaults(spec)).toEqual([]);
  });

  it('connects the battery the layout put on the rails, even when an Arduino is listed first', () => {
    const spec: CircuitSpec = {
      layout: 'breadboard',
      parts: [
        { id: 'ARD', type: 'arduino' },
        { id: 'B1', type: 'battery', volts: 12 },
        { id: 'R1', type: 'resistor', ohms: 1000 },
        { id: 'D1', type: 'led' },
        { id: 'R2', type: 'resistor', ohms: 10000 },
      ],
      wires: [
        { from: 'B1.pos', to: 'R1.a' },
        { from: 'R1.b', to: 'D1.anode' },
        { from: 'D1.cathode', to: 'B1.neg' },
        { from: 'ARD.D2', to: 'R2.a' },
        { from: 'R2.b', to: 'ARD.GND' },
        { from: 'ARD.GND', to: 'B1.neg' },
      ],
      drive: [],
    };
    const connects = buildGuide(spec).steps.filter((s) => s.startsWith('Connect') && s.includes('rail'));
    expect(connects.length).toBeGreaterThan(0);
    for (const step of connects) expect(step).toMatch(/^Connect B1 /);
    expect(physicalFaults(spec)).toEqual([]);
  });

  it('wires a custom power module to the rails it feeds', () => {
    const spec = DOMAINS.electronics.specSchema.parse({
      layout: 'breadboard',
      parts: [
        { id: 'REG', type: 'custom', package: 'module', custom: { label: 'buck module', pins: ['IN', 'OUT', 'G'], sources: [{ pos: 'OUT', neg: 'G', volts: 5 }] } },
        { id: 'R1', type: 'resistor', ohms: 330 },
        { id: 'D1', type: 'led' },
      ],
      wires: [
        { from: 'REG.OUT', to: 'R1.a' },
        { from: 'R1.b', to: 'D1.anode' },
        { from: 'D1.cathode', to: 'REG.G' },
      ],
    }) as CircuitSpec;
    expect(buildGuide(spec).steps.some((s) => /^Connect REG .*OUT pin to the .* \+ rail/.test(s) || /^Connect REG .*G pin to the .* − rail/.test(s))).toBe(true);
    expect(physicalFaults(spec)).toEqual([]);
  });

  it('writes the guide as Markdown', () => {
    const text = guideText('AND gate', buildGuide(andGate(DATASHEET)));
    expect(text).toMatch(/^# AND gate\n\n## Parts\n- 1 × /);
    expect(text).toMatch(/\n## Steps\n1\. Lay the breadboard/);
  });
});
