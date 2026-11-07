import { useFrame } from '@react-three/fiber';
import { dipRows, pinsOf, type CircuitRun, type Part } from '@tv/core';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';

// One renderer per physical package, so any chip, board or module the Architect names is drawn from its pin count and label.
const circuit = () => runner.run as CircuitRun | null;
export const PITCH = 0.3;
const METAL = { color: '#c8d0da', metalness: 0.85, roughness: 0.3 };

const DRAWN = new Set(['dip', 'module', 'to92', 'to220', 'axial', 'radial', 'bulb', 'display', 'pot', 'relay', 'speaker', 'sensor']);
export const drawnByPackage = (part: Part) => Boolean(part.package && DRAWN.has(part.package)) && !(part.package === 'motor');

export { dipRows };

export function dipSpan(part: Part) {
  const { half } = dipRows(part);
  const wide = part.package === 'module';
  return { length: half * PITCH, width: wide ? Math.max(1.2, Math.min(2.4, half * 0.12 + 0.8)) : 0.75 };
}

// Where each pin sits relative to the part's centre, for wires on the bench.
export function packagePin(part: Part, pin: string): [number, number, number] | null {
  if (part.package !== 'dip' && part.package !== 'module') return null;
  const { near, far, half } = dipRows(part);
  const { width } = dipSpan(part);
  const ni = near.indexOf(pin);
  const fi = far.indexOf(pin);
  const x = (i: number) => (i - (half - 1) / 2) * PITCH;
  if (ni >= 0) return [x(ni), 0.22, width / 2 + 0.05];
  if (fi >= 0) return [x(fi), 0.22, -width / 2 - 0.05];
  return [0, 0.22, 0];
}

// The part number printed on the package: the first word that looks like one ("74HC08", "NE555"), else the label's first word.
function markingOf(part: Part) {
  const label = part.custom?.label ?? part.id;
  return (label.match(/[A-Z]{0,4}\d{2,}[A-Z0-9-]*/i)?.[0] ?? label.split(/\s+/)[0]).toUpperCase().slice(0, 12);
}

const markings = new Map<string, THREE.CanvasTexture>();
function markingTexture(text: string, color: string) {
  const key = `${text}|${color}`;
  let texture = markings.get(key);
  if (texture) return texture;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = color;
    ctx.font = 'bold 72px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 68, 492);
  }
  texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  markings.set(key, texture);
  return texture;
}

function Marking({ part, width, depth, y, color = '#c9ced6' }: { part: Part; width: number; depth: number; y: number; color?: string }) {
  const texture = useMemo(() => markingTexture(markingOf(part), color), [part, color]);
  const w = Math.min(width * 0.9, depth * 4 * 0.9);
  return (
    <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[w, w / 4]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

function Dip({ part }: { part: Part }) {
  const { near, far, half } = dipRows(part);
  const { length, width } = dipSpan(part);
  const x = (i: number) => (i - (half - 1) / 2) * PITCH;
  return (
    <group>
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[length + 0.1, 0.22, width - 0.1]} />
        <meshStandardMaterial color="#16181d" roughness={0.55} />
      </mesh>
      <mesh position={[-length / 2 + 0.02, 0.415, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.09, 16, -Math.PI / 2, Math.PI]} />
        <meshStandardMaterial color="#2b2f38" />
      </mesh>
      <mesh position={[-length / 2 + 0.22, 0.415, width / 2 - 0.2]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.04, 12]} />
        <meshStandardMaterial color="#9aa3b2" />
      </mesh>
      <Marking part={part} width={length} depth={width - 0.1} y={0.413} />
      {[...near.map((_, i) => [x(i), 1] as const), ...far.map((_, i) => [x(i), -1] as const)].map(([px, side], i) => (
        <mesh key={i} position={[px, 0.18, (side * width) / 2]}>
          <boxGeometry args={[0.07, 0.28, 0.12]} />
          <meshStandardMaterial {...METAL} />
        </mesh>
      ))}
    </group>
  );
}

