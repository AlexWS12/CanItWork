import { describe, expect, it } from 'vitest';
import { buildGuide, guideText, layoutBreadboard, type CircuitSpec } from '../src';

type SpecPart = CircuitSpec['parts'][number];

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

  it('writes the guide as Markdown', () => {
    const text = guideText('AND gate', buildGuide(andGate(DATASHEET)));
    expect(text).toMatch(/^# AND gate\n\n## Parts\n- 1 × /);
    expect(text).toMatch(/\n## Steps\n1\. Lay the breadboard/);
  });
});
