import { Edges, Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { Environment, NetNode, NetRun } from '@tv/core';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';

// An elevator bank drawn as a building cut open: glass floor slabs stacked up, glass shafts rising through them, and lit cars
// that load at the lobby, ride to a floor, let their riders step out onto the landing, and come back down.

// The run, but only while it is a flow run: switching designs can briefly leave another kind of run in place
const net = () => {
  const run = runner.run as NetRun | null;
  return run && 'links' in run && 'states' in run ? run : null;
};
export const FLOOR_HEIGHT = 1.15;
const MAX_DRAWN_FLOORS = 12;
const SHAFT_GAP = 1.3;
const MAX_CARS = 8;
const RIDERS = 4;

// The building's real floor count, read from what the user wrote ("a 30 floor office tower"); 10 when nothing says.
export function floorsOf(environment: Pick<Environment, 'name' | 'summary' | 'spec'> | null, node?: NetNode) {
  const text = [node?.label, environment?.name, environment?.summary, JSON.stringify(environment?.spec ?? {})].join(' ');
  const match = text.match(/(\d{1,3})[\s-]*(?:floors?|stor(?:e)?ys?|levels?)\b/i) ?? text.match(/\bfloors?\s*(\d{1,3})\b/i);
  const floors = match ? Number(match[1]) : 10;
  return Math.max(2, Math.min(200, floors));
}

export const drawnFloors = (floors: number) => Math.min(MAX_DRAWN_FLOORS, floors);
export const towerHeight = (floors: number) => drawnFloors(floors) * FLOOR_HEIGHT;

// A stable pseudo-random floor for a car's nth trip, so every car visits different floors without any state.
const tripFloor = (car: number, trip: number, top: number) => 1 + ((((car * 7919 + trip * 104729) >>> 0) % 997) % Math.max(1, top));

interface Trip {
  y: number;
  floor: number;
  phase: 'loading' | 'up' | 'stop' | 'down';
}

function tripAt(t: number, car: number, top: number): Trip {
  const cycle = 6 + (car % 3);
  const trip = Math.floor(t / cycle);
  const p = (t % cycle) / cycle;
  const floor = tripFloor(car, trip, top);
  const y = floor * FLOOR_HEIGHT;
  if (p < 0.15) return { y: 0, floor, phase: 'loading' };
  if (p < 0.5) return { y: THREE.MathUtils.smootherstep(p, 0.15, 0.5) * y, floor, phase: 'up' };
  if (p < 0.65) return { y, floor, phase: 'stop' };
  return { y: (1 - THREE.MathUtils.smootherstep(p, 0.65, 1)) * y, floor, phase: 'down' };
}

function Rider({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.28, 0]}>
        <capsuleGeometry args={[0.09, 0.26, 4, 8]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.58, 0]}>
        <sphereGeometry args={[0.08, 10, 8]} />
        <meshStandardMaterial color="#f1c7a3" roughness={0.6} />
      </mesh>
    </group>
  );
}

const RIDER_COLORS = ['#e2e8f0', '#93c5fd', '#fca5a5', '#fde68a'];