function Module({ part }: { part: Part }) {
  const { near, far, half } = dipRows(part);
  const { length, width } = dipSpan(part);
  const x = (i: number) => (i - (half - 1) / 2) * PITCH;
  const label = (part.custom?.label ?? '').toLowerCase();
  const pcb = /pico|rp2040/.test(label) ? '#0f5c2e' : /xiao|seeed/.test(label) ? '#101418' : /esp/.test(label) ? '#141a24' : '#0f3d6e';
  return (
    <group>
      <mesh position={[0, 0.38, 0]} castShadow>
        <boxGeometry args={[length + 0.2, 0.08, width]} />
        <meshStandardMaterial color={pcb} roughness={0.5} metalness={0.2} />
      </mesh>
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[Math.min(length * 0.45, 1.4), 0.14, Math.min(width * 0.45, 0.9)]} />
        <meshStandardMaterial color="#b8c1cc" metalness={0.85} roughness={0.25} />
      </mesh>
      <group position={[0, 0, width * 0.3]}>
        <Marking
          part={{ ...part, custom: part.custom && { ...part.custom, label: part.custom.label.replace(/^seeed\s+studio\s+|^seeed\s+/i, '') } }}
          width={length}
          depth={width * 0.3}
          y={0.425}
          color="#f1f5f9"
        />
      </group>
      <mesh position={[-length / 2 - 0.02, 0.48, 0]} castShadow>
        <boxGeometry args={[0.32, 0.14, 0.42]} />
        <meshStandardMaterial color="#d7dde5" metalness={0.9} roughness={0.2} />
      </mesh>
      {[...near.map((_, i) => [x(i), 1] as const), ...far.map((_, i) => [x(i), -1] as const)].map(([px, side], i) => (
        <group key={i} position={[px, 0, (side * (width - 0.16)) / 2]}>
          <mesh position={[0, 0.2, 0]}>
            <boxGeometry args={[0.07, 0.34, 0.07]} />
            <meshStandardMaterial {...METAL} />
          </mesh>
          <mesh position={[0, 0.43, 0]}>
            <cylinderGeometry args={[0.07, 0.07, 0.02, 12]} />
            <meshStandardMaterial color="#e2b84a" metalness={0.9} roughness={0.25} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function To92() {
  return (
    <group>
      <mesh position={[0, 0.55, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
        <cylinderGeometry args={[0.24, 0.24, 0.36, 24, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color="#14161b" roughness={0.5} side={THREE.DoubleSide} />
      </mesh>
      {[-1, 0, 1].map((i) => (
        <mesh key={i} position={[i * PITCH * 0.9, 0.2, 0]}>
          <boxGeometry args={[0.05, 0.4, 0.05]} />
          <meshStandardMaterial {...METAL} />
        </mesh>
      ))}
    </group>
  );
}

function To220() {
  return (
    <group>
      <mesh position={[0, 0.75, 0]} castShadow>
        <boxGeometry args={[0.95, 0.85, 0.2]} />
        <meshStandardMaterial color="#14161b" roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.3, -0.06]} castShadow>
        <boxGeometry args={[0.95, 0.5, 0.06]} />
        <meshStandardMaterial color="#b8c1cc" metalness={0.9} roughness={0.25} />
      </mesh>
      {[-1, 0, 1].map((i) => (
        <mesh key={i} position={[i * PITCH, 0.2, 0]}>
          <boxGeometry args={[0.07, 0.42, 0.04]} />
          <meshStandardMaterial {...METAL} />
        </mesh>
      ))}
    </group>
  );
}

function Bulb({ part }: { part: Part }) {
  const glass = useRef<THREE.MeshStandardMaterial>(null!);
  const light = useRef<THREE.PointLight>(null!);
  useFrame(() => {
    const run = circuit();
    const level = run && !run.burned.has(part.id) ? run.levelOf(part) : 0;
    glass.current.emissiveIntensity = level * 4;
    light.current.intensity = level * 6;
  });
  return (
    <group>
      <mesh position={[0, 0.22, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.26, 0.3, 20]} />
        <meshStandardMaterial color="#b8c1cc" metalness={0.85} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.66, 0]} castShadow>
        <sphereGeometry args={[0.4, 24, 18]} />
        <meshStandardMaterial ref={glass} color="#fff4cc" emissive="#ffcf6b" emissiveIntensity={0} transparent opacity={0.85} roughness={0.1} toneMapped={false} />
      </mesh>
      <pointLight ref={light} position={[0, 0.7, 0]} color="#ffcf6b" distance={4} intensity={0} />
    </group>
  );
}

function Display({ part }: { part: Part }) {
  const screen = useRef<THREE.MeshStandardMaterial>(null!);
  const label = (part.custom?.label ?? '').toLowerCase();
  const segment = /seg/.test(label);
  const oled = /oled/.test(label);
  useFrame(() => {
    const run = circuit();
    screen.current.emissiveIntensity = run?.isPowered(part) && !run.burned.has(part.id) ? 1.2 : 0.05;
  });
  const size: [number, number] = segment ? [0.8, 1.1] : oled ? [1.1, 0.7] : [2.4, 0.8];
  const glow = segment ? '#ff3b3b' : oled ? '#7dd3fc' : '#9ae66e';
  return (
    <group>
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[size[0] + 0.3, 0.12, size[1] + 0.35]} />
        <meshStandardMaterial color={segment ? '#16181d' : '#0f4c81'} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.37, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={size} />
        <meshStandardMaterial ref={screen} color="#0a0f0a" emissive={glow} emissiveIntensity={0.05} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Pot() {
  return (
    <group>
      <mesh position={[0, 0.25, 0]} castShadow>
        <boxGeometry args={[0.8, 0.3, 0.8]} />
        <meshStandardMaterial color="#1d4ed8" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.55, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.18, 0.4, 20]} />
        <meshStandardMaterial color="#e5e7eb" metalness={0.6} roughness={0.3} />
      </mesh>
    </group>
  );
}

function Relay() {
  return (
    <group>
      <mesh position={[0, 0.16, 0]} castShadow>
        <boxGeometry args={[1.6, 0.08, 1.1]} />
        <meshStandardMaterial color="#0f3d6e" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[0.9, 0.6, 0.7]} />
        <meshStandardMaterial color="#1e63d6" roughness={0.4} />
      </mesh>
      <mesh position={[0.62, 0.32, 0]} castShadow>
        <boxGeometry args={[0.3, 0.26, 0.9]} />
        <meshStandardMaterial color="#1f9d55" roughness={0.5} />
      </mesh>
    </group>
  );
}

function Speaker() {
  return (
    <group>
      <mesh position={[0, 0.3, 0]} castShadow>
        <cylinderGeometry args={[0.55, 0.55, 0.5, 28]} />
        <meshStandardMaterial color="#14171f" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.56, 0]}>
        <cylinderGeometry args={[0.1, 0.1, 0.02, 16]} />
        <meshStandardMaterial color="#3a3f4a" />
      </mesh>
    </group>
  );
}

