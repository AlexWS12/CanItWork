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
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.captures', label);
mkdirSync(out, { recursive: true });

// Software WebGL, so captures work without a GPU or a visible window
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => console.error('page error:', error.message));
await page.goto(url);
await page.waitForFunction(() => 'shoot' in (window.__tv ?? {}), null, { timeout: 30000 });

const stats = {};
for (const domain of domains) {
  try {
    const shot = await page.evaluate((d) => window.__tv.shoot(d), domain);
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

writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stats, null, 2));
await browser.close();
console.log(`Saved to ${out}`);
