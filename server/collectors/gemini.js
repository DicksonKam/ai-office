// Gemini CLI collector.
//  - ~/.gemini/tmp/<project>/chats/session-<time>-<id>.json   current CLI: the whole conversation, rewritten as it goes:
//        { sessionId, projectHash, startTime, lastUpdated, summary?, messages: [{ id, timestamp, type: 'user' | 'gemini' |
//          'info' | 'error' | 'warning', content, model?, thoughts?: [{ subject, description, timestamp }],
//          toolCalls?: [{ id, name, displayName?, args, status: 'validating' | 'scheduled' | 'awaiting_approval' |
//          'executing' | 'success' | 'error' | 'cancelled', timestamp }] }] }
//    (.jsonl variants, one record per line, are read the same way)
//  - ~/.gemini/tmp/<project>/logs.json   early CLI builds (0.1.x): only the prompts you typed, with timestamps
//  <project> is sha256(project root) on older builds, a readable name on newer ones; the root is found from a
//  .project_root file, ~/.gemini/projects.json, or by hashing likely folders (never inside TCC-protected folders).
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { readTail, readHead, parseJsonl, snippet, basename, SeenMap, every, readdirCached, statCached } from '../tail.js';

const HOME = os.homedir();
const GEMINI_DIR = path.join(HOME, '.gemini');
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');

const ASKING_WINDOW_MS = 6 * 60 * 60 * 1000; // sessions touched this recently are looked at
const PHANTOM_ASK_MS = 30 * 60 * 1000;       // awaiting_approval in a file untouched this long is left over from a crash
const THINK_GAP_MS = 2 * 60 * 1000;          // a prompt or tool result with no reply yet counts as work this long
const STREAM_GAP_MS = 8 * 1000;              // a reply rewritten this recently may still be streaming
const MAX_SESSION_BYTES = 24 * 1024 * 1024;  // whole-file JSON: bigger files fall back to mtime and name only
const OPEN = new Set(['validating', 'scheduled', 'executing', 'awaiting_approval', 'pending', 'running']);
// folders macOS guards with a privacy prompt: never list them to guess a project root
const PROTECTED = new Set(['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public', 'Applications']);
const CLOUD = /^(OneDrive|Dropbox|Google Drive|iCloud|Box|Creative Cloud)/i; // synced folders: listing them can wake the sync client

// caches drop entries unused for an hour, so days of uptime do not keep every session ever seen
const sessionCache = new SeenMap(); // file -> { mtimeMs, size, info }
const sessionIds = new SeenMap();   // file -> the session id first seen in it (the id sits at the top of the file)
const legacyCache = new SeenMap();  // logs.json -> { mtimeMs, size, sessions }
const rootCache = new SeenMap();    // project dir name -> { root, at }
const pruneCaches = every(60 * 1000, now => { for (const m of [sessionCache, sessionIds, legacyCache, rootCache]) m.prune(now); });
let registry = { at: 0, map: new Map() };

const humanize = s => String(s || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
function tsOf(v) { if (!v) return 0; if (typeof v === 'number') return v; const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join(' ');
  if (typeof content === 'object') return typeof content.text === 'string' ? content.text : '';
  return '';
}

export function describeTool(name, args = {}, call = {}) {
  const a = args || {};
  const n = String(name || '').toLowerCase();
  const file = () => basename(a.file_path || a.absolute_path || a.path || a.paths?.[0]) || 'a file';
  switch (n) {
    case 'read_file': case 'read_many_files': return n === 'read_many_files' ? 'Reading a few files' : `Reading ${file()}`;
    case 'write_file': return `Writing ${file()}`;
    case 'replace': case 'edit': case 'smart_edit': return `Editing ${file()}`;
    case 'run_shell_command': case 'shell': return `Running: ${snippet(a.description || String(a.command || '').split('\n')[0], 56) || 'a command'}`;
    case 'search_file_content': case 'grep': case 'grep_search': return `Searching for “${snippet(a.pattern || a.query || '', 30)}”`;
    case 'glob': return `Looking for ${snippet(a.pattern || 'files', 36)}`;
    case 'list_directory': case 'ls': return `Looking around ${basename(a.path || a.dir_path) || 'the project'}`;
    case 'google_web_search': case 'web_search': return `Searching the web: ${snippet(a.query || '', 44)}`;
    case 'web_fetch': { const u = /https?:\/\/[^\s)]+/.exec(a.prompt || a.url || ''); try { return `Reading ${new URL(u?.[0] || a.url).hostname}`; } catch { return 'Reading a web page'; } }
    case 'save_memory': return 'Making a note to remember';
    case 'write_todos': case 'todo_write': return 'Updating the task list';
    case 'delegate_to_agent': case 'codebase_investigator': return `Delegating: ${snippet(a.objective || a.task || a.description || 'a side task', 48)}`;
    default: return `Using ${humanize(call.displayName || name) || 'a tool'}`;
  }
}

