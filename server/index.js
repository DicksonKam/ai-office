import './preflight.js'; // first: a Node too old for the rest says so plainly
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CONFIG } from './config.js';
import { buildSnapshot } from './model.js';
import { Journal, localDate, isValidDay } from './journal.js';
import { logError, logRecovered } from './tail.js';
import { Director } from '../web/director.js';
import { jobBook, startedBy, openBook } from './model.js';
import { openLink } from './open.js';
import { JobBook } from './jobbook.js';
import { StartedBy } from './startedby.js';
import { scanSessionStarts } from './collectors/claude.js';
import { isLocalRequest } from './origin.js';
import { Uptime } from './uptime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const THREE = path.join(ROOT, 'node_modules', 'three');
const HEARTBEAT_MS = 4000;            // resend the snapshot at least this often (with a fresh `now`) even when nothing changed
const MAX_BUFFERED = 4 * 1024 * 1024; // a client this far behind skips snapshots until it catches up

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

function sendText(res, status, text) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function serveFile(res, filePath) {
  let st;
  try { st = await stat(filePath); } catch { return sendText(res, 404, 'not found'); }
  if (!st.isFile()) return sendText(res, 404, 'not found');
  const stream = createReadStream(filePath);
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    stream.pipe(res);
  });
  // vanished or unreadable between stat and read, or failed mid-way: answer 404 if nothing was sent yet, else cut it
  stream.on('error', () => sendText(res, 404, 'not found'));
  res.on('close', () => stream.destroy());
}

