import { z } from 'zod';
import type { Breakable, Evaluation, Incident, Inspection, Metric, Point, Run, TimedEvent } from '../../domain';
import { FORWARD_VOLTS, GPIO, LIMITS, PIN_LIMIT, RAIL_LIMIT, RESISTOR_WATTS, isOutput, pinsOf, type CircuitSpec, type Part } from './parts';

export const CircuitPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_ohms'), part: z.string(), ohms: z.number().positive() }),
  z.object({ op: z.literal('insert_resistor'), wire: z.string(), ohms: z.number().positive() }),
  z.object({ op: z.literal('set_volts'), part: z.string(), volts: z.number().positive().max(48) }),
  z.object({ op: z.literal('replace_part'), part: z.string() }),
  z.object({ op: z.literal('secure_wire'), wire: z.string() }),
  z.object({ op: z.literal('rewire'), wire: z.string(), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('set_drive'), pin: z.string(), mode: z.enum(['high', 'low', 'blink']), period: z.number().int().min(2).max(200).optional() }),
]);
type CircuitPatch = z.infer<typeof CircuitPatchSchema>;

const LEAK = 1e-9;
const BURN_TICKS = 6;
const ACTIVE_WINDOW = 60;
const SERIES_STEP = 5;
const LED_RESISTANCE = 12;
const PIN_RESISTANCE = 25;
const CHANNELS = [
  ['ENA', 'IN1', 'OUT1'],
  ['ENA', 'IN2', 'OUT2'],
  ['ENB', 'IN3', 'OUT3'],
  ['ENB', 'IN4', 'OUT4'],
];

interface Element {
  owner: string;
  a: string;
  b: string;
  g: number;
  e: number;
}

export interface Reading {
  volts: number;
  amps: number;
  load: number;
  burnAt: number;
  rated: string;
}

function nodal(size: number, elements: Array<{ a: number; b: number; g: number; e: number }>): number[] {
  const m = size - 1;
  if (m <= 0) return [0];
  const A = Array.from({ length: m }, () => new Float64Array(m + 1));
  const stamp = (r: number, c: number, value: number) => {
    if (r > 0 && c > 0) A[r - 1][c - 1] += value;
  };
  for (const { a, b, g, e } of elements) {
    if (a === b) continue;
    stamp(a, a, g);
    stamp(b, b, g);
    stamp(a, b, -g);
    stamp(b, a, -g);
    if (a > 0) A[a - 1][m] += g * e;
    if (b > 0) A[b - 1][m] -= g * e;
  }
  for (let i = 0; i < m; i++) A[i][i] += LEAK;
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const head = A[col][col] || 1e-12;
    for (let r = col + 1; r < m; r++) {
      const factor = A[r][col] / head;
      if (factor === 0) continue;
      for (let c = col; c <= m; c++) A[r][c] -= factor * A[col][c];
    }
  }
  const x = new Array<number>(size).fill(0);
  for (let r = m - 1; r >= 0; r--) {
    let sum = A[r][m];
    for (let c = r + 1; c < m; c++) sum -= A[r][c] * x[c + 1];
    x[r + 1] = sum / (A[r][r] || 1e-12);
  }
  return x;
}

export const wireId = (index: number) => `W${index + 1}`;
const wireIndex = (id: string) => Number(id.slice(1)) - 1;
const milli = (amps: number) => `${Math.round(Math.abs(amps) * 1000)} mA`;
const volts = (v: number) => `${(Math.round(v * 100) / 100).toFixed(2)} V`;

export class CircuitRun implements Run {
  readonly log: TimedEvent[] = [];
  readonly spec: CircuitSpec;
  readonly burned = new Set<string>();
  readonly shorted = new Set<string>();
  readonly loose = new Set<number>();
  readonly readings = new Map<string, Reading>();
  wireAmps: number[] = [];
  tick = 0;

  private sag = new Map<string, number>();
  private stress = new Map<string, number>();
  private active = new Map<string, number>();
  private series: Point[] = [];
  private scoreSum = 0;
  private peakAmps = 0;
  private dirty = true;
  private lastLevels = '';