// No process id in a session file (sessionId, projectHash, startTime, lastUpdated, messages): the collector reports
// `pid: null`; with startTime and the project root known, the process reader may join a `gemini` process by cwd + start
// time (flagged weak). File touches for the shared-file reader: read_file -> read, write_file / replace / edit -> write.
const WRITE_TOOLS = new Set(['write_file', 'replace', 'edit', 'smart_edit']);
const READ_TOOLS = new Set(['read_file']);
/** `{ path, op, at }` for a finished tool call that touched one file, or null. */
export function touchOf(call, at) {
  const n = String(call?.name || '').toLowerCase(), a = call?.args || {};
  if (String(call?.status || '').toLowerCase() !== 'success') return null;
  const p = a.file_path || a.absolute_path || a.path;
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  if (WRITE_TOOLS.has(n)) return { path: p, op: 'write', at };
  if (READ_TOOLS.has(n)) return { path: p, op: 'read', at };
  return null;
}

function extractConversation(messages) {
  const info = { thought: null, lastAt: 0, model: null, openTool: null, asking: null, last: null, firstUser: null, touches: [] };
  for (const m of messages) if (m && m.type === 'user' && textOf(m.content).trim()) { info.firstUser = snippet(textOf(m.content), 60); break; }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const at = tsOf(m.timestamp);
    if (m.type === 'info' || m.type === 'warning') continue;
    if (!info.last) info.last = m;
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    for (const c of calls) info.lastAt = Math.max(info.lastAt, tsOf(c.timestamp));
    for (let k = calls.length - 1; k >= 0 && info.touches.length < CONFIG.links.touchesMax; k--) { const t = touchOf(calls[k], tsOf(calls[k]?.timestamp) || at); if (t) info.touches.push(t); }
    info.lastAt = Math.max(info.lastAt, at);
    if (!info.model && m.model) info.model = m.model;
    if (info.thought) { if (info.model && info.touches.length >= CONFIG.links.touchesMax) break; continue; }
    if (m.type === 'gemini') {
      const open = calls.filter(c => OPEN.has(String(c.status || '').toLowerCase()));
      if (open.length && info.last === m) {
        const c = open[open.length - 1];
        info.openTool = { name: c.name, at: tsOf(c.timestamp) || at };
        if (String(c.status).toLowerCase() === 'awaiting_approval') info.asking = `Needs your OK: ${describeTool(c.name, c.args, c)}`;
      }
      const c = calls[calls.length - 1];
      if (c && info.last === m) {
        const failed = String(c.status || '').toLowerCase() === 'error';
        info.thought = failed ? { kind: 'error', text: 'Oops, that did not work. Trying again…', at: tsOf(c.timestamp) || at }
          : { kind: 'tool', text: describeTool(c.name, c.args, c), at: tsOf(c.timestamp) || at };
        continue;
      }
      const text = textOf(m.content);
      if (text.trim()) { info.thought = { kind: 'say', text: snippet(text), at }; continue; }
      const th = Array.isArray(m.thoughts) ? m.thoughts[m.thoughts.length - 1] : null;
      if (th) { info.thought = { kind: 'think', text: snippet([th.subject, th.description].filter(Boolean).join(': ')) || 'Hmm… thinking it through', at: tsOf(th.timestamp) || at }; continue; }
      if (c) info.thought = { kind: 'tool', text: describeTool(c.name, c.args, c), at };
    } else if (m.type === 'user') {
      const text = textOf(m.content);
      if (text.trim()) info.thought = { kind: 'read', text: `New request: ${snippet(text, 50)}`, at };
    } else if (m.type === 'error') {
      info.thought = { kind: 'error', text: 'Oops, that did not work. Trying again…', at };
    }
  }
  // the cache keeps only what statusOf needs from the newest message, not the message itself (it can be huge)
  const l = info.last;
  info.last = l ? { type: l.type, calls: Array.isArray(l.toolCalls) ? l.toolCalls.length : 0, hasText: !!textOf(l.content).trim() } : null;
  return info;
}