// No snapshot until the first poll finishes: a placeholder with nobody in it would make every client (and its day log)
// see the whole office leave and walk back in after each server restart.
let latestJson = null;
const journal = new Journal().load();
const uptime = new Uptime(path.join(CONFIG.dataDir, 'uptime.json'));
uptime.beat();
/** a film's records, with the stretches the office was not running */
function filmRecord(opts) { const r = journal.film(opts); r.gaps = uptime.gaps(r.from, r.to); return r; }

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const perfLog = [];
let lastOpenAt = 0;
async function handle(req, res) {
  if (!isLocalRequest(req.headers, CONFIG.port)) return sendText(res, 403, 'forbidden');
  let url, p;
  try {
    url = new URL(req.url, 'http://localhost');
    p = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'bad request');
  }
  if (p.includes('\0')) return sendText(res, 400, 'bad request');
  if (p === '/api/perf') { // ?perf readouts from a real browser, in memory only (the last 60)
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return sendJson(res, 413, { error: 'too large' }); }
      let d; try { d = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const num = k => (Number.isFinite(d?.[k]) ? +d[k] : null);
      const keep = { at: Date.now(), ua: typeof d?.ua === 'string' ? d.ua.slice(0, 160) : '', demo: d?.demo === true };
      for (const k of ['fps', 'medianMs', 'low1Fps', 'calls', 'triangles', 'floors', 'people', 'w', 'h', 'dpr', 'frames']) keep[k] = num(k);
      perfLog.push(keep); if (perfLog.length > 60) perfLog.shift();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, { entries: perfLog });
  }
  if (p === '/api/open') { // a worker card's button: names an agent, never a link
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    if (!req.headers.origin) return sendJson(res, 403, { error: 'from the office page only' });
    if (Date.now() - lastOpenAt < 700) return sendJson(res, 429, { error: 'one at a time' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 512) return sendJson(res, 413, { error: 'too large' }); }
    let id; try { ({ id } = JSON.parse(body)); } catch { return sendJson(res, 400, { error: 'bad json' }); }
    const target = typeof id === 'string' ? openBook.targets.get(id) : null;
    if (!target) return sendJson(res, 404, { error: 'that worker cannot be opened' });
    lastOpenAt = Date.now();
    try { await openLink(target.url); return sendJson(res, 200, { ok: true }); }
    catch (e) { logError('[open]', e); return sendJson(res, 500, { error: 'could not open it' }); }
  }
  if (p === '/api/state') {
    if (!latestJson) return sendJson(res, 503, { error: 'starting up' }, { 'Retry-After': '2' });
    return sendJson(res, 200, latestJson);
  }
  if (p === '/api/week' || (p === '/api/journal' && url.searchParams.has('day'))) {
    try {
      // strict: a real YYYY-MM-DD or 400 (the value becomes a file name)
      const q = url.searchParams.get(p === '/api/week' ? 'end' : 'day');
      if (p === '/api/week' && q == null) return sendJson(res, 200, await journal.week());
      if (!isValidDay(q)) return sendJson(res, 400, { error: 'bad date: want a real YYYY-MM-DD' });
      if (p === '/api/week') return sendJson(res, 200, await journal.week(q));
      const since = Number(url.searchParams.get('since')) || 0;
      return sendJson(res, 200, { ...journal.day(q, { since }), since });
    } catch (e) {
      console.error('[journal api]', e);
      return sendJson(res, 500, { error: 'journal unavailable' });
    }
  }
  if (p === '/api/film') { // the records behind a film: same lines the Today and Week views read
    try {
      const q = url.searchParams, day = q.get('day') === 'today' ? localDate() : q.get('day');
      if (day != null) { if (!isValidDay(day)) return sendJson(res, 400, { error: 'bad date: want a real YYYY-MM-DD' }); return sendJson(res, 200, filmRecord({ day })); }
      const from = Number(q.get('from')), to = Number(q.get('to')) || Date.now();
      if (!(from > 0) || !(to > from)) return sendJson(res, 400, { error: 'bad span: want from and to in ms' });
      return sendJson(res, 200, filmRecord({ from, to }));
    } catch (e) {
      console.error('[film api]', e);
      return sendJson(res, 500, { error: 'journal unavailable' });
    }
  }
  if (p === '/api/today' || p === '/api/journal') {
    try {
      const qd = url.searchParams.get('date');
      const date = qd && DATE_RE.test(qd) ? qd : localDate();
      if (p === '/api/today') return sendJson(res, 200, journal.today(date));
      const since = Number(url.searchParams.get('since')) || 0;
      return sendJson(res, 200, { date, since, entries: journal.entries({ since, date }) });
    } catch (e) {
      console.error('[journal api]', e);
      return sendJson(res, 500, { error: 'journal unavailable' });
    }
  }
  if (p.startsWith('/vendor/three/')) {
    const rel = path.normalize(p.slice('/vendor/three/'.length));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return sendText(res, 403, 'forbidden');
    return serveFile(res, path.join(THREE, rel));
  }
  if (p.endsWith('/')) p += 'index.html';
  const rel = path.normalize(p);
  if (rel.startsWith('..')) return sendText(res, 403, 'forbidden');
  return serveFile(res, path.join(WEB, rel));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    logError('[http]', e);
    try { sendText(res, 500, 'server error'); } catch { /* socket gone */ }
  });
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${CONFIG.port} is already in use. The office may already be running: try http://localhost:${CONFIG.port}\nTo use another port: AI_OFFICE_PORT=4478 npm start`);
  else console.error('[server]', e.message);
  if (e.code === 'EADDRINUSE' || e.code === 'EACCES') process.exit(1);
});

const wss = new WebSocketServer({ server, verifyClient: ({ req }) => isLocalRequest(req.headers, CONFIG.port) });
wss.on('error', e => logError('[ws server]', e));
wss.on('connection', ws => {
  ws.on('error', e => logError('[ws client]', e));
  if (latestJson) send(ws, latestJson); // otherwise the first poll's broadcast greets it
});

function send(ws, json) {
  if (ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED) return;
  try { ws.send(json); } catch (e) { logError('[ws send]', e); }
}
function broadcast(json) { for (const c of wss.clients) send(c, json); }