function SensorBoard({ part }: { part: Part }) {
  const pins = pinsOf(part).length;
  return (
    <group>
      <mesh position={[0, 0.2, 0]} castShadow>
        <boxGeometry args={[Math.max(1, pins * PITCH + 0.3), 0.08, 1]} />
        <meshStandardMaterial color="#6d28d9" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.34, -0.1]} castShadow>
        <boxGeometry args={[0.5, 0.2, 0.5]} />
        <meshStandardMaterial color="#e5e7eb" roughness={0.4} />
      </mesh>
    </group>
  );
}

function Axial() {
  return (
    <group>
      <mesh position={[0, 0.2, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.13, 0.13, 0.6, 16]} />
        <meshStandardMaterial color="#1a1c22" roughness={0.4} />
      </mesh>
      <mesh position={[0.22, 0.2, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.135, 0.135, 0.08, 16]} />
        <meshStandardMaterial color="#cbd5e1" />
      </mesh>
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[1.6, 0.04, 0.04]} />
        <meshStandardMaterial {...METAL} />
      </mesh>
    </group>
  );
}

function Radial() {
  return (
    <group>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.3, 0.8, 24]} />
        <meshStandardMaterial color="#1e3a8a" roughness={0.4} />
      </mesh>
      <mesh position={[0.24, 0.5, 0]}>
        <boxGeometry args={[0.12, 0.76, 0.22]} />
        <meshStandardMaterial color="#cbd5e1" />
      </mesh>
    </group>
  );
}

