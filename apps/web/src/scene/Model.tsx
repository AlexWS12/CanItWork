import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { reducedMotion } from '../motion';

// Models from Kenney's CC0 packs, copied into public/models by scripts/models.mjs (CREDITS.md lists them).
// A model is asked for by size, not scale: it is fitted to the height or footprint it should have, centred and stood on the floor,
// so every pack's own units and origins stop mattering. While it loads, or if it can't, the caller's own drawing shows instead.

export type ModelId = `${'characters' | 'vehicles' | 'industrial' | 'suburban' | 'commercial' | 'watercraft' | 'factory' | 'furniture' | 'nature'}/${string}`;

const url = (id: ModelId) => `/models/${id}.glb`;

interface Fit {
  /** Height to fit, in scene units. */
  height?: number;
  /** Largest side of the footprint to fit, in scene units; used when no height is given. */
  width?: number;
}

const bounds = new WeakMap<THREE.Object3D, THREE.Box3>();
const sizeOf = (scene: THREE.Object3D) => {
  let box = bounds.get(scene);
  if (!box) {
    box = new THREE.Box3().setFromObject(scene);
    bounds.set(scene, box);
  }
  return box;
};

function useFitted(id: ModelId, fit: Fit) {
  const { scene, animations } = useGLTF(url(id));
  return useMemo(() => {
    const copy = clone(scene);
    copy.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    const box = sizeOf(scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = fit.height ? fit.height / Math.max(size.y, 1e-6) : fit.width ? fit.width / Math.max(size.x, size.z, 1e-6) : 1;
    const holder = new THREE.Group();
    copy.scale.setScalar(scale);
    const center = box.getCenter(new THREE.Vector3());
    copy.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    holder.add(copy);
    return { object: holder, animations, model: copy };
  }, [scene, animations, fit.height, fit.width]);
}

interface ModelProps extends Fit {
  id: ModelId;
  position?: [number, number, number];
  /** Turn about the vertical axis, in radians. */
  rotation?: number;
  /** An animation the model carries to play in a loop, such as a character's "idle" or "walk". */
  play?: string;
}

function Loaded({ id, height, width, position, rotation = 0, play }: ModelProps) {
  const { object, animations, model } = useFitted(id, { height, width });
  const mixer = useMemo(() => (play && animations.length ? new THREE.AnimationMixer(model) : null), [play, animations, model]);
  useEffect(() => {
    if (!mixer || !play) return;
    const clip = THREE.AnimationClip.findByName(animations, play);
    if (!clip) return;
    const action = mixer.clipAction(clip);
    // Each copy starts at its own point in the loop, so a crowd doesn't move in lockstep
    action.play();
    mixer.setTime(Math.random() * clip.duration);
    return () => void mixer.stopAllAction();
  }, [mixer, play, animations]);
  useFrame((_, dt) => {
    if (mixer && !reducedMotion()) mixer.update(dt);
  });
  return <primitive object={object} position={position} rotation={[0, rotation, 0]} />;
}

class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** A pack model fitted to the size asked for; `fallback` (the code-built drawing) shows while it loads and if it can't. */
export function Model({ fallback = null, ...props }: ModelProps & { fallback?: ReactNode }) {
  return (
    <Fallback fallback={fallback}>
      <Suspense fallback={fallback}>
        <Loaded {...props} />
      </Suspense>
    </Fallback>
  );
}

/** One model inside a `Packed` group, which handles loading and failure for the whole group at once. */
export const Piece = Loaded;

/**
 * Several models drawn together as one thing (a ward of beds, a call-centre floor). Until every one has loaded, or if any can't,
 * the whole code-built drawing shows instead, so a half-loaded scene never mixes the two.
 */
export function Packed({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return (
    <Fallback fallback={fallback}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </Fallback>
  );
}

const instanced = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>();

/**
 * A pack model as one geometry and one material, for an instancedMesh that draws hundreds of copies in a single call (crates,
 * belt segments). Baked to fit a unit cube: centred on the origin, its largest side 1, so callers scale it like a unit box.
 * Suspends while loading; put it inside `Packed` with the code-built drawing as the fallback.
 */
export function useInstancedModel(id: ModelId) {
  const { scene } = useGLTF(url(id));
  return useMemo(() => {
    const cached = instanced.get(id);
    if (cached) return cached;
    scene.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    let material: THREE.Material | undefined;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      material ??= Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      parts.push(g.index ? g.toNonIndexed() : g);
    });
    const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts)!;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    geometry.translate(-centre.x, -centre.y, -centre.z);
    geometry.scale(1 / size.x, 1 / size.y, 1 / size.z);
    geometry.computeBoundingSphere();
    const made = { geometry, material: material! };
    instanced.set(id, made);
    return made;
  }, [id, scene]);
}

/** Starts fetching models a view is about to draw, so they arrive with the design instead of after it. */
export const preloadModels = (ids: ModelId[]) => ids.forEach((id) => useGLTF.preload(url(id)));

export const CHARACTERS: ModelId[] = [
  'characters/character-male-a',
  'characters/character-female-a',
  'characters/character-male-b',
  'characters/character-female-b',
  'characters/character-male-c',
  'characters/character-female-c',
  'characters/character-male-d',
  'characters/character-female-d',
  'characters/character-male-e',
  'characters/character-female-e',
  'characters/character-male-f',
  'characters/character-female-f',
];