export function Tower({ node, environment }: { node: NetNode; environment: Environment | null }) {
  const floors = floorsOf(environment, node);
  const drawn = drawnFloors(floors);
  const cars = Math.min(MAX_CARS, Math.max(1, node.count ?? 1));
  const depth = cars * SHAFT_GAP + 1.2;
  const zOf = (i: number) => (i - (cars - 1) / 2) * SHAFT_GAP;
  const carRefs = useRef<Array<THREE.Group | null>>([]);
  const carLights = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const riderRefs = useRef<Array<Array<THREE.Group | null>>>([]);
  const landingRefs = useRef<Array<Array<THREE.Group | null>>>([]);
  const floorGlow = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const clock = useRef(0);
  // Each drawn floor stands for floors/drawn real ones when the building is taller than what is drawn.
  const label = (i: number) => (floors > drawn ? Math.round((i * floors) / drawn) : i);
  const slabs = useMemo(() => Array.from({ length: drawn + 1 }, (_, i) => i), [drawn]);

  useFrame((_, dt) => {
    const run = net();
    const state = run?.states.get(node.id);
    if (!run || !state) return;
    const waiting = state.queue + run.heldAt(node.id);
    const busy = !state.down && (state.utilization > 0.02 || waiting > 0.5);
    if (runner.running && busy) clock.current += dt * runner.speed;
    const lit = new Set<number>();
    // Cars out of service, drawn from the end of the bank, park dark at the lobby with a red light.
    const out = state.down ? cars : Math.min(cars, Math.ceil((state.lost * cars) / Math.max(1, node.count ?? 1)));
    for (let i = 0; i < cars; i++) {
      const car = carRefs.current[i];
      if (!car) continue;
      const broken = i >= cars - out;
      const trip = broken ? { y: 0, floor: 0, phase: 'loading' as const } : tripAt(clock.current + i * 1.9, i, Math.max(1, drawn - 1));
      car.position.y = trip.y;
      const light = carLights.current[i];
      if (light) {
        light.color.set(broken ? '#ef4444' : busy ? '#fef3c7' : '#64748b');
        light.emissive.set(broken ? '#ef4444' : busy ? '#fbbf24' : '#000000');
        light.emissiveIntensity = broken ? 1.2 : busy ? 1.4 : 0;
      }
      const riding = !broken && busy && (trip.phase === 'up' || trip.phase === 'loading');
      const stepping = !broken && busy && trip.phase === 'stop';
      const load = Math.max(1, Math.min(RIDERS, Math.round(waiting / Math.max(1, cars)) || 1));
      riderRefs.current[i]?.forEach((r, k) => r && (r.visible = riding && k < load));
      landingRefs.current[i]?.forEach((r, k) => {
        if (!r) return;
        r.visible = stepping && k < load;
        r.position.y = trip.y;
      });
      if (stepping) lit.add(trip.floor);
    }
    floorGlow.current.forEach((m, f) => {
      if (m) m.emissiveIntensity = lit.has(f) ? 0.9 : 0.05;
    });
  });

  return (
    <group>
      {/* Floor slabs, a strip of light on each landing, and floor numbers */}
      {slabs.map((f) => (
        <group key={f} position={[0.9, f * FLOOR_HEIGHT, 0]}>
          <mesh position={[0, -0.03, 0]} receiveShadow>
            <boxGeometry args={[3.4, 0.06, depth]} />
            <meshStandardMaterial color={f === 0 ? '#334155' : '#a5b4c8'} transparent opacity={f === 0 ? 1 : 0.1} roughness={0.2} metalness={0.3} depthWrite={f === 0} />
            <Edges color="#7dd3fc" transparent opacity={f === 0 ? 0.5 : 0.35} />
          </mesh>
          {f > 0 && f < drawn && (
            <mesh position={[1.25, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[0.6, depth - 0.3]} />
              <meshStandardMaterial
                ref={(m) => (floorGlow.current[f] = m)}
                color="#0f172a"
                emissive="#38bdf8"
                emissiveIntensity={0.05}
                toneMapped={false}
                transparent
                opacity={0.8}
              />
            </mesh>
          )}
          {f > 0 && f < drawn && (
            <Html position={[2.75, 0.25, -depth / 2]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
              <span className="tower-floor">{label(f)}</span>
            </Html>
          )}
        </group>
      ))}
      {Array.from({ length: cars }, (_, i) => (
        <group key={i} position={[0, 0, zOf(i)]}>
          {/* Glass shaft through every floor */}
          <mesh position={[0, towerHeight(floors) / 2, 0]}>
            <boxGeometry args={[0.95, towerHeight(floors), 0.95]} />
            <meshStandardMaterial color="#7dd3fc" transparent opacity={0.05} roughness={0.05} metalness={0.2} depthWrite={false} />
            <Edges color="#38bdf8" transparent opacity={0.22} />
          </mesh>
          {/* The car, with its light and the riders inside */}
          <group ref={(g) => (carRefs.current[i] = g)}>
            <mesh position={[0, 0.47, 0]} castShadow>
              <boxGeometry args={[0.86, 0.94, 0.86]} />
              <meshStandardMaterial color="#e2e8f0" metalness={0.5} roughness={0.3} transparent opacity={0.55} depthWrite={false} />
              <Edges color="#f8fafc" />
            </mesh>
            <mesh position={[0, 0.94, 0]}>
              <boxGeometry args={[0.5, 0.06, 0.5]} />
              <meshStandardMaterial ref={(m) => (carLights.current[i] = m)} color="#fef3c7" emissive="#fbbf24" emissiveIntensity={1.4} toneMapped={false} />
            </mesh>
            {Array.from({ length: RIDERS }, (_, k) => (
              <group
                key={k}
                ref={(g) => {
                  riderRefs.current[i] ??= [];
                  riderRefs.current[i][k] = g;
                }}
                position={[(k % 2) * 0.28 - 0.14, 0.02, Math.floor(k / 2) * 0.28 - 0.14]}
              >
                <Rider color={RIDER_COLORS[k]} />
              </group>
            ))}
          </group>
          {/* Riders stepping out onto the landing while the car is stopped */}
          {Array.from({ length: RIDERS }, (_, k) => (
            <group
              key={k}
              ref={(g) => {
                landingRefs.current[i] ??= [];
                landingRefs.current[i][k] = g;
              }}
              position={[0.85 + k * 0.32, 0, (k % 2) * 0.25 - 0.12]}
              visible={false}
            >
              <Rider color={RIDER_COLORS[k]} />
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}
