import type { Domain, Hypothesis, Incident, Issue, RecoveryOption } from '../../domain';
import { countOf } from '../warehouse';
import { CircuitPatchSchema, CircuitRun, wireId } from './circuit';
import { CircuitSpecSchema, GPIO, PINS, isOutput, pinsOf, sensorOf, withUnit, type CircuitSpec, type Part } from './parts';
import { compile, namesIn, type Expr } from './sketch';

const CHECK_TICKS = 70;
const TIMED_CHECK_TICKS = 720;
const TARGET_SHARE = 80;
const RESPONSE_TICKS = 24;
const WARMUP_TICKS = 20;
const SUSTAINED_TICKS = 10;
const TWO_PINS = new Set(['resistor', 'capacitor', 'led', 'motor', 'buzzer', 'diode', 'ldr', 'thermistor']);

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
  const measured = new Set(spec.parts.flatMap((p) => (sensorOf(p) && p.measures ? [p.measures] : [])));
  const worldIds = new Set((spec.world ?? []).map((q) => q.id));
  const known = (name: string) => name === 't' || name === 'dt' || variables.has(name) || sensorIds.has(name) || measured.has(name) || pinExists(spec, name);
  const checkExpr = (expr: Expr | undefined) => {
    if (expr === undefined || typeof expr === 'number') return;
    try {
      for (const name of namesIn(compile(expr))) {
        if (known(name)) continue;
        const message = worldIds.has(name)
          ? `The program reads ${name} in "${expr}", but no sensor measures it: give a sensor "measures": "${name}" or read that sensor's id`
          : `The program uses ${name} in "${expr}", which isn't a variable, sensor, pin or measured world quantity`;
        issues.push({ severity: 'error', message });
      }
    } catch (error) {
      issues.push({ severity: 'error', message: `The program can't read "${expr}": ${(error as Error).message}` });
    }
  };
  // Reading a sensor by its id already gives its own unit; scaling that by 1023 is a raw-ADC conversion applied twice.
  const exprs = [...(spec.program ?? []).flatMap((r) => [r.when]), ...actionsOf(spec).flatMap((a) => ('to' in a ? [a.to] : 'value' in a ? [a.value] : []))];
  for (const expr of exprs) {
    if (typeof expr !== 'string' || !/\b102[34](\.0+)?\b/.test(expr)) continue;
    for (const id of sensorIds) {
      if (!new RegExp(`(^|[^.\\w])${id}(?![.\\w])`).test(expr)) continue;
      const sensor = sensorOf(spec.parts.find((p) => p.id === id)!)!;
      issues.push({
        severity: 'warning',
        message: `"${expr}" converts ${id} from 0-1023, but reading ${id} by its id already gives ${sensor.unit || 'its own unit'} (${sensor.min} to ${sensor.max}); use ${id} directly`,
        repair: true,
      });
    }
  }
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

