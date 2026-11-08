import type { RobotState, World } from '@tv/core';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { useStore } from '../../store';
import { ClaimPin } from '../shared';
import { useFloorDrag, type Grab } from './drag';
import { COLORS, robotColor, toScene, warehouseSim } from './palette';

const dummy = new THREE.Object3D();
const MAX_ROUTE = 66;

function Robot({ world, index }: { world: World; index: number }) {
  const group = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const led = useRef<THREE.MeshBasicMaterial>(null!);
  const halo = useRef<THREE.Mesh>(null!);
  const haloMat = useRef<THREE.MeshBasicMaterial>(null!);
  const parcel = useRef<THREE.Mesh>(null!);
  const label = useRef<HTMLDivElement>(null!);
  const heading = useRef(0);
  const tint = robotColor(index);
  const selected = useStore((s) => s.selected !== null && warehouseSim()?.robots[index]?.id === s.selected);
  const drag = useFloorDrag(world);
  const grab = (): Grab | null => {
    const r = warehouseSim()?.robots[index];
    return r && !r.removed ? { id: r.id, from: { x: r.x, y: r.y }, move: (to) => ({ op: 'move_robot', robotId: r.id, to }) } : null;
  };

  const route = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_ROUTE * 3), 3));
    const material = new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: 0.4, toneMapped: false });
    return new THREE.Line(geometry, material);
  }, [tint]);

  useFrame(({ clock }, dt) => {
    const r: RobotState | undefined = warehouseSim()?.robots[index];
    if (!r) return;
    const a = runner.alpha;
    const x = r.px + (r.x - r.px) * a;
    const y = r.py + (r.y - r.py) * a;
    const [sx, , sz] = toScene(world, { x, y });
    group.current.position.set(sx, 0, sz);

    if (r.x !== r.px || r.y !== r.py) {
      const target = Math.atan2(r.x - r.px, r.y - r.py);
      const delta = Math.atan2(Math.sin(target - heading.current), Math.cos(target - heading.current));
      heading.current += delta * Math.min(1, dt * 14);
    }
    body.current.rotation.y = heading.current;

    const failed = r.mode === 'failed';
    const blink = failed ? (Math.sin(clock.elapsedTime * 9) > 0 ? 2.4 : 0.3) : 1.6;
    led.current.color.set(failed ? COLORS.danger : r.mode === 'charging' ? COLORS.energy : tint).multiplyScalar(blink);
    parcel.current.visible = r.carrying;

    halo.current.visible = failed || selected;
    if (failed) {
      const pulse = (clock.elapsedTime * 0.9) % 1;
      halo.current.scale.setScalar(1 + pulse * 2.2);
      haloMat.current.opacity = 0.9 * (1 - pulse);
      haloMat.current.color.set(COLORS.danger);
    } else if (selected) {
      halo.current.scale.setScalar(1);
      haloMat.current.opacity = 0.9;
      haloMat.current.color.set(tint);
    }

    const positions = route.geometry.attributes.position as THREE.BufferAttribute;
    const step = r.path.length ? Math.max(0, warehouseSim()!.tick - r.pathStart) : 0;
    const cells = r.path.slice(step);
    let n = 0;
    positions.setXYZ(n++, sx, 0.06, sz);
    for (const cell of cells) {
      if (n >= MAX_ROUTE) break;
      const [px, , pz] = toScene(world, { x: cell % world.cols, y: Math.floor(cell / world.cols) });
      positions.setXYZ(n++, px, 0.06, pz);
    }
    positions.needsUpdate = true;
    route.geometry.setDrawRange(0, n);
    route.visible = n > 1 && !failed;

    if (label.current) {
      const battery = Math.round((r.battery / world.params.batteryCapacity) * 100);
      label.current.dataset.failed = String(failed);
      label.current.textContent = failed ? `${r.name} · ${r.failReason === 'battery' ? 'OUT OF POWER' : 'FAULT'}` : `${r.name} · ${battery}%`;
    }
  });

  return (
    <>
      <primitive object={route} />
      <group
        ref={group}
        onPointerDown={(e) => drag.onPointerDown(e, grab())}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onClick={(e) => drag.onClick(e, warehouseSim()?.robots[index]?.id ?? '')}
      >
        <group ref={body}>
          <mesh position={[0, 0.2, 0]} castShadow>
            <boxGeometry args={[0.72, 0.28, 0.86]} />
            <meshStandardMaterial color="#d7dfec" metalness={0.35} roughness={0.35} />
          </mesh>
          <mesh position={[0, 0.36, 0]}>
            <boxGeometry args={[0.6, 0.05, 0.72]} />
            <meshStandardMaterial color="#10172a" metalness={0.5} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.2, 0.44]}>
            <boxGeometry args={[0.5, 0.07, 0.02]} />
            <meshBasicMaterial ref={led} toneMapped={false} />
          </mesh>
          <mesh ref={parcel} position={[0, 0.56, 0]} castShadow visible={false}>
            <boxGeometry args={[0.46, 0.34, 0.46]} />
            <meshStandardMaterial color={COLORS.cargo} emissive={COLORS.cargo} emissiveIntensity={0.25} roughness={0.6} />
          </mesh>
        </group>
        <mesh ref={halo} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
          <ringGeometry args={[0.52, 0.6, 40]} />
          <meshBasicMaterial ref={haloMat} toneMapped={false} transparent />
        </mesh>
        <Html position={[0, 1.15, 0]} center zIndexRange={[10, 0]} wrapperClass="robot-tag-wrap">
          <div ref={label} className="scene-tag" style={{ ['--tag' as string]: tint }} />
        </Html>
        <ClaimPin id={warehouseSim()?.robots[index]?.id ?? ''} position={[0, 0.4, 0]} />
      </group>
    </>
  );
}

