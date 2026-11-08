import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { netsOf, pinsOf, sensorOf, withUnit, type CircuitRun, type CircuitSpec, type Part } from '@tv/core';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select, useStore } from '../../store';
import { ClaimPin, Floor, Tag, pick } from '../shared';
import { LOOK } from '../../scene/look';
import { BoardParts, breadboardExtent, jumperColor, layoutBreadboard, spotPosition, type BoardLayout, type Spot } from './Breadboard';
import { PackageBody, SevenSegment, SmallPart, dipSpan, drawnByPackage, packagePin } from './Packages';
import './Bench.css';

const circuit = () => runner.run as CircuitRun | null;
const LED_COLORS = { red: '#ff3b3b', yellow: '#ffd24a', green: '#3dff7a', blue: '#4aa3ff', white: '#ffffff' };
const WIRE_COLORS = ['#f59e0b', '#22d3ee', '#a78bfa', '#34d399', '#f472b6', '#60a5fa'];
const dummy = new THREE.Object3D();

const footprint = (part: Part) => {
  if (part.type === 'arduino') return 0;
  if (part.package === 'dip' || part.package === 'module') return Math.max(2.6, dipSpan(part).length + 1.4);
  return 4.4;
};

function layoutParts(spec: CircuitSpec) {
  const positions = new Map<string, [number, number]>();
  spec.parts.filter((p) => p.type === 'arduino').forEach((p, i) => positions.set(p.id, [-9.5, i * 7]));
  const others = spec.parts.filter((p) => p.type !== 'arduino');
  const rowWidth = Math.max(13.2, Math.sqrt(others.reduce((a, p) => a + footprint(p), 0) * 4.4 * 1.4));
  let x = 0;
  let row = 0;
  for (const p of others) {
    const w = footprint(p);
    if (x > 0 && x + w > rowWidth) {
      x = 0;
      row++;
    }
    positions.set(p.id, [-5.2 + x + w / 2, -5 + row * 3.6]);
    x += w;
  }
  return positions;
}

export function benchExtent(spec: CircuitSpec) {
  if (spec.layout === 'breadboard') return breadboardExtent(spec);
  const points = [...layoutParts(spec).values()];
  const xs = points.map(([x]) => x);
  const zs = points.map(([, z]) => z);
  const minX = Math.min(...xs) - 4;
  const maxX = Math.max(...xs) + 2;
  const minZ = Math.min(...zs) - 3;
  const maxZ = Math.max(...zs) + 3;
  return { width: maxX - minX, depth: maxZ - minZ, centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2 };
}