  constructor(spec: CircuitSpec, _seed: number) {
    this.spec = structuredClone(spec);
    for (const part of this.spec.parts) this.active.set(part.id, 0);
  }

  private outputs() {
    return this.spec.parts.filter(isOutput);
  }

  private level(pin: string) {
    const drive = this.spec.drive.find((d) => d.pin === pin);
    if (!drive) return null;
    if (drive.mode !== 'blink') return drive.mode === 'high';
    const half = Math.max(1, Math.floor((drive.period ?? 20) / 2));
    return Math.floor(this.tick / half) % 2 === 0;
  }

  pinHigh(pin: string) {
    return this.level(pin) === true;
  }

  private elements(on: Set<string>, logic: Map<string, boolean>, wired: Set<string>) {
    const out: Element[] = [];
    const add = (owner: string, a: string, b: string, ohms: number, e = 0) => out.push({ owner, a, b, g: 1 / ohms, e });
    for (const part of this.spec.parts) {
      const pin = (name: string) => `${part.id}.${name}`;
      if (this.burned.has(part.id)) continue;
      if (this.shorted.has(part.id)) {
        const pins = pinsOf(part);
        if (pins.length > 1) add(part.id, pin(pins[0]), pin(pins[1]), 0.05);
        continue;
      }
      switch (part.type) {
        case 'arduino':
          if (!this.burned.has(pin('5V'))) add(pin('5V'), pin('5V'), pin('GND'), 0.2, 5);
          if (!this.burned.has(pin('3V3'))) add(pin('3V3'), pin('3V3'), pin('GND'), 2, 3.3);
          if (wired.has(pin('VIN'))) add(part.id, pin('VIN'), pin('GND'), 180);
          for (const name of GPIO) {
            const level = this.level(pin(name));
            if (level === null || this.burned.has(pin(name))) continue;
            add(pin(name), pin(name), pin('GND'), PIN_RESISTANCE, level ? 5 : 0);
          }
          break;
        case 'battery':
          add(part.id, pin('pos'), pin('neg'), 0.5, this.sag.get(part.id) ?? part.volts ?? 9);
          break;
        case 'resistor':
          add(part.id, pin('a'), pin('b'), part.ohms ?? 1000);
          break;
        case 'led':
          if (on.has(part.id)) add(part.id, pin('anode'), pin('cathode'), LED_RESISTANCE, FORWARD_VOLTS[part.color ?? 'red']);
          break;
        case 'button':
          add(part.id, pin('a'), pin('b'), 0.05);
          break;
        case 'motor':
          add(part.id, pin('a'), pin('b'), 6);
          break;
        case 'buzzer':
          add(part.id, pin('pos'), pin('neg'), 170);
          break;
        case 'ultrasonic':
          add(part.id, pin('VCC'), pin('GND'), 333);
          break;
        case 'custom': {
          const custom = part.custom;
          if (!custom) break;
          for (const path of custom.paths) add(part.id, pin(path.a), pin(path.b), path.ohms);
          custom.switches.forEach((sw, i) => {
            if (logic.get(pin(`switch${i}`))) add(part.id, pin(sw.a), pin(sw.b), sw.ohms);
          });
          custom.drivers.forEach((driver, i) => {
            const high = Boolean(logic.get(pin(`driver${i}`))) !== driver.invert;
            if (high) add(part.id, pin(driver.high), pin(driver.pin), driver.ohms);
            else add(part.id, pin(driver.pin), pin(driver.low), driver.ohms);
          });
          for (const source of custom.sources) add(part.id, pin(source.pos), pin(source.neg), source.ohms, source.volts);
          const reference = custom.sources[0]?.neg ?? custom.supply?.neg;
          if (!reference) break;
          for (const name of custom.gpio) {
            const level = this.level(pin(name));
            if (level === null || this.burned.has(pin(name))) continue;
            add(pin(name), pin(name), pin(reference), PIN_RESISTANCE, level ? (custom.gpioVolts ?? 3.3) : 0);
          }
          break;
        }
        case 'motor_driver':
          if (wired.has(pin('VCC'))) add(part.id, pin('VCC'), pin('GND'), 140);
          if (!logic.get(pin('POWER'))) break;
          for (const [enable, input, output] of CHANNELS) {
            const enabled = !wired.has(pin(enable)) || logic.get(pin(enable));
            if (!enabled) continue;
            if (logic.get(pin(input))) add(part.id, pin('VS'), pin(output), 1.5);
            else add(part.id, pin(output), pin('GND'), 1.5);
          }
          break;
      }
    }
    return out;
  }