/** Session id from the top of a session file (the metadata record / object comes first). */
async function headSessionId(file) {
  try {
    const head = await readHead(file, 8192);
    const m = /"sessionId"\s*:\s*"([^"]+)"/.exec(head);
    const t = /"startTime"\s*:\s*"([^"]+)"/.exec(head);
    const h = /"projectHash"\s*:\s*"([^"]+)"/.exec(head);
    return { sessionId: m?.[1] || null, startTime: t?.[1] || null, projectHash: h?.[1] || null };
  } catch { return { sessionId: null, startTime: null, projectHash: null }; }
}

/** The id stays the one first seen for this file, so a session does not turn into someone else when its metadata
 *  falls out of the tail we read (or the file outgrows MAX_SESSION_BYTES). */
function stableId(file, found, now) {
  const known = sessionIds.get(file);
  if (known) { sessionIds.touch(file, now); return known; }
  const id = found || path.basename(file).replace(/\.jsonl?$/, '');
  sessionIds.set(file, id, now);
  return id;
}

async function sessionInfo(file, st, now) {
  const cached = sessionCache.get(file);
  if (cached) sessionCache.touch(file, now);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info;
  let record = null;
  try {
    if (file.endsWith('.jsonl')) {
      const { text, size } = await readTail(file, CONFIG.tailBytes);
      const lines = parseJsonl(text);
      const meta = lines.find(l => l.sessionId && !l.type) || {};
      const msgs = [];
      for (const l of lines) {
        if (l.type === 'message' && l.message) msgs.push(l.message);
        else if (l.type && l.timestamp && ['user', 'gemini', 'error', 'info', 'warning'].includes(l.type)) msgs.push(l);
        else if (Array.isArray(l.messages)) msgs.push(...l.messages);
      }
      record = { ...meta, sessionId: meta.sessionId || lines.find(l => l.sessionId)?.sessionId, messages: msgs };
      // past the tail the metadata line is gone: take the id from the top of the file
      if (size > CONFIG.tailBytes && !meta.sessionId && !sessionIds.has(file)) {
        const h = await headSessionId(file);
        record = { ...record, sessionId: h.sessionId || record.sessionId, startTime: record.startTime || h.startTime, projectHash: record.projectHash || h.projectHash };
      }
    } else if (st.size <= MAX_SESSION_BYTES) {
      try { record = JSON.parse(await readFile(file, 'utf8')); } catch { record = null; } // caught mid-rewrite: retry next poll
      if (!record) return cached?.info || null;
    } else {
      return await bigSessionInfo(file, st, cached, now);
    }
  } catch {
    return cached?.info || null; // vanished or unreadable mid-read: keep the last good read
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) || !(record.sessionId || Array.isArray(record.messages))) return null;
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const info = {
    sessionId: stableId(file, record?.sessionId, now),
    startedAt: tsOf(record?.startTime) || null,
    updatedAt: tsOf(record?.lastUpdated),
    summary: typeof record?.summary === 'string' ? snippet(record.summary, 60) : null,
    projectHash: record?.projectHash || null,
    ...extractConversation(messages),
  };
  sessionCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info }, now);
  return info;
}

/** A whole-file JSON session too big to parse every time it is rewritten: who and when from the top of the file, the
 *  name and the mtime (plus what we knew while it was smaller); being rewritten means it is busy. */
