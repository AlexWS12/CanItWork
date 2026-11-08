import { z } from 'zod';
import { checkPatches, type Breakable, type Evaluation, type Incident, type Inspection, type Metric, type Point, type Run, type Setting, type TimedEvent } from '../../domain';
import {
  FORWARD_VOLTS,
  SEGMENTS,
  glyphOf,
  GPIO,
  LIMITS,
  PIN_LIMIT,
  RAIL_LIMIT,
  RESISTOR_WATTS,
  RuleSchema,
  isOutput,
  pinsOf,
  sensorOf,
  withUnit,
  type Action,
  type CircuitSpec,
  type CustomPart,
  type Part,
} from './parts';
import { netsOf } from './nets';
import { aliasPins, compile, evaluate, type Expr, type Node } from './sketch';

const MODES = z.enum(['high', 'low', 'blink', 'pwm', 'angle']);

export const CircuitPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_ohms'), part: z.string(), ohms: z.number().positive() }),
  z.object({ op: z.literal('insert_resistor'), wire: z.string(), ohms: z.number().positive() }),
  z.object({ op: z.literal('set_volts'), part: z.string(), volts: z.number().positive().max(48) }),
  z.object({ op: z.literal('set_farads'), part: z.string(), farads: z.number().positive().max(10) }),
  z.object({ op: z.literal('set_usb'), part: z.string(), usb: z.boolean() }),
  z.object({ op: z.literal('replace_part'), part: z.string() }),
  z.object({ op: z.literal('secure_wire'), wire: z.string() }),
  z.object({ op: z.literal('rewire'), wire: z.string(), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('set_drive'), pin: z.string(), mode: MODES, value: z.number().optional(), period: z.number().int().min(2).max(200).optional() }),
  z.object({ op: z.literal('set_program'), program: z.array(RuleSchema).max(20), vars: z.record(z.number()).optional() }),
]);
type CircuitPatch = z.infer<typeof CircuitPatchSchema>;

const RESISTOR_VALUES = [100, 220, 330, 470, 1000, 2200, 4700, 10000, 47000, 100000];
const BATTERY_VOLTS = [3, 3.7, 5, 9, 12];
const ohmsLabel = (ohms: number) => (ohms >= 1e6 ? `${ohms / 1e6} MΩ` : ohms >= 1000 ? `${ohms / 1000} kΩ` : `${ohms} Ω`);

export const DT = 1 / 12;
const SUBSTEPS = 4;
const BOOT_TICKS = 2;
const LEAK = 1e-9;
const BURN_TICKS = 6;
const SERIES_STEP = 5;
const LED_RESISTANCE = 12;
const SEGMENT_VOLTS = 2;
const USB_VOLTS = 5;
const DIODE_RESISTANCE = 0.3;
const BE_VOLTS = 0.65;
const BE_RESISTANCE = 50;
const CE_SATURATED = 0.2;
const MOS_ON = 0.05;
const PIN_RESISTANCE = 25;
const BROWNOUT_VOLTS = 4.3;
const REGULATOR_DROP = 1.2;
const MOTOR_TAU = 0.25;
const MOTOR_LOADED = 0.35;
const PULSED = new Set(['pwm']);
const CHANNELS = [
  ['ENA', 'IN1', 'OUT1'],
  ['ENA', 'IN2', 'OUT2'],
  ['ENB', 'IN3', 'OUT3'],
  ['ENB', 'IN4', 'OUT4'],
];

type PinState = { mode: z.infer<typeof MODES>; value?: number; period?: number };
type Source = CustomPart['sources'][number];

interface Element {
  owner: string;
  a: string;
  b: string;
  g: number;
  e: number;
  ctrl?: { p: string; n: string; gain: number };
}

export interface Reading {
  volts: number;
  amps: number;
  load: number;
  burnAt: number;
  rated: string;
}