  private solve() {
    const parent = new Map<string, string>();
    const find = (key: string): string => {
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root)!;
      parent.set(key, root);
      return root;
    };
    for (const part of this.spec.parts) for (const name of pinsOf(part)) parent.set(`${part.id}.${name}`, `${part.id}.${name}`);
    const wired = new Set<string>();
    this.spec.wires.forEach((wire, i) => {
      if (this.loose.has(i) || !parent.has(wire.from) || !parent.has(wire.to)) return;
      wired.add(wire.from);
      wired.add(wire.to);
      parent.set(find(wire.from), find(wire.to));
    });

    const ground = this.spec.parts.find((p) => p.type === 'arduino' || p.type === 'battery' || p.custom?.sources.length);
    const groundPin = ground?.type === 'arduino' ? 'GND' : ground?.type === 'battery' ? 'neg' : ground?.custom?.sources[0].neg;
    const groundKey = ground ? `${ground.id}.${groundPin}` : '';
    const ids = new Map<string, number>();
    if (groundKey) ids.set(find(groundKey), 0);
    for (const key of parent.keys()) {
      const root = find(key);
      if (!ids.has(root)) ids.set(root, ids.size);
    }
    const node = (key: string) => ids.get(find(key)) ?? 0;

    const on = new Set<string>();
    const logic = new Map<string, boolean>();
    let v: number[] = [];
    let elements: Element[] = [];
    for (let iteration = 0; iteration < 14; iteration++) {
      elements = this.elements(on, logic, wired);
      v = nodal(ids.size, elements.map((el) => ({ a: node(el.a), b: node(el.b), g: el.g, e: el.e })));
      const at = (key: string) => v[node(key)] ?? 0;
      let changed = false;
      for (const part of this.spec.parts) {
        if (part.type === 'led') {
          const threshold = FORWARD_VOLTS[part.color ?? 'red'];
          const drop = at(`${part.id}.anode`) - at(`${part.id}.cathode`);
          const conducting = on.has(part.id) ? drop > threshold * 0.98 : drop > threshold;
          if (conducting !== on.has(part.id)) {
            changed = true;
            if (conducting) on.add(part.id);
            else on.delete(part.id);
          }
        }
        const updateControl = (key: string, control: { when: string; ref: string; aboveVolts: number }) => {
          const active = at(`${part.id}.${control.when}`) - at(`${part.id}.${control.ref}`) >= control.aboveVolts;
          if ((logic.get(key) ?? false) !== active) changed = true;
          logic.set(key, active);
        };
        part.custom?.switches.forEach((sw, i) => updateControl(`${part.id}.switch${i}`, sw));
        part.custom?.drivers.forEach((driver, i) => updateControl(`${part.id}.driver${i}`, driver));
        if (part.type === 'motor_driver') {
          const pin = (name: string) => `${part.id}.${name}`;
          const reference = at(pin('GND'));
          const update = (key: string, value: boolean) => {
            if ((logic.get(key) ?? false) !== value) changed = true;
            logic.set(key, value);
          };
          const powered = wired.has(pin('VCC')) ? at(pin('VCC')) - reference > 4 : at(pin('VS')) - reference >= 7;
          update(pin('POWER'), powered);
          for (const name of ['ENA', 'ENB', 'IN1', 'IN2', 'IN3', 'IN4']) update(pin(name), at(pin(name)) - reference > 2.5);
        }
      }
      if (!changed) break;
    }

