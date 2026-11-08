import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { reducedMotion } from '../motion';
import { runner } from '../runner';

// Building blocks for the models the views draw: shared materials and small, recognisable pieces (people, vehicles, roofs, windows).
// Everything stands on y = 0 and is sized in metres-ish scene units, so pieces combine without fiddling.

const materials = new Map<string, THREE.MeshStandardMaterial>();

interface Finish {
  metal?: number;
  rough?: number;
  /** Emissive colour; with glow above 1 it blooms. */
  emissive?: string;
  glow?: number;
  opacity?: number;
}

/** One shared material per colour and finish, so a scene of many models stays cheap. */
export function mat(color: string, { metal = 0.1, rough = 0.6, emissive, glow = 1, opacity = 1 }: Finish = {}) {
  const key = `${color}|${metal}|${rough}|${emissive}|${glow}|${opacity}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    if (emissive) {
      m.emissive.set(emissive);
      m.emissiveIntensity = glow;
      m.toneMapped = glow <= 1;
    }
    materials.set(key, m);
  }
  return m;
}

// A small palette of real-world finishes; a model's own tint is reserved for its accents
export const FINISH = {
  concrete: () => mat('#8b9099', { rough: 0.9 }),
  plaster: () => mat('#c9ccd2', { rough: 0.85 }),
  steel: () => mat('#a3abb6', { metal: 0.7, rough: 0.35 }),
  darkSteel: () => mat('#3b4048', { metal: 0.6, rough: 0.45 }),
  roof: () => mat('#4b5059', { rough: 0.8 }),
  white: () => mat('#eceef2', { rough: 0.5 }),
  glass: () => mat('#26313f', { metal: 0.3, rough: 0.1 }),
  window: () => mat('#2a2f37', { emissive: '#ffcf8a', glow: 1.3 }),
  screen: () => mat('#10151c', { emissive: '#8fd3ff', glow: 1.4 }),
  wood: () => mat('#9a7350', { rough: 0.85 }),
  rubber: () => mat('#16181c', { rough: 0.9 }),
  asphalt: () => mat('#24272d', { rough: 0.95 }),
  water: () => mat('#1d5a86', { metal: 0.2, rough: 0.08 }),
  grass: () => mat('#33503a', { rough: 1 }),
};

type V3 = [number, number, number];

export function Box({ size, at = [0, 0, 0], m, rot, shadow = true }: { size: V3; at?: V3; m: THREE.Material; rot?: V3; shadow?: boolean }) {
  return (
    <mesh position={at} rotation={rot} material={m} castShadow={shadow} receiveShadow>
      <boxGeometry args={size} />
    </mesh>
  );
}

export function Cyl({
  r,
  r2 = r,
  h,
  at = [0, 0, 0],
  m,
  seg = 20,
  rot,
  open = false,
}: {
  r: number;
  r2?: number;
  h: number;
  at?: V3;
  m: THREE.Material;
  seg?: number;
  rot?: V3;
  open?: boolean;
}) {
  return (
    <mesh position={at} rotation={rot} material={m} castShadow receiveShadow>
      <cylinderGeometry args={[r2, r, h, seg, 1, open]} />
    </mesh>
  );
}

/** A gable roof: a triangular prism along x. */
export function Gable({ w, d, h, at, m }: { w: number; d: number; h: number; at: V3; m: THREE.Material }) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, h)]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
    g.translate(0, 0, -w / 2);
    g.rotateY(Math.PI / 2);
    return g;
  }, [w, d, h]);
  return <mesh geometry={geometry} position={at} material={m} castShadow receiveShadow />;
}

/** A row of lit windows on a wall facing +z. */
export function Windows({ w, rows = 1, cols, at, gap = 0.34 }: { w: number; rows?: number; cols: number; at: V3; gap?: number }) {
  const panes: V3[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) panes.push([((c + 0.5) / cols - 0.5) * w, r * gap, 0]);
  return (
    <group position={at}>
      {panes.map((p, i) => (
        <mesh key={i} position={p} material={FINISH.window()}>
          <planeGeometry args={[(w / cols) * 0.55, 0.16]} />
        </mesh>
      ))}
    </group>
  );
}

const SKIN = ['#e0b896', '#c58c66', '#8d5a3b', '#f1cfb0'];
const CLOTHES = ['#3b6fb6', '#b6493b', '#4b8f5f', '#c8a24a', '#6b5fb0', '#d0d3d9', '#2f3a4a'];

/** A small standing person; vary `seed` for different clothes and skin. */
export function Person({ at = [0, 0, 0], seed = 0, coat, scale = 1, headset = false }: { at?: V3; seed?: number; coat?: string; scale?: number; headset?: boolean }) {
  return (
    <group position={at} scale={scale}>
      <mesh position={[0, 0.34, 0]} material={mat(coat ?? CLOTHES[seed % CLOTHES.length], { rough: 0.8 })} castShadow>
        <capsuleGeometry args={[0.12, 0.34, 4, 10]} />
      </mesh>
      <mesh position={[0, 0.72, 0]} material={mat(SKIN[(seed * 7) % SKIN.length], { rough: 0.7 })} castShadow>
        <sphereGeometry args={[0.1, 14, 10]} />
      </mesh>
      {headset && (
        <mesh position={[0, 0.76, 0]} rotation={[0, 0, Math.PI / 2]} material={FINISH.rubber()}>
          <torusGeometry args={[0.11, 0.018, 6, 16, Math.PI]} />
        </mesh>
      )}
    </group>
  );
}

/** A loose group of people standing around a point. */
export function Crowd({ count = 5, radius = 0.9, at = [0, 0, 0], seed = 0 }: { count?: number; radius?: number; at?: V3; seed?: number }) {
  const spots = useMemo(() => {
    const out: V3[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + seed;
      const r = radius * (0.35 + 0.65 * (((i * 37 + seed * 11) % 10) / 10));
      out.push([Math.cos(a) * r, 0, Math.sin(a) * r]);
    }
    return out;
  }, [count, radius, seed]);
  return (
    <group position={at}>
      {spots.map((p, i) => (
        <Person key={i} at={p} seed={seed + i} />
      ))}
    </group>
  );
}

export function Wheels({ length, width, r = 0.16, at = [0, 0, 0] }: { length: number; width: number; r?: number; at?: V3 }) {
  const spots: V3[] = [
    [-length / 2, r, -width / 2],
    [length / 2, r, -width / 2],
    [-length / 2, r, width / 2],
    [length / 2, r, width / 2],
  ];
  return (
    <group position={at}>
      {spots.map((p, i) => (
        <Cyl key={i} r={r} h={0.1} at={p} rot={[Math.PI / 2, 0, 0]} m={FINISH.rubber()} seg={14} />
      ))}
    </group>
  );
}

/** A box truck: cab and trailer along +x. */
export function Truck({ at = [0, 0, 0], rot = 0, tint = '#c8cdd6' }: { at?: V3; rot?: number; tint?: string }) {
  return (
    <group position={at} rotation={[0, rot, 0]}>
      <Box size={[1.5, 0.75, 0.62]} at={[-0.3, 0.6, 0]} m={mat(tint, { rough: 0.5 })} />
      <Box size={[0.5, 0.55, 0.6]} at={[0.75, 0.5, 0]} m={FINISH.white()} />
      <Box size={[0.04, 0.22, 0.5]} at={[1.0, 0.62, 0]} m={FINISH.glass()} />
      <Wheels length={1.4} width={0.6} at={[0.05, 0, 0]} />
    </group>
  );
}

/** A small airliner pointing along +x. */
export function Plane({ at = [0, 0, 0], rot = 0, scale = 1, tint = '#e9edf3' }: { at?: V3; rot?: number; scale?: number; tint?: string }) {
  const body = mat(tint, { rough: 0.4, metal: 0.2 });
  return (
    <group position={at} rotation={[0, rot, 0]} scale={scale}>
      <mesh position={[0, 0.45, 0]} rotation={[0, 0, Math.PI / 2]} material={body} castShadow>
        <capsuleGeometry args={[0.2, 1.8, 6, 14]} />
      </mesh>
      <Box size={[0.55, 0.05, 2.2]} at={[0.05, 0.4, 0]} m={body} />
      <Box size={[0.3, 0.04, 0.8]} at={[-0.95, 0.5, 0]} m={body} />
      <Box size={[0.32, 0.45, 0.04]} at={[-0.95, 0.75, 0]} m={mat('#c9472f', { rough: 0.5 })} />
      <Cyl r={0.08} h={0.35} at={[0.15, 0.3, 0.55]} rot={[0, 0, Math.PI / 2]} m={FINISH.darkSteel()} seg={12} />
      <Cyl r={0.08} h={0.35} at={[0.15, 0.3, -0.55]} rot={[0, 0, Math.PI / 2]} m={FINISH.darkSteel()} seg={12} />
    </group>
  );
}

/** Rising smoke or steam puffs above a point; they rise faster when the source works harder. */
export function Smoke({ at, tint = '#cfd3da', rate = () => 1 }: { at: V3; tint?: string; rate?: () => number }) {
  const puffs = useRef<Array<THREE.Mesh | null>>([]);
  const phase = useRef(0);
  // A little self-light keeps puffs reading as soft vapour rather than dark balls shaded from above
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 0.35, transparent: true, opacity: 0.35, roughness: 1, depthWrite: false }),
    [tint],
  );
  useFrame((_, dt) => {
    if (reducedMotion()) return;
    if (runner.running) phase.current += dt * 0.25 * (0.4 + rate()) * runner.speed;
    puffs.current.forEach((p, i) => {
      if (!p) return;
      const t = (phase.current + i / 4) % 1;
      p.position.set(Math.sin(i * 2.1) * 0.15 * t, t * 2.2, Math.cos(i * 1.3) * 0.15 * t);
      p.scale.setScalar(0.2 + t * 0.55);
      (p.material as THREE.MeshStandardMaterial).opacity = 0.4 * (1 - t);
    });
  });
  return (
    <group position={at}>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(m) => void (puffs.current[i] = m)} material={i === 0 ? material : material.clone()}>
          <sphereGeometry args={[0.5, 10, 8]} />
        </mesh>
      ))}
    </group>
  );
}

/** Spins its children around its local axis at a speed the caller decides each frame. */
export function Spinner({ axis = 'z', speed, children, at }: { axis?: 'x' | 'y' | 'z'; speed: () => number; children: ReactNode; at?: V3 }) {
  const group = useRef<THREE.Group>(null!);
  useFrame((_, dt) => {
    if (reducedMotion() || !runner.running) return;
    group.current.rotation[axis] += dt * speed() * runner.speed;
  });
  return (
    <group ref={group} position={at}>
      {children}
    </group>
  );
}

/** A light that blinks, for beacons, status LEDs and welding sparks. */
export function Blink({ at, color, size = 0.06, rate = 2, on = () => true }: { at: V3; color: string; size?: number; rate?: number; on?: () => boolean }) {
  const mesh = useRef<THREE.Mesh>(null!);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), toneMapped: false }), [color]);
  useFrame(({ clock }) => {
    const lit = on() && (reducedMotion() || Math.sin(clock.elapsedTime * rate * Math.PI * 2 + at[0] * 3) > -0.2);
    mesh.current.visible = lit;
  });
  return (
    <mesh ref={mesh} position={at} material={material}>
      <sphereGeometry args={[size, 8, 6]} />
    </mesh>
  );
}
