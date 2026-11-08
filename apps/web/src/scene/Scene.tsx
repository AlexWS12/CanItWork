import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { Environment } from '@tv/core';
import { VIEWS } from '../domains';
import { reducedMotion } from '../motion';
import { runner } from '../runner';
import { useStore } from '../store';

function Clock() {
  useFrame((_, dt) => runner.frame(dt));
  return null;
}

const lookAt = (environment: Environment | null): [number, number, number] => (environment && VIEWS[environment.domain].target?.(environment)) || [0, 0, 0];

function CameraRig() {
  const environment = useStore((s) => s.environment);
  const key = useStore((s) => s.environmentKey);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const position = environment ? VIEWS[environment.domain].camera(environment) : ([-6, 30, 30] as const);
    const [tx, ty, tz] = lookAt(environment);
    camera.position.set(position[0] + tx, position[1] + ty, position[2] + tz);
    camera.lookAt(tx, ty, tz);
  }, [key, environment === null, camera]);
  return null;
}

function ViewShift() {
  const open = useStore((s) => Boolean(s.report) && s.reportOpen);
  const shift = useRef(0);
  useFrame(({ camera, size }) => {
    // Lifts the scene so the failed part stays visible above the recovery sheet
    const target = open ? size.height * 0.26 : 0;
    shift.current = reducedMotion() ? target : shift.current + (target - shift.current) * 0.09;
    (camera as THREE.PerspectiveCamera).setViewOffset(size.width, size.height, 0, shift.current, size.width, size.height);
  });
  return null;
}

export function Scene() {
  const environment = useStore((s) => s.environment);
  const key = useStore((s) => s.environmentKey);
  const rebuilds = useStore((s) => s.rebuilds);
  const View = environment ? VIEWS[environment.domain].Scene : null;
  return (
    <Canvas
      className="stage"
      style={{ position: 'fixed' }}
      shadows
      dpr={[1, 1.75]}
      camera={{ fov: 30, near: 1, far: 400, position: [-6, 30, 30] }}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.4 }}
    >
      {/* Mirrors --color-bg, --color-accent and --color-teal in tokens.css */}
      <color attach="background" args={['#06090f']} />
      <fog attach="fog" args={['#06090f', 90, 220]} />
      <ambientLight intensity={1.1} color="#9db2e0" />
      <directionalLight
        position={[-14, 26, 12]}
        intensity={2.8}
        color="#dfe8ff"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-camera-far={90}
        shadow-bias={-0.0004}
      />
      <pointLight position={[14, 7, 8]} intensity={110} color="#ffb347" distance={34} />
      <pointLight position={[-16, 8, -10]} intensity={90} color="#3fd6c8" distance={34} />
      <Clock />
      <CameraRig />
      <ViewShift />
      {View && (
        <group key={`${key}:${rebuilds}`}>
          <View />
        </group>
      )}
      <OrbitControls makeDefault enableDamping={!reducedMotion()} dampingFactor={0.08} maxPolarAngle={1.32} minDistance={10} maxDistance={160} target={lookAt(environment)} />
      <EffectComposer multisampling={0}>
        <Bloom intensity={0.75} luminanceThreshold={1} luminanceSmoothing={0.2} mipmapBlur />
        <Vignette eskil={false} offset={0.28} darkness={0.72} />
      </EffectComposer>
    </Canvas>
  );
}
