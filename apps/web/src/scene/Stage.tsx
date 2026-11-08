import { Environment, Lightformer } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as Controls } from 'three-stdlib';
import { VIEWS } from '../domains';
import { reducedMotion } from '../motion';
import { useStore } from '../store';
import { LOOK } from './look';

// Light, framing and the idle orbit, shared by every kind of system.
// The camera is fitted to what the system is made of (floors excluded), inside the part of the screen the panels leave clear.

const IDLE_SECONDS = 8;
const box = new THREE.Box3();
const part = new THREE.Box3();
const corner = new THREE.Vector3();

// What the view drew, without its floor: a sprawling floor shouldn't push the camera back from a small system.
export function contentBounds(root: THREE.Object3D) {
  box.makeEmpty();
  root.updateWorldMatrix(true, true);
  root.traverseVisible((object) => {
    if (object.userData.floor || !(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const instanced = mesh as THREE.InstancedMesh;
      if (!instanced.count) return;
      instanced.computeBoundingBox();
      part.copy(instanced.boundingBox!);
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      part.copy(mesh.geometry.boundingBox!);
    }
    part.applyMatrix4(mesh.matrixWorld);
    if (!part.isEmpty() && Number.isFinite(part.max.x)) box.union(part);
  });
  return box;
}

// The screen area the panels leave clear, in pixels.
function clearArea(width: number, height: number) {
  const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
  const visible = (r: DOMRect | undefined) => r && r.width > 0 && r.height > 0;
  // On the landing page the copy column covers the left of the screen
  const left = rect('.panel.left') ?? rect('.landing-copy');
  // While building, the agents rail covers the right of the screen instead of the right panel
  const right = rect('.panel.right') ?? rect('.build-agents');
  const top = rect('.topbar');
  const dock = rect('.transport');
  const x0 = visible(left) && left!.right < width * 0.85 ? left!.right : 0;
  const x1 = visible(right) && right!.left > width / 2 ? right!.left : width;
  const y0 = visible(top) ? top!.bottom : 0;
  const y1 = visible(dock) && dock!.top > height / 2 ? dock!.top : height;
  return { x0, x1, y0, y1 };
}

/** Where the scene is shifted on screen so the system sits in the clear area; ViewShift adds the report sheet's lift. */
export const framingOffset = { x: 0, y: 0 };

// Puts the camera on the view's preferred angle and backs it off until the whole system fits the clear area, with a margin.
function fit(camera: THREE.PerspectiveCamera, bounds: THREE.Box3, direction: THREE.Vector3, size: { width: number; height: number }) {
  const center = bounds.getCenter(new THREE.Vector3());
  const area = clearArea(size.width, size.height);
  const fx = Math.max(0.3, (area.x1 - area.x0) / size.width) * 0.9;
  const fy = Math.max(0.3, (area.y1 - area.y0) / size.height) * 0.86;
  framingOffset.x = size.width / 2 - (area.x0 + area.x1) / 2;
  framingOffset.y = size.height / 2 - (area.y0 + area.y1) / 2;
  let distance = Math.max(bounds.getSize(corner).length(), 8) * 1.5;
  for (let i = 0; i < 6; i++) {
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    let reach = 0;
    for (let c = 0; c < 8; c++) {
      corner.set(c & 1 ? bounds.max.x : bounds.min.x, c & 2 ? bounds.max.y : bounds.min.y, c & 4 ? bounds.max.z : bounds.min.z);
      corner.applyMatrix4(camera.matrixWorldInverse);
      // How far off-centre the corner lands as a share of the half-screen the system may use
      const depth = Math.max(0.1, -corner.z);
      const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      reach = Math.max(reach, Math.abs(corner.x) / (depth * tan * camera.aspect * fx), Math.abs(corner.y) / (depth * tan * fy));
    }
    distance *= reach;
  }
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  return { center, distance };
}

export function Stage({ content }: { content: React.RefObject<THREE.Group> }) {
  const environment = useStore((s) => s.environment);
  const key = useStore((s) => s.environmentKey);
  // Before any design exists, the stage the Interpreter chose is framed instead
  const stage = useStore((s) => (s.environment ? null : s.stage));
  // The screen layout changes when a build ends (agents rail out, panels in), so the camera refits then too
  const building = useStore((s) => s.building);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as Controls | null;
  const size = useThree((s) => s.size);
  const scene = useThree((s) => s.scene);
  const key_ = useRef<THREE.DirectionalLight>(null);
  const rim = useRef<THREE.DirectionalLight>(null);
  const touched = useRef(false);
  const idle = useRef(0);

  // Frame once the view has mounted, and again when late pieces (grow-in shelves, loaded models) have settled, unless the person moved the camera.
  useEffect(() => {
    const domain = environment?.domain ?? stage;
    if (!domain) return;
    touched.current = false;
    const direction = new THREE.Vector3(...VIEWS[domain].direction).normalize();
    const frame = () => {
      if (touched.current || !content.current) return;
      const bounds = contentBounds(content.current);
      if (bounds.isEmpty()) return;
      const { center, distance } = fit(camera, bounds, direction, size);
      if (controls) {
        controls.target.copy(center);
        controls.minDistance = distance * 0.2;
        controls.maxDistance = distance * 3;
        controls.update();
      }
      const fog = scene.fog as THREE.Fog | null;
      if (fog) {
        fog.near = distance * 1.6;
        fog.far = distance * 4;
      }
      // Shadows cover the system and a little floor around it, so a big system keeps its shadows and a small one stays crisp
      const light = key_.current;
      if (light) {
        const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius * 1.25 + 4;
        light.position.copy(center).add(new THREE.Vector3(-0.55, 1, 0.45).multiplyScalar(radius * 1.6));
        light.target.position.copy(center);
        light.target.updateMatrixWorld();
        const shadow = light.shadow.camera;
        shadow.left = shadow.bottom = -radius;
        shadow.right = shadow.top = radius;
        shadow.near = 0.5;
        shadow.far = radius * 4;
        shadow.updateProjectionMatrix();
      }
      rim.current?.position.copy(center).add(new THREE.Vector3(0.6, 0.7, -1).multiplyScalar(60));
    };
    const timers = [80, 600, 1600].map((ms) => setTimeout(frame, ms));
    return () => timers.forEach(clearTimeout);
  }, [key, environment === null, stage, building, camera, controls, size.width, size.height]);

  // Any hand on the camera stops reframing and the idle orbit
  useEffect(() => {
    if (!controls) return;
    const start = () => {
      touched.current = true;
      idle.current = 0;
    };
    controls.addEventListener('start', start);
    return () => controls.removeEventListener('start', start);
  }, [controls]);

  // After a while untouched, the camera drifts slowly round the system
  useFrame((_, dt) => {
    if (!controls) return;
    idle.current = controls.enabled ? idle.current + dt : 0;
    controls.autoRotate = !reducedMotion() && idle.current > IDLE_SECONDS && Boolean(environment);
    controls.autoRotateSpeed = 0.35;
  });

  return (
    <>
      <color attach="background" args={[LOOK.background]} />
      <fog attach="fog" args={[LOOK.background, 90, 240]} />
      <hemisphereLight args={[LOOK.sky, LOOK.bounce, 0.55]} />
      <directionalLight
        ref={key_}
        position={[-14, 26, 12]}
        intensity={2.4}
        color={LOOK.key}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.03}
      />
      <directionalLight ref={rim} position={[20, 18, -30]} intensity={0.8} color={LOOK.rim} />
      {/* Soft studio panels for reflections on metal and glass; built here, so nothing is downloaded */}
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={1.4} color={LOOK.panel} scale={[18, 12, 1]} position={[-6, 12, 8]} rotation={[-Math.PI / 3, 0, 0]} />
        <Lightformer form="rect" intensity={0.7} color={LOOK.rim} scale={[14, 8, 1]} position={[10, 6, -12]} rotation={[0, Math.PI, 0]} />
        <Lightformer form="ring" intensity={0.5} color="#ffffff" scale={10} position={[0, 18, 0]} rotation={[Math.PI / 2, 0, 0]} />
      </Environment>
    </>
  );
}
