// npm run roomcheck [-- seconds] : load the crowd demo in headless Chrome against the running office server and check
// that every shared room and spot actually gets used within the given time (default 480 s): the coffee machine, the
// café table, the lounge, a WC, the huddle room and the meeting room (kickoffs). Exits 1, naming what
// was never used, if anything is missing. Needs Google Chrome and the server on CONFIG.port (npm start / the service).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../server/config.js';

const secs = Number(process.argv[2]) || 480;
const CH = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-roomcheck-'));
const port = 9300 + Math.floor(Math.random() * 500);
const ch = spawn(CH, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-extensions',
  '--window-size=1200,800', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const done = code => { try { ch.kill(); } catch { /* gone */ } process.exit(code); };
let list;
for (let i = 0; i < 50 && !list?.find(t => t.type === 'page'); i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { /* starting */ } await sleep(200); }
const page = list?.find(t => t.type === 'page');
if (!page) { console.error('roomcheck: Chrome did not start'); done(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') console.error('page exception:', m.params.exceptionDetails.exception?.description?.split('\n')[0]); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Runtime.enable');
await send('Page.navigate', { url: `http://localhost:${CONFIG.port}/?demo&crowd=30&hour=13` });
await sleep(6000);
// sample every 0.4 s in the page: who used what (a Set per spot, read back at the end)
const ok = await evalJs(`(() => { const m = window.__office?.mgr; if (!m) return false;
  const u = window.__rooms = { coffee: new Set(), cafe: new Set(), lounge: new Set(), wc: new Set(), huddle: new Set(), meeting: new Set() };
  setInterval(() => {
    for (const w of m.list) {
      if (w.state === 'brew') u.coffee.add(w.name);
      if (w.state === 'break' && w.seat?.style === 'cafe') u.cafe.add(w.name);
      if (w.state === 'break' && w.seat && w.seat.style !== 'cafe') u.lounge.add(w.name);
      if (w.state === 'ambient' && w.ambientKind === 'wc') u.wc.add(w.name);
    }
    m.floors.forEach((f, k) => {
      for (const [key, r] of [['huddle', f.huddle], ['meeting', f.meeting]]) if (r?.session && r.team) u[key].add(k + 1 + 'F:' + r.team.name);
    });
  }, 400); return true; })()`);
if (!ok) { console.error('roomcheck: the office did not load'); done(2); }
const t0 = Date.now();
while (Date.now() - t0 < secs * 1000) { await sleep(15000); process.stdout.write(`\rroomcheck: ${Math.round((Date.now() - t0) / 1000)}/${secs} s`); }
const used = await evalJs('Object.fromEntries(Object.entries(window.__rooms).map(([k, v]) => [k, [...v]]))');
console.log('');
let missing = [];
for (const [k, v] of Object.entries(used)) { console.log(`${v.length ? '✔' : '✘'} ${k.padEnd(8)} ${v.slice(0, 6).join(', ')}${v.length > 6 ? ` … (${v.length})` : ''}`); if (!v.length) missing.push(k); }
if (missing.length) { console.error(`roomcheck: never used in ${secs} s: ${missing.join(', ')}`); done(1); }
console.log(`roomcheck: every room used within ${secs} s`); done(0);
