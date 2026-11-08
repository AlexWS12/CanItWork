import type { Environment } from '@tv/core';
import { advance } from '@react-three/fiber';
import type { WebGLRenderer } from 'three';
import { useStore } from './store';
import { openShowcase } from './actions';
import { runner } from './runner';

// Development tools for judging the 3D views: open any kind of system without agents, and capture or measure the canvas.
// `npm run capture` starts the receiver that saves captures into apps/web/.captures.

let gl: WebGLRenderer | null = null;
export const registerRenderer = (renderer: WebGLRenderer) => void (gl = renderer);

// Renders a frame now instead of waiting for one: a pane the browser isn't painting gets no animation frames at all.
let clock = performance.now();
const nextFrame = async () => {
  clock = Math.max(clock + 1000 / 60, performance.now());
  advance(clock);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Read straight after a render, before the browser composites, the drawing buffer still holds the finished image.
async function capture(name: string) {
  if (!gl) throw new Error('The scene has not rendered yet');
  await nextFrame();
  const png = gl.domElement.toDataURL('image/png');
  const res = await fetch(`http://127.0.0.1:5199/?name=${encodeURIComponent(name)}`, { method: 'POST', body: png });
  return res.json();
}

// Draw calls and triangles of a whole frame (every pass, not only the composer's last one), and the CPU time spent rendering it.
// Frame rate is left out on purpose: a backgrounded browser throttles animation frames, so it would measure the window, not the scene.
async function stats(frames = 3) {
  const renderer = gl;
  if (!renderer) throw new Error('The scene has not rendered yet');
  const render = renderer.render.bind(renderer);
  let cpu = 0;
  renderer.render = (scene, camera) => {
    const start = performance.now();
    render(scene, camera);
    cpu += performance.now() - start;
  };
  renderer.info.autoReset = false;
  try {
    await nextFrame();
    renderer.info.reset();
    cpu = 0;
    for (let i = 0; i < frames; i++) await nextFrame();
    const { calls, triangles } = renderer.info.render;
    return { calls: Math.round(calls / frames), triangles: Math.round(triangles / frames), cpuMs: Math.round((cpu / frames) * 10) / 10 };
  } finally {
    renderer.render = render;
    renderer.info.autoReset = true;
  }
}

// Opens every kind of system in turn, lets it run, then captures and measures it.
async function tour(domains: string[], { settle = 1500, run = 6, prefix = '' } = {}) {
  const results: Record<string, unknown> = {};
  for (const domain of domains) {
    const environment = await openShowcase(domain);
    if (!environment) {
      results[domain] = 'no showcase design';
      continue;
    }
    await wait(settle);
    // Runs the simulation a fixed stretch first, so every capture shows the system mid-run whatever the frame rate.
    // Rendering frames as it goes lets animations that ease toward the simulation (robots, cameras) catch up.
    for (let t = 0; t < run; t += 0.1) {
      runner.frame(0.1);
      await nextFrame();
    }
    results[domain] = { ...(await stats()), file: (await capture(`${prefix}${domain}`)).file };
  }
  return results;
}

// Opens a hand-made environment, such as a showcase design with an odd part added, to see how the views cope.
function openEnvironment(environment: Environment) {
  runner.replay(environment, 1, 0, []);
  const s = useStore.getState();
  s.set({ environment, environmentKey: s.environmentKey + 1, report: null, appliedId: null, selected: null, refusal: null });
}

export const devTools = { open: openShowcase, openEnvironment, capture, stats, tour };
