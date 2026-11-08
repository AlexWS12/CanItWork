import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Floor } from '../domains/shared';
import { reducedMotion } from '../motion';
import { useStore } from '../store';
import { LOOK } from './look';

// What the scene shows while a never-seen system is being built, honestly: the stage the Interpreter chose, then each round's
// design as a blueprint, then the design that passed every check, solid and running.

const blueprint = new THREE.MeshBasicMaterial({ color: '#9cc2f0', wireframe: true, transparent: true, opacity: 0.45, depthWrite: false });

/** Draws every mesh as blue wireframe while the design on screen is still a draft. */
export function BlueprintLook() {
  const on = useStore((s) => s.blueprint);
  const key = useStore((s) => s.environmentKey);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.overrideMaterial = on ? blueprint : null;
    // Floors would draw as two huge wireframe triangles, so a blueprint floats over the dark instead
    const floors: THREE.Object3D[] = [];
    const timer = setTimeout(() => {
      if (!on) return;
      scene.traverse((o) => {
        if (o.userData.floor && o.visible) {
          o.visible = false;
          floors.push(o);
        }
      });
    });
    return () => {
      clearTimeout(timer);
      scene.overrideMaterial = null;
      for (const o of floors) o.visible = true;
    };
  }, [on, key, scene]);
  useFrame(({ clock }) => {
    if (on) blueprint.opacity = reducedMotion() ? 0.45 : 0.35 + 0.15 * Math.sin(clock.elapsedTime * 3);
  });
  return null;
}

/** The chosen simulator's empty stage, with a scan sweeping it, until the first design arrives. */
export function EmptyStage() {
  const stage = useStore((s) => (s.building && !s.environment ? s.stage : null));
  const sweep = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    if (!sweep.current) return;
    const t = reducedMotion() ? 0.5 : (clock.elapsedTime * 0.35) % 1;
    sweep.current.position.x = -15 + t * 30;
  });
  if (!stage) return null;
  return (
    <group>
      <Floor width={36} depth={24} />
      <mesh ref={sweep} position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.25, 22]} />
        <meshBasicMaterial color={LOOK.accent} transparent opacity={0.7} toneMapped={false} />
      </mesh>
      {/* An unseen plane the camera frames, since floors are left out of framing */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[30, 20]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}
