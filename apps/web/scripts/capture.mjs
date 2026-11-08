// Pictures every kind of system in a headless browser, with draw calls and triangles, so 3D changes can be compared.
// Usage: npm run capture -w @tv/web -- <label> [domain ...] [--ui] [--url=http://localhost:5175]
//   Saves apps/web/.captures/<label>/<domain>.png (the 3D canvas), <domain>-ui.png with --ui (the whole page), and stats.json.
// The dev server must be running; captures use its window.__tv tools, so nothing is designed and nothing is spent.
import { mkdirSync, writeFileSync } from 'node:fs';
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(out, 'landing-phone.png') });
  await browser.close();
  console.log(`Saved the landing page to ${out}`);
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
