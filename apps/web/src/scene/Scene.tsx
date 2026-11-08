import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { registerRenderer } from '../dev';
import { VIEWS } from '../domains';
import { reducedMotion } from '../motion';
import { runner } from '../runner';
import { useStore } from '../store';
import { BlueprintLook, EmptyStage } from './Blueprint';
import { setSnapshotRenderer } from './snapshot';
import { Gallery } from './Gallery';
import { Stage, framingOffset } from './Stage';

// Hands the renderer to the development tools that capture and measure the canvas.
function DevRenderer({ content }: { content: React.RefObject<THREE.Group> }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => registerRenderer(gl, content.current), [gl, content]);
  return null;
}

// Lets Save take a picture of the view for the system's card
function SnapshotRenderer() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    setSnapshotRenderer(gl);
    return () => setSnapshotRenderer(null);
  }, [gl]);
  return null;
}

function Clock() {
  useFrame((_, dt) => runner.frame(dt));
  return null;
}

// Keeps the system in the screen area the panels leave clear, and lifts it above the recovery sheet when that is open.
function ViewShift() {
  const open = useStore((s) => Boolean(s.report) && s.reportOpen);
  const shift = useRef({ x: 0, y: 0 });
  useFrame(({ camera, size }) => {
    const x = framingOffset.x;
    const y = framingOffset.y + (open ? size.height * 0.26 : 0);
    const ease = reducedMotion() ? 1 : 0.09;
    shift.current.x += (x - shift.current.x) * ease;
    shift.current.y += (y - shift.current.y) * ease;
    (camera as THREE.PerspectiveCamera).setViewOffset(size.width, size.height, shift.current.x, shift.current.y, size.width, size.height);
  });
  return null;
}

export function Scene() {
  const environment = useStore((s) => s.environment);
  const key = useStore((s) => s.environmentKey);
  const rebuilds = useStore((s) => s.rebuilds);
  const content = useRef<THREE.Group>(null);
  const View = environment ? VIEWS[environment.domain].Scene : null;
  return (
    <Canvas
      className="stage"
      style={{ position: 'fixed' }}
      shadows
      dpr={[1, 1.75]}
      camera={{ fov: 30, near: 0.5, far: 600, position: [-6, 30, 30] }}
      gl={{ antialias: false, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.15 }}
    >
      <Stage content={content} />
      <Clock />
      <SnapshotRenderer />
      {import.meta.env.DEV && <DevRenderer content={content} />}
      <ViewShift />
      <group ref={content}>
        {View && <View key={`${key}:${rebuilds}`} />}
        <EmptyStage />
        {import.meta.env.DEV && location.hash === '#gallery' && <Gallery />}
      </group>
      <BlueprintLook />
      <OrbitControls makeDefault enableDamping={!reducedMotion()} dampingFactor={0.08} maxPolarAngle={1.32} />
      {/* The composer renders the scene, so it carries the anti-aliasing; the canvas's own would be lost */}
      <EffectComposer multisampling={4}>
        <Bloom intensity={0.7} luminanceThreshold={1} luminanceSmoothing={0.2} mipmapBlur />
        <Vignette eskil={false} offset={0.3} darkness={0.6} />
      </EffectComposer>
    </Canvas>
  );
}