function pinPosition(part: Part, pin: string, [x, z]: [number, number]) {
  const pins = pinsOf(part);
  const i = Math.max(0, pins.indexOf(pin));
  const packaged = packagePin(part, pin) ?? (part.type === 'seven_segment' ? packagePin({ ...part, package: 'dip' }, pin) : null);
  if (packaged) return new THREE.Vector3(x + packaged[0], packaged[1], z + packaged[2]);
  switch (part.type) {
    case 'custom': {
      const half = Math.ceil(pins.length / 2);
      const left = i < half;
      const row = left ? i : i - half;
      const count = left ? half : pins.length - half;
      return new THREE.Vector3(x + (left ? -1.2 : 1.2), 0.25, z + (row - (count - 1) / 2) * 0.34);
    }
    case 'arduino': {
      if (/^D\d+$/.test(pin)) return new THREE.Vector3(x - 2.9 + (Number(pin.slice(1)) - 2) * 0.52, 0.36, z - 2.45);
      const lower = ['5V', '3V3', 'GND', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'].indexOf(pin);
      return new THREE.Vector3(x - 2.9 + lower * 0.62, 0.36, z + 2.45);
    }
    case 'motor_driver':
      return new THREE.Vector3(x + (i < 7 ? -1.35 : 1.35), 0.32, z - 1.2 + (i < 7 ? i : i - 7) * 0.38);
    case 'ultrasonic':
      return new THREE.Vector3(x - 0.54 + i * 0.36, 0.3, z + 0.75);
    default:
      return new THREE.Vector3(x + (i === 0 ? -1 : 1), 0.2, z);
  }
}

function wireColor(from: string, to: string, index: number) {
  if (/\.(GND|neg)$/.test(from) || /\.(GND|neg)$/.test(to)) return '#64748b';
  if (/\.(5V|3V3|VCC|VS|pos)$/.test(from) || /\.(5V|3V3|VCC|VS|pos)$/.test(to)) return '#ef4444';
  return WIRE_COLORS[index % WIRE_COLORS.length];
}

function Board() {
  return (
    <group>
      <mesh position={[0, 0.16, 0]} castShadow receiveShadow>
        <boxGeometry args={[7.2, 0.14, 5.2]} />
        <meshStandardMaterial color="#0c6a78" roughness={0.5} metalness={0.3} />
      </mesh>
      <mesh position={[-3.1, 0.42, 1]} castShadow>
        <boxGeometry args={[1.6, 0.5, 1.4]} />
        <meshStandardMaterial color="#b6c0cc" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh position={[0.9, 0.3, 0.2]} castShadow>
        <boxGeometry args={[3, 0.16, 0.8]} />
        <meshStandardMaterial color="#14171f" roughness={0.6} />
      </mesh>
      {[-2.45, 2.45].map((z) => (
        <mesh key={z} position={[0, 0.3, z]}>
          <boxGeometry args={[6.4, 0.16, 0.2]} />
          <meshStandardMaterial color="#14171f" />
        </mesh>
      ))}
    </group>
  );
}

function Led({ part }: { part: Part }) {
  const material = useRef<THREE.MeshStandardMaterial>(null!);
  const color = LED_COLORS[part.color ?? 'red'];
  useFrame(() => {
    const run = circuit();
    const amps = run?.readings.get(part.id)?.amps ?? 0;
    const dead = run?.burned.has(part.id);
    material.current.emissiveIntensity = dead ? 0 : Math.min(7, amps * 500);
    material.current.color.set(dead ? '#111' : color);
  });
  return (
    <group>
      <mesh position={[0, 0.34, 0]} castShadow>
        <sphereGeometry args={[0.36, 24, 16]} />
        <meshStandardMaterial ref={material} color={color} emissive={color} roughness={0.25} transparent opacity={0.92} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.12, 0]}>
        <boxGeometry args={[2, 0.05, 0.08]} />
        <meshStandardMaterial color="#c8d0da" metalness={0.8} roughness={0.3} />
      </mesh>
    </group>
  );
}

function Resistor({ part }: { part: Part }) {
  const material = useRef<THREE.MeshStandardMaterial>(null!);
  useFrame(() => {
    const run = circuit();
    const load = run?.readings.get(part.id)?.load ?? 0;
    material.current.color.set(run?.burned.has(part.id) ? '#1a1a1a' : load > 1 ? '#c2410c' : '#d6b98a');
  });
  return (
    <group>
      <mesh position={[0, 0.2, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.2, 0.9, 6, 16]} />
        <meshStandardMaterial ref={material} roughness={0.6} />
      </mesh>
      {[-0.26, 0, 0.26].map((x, i) => (
        <mesh key={x} position={[x, 0.2, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.215, 0.215, 0.1, 16]} />
          <meshStandardMaterial color={['#7c2d12', '#991b1b', '#1f2937'][i]} />
        </mesh>
      ))}
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[2, 0.05, 0.05]} />
        <meshStandardMaterial color="#c8d0da" metalness={0.8} roughness={0.3} />
      </mesh>
    </group>
  );
}

function Motor({ part }: { part: Part }) {
  const shaft = useRef<THREE.Group>(null!);
  useFrame((_, dt) => {
    const run = circuit();
    const speed = run?.burned.has(part.id) ? 0 : (run?.speeds.get(part.id) ?? 0);
    shaft.current.rotation.z += dt * speed * 14 * (runner.running ? runner.speed : 0);
  });
  return (
    <group>
      <mesh position={[-0.2, 0.55, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.55, 0.55, 1.5, 28]} />
        <meshStandardMaterial color="#aeb8c4" metalness={0.8} roughness={0.28} />
      </mesh>
      <group ref={shaft} position={[0.75, 0.55, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.08, 0.08, 0.5, 12]} />
          <meshStandardMaterial color="#e2e8f0" metalness={0.9} roughness={0.2} />
        </mesh>
        <mesh position={[0.25, 0, 0]}>
          <boxGeometry args={[0.08, 1.3, 0.18]} />
          <meshStandardMaterial color="#f59e0b" />
        </mesh>
      </group>
    </group>
  );
}

