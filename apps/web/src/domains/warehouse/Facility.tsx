import type { World } from '@tv/core';
import { Grid } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { runner } from '../../runner';
import { select } from '../../store';
import { pick } from '../shared';
import { COLORS, robotColor, toScene, warehouseSim } from './palette';

const dummy = new THREE.Object3D();
const color = new THREE.Color();

const easeOut = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

function Shelves({ world }: { world: World }) {
  const frames = useRef<THREE.InstancedMesh>(null!);
  const crates = useRef<THREE.InstancedMesh>(null!);
  const plates = useRef<THREE.InstancedMesh>(null!);
  const lastOwners = useRef('');
  const born = useRef(0);
  const count = world.shelves.length;
  const CRATES_PER_SHELF = 3;

  const place = (progress: (i: number) => number) => {
    world.shelves.forEach((shelf, i) => {
      const [x, , z] = toScene(world, shelf);
      const p = easeOut(progress(i));
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(x, 0.55 * p, z);
      dummy.scale.set(0.84, Math.max(0.001, p), 0.84);
      dummy.updateMatrix();
      frames.current.setMatrixAt(i, dummy.matrix);

      for (let c = 0; c < CRATES_PER_SHELF; c++) {
        const seed = (i * 7 + c * 13) % 11;
        const size = 0.3 + (seed % 4) * 0.04;
        dummy.position.set(x + ((seed % 3) - 1) * 0.1, (0.26 + c * 0.34) * p, z + ((seed % 5) - 2) * 0.05);
        dummy.scale.set(size, Math.max(0.001, size * 0.8 * p), size);
        dummy.updateMatrix();
        crates.current.setMatrixAt(i * CRATES_PER_SHELF + c, dummy.matrix);
      }

      dummy.position.set(x, 0.02, z);
      dummy.scale.set(0.92 * p, 1, 0.92 * p);
      dummy.updateMatrix();
      plates.current.setMatrixAt(i, dummy.matrix);
    });
    frames.current.instanceMatrix.needsUpdate = true;
    crates.current.instanceMatrix.needsUpdate = true;
    plates.current.instanceMatrix.needsUpdate = true;
  };

  useLayoutEffect(() => {
    place(() => 0);
    world.shelves.forEach((_, i) => {
      for (let c = 0; c < CRATES_PER_SHELF; c++) {
        const seed = (i * 7 + c * 13) % 11;
        crates.current.setColorAt(i * CRATES_PER_SHELF + c, color.set(COLORS.crate).offsetHSL(0, 0, (seed - 5) * 0.012));
      }
    });
    crates.current.instanceColor!.needsUpdate = true;
    born.current = performance.now();
    lastOwners.current = '';
  }, [world]);

  useFrame(() => {
    const age = (performance.now() - born.current) / 1000;
    if (age < 2.4) {
      place((i) => (age - (world.shelves[i].x + world.shelves[i].y) * 0.035) / 0.7);
    }
    const sim = warehouseSim();
    if (!sim) return;
    const owners = world.shelves.map((s) => sim.shelfOwner.get(s.id)).join();
    if (owners === lastOwners.current) return;
    lastOwners.current = owners;
    world.shelves.forEach((shelf, i) => {
      const owner = sim.robots.find((r) => r.id === sim.shelfOwner.get(shelf.id));
      plates.current.setColorAt(i, color.set(owner ? robotColor(owner.index) : COLORS.steel).multiplyScalar(1.6));
    });
    if (plates.current.instanceColor) plates.current.instanceColor.needsUpdate = true;
  });

  const pickShelf = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId !== undefined) pick(world.shelves[e.instanceId].id)(e);
  };

  return (
    <group>
      <instancedMesh ref={frames} args={[undefined, undefined, count]} castShadow receiveShadow onClick={pickShelf}>
        <boxGeometry args={[1, 1.1, 1]} />
        <meshStandardMaterial color={COLORS.steel} metalness={0.7} roughness={0.45} transparent opacity={0.55} />
      </instancedMesh>
      <instancedMesh ref={crates} args={[undefined, undefined, count * CRATES_PER_SHELF]} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={plates} args={[undefined, undefined, count]}>
        <boxGeometry args={[1, 0.03, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

function Conveyor({ world, index }: { world: World; index: number }) {
  const conveyor = world.conveyors[index];
  const slats = useRef<THREE.InstancedMesh>(null!);
  const bed = useRef<THREE.MeshStandardMaterial>(null!);
  const edge = useRef<THREE.MeshBasicMaterial>(null!);
  const offset = useRef(0);
  const first = conveyor.path[0];
  const length = conveyor.path.length;
  const [cx, , cz] = toScene(world, { x: first.x + (length - 1) / 2, y: first.y });
  const slatCount = length * 2;

  useFrame((_, dt) => {
    const belt = warehouseSim()?.belts[index];
    const blocked = belt?.blocked ?? false;
    if (!blocked && runner.running) offset.current = (offset.current + dt * 2.2 * runner.speed) % 0.5;
    edge.current.color.set(blocked ? COLORS.danger : '#3b4a66').multiplyScalar(blocked ? 2 : 1);
    bed.current.color.set(blocked ? '#3a1218' : '#121a28');
    for (let i = 0; i < slatCount; i++) {
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.position.set(cx - length / 2 + ((i * 0.5 + offset.current) % length), 0.335, cz);
      dummy.updateMatrix();
      slats.current.setMatrixAt(i, dummy.matrix);
    }
    slats.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group onClick={pick(conveyor.id)}>
      <mesh position={[cx, 0.16, cz]} castShadow receiveShadow>
        <boxGeometry args={[length, 0.32, 0.86]} />
        <meshStandardMaterial ref={bed} metalness={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[cx, 0.34, cz - 0.44]}>
        <boxGeometry args={[length, 0.06, 0.05]} />
        <meshBasicMaterial ref={edge} toneMapped={false} />
      </mesh>
      <mesh position={[cx, 0.34, cz + 0.44]}>
        <boxGeometry args={[length, 0.06, 0.05]} />
        <meshBasicMaterial color="#3b4a66" toneMapped={false} />
      </mesh>
      <instancedMesh ref={slats} args={[undefined, undefined, slatCount]}>
        <boxGeometry args={[0.07, 0.012, 0.76]} />
        <meshStandardMaterial color="#2c3a54" />
      </instancedMesh>
      {conveyor.stations.map((s) => {
        const [x, , z] = toScene(world, s);
        return (
          <mesh key={s.index} position={[x, 0.012, z]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.32, 0.38, 28]} />
            <meshBasicMaterial color={COLORS.cargo} toneMapped={false} transparent opacity={0.55} />
          </mesh>
        );
      })}
    </group>
  );
}

function Sorter({ world }: { world: World }) {
  const { sorter } = world;
  const ring = useRef<THREE.Mesh>(null!);
  const [x, , z] = toScene(world, { x: sorter.x + sorter.w / 2 - 0.5, y: sorter.y + sorter.h / 2 - 0.5 });

  useFrame((_, dt) => {
    if (runner.running) ring.current.rotation.z += dt * 1.4 * runner.speed;
  });

  return (
    <group position={[x, 0, z]} onClick={pick(sorter.id)}>
      <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[sorter.w - 0.1, 1.1, sorter.h - 0.1]} />
        <meshStandardMaterial color={COLORS.steelLight} metalness={0.75} roughness={0.35} />
      </mesh>
      <mesh position={[0, 1.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[Math.min(sorter.w, sorter.h) * 0.36, 40]} />
        <meshStandardMaterial color="#0e1522" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh ref={ring} position={[0, 1.14, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[Math.min(sorter.w, sorter.h) * 0.3, Math.min(sorter.w, sorter.h) * 0.36, 6, 1]} />
        <meshBasicMaterial color={COLORS.cargo} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Docks({ world }: { world: World }) {
  const { sorter } = world;
  const startX = sorter.x + sorter.w - 0.5;
  return (
    <group>
      {world.docks.map((dock) => {
        const [x, , z] = toScene(world, dock);
        const [sx, , sz] = toScene(world, { x: startX, y: sorter.y + sorter.h / 2 - 0.5 });
        const dx = x - sx;
        const dz = z - sz;
        const length = Math.hypot(dx, dz);
        return (
          <group key={dock.id}>
            <mesh position={[(sx + x) / 2, 0.14, (sz + z) / 2]} rotation={[0, -Math.atan2(dz, dx), 0]} castShadow>
              <boxGeometry args={[length, 0.1, 0.42]} />
              <meshStandardMaterial color={COLORS.steelLight} metalness={0.7} roughness={0.4} />
            </mesh>
            <mesh position={[x + 0.2, 0.75, z]} castShadow>
              <boxGeometry args={[0.2, 1.5, 1.3]} />
              <meshStandardMaterial color={COLORS.steel} metalness={0.5} roughness={0.5} />
            </mesh>
            <mesh position={[x + 0.08, 1.56, z]}>
              <boxGeometry args={[0.05, 0.05, 1.2]} />
              <meshBasicMaterial color={COLORS.cargo} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function ChargerPost({ world, index }: { world: World; index: number }) {
  const charger = world.chargers[index];
  const light = useRef<THREE.MeshBasicMaterial>(null!);
  const pad = useRef<THREE.MeshBasicMaterial>(null!);
  const [x, , z] = toScene(world, charger);
  const [bx, , bz] = toScene(world, charger.bay);

  useFrame(({ clock }) => {
    const state = warehouseSim()?.chargers[index];
    const offline = state?.offline ?? false;
    const inUse = Boolean(state?.claimedBy);
    const pulse = inUse ? 1.4 + Math.sin(clock.elapsedTime * 6) * 0.6 : 1;
    light.current.color.set(offline ? COLORS.danger : COLORS.energy).multiplyScalar(pulse);
    pad.current.color.set(offline ? COLORS.danger : COLORS.energy);
  });

  return (
    <group onClick={pick(charger.id)}>
      <mesh position={[x, 0.6, z]} castShadow>
        <boxGeometry args={[0.6, 1.2, 0.7]} />
        <meshStandardMaterial color={COLORS.steelLight} metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[x + 0.31, 0.85, z]}>
        <boxGeometry args={[0.02, 0.36, 0.16]} />
        <meshBasicMaterial ref={light} toneMapped={false} />
      </mesh>
      <mesh position={[bx, 0.012, bz]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.34, 0.42, 4, 1, Math.PI / 4]} />
        <meshBasicMaterial ref={pad} toneMapped={false} transparent opacity={0.8} />
      </mesh>
    </group>
  );
}

export function Facility({ world }: { world: World }) {
  const size = useMemo(() => [world.cols + 1, world.rows + 1] as const, [world]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow onClick={() => select(null)}>
        <planeGeometry args={size as unknown as [number, number]} />
        <meshStandardMaterial color={COLORS.floor} metalness={0.4} roughness={0.55} />
      </mesh>
      <Grid
        position={[0, 0, 0]}
        args={size as unknown as [number, number]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#2a3852"
        sectionSize={5}
        sectionThickness={0.9}
        sectionColor="#3c4f74"
        fadeDistance={80}
      />
      <Shelves world={world} />
      {world.conveyors.map((c, i) => (
        <Conveyor key={c.id} world={world} index={i} />
      ))}
      <Sorter world={world} />
      <Docks world={world} />
      {world.chargers.map((c, i) => (
        <ChargerPost key={c.id} world={world} index={i} />
      ))}
    </group>
  );
}