function Cargo({ world }: { world: World }) {
  const boxes = useRef<THREE.InstancedMesh>(null!);
  const markers = useRef<THREE.InstancedMesh>(null!);
  const MAX_BOXES = 160;
  const MAX_MARKERS = 200;

  useFrame(({ clock }) => {
    const sim = warehouseSim();
    if (!sim) return;
    const a = runner.running ? runner.alpha : 0;
    let n = 0;
    const put = (x: number, y: number, z: number, size: number) => {
      if (n >= MAX_BOXES) return;
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      boxes.current.setMatrixAt(n++, dummy.matrix);
    };

    sim.belts.forEach((belt, c) => {
      const path = world.conveyors[c].path;
      belt.slots.forEach((order, i) => {
        if (!order) return;
        const move = !belt.blocked && i < path.length - 1 && !belt.slots[i + 1] ? a : 0;
        const [x, , z] = toScene(world, { x: path[i].x + move, y: path[i].y });
        put(x, 0.52, z, 0.42);
      });
    });

    const { sorter } = world;
    const [sx, , sz] = toScene(world, { x: sorter.x + sorter.w - 0.5, y: sorter.y + sorter.h / 2 - 0.5 });
    for (const item of sim.chutes) {
      const dock = world.docks[item.order.dock];
      const [dx, , dz] = toScene(world, dock);
      const t = 1 - (item.left - a) / world.params.chuteTicks;
      put(sx + (dx - sx) * t, 0.36, sz + (dz - sz) * t, 0.34);
    }
    boxes.current.count = n;
    boxes.current.instanceMatrix.needsUpdate = true;

    const stacks = new Map<string, number>();
    let m = 0;
    for (const order of sim.queue) {
      if (m >= MAX_MARKERS) break;
      const level = stacks.get(order.shelf.id) ?? 0;
      stacks.set(order.shelf.id, level + 1);
      const [x, , z] = toScene(world, order.shelf);
      const bob = Math.sin(clock.elapsedTime * 3 + order.id) * 0.03;
      dummy.position.set(x, 1.45 + level * 0.26 + bob, z);
      dummy.rotation.set(0, clock.elapsedTime * 1.5 + order.id, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      markers.current.setMatrixAt(m++, dummy.matrix);
    }
    markers.current.count = m;
    markers.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={boxes} args={[undefined, undefined, MAX_BOXES]} castShadow frustumCulled={false}>
        <boxGeometry args={[1, 0.8, 1]} />
        <meshStandardMaterial color={COLORS.cargo} emissive={COLORS.cargo} emissiveIntensity={0.25} roughness={0.6} />
      </instancedMesh>
      <instancedMesh ref={markers} args={[undefined, undefined, MAX_MARKERS]} frustumCulled={false}>
        <octahedronGeometry args={[0.13]} />
        <meshBasicMaterial color={COLORS.cargo} toneMapped={false} />
      </instancedMesh>
    </>
  );
}

export function Actors({ world }: { world: World }) {
  useStore((s) => s.telemetry.tick);
  const count = warehouseSim()?.robots.length ?? 0;
  return (
    <group>
      {Array.from({ length: count }, (_, i) => (
        <Robot key={i} world={world} index={i} />
      ))}
      <Cargo world={world} />
    </group>
  );
}
