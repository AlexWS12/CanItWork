// Saves canvas captures sent by the dev tools (window.__tv.capture / tour) as PNGs in apps/web/.captures.
// Local only: it listens on 127.0.0.1 and answers only the dev server's pages.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.captures');
mkdirSync(out, { recursive: true });

createServer((req, res) => {
  const origin = req.headers.origin ?? '';
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST') return res.writeHead(405).end();
  const name = (new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? 'capture').replace(/[^a-z0-9_-]/gi, '') || 'capture';
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const file = path.join(out, `${name}.png`);
    writeFileSync(file, Buffer.from(body.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ file }));
  });
}).listen(5199, '127.0.0.1', () => console.log(`Saving captures to ${out}`));
