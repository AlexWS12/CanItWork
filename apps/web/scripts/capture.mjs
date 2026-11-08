// Pictures every kind of system in a headless browser, with draw calls and triangles, so 3D changes can be compared.
// Usage: npm run capture -w @tv/web -- <label> [domain ...] [--ui] [--url=http://localhost:5175]
//   Saves apps/web/.captures/<label>/<domain>.png (the 3D canvas), <domain>-ui.png with --ui (the whole page), and stats.json.
// The dev server must be running; captures use its window.__tv tools, so nothing is designed and nothing is spent.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ALL = ['electronics', 'software', 'database', 'warehouse', 'fleet', 'queues', 'hospital', 'power', 'water', 'supply', 'factory', 'airport', 'callcenter'];
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}`));
const [label = 'latest', ...picked] = args.filter((a) => !a.startsWith('--'));
const domains = picked.length ? picked : ALL;
const url = flag('url')?.split('=')[1] ?? 'http://localhost:5175';
// --settle=ms: how long each view gets to load (pack models) before it runs and is pictured
const settle = Number(flag('settle')?.split('=')[1] ?? 2500);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.captures', label);
mkdirSync(out, { recursive: true });

// Software WebGL, so captures work without a GPU or a visible window
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
// --phone: a 390 by 844 phone screen instead of a 1440 by 900 desktop
const page = await browser.newPage({ viewport: flag('phone') ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => console.error('page error:', error.message));
await page.goto(url);
await page.waitForFunction(() => 'shoot' in (window.__tv ?? {}), null, { timeout: 30000 });

const stats = {};
// --landing: the landing page with its live hero, at desktop and phone width, then stop
if (flag('landing')) {
  await page.waitForTimeout(9000);
  await page.screenshot({ path: path.join(out, 'landing.png') });
  // Each section below the first screen, scrolled into view
  for (const id of ['how', 'systems']) {
    await page.evaluate((s) => document.getElementById(s)?.scrollIntoView(), id);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(out, `landing-${id}.png`) });
  }
  await page.evaluate(() => document.getElementById('top')?.scrollIntoView());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(out, 'landing-phone.png') });
  await browser.close();
  console.log(`Saved the landing page to ${out}`);
  process.exit(0);
}
// --thumbs: a preview picture of every verified design, for the landing's system panels, then stop.
// Saves public/thumbs/<slug>.jpg and public/thumbs/index.json (prompt to file). Verified designs open as is: nothing is designed.
if (flag('thumbs')) {
  const thumbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/thumbs');
  mkdirSync(thumbs, { recursive: true });
  // Saved after every picture and merged into what is there, so a run can stop at any point and one kind can be redone alone
  const indexFile = path.join(thumbs, 'index.json');
  let index = {};
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8'));
  } catch {
    // First run
  }
  const done = new Set(flag('again') ? [] : Object.keys(index));
  let made = 0;
  for (const domain of domains) {
    const { verified } = await page.evaluate(async (d) => (await fetch(`/api/systems/${d}`)).json(), domain);
    for (const { prompt, name } of verified) {
      // Already pictured: skipped unless --again
      if (done.has(prompt)) continue;
      try {
        const { environment } = await page.evaluate(async (p) => (await fetch(`/api/verified?prompt=${encodeURIComponent(p)}`)).json(), prompt);
        const shot = await page.evaluate((e) => window.__tv.shoot(e, { settle: 1500 }), environment);
        // Crops to the system itself (anything brighter than the graphite floor), pads it, and fits it to a 4:3 picture
        const jpeg = await page.evaluate(async (png) => {
          const img = new Image();
          img.src = png;
          await img.decode();
          const full = new OffscreenCanvas(img.width, img.height);
          const fc = full.getContext('2d');
          fc.drawImage(img, 0, 0);
          const { data, width, height } = fc.getImageData(0, 0, img.width, img.height);
          let x0 = width,
            y0 = height,
            x1 = 0,
            y1 = 0;
          for (let y = 0; y < height; y += 2)
            for (let x = 0; x < width; x += 2) {
              const i = (y * width + x) * 4;
              if (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 > 72) {
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
              }
            }
          if (x1 <= x0) [x0, y0, x1, y1] = [0, 0, width, height];
          let w = (x1 - x0) * 1.3;
          let h = (y1 - y0) * 1.3;
          if (w / h > 4 / 3) h = (w * 3) / 4;
          else w = (h * 4) / 3;
          const cx = (x0 + x1) / 2;
          const cy = (y0 + y1) / 2;
          const out = new OffscreenCanvas(480, 360);
          const oc = out.getContext('2d');
          oc.fillStyle = '#0b0c0f';
          oc.fillRect(0, 0, 480, 360);
          oc.drawImage(img, cx - w / 2, cy - h / 2, w, h, 0, 0, 480, 360);
          const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let text = '';
          for (const b of bytes) text += String.fromCharCode(b);
          return btoa(text);
        }, shot.png);
        const slug = `${domain}-${createHash('sha1').update(prompt).digest('hex').slice(0, 10)}.jpg`;
        writeFileSync(path.join(thumbs, slug), Buffer.from(jpeg, 'base64'));
        index[prompt] = slug;
        made++;
        writeFileSync(indexFile, JSON.stringify(index, null, 2));
        console.log(`${domain.padEnd(12)} ${name}`);
      } catch (error) {
        console.error(`${domain} ${name}: ${error}`);
      }
    }
  }
  await browser.close();
  console.log(`Saved ${made} new previews (${Object.keys(index).length} in all) to ${thumbs}`);
  process.exit(0);
}
// --gallery: every pack model side by side, then stop
if (flag('gallery')) {
  await page.goto(`${url}/#gallery`);
  await page.waitForFunction(() => 'snapshot' in (window.__tv ?? {}), null, { timeout: 30000 });
  await page.waitForTimeout(9000);
  const png = await page.evaluate(() => window.__tv.snapshot());
  writeFileSync(path.join(out, 'gallery.png'), Buffer.from(png.split(',')[1], 'base64'));
  await page.screenshot({ path: path.join(out, 'gallery-ui.png') });
  await browser.close();
  console.log(`Saved the gallery to ${out}`);
  process.exit(0);
}
for (const domain of domains) {
  try {
    const shot = await page.evaluate(([d, ms]) => window.__tv.shoot(d, { settle: ms }), [domain, settle]);
    writeFileSync(path.join(out, `${domain}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
    if (flag('ui')) await page.screenshot({ path: path.join(out, `${domain}-ui.png`) });
    // --bounds: the meshes that set the camera's framing, largest first; with --tris, the heaviest meshes instead
    if (flag('bounds'))
      for (const r of await page.evaluate((by) => window.__tv.boundsReport(8, by), flag('tris') ? 'tris' : 'size'))
        console.log(`   ${String(r.size).padStart(7)} ${String(r.tris).padStart(7)} tris  ${r.geometry} in ${r.parent}${r.count === undefined ? '' : ` ×${r.count}`}`);
    stats[domain] = { name: shot.name, calls: shot.calls, triangles: shot.triangles, cpuMs: shot.cpuMs };
    console.log(
      `${domain.padEnd(12)} ${String(shot.calls).padStart(5)} calls ${String(Math.round(shot.triangles / 1000)).padStart(5)}k tris ${String(shot.cpuMs).padStart(6)} ms cpu  ${shot.name}`,
    );
  } catch (error) {
    stats[domain] = { error: String(error) };
    console.error(`${domain}: ${error}`);
  }
}
// --stress: showcase designs bent to hit the views' edge cases, such as a kind or part they have no model for
if (flag('stress')) {
  const cases = await page.evaluate(async () => {
    const get = async (d) => (await (await fetch(`/api/examples/${d}`)).json()).environment;
    const custom = (id, label, extra = {}) => ({ id, type: 'custom', ...extra, custom: { label, pins: ['a', 'b'], paths: [{ a: 'a', b: 'b', ohms: 100 }], visual: [] } });
    const hospital = await get('hospital');
    hospital.spec.nodes[2].kind = 'helipad';
    const bench = await get('electronics');
    bench.spec.layout = 'bench';
    bench.spec.parts.push(custom('X1', 'Peltier cooler'), custom('X2', 'Gear motor', { package: 'motor' }));
    return { 'stress-network': hospital, 'stress-electronics': bench };
  });
  for (const [name, environment] of Object.entries(cases)) {
    try {
      const shot = await page.evaluate((e) => window.__tv.shoot(e), environment);
      writeFileSync(path.join(out, `${name}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
      if (flag('ui')) await page.screenshot({ path: path.join(out, `${name}-ui.png`) });
      stats[name] = { calls: shot.calls, triangles: shot.triangles };
      console.log(`${name.padEnd(20)} ${shot.calls} calls ${Math.round(shot.triangles / 1000)}k tris`);
    } catch (error) {
      stats[name] = { error: String(error) };
      console.error(`${name}: ${error}`);
    }
  }
}

// --build: replays a build with a stubbed stream (domain, two drafts, the design), picturing each stage. No model is called.
if (flag('build')) {
  await page.evaluate(async () => {
    const { environment } = await (await fetch('/api/examples/hospital')).json();
    const first = {
      ...environment,
      spec: {
        ...environment.spec,
        nodes: environment.spec.nodes.slice(0, 4),
        edges: environment.spec.edges.filter((e) => environment.spec.nodes.slice(0, 4).some((n) => n.id === e.to)),
      },
    };
    const script = [
      [300, { type: 'step', id: 's1', agent: 'interpreter', engine: 'jev', title: 'Identifying the domain', status: 'done', ms: 300 }],
      [100, { type: 'domain', domain: 'hospital' }],
      [2500, { type: 'draft', attempt: 0, environment: first, issues: ['Triage is over capacity'] }],
      [2500, { type: 'draft', attempt: 1, environment, issues: [] }],
      [2500, { type: 'environment', environment }],
      [100, { type: 'done' }],
    ];
    const real = window.fetch.bind(window);
    window.fetch = (url, init) => {
      const encoder = new TextEncoder();
      // The Explainer would spend a model call after the build; it gets an empty answer instead
      if (String(url).includes('/api/explain'))
        return Promise.resolve(new Response(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`), { headers: { 'content-type': 'text/event-stream' } }));
      if (!String(url).includes('/api/build')) return real(url, init);
      const body = new ReadableStream({
        async start(controller) {
          for (const [wait, event] of script) {
            await new Promise((r) => setTimeout(r, wait));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    };
    void window.__tv.actions.buildEnvironment('An emergency room on a busy night, never seen before');
  });
  for (const [ms, name] of [
    [1200, 'build-1-stage'],
    [2500, 'build-2-draft'],
    [2500, 'build-3-repaired'],
    [3500, 'build-4-design'],
  ]) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`saved ${name}`);
  }
}

writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stats, null, 2));
await browser.close();
console.log(`Saved to ${out}`);
