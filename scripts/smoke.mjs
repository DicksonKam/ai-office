// Start the real server as a stranger would have it: an empty home folder, no agents, no earlier records. Exits 1, naming
// what failed, if it does not come up, serve the page, or refuse another web site. Touches nothing of a running office.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-smoke-'));
const port = 4400 + Math.floor(Math.random() * 90), base = `http://localhost:${port}`;
let log = '';
const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], { cwd: ROOT, env: { ...process.env, HOME: home, AI_OFFICE_PORT: String(port), AI_OFFICE_DATA_DIR: path.join(home, 'data') } });
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const socket = origin => new Promise(done => {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { origin });
  ws.on('message', () => { ws.close(); done('open'); });
  ws.on('unexpected-response', (_, r) => done(`refused ${r.statusCode}`));
  ws.on('error', e => done(`error ${e.message}`));
});

let state = null;
for (let i = 0; i < 60 && !state; i++) {
  await sleep(500);
  if (server.exitCode !== null) break;
  try { const r = await fetch(`${base}/api/state`); if (r.ok) state = await r.json(); } catch { /* not up yet */ }
}
check(!!state, 'the server comes up and answers with a state');
if (state) {
  check(state.agents.length === 0, 'an empty home folder means an empty office');
  check((await fetch(`${base}/`)).status === 200, 'the page is served');
  check((await fetch(`${base}/vendor/three/build/three.module.js`)).status === 200, 'three.js is served');
  check((await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.example' } })).status === 403, 'another web site gets no data');
  check((await fetch(`${base}/`)).headers.get('access-control-allow-origin') === null, 'no cross-site permission is offered');
  check((await socket('https://evil.example')).startsWith('refused'), 'another web site gets no live feed');
  check((await socket(base)) === 'open', 'the page itself gets the live feed');
}
server.kill();
if (fails.length) console.log(`\nserver log:\n${log}`);
process.exit(fails.length ? 1 : 0);