    this.readings.clear();
    const pinAmps = new Map<string, number>();
    const totals = new Map<string, { amps: number; volts: number }>();
    for (const el of elements) {
      const drop = (v[node(el.a)] ?? 0) - (v[node(el.b)] ?? 0);
      const amps = el.g * (drop - el.e);
      pinAmps.set(el.a, (pinAmps.get(el.a) ?? 0) + amps);
      pinAmps.set(el.b, (pinAmps.get(el.b) ?? 0) - amps);
      const entry = totals.get(el.owner) ?? { amps: 0, volts: 0 };
      if (Math.abs(amps) > entry.amps) totals.set(el.owner, { amps: Math.abs(amps), volts: Math.abs(drop) });
    }
    for (const [owner, { amps, volts: drop }] of totals) this.readings.set(owner, this.rate(owner, amps, drop));
    for (const part of this.spec.parts) {
      const supply = part.custom?.supply;
      if (!supply || this.burned.has(part.id)) continue;
      const across = (v[node(`${part.id}.${supply.pos}`)] ?? 0) - (v[node(`${part.id}.${supply.neg}`)] ?? 0);
      const reading = this.readings.get(part.id) ?? this.rate(part.id, 0, 0);
      const overVolts = across / supply.maxVolts;
      this.readings.set(part.id, { ...reading, volts: across, load: Math.max(reading.load, overVolts), burnAt: Math.min(reading.burnAt, 1.5) });
    }
    this.wireAmps = this.spec.wires.map((wire, i) => {
      if (this.loose.has(i)) return 0;
      const from = pinAmps.get(wire.from) ?? 0;
      const to = pinAmps.get(wire.to) ?? 0;
      return Math.abs(from) >= Math.abs(to) ? from : -to;
    });
  }

  private rate(owner: string, amps: number, drop: number): Reading {
    const part = this.spec.parts.find((p) => p.id === owner);
    if (!part) {
      const limit = owner.endsWith('.5V') || owner.endsWith('.3V3') ? RAIL_LIMIT : PIN_LIMIT;
      return { volts: drop, amps, load: amps / limit.rated, burnAt: limit.burn / limit.rated, rated: milli(limit.rated) };
    }
    if (part.type === 'resistor') {
      const watts = amps * amps * (part.ohms ?? 1000);
      return { volts: drop, amps, load: watts / RESISTOR_WATTS.rated, burnAt: RESISTOR_WATTS.burn / RESISTOR_WATTS.rated, rated: '0.25 W' };
    }
    if (part.custom?.maxAmps) {
      const rated = part.custom.maxAmps;
      return { volts: drop, amps, load: amps / rated, burnAt: 2, rated: milli(rated) };
    }
    const limit = LIMITS[part.type];
    if (!limit) return { volts: drop, amps, load: 0, burnAt: Infinity, rated: 'n/a' };
    return { volts: drop, amps, load: amps / limit.rated, burnAt: limit.burn / limit.rated, rated: milli(limit.rated) };
  }

  private isActive(part: Part) {
    const reading = this.readings.get(part.id);
    if (!reading) return false;
    switch (part.type) {
      case 'led':
        return reading.amps > 0.002;
      case 'buzzer':
        return reading.amps > 0.005;
      case 'motor':
        return reading.volts >= 1.5;
      case 'ultrasonic':
        return reading.volts >= 4.5 && reading.volts <= 5.5;
      case 'custom': {
        const supply = part.custom?.supply;
        return supply ? reading.volts >= supply.minVolts && reading.volts <= supply.maxVolts : reading.amps > 0.001;
      }
      default:
        return false;
    }
  }

  isHealthy(part: Part) {
    if (this.burned.has(part.id) || this.shorted.has(part.id)) return false;
    if ((this.readings.get(part.id)?.load ?? 0) > 1) return false;
    return this.tick - (this.active.get(part.id) ?? 0) <= ACTIVE_WINDOW;
  }

  isRunning(part: Part) {
    return !this.burned.has(part.id) && this.isActive(part);
  }

  step() {
    const levels = this.spec.drive.map((d) => this.level(d.pin)).join();
    if (levels !== this.lastLevels) {
      this.lastLevels = levels;
      this.dirty = true;
    }
    if (this.dirty) {
      this.solve();
      this.dirty = false;
    }
    for (const [key, reading] of this.readings) {
      this.peakAmps = Math.max(this.peakAmps, reading.amps);
      const over = reading.load >= reading.burnAt;
      const count = over ? (this.stress.get(key) ?? 0) + 1 : 0;
      this.stress.set(key, count);
      if (count >= BURN_TICKS) {
        this.burned.add(key);
        this.dirty = true;
      }
    }
    for (const part of this.spec.parts) if (this.isActive(part)) this.active.set(part.id, this.tick);
    this.tick++;
    const value = this.percentOk();
    this.scoreSum += value;
    if (this.tick % SERIES_STEP === 0) this.series.push({ t: this.tick, value });
  }

  private percentOk() {
    const outputs = this.outputs();
    if (!outputs.length) {
      const parts = this.spec.parts.length;
      return ((parts - this.spec.parts.filter((p) => this.burned.has(p.id)).length) / parts) * 100;
    }
    return (outputs.filter((p) => this.isHealthy(p)).length / outputs.length) * 100;
  }

  inject(incident: Incident) {
    const target = incident.target ?? '';
    this.log.push({ at: this.tick, incident });
    switch (incident.type) {
      case 'burn_part':
        this.burned.add(target);
        break;
      case 'short_part':
        this.shorted.add(target);
        break;
      case 'loose_wire':
        this.loose.add(wireIndex(target));
        break;
      case 'low_supply':
        this.sag.set(target, incident.value ?? 3);
        break;
      case 'repair':
        this.burned.delete(target);
        this.shorted.delete(target);
        this.sag.delete(target);
        this.stress.delete(target);
        if (target.startsWith('W')) this.loose.delete(wireIndex(target));
        this.active.set(target, this.tick);
        break;
    }
    this.dirty = true;
  }

  apply(patches: unknown[]) {
    this.log.push({ at: this.tick, patches });
    for (const patch of patches as CircuitPatch[]) this.applyPatch(patch);
    this.dirty = true;
  }

  private applyPatch(patch: CircuitPatch) {
    switch (patch.op) {
      case 'set_ohms': {
        const part = this.spec.parts.find((p) => p.id === patch.part);
        if (part) part.ohms = patch.ohms;
        break;
      }
      case 'set_volts': {
        const part = this.spec.parts.find((p) => p.id === patch.part);
        if (part) part.volts = patch.volts;
        this.sag.delete(patch.part);
        break;
      }
      case 'replace_part':
        this.burned.delete(patch.part);
        this.shorted.delete(patch.part);
        for (const key of [...this.burned]) if (key.startsWith(`${patch.part}.`)) this.burned.delete(key);
        this.stress.clear();
        this.active.set(patch.part, this.tick);
        break;
      case 'secure_wire':
        this.loose.delete(wireIndex(patch.wire));
        break;
      case 'rewire': {
        const wire = this.spec.wires[wireIndex(patch.wire)];
        if (wire) {
          wire.from = patch.from;
          wire.to = patch.to;
        }
        break;
      }
      case 'insert_resistor': {
        const wire = this.spec.wires[wireIndex(patch.wire)];
        if (!wire) break;
        const id = `R${this.spec.parts.length + 1}x`;
        this.spec.parts.push({ id, type: 'resistor', ohms: patch.ohms });
        const end = wire.to;
        wire.to = `${id}.a`;
        this.spec.wires.push({ from: `${id}.b`, to: end });
        break;
      }
      case 'set_drive': {
        const drive = this.spec.drive.find((d) => d.pin === patch.pin);
        if (drive) {
          drive.mode = patch.mode;
          drive.period = patch.period;
        } else {
          this.spec.drive.push({ pin: patch.pin, mode: patch.mode, period: patch.period });
        }
        break;
      }
    }
  }

  private worstLoad() {
    let worst = 0;
    for (const reading of this.readings.values()) if (reading.load > worst) worst = reading.load;
    return Math.round(worst * 100);
  }

  evaluation(): Evaluation {
    return {
      score: this.tick ? Math.round((this.scoreSum / this.tick) * 10) / 10 : 0,
      scoreLabel: '% of outputs working',
      metrics: [
        { label: 'peak current', value: milli(this.peakAmps) },
        { label: 'parts burned', value: this.burned.size },
        { label: 'worst load', value: `${this.worstLoad()}%` },
      ],
      series: this.series,
    };
  }

  telemetry(): Metric[] {
    const outputs = this.outputs();
    const healthy = outputs.filter((p) => this.isHealthy(p)).length;
    const worst = this.worstLoad();
    let supply = 0;
    for (const [key, reading] of this.readings) if (key.endsWith('.5V') || key.endsWith('.3V3') || this.spec.parts.find((p) => p.id === key)?.type === 'battery') supply += reading.amps;
    return [
      { label: 'outputs working', value: `${healthy}/${outputs.length}`, tone: healthy < outputs.length ? 'danger' : undefined },
      { label: 'supply current', value: milli(supply) },
      { label: 'worst part load', value: `${worst}%`, tone: worst > 100 ? 'danger' : worst > 80 ? 'warn' : undefined },
      { label: 'parts burned', value: this.burned.size, tone: this.burned.size ? 'danger' : undefined },
    ];
  }

  breakables(): Breakable[] {
    const out: Breakable[] = [];
    const output = this.outputs().find((p) => !this.burned.has(p.id));
    if (output) out.push({ label: `Burn ${output.custom?.label ?? output.id}`, incident: { type: 'burn_part', target: output.id }, keywords: [output.id.toLowerCase(), output.type, (output.custom?.label ?? '').toLowerCase(), 'burn', 'fail'].filter(Boolean) });
    const resistor = this.spec.parts.find((p) => p.type === 'resistor' && !this.shorted.has(p.id));
    if (resistor) out.push({ label: `Short ${resistor.id}`, incident: { type: 'short_part', target: resistor.id }, keywords: [resistor.id.toLowerCase(), 'resistor', 'short'] });
    const wire = this.spec.wires.findIndex((_, i) => !this.loose.has(i));
    if (wire >= 0) out.push({ label: `Loose ${wireId(wire)}`, incident: { type: 'loose_wire', target: wireId(wire) }, keywords: ['wire', 'loose', 'disconnect'] });
    const battery = this.spec.parts.find((p) => p.type === 'battery');
    if (battery) out.push({ label: 'Low battery', incident: { type: 'low_supply', target: battery.id, value: (battery.volts ?? 9) / 2 }, keywords: ['battery', 'supply', 'power'] });
    return out;
  }

  inspect(target: string): Inspection | null {
    if (/^W\d+$/.test(target)) {
      const index = wireIndex(target);
      const wire = this.spec.wires[index];
      if (!wire) return null;
      const loose = this.loose.has(index);
      return {
        title: `Wire ${target}`,
        rows: [
          ['From', wire.from],
          ['To', wire.to],
          ['Current', loose ? 'Disconnected' : milli(this.wireAmps[index] ?? 0)],
        ],
        actions: [
          loose
            ? { label: 'Reconnect wire', incident: { type: 'repair', target }, destructive: false }
            : { label: 'Pull this wire loose', incident: { type: 'loose_wire', target }, destructive: true },
        ],
      };
    }
    const part = this.spec.parts.find((p) => p.id === target);
    if (!part) return null;
    const reading = this.readings.get(target);
    const broken = this.burned.has(target) || this.shorted.has(target);
    const status = this.burned.has(target) ? 'Burned out' : this.shorted.has(target) ? 'Shorted' : (reading?.load ?? 0) > 1 ? 'Over its rating' : 'OK';
    const rows: Array<[string, string | number]> = [
      ['Type', part.custom?.label ?? part.type.replace('_', ' ')],
      ['Status', status],
    ];
    if (part.ohms) rows.push(['Value', `${part.ohms} Ω`]);
    if (reading) rows.push(['Voltage', volts(reading.volts)], ['Current', milli(reading.amps)], ['Rated', reading.rated], ['Load', `${Math.round(reading.load * 100)}%`]);
    if (part.type === 'arduino') {
      const pins = this.spec.drive.filter((d) => d.pin.startsWith(`${target}.`)).length;
      rows.push(['Driven pins', pins]);
      return { title: target, rows, actions: [] };
    }
    return {
      title: target,
      rows,
      actions: broken
        ? [{ label: 'Replace part', incident: { type: 'repair', target }, destructive: false }]
        : [
            { label: 'Burn this part', incident: { type: 'burn_part', target }, destructive: true },
            { label: 'Short this part', incident: { type: 'short_part', target }, destructive: true },
          ],
    };
  }
}