async function bigSessionInfo(file, st, cached, now) {
  const prev = cached?.info || null;
  const h = prev ? { sessionId: null, startTime: null, projectHash: null } : await headSessionId(file);
  const info = {
    sessionId: stableId(file, h.sessionId, now),
    startedAt: prev?.startedAt || tsOf(h.startTime) || null,
    updatedAt: st.mtimeMs,
    summary: prev?.summary || null,
    projectHash: prev?.projectHash || h.projectHash || null,
    thought: null, lastAt: st.mtimeMs, model: prev?.model || null, openTool: null, asking: null, last: null,
    firstUser: prev?.firstUser || null, big: true, touches: [],
  };
  sessionCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info }, now);
  return info;
}

// ---------- which folder is this project? ----------

async function loadRegistry(now) {
  if (now - registry.at < 60000) return registry.map;
  const map = new Map();
  try {
    const j = JSON.parse(await readFile(path.join(GEMINI_DIR, 'projects.json'), 'utf8'));
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 3) return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && path.isAbsolute(k)) map.set(v, k);
        else if (typeof v === 'string' && path.isAbsolute(v)) map.set(k, v);
        else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(j, 0);
  } catch { /* no registry on this build */ }
  registry = { at: now, map };
  return map;
}

const sha256 = s => createHash('sha256').update(s).digest('hex');

/** Hash HOME and two levels of folders below it (skipping protected and hidden ones) to find a sha256-named project. */
async function guessRoot(hash) {
  const queue = [{ dir: HOME, depth: 0 }];
  let budget = 600;
  while (queue.length && budget-- > 0) {
    const { dir, depth } = queue.shift();
    if (sha256(dir) === hash) return dir;
    if (depth >= 2) continue;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || (depth === 0 && (PROTECTED.has(e.name) || CLOUD.test(e.name))) || e.name === 'node_modules') continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

async function projectRoot(dirName, now) {
  const hit = rootCache.get(dirName);
  if (hit && (hit.root || now - hit.at < 10 * 60 * 1000)) { rootCache.touch(dirName, now); return hit.root; }
  let root = null;
  try { root = (await readFile(path.join(TMP_DIR, dirName, '.project_root'), 'utf8')).trim() || null; } catch { /* none */ }
  if (!root) root = (await loadRegistry(now)).get(dirName) || null;
  if (!root && /^[0-9a-f]{64}$/.test(dirName)) root = await guessRoot(dirName);
  rootCache.set(dirName, { root, at: now }, now);
  return root;
}

// ---------- legacy prompt log ----------

async function legacySessions(file, st, now) {
  const cached = legacyCache.get(file);
  if (cached) legacyCache.touch(file, now);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.sessions;
  let list = [];
  try { list = JSON.parse(await readFile(file, 'utf8')); } catch { return cached?.sessions || []; }
  const by = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e?.sessionId) continue;
    const at = tsOf(e.timestamp);
    const s = by.get(e.sessionId) || { sessionId: e.sessionId, startedAt: at, lastAt: 0, lastText: null, firstText: null };
    if (!s.firstText && typeof e.message === 'string') s.firstText = snippet(e.message, 60);
    if (at >= s.lastAt) { s.lastAt = at; s.lastText = typeof e.message === 'string' ? e.message : null; }
    s.startedAt = Math.min(s.startedAt || at, at);
    by.set(e.sessionId, s);
  }
  const sessions = [...by.values()];
  legacyCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, sessions }, now);
  return sessions;
}

// ---------- collect ----------