function checkWorld(spec: CircuitSpec): Issue[] {
  const issues: Issue[] = [];
  const world = spec.world ?? [];
  const ids = new Set<string>();
  for (const q of world) {
    if (ids.has(q.id)) issues.push({ severity: 'error', message: `Duplicate world quantity ${q.id}` });
    ids.add(q.id);
    if (q.max <= q.min) issues.push({ severity: 'error', message: `World quantity ${q.id} has an empty range` });
    if (q.target && (q.target.min >= q.target.max || q.target.min < q.min || q.target.max > q.max))
      issues.push({ severity: 'error', message: `World quantity ${q.id} has a target outside its range` });
    for (const effect of q.effects) {
      if (!spec.parts.some((p) => p.id === effect.from)) issues.push({ severity: 'error', message: `${q.id} is changed by ${effect.from}, which isn't a part` });
    }
  }
  for (const part of spec.parts) {
    if (!part.measures) continue;
    if (!ids.has(part.measures)) issues.push({ severity: 'error', message: `${part.id} measures ${part.measures}, which isn't in the world`, target: part.id });
    else if (!sensorOf(part)) issues.push({ severity: 'error', message: `${part.id} measures ${part.measures} but isn't a sensor`, target: part.id });
  }
  return issues;
}

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
    const isPin = (name: string) => custom.pins.includes(name);
    const stateVars = new Set([...Object.keys(custom.state?.vars ?? {}), ...(custom.state?.rules ?? []).map((r) => r.set)]);
    const checkLogic = (expr: Expr, where: string) => {
      if (typeof expr === 'number') return;
      try {
        for (const name of namesIn(compile(expr))) {
          const pin = name.startsWith('v.') ? name.slice(2) : name;
          if (!isPin(pin) && !stateVars.has(name))
            issues.push({
              severity: 'error',
              message: `${part.id}'s ${where} "${expr}" uses ${name}, which isn't one of its pins (${custom.pins.join(', ')}) or state variables${custom.gpio.length ? `. ${part.id} is a board: drive its pins from the "program" (list them in "gpio"), not with drivers` : ''}`,
              target: part.id,
            });
        }
      } catch (error) {
        issues.push({ severity: 'error', message: `${part.id}'s ${where} "${expr}" can't be read: ${(error as Error).message}`, target: part.id });
      }
    };
    for (const c of [...custom.switches, ...custom.drivers]) if (!isPin(c.when)) checkLogic(c.when, 'logic');
    for (const rule of custom.state?.rules ?? []) {
      if (rule.when) checkLogic(rule.when, 'state rule');
      checkLogic(rule.to, 'state rule');
    }
    const named = [
      ...custom.paths.flatMap((p) => [p.a, p.b]),
      ...custom.switches.flatMap((s) => [s.a, s.b, ...(isPin(s.when) ? [s.when] : []), s.ref]),
      ...custom.drivers.flatMap((d) => [d.pin, d.high, d.low, ...(isPin(d.when) ? [d.when] : []), d.ref]),
      ...(custom.state ? [custom.state.ref, ...custom.state.rules.flatMap((r) => (r.edge ? [r.edge] : []))] : []),
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

const isInput = (part: Part) => part.type === 'button' || part.type === 'switch';

function scenarios(spec: CircuitSpec) {
  const out: Array<{ incident?: Incident; also?: Incident[]; when: string; sensor?: string }> = [{ when: '' }];
  const inputs = spec.parts.filter(isInput);
  // Every input flipped at once, so outputs that need several inputs together (an AND gate, a carry bit) get a chance to turn on.
  if (inputs.length > 1) {
    const [first, ...rest] = inputs.map((p): Incident => ({ type: 'set_reading', target: p.id, value: p.closed ? 0 : 1 }));
    out.push({ incident: first, also: rest, when: ` with every switch and button flipped` });
  }
  for (const part of spec.parts) {
    const sensor = sensorOf(part);
    if (!sensor) continue;
    const values = isInput(part) ? [part.closed ? 0 : 1] : [sensor.min, sensor.max];
    for (const value of values) {
      const when = isInput(part)
        ? ` when ${part.id} is ${value ? (part.type === 'switch' ? 'on' : 'pressed') : 'off'}`
        : ` when ${part.id} reads ${value}${sensor.unit ? ` ${sensor.unit}` : ''}`;
      out.push({ incident: { type: 'set_reading', target: part.id, value }, when, sensor: isInput(part) ? undefined : part.id });
    }
  }
  return out.slice(0, 12);
}

function explore(spec: CircuitSpec) {
  const burned = new Map<string, string>();
  const overloads = new Map<string, string>();
  const ran = new Set<string>();
  const offTarget = new Map<string, string>();
  const targets = (spec.world ?? []).filter((q) => q.target);
  const controls = spec.parts.flatMap((part) => (part.custom?.switches ?? []).filter((sw) => pinsOf(part).includes(sw.when)).map((sw) => ({ part, sw, reached: -Infinity })));
  const responses = new Map<string, Array<{ value: number; pins: string }>>();
  const pinsRead = [...new Set((JSON.stringify(spec.program ?? []).match(/[A-Za-z_]\w*\.\w+/g) ?? []).filter((key) => pinExists(spec, key)))];
  for (const { incident, also, when, sensor } of scenarios(spec)) {
    const run = new CircuitRun(spec, 1, true);
    for (const each of incident ? [incident, ...(also ?? [])] : []) run.inject(each);
    const over = new Map<string, { ticks: number; message: string }>();
    const ticks = !incident && (timed(spec) || targets.length) ? TIMED_CHECK_TICKS : CHECK_TICKS;
    const held = new Map<string, number>();
    const left = new Map<string, string>();
    const reached = new Set<string>();
    for (let i = 0; i < ticks; i++) {
      run.step();
      if (sensor && i === RESPONSE_TICKS) {
        const list = responses.get(sensor) ?? [];
        list.push({ value: incident!.value ?? 0, pins: pinsRead.map((key) => `${key} at ${Math.round(run.read(key) * 10) / 10}`).join(', ') });
        responses.set(sensor, list);
      }
      for (const control of controls) {
        const id = control.part.id;
        control.reached = Math.max(control.reached, run.voltsBetween(`${id}.${control.sw.when}`, `${id}.${control.sw.ref}`));
      }
      if (!incident) {
        for (const q of targets) {
          const value = run.world.get(q.id) ?? 0;
          if (value >= q.target!.min && value <= q.target!.max) reached.add(q.id);
          if (left.has(q.id) || !reached.has(q.id) || (value >= q.target!.min && value <= q.target!.max)) continue;
          const drivers = q.effects.flatMap((effect) => {
            const part = spec.parts.find((p) => p.id === effect.from);
            if (!part) return [];
            const level = Math.round(run.levelOf(part) * 100);
            return [`${part.id} at ${level}%${part.type === 'motor' && level > 5 ? ' (motors take a moment to stop, so slow down or stop earlier)' : ''}`];
          });
          left.set(
            q.id,
            `; it first left the range after ${Math.round((i / 12) * 10) / 10} s at ${Math.round(value * 10) / 10}${drivers.length ? `, with ${drivers.join(', ')}` : ''}`,
          );
        }
      }
      if (!incident && i >= ticks / 2) {
        for (const q of targets) {
          const value = run.world.get(q.id) ?? 0;
          if (value >= q.target!.min && value <= q.target!.max) held.set(q.id, (held.get(q.id) ?? 0) + 1);
        }
      }
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
    if (!incident) {
      for (const q of targets) {
        if (!reached.has(q.id)) left.set(q.id, `; it never reached the range from its start of ${q.start}`);
        const share = Math.round(((held.get(q.id) ?? 0) / (ticks / 2)) * 100);
        if (share < TARGET_SHARE)
          offTarget.set(
            q.id,
            `${q.label} stays within ${q.target!.min}–${q.target!.max}${q.unit ? ` ${q.unit}` : ''} only ${share}% of the time once running, ending at ${Math.round((run.world.get(q.id) ?? 0) * 10) / 10}${left.get(q.id) ?? ''}`,
          );
      }
    }
    for (const [id, { ticks, message }] of over) {
      if (ticks >= SUSTAINED_TICKS && !overloads.has(id) && !run.burned.has(id)) overloads.set(id, `${message}${when}`);
    }
  }
  const stuck = controls.filter((c) => c.reached < c.sw.aboveVolts);
  const deaf: string[] = [];
  if ((spec.program ?? []).length) {
    for (const [id, [low, high]] of responses) {
      const part = spec.parts.find((p) => p.id === id)!;
      const program = JSON.stringify(spec.program ?? []);
      const named = [id, part.measures].filter(Boolean).some((name) => new RegExp(`\\b${name}\\b`).test(program));
      if (!low || !high || named || low.pins !== high.pins) continue;
      const unit = sensorOf(part)?.unit ?? '';
      const range = `${low.value} to ${high.value}${unit ? ` ${unit}` : ''}`;
      deaf.push(
        low.pins
          ? `The sketch never sees ${id}: changing it from ${range} leaves ${low.pins} either way, so check how it is wired and read`
          : `The sketch never reads ${id}, so changing it from ${range} does nothing`,
      );
    }
  }
  return { burned, overloads, ran, offTarget, stuck, deaf };
}

const TEST_TICKS = 24;

// Runs each of the design's own behaviour tests and reports every output that does the wrong thing.
function netsOf(spec: CircuitSpec) {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (const w of spec.wires) parent.set(find(w.from), find(w.to));
  const members = new Map<string, string[]>();
  for (const part of spec.parts)
    for (const pin of pinsOf(part)) {
      const key = `${part.id}.${pin}`;
      const root = find(key);
      members.set(root, [...(members.get(root) ?? []), key]);
    }
  return { find, members };
}

// Follows a wrong output back to the chip output driving it, with that output's logic and the level each of its inputs had, so a repair knows where the logic breaks.
function traceOutput(spec: CircuitSpec, run: CircuitRun, outputId: string) {
  const { find, members } = netsOf(spec);
  const part = spec.parts.find((p) => p.id === outputId);
  if (!part) return '';
  const nets = new Set(pinsOf(part).map((pin) => find(`${part.id}.${pin}`)));
  // Step through series resistors, the usual LED current limiter.
  for (const net of [...nets]) {
    for (const key of members.get(net) ?? []) {
      const [id, pin] = key.split('.');
      const passive = spec.parts.find((p) => p.id === id && p.type === 'resistor');
      if (passive && passive.id !== outputId) nets.add(find(`${id}.${pin === 'a' ? 'b' : 'a'}`));
    }
  }
  const sourceOf = (key: string) =>
    (members.get(find(key)) ?? []).find((k) => {
      if (k === key) return false;
      const [id, pin] = k.split('.');
      const p = spec.parts.find((x) => x.id === id);
      return p && (p.type === 'switch' || p.type === 'button' || p.custom?.drivers.some((d) => d.pin === pin));
    });
  const found: string[] = [];
  for (const chip of spec.parts) {
    for (const driver of chip.custom?.drivers ?? []) {
      if (!nets.has(find(`${chip.id}.${driver.pin}`))) continue;
      let inputs = '';
      try {
        const names = [...namesIn(compile(driver.when))].filter((n) => pinsOf(chip).includes(n));
        inputs = names
          .map((n) => {
            const level = run.voltsBetween(`${chip.id}.${n}`, `${chip.id}.${driver.ref}`) >= driver.aboveVolts ? 1 : 0;
            const from = sourceOf(`${chip.id}.${n}`);
            return `${n}=${level}${from ? ` from ${from}` : ' (unconnected)'}`;
          })
          .join(', ');
      } catch {
        inputs = '';
      }
      found.push(`${outputId} is driven by ${chip.id}.${driver.pin} = "${driver.when}"${inputs ? ` with ${inputs}` : ''}`);
    }
  }
  if (found.length) return found.join('; ');
  // No chip drives it: say what each of its pins is wired to and at what voltage, so a passive or sketch-driven circuit can be traced too.
  const pins = pinsOf(part).map((pin) => {
    const key = `${part.id}.${pin}`;
    const others = (members.get(find(key)) ?? []).filter((k) => k !== key);
    const volts = Math.round(run.voltsBetween(key, `${part.id}.${pinsOf(part).at(-1)}`) * 10) / 10;
    return `${pin} (${volts} V) joins ${others.length ? others.slice(0, 4).join(', ') : 'nothing'}`;
  });
  return `${outputId}'s ${pins.join('; ')}`;
}

// Runs each of the design's own behaviour tests and reports every output that does the wrong thing.
export function runTests(spec: CircuitSpec) {
  const failures: string[] = [];
  const traces: string[] = [];
  let passed = 0;
  // A test with no inputs on a clocked circuit only samples wherever the clock happens to be, so it proves nothing.
  const clocked = spec.parts.some((p) => p.custom?.state) || Boolean(spec.program?.some((r) => r.every));
  for (const [i, test] of (spec.tests ?? []).entries()) {
    if (clocked && !Object.keys(test.set).length) continue;
    const run = new CircuitRun(spec, 1, true);
    for (const [target, value] of Object.entries(test.set)) run.inject({ type: 'set_reading', target, value });
    for (let t = 0; t < TEST_TICKS; t++) run.step();
    const bad: Array<[string, string]> = [
      ...test.on.flatMap((id): Array<[string, string]> => {
        const part = spec.parts.find((p) => p.id === id);
        return part && !run.isRunning(part) ? [[id, `${id} should be on but is off`]] : [];
      }),
      ...test.off.flatMap((id): Array<[string, string]> => {
        const part = spec.parts.find((p) => p.id === id);
        return part && run.isRunning(part) ? [[id, `${id} should be off but is on`]] : [];
      }),
    ];
    if (!bad.length) {
      passed++;
      continue;
    }
    const inputs = Object.entries(test.set)
      .map(([id, v]) => `${id}=${v}`)
      .join(', ');
    failures.push(`Test ${test.name ? `"${test.name}"` : i + 1} (${inputs || 'no inputs'}): ${bad.map(([, m]) => m).join(', ')}`);
    if (traces.length < 3) traces.push(`In that test ${traceOutput(spec, run, bad[0][0])}`);
  }
  return { passed, total: (spec.tests ?? []).filter((t) => !clocked || Object.keys(t.set).length).length, failures, traces };
}

function checkTests(spec: CircuitSpec): Issue[] {
  const issues: Issue[] = [];
  const inputs = spec.parts.filter(isInput);
  if (!spec.tests?.length && !spec.program?.length && inputs.length && spec.parts.some(isOutput)) {
    const rows = Math.min(16, 2 ** Math.max(1, inputs.length));
    return [
      {
        severity: 'warning',
        message: `This circuit has ${inputs.length ? 'inputs' : 'logic'} but no behaviour tests, so nothing confirms it does what was asked. Add "tests" with ${rows === 16 && inputs.length > 4 ? 'the 16 most telling' : `all ${rows}`} input combinations, each listing every output as on or off`,
        repair: true,
      },
    ];
  }
  const ids = new Set(spec.parts.map((p) => p.id));
  const settable = new Set(spec.parts.filter((p) => sensorOf(p)).map((p) => p.id));
  for (const test of spec.tests ?? []) {
    for (const id of Object.keys(test.set)) if (!settable.has(id)) issues.push({ severity: 'error', message: `A test sets ${id}, which isn't a switch, button or sensor` });
    for (const id of [...test.on, ...test.off]) if (!ids.has(id)) issues.push({ severity: 'error', message: `A test checks ${id}, which isn't a part` });
  }
  if (issues.length) return issues;
  const wanted = 2 ** inputs.length;
  if (!spec.program?.length && inputs.length && inputs.length <= 4 && (spec.tests?.length ?? 0) < wanted) {
    issues.push({
      severity: 'warning',
      message: `There are ${inputs.length} inputs (${inputs.map((p) => p.id).join(', ')}) but only ${spec.tests?.length ?? 0} behaviour tests; list all ${wanted} combinations so every case is checked`,
      repair: true,
    });
  }
  const { failures, total, traces } = runTests(spec);
  // Report a few in full, so a repair has concrete rows to fix without drowning in them.
  if (failures.length)
    issues.push({
      severity: 'warning',
      message: `${failures.length} of ${total} behaviour tests fail. ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? `; and ${failures.length - 5} more` : ''}. ${traces.join('. ')}. Fix the wiring or the chip logic so every row passes`,
      repair: true,
    });
  return issues;
}

function validateCircuit(spec: CircuitSpec): Issue[] {
  const issues = checkParts(spec);
  spec.wires.forEach((wire, i) => {
    for (const end of [wire.from, wire.to]) {
      if (!pinExists(spec, end)) issues.push({ severity: 'error', message: `${wireId(i)} connects to ${end}, which doesn't exist`, target: wireId(i) });
    }
  });
  issues.push(...checkProgram(spec), ...checkWorld(spec));
  if (!spec.parts.some((p) => p.type === 'arduino' || p.type === 'battery' || p.custom?.sources.length)) {
    issues.push({ severity: 'error', message: 'There is no power source' });
  }
  if (issues.some((i) => i.severity === 'error')) return issues;
  issues.push(...checkTests(spec));
  if (issues.some((i) => i.severity === 'error')) return issues;
  if (!spec.parts.some(isOutput)) {
    issues.push({ severity: 'warning', message: 'Nothing in this circuit does anything observable, so there is nothing to simulate', repair: true });
  }

  const { burned, overloads, ran, offTarget, stuck, deaf } = explore(spec);
  for (const message of offTarget.values()) issues.push({ severity: 'warning', message, repair: true });
  for (const message of deaf) issues.push({ severity: 'warning', message, repair: true });
  for (const { part, sw, reached } of stuck) {
    const got = Number.isFinite(reached) ? `${Math.max(0, Math.round(reached * 10) / 10)} V` : 'nothing';
    issues.push({
      severity: 'warning',
      message: `${part.id} never connects ${sw.a} to ${sw.b}: it needs ${sw.when} at least ${sw.aboveVolts} V above ${sw.ref}, but gets ${got}`,
      target: part.id,
      repair: true,
    });
  }
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

const CUSTOM = { paths: [], switches: [], drivers: [], sources: [], gpio: [], output: false, visual: [] };

function planter(): CircuitSpec {
  return {
    parts: [
      { id: 'U1', type: 'arduino' },
      { id: 'B1', type: 'battery', volts: 9, maxAmps: 2 },
      { id: 'P1', type: 'motor', volts: 9, ohms: 9, maxAmps: 1.5 },
      {
        id: 'S1',
        type: 'custom',
        measures: 'soil',
        custom: {
          ...CUSTOM,
          label: 'Soil sensor',
          pins: ['VCC', 'GND', 'AO'],
          paths: [{ a: 'VCC', b: 'GND', ohms: 500 }],
          supply: { pos: 'VCC', neg: 'GND', minVolts: 3, maxVolts: 5.5 },
          sensor: { quantity: 'soil moisture', unit: '%', min: 0, max: 100, pin: 'AO' },
          visual: [
            { shape: 'box', size: [1.2, 0.08, 0.7], at: [0, 0.2, 0], color: '#14532d' },
            { shape: 'box', size: [0.18, 0.06, 1.3], at: [-0.3, 0.2, 0.95], color: '#d4af37' },
            { shape: 'box', size: [0.18, 0.06, 1.3], at: [0.3, 0.2, 0.95], color: '#d4af37' },
          ],
        },
      },
      {
        id: 'K1',
        type: 'custom',
        custom: {
          ...CUSTOM,
          label: 'Relay',
          pins: ['IN', 'VCC', 'GND', 'COM', 'NO'],
          paths: [{ a: 'VCC', b: 'GND', ohms: 70 }],
          switches: [{ a: 'COM', b: 'NO', ohms: 0.05, when: 'IN', ref: 'GND', aboveVolts: 2 }],
          visual: [
            { shape: 'box', size: [1.6, 0.1, 1.1], at: [0, 0.15, 0], color: '#1d4ed8' },
            { shape: 'box', size: [0.9, 0.6, 0.7], at: [0, 0.5, 0], color: '#0f172a' },
          ],
        },
      },
      {
        id: 'L1',
        type: 'custom',
        custom: {
          ...CUSTOM,
          label: '16x2 LCD',
          pins: ['VCC', 'GND'],
          paths: [{ a: 'VCC', b: 'GND', ohms: 250 }],
          supply: { pos: 'VCC', neg: 'GND', minVolts: 4.5, maxVolts: 5.5 },
          actuator: { quantity: 'text', min: 0, max: 0 },
          visual: [
            { shape: 'box', size: [2, 0.12, 1], at: [0, 0.15, 0], color: '#166534' },
            { shape: 'box', size: [1.6, 0.06, 0.55], at: [0, 0.24, 0], color: '#86efac' },
          ],
        },
      },
    ],
    wires: [
      { from: 'U1.5V', to: 'S1.VCC' },
      { from: 'U1.GND', to: 'S1.GND' },
      { from: 'S1.AO', to: 'U1.A0' },
      { from: 'U1.D7', to: 'K1.IN' },
      { from: 'U1.5V', to: 'K1.VCC' },
      { from: 'U1.GND', to: 'K1.GND' },
      { from: 'B1.neg', to: 'U1.GND' },
      { from: 'B1.pos', to: 'K1.COM' },
      { from: 'K1.NO', to: 'P1.a' },
      { from: 'P1.b', to: 'B1.neg' },
      { from: 'U1.5V', to: 'L1.VCC' },
      { from: 'U1.GND', to: 'L1.GND' },
    ],
    drive: [],
    vars: { watering: 0 },
    program: [
      { when: 'S1 < 35', then: [{ set: 'watering', to: 1 }] },
      { when: 'S1 > 60', then: [{ set: 'watering', to: 0 }] },
      { when: 'watering == 1', then: [{ pin: 'U1.D7', mode: 'high' }], else: [{ pin: 'U1.D7', mode: 'low' }] },
      { every: 0.5, then: [{ show: 'L1', text: 'Soil {S1}% pump {watering}' }] },
    ],
    world: [{ id: 'soil', label: 'Soil moisture', unit: '%', start: 50, min: 0, max: 100, drift: -1.5, effects: [{ from: 'P1', rate: 8 }], target: { min: 30, max: 70 } }],
  };
}

function buildCircuit(prompt: string): CircuitSpec {
  const text = prompt.toLowerCase();
  if (/plant|soil|water|greenhouse|irrigat/.test(text)) return planter();
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
  const program = JSON.stringify(rules);
  const read = sensed.find((p) => new RegExp(`\\b${p.id}\\b`).test(program)) ?? (rules.some((r) => r.if || r.when) ? sensed[0] : undefined);
  const info = read && sensorOf(read);
  if (read && info)
    out.push({
      claim: `If ${read.id} sticks at ${withUnit(info.max, info.unit)}, the sketch acts on a false reading.`,
      incident: { type: 'sensor_fault', target: read.id, value: info.max },
    });
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
    'Electronics of any kind, from a battery and a bulb to digital logic to microcontroller projects. Built-in parts cover batteries, resistors, capacitors, LEDs, switches, buttons, buzzers, DC motors, H-bridge drivers, ultrasonic sensors and Arduino boards, and any other component or board (logic gates and other chips, 555 timers, counters, transistors, relays, servos, displays, sensors, regulators, and boards such as a Seeed XIAO, Raspberry Pi Pico or ESP32) is defined from its real pins, electrical paths, ratings and logic. Simulates over time: voltages and currents, digital logic and chip state, PWM, capacitor charging, motor spin-up and back-EMF, board power and brownout, sensor readings, servo angles, display text and microcontroller sketches. Circuits can be laid out on a breadboard. Checks ratings and burns out overloaded parts.',
  limits: [
    'Time runs in 1/12 s steps, so radio, audio and fast signal waveforms are averaged',
    'Sketches are rules over readings and pin states, not compiled code',
    'Mechanical load, heat and physical motion beyond rotation are not simulated',
  ],
  examples: [
    'A self-watering planter that keeps the soil between 30 and 70 percent',
    'An Arduino with a motor driver, two motors and an ultrasonic sensor',
    'A blinking LED wired to an Arduino with no resistor',
  ],
  suggestions: ['What happens if the battery runs low?', 'Is anything over its rating?', 'What happens if a wire comes loose?'],
  keywords:
    /planter|soil|greenhouse|irrigat|thermostat|relay|pump|arduino|esp32|raspberry pi pico|circuit|breadboard|\bleds?\b|resistor|capacitor|servo|sensor|motor driver|h-bridge|ultrasonic|buzzer|electronic|robotic system/i,
  ticksPerSecond: 12,
  horizon: 300,
  seeds: 1,
  responseDelay: 10,
  specSchema: CircuitSpecSchema,
  specDoc: `{
  "parts": [{"id": unique string, "type": type, "measures"?: world id, "ohms"?: number, "volts"?: number, "maxAmps"?: number, "farads"?: number, "usb"?: boolean, "color"?: "red"|"yellow"|"green"|"blue"|"white"}],
  "wires": [{"from": "PartId.pin", "to": "PartId.pin"}],
  "drive": [{"pin": "U1.D13", "mode": "high"|"low"|"blink"|"pwm"|"angle", "value"?: number, "period"?: ticks}],
  "vars"?: {"name": starting number},
  "world"?: [{"id": name, "label": string, "unit": string, "start": number, "min": number, "max": number, "drift"?: change per second on its own, "toward"?: {"value": ambient level, "rate": share of the gap closed per second}, "effects"?: [{"from": part id, "rate": change per second at that part's full output}], "target"?: {"min": number, "max": number}}],
  "program": [{"every"?: seconds, "when"?: expression, "then": [Action], "else"?: [Action]}],
  "layout"?: "breadboard" | "bench"
}
Build what the user asked for, the way a person would really build it. Only use a microcontroller when the user names one or the behaviour needs code; a lamp, a logic circuit, a 555 blinker, a transistor switch or a calculator made of gates is built from batteries, switches, chips and discrete parts, with no board, no "drive" and no "program". Use type "arduino" only for an Arduino Uno or Nano.
Set "layout": "breadboard" when the user mentions a breadboard, or when the circuit is low-voltage signal work only: LEDs, logic chips, 555 timers, small transistors, switches and resistors. Use "bench" for anything that drives a real load (heaters, lamps and bulbs, motors, pumps, fans, relays switching power) or is built around a board and modules. The layout only changes how it is drawn, never what is simulated.
Give every part a "package" for how it looks: "dip" for chips in a DIP package, "module" for boards and breakout modules, "to92" for small transistors and regulators, "to220" for power transistors and regulators, "axial" for diodes, "radial" for electrolytic capacitors, "bulb" for lamps, "display" for LCDs, OLEDs and 7-segment displays, "pot" for potentiometers, "relay", "motor" for motors, pumps, fans and servos, "speaker" for buzzers and speakers, "sensor" for sensors.
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
"paths" are its resistive paths: model what it draws as a path between its power pins (a part drawing 100 mA at 5 V is 50 ohms), and a pass-through such as a driver's power rail as a very low value. "switches" are paths that only conduct when a control pin is high, for relay contacts and transistors. A relay is {"a":"COM","b":"NO","ohms":0.05,"when":"IN","ref":"GND","aboveVolts":2}. "drivers" are outputs that swing between two rails from a control pin, for motor drivers, H-bridges and stepper drivers. A coil or motor needs its two ends on opposite rails, so give each pair one normal and one inverted output: {"pin":"1A","high":"VMOT","low":"GND","when":"STEP","ref":"GND","aboveVolts":2,"ohms":1} and {"pin":"1B","high":"VMOT","low":"GND","when":"STEP","ref":"GND","aboveVolts":2,"ohms":1,"invert":true}. "maxAmps" is the part's highest rated current, including what its outputs carry. "sources" are voltages it produces, such as a board's 3.3 V rail; a regulator takes "from" its input pin and "dropout", so it fails when its input sags. For any board other than an Arduino Uno or Nano (Seeed XIAO, Raspberry Pi Pico, ESP32, STM32 and so on) use custom with "package": "module", the board's exact name as "label", its real pin names, "sources" for its rails (a 3V3 regulator "from" its 5V or VIN pin), "gpio" for its I/O pins and "gpioVolts": 3.3; the sketch drives those pins as "PartId.pin" exactly like an Arduino's.
Logic: the "when" of a switch or driver can also be a logic expression over the part's own pins, where each pin name is 1 when it is at least "aboveVolts" over "ref", "v.PIN" is that pin's voltage over "ref", and != is XOR. Name chip pins so they work in expressions (letters first, such as A1, B1, Y1). A 74HC08 quad AND gate is {"label":"74HC08 quad AND","pins":["VCC","GND","A1","B1","Y1","A2","B2","Y2"],"paths":[{"a":"VCC","b":"GND","ohms":5000}],"drivers":[{"pin":"Y1","high":"VCC","low":"GND","when":"A1 && B1","ref":"GND","aboveVolts":2.5,"ohms":50},{"pin":"Y2","high":"VCC","low":"GND","when":"A2 && B2","ref":"GND","aboveVolts":2.5,"ohms":50}],"supply":{"pos":"VCC","neg":"GND","minVolts":2,"maxVolts":6}}; a 74HC86 XOR output is "when":"A1 != B1", a 74HC32 OR is "A1 || B1", a NOT is "!A1". When the user names a gate (AND, OR, XOR, NAND, NOT), build it with that gate chip, not with switches in series or parallel. Only list the gates you wire. Wire chips to each other directly, output pin to input pin, and power every chip's VCC and GND. Arithmetic from gates: a half adder is S = A XOR B and C = A AND B; a full adder is S = (A XOR B) XOR Cin and Cout = (A AND B) OR (Cin AND (A XOR B)); a 2-bit adder is a half adder on bit 0 whose carry feeds a full adder on bit 1, giving S0, S1 and the carry as the 4s bit. Before writing wires, write down which gate output each signal comes from.
Chips with memory (flip-flops, counters, shift registers, 555 timers) add "state": {"ref": pin, "aboveVolts": number, "vars": {"name": start}, "rules": [{"edge"?: pin that must have just risen, "when"?: expression, "set": var, "to": expression}]}, and their outputs' "when" read those vars. A 4-bit counter is "state":{"ref":"GND","aboveVolts":2.5,"vars":{"n":0},"rules":[{"edge":"CLK","set":"n","to":"(n + 1) % 16"}]} with outputs "when":"n % 2 >= 1", "n % 4 >= 2", "n % 8 >= 4", "n % 16 >= 8". A 555 timer has pins GND, TRIG, OUT, RST, CV, THR, DIS, VCC, a path VCC to GND of 1500 ohms, "state":{"ref":"GND","aboveVolts":2,"vars":{"q":1},"rules":[{"when":"v.TRIG < v.VCC / 3","set":"q","to":1},{"when":"v.THR > v.VCC * 2 / 3","set":"q","to":0}]}, a driver OUT "when":"q" between VCC and GND, and a switch DIS to GND "when":"!q"; in astable mode RA runs from VCC to DIS, RB from DIS to THR, THR joins TRIG and the capacitor to ground, RST to VCC, and it blinks at 1.44 / ((RA + 2 RB) C) Hz, so choose a rate a person can see (about 1 Hz: RA 1k, RB 4.7k, C 100 uF).
A transistor is custom "to92": an NPN such as a 2N2222 is {"pins":["C","B","E"],"paths":[{"a":"B","b":"E","ohms":1000}],"switches":[{"a":"C","b":"E","ohms":0.3,"when":"B","ref":"E","aboveVolts":0.65}],"maxAmps":0.6}, with a base resistor (1k to 10k) from whatever drives it, and a flyback diode across any motor or relay it switches.
"tests" are checked in simulation, so add them for anything with defined behaviour (logic, calculators, counters' first states, switches or buttons controlling outputs): [{"name": short label, "set": {"input part id": 1 or 0, or a sensor id: reading}, "on": [output ids that must be on], "off": [output ids that must be off]}], with every input not listed left at its default. A 2-bit adder needs all 16 input combinations, each listing every sum LED as on or off; an AND gate needs all 4. Work out each expected row from what the circuit is for, not from your wiring, then make the wiring pass them.
Inputs: "switch" is a toggle or slide switch that stays where it is set ("closed": true to start on), and "button" a momentary push button; the user flips them by clicking. Every logic input needs a pull-down resistor (10k to ground) so it reads 0 when open, and every LED needs its series resistor. For a DIP switch bank use one "switch" per position. A lamp or bulb is custom "bulb" with a path between its two pins and "output": true.
More built-in parts: "diode" conducts only from anode to cathode with "volts" forward drop (0.7 silicon, 0.3 Schottky), for rectifiers, reverse protection, solar charging and flyback diodes. "pot" is a potentiometer of "ohms" total with its wiper at a position the user turns (0-100%). "ldr" is a light sensor whose resistance falls from about 1 MOhm in the dark to 1 kOhm in bright light (0-100%), and "thermistor" a 10k NTC ("ohms" at 25 C) reading temperature in C; wire either in a divider with a fixed resistor, and give it "measures" when it senses a world quantity. "seven_segment" is a display with segment pins a-g and "com", "common": "cathode" or "anode"; each segment is an LED and needs its own resistor, and it shows the digit its lit segments spell, so drive it from a decoder chip (a CD4511 or 74HC47 is custom, with each segment output's "when" written over its BCD input pins) or from a board's pins.
A comparator or op-amp used as one (LM393, LM358) is custom with a driver whose "when" compares voltages, such as "v.INP > v.INN", which is how a night light, thermostat or battery alarm works without a board.
Sensor: {"quantity": what it measures, "unit": "%"|"C"|"cm"|..., "min": number, "max": number, "value": a typical reading, "pin"?: its analog output pin}. With "pin" it outputs a voltage proportional to the reading (wire it to an analog pin); without, it is read over I2C, SPI or 1-wire by its id. Give it a "supply" so it only reads when powered.
Actuator: {"quantity": "angle"|"speed"|"brightness"|"text", "pin"?: its control pin, "min": number, "max": number}. A servo is angle, min 0, max 180, on its signal pin, which the sketch drives with mode "angle" and value in degrees. A display (LCD, OLED, 7-segment) is text and shows what the program writes to it.
A part with a "package" is drawn from it and needs no "visual". Only when no package fits, "visual" must use 3 to 8 shapes in units where the part is about 2 wide, so it looks like the real thing: y is up and sits on the bench at 0. A servo is [{"shape":"box","size":[1.6,0.9,0.8],"at":[0,0.45,0],"color":"#1f2937"},{"shape":"box","size":[2.2,0.08,0.8],"at":[0,0.65,0],"color":"#111827"},{"shape":"cylinder","size":[0.3,0.3,0.3],"at":[0.4,1.05,0],"color":"#e5e7eb"},{"shape":"box","size":[1.1,0.08,0.22],"at":[0.4,1.22,0],"color":"#f8fafc","moves":true}]. Use Part "custom" field only with type "custom".
"drive" is each output pin's state at startup: "pwm" takes "value" from 0 to 1 for speed or brightness, "angle" takes degrees. "program" is the sketch's loop and runs every tick, rule by rule. A rule with "every" runs once per that many seconds; one with "when" runs "then" while the expression is true and "else" while it is false; one with neither runs every tick. Actions: {"pin": "U1.D9", "mode": ..., "value"?: expression}, {"set": variable, "to": expression}, {"show": display id, "text": "Angle {angle} deg"}, where each {expression} becomes its value. An expression is a number or a string using numbers, "vars", t (seconds since the sketch started), sensor ids, "PartId.pin" readings, + - * / %, < > <= >= == !=, && || !, a ? b : c, and min, max, abs, round, floor, ceil, sqrt, sin, cos, clamp(x, lo, hi). Variables keep their value between ticks and reset when the board resets. A servo sweep is "vars": {"angle": 0, "step": 5} with rules {"every": 0.05, "then": [{"set": "angle", "to": "angle + step"}]}, {"when": "angle >= 180", "then": [{"set": "step", "to": -5}]}, {"when": "angle <= 0", "then": [{"set": "step", "to": 5}]}, {"then": [{"pin": "U1.D9", "mode": "angle", "value": "angle"}]}. Use variables and t for anything timed: sequences, timers, debouncing and state machines. Read a sensor by its id. Reading one of its pins, or a board pin wired to it, gives the same reading in the sensor's own unit (an ultrasonic gives distance in cm, 2 to 400), except an arduino analog pin wired to a sensor's analog output, which gives 0 to 1023. Any other arduino digital pin reads 0 or 1, and any other board's pin its voltage. A button is released until someone presses it; wire it with a pull-down or pull-up resistor so its pin reads 0 or 1. Every pin that controls something must be in drive or the program, including motor driver IN and EN pins. Use the program for anything that reacts to a sensor.
"world" is the physical system the circuit senses and acts on, such as soil a pump wets, a room a heater warms and a window cools, the distance a robot drives toward a wall, or water in a tank. Add a world quantity for every physical thing the user's system is meant to control or react to, give each sensor that reads it "measures", and list every part that changes it in "effects" with a realistic rate: a pump at full speed might raise soil moisture 5 % per second while it dries 1 % per second, and motors at full speed close a gap by 30 to 60 cm per second. Effects add up, so a car driven by two wheel motors gives each half of its speed. Time runs in real seconds, so choose rates that show change within a minute. A heater, lamp, solenoid or other resistive load is custom with a path between its power pins and "output": true, never a motor or a resistor. A part's output is its speed for motors, its angle or level for actuators, its brightness for LEDs, and on or off for anything else. Give "target" for what the system is meant to keep in range; the checks reject a design whose sketch doesn't hold it there, so write a real control loop with hysteresis, and remember motors take a moment to stop: a motor coasts when its driver is disabled, so brake by driving both inputs to the same level with the driver enabled, and leave room to stop.
Wire electrically real circuits: use a current-limiting resistor with LEDs (220 ohms is typical), drive motors through a driver with a battery on its motor supply, and share ground between the board and any battery. A servo driver passes its V+ power straight through to the servo with low-ohm "paths". Wire exactly what the user asks for, even if it is a mistake: the checks that follow will catch it. "unmodelled" is only for behaviour none of this can represent, such as a radio link or a mechanical load, never for leaving a part out.`,
  incidentTypes: ['burn_part', 'short_part', 'loose_wire', 'low_supply', 'sensor_fault', 'set_reading'],
  incidentDoc: `{"type":"burn_part","target":"D1"}
{"type":"short_part","target":"R1"}
{"type":"loose_wire","target":"W3"} (wires are numbered from W1 in spec order)
{"type":"low_supply","target":"B1","value":volts}
{"type":"sensor_fault","target":"S1","value":the wrong reading it gets stuck at}
{"type":"set_reading","target":"S1" or a world id,"value":reading} (a change in conditions, such as the soil drying out, not a failure)`,
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
      world: spec.world ?? [],
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