export function PackageBody({ part }: { part: Part }) {
  switch (part.package) {
    case 'dip':
      return <Dip part={part} />;
    case 'module':
      return <Module part={part} />;
    case 'to92':
      return <To92 />;
    case 'to220':
      return <To220 />;
    case 'axial':
      return <Axial />;
    case 'radial':
      return <Radial />;
    case 'bulb':
      return <Bulb part={part} />;
    case 'display':
      return <Display part={part} />;
    case 'pot':
      return <Pot />;
    case 'relay':
      return <Relay />;
    case 'speaker':
      return <Speaker />;
    case 'sensor':
      return <SensorBoard part={part} />;
    default:
      return null;
  }
}

// Segment bars laid out as on a real display: [x, z, horizontal].
const SEGMENT_BARS: Record<string, [number, number, boolean]> = {
  a: [0, -0.42, true],
  b: [0.2, -0.21, false],
  c: [0.2, 0.21, false],
  d: [0, 0.42, true],
  e: [-0.2, 0.21, false],
  f: [-0.2, -0.21, false],
  g: [0, 0, true],
};

export function SevenSegment({ part }: { part: Part }) {
  const mats = useRef<Record<string, THREE.MeshStandardMaterial | null>>({});
  useFrame(() => {
    const run = circuit();
    const lit = new Set<string>(run?.litSegments(part) ?? []);
    for (const [seg, m] of Object.entries(mats.current)) if (m) m.emissiveIntensity = lit.has(seg) ? 3 : 0.04;
  });
  return (
    <group>
      <mesh position={[0, 0.32, 0]} castShadow>
        <boxGeometry args={[0.8, 0.24, 1.15]} />
        <meshStandardMaterial color="#111316" roughness={0.6} />
      </mesh>
      {Object.entries(SEGMENT_BARS).map(([seg, [x, z, flat]]) => (
        <mesh key={seg} position={[x, 0.445, z]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={flat ? [0.32, 0.07] : [0.07, 0.34]} />
          <meshStandardMaterial ref={(m) => (mats.current[seg] = m)} color="#2a0b0b" emissive="#ff2a2a" emissiveIntensity={0.04} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

export function SmallPart({ part }: { part: Part }) {
  switch (part.type) {
    case 'diode':
      return <Axial />;
    case 'pot':
      return <Pot />;
    case 'ldr':
      return (
        <group>
          <mesh position={[0, 0.42, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.2, 0.2, 0.08, 20]} />
            <meshStandardMaterial color="#c2410c" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.42, -0.045]}>
            <planeGeometry args={[0.26, 0.06]} />
            <meshStandardMaterial color="#fde68a" side={THREE.DoubleSide} />
          </mesh>
        </group>
      );
    case 'thermistor':
      return (
        <mesh position={[0, 0.4, 0]} castShadow>
          <sphereGeometry args={[0.12, 16, 12]} />
          <meshStandardMaterial color="#1e40af" roughness={0.4} />
        </mesh>
      );
    default:
      return null;
  }
}
