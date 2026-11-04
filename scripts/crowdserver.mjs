// node scripts/crowdserver.mjs [port] [agents] : the crowd demo fed from a server instead of from the tab, so any number
// of tabs can watch one office (the real server has only the real agents). Serves the page like server/index.js;
// used by `npm run synccheck`. Nothing here touches real sessions or the data folder.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startCrowdDemo } from '../web/demo.js';
import { Director } from '../web/director.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web'), THREE = path.join(ROOT, 'node_modules', 'three');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

export function startCrowdServer(port, n = 24) {
  let latest = null;
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = p.startsWith('/vendor/three/') ? path.join(THREE, p.slice('/vendor/three/'.length)) : path.join(WEB, p === '/' ? 'index.html' : p);
    let ok = false;
    try { ok = (file.startsWith(WEB) || file.startsWith(THREE)) && statSync(file).isFile(); } catch { /* missing */ }
    if (!ok) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => { if (latest) ws.send(latest); });
  const director = new Director({ seed: 7 });
  const timer = startCrowdDemo(snap => {
    snap.plan = director.update(snap.agents, snap.events, snap.now, snap.config);
    latest = JSON.stringify(snap);
    for (const c of wss.clients) if (c.readyState === 1) c.send(latest);
  }, n);
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ close() { clearInterval(timer); for (const c of wss.clients) c.terminate(); server.close(); } })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 4478, n = Number(process.argv[3]) || 24;
  await startCrowdServer(port, n);
  console.log(`crowd office → http://localhost:${port} (${n} agents)`);
}