function Driver() {
  return (
    <group>
      <mesh position={[0, 0.14, 0]} castShadow>
        <boxGeometry args={[2.8, 0.12, 2.8]} />
        <meshStandardMaterial color="#9f1239" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.5, -0.3]} castShadow>
        <boxGeometry args={[1.6, 0.6, 1]} />
        <meshStandardMaterial color="#20262f" metalness={0.7} roughness={0.4} />
      </mesh>
    </group>
  );
}

function Ultrasonic() {
  return (
    <group>
      <mesh position={[0, 0.14, 0]} castShadow>
        <boxGeometry args={[2.6, 0.1, 1.4]} />
        <meshStandardMaterial color="#1d4ed8" roughness={0.5} />
      </mesh>
      {[-0.7, 0.7].map((x) => (
        <mesh key={x} position={[x, 0.42, -0.1]} castShadow>
          <cylinderGeometry args={[0.46, 0.46, 0.5, 28]} />
          <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.25} />
        </mesh>
      ))}
    </group>
  );
}

function CustomBody({ part }: { part: Part }) {
  if (drawnByPackage(part)) return <PackageBody part={part} />;
  return <VisualBody part={part} />;
}

function VisualBody({ part }: { part: Part }) {
  const moving = useRef<Array<THREE.Mesh | null>>([]);
  const visual = part.custom?.visual ?? [];
  const actuator = part.custom?.actuator;
  useFrame((_, dt) => {
    const run = circuit();
    if (!run) return;
    const value = run.outputs.get(part.id) ?? actuator?.min ?? 0;
    for (const mesh of moving.current) {
      if (!mesh) continue;
      if (actuator?.quantity === 'angle') {
        const target = THREE.MathUtils.degToRad(value - (actuator.min + actuator.max) / 2);
        mesh.rotation.y = THREE.MathUtils.damp(mesh.rotation.y, target, 8, dt);
      } else if (run.isRunning(part) && runner.running) {
        const rate = actuator?.quantity === 'speed' ? value / (actuator.max || 1) : 1;
        mesh.rotation.y += dt * 3 * rate * runner.speed;
      }
    }
  });
  if (!visual.length) {
    return (
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[2, 0.5, 1.4]} />
        <meshStandardMaterial color="#3d4d6e" roughness={0.5} />
      </mesh>
    );
  }
  return (
    <group>
      {visual.map((v, i) => (
        <mesh key={i} ref={(m) => (moving.current[i] = v.moves ? m : null)} position={v.at as [number, number, number]} castShadow>
          {v.shape === 'box' && <boxGeometry args={v.size as [number, number, number]} />}
          {v.shape === 'cylinder' && <cylinderGeometry args={[v.size[0] / 2, v.size[0] / 2, v.size[1], 28]} />}
          {v.shape === 'sphere' && <sphereGeometry args={[v.size[0] / 2, 24, 16]} />}
          <meshStandardMaterial color={v.color} roughness={0.5} metalness={0.25} />
        </mesh>
      ))}
    </group>
  );
}

