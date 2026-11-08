import { isEditable, type Finding } from '@tv/core';
import { Grid, Html } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { finishMove, moveComponent } from '../actions';
import { plainFinding, struggling } from '../explain';
import { reducedMotion } from '../motion';
import { LOOK } from '../scene/look';
import { select, useStore } from '../store';

export const pick = (id: string) => (e: ThreeEvent<MouseEvent>) => {
  e.stopPropagation();
  select(id);
};

interface FloorProps {
  width: number;
  depth: number;
  position?: [number, number, number];
  cell?: number;
  section?: number;
  color?: string;
  metalness?: number;
  roughness?: number;
  fade?: number;
}

// The floor a system stands on. Clicking it clears the selection, and the camera frames what stands on it, not the floor itself.
export function Floor({ width, depth, position = [0, 0, 0], cell = 1, section = 5, color = LOOK.floor, metalness = 0.1, roughness = 0.85, fade = 110 }: FloorProps) {
  const floor = useMemo(() => ({ floor: true }), []);
  return (
    <group position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow onClick={() => select(null)} userData={floor}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
      </mesh>
      <Grid
        args={[width, depth]}
        cellSize={cell}
        cellThickness={0.4}
        cellColor={LOOK.grid}
        sectionSize={section}
        sectionThickness={0.8}
        sectionColor={LOOK.section}
        fadeDistance={fade}
        userData={floor}
      />
    </group>
  );
}

export function Tag({ text, tint, y = 1.1 }: { text: string; tint: string; y?: number }) {
  return (
    <Html position={[0, y, 0]} center zIndexRange={[10, 0]}>
      <div className="scene-tag" style={{ ['--tag' as string]: tint }}>
        {text}
      </div>
    </Html>
  );
}

const MAX_PINS = 3;

// The part a claim is about: "orders.email" is the orders table, "api->db" starts at api
const targetOf = (finding: Finding) => finding.incident.target?.split(/->|\./)[0];
const projected = new THREE.Vector3();

export function ClaimPin({ id, position = [0, 0, 0] }: { id: string; position?: [number, number, number] }) {
  const anchor = useRef<THREE.Group>(null);
  const pin = useRef<HTMLDivElement>(null);
  // Cards on the right half of the screen open leftwards, so they stay clear of the right panel
  useFrame(({ camera }) => {
    if (!anchor.current || !pin.current) return;
    anchor.current.getWorldPosition(projected).project(camera);
    const side = projected.x > 0 ? 'left' : 'right';
    if (pin.current.dataset.side !== side) pin.current.dataset.side = side;
  });
  const findings = useStore((s) => s.findings);
  const explanation = useStore((s) => s.explanation);
  const sheetOpen = useStore((s) => Boolean(s.report) && s.reportOpen);
  const pinned = findings.filter(targetOf).slice(0, MAX_PINS);
  const index = pinned.findIndex((f) => targetOf(f) === id);
  if (index < 0 || sheetOpen) return null;
  const finding = pinned[index];
  const confirmed = finding.verdict === 'confirmed';
  const plain = plainFinding(finding, explanation);
  return (
    <group ref={anchor} position={position}>
      <Html zIndexRange={[20, 11]} pointerEvents="none">
        <div ref={pin} className="claim-pin" data-verdict={finding.verdict}>
          <button className="claim-card" onClick={() => select(id)}>
            <span className="claim-kicker">Weak-spot check · {confirmed ? 'Weak spot' : struggling(finding) !== null ? 'No change' : 'Held up'}</span>
            <span>
              {plain.title} {plain.impact}
            </span>
          </button>
          <span className="claim-leader" aria-hidden />
          <span className="claim-dot" aria-hidden />
        </div>
      </Html>
    </group>
  );
}

/** A view's computed layout with the user's dragged positions laid over it. */
export function useArranged(positions: Map<string, THREE.Vector3>) {
  const layout = useStore((s) => s.environment?.layout);
  return useMemo(() => {
    if (!layout) return positions;
    const out = new Map(positions);
    for (const [id, [x, z]] of Object.entries(layout)) {
      const at = out.get(id);
      if (at) out.set(id, new THREE.Vector3(x, at.y, z));
    }
    return out;
  }, [positions, layout]);
}

const DRAG_THRESHOLD = 5;
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

interface Drag {
  pointer: number;
  x: number;
  y: number;
  offset: THREE.Vector2;
  moved: boolean;
}

/** One component in a graph view: click selects it, and in editable domains dragging moves it across the floor. */
export function Movable({ id, position, children }: { id: string; position: THREE.Vector3; children: ReactNode }) {
  const editable = useStore((s) => (s.environment ? isEditable(s.environment.domain) : false));
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const canvas = useThree((s) => s.gl.domElement);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    dragged.current = false;
    if (!e.ray.intersectPlane(ground, hit)) return;
    drag.current = { pointer: e.pointerId, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, offset: new THREE.Vector2(hit.x - position.x, hit.z - position.z), moved: false };
    (e.target as unknown as Element).setPointerCapture(e.pointerId);
    if (controls) controls.enabled = false;
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.stopPropagation();
    if (!d.moved && Math.hypot(e.nativeEvent.clientX - d.x, e.nativeEvent.clientY - d.y) < DRAG_THRESHOLD) return;
    d.moved = true;
    canvas.style.cursor = 'grabbing';
    if (e.ray.intersectPlane(ground, hit)) moveComponent(id, [Math.round((hit.x - d.offset.x) * 10) / 10, Math.round((hit.z - d.offset.y) * 10) / 10]);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    (e.target as unknown as Element).releasePointerCapture?.(e.pointerId);
    if (controls) controls.enabled = true;
    canvas.style.cursor = editable ? 'grab' : '';
    if (d.moved) {
      dragged.current = true;
      finishMove(id);
    }
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    select(id);
  };
  return (
    <group
      position={position}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        if (editable && !drag.current) canvas.style.cursor = 'grab';
      }}
      onPointerOut={() => {
        if (!drag.current) canvas.style.cursor = '';
      }}
    >
      {children}
      <FreshRing id={id} />
    </group>
  );
}

const FRESH_SECONDS = 2.4;

/** A ring that spreads out from a component the agents or the user just added, so it's easy to spot. */
function FreshRing({ id }: { id: string }) {
  const fresh = useStore((s) => s.fresh.includes(id));
  const ring = useRef<THREE.Mesh>(null);
  const age = useRef(0);
  useFrame((_, dt) => {
    if (!ring.current) return;
    age.current = (age.current + dt) % FRESH_SECONDS;
    const t = reducedMotion() ? 0.5 : age.current / FRESH_SECONDS;
    ring.current.scale.setScalar(1 + t * 2.2);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
  });
  if (!fresh) return null;
  return (
    <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]}>
      <ringGeometry args={[1.6, 1.9, 48]} />
      <meshBasicMaterial color="#5eead4" transparent toneMapped={false} depthWrite={false} />
    </mesh>
  );
}
