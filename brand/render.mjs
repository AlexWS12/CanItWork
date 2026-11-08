// Renders the CanItWork logo set (logo 2, "Blueprint to Solid") to PNG files in this folder.
// Usage, with the web app's Playwright: node brand/render.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.dirname(fileURLToPath(import.meta.url));
const AMBER = '#f4b04a';
const BLUE = '#8fb3ec';
const GRAPHITE = '#0b0c0f';
const TILE = '#15171c';

// The cube: two dashed blueprint faces and one solid face. Below about 48px the dashes close up, so small sizes draw them solid.
const mark = (px, { blue = BLUE, amber = AMBER, dashed = px >= 48 } = {}) => {
  const stroke = px >= 48 ? 5.5 : 7;
  return `<svg width="${px}" height="${px}" viewBox="-50 -50 100 100" xmlns="http://www.w3.org/2000/svg">
    <path d="M0,-40 L34.6,-20 L0,0 L-34.6,-20 Z M-34.6,-20 L0,0 L0,40 L-34.6,20 Z" fill="none" stroke="${blue}" stroke-width="${stroke}" ${dashed ? 'stroke-dasharray="9 7"' : ''} stroke-linejoin="round"/>
    <path d="M0,0 L34.6,-20 L34.6,20 L0,40 Z" fill="${amber}"/>
  </svg>`;
};

const word = (size, light) =>
  `<span style="font: ${size}px/1 'Space Grotesk', sans-serif; letter-spacing: -0.02em; white-space: nowrap">` +
  `<span style="font-weight: 400; color: ${light ? '#5d636e' : '#9aa1ad'}">CanIt</span>` +
  `<span style="font-weight: 600; color: ${light ? '#17191e' : '#eef0f3'}">Work</span></span>`;

const page = (w, h, body, bg = 'transparent') => `<!doctype html><html><head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap">
  <style>html,body{margin:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden}
  .c{width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;box-sizing:border-box}</style>
  </head><body>${body}</body></html>`;

const jobs = [];
// The mark alone, transparent, at the usual icon sizes
for (const px of [1024, 512, 256, 128, 64]) jobs.push([`logo-mark-${px}.png`, px, px, page(px, px, `<div class="c">${mark(px * 0.92)}</div>`)]);
// App icons: the mark on a rounded graphite tile (the rounding is drawn, so it works where the platform doesn't round)
for (const [name, px] of [
  ['app-icon-1024.png', 1024],
  ['app-icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
]) {
  jobs.push([name, px, px, page(px, px, `<div class="c" style="background:${TILE};border-radius:${px * 0.22}px">${mark(px * 0.68)}</div>`)]);
}
// Favicons: the mark on a square tile, solid lines, so it stays crisp in a browser tab
for (const px of [48, 32, 16])
  jobs.push([`favicon-${px}.png`, px, px, page(px, px, `<div class="c" style="background:${TILE};border-radius:${px * 0.18}px">${mark(px * 0.86, { dashed: false })}</div>`)]);
// Wordmark lockups: transparent, for dark and for light backgrounds
const lockup = (light) => `<div class="c" style="gap:44px">${mark(220, light ? { blue: '#3a6fc0', amber: '#e39a20' } : {})}${word(150, light)}</div>`;
jobs.push(['logo-wordmark-dark.png', 1400, 360, page(1400, 360, lockup(false))]);
jobs.push(['logo-wordmark-light.png', 1400, 360, page(1400, 360, lockup(true))]);
jobs.push(['logo-wordmark-on-graphite.png', 1400, 360, page(1400, 360, lockup(false), GRAPHITE)]);
jobs.push(['logo-wordmark-on-white.png', 1400, 360, page(1400, 360, lockup(true), '#ffffff')]);
// Banners: social preview (1200x630), GitHub (1280x640) and a wide header (1500x500)
const banner = (w, h, scale) =>
  page(
    w,
    h,
    `<div class="c" style="flex-direction:column;gap:${28 * scale}px;background:radial-gradient(${w * 0.7}px ${h * 0.7}px at 50% 30%, rgba(244,176,74,0.10), transparent), ${GRAPHITE}">
      <div style="display:flex;align-items:center;gap:${26 * scale}px">${mark(130 * scale)}${word(96 * scale, false)}</div>
      <div style="font: 500 ${30 * scale}px/1.3 'Space Grotesk', sans-serif; color:#a9afba; letter-spacing:-0.01em">Describe any system. Watch it run in 3D, checked by a simulator.</div>
    </div>`,
  );
jobs.push(['banner-social-1200x630.png', 1200, 630, banner(1200, 630, 1)]);
jobs.push(['banner-github-1280x640.png', 1280, 640, banner(1280, 640, 1.04)]);
jobs.push(['banner-header-1500x500.png', 1500, 500, banner(1500, 500, 0.92)]);

const browser = await chromium.launch();
for (const [name, w, h, html] of jobs) {
  const tab = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await tab.setContent(html, { waitUntil: 'networkidle' });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: path.join(out, name), omitBackground: true });
  await tab.close();
  console.log(name);
}
await browser.close();