function PartBody({ part }: { part: Part }) {
  switch (part.type) {
    case 'custom':
      return <CustomBody part={part} />;
    case 'arduino':
      return <Board />;
    case 'led':
      return <Led part={part} />;
    case 'resistor':
      return <Resistor part={part} />;
    case 'motor':
      return <Motor part={part} />;
    case 'motor_driver':
      return <Driver />;
    case 'ultrasonic':
      return <Ultrasonic />;
    case 'battery':
      return (
        <mesh position={[0, 0.5, 0]} castShadow>
          <boxGeometry args={[1.8, 1, 1.2]} />
          <meshStandardMaterial color="#1f2937" roughness={0.45} />
        </mesh>
      );
    case 'button':
    case 'switch':
      return (
        <group>
          <mesh position={[0, 0.16, 0]} castShadow>
            <boxGeometry args={[0.9, 0.3, 0.9]} />
            <meshStandardMaterial color="#27303d" />
          </mesh>
          <mesh position={[0, 0.38, 0]}>
            <cylinderGeometry args={[0.26, 0.26, 0.2, 20]} />
            <meshStandardMaterial color={part.type === 'switch' ? '#f8fafc' : '#e11d48'} />
          </mesh>
        </group>
      );
    case 'capacitor':
      return (
        <group>
          <mesh position={[0, 0.55, 0]} castShadow>
            <cylinderGeometry args={[0.38, 0.38, 0.9, 24]} />
            <meshStandardMaterial color="#1e3a8a" roughness={0.4} />
          </mesh>
          <mesh position={[0.3, 0.55, 0]}>
            <boxGeometry args={[0.14, 0.86, 0.3]} />
            <meshStandardMaterial color="#cbd5e1" />
          </mesh>
          <mesh position={[0, 0.12, 0]}>
            <boxGeometry args={[2, 0.05, 0.06]} />
            <meshStandardMaterial color="#c8d0da" metalness={0.8} roughness={0.3} />
          </mesh>
        </group>
      );
    case 'diode':
    case 'pot':
    case 'ldr':
    case 'thermistor':
    case 'npn':
    case 'pnp':
    case 'nmos':
    case 'pmos':
      return <SmallPart part={part} />;
    case 'seven_segment':
      return <SevenSegment part={part} />;
    case 'buzzer':
      return (
        <mesh position={[0, 0.34, 0]} castShadow>
          <cylinderGeometry args={[0.6, 0.6, 0.65, 28]} />
          <meshStandardMaterial color="#14171f" roughness={0.4} />
        </mesh>
      );
  }
}

function FaultRing({ part, size: given }: { part: Part; size?: number }) {
  const ring = useRef<THREE.Mesh>(null!);
  const material = useRef<THREE.MeshBasicMaterial>(null!);
  const size = given ?? (part.type === 'arduino' ? 4.8 : part.type === 'motor_driver' ? 2.1 : 1.5);
  useFrame(({ clock }) => {
    const run = circuit();
    const selected = useStore.getState().selected === part.id;
    const broken = Boolean(run?.burned.has(part.id) || run?.shorted.has(part.id));
    const stressed = (run?.readings.get(part.id)?.load ?? 0) > 1;
    ring.current.visible = broken || stressed || selected;
    material.current.color.set(broken ? '#ff3b4e' : stressed ? '#ffb347' : '#22d3ee');
    ring.current.scale.setScalar(broken ? 1 + ((clock.elapsedTime * 0.8) % 1) * 0.35 : 1);
  });
  return (
    <mesh ref={ring} position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
      <ringGeometry args={[size * 0.9, size, 44]} />
      <meshBasicMaterial ref={material} toneMapped={false} transparent opacity={0.9} />
    </mesh>
  );
}

type Ends = (i: number) => { a: THREE.Vector3; b: THREE.Vector3; color: string; low?: boolean } | null;