function statusOf(info, now, mtimeMs) {
  const activeAt = Math.max(info.lastAt, info.updatedAt, info.lastAt ? 0 : mtimeMs) || mtimeMs;
  // an approval prompt writes nothing while it waits, but one in a file untouched for PHANTOM_ASK_MS is a leftover from
  // a CLI that quit or crashed mid-prompt
  if (info.asking && now - mtimeMs < PHANTOM_ASK_MS) return { status: 'working', statusAt: activeAt, activeAt, asking: info.asking };
  if (now - activeAt > CONFIG.activeWindowMs) return null;
  const last = info.last;
  let working;
  if (info.openTool) working = now - info.openTool.at < CONFIG.activeWindowMs;
  else if (info.big) working = now - mtimeMs < CONFIG.idleAfterMs; // too big to read: being rewritten = busy
  else if (!last) working = false; // a session opened but not used yet
  else if (last.type === 'user') working = now - activeAt < THINK_GAP_MS;
  else if (last.type === 'gemini' && last.calls && !last.hasText) working = now - activeAt < THINK_GAP_MS; // tool results going back to the model
  else if (last.type === 'gemini') working = now - activeAt < STREAM_GAP_MS; // the answer may still be streaming in
  else working = now - activeAt < CONFIG.idleAfterMs && last.type !== 'error';
  return { status: working ? 'working' : 'idle', statusAt: activeAt, activeAt, asking: null };
}

export async function collectGemini(now) {
  const agents = [];
  pruneCaches(now);
  let dirs = [];
  try { dirs = await readdirCached(TMP_DIR, now, { withFileTypes: true }); } catch { return agents; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const pdir = path.join(TMP_DIR, d.name);
    const seen = new Set();
    let root; // resolved lazily: only projects with a live session pay for it
    const rootFor = async () => (root === undefined ? (root = await projectRoot(d.name, now)) : root);

    let files = [];
    try { files = (await readdirCached(path.join(pdir, 'chats'), now)).filter(f => /\.jsonl?$/.test(f)); } catch { /* no chats on this build */ }
    for (const f of files) {
      const file = path.join(pdir, 'chats', f);
      const st = await statCached(file, now, { staleMs: ASKING_WINDOW_MS }); // old sessions: re-checked every 15 s
      if (!st || now - st.mtimeMs > ASKING_WINDOW_MS) continue;
      const info = await sessionInfo(file, st, now);
      if (!info) continue;
      const s = statusOf(info, now, st.mtimeMs);
      if (!s) continue;
      if (seen.has(info.sessionId)) continue;
      seen.add(info.sessionId);
      const cwd = await rootFor();
      agents.push({
        id: `gemini:${info.sessionId}`, vendor: 'gemini', kind: 'cli', host: 'Gemini CLI', nickname: null,
        task: info.summary || info.firstUser || (cwd ? basename(cwd) : 'Gemini session'),
        cwd, project: cwd ? basename(cwd) : (/^[0-9a-f]{64}$/.test(d.name) ? 'Gemini' : d.name), model: info.model, branch: null,
        startedAt: info.startedAt, alive: true, status: s.status, statusAt: s.statusAt, lastActivityAt: s.activeAt,
        thought: info.thought, parentId: null, waiting: false, asking: s.asking, events: [],
        pid: null, touches: info.touches || [], // no pid on record; cwd + startedAt let the process reader try a weak join
      });
    }

    // early builds: prompts only. Work for a short while after each prompt, then idle.
    const logs = path.join(pdir, 'logs.json');
    let lst;
    try { lst = await stat(logs); } catch { continue; }
    if (now - lst.mtimeMs > CONFIG.activeWindowMs) continue;
    for (const s of await legacySessions(logs, lst, now)) {
      if (seen.has(s.sessionId) || now - s.lastAt > CONFIG.activeWindowMs) continue;
      const working = now - s.lastAt < THINK_GAP_MS / 2;
      const cwd = await rootFor();
      agents.push({
        id: `gemini:${s.sessionId}`, vendor: 'gemini', kind: 'cli', host: 'Gemini CLI', nickname: null,
        task: s.firstText || (cwd ? basename(cwd) : 'Gemini session'),
        cwd, project: cwd ? basename(cwd) : (/^[0-9a-f]{64}$/.test(d.name) ? 'Gemini' : d.name), model: null, branch: null,
        startedAt: s.startedAt || null, alive: true, status: working ? 'working' : 'idle', statusAt: s.lastAt, lastActivityAt: s.lastAt,
        thought: s.lastText ? { kind: 'read', text: `New request: ${snippet(s.lastText, 50)}`, at: s.lastAt } : null,
        parentId: null, waiting: false, asking: null, events: [],
        pid: null, touches: [], // the legacy prompt log records no tool calls
      });
    }
  }
  return agents;
}
