import type { World } from '@tv/core';
import { Html } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { create } from 'zustand';
import { editFloor } from '../../actions';
import { runner } from '../../runner';
import { select } from '../../store';
import { COLORS, toScene } from './palette';

type Cell = { x: number; y: number };

/** Something on the floor that can be picked up: where it is now, and the edit that puts it on another cell. */
export interface Grab {
  id: string;
  from: Cell;
  move: (to: Cell) => unknown;
}

export type Placeable = 'robot' | 'shelf' | 'charger';

interface FloorEdit {
  /** The cell under a dragged or placed thing, and why it can't go there, if it can't */
  ghost: { cell: Cell; reason: string | null } | null;
  /** A refused drop, shown where it was dropped for a moment */
  warning: { cell: Cell; text: string; key: number } | null;
  /** What the next click on the floor puts down, once the Add toolbar arms it */
  placing: Placeable | null;
}

export const useFloorEdit = create<FloorEdit>(() => ({ ghost: null, warning: null, placing: null }));

const placeAt = (kind: Placeable, at: Cell) => ({ op: kind === 'robot' ? 'add_robot' : kind === 'shelf' ? 'add_shelf' : 'add_charger', at });

const WARNING_MS = 3200;
const DRAG_THRESHOLD = 5;
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;

// The floor cell under the pointer, whatever it hits on the way down
function cellUnder(e: ThreeEvent<PointerEvent | MouseEvent>, world: World): Cell | null {
  if (!e.ray.intersectPlane(ground, hit)) return null;
  const cell = { x: Math.floor(hit.x + world.cols / 2), y: Math.floor(hit.z + world.rows / 2) };
  return cell.x < 0 || cell.y < 0 || cell.x >= world.cols || cell.y >= world.rows ? null : cell;
}

interface Press {
  pointer: number;
  x: number;
  y: number;
  grab: Grab;
  moved: boolean;
  cell: Cell | null;
}

/**
 * Drag to move on the warehouse grid. The thing stays put while it's dragged and a ghost marks the cell under it;
 * a drop the run refuses leaves it where it was and says why.
 */
export function useFloorDrag(world: World) {
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const canvas = useThree((s) => s.gl.domElement);
  const press = useRef<Press | null>(null);
  const dragged = useRef(false);

  const onPointerDown = (e: ThreeEvent<PointerEvent>, grab: Grab | null) => {
    if (!grab || e.button !== 0) return;
    e.stopPropagation();
    dragged.current = false;
    press.current = { pointer: e.pointerId, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, grab, moved: false, cell: null };
    (e.target as unknown as Element).setPointerCapture(e.pointerId);
    if (controls) controls.enabled = false;
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    e.stopPropagation();
    if (!p.moved && Math.hypot(e.nativeEvent.clientX - p.x, e.nativeEvent.clientY - p.y) < DRAG_THRESHOLD) return;
    p.moved = true;
    canvas.style.cursor = 'grabbing';
    const cell = cellUnder(e, world);
    if (cell && p.cell && same(cell, p.cell)) return;
    p.cell = cell;
    const reason = !cell || same(cell, p.grab.from) ? null : (runner.run?.check?.([p.grab.move(cell)]) ?? null);
    useFloorEdit.setState({ ghost: cell ? { cell, reason } : null });
  };

  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    press.current = null;
    (e.target as unknown as Element).releasePointerCapture?.(e.pointerId);
    if (controls) controls.enabled = true;
    canvas.style.cursor = '';
    useFloorEdit.setState({ ghost: null });
    if (!p.moved) return;
    dragged.current = true;
    const { cell } = p;
    if (!cell || same(cell, p.grab.from)) return;
    const reason = editFloor([p.grab.move(cell)]);
    if (reason) useFloorEdit.setState({ warning: { cell, text: reason, key: performance.now() } });
  };

  // A drag ends in a click on the same thing, which mustn't also select it
  const onClick = (e: ThreeEvent<MouseEvent>, id: string) => {
    e.stopPropagation();
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    select(id);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onClick };
}

/** The cell a dragged thing would land on, green when it can and red with the reason when it can't, and any refused drop. */
export function FloorEditMarks({ world }: { world: World }) {
  const ghost = useFloorEdit((s) => s.ghost);
  const warning = useFloorEdit((s) => s.warning);

  useEffect(() => {
    if (!warning) return;
    const timer = setTimeout(() => useFloorEdit.setState((s) => (s.warning?.key === warning.key ? { warning: null } : s)), WARNING_MS);
    return () => clearTimeout(timer);
  }, [warning]);

  return (
    <>
      {ghost && (
        <group position={toScene(world, ghost.cell)}>
          <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.92, 0.92]} />
            <meshBasicMaterial color={ghost.reason ? COLORS.danger : COLORS.energy} transparent opacity={0.45} toneMapped={false} depthWrite={false} />
          </mesh>
          {ghost.reason && <Mark text={ghost.reason} />}
        </group>
      )}
      {warning && (!ghost || !same(ghost.cell, warning.cell)) && (
        <group position={toScene(world, warning.cell)}>
          <Mark text={warning.text} />
        </group>
      )}
    </>
  );
}

/**
 * While the Add toolbar is armed, a sheet over everything on the floor takes the pointer: hovering shows whether the
 * cell beneath can take the new thing, and a click puts it there. Dragging still turns the camera.
 */
export function PlacementLayer({ world }: { world: World }) {
  const placing = useFloorEdit((s) => s.placing);
  const last = useRef<Cell | null>(null);
  if (!placing) return null;

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const cell = cellUnder(e, world);
    if (cell && last.current && same(cell, last.current)) return;
    last.current = cell;
    const reason = cell ? (runner.run?.check?.([placeAt(placing, cell)]) ?? null) : null;
    useFloorEdit.setState({ ghost: cell ? { cell, reason } : null });
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > DRAG_THRESHOLD) return;
    const cell = cellUnder(e, world);
    if (!cell) return;
    const reason = editFloor([placeAt(placing, cell)]);
    last.current = null;
    if (reason) useFloorEdit.setState({ warning: { cell, text: reason, key: performance.now() } });
    else useFloorEdit.setState({ placing: null, ghost: null });
  };

  return (
    <mesh
      // An invisible catch-plane, wider than the floor: marked as floor so the camera frames the warehouse, not this
      userData={{ floor: true }}
      position={[0, 2.5, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={onPointerMove}
      onPointerOut={() => {
        last.current = null;
        useFloorEdit.setState({ ghost: null });
      }}
      onClick={onClick}
    >
      <planeGeometry args={[world.cols + 40, world.rows + 40]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function Mark({ text }: { text: string }) {
  return (
    <Html position={[0, 1.2, 0]} center zIndexRange={[30, 20]}>
      <div className="scene-tag" data-failed="true">
        {text}
      </div>
    </Html>
  );
}