function Wires({ spec, ends }: { spec: CircuitSpec; ends: Ends }) {
  const dots = useRef<THREE.InstancedMesh>(null!);
  const phase = useRef(0);
  const DOTS = 4;

  const curves = useMemo(
    () =>
      spec.wires.map((_, i) => {
        const end = ends(i);
        if (!end) return null;
        const { a, b, color, low } = end;
        // Breadboard jumpers stay low, even long ones between boards, so a big build reads as wiring rather than a canopy.
        const height = low ? 0.32 + Math.min(1.1, a.distanceTo(b) * 0.07) : 0.9 + a.distanceTo(b) * 0.16;
        const curve = low
          ? new THREE.CubicBezierCurve3(a, a.clone().setY(height), b.clone().setY(height), b)
          : new THREE.QuadraticBezierCurve3(a, a.clone().lerp(b, 0.5).setY(height), b);
        return { curve, color, geometry: new THREE.TubeGeometry(curve, 28, low ? 0.035 : 0.05, 6) };
      }),
    [spec, ends],
  );

  useFrame((_, dt) => {
    const run = circuit();
    if (!run) return;
    if (runner.running) phase.current += dt * runner.speed;
    let n = 0;
    curves.forEach((c, i) => {
      if (!c) return;
      const amps = run.wireAmps[i] ?? 0;
      if (Math.abs(amps) < 0.0005) return;
      const speed = Math.min(1.4, 0.25 + Math.abs(amps) * 8) * Math.sign(amps);
      for (let d = 0; d < DOTS; d++) {
        const t = (((phase.current * speed + d / DOTS) % 1) + 1) % 1;
        dummy.position.copy(c.curve.getPoint(t));
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        dots.current.setMatrixAt(n++, dummy.matrix);
      }
    });
    dots.current.count = n;
    dots.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      {curves.map((c, i) =>
        c ? (
          <mesh key={i} geometry={c.geometry} onClick={pick(`W${i + 1}`)} castShadow>
            <meshStandardMaterial color={c.color} roughness={0.45} />
          </mesh>
        ) : null,
      )}
      <instancedMesh ref={dots} args={[undefined, undefined, Math.max(1, spec.wires.length * DOTS)]} frustumCulled={false}>
        <sphereGeometry args={[0.07, 8, 8]} />
        <meshBasicMaterial color="#fff7d6" toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

function liveText(run: CircuitRun, part: Part) {
  if (part.type === 'switch' || part.type === 'button') {
    const on = (run.values.get(part.id) ?? 0) >= 0.5;
    return part.type === 'switch' ? (on ? 'ON' : 'OFF') : on ? 'pressed' : '';
  }
  if (part.type === 'seven_segment') return run.glyph(part);
  const sensor = sensorOf(part);
  if (sensor) {
    const value = run.read(part.id);
    return Number.isNaN(value) ? 'no reading' : withUnit(value, sensor.unit);
  }
  const actuator = part.custom?.actuator;
  if (actuator?.quantity === 'text') return run.isPowered(part) ? (run.texts.get(part.id) ?? '') : '';
  if (actuator) return `${Math.round(run.outputs.get(part.id) ?? actuator.min)}${actuator.quantity === 'angle' ? '°' : ''}`;
  if (part.type === 'motor') return `${Math.round(Math.abs(run.speeds.get(part.id) ?? 0) * 100)}% speed`;
  if (part.type === 'capacitor') return `${(run.capVolts.get(part.id) ?? 0).toFixed(1)} V`;
  if (part.type === 'arduino' && run.boardOn.get(part.id) === false) return 'browned out';
  return '';
}

const hasLiveValue = (part: Part) => Boolean(sensorOf(part) || part.custom?.actuator) || ['motor', 'capacitor', 'arduino', 'seven_segment'].includes(part.type);

function LiveTag({ part, y }: { part: Part; y: number }) {
  const label = useRef<HTMLDivElement>(null);
  const screen = part.custom?.actuator?.quantity === 'text';
  useFrame(() => {
    const run = circuit();
    const element = label.current;
    if (!run || !element) return;
    const text = liveText(run, part);
    if (element.textContent !== text) element.textContent = text;
    element.style.display = text ? '' : 'none';
  });
  return (
    <Html position={[0, y, 0]} center zIndexRange={[10, 0]}>
      <div ref={label} className={screen ? 'scene-tag screen-tag' : 'scene-tag'} style={{ ['--tag' as string]: screen ? '#86efac' : '#7dd3fc', display: 'none' }} />
    </Html>
  );
}

const describePart = (part: Part) => {
  if (part.type === 'resistor') return `${part.id} ${part.ohms ?? 1000} Ω`;
  if (part.type === 'battery') return `${part.id} ${part.volts ?? 9} V`;
  if (part.type === 'capacitor') return `${part.id} ${Math.round((part.farads ?? 1e-4) * 1e6)} µF`;
  return part.custom?.label ?? part.id;
};

const HISTORY = 240;
const SAMPLE_TICKS = 3;

function Trace({ values, min, max, target }: { values: number[]; min: number; max: number; target?: { min: number; max: number } }) {
  const span = max - min || 1;
  const y = (v: number) => 38 - ((v - min) / span) * 36;
  const points = values.map((v, i) => `${(i / (HISTORY - 1)) * 180},${y(v)}`).join(' ');
  return (
    <svg viewBox="0 0 180 40" className="world-trace" aria-hidden>
      {target && <rect x="0" y={y(target.max)} width="180" height={Math.max(1, y(target.min) - y(target.max))} className="world-band" />}
      {values.length > 1 && <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function WorldPanel({ spec }: { spec: CircuitSpec }) {
  const history = useRef(new Map<string, number[]>());
  const last = useRef(-SAMPLE_TICKS);
  const [, redraw] = useState(0);
  useFrame(() => {
    const run = circuit();
    if (!run) return;
    if (run.tick < last.current) {
      history.current.clear();
      last.current = -SAMPLE_TICKS;
    }
    if (run.tick - last.current < SAMPLE_TICKS) return;
    last.current = run.tick;
    for (const q of spec.world ?? []) {
      const list = history.current.get(q.id) ?? [];
      list.push(run.world.get(q.id) ?? q.start);
      if (list.length > HISTORY) list.shift();
      history.current.set(q.id, list);
    }
    redraw((n) => n + 1);
  });
  const run = circuit();
  return (
    <Html fullscreen calculatePosition={(_, __, size) => [size.width / 2, size.height / 2]} zIndexRange={[8, 0]} style={{ pointerEvents: 'none' }}>
      <div className="world-panel">
        {(spec.world ?? []).map((q) => {
          const value = run?.world.get(q.id) ?? q.start;
          const off = q.target && (value < q.target.min || value > q.target.max);
          return (
            <div key={q.id} className="world-row" data-off={off ? 'true' : undefined}>
              <div className="world-head">
                <span>{q.label}</span>
                <strong>{withUnit(value, q.unit)}</strong>
              </div>
              <Trace values={history.current.get(q.id) ?? []} min={q.min} max={q.max} target={q.target} />
              {q.target && (
                <span className="world-target">
                  target {q.target.min}–{withUnit(q.target.max, q.unit)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Html>
  );
}

function Decorations({
  part,
  at,
  size,
  y,
  quiet,
  crowded,
}: {
  part: Part;
  at: THREE.Vector3 | [number, number, number];
  size?: number;
  y?: number;
  quiet?: boolean;
  crowded?: boolean;
}) {
  const position: [number, number, number] = Array.isArray(at) ? at : [at.x, 0, at.z];
  const tagY = y ?? (part.type === 'arduino' ? 1.4 : 1.35);
  // On a crowded board only chips keep a tag, and just their part number; a switch's lever and an LED's glow already show their state.
  const text = crowded ? (part.type === 'custom' ? describePart(part).split(' ')[0] : null) : describePart(part);
  return (
    <group position={position}>
      <FaultRing part={part} size={size} />
      {!quiet && text && <Tag text={text} tint={part.type === 'arduino' || part.package === 'module' ? '#22d3ee' : '#ffb347'} y={tagY} />}
      {hasLiveValue(part) && !(crowded && (part.type === 'switch' || part.type === 'led' || part.type === 'button')) && <LiveTag part={part} y={tagY + 0.6} />}
      <ClaimPin id={part.id} position={[0, 0.5, 0]} />
    </group>
  );
}

const toggleInput = (part: Part) => {
  const run = circuit();
  if ((part.type === 'switch' || part.type === 'button') && run && !run.burned.has(part.id)) {
    runner.inject({ type: 'set_reading', target: part.id, value: (run.values.get(part.id) ?? 0) >= 0.5 ? 0 : 1 });
  }
};

function Lead({ a, b, color }: { a: THREE.Vector3; b: THREE.Vector3; color: string }) {
  const geometry = useMemo(() => {
    const mid = a.clone().lerp(b, 0.5);
    mid.y = 0.9 + a.distanceTo(b) * 0.12;
    return new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 24, 0.045, 6);
  }, [a, b]);
  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial color={color} roughness={0.45} />
    </mesh>
  );
}

function BreadboardScene({ spec }: { spec: CircuitSpec }) {
  const layout = useMemo<BoardLayout>(() => layoutBreadboard(spec), [spec]);
  const offPin = (key: string) => {
    const [id, pin] = key.split('.');
    const part = spec.parts.find((p) => p.id === id);
    const at = layout.offBoard.get(id);
    return part && at ? pinPosition(part, pin, at) : new THREE.Vector3();
  };
  const point = (end: Spot | string) => (typeof end === 'string' ? offPin(end) : spotPosition(layout, end, 0.2));
  const ends = useMemo<Ends>(
    () => (i) => {
      const pair = layout.wireEnds[i];
      if (!pair) return null;
      const wire = spec.wires[i];
      const offBoard = typeof pair[0] === 'string' || typeof pair[1] === 'string';
      return { a: point(pair[0]), b: point(pair[1]), color: jumperColor(wire.from, wire.to, i, layout, pair), low: !offBoard };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, spec],
  );
  // The supply's leads clip onto the left end of each rail it feeds.
  const leads = useMemo(() => {
    const { find } = netsOf(spec);
    const offKeys = spec.parts.filter((p) => layout.offBoard.has(p.id)).flatMap((p) => pinsOf(p).map((pin) => `${p.id}.${pin}`));
    return [...layout.supply.entries()].flatMap(([net, rail]) => {
      const key = offKeys.find((k) => find(k) === find(net));
      if (!key) return [];
      return (['top', 'bottom'] as const)
        .filter((side) => layout.railsUsed.has(`${side}${rail}`))
        .map((side) => ({ a: offPin(key), b: spotPosition(layout, { kind: 'rail', col: 0, side, rail }, 0.2), color: rail === '+' ? '#ef4444' : '#1f2937' }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, spec]);
  return (
    <group>
      <BoardParts
        spec={spec}
        layout={layout}
        onPart={toggleInput}
        decorate={(part, at, size) => (
          <Decorations
            part={part}
            at={at}
            size={size}
            y={part.type === 'custom' ? 1.1 : 0.95}
            quiet={part.type === 'resistor' || part.type === 'capacitor'}
            crowded={spec.parts.length > 40}
          />
        )}
      />
      {spec.parts
        .filter((p) => layout.offBoard.has(p.id))
        .map((part) => {
          const at = layout.offBoard.get(part.id)!;
          return (
            <group key={part.id}>
              <group position={[at[0], 0, at[1]]} onClick={pick(part.id)}>
                <PartBody part={part} />
              </group>
              <Decorations part={part} at={[at[0], 0, at[1]]} />
            </group>
          );
        })}
      <Wires spec={spec} ends={ends} />
      {leads.map((l, i) => (
        <Lead key={i} {...l} />
      ))}
    </group>
  );
}

export function Bench() {
  useStore((s) => s.structure);
  const run = circuit();
  const spec = useMemo(() => (run ? ({ ...run.spec } as CircuitSpec) : null), [run, useStore.getState().structure]);
  const positions = useMemo(() => (spec ? layoutParts(spec) : new Map<string, [number, number]>()), [spec]);
  const ends = useMemo<Ends>(
    () => (i) => {
      if (!spec) return null;
      const wire = spec.wires[i];
      const end = (key: string) => {
        const [id, pin] = key.split('.');
        const part = spec.parts.find((p) => p.id === id);
        const at = positions.get(id);
        return part && at ? pinPosition(part, pin, at) : new THREE.Vector3();
      };
      return { a: end(wire.from), b: end(wire.to), color: wireColor(wire.from, wire.to, i) };
    },
    [spec, positions],
  );
  if (!spec) return null;
  const { width, depth, centerX, centerZ } = benchExtent(spec);
  return (
    <group position={[-centerX, 0, -centerZ]}>
      <Floor position={[centerX, 0, centerZ]} width={width + 4} depth={depth + 4} cell={0.5} section={2.5} color={LOOK.bench} roughness={0.75} metalness={0.15} fade={90} />
      {spec.layout === 'breadboard' ? (
        <BreadboardScene spec={spec} />
      ) : (
        <>
          {spec.parts.map((part) => {
            const at = positions.get(part.id) ?? [0, 0];
            return (
              <group key={part.id}>
                <group
                  position={[at[0], 0, at[1]]}
                  onClick={(e) => {
                    pick(part.id)(e);
                    toggleInput(part);
                  }}
                >
                  <PartBody part={part} />
                </group>
                <Decorations part={part} at={[at[0], 0, at[1]]} size={part.package === 'module' || part.package === 'dip' ? dipSpan(part).length / 2 + 0.6 : undefined} />
              </group>
            );
          })}
          <Wires spec={spec} ends={ends} />
        </>
      )}
      {spec.world?.length ? <WorldPanel key={useStore.getState().environmentKey} spec={spec} /> : null}
    </group>
  );
}
