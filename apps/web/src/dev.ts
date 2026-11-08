import { DOMAINS, type Environment } from '@tv/core';
import { advance } from '@react-three/fiber';
import * as THREE from 'three';
import type { WebGLRenderer } from 'three';
import { openShowcase } from './actions';
import { runner } from './runner';
import { useStore } from './store';

// Development tools for judging the 3D views: open any kind of system without agents, run it, measure it and take a picture.
// `npm run capture -w @tv/web` drives these from a headless browser and saves the results in apps/web/.captures.

let gl: WebGLRenderer | null = null;
let content: THREE.Object3D | null = null;
export const registerRenderer = (renderer: WebGLRenderer, root: THREE.Object3D | null) => {
  gl = renderer;
  content = root;
};

// The meshes that make up the framed bounds, largest first, to find what pushes the camera back.
function boundsReport(top = 8, by: 'size' | 'tris' = 'size') {
  if (!content) return [];
  const box = new THREE.Box3();
  const rows: Array<{ size: number; tris: number; type: string; geometry: string; parent: string; count?: number }> = [];
  content.updateWorldMatrix(true, true);
  content.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (o.userData.floor || !mesh.isMesh) return;
    const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
    if (instanced) instanced.computeBoundingBox();
    else if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.copy(instanced ? instanced.boundingBox! : mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    const index = mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0;
    rows.push({
      size: Math.round(box.getSize(new THREE.Vector3()).length() * 10) / 10,
      tris: Math.round((index / 3) * (instanced?.count ?? 1)),
      type: mesh.type,
      geometry: mesh.geometry.type,
      parent: mesh.parent?.type ?? '',
      count: instanced?.count,
    });
  });
  return rows.sort((a, b) => b[by] - a[by]).slice(0, top);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function renderer() {
  for (let i = 0; !gl && i < 200; i++) await wait(50);
  if (!gl) throw new Error('The scene never rendered');
  return gl;
}

// Renders a frame now instead of waiting for one: a browser that isn't painting the page gives it no animation frames.
let clock = performance.now();
const frame = () => {
  clock = Math.max(clock + 1000 / 60, performance.now());
  advance(clock);
};

// Opens a hand-made environment, such as a showcase design with an odd part added, to see how the views cope.
// Its spec goes through the domain's schema first, so a hand-made part gets the same defaults a designed one would.
// A spec the schema refuses (an unknown kind, say) is opened as given, to see how the views cope with it anyway.
function openEnvironment(given: Environment) {
  const parsed = DOMAINS[given.domain].specSchema.safeParse(given.spec);
  const environment = { ...given, spec: parsed.success ? parsed.data : given.spec };
  runner.replay(environment, 1, 0, []);
  const s = useStore.getState();
  s.set({ environment, environmentKey: s.environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null });
  return environment;
}

// Runs the simulation a fixed stretch, rendering as it goes so animations that ease toward the simulation keep up.
function run(seconds: number) {
  for (let t = 0; t < seconds; t += 0.1) {
    runner.frame(0.1);
    frame();
  }
}

// Draw calls and triangles of whole frames (every pass, not only the composer's last one), and the CPU time spent rendering.
// Frame rate is left out on purpose: it would measure the browser window, not the scene.
async function stats(frames = 3) {
  const r = await renderer();
  const render = r.render.bind(r);
  let cpu = 0;
  r.render = (scene, camera) => {
    const start = performance.now();
    render(scene, camera);
    cpu += performance.now() - start;
  };
  r.info.autoReset = false;
  try {
    frame();
    r.info.reset();
    cpu = 0;
    for (let i = 0; i < frames; i++) frame();
    const { calls, triangles } = r.info.render;
    return { calls: Math.round(calls / frames), triangles: Math.round(triangles / frames), cpuMs: Math.round((cpu / frames) * 10) / 10 };
  } finally {
    r.render = render;
    r.info.autoReset = true;
  }
}

// Read straight after a render, before the browser composites, the drawing buffer still holds the finished image.
async function snapshot() {
  const r = await renderer();
  frame();
  return r.domElement.toDataURL('image/png');
}

// Opens a showcase design (or a hand-made environment), lets it run, then measures and pictures it.
async function shoot(what: string | Environment, { settle = 1200, seconds = 6 } = {}) {
  const environment = typeof what === 'string' ? await openShowcase(what) : openEnvironment(what);
  if (!environment) throw new Error(`No showcase design for ${String(what)}`);
  await renderer();
  await wait(settle);
  run(seconds);
  return { name: environment.name, ...(await stats()), png: await snapshot() };
}

export const devTools = { open: openShowcase, openEnvironment, run, stats, snapshot, shoot, boundsReport };