function stripVolatile(snap) {
  // compare without the clock so we only broadcast real changes (plus the heartbeat)
  return JSON.stringify({ ...snap, now: 0 });
}

let lastSig = '', lastSentAt = 0;
// The director runs the office whether or not a tab is open; its state is saved, so a restart reshuffles nobody.
const DIRECTOR_FILE = path.join(CONFIG.dataDir, 'director.json');
const DIRECTOR_SAVE_MS = 5000;
const director = new Director({ seed: Date.now() >>> 0, state: await readFile(DIRECTOR_FILE, 'utf8').then(JSON.parse).catch(() => null) });
let directorSavedAt = 0, directorSaving = false;
async function saveDirector(now) {
  if (directorSaving || now - directorSavedAt < DIRECTOR_SAVE_MS) return;
  directorSaving = true; directorSavedAt = now;
  try { await mkdir(path.dirname(DIRECTOR_FILE), { recursive: true }); await writeFile(`${DIRECTOR_FILE}.tmp`, JSON.stringify(director)); await rename(`${DIRECTOR_FILE}.tmp`, DIRECTOR_FILE); logRecovered('[director save]'); }
  catch (e) { logError('[director save]', e); }
  directorSaving = false;
}
// the jobs in progress are saved the same way: a job's start may no longer be in the end of its transcript after a restart
const JOBS_FILE = path.join(CONFIG.dataDir, 'jobs.json');
Object.assign(jobBook, new JobBook(await readFile(JOBS_FILE, 'utf8').then(JSON.parse).catch(() => null)));
// who started whom, the same way; the first run also reads back through the last week, whose start calls have scrolled out of the tails
const STARTED_FILE = path.join(CONFIG.dataDir, 'started.json');
const startedSaved = await readFile(STARTED_FILE, 'utf8').then(JSON.parse).catch(() => null);
Object.assign(startedBy, new StartedBy(startedSaved));
if (!startedSaved) { startedBy.dirty = true; scanSessionStarts((parent, hostId, at) => startedBy.noteCall(parent, hostId, at)).catch(e => logError('[started scan]', e)); }
async function saveStarted() {
  if (!startedBy.dirty) return;
  startedBy.dirty = false;
  try { await mkdir(path.dirname(STARTED_FILE), { recursive: true }); await writeFile(`${STARTED_FILE}.tmp`, JSON.stringify(startedBy)); await rename(`${STARTED_FILE}.tmp`, STARTED_FILE); }
  catch (e) { logError('[started save]', e); }
}
async function saveJobs() {
  if (!jobBook.dirty) return;
  jobBook.dirty = false;
  try { await mkdir(path.dirname(JOBS_FILE), { recursive: true }); await writeFile(`${JOBS_FILE}.tmp`, JSON.stringify(jobBook)); await rename(`${JOBS_FILE}.tmp`, JOBS_FILE); }
  catch (e) { logError('[jobs save]', e); }
}
async function poll() {
  try {
    const snap = await buildSnapshot();
    saveJobs(); saveStarted();
    snap.plan = director.update(snap.agents, snap.events || [], snap.now, snap.config);
    saveDirector(snap.now);
    const sig = stripVolatile(snap);
    latestJson = JSON.stringify(snap);
    journal.record(snap);
    uptime.beat(snap.now);
    // clients age bubbles, coffee breaks and departures by the snapshot clock: keep it ticking even when nothing moves
    if (sig !== lastSig || snap.now - lastSentAt >= HEARTBEAT_MS) { lastSig = sig; lastSentAt = snap.now; broadcast(latestJson); }
    logRecovered('[poll]');
  } catch (e) {
    logError('[poll]', e);
  } finally {
    setTimeout(poll, CONFIG.pollMs);
  }
}

server.listen(CONFIG.port, '127.0.0.1', () => {
  console.log(`AI Office  →  http://localhost:${CONFIG.port}`);
  poll();
});
