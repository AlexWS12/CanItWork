import { advance } from '@react-three/fiber';
import type { WebGLRenderer } from 'three';
import { clearArea } from './Stage';

// A picture of the system as it sits on screen, taken when it is saved, for its card in My systems.

let gl: WebGLRenderer | null = null;
export const setSnapshotRenderer = (renderer: WebGLRenderer | null) => {
  gl = renderer;
};

/** A small JPEG data URL of the part of the 3D view the panels leave clear, or null when there is nothing to picture. */
export function snapshotView(width = 480, height = 360): string | null {
  if (!gl) return null;
  const canvas = gl.domElement;
  if (!canvas.clientWidth || !canvas.clientHeight) return null;
  const scale = canvas.width / canvas.clientWidth;
  // The largest box of the picture's shape centred on the clear area, where the camera framed the system
  const area = clearArea(canvas.clientWidth, canvas.clientHeight);
  const cx = (area.x0 + area.x1) / 2;
  const cy = (area.y0 + area.y1) / 2;
  let w = area.x1 - area.x0;
  let h = area.y1 - area.y0;
  if (w / h > width / height) w = (h * width) / height;
  else h = (w * height) / width;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  // Render a frame now: straight after a render, before the browser composites, the drawing buffer still holds it
  advance(performance.now());
  ctx.drawImage(canvas, (cx - w / 2) * scale, (cy - h / 2) * scale, w * scale, h * scale, 0, 0, width, height);
  try {
    return out.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