// Elements are conductances with a series EMF; one with p, n and gain is a voltage-controlled source: its EMF is gain x (V(p) - V(n)).
function nodal(size: number, elements: Array<{ a: number; b: number; g: number; e: number; p?: number; n?: number; gain?: number }>): number[] {
  const m = size - 1;
  if (m <= 0) return [0];
  const A = Array.from({ length: m }, () => new Float64Array(m + 1));
  const stamp = (r: number, c: number, value: number) => {
    if (r > 0 && c > 0) A[r - 1][c - 1] += value;
  };
  for (const { a, b, g, e, p, n, gain } of elements) {
    if (a === b) continue;
    stamp(a, a, g);
    stamp(b, b, g);
    stamp(a, b, -g);
    stamp(b, a, -g);
    if (gain && p !== undefined && n !== undefined) {
      stamp(a, p, -g * gain);
      stamp(a, n, g * gain);
      stamp(b, p, g * gain);
      stamp(b, n, -g * gain);
    }
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
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const shape = (text: string | undefined) => (text ?? '').replace(/-?\d+(\.\d+)?/g, '#');

function compare(left: number, op: string, right: number) {
  switch (op) {
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    case '==':
      return left === right;
    default:
      return left !== right;
  }
}

function motorModel(part: Part) {
  const ohms = part.ohms ?? 6;
  const rated = part.volts ?? 6;
  const k = rated * (1 - MOTOR_LOADED);
  const friction = (k * MOTOR_LOADED * rated) / ohms;
  const inertia = MOTOR_TAU * ((k * k) / ohms + friction);
  return { ohms, rated, k, friction, inertia };
}

export class CircuitRun implements Run {
  readonly log: TimedEvent[] = [];
  readonly spec: CircuitSpec;
  readonly burned = new Set<string>();
  readonly shorted = new Set<string>();
  readonly loose = new Set<number>();
  readonly readings = new Map<string, Reading>();
  readonly burnCauses = new Map<string, string>();
  readonly values = new Map<string, number>();
  readonly outputs = new Map<string, number>();
  readonly texts = new Map<string, string>();
  readonly speeds = new Map<string, number>();
  readonly capVolts = new Map<string, number>();
  readonly boardOn = new Map<string, boolean>();
  readonly railVolts = new Map<string, number>();
  wireAmps: number[] = [];
  tick = 0;

  private twin: CircuitRun | null;
  private pinStates = new Map<string, PinState>();
  private faults = new Map<string, number>();
  private sag = new Map<string, number>();
  private stress = new Map<string, number>();
  private lastOn = new Map<string, number>();
  private lastVolts = new Map<string, number>();
  private nodeOf = new Map<string, number>();
  private wired = new Set<string>();
  private railAmps = new Map<string, number>();
  private onSince = new Map<string, number>();
  readonly vars = new Map<string, number>();
  readonly world = new Map<string, number>();
  private onTarget = new Map<string, number>();
  private slots = new Map<number, number>();
  private startTick: number | null = null;
  private topology: { version: number; size: number; node: Map<string, number>; wired: Set<string> } | null = null;
  private version = 0;
  private series: Point[] = [];
  private scoreSum = 0;
  private peakAmps = 0;
  private dirty = true;
  private signature = '';
  private segmentsOn = new Set<string>();
  private closedSwitches = new Set<string>();
  private ampState = new Map<string, 'linear' | 'high' | 'low'>();
  private chipVars = new Map<string, Map<string, number>>();
  private chipPrev = new Map<string, number>();

  constructor(spec: CircuitSpec, seed: number, reference = false) {
    this.spec = structuredClone(spec);
    this.resetPins();
    this.resetSketch();
    for (const q of this.spec.world ?? []) this.world.set(q.id, clamp(q.start, q.min, q.max));
    for (const part of this.spec.parts) {
      const sensor = sensorOf(part);
      if (sensor) this.values.set(part.id, sensor.value ?? (sensor.min + sensor.max) / 2);
      if (part.type === 'capacitor') this.capVolts.set(part.id, 0);
      if (part.type === 'motor') this.speeds.set(part.id, 0);
    }
    for (const wire of this.spec.wires) this.wired.add(wire.from).add(wire.to);
    this.resetChips();
    this.twin = reference ? null : new CircuitRun(spec, seed, true);
  }

  private resetPins(board?: string) {
    for (const key of [...this.pinStates.keys()]) if (!board || key.startsWith(`${board}.`)) this.pinStates.delete(key);
    for (const d of this.spec.drive) if (!board || d.pin.startsWith(`${board}.`)) this.pinStates.set(d.pin, { mode: d.mode, value: d.value, period: d.period });
  }

  private resetChips() {
    for (const part of this.spec.parts) if (part.custom?.state) this.chipVars.set(part.id, new Map(Object.entries(part.custom.state.vars)));
  }

  private chipExprs = new Map<string, { node: Node; unalias: (name: string) => string }>();

  // Evaluates an expression over a chip's own pins and state, whatever its pins are called.
  private chipEval(part: Part, source: string, lookup: (name: string) => number) {
    const key = `${part.id}|${source}`;
    let entry = this.chipExprs.get(key);
    if (!entry) {
      const aliased = aliasPins(source, pinsOf(part));
      entry = { node: compile(aliased.source), unalias: aliased.unalias };
      this.chipExprs.set(key, entry);
    }
    const { unalias } = entry;
    return evaluate(entry.node, (name) => lookup(unalias(name)));
  }

  // Names inside a chip's expression: a bare pin is its logic level (1 when at least aboveVolts over ref), v.PIN its voltage over ref, and anything else one of the chip's state variables.
  private chipLookup(part: Part, at: (key: string) => number, ref: string, aboveVolts: number) {
    const pins = new Set(pinsOf(part));
    const vars = this.chipVars.get(part.id);
    return (name: string) => {
      if (vars?.has(name)) return vars.get(name)!;
      if (name.startsWith('v.') && pins.has(name.slice(2))) return at(`${part.id}.${name.slice(2)}`) - at(`${part.id}.${ref}`);
      if (pins.has(name)) return at(`${part.id}.${name}`) - at(`${part.id}.${ref}`) >= aboveVolts ? 1 : 0;
      throw new Error(`${part.id} has no pin or state called ${name}`);
    };
  }

  private controlled(part: Part, c: { when: string; ref: string; aboveVolts: number }, at: (key: string) => number) {
    if (pinsOf(part).includes(c.when)) return at(`${part.id}.${c.when}`) - at(`${part.id}.${c.ref}`) >= c.aboveVolts;
    return Boolean(this.chipEval(part, c.when, this.chipLookup(part, at, c.ref, c.aboveVolts)));
  }

  private stepChips() {
    const at = (key: string) => this.volt(key);
    for (const part of this.spec.parts) {
      const state = part.custom?.state;
      const vars = this.chipVars.get(part.id);
      if (!state || !vars || this.burned.has(part.id)) continue;
      const lookup = this.chipLookup(part, at, state.ref, state.aboveVolts);
      for (const rule of state.rules) {
        if (rule.edge) {
          const key = `${part.id}.${rule.edge}`;
          if (!(lookup(rule.edge) && !this.chipPrev.get(key))) continue;
        }
        if (rule.when && !this.chipEval(part, rule.when, lookup)) continue;
        vars.set(rule.set, typeof rule.to === 'number' ? rule.to : this.chipEval(part, rule.to, lookup));
      }
      for (const rule of state.rules) if (rule.edge) this.chipPrev.set(`${part.id}.${rule.edge}`, lookup(rule.edge));
    }
  }

  private part(id: string) {
    return this.spec.parts.find((p) => p.id === id);
  }

  voltsBetween(a: string, b: string) {
    return this.volt(a) - this.volt(b);
  }

  private volt(key: string) {
    return this.lastVolts.get(key) ?? 0;
  }

  private boardOf(pinKey: string) {
    return this.boardOn.get(pinKey.split('.')[0]) ?? true;
  }

  private usbPowered(part: Part) {
    const vin = `${part.id}.VIN`;
    return part.usb ?? !this.spec.wires.some((w) => w.from === vin || w.to === vin);
  }

  private get dynamic() {
    return this.spec.parts.some(
      (p) => p.type === 'capacitor' || p.type === 'motor' || p.custom?.state || (p.type === 'arduino' && !this.usbPowered(p)) || p.custom?.sources.some((s) => s.from),
    );
  }

  private get hasCapacitors() {
    return this.spec.parts.some((p) => p.type === 'capacitor');
  }

  private command(state: PinState) {
    switch (state.mode) {
      case 'high':
        return 1;
      case 'low':
        return 0;
      case 'blink': {
        const half = Math.max(1, Math.floor((state.period ?? 20) / 2));
        return Math.floor(this.tick / half) % 2 === 0 ? 1 : 0;
      }
      case 'pwm':
        return clamp(state.value ?? 0.5, 0, 1);
      case 'angle':
        return clamp((state.value ?? 90) / 180, 0, 1);
    }
  }

  private duty(state: PinState) {
    return state.mode === 'angle' ? (1 + this.command(state)) / 20 : this.command(state);
  }

  private pinVolts(key: string, high: number, low: Set<string>) {
    const state = this.pinStates.get(key);
    if (!state || this.burned.has(key)) return null;
    if (PULSED.has(state.mode)) return low.has(key) ? 0 : high;
    return this.duty(state) * high;
  }

  private sensor(id: string) {
    const part = this.part(id);
    return part ? sensorOf(part) : null;
  }

  private sensorFor(target: string): string | null {
    if (this.values.has(target)) return target;
    const [id, name] = target.split('.');
    if (!name || !this.part(id)) return null;
    if (this.values.has(id)) return id;
    const node = this.nodeOf.get(target);
    if (node === undefined) return null;
    const analog = this.part(id)!.type === 'arduino' && /^A\d$/.test(name);
    for (const part of this.spec.parts) {
      const sensor = sensorOf(part);
      for (const output of sensor?.outputs ?? []) {
        if (this.nodeOf.get(`${part.id}.${output}`) !== node) continue;
        return analog && sensor!.pin === output ? null : part.id;
      }
    }
    return null;
  }

  // A settable input's current value (a pot's position, an LDR's light), whether set directly or read from the world.
  private inputLevel(id: string) {
    return this.faults.get(id) ?? this.sensed(id);
  }

  litSegments(part: Part) {
    if (part.type !== 'seven_segment' || this.burned.has(part.id)) return [];
    return SEGMENTS.filter((seg) => this.segmentsOn.has(`${part.id}.${seg}`));
  }

  glyph(part: Part) {
    return glyphOf(this.litSegments(part));
  }

  private sensed(id: string) {
    const measures = this.sensor(id)?.measures;
    return measures !== undefined && this.world.has(measures) ? this.world.get(measures)! : this.values.get(id)!;
  }

  private quantity(id: string) {
    return this.spec.world?.find((q) => q.id === id);
  }

  levelOf(part: Part) {
    if (this.burned.has(part.id)) return 0;
    const actuator = part.custom?.actuator;
    if (part.type === 'motor') return clamp(Math.abs(this.speeds.get(part.id) ?? 0), 0, 1);
    if (part.type === 'led') return clamp((this.readings.get(part.id)?.amps ?? 0) / 0.02, 0, 1);
    if (actuator && actuator.quantity !== 'text') {
      if (!this.isPowered(part)) return 0;
      return clamp(((this.outputs.get(part.id) ?? actuator.min) - actuator.min) / (actuator.max - actuator.min || 1), 0, 1);
    }
    return this.isRunning(part) ? 1 : 0;
  }

  private stepWorld() {
    for (const q of this.spec.world ?? []) {
      const now = this.world.get(q.id)!;
      let rate = q.drift ?? 0;
      if (q.toward) rate += q.toward.rate * (q.toward.value - now);
      for (const effect of q.effects) {
        const part = this.part(effect.from);
        if (part) rate += effect.rate * this.levelOf(part);
      }
      const next = clamp(now + rate * DT, q.min, q.max);
      this.world.set(q.id, next);
      if (q.target && next >= q.target.min && next <= q.target.max) this.onTarget.set(q.id, (this.onTarget.get(q.id) ?? 0) + 1);
    }
  }

  private targets() {
    return (this.spec.world ?? []).filter((q) => q.target);
  }

  private inTarget(q: { id: string; target?: { min: number; max: number } }) {
    const value = this.world.get(q.id) ?? 0;
    return !q.target || (value >= q.target.min && value <= q.target.max);
  }

  read(target: string): number {
    const sensorId = this.sensorFor(target);
    if (sensorId) {
      const part = this.part(sensorId)!;
      const needsPower = part.type === 'ultrasonic' || Boolean(part.custom?.supply);
      if (this.burned.has(sensorId) || this.shorted.has(sensorId) || (needsPower && !this.isPowered(part))) return NaN;
      return this.faults.get(sensorId) ?? this.sensed(sensorId);
    }
    const [id, name = ''] = target.split('.');
    const part = this.part(id);
    const ground = part?.type === 'arduino' ? 'GND' : (part?.custom?.sources[0]?.neg ?? part?.custom?.supply?.neg);
    const v = this.volt(target) - (ground ? this.volt(`${id}.${ground}`) : 0);
    if (part?.type === 'arduino' && /^A\d$/.test(name)) return Math.round((clamp(v, 0, 5) / 5) * 1023);
    if (part?.type === 'arduino') return v > 2.5 ? 1 : 0;
    return Math.round(v * 100) / 100;
  }

  private resetSketch() {
    this.vars.clear();
    for (const [name, value] of Object.entries(this.spec.vars ?? {})) this.vars.set(name, value);
    this.slots.clear();
    this.startTick = null;
  }

  time() {
    return this.startTick === null ? 0 : (this.tick - this.startTick) * DT;
  }

  private lookup = (name: string): number => {
    if (name === 't') return this.time();
    if (name === 'dt') return DT;
    if (this.vars.has(name)) return this.vars.get(name)!;
    if (this.world.has(name)) {
      const sensor = this.spec.parts.find((p) => sensorOf(p)?.measures === name);
      if (sensor) return this.read(sensor.id);
    }
    return this.read(name);
  };

  private calc(expr: Expr) {
    return evaluate(compile(expr), this.lookup);
  }

  private format(text: string) {
    return text.replace(/\{([^}]+)\}/g, (match, key: string, offset: number) => {
      const id = key.trim();
      let value: number;
      try {
        value = this.calc(id);
      } catch {
        return match;
      }
      if (Number.isNaN(value)) return '--';
      const sensorId = this.sensorFor(id);
      const unit = (sensorId && this.sensor(sensorId)?.unit) || '';
      const after = text
        .slice(offset + match.length)
        .replace(/^\s*°?/, '')
        .toLowerCase();
      const written = unit && after.startsWith(unit.replace('°', '').toLowerCase());
      return `${round1(value)}${written ? '' : unit}`;
    });
  }

  private act(action: Action) {
    if ('show' in action) this.texts.set(action.show, this.format(action.text));
    else if ('set' in action) this.vars.set(action.set, this.calc(action.to));
    else {
      // A dead sensor reads NaN; a pin computed from it holds its last value, as a servo holds its angle, rather than driving NaN volts.
      const computed = action.value === undefined ? undefined : this.calc(action.value);
      const value = computed === undefined || Number.isFinite(computed) ? computed : (this.pinStates.get(action.pin)?.value ?? 0);
      this.pinStates.set(action.pin, { mode: action.mode, value, period: action.period });
    }
  }

  private runProgram() {
    this.startTick ??= this.tick;
    (this.spec.program ?? []).forEach((rule, i) => {
      if (rule.every) {
        const slot = Math.floor(this.time() / rule.every + 1e-9);
        if (this.slots.get(i) === slot) return;
        this.slots.set(i, slot);
      }
      const pass = rule.when ? Boolean(this.calc(rule.when)) : !rule.if || compare(this.read(rule.if.read), rule.if.op, rule.if.value);
      for (const action of pass ? rule.then : (rule.else ?? [])) this.act(action);
    });
  }

  // A board runs from USB, like an Arduino with nothing on VIN, unless a real supply feeds its regulator input.
  // Wiring a load to that input (a servo on a Pico's VBUS) doesn't count: on USB the input pin is itself a live 5 V output.
  private onUsb(part: Part, source: Source) {
    if (!part.custom?.gpio.length || part.usb === false || !source.from) return false;
    const { find } = this.nets();
    const net = find(`${part.id}.${source.from}`);
    const fed = this.spec.parts.some((p) => {
      if (p.id === part.id) return false;
      const supplies = p.type === 'battery' ? ['pos'] : p.type === 'arduino' ? ['5V', 'VIN', '3V3'] : (p.custom?.sources.map((s) => s.pos) ?? []);
      return supplies.some((pin) => find(`${p.id}.${pin}`) === net);
    });
    return !fed;
  }

  private netCache: { version: number; nets: ReturnType<typeof netsOf> } | null = null;
  private nets() {
    if (this.netCache?.version !== this.version)
      this.netCache = { version: this.version, nets: netsOf({ ...this.spec, wires: this.spec.wires.filter((_, i) => !this.loose.has(i)) }) };
    return this.netCache.nets;
  }

  private sourceVolts(part: Part, source: Source) {
    const sag = this.sag.get(part.id);
    const limit = sag !== undefined ? Math.min(sag, source.volts) : source.volts;
    if (!source.from) return limit;
    if (this.onUsb(part, source)) return limit;
    const input = this.volt(`${part.id}.${source.from}`) - this.volt(`${part.id}.${source.neg}`);
    return clamp(input - (source.dropout ?? 0), 0, limit);
  }

  private updateBoards() {
    for (const part of this.spec.parts) {
      let on: boolean;
      if (part.type === 'arduino') {
        const vin = this.volt(`${part.id}.VIN`) - this.volt(`${part.id}.GND`);
        const rail = this.burned.has(part.id) ? 0 : this.usbPowered(part) ? 5 : clamp(vin - REGULATOR_DROP, 0, 5);
        this.railVolts.set(part.id, rail);
        on = rail >= BROWNOUT_VOLTS;
      } else if (part.custom?.gpio.length) {
        const sources = part.custom.sources;
        on = !this.burned.has(part.id) && (sources.length ? sources.every((s) => this.sourceVolts(part, s) >= s.volts * 0.8) : !part.custom.supply || this.isPowered(part));
      } else {
        continue;
      }
      if (this.boardOn.get(part.id) && !on) {
        this.resetPins(part.id);
        this.resetSketch();
      }
      if (!on) this.onSince.delete(part.id);
      else if (!this.onSince.has(part.id)) this.onSince.set(part.id, this.tick);
      this.boardOn.set(part.id, on);
    }
  }

  private elements(on: Set<string>, logic: Map<string, boolean>, h: number, low: Set<string>) {
    const out: Element[] = [];
    const add = (owner: string, a: string, b: string, ohms: number, e = 0, ctrl?: Element['ctrl']) => out.push({ owner, a, b, g: 1 / ohms, e, ctrl });
    for (const part of this.spec.parts) {
      const pin = (name: string) => `${part.id}.${name}`;
      if (this.burned.has(part.id)) continue;
      if (this.shorted.has(part.id)) {
        const pins = pinsOf(part);
        if (pins.length > 1) add(part.id, pin(pins[0]), pin(pins[1]), 0.05);
        continue;
      }
      switch (part.type) {
        case 'arduino': {
          const rail = this.railVolts.get(part.id) ?? 0;
          if (!this.burned.has(pin('5V')) && rail > 0.1) add(pin('5V'), pin('5V'), pin('GND'), 0.2, rail);
          if (!this.burned.has(pin('3V3')) && rail > 3.6) add(pin('3V3'), pin('3V3'), pin('GND'), 2, 3.3);
          if (this.wired.has(pin('VIN'))) {
            const vin = Math.max(0.5, this.volt(pin('VIN')) - this.volt(pin('GND')));
            const draw = this.usbPowered(part) ? 0.005 : (this.railAmps.get(part.id) ?? 0) + 0.04;
            add(part.id, pin('VIN'), pin('GND'), Math.max(10, vin / draw));
          }
          if (!this.boardOn.get(part.id)) break;
          for (const name of GPIO) {
            const e = this.pinVolts(pin(name), 5, low);
            if (e !== null) add(pin(name), pin(name), pin('GND'), PIN_RESISTANCE, e);
          }
          break;
        }
        case 'battery':
          add(part.id, pin('pos'), pin('neg'), 0.5, this.sag.get(part.id) ?? part.volts ?? 9);
          break;
        case 'resistor':
          add(part.id, pin('a'), pin('b'), part.ohms ?? 1000);
          break;
        case 'capacitor':
          add(part.id, pin('a'), pin('b'), h / (part.farads ?? 1e-4), this.capVolts.get(part.id) ?? 0);
          break;
        case 'led':
          if (on.has(part.id)) add(part.id, pin('anode'), pin('cathode'), LED_RESISTANCE, FORWARD_VOLTS[part.color ?? 'red']);
          break;
        // A BJT's base-emitter junction is a diode; once it conducts, the transistor saturates and closes collector to emitter.
        case 'npn':
          if (on.has(pin('B'))) {
            add(part.id, pin('B'), pin('E'), BE_RESISTANCE, BE_VOLTS);
            add(part.id, pin('C'), pin('E'), CE_SATURATED);
          }
          break;
        case 'pnp':
          if (on.has(pin('B'))) {
            add(part.id, pin('E'), pin('B'), BE_RESISTANCE, BE_VOLTS);
            add(part.id, pin('E'), pin('C'), CE_SATURATED);
          }
          break;
        // A MOSFET's gate draws nothing; past its threshold ("volts", default 2 V for logic-level parts) the channel closes.
        case 'nmos':
        case 'pmos':
          if (on.has(pin('G'))) add(part.id, pin('D'), pin('S'), MOS_ON);
          break;
        case 'diode':
          if (on.has(part.id)) add(part.id, pin('anode'), pin('cathode'), DIODE_RESISTANCE, part.volts ?? 0.7);
          // A Zener also conducts backwards once the reverse voltage reaches its rating, holding it there.
          else if (part.zener && on.has(`${part.id}.reverse`)) add(part.id, pin('cathode'), pin('anode'), DIODE_RESISTANCE, part.zener);
          break;
        case 'pot': {
          const total = part.ohms ?? 10000;
          // Turned up to 100%, the wiper sits at the "a" end, so wiring "a" to the supply makes a higher setting a higher voltage.
          const at = clamp(this.inputLevel(part.id) / 100, 0, 1);
          add(part.id, pin('a'), pin('wiper'), Math.max(1, total * (1 - at)));
          add(part.id, pin('wiper'), pin('b'), Math.max(1, total * at));
          break;
        }
        case 'ldr': {
          // About 1 MOhm in the dark down to 1 kOhm in bright light, on a log scale.
          const light = clamp(this.inputLevel(part.id) / 100, 0, 1);
          add(part.id, pin('a'), pin('b'), 10 ** (6 - 3 * light));
          break;
        }
        case 'thermistor': {
          // NTC: ohms at 25 C (default 10k), beta 3950.
          const kelvin = this.inputLevel(part.id) + 273.15;
          add(part.id, pin('a'), pin('b'), (part.ohms ?? 10000) * Math.exp(3950 * (1 / kelvin - 1 / 298.15)));
          break;
        }
        case 'seven_segment':
          for (const seg of SEGMENTS) {
            if (!on.has(pin(seg))) continue;
            if (part.common === 'anode') add(part.id, pin('com'), pin(seg), LED_RESISTANCE, SEGMENT_VOLTS);
            else add(part.id, pin(seg), pin('com'), LED_RESISTANCE, SEGMENT_VOLTS);
          }
          break;
        case 'button':
        case 'switch':
          if ((this.faults.get(part.id) ?? this.values.get(part.id) ?? 0) >= 0.5) add(part.id, pin('a'), pin('b'), 0.05);
          break;
        case 'motor': {
          const model = motorModel(part);
          add(part.id, pin('a'), pin('b'), model.ohms, model.k * (this.speeds.get(part.id) ?? 0));
          break;
        }
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
          (custom.amplifiers ?? []).forEach((amp, i) => {
            const state = this.ampState.get(pin(`amp${i}`)) ?? 'linear';
            if (state === 'high') add(part.id, pin(amp.out), pin(amp.high), amp.ohms, this.volt(pin(amp.out)) > this.volt(pin(amp.high)) ? 0 : -amp.headroom);
            else if (state === 'low') add(part.id, pin(amp.out), pin(amp.low), amp.ohms, amp.headroom);
            else add(part.id, pin(amp.out), pin(amp.low), amp.ohms, 0, { p: pin(amp.plus), n: pin(amp.minus), gain: amp.gain });
          });
          for (const source of custom.sources) {
            const e = this.sourceVolts(part, source);
            if (e > 0.05) add(part.id, pin(source.pos), pin(source.neg), source.ohms, e);
            // USB's own 5 V comes out of the regulator input pin (VBUS, 5V) for anything wired to it.
            if (source.from && this.onUsb(part, source) && !this.burned.has(part.id)) add(part.id, pin(source.from), pin(source.neg), 0.3, USB_VOLTS);
          }
          const sensor = custom.sensor;
          if (sensor?.pin && custom.supply && this.isPowered(part)) {
            const fraction = clamp((this.read(part.id) - sensor.min) / (sensor.max - sensor.min || 1), 0, 1);
            const supplyVolts = this.volt(pin(custom.supply.pos)) - this.volt(pin(custom.supply.neg));
            add(part.id, pin(sensor.pin), pin(custom.supply.neg), 1000, fraction * supplyVolts);
          }
          const reference = custom.sources[0]?.neg ?? custom.supply?.neg;
          if (!reference || !this.boardOn.get(part.id)) break;
          for (const name of custom.gpio) {
            const e = this.pinVolts(pin(name), custom.gpioVolts ?? 3.3, low);
            if (e !== null) add(pin(name), pin(name), pin(reference), PIN_RESISTANCE, e);
          }
          break;
        }
        case 'motor_driver':
          if (this.wired.has(pin('VCC'))) add(part.id, pin('VCC'), pin('GND'), 140);
          if (!logic.get(pin('POWER'))) break;
          for (const [enable, input, output] of CHANNELS) {
            const enabled = !this.wired.has(pin(enable)) || logic.get(pin(enable));
            if (!enabled) continue;
            if (logic.get(pin(input))) add(part.id, pin('VS'), pin(output), 1.5);
            else add(part.id, pin(output), pin('GND'), 1.5);
          }
          break;
      }
    }
    return out;
  }

  private segments() {
    const pulsed = [...this.pinStates]
      .filter(([key, state]) => PULSED.has(state.mode) && this.boardOf(key))
      .map(([key, state]) => ({ key, duty: this.duty(state) }))
      .sort((a, b) => a.duty - b.duty);
    const out: Array<{ weight: number; low: Set<string> }> = [];
    const low = new Set<string>();
    let start = 0;
    for (const { key, duty } of pulsed) {
      if (duty > start) out.push({ weight: duty - start, low: new Set(low) });
      start = Math.max(start, duty);
      low.add(key);
    }
    if (start < 1) out.push({ weight: 1 - start, low });
    return out;
  }

  private connect() {
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
      wired.add(wire.from).add(wire.to);
      parent.set(find(wire.from), find(wire.to));
    });
    const ground = this.spec.parts.find((p) => p.type === 'arduino' || p.type === 'battery' || p.custom?.sources.length);
    const groundPin = ground?.type === 'arduino' ? 'GND' : ground?.type === 'battery' ? 'neg' : ground?.custom?.sources[0].neg;
    const ids = new Map<string, number>();
    if (ground) ids.set(find(`${ground.id}.${groundPin}`), 0);
    const node = new Map<string, number>();
    for (const key of parent.keys()) {
      const root = find(key);
      if (!ids.has(root)) ids.set(root, ids.size);
      node.set(key, ids.get(root)!);
    }
    return { version: this.version, size: ids.size, node, wired };
  }

  private solve(h: number) {
    this.stepChips();
    if (this.topology?.version !== this.version) this.topology = this.connect();
    const { size, node: nodes } = this.topology;
    this.wired = this.topology.wired;
    this.nodeOf = nodes;
    const node = (key: string) => nodes.get(key) ?? 0;

    const average = new Array<number>(size).fill(0);
    const pinAmps = new Map<string, number>();
    const totals = new Map<string, { amps: number; volts: number }>();
    const on = new Set<string>();
    const logic = new Map<string, boolean>();
    // Each round settles one more gate in a chain, so a 16-bit ripple carry needs about 33; rounds stop early once nothing changes.
    const gates = this.spec.parts.reduce((sum, p) => sum + (p.custom?.drivers.length ?? 0), 0);
    const rounds = Math.min(240, 14 + 2 * gates);
    for (const segment of this.segments()) {
      let v: number[] = [];
      let elements: Element[] = [];
      for (let iteration = 0; iteration < rounds; iteration++) {
        elements = this.elements(on, logic, h, segment.low);
        v = nodal(
          size,
          elements.map((el) => ({ a: node(el.a), b: node(el.b), g: el.g, e: el.e, ...(el.ctrl ? { p: node(el.ctrl.p), n: node(el.ctrl.n), gain: el.ctrl.gain } : {}) })),
        );
        const at = (key: string) => v[node(key)] ?? 0;
        let changed = false;
        const update = (key: string, value: boolean) => {
          if ((logic.get(key) ?? false) !== value) changed = true;
          logic.set(key, value);
        };
        for (const part of this.spec.parts) {
          const conduct = (key: string, drop: number, threshold: number) => {
            const conducting = on.has(key) ? drop > threshold * 0.98 : drop > threshold;
            if (conducting !== on.has(key)) {
              changed = true;
              if (conducting) on.add(key);
              else on.delete(key);
            }
          };
          if (part.type === 'npn') conduct(`${part.id}.B`, at(`${part.id}.B`) - at(`${part.id}.E`), BE_VOLTS);
          if (part.type === 'pnp') conduct(`${part.id}.B`, at(`${part.id}.E`) - at(`${part.id}.B`), BE_VOLTS);
          if (part.type === 'nmos') conduct(`${part.id}.G`, at(`${part.id}.G`) - at(`${part.id}.S`), part.volts ?? 2);
          if (part.type === 'pmos') conduct(`${part.id}.G`, at(`${part.id}.S`) - at(`${part.id}.G`), part.volts ?? 2);
          if (part.type === 'diode') {
            conduct(part.id, at(`${part.id}.anode`) - at(`${part.id}.cathode`), part.volts ?? 0.7);
            if (part.zener) conduct(`${part.id}.reverse`, at(`${part.id}.cathode`) - at(`${part.id}.anode`), part.zener);
          }
          if (part.type === 'seven_segment') {
            for (const seg of SEGMENTS) {
              const drop = at(`${part.id}.${seg}`) - at(`${part.id}.com`);
              conduct(`${part.id}.${seg}`, part.common === 'anode' ? -drop : drop, SEGMENT_VOLTS);
            }
          }
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
          const control = (key: string, c: { when: string; ref: string; aboveVolts: number }) => update(key, this.controlled(part, c, at));
          part.custom?.switches.forEach((sw, i) => control(`${part.id}.switch${i}`, sw));
          (part.custom?.amplifiers ?? []).forEach((amp, i) => {
            const key = `${part.id}.amp${i}`;
            const pin = (name: string) => `${part.id}.${name}`;
            const top = at(pin(amp.high)) - amp.headroom;
            const bottom = at(pin(amp.low)) + amp.headroom;
            const wanted = at(pin(amp.low)) + amp.gain * (at(pin(amp.plus)) - at(pin(amp.minus)));
            const now = this.ampState.get(key) ?? 'linear';
            // Leaving one rail, try the linear region before the other rail: with feedback (a follower), jumping rail to rail
            // flips for ever, so an op-amp that once saturated, such as while an input wire was loose, never settled back.
            const next = wanted > top ? (now === 'low' ? 'linear' : 'high') : wanted < bottom ? (now === 'high' ? 'linear' : 'low') : 'linear';
            if (next !== now) {
              this.ampState.set(key, next);
              changed = true;
            }
          });
          part.custom?.drivers.forEach((driver, i) => control(`${part.id}.driver${i}`, driver));
          if (part.type === 'motor_driver') {
            const pin = (name: string) => `${part.id}.${name}`;
            const reference = at(pin('GND'));
            update(pin('POWER'), this.wired.has(pin('VCC')) ? at(pin('VCC')) - reference > 4 : at(pin('VS')) - reference >= 7);
            for (const name of ['ENA', 'ENB', 'IN1', 'IN2', 'IN3', 'IN4']) update(pin(name), at(pin(name)) - reference > 2.5);
          }
        }
        if (!changed) break;
      }
      v.forEach((value, i) => (average[i] += value * segment.weight));
      const peak = new Map<string, { amps: number; volts: number }>();
      for (const el of elements) {
        const drop = (v[node(el.a)] ?? 0) - (v[node(el.b)] ?? 0);
        const amps = el.g * (drop - el.e);
        pinAmps.set(el.a, (pinAmps.get(el.a) ?? 0) + amps * segment.weight);
        pinAmps.set(el.b, (pinAmps.get(el.b) ?? 0) - amps * segment.weight);
        const best = peak.get(el.owner);
        if (!best || Math.abs(amps) > Math.abs(best.amps)) peak.set(el.owner, { amps, volts: drop });
      }
      for (const [owner, { amps, volts: drop }] of peak) {
        const total = totals.get(owner) ?? { amps: 0, volts: 0 };
        totals.set(owner, { amps: total.amps + amps * segment.weight, volts: total.volts + drop * segment.weight });
      }
    }

    this.segmentsOn = new Set([...on].filter((key) => key.includes('.')));
    this.closedSwitches = new Set([...logic].filter(([key, value]) => value && /\.switch\d+$/.test(key)).map(([key]) => key));
    for (const [key, index] of nodes) this.lastVolts.set(key, average[index] ?? 0);
    const at = (key: string) => average[node(key)] ?? 0;
    this.readings.clear();
    for (const [owner, { amps, volts: drop }] of totals) this.readings.set(owner, this.rate(owner, Math.abs(amps), Math.abs(drop)));

    for (const part of this.spec.parts) {
      const dead = this.burned.has(part.id) || this.shorted.has(part.id);
      if (part.type === 'capacitor' && !this.burned.has(part.id)) this.capVolts.set(part.id, at(`${part.id}.a`) - at(`${part.id}.b`));
      if (part.type === 'motor') {
        const model = motorModel(part);
        const amps = dead ? 0 : (totals.get(part.id)?.amps ?? 0);
        const speed = this.speeds.get(part.id) ?? 0;
        this.speeds.set(part.id, speed + (h * (model.k * amps - model.friction * speed)) / model.inertia);
      }
      if (part.type === 'arduino') this.railAmps.set(part.id, this.readings.get(`${part.id}.5V`)?.amps ?? 0);
      const supply = part.custom?.supply;
      if (!supply || this.burned.has(part.id)) continue;
      const across = at(`${part.id}.${supply.pos}`) - at(`${part.id}.${supply.neg}`);
      const reading = this.readings.get(part.id) ?? this.rate(part.id, 0, 0);
      const load = across > supply.maxVolts ? Math.max(reading.load, across / supply.maxVolts) : reading.load;
      this.readings.set(part.id, { ...reading, volts: across, load, burnAt: Math.min(reading.burnAt, 1.5) });
    }

    this.wireAmps = this.spec.wires.map((wire, i) => {
      if (this.loose.has(i)) return 0;
      const from = pinAmps.get(wire.from) ?? 0;
      const to = pinAmps.get(wire.to) ?? 0;
      return Math.abs(from) >= Math.abs(to) ? from : -to;
    });
  }

  private rate(owner: string, amps: number, drop: number): Reading {
    const part = this.part(owner);
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
    if (part.type === 'motor') {
      const rated = part.maxAmps ?? LIMITS.motor!.rated;
      return { volts: drop, amps, load: Math.max(amps / rated, drop / ((part.volts ?? 6) * 1.25)), burnAt: 2, rated: milli(rated) };
    }
    if (part.type === 'battery' && part.maxAmps) {
      return { volts: drop, amps, load: amps / part.maxAmps, burnAt: 2.5, rated: milli(part.maxAmps) };
    }
    const limit = LIMITS[part.type];
    if (!limit) return { volts: drop, amps, load: 0, burnAt: Infinity, rated: 'n/a' };
    return { volts: drop, amps, load: amps / limit.rated, burnAt: limit.burn / limit.rated, rated: milli(limit.rated) };
  }

  private causeOf(key: string, reading: Reading) {
    const part = this.part(key);
    const supply = part?.custom?.supply;
    if (supply && reading.volts > supply.maxVolts) return `${reading.volts.toFixed(1)} V against its ${supply.maxVolts} V maximum`;
    if (part?.type === 'motor' && reading.volts > (part.volts ?? 6) * 1.25) return `${reading.volts.toFixed(1)} V on a ${part.volts ?? 6} V motor`;
    if (reading.rated.endsWith('W')) return `more power than its ${reading.rated} rating`;
    return `${milli(reading.amps)} against its ${reading.rated} rating`;
  }

  isPowered(part: Part) {
    if (this.burned.has(part.id) || this.shorted.has(part.id)) return false;
    const reading = this.readings.get(part.id);
    const supply = part.custom?.supply;
    if (supply) return Boolean(reading && reading.volts >= supply.minVolts && reading.volts <= supply.maxVolts);
    return Boolean(reading && reading.amps > 0.001);
  }

  private controlLevel(part: Part, pinName: string | undefined) {
    if (!pinName) return 1;
    const target = this.nodeOf.get(`${part.id}.${pinName}`);
    if (target === undefined) return 0;
    for (const [key, state] of this.pinStates) {
      if (this.nodeOf.get(key) === target && this.boardOf(key)) return this.command(state);
    }
    const boardPins = this.spec.parts.flatMap((p) => (p.type === 'arduino' ? GPIO : (p.custom?.gpio ?? [])).map((name) => `${p.id}.${name}`));
    return boardPins.some((key) => this.nodeOf.get(key) === target) ? 0 : 1;
  }

  private updateActuators() {
    for (const part of this.spec.parts) {
      const actuator = part.custom?.actuator;
      if (!actuator || actuator.quantity === 'text') continue;
      const powered = this.isPowered(part);
      const value = actuator.min + this.controlLevel(part, actuator.pin) * (actuator.max - actuator.min);
      if (actuator.quantity !== 'angle') this.outputs.set(part.id, powered ? value : actuator.min);
      else if (powered) this.outputs.set(part.id, value);
      else if (!this.outputs.has(part.id)) this.outputs.set(part.id, actuator.min);
    }
  }

  private isActive(part: Part) {
    const reading = this.readings.get(part.id);
    switch (part.type) {
      case 'led':
        return (reading?.amps ?? 0) > 0.002;
      case 'seven_segment':
        return this.litSegments(part).length > 0;
      case 'buzzer':
        return (reading?.amps ?? 0) > 0.005;
      case 'motor':
        return Math.abs(this.speeds.get(part.id) ?? 0) > 0.15;
      case 'ultrasonic':
        return Boolean(reading && reading.volts >= 4.5 && reading.volts <= 5.5);
      case 'custom': {
        const actuator = part.custom?.actuator;
        if (!this.isPowered(part)) return false;
        // A relay or other switching part is on when its contacts are closed, not just because it has power.
        if (!actuator && part.custom?.switches.length) return part.custom.switches.some((_, i) => this.closedSwitches.has(`${part.id}.switch${i}`));
        if (!actuator || actuator.quantity === 'angle') return true;
        if (actuator.quantity === 'text') return Boolean(this.texts.get(part.id));
        return ((this.outputs.get(part.id) ?? actuator.min) - actuator.min) / (actuator.max - actuator.min || 1) > 0.05;
      }
      default:
        return false;
    }
  }

  isRunning(part: Part) {
    return !this.burned.has(part.id) && this.isActive(part);
  }

  private window() {
    let span = 12;
    for (const state of this.pinStates.values()) if (state.mode === 'blink') span = Math.max(span, state.period ?? 20);
    return span;
  }

  private ranRecently(id: string) {
    return this.tick - (this.lastOn.get(id) ?? -Infinity) <= this.window();
  }

  isHealthy(part: Part) {
    if (this.burned.has(part.id) || this.shorted.has(part.id)) return false;
    if ((this.readings.get(part.id)?.load ?? 0) > 1) return false;
    return !this.twin || (this.twin.ranRecently(part.id) === this.ranRecently(part.id) && this.matchesTwin(part));
  }

  private matchesTwin(part: Part) {
    const twin = this.twin!;
    const actuator = part.custom?.actuator;
    if (actuator?.quantity === 'text') return shape(this.texts.get(part.id)) === shape(twin.texts.get(part.id));
    if (actuator) {
      const span = Math.abs(actuator.max - actuator.min) || 1;
      return Math.abs((this.outputs.get(part.id) ?? 0) - (twin.outputs.get(part.id) ?? 0)) <= span * 0.05;
    }
    if (part.type === 'motor') {
      const designed = Math.abs(twin.speeds.get(part.id) ?? 0);
      return designed < 0.15 || Math.abs(this.speeds.get(part.id) ?? 0) >= designed * 0.5;
    }
    return true;
  }

  private booted() {
    if (!this.boardOn.size) return true;
    return [...this.onSince.values()].some((since) => this.tick - since >= BOOT_TICKS);
  }

  step() {
    this.twin?.step();
    this.updateBoards();
    if (this.booted()) this.runProgram();
    const signature = [
      [...this.pinStates].map(([key, state]) => `${key}:${this.boardOf(key) ? `${state.mode}${this.command(state)}` : 'off'}`).join(),
      [...this.boardOn.values()].join(),
      [...this.values.values()].join(),
      [...this.world.values()].map((v) => v.toFixed(1)).join(),
      [...this.faults.values()].join(),
    ].join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.dirty = true;
    }
    if (this.dirty || this.dynamic) {
      const substeps = this.hasCapacitors ? SUBSTEPS : 1;
      for (let i = 0; i < substeps; i++) this.solve(DT / substeps);
      this.dirty = false;
    }
    for (const [key, reading] of this.readings) {
      this.peakAmps = Math.max(this.peakAmps, reading.amps);
      const count = reading.load >= reading.burnAt ? (this.stress.get(key) ?? 0) + 1 : 0;
      this.stress.set(key, count);
      if (count >= BURN_TICKS && !this.burned.has(key)) {
        this.burned.add(key);
        this.burnCauses.set(key, this.causeOf(key, reading));
        this.dirty = true;
      }
    }
    this.updateActuators();
    this.stepWorld();
    for (const part of this.outputParts()) if (this.isRunning(part)) this.lastOn.set(part.id, this.tick);
    this.tick++;
    const value = this.percentOk();
    this.scoreSum += value;
    if (this.tick % SERIES_STEP === 0) this.series.push({ t: this.tick, value });
  }

  private outputParts() {
    return this.spec.parts.filter(isOutput);
  }

  private percentOk() {
    const outputs = this.outputParts();
    const targets = this.targets();
    if (!outputs.length && !targets.length) {
      const parts = this.spec.parts.length;
      return ((parts - this.spec.parts.filter((p) => this.burned.has(p.id)).length) / parts) * 100;
    }
    const ok = outputs.filter((p) => this.isHealthy(p)).length + targets.filter((q) => this.inTarget(q)).length;
    return (ok / (outputs.length + targets.length)) * 100;
  }

  inject(incident: Incident) {
    const target = incident.target ?? '';
    this.log.push({ at: this.tick, incident });
    this.version++;
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
      case 'set_reading': {
        this.twin?.inject(incident);
        const sensor = this.sensor(target);
        const q = this.quantity(target) ?? (sensor?.measures ? this.quantity(sensor.measures) : undefined);
        if (q) this.world.set(q.id, clamp(incident.value ?? q.min, q.min, q.max));
        else if (sensor) this.values.set(target, clamp(incident.value ?? sensor.min, sensor.min, sensor.max));
        break;
      }
      case 'sensor_fault':
        this.faults.set(target, incident.value ?? this.sensor(target)?.min ?? 0);
        break;
      case 'repair':
        this.burned.delete(target);
        this.shorted.delete(target);
        this.sag.delete(target);
        this.faults.delete(target);
        this.stress.delete(target);
        if (/^W\d+$/.test(target)) this.loose.delete(wireIndex(target));
        break;
    }
    this.dirty = true;
  }

  apply(patches: unknown[]) {
    this.log.push({ at: this.tick, patches });
    this.version++;
    this.twin?.apply(patches);
    for (const patch of patches as CircuitPatch[]) this.applyPatch(patch);
    this.dirty = true;
  }

  private applyPatch(patch: CircuitPatch) {
    switch (patch.op) {
      case 'set_ohms': {
        const part = this.part(patch.part);
        if (part) part.ohms = patch.ohms;
        break;
      }
      case 'set_volts': {
        const part = this.part(patch.part);
        if (part) part.volts = patch.volts;
        this.sag.delete(patch.part);
        break;
      }
      case 'set_farads': {
        const part = this.part(patch.part);
        if (part) part.farads = patch.farads;
        break;
      }
      case 'set_usb': {
        const part = this.part(patch.part);
        if (part) part.usb = patch.usb;
        break;
      }
      case 'replace_part':
        this.burned.delete(patch.part);
        this.shorted.delete(patch.part);
        this.faults.delete(patch.part);
        for (const key of [...this.burned]) if (key.startsWith(`${patch.part}.`)) this.burned.delete(key);
        this.stress.clear();
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
        const drive = { pin: patch.pin, mode: patch.mode, value: patch.value, period: patch.period };
        this.spec.drive = [...this.spec.drive.filter((d) => d.pin !== patch.pin), drive];
        this.pinStates.set(patch.pin, { mode: patch.mode, value: patch.value, period: patch.period });
        break;
      }
      case 'set_program':
        this.spec.program = patch.program;
        if (patch.vars) {
          this.spec.vars = patch.vars;
          this.resetSketch();
        }
        break;
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
      scoreLabel: this.targets().length ? '% of outputs and targets OK' : '% of outputs working',
      metrics: [
        ...this.targets().map((q) => ({
          label: `${q.label.toLowerCase()} on target`,
          value: `${this.tick ? Math.round(((this.onTarget.get(q.id) ?? 0) / this.tick) * 100) : 0}%`,
        })),
        { label: 'peak current', value: milli(this.peakAmps) },
        { label: 'parts burned', value: this.burned.size },
        { label: 'worst load', value: `${this.worstLoad()}%` },
      ],
      series: this.series,
    };
  }

  telemetry(): Metric[] {
    const outputs = this.outputParts();
    const healthy = outputs.filter((p) => this.isHealthy(p)).length;
    const worst = this.worstLoad();
    let supply = 0;
    // A USB-powered board's pins draw from the computer, which the rails don't see, so its zero reading means "not measured" rather than "off"
    let measured = false;
    for (const part of this.spec.parts) {
      const own = part.type === 'battery' || part.custom?.sources.some((source) => !source.from);
      const keys = own ? [part.id] : part.type === 'arduino' && this.usbPowered(part) ? [`${part.id}.5V`, `${part.id}.3V3`] : [];
      if (own) measured = true;
      for (const key of keys) supply += this.readings.get(key)?.amps ?? 0;
    }
    const metrics: Metric[] = [
      { label: 'outputs working', value: `${healthy}/${outputs.length}`, tone: healthy < outputs.length ? 'danger' : undefined },
      ...(measured || supply > 0 ? [{ label: 'supply current', value: milli(supply) }] : []),
      { label: 'worst part load', value: `${worst}%`, tone: worst > 100 ? 'danger' : worst > 80 ? 'warn' : undefined },
      { label: 'parts burned', value: this.burned.size, tone: this.burned.size ? 'danger' : undefined },
    ];
    const off = [...this.boardOn].find(([, on]) => !on);
    if (off) metrics.push({ label: `${off[0]} board`, value: 'browned out', tone: 'danger' });
    for (const q of this.spec.world ?? []) {
      metrics.push({ label: q.label.toLowerCase(), value: withUnit(this.world.get(q.id) ?? 0, q.unit), tone: this.inTarget(q) ? undefined : 'danger' });
    }
    return metrics;
  }

  breakables(): Breakable[] {
    const out: Breakable[] = [];
    const output = this.outputParts().find((p) => !this.burned.has(p.id));
    if (output)
      out.push({
        label: `Burn ${output.custom?.label ?? output.id}`,
        incident: { type: 'burn_part', target: output.id },
        keywords: [output.id.toLowerCase(), output.type, (output.custom?.label ?? '').toLowerCase(), 'burn', 'fail'].filter(Boolean),
      });
    const sensorPart = this.spec.parts.find((p) => sensorOf(p) && !this.faults.has(p.id));
    const sensor = sensorPart && sensorOf(sensorPart);
    if (sensorPart && sensor) {
      out.push({
        label: `Fault ${sensor.label}`,
        incident: { type: 'sensor_fault', target: sensorPart.id, value: sensor.min },
        keywords: [sensorPart.id.toLowerCase(), sensor.label.toLowerCase(), 'sensor', 'reading', 'fault'],
      });
    }
    const wire = this.spec.wires.findIndex((_, i) => !this.loose.has(i));
    if (wire >= 0) out.push({ label: `Loose ${wireId(wire)}`, incident: { type: 'loose_wire', target: wireId(wire) }, keywords: ['wire', 'loose', 'disconnect'] });
    const battery = this.spec.parts.find((p) => p.type === 'battery');
    if (battery)
      out.push({ label: 'Low battery', incident: { type: 'low_supply', target: battery.id, value: (battery.volts ?? 9) / 2 }, keywords: ['battery', 'supply', 'power'] });
    else {
      const resistor = this.spec.parts.find((p) => p.type === 'resistor' && !this.shorted.has(p.id));
      if (resistor) out.push({ label: `Short ${resistor.id}`, incident: { type: 'short_part', target: resistor.id }, keywords: [resistor.id.toLowerCase(), 'resistor', 'short'] });
    }
    return out;
  }

  check(patches: unknown[]) {
    return checkPatches(CircuitPatchSchema, patches, (p: CircuitPatch) => {
      if ('part' in p && !this.part(p.part)) return `There is no part ${p.part} here.`;
      if (p.op === 'set_ohms' && this.part(p.part)!.type !== 'resistor') return 'Only a resistor takes a new value in ohms.';
      if (p.op === 'set_volts' && this.part(p.part)!.type !== 'battery') return 'Only a battery takes a new voltage.';
      return null;
    });
  }

  /** Values a hand edit can swap on a part as it runs: a resistor from the standard series, or a battery's voltage. */
  private partSettings(part: Part): Setting[] {
    if (part.type === 'resistor' && part.ohms) {
      const values = [...new Set([...RESISTOR_VALUES, part.ohms])].sort((a, b) => a - b);
      return [{ kind: 'choice', label: 'Resistance', hint: 'Swap in another standard value.', value: part.ohms, options: values.map((v) => ({ label: ohmsLabel(v), value: v })), patch: { op: 'set_ohms', part: part.id }, key: 'ohms' }];
    }
    if (part.type === 'battery' && part.volts) {
      const values = [...new Set([...BATTERY_VOLTS, part.volts])].sort((a, b) => a - b);
      return [{ kind: 'choice', label: 'Battery', hint: 'Swap in a pack of another voltage.', value: part.volts, options: values.map((v) => ({ label: `${v} V`, value: v })), patch: { op: 'set_volts', part: part.id }, key: 'volts' }];
    }
    return [];
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
    const part = this.part(target);
    if (!part) return null;
    const reading = this.readings.get(target);
    const broken = this.burned.has(target) || this.shorted.has(target) || this.faults.has(target);
    const status = this.burned.has(target)
      ? 'Burned out'
      : this.shorted.has(target)
        ? 'Shorted'
        : this.faults.has(target)
          ? 'Faulty reading'
          : (reading?.load ?? 0) > 1
            ? 'Over its rating'
            : 'OK';
    const rows: Array<[string, string | number]> = [
      ['Type', part.custom?.label ?? part.type.replace('_', ' ')],
      ['Status', status],
    ];
    if (part.ohms && part.type !== 'motor') rows.push(['Value', `${part.ohms} Ω`]);
    if (part.type === 'capacitor') rows.push(['Charge', volts(this.capVolts.get(target) ?? 0)]);
    if (part.type === 'motor') rows.push(['Speed', `${Math.round(Math.abs(this.speeds.get(target) ?? 0) * 100)}% of rated`]);
    const sensor = sensorOf(part);
    if (sensor) {
      const value = this.read(target);
      rows.push(['Reading', Number.isNaN(value) ? 'No reading' : withUnit(value, sensor.unit)]);
    }
    const actuator = part.custom?.actuator;
    if (actuator?.quantity === 'text') rows.push(['Showing', this.isPowered(part) ? (this.texts.get(target) ?? 'Nothing yet') : 'Off']);
    else if (actuator) rows.push([actuator.quantity[0].toUpperCase() + actuator.quantity.slice(1), round1(this.outputs.get(target) ?? actuator.min)]);
    if (part.type === 'arduino') {
      const usb = this.usbPowered(part);
      const rail = this.readings.get(`${target}.5V`);
      rows.push(['Powered by', usb ? 'USB' : `VIN at ${volts(this.volt(`${target}.VIN`) - this.volt(`${target}.GND`))}`], ['5 V rail', volts(this.railVolts.get(target) ?? 0)]);
      if (rail) rows.push(['5 V rail load', `${milli(rail.amps)} of ${rail.rated}`]);
      rows.push(['Board', this.boardOn.get(target) ? 'Running' : 'Browned out']);
      return { title: target, rows, actions: [] };
    }
    if (reading) rows.push(['Voltage', volts(reading.volts)], ['Current', milli(reading.amps)], ['Rated', reading.rated], ['Load', `${Math.round(reading.load * 100)}%`]);
    const actions: Inspection['actions'] = [];
    if ((part.type === 'button' || part.type === 'switch') && !broken) {
      const pressed = (this.values.get(target) ?? 0) >= 0.5;
      const words = part.type === 'switch' ? ['Turn off', 'Turn on'] : ['Release', 'Press'];
      actions.push(
        { label: pressed ? words[0] : words[1], incident: { type: 'set_reading', target, value: pressed ? 0 : 1 }, destructive: false },
        { label: 'Stick it down', incident: { type: 'sensor_fault', target, value: 1 }, destructive: true },
      );
    } else if (sensor && !broken) {
      const span = sensor.max - sensor.min;
      const label = (word: string, value: number) => `Reading ${word} (${withUnit(value, sensor.unit)})`;
      actions.push(
        { label: label('low', sensor.min + span * 0.1), incident: { type: 'set_reading', target, value: sensor.min + span * 0.1 }, destructive: false },
        { label: label('high', sensor.max - span * 0.1), incident: { type: 'set_reading', target, value: sensor.max - span * 0.1 }, destructive: false },
        { label: 'Sensor fault', incident: { type: 'sensor_fault', target, value: sensor.min }, destructive: true },
      );
    }
    if (broken) actions.push({ label: 'Replace part', incident: { type: 'repair', target }, destructive: false });
    else actions.push({ label: 'Burn this part', incident: { type: 'burn_part', target }, destructive: true });
    return { title: target, rows, actions, settings: broken ? [] : this.partSettings(part) };
  }
}
