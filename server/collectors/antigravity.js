// Antigravity collector: Google's agents on a Gemini plan. The same store in two places:
//  - ~/.gemini/antigravity-cli   the Antigravity CLI (`agy`)
//  - ~/.gemini/antigravity       the agents of the Gemini Mac app (it runs its own Antigravity, Gemini.app/Contents/Helpers/agy)
// In each:
//  - conversation_summaries.db   one row per conversation: title, preview (the first request), workspace_uris (JSON list of
//        file:// URIs), status ('CASCADE_RUN_STATUS_IDLE' | _RUNNING | _BUSY | _CANCELING), parent_conversation_id (a
//        helper's lead), agent_name, killed, last_modified_time ('2026-11-11 04:43:01.184119+00:00')
//  - conversations/<id>.db       the conversation itself: steps(idx, step_type, status, step_payload, ...). step_type and
//        status are the CLI's own enums (read from its built-in definitions, agy 1.5.5): 14 your request, 15 its reply,
//        132 a tool call (payload: call id, tool name, JSON arguments such as {"Path"} or {"CommandLine", "toolSummary"});
//        status 3 done, 7 error, 1/2/8/11 under way, 9 waiting for you.
// Both are SQLite in WAL mode, written while the CLI runs (the newest steps sit in the -wal file until it closes). They
// are never opened in place: opening them, even read-only, can leave -wal/-shm files beside them. Each is copied (with
// its -wal) to a private temp folder when it changes, and the copy is read.
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { snippet, basename, SeenMap, every } from '../tail.js';
import { antigravityLedger } from '../output.js';

const ASKING_WINDOW_MS = 30 * 60 * 1000;   // a step waiting for you writes nothing while it waits: look this far back
const STEP = { USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17, GENERIC: 132, RUN_COMMAND: 21, VIEW_FILE: 8, CODE_ACTION: 5,
  GREP_SEARCH: 7, LIST_DIRECTORY: 9, SEARCH_WEB: 33, READ_URL_CONTENT: 31, FILE_CHANGE: 86, INVOKE_SUBAGENT: 127, BROWSER_SUBAGENT: 85, ASK_QUESTION: 138 };
const DONE = 3, ERROR = 7, WAITING = 9;
const UNDER_WAY = new Set([1, 2, 8, 11]); // pending, running, generating, queued
const QUIET_STEPS = new Set([23, 90, 98, 101, 116]); // checkpoints, ephemeral and system notes: not what it is doing
const BUSY_RUN = /RUNNING|BUSY|CANCELING/;

let DatabaseSync = null;
const copies = new SeenMap();   // source db -> { sig, file }
const convCache = new SeenMap(); // conversation id -> { sig, info }
const summaries = new Map(); // home -> { sig, rows }
const prune = every(60 * 1000, now => { copies.prune(now); convCache.prune(now); });
const madeRoots = new Set();

/** the stores to read: [{ dir, host, kind }] (a bare folder, as in tests, is a CLI) */
function homes() {
  const v = CONFIG.gemini?.antigravity ?? [{ dir: path.join(os.homedir(), '.gemini', 'antigravity-cli'), host: 'Antigravity CLI', kind: 'cli' }];
  return (Array.isArray(v) ? v : [v]).map(h => typeof h === 'string' ? { dir: h, host: 'Antigravity CLI', kind: 'cli' } : h);
}
const humanize = s => String(s || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
/** '2026-11-11 04:43:01.184119+00:00' (and the zero time '0001-01-01 ...') -> ms, or 0 */
export function timeOf(v) {
  if (!v) return 0;
  const t = Date.parse(String(v).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(t) && t > 0 ? t : 0;
}

// ---------- protobuf payloads: just the strings ----------

function varint(buf, i) {
  let r = 0, mul = 1, b;
  do { if (i >= buf.length) return [null, i]; b = buf[i++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80 && mul < 2 ** 56);
  return [r, i];
}
/** every text field in a protobuf message, nested ones included, in order (nothing is decoded by schema) */
export function protoStrings(buf, depth = 0, out = []) {
  if (!buf || depth > 6) return out;
  let i = 0;
  while (i < buf.length) {
    const [key, j] = varint(buf, i); if (key === null) return out;
    const wt = key & 7; i = j;
    if (wt === 0) { const [, k] = varint(buf, i); i = k; }
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else if (wt === 2) {
      const [len, k] = varint(buf, i); if (len === null || k + len > buf.length) return out;
      const part = buf.subarray(k, k + len); i = k + len;
      const s = part.toString('utf8'), text = len > 0 && !s.includes('�') && !/[\x00-\x08\x0e-\x1f]/.test(s);
      const nested = [];
      if (len > 1 && parsesAsMessage(part)) protoStrings(part, depth + 1, nested);
      out.push(...nested);
      // plain text can happen to read as a message too ("Be" is field 8 and a length): keep it whole as well, unless it
      // starts like one of the first fields (a control byte), which real text does not
      if (text && (!nested.length || part[0] >= 0x20)) out.push(s);
    } else return out;
  }
  return out;
}
function parsesAsMessage(buf) {
  let i = 0;
  while (i < buf.length) {
    const [key, j] = varint(buf, i); if (key === null || key < 8) return false;
    const wt = key & 7; i = j;
    if (wt === 0) { const [v, k] = varint(buf, i); if (v === null) return false; i = k; }
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else if (wt === 2) { const [len, k] = varint(buf, i); if (len === null) return false; i = k + len; }
    else return false;
  }
  return i === buf.length;
}

/** a tool call step: { name, args } from its payload */
export function toolOf(payload) {
  const strs = protoStrings(payload);
  let name = null, args = {};
  for (const s of strs) {
    if (!name && /^[a-z][a-z0-9_]{2,60}$/.test(s) && !/^call_\d/.test(s)) name = s;
    if (s.startsWith('{')) { try { const o = JSON.parse(s); if (o && typeof o === 'object' && !Array.isArray(o)) { args = o; if (name) break; } } catch { /* not the arguments */ } }
  }
  return { name, args };
}
/** the longest piece of real text in a payload (your request, its reply), skipping ids and tokens */
export function textOf(payload) {
  let best = '';
  for (const s of protoStrings(payload)) if (s.length > best.length && /\s/.test(s.trim()) && !s.startsWith('{')) best = s;
  return best.trim();
}

const ASK_TOOLS = /^(ask_question|ask_user|ask_followup_question|request_user_input)$/;
/** the question a question tool puts to you, or null */
function questionOf(name, args = {}) {
  if (!ASK_TOOLS.test(String(name || '').toLowerCase())) return null;
  const q = Array.isArray(args.questions) ? args.questions[0] : args;
  return snippet(String(q?.question || q?.Question || q?.prompt || q?.text || ''), 60) || 'it asked you something';
}
const pathArg = a => a.Path || a.AbsolutePath || a.TargetFile || a.FilePath || a.file_path || a.path || null;
export function describeTool(name, args = {}) {
  const n = String(name || '').toLowerCase(), a = args || {};
  const file = () => basename(pathArg(a)) || 'a file';
  if (/^(read_file|view_file|view_file_outline|view_code_item|read_many_files)$/.test(n)) return `Reading ${file()}`;
  if (/^(write_to_file|write_file|create_file)$/.test(n)) return `Writing ${file()}`;
  if (/replace|edit/.test(n)) return `Editing ${file()}`;
  if (/^(run_command|shell|run_shell_command|send_command_input)$/.test(n)) return `Running: ${snippet(a.toolSummary || String(a.CommandLine || a.command || '').split('\n')[0], 56) || 'a command'}`;
  if (/grep|search_in_file|codebase_search|find_by_name|find/.test(n) && !/web/.test(n)) return `Searching for “${snippet(a.Query || a.Pattern || a.query || a.pattern || '', 30)}”`;
  if (/^list_dir/.test(n)) return `Looking around ${basename(a.DirectoryPath || a.Path || a.path) || 'the project'}`;
  if (/search_web|web_search/.test(n)) return `Searching the web: ${snippet(a.query || a.Query || '', 44)}`;
  if (/read_url|web_fetch/.test(n)) { try { return `Reading ${new URL(a.Url || a.url).hostname}`; } catch { return 'Reading a web page'; } }
  if (/browser/.test(n)) return 'Using the browser';
  if (ASK_TOOLS.test(n)) return `Asking you: ${questionOf(n, a)}`;
  if (/subagent|delegate/.test(n)) return `Delegating: ${snippet(a.Task || a.task || a.description || 'a side task', 48)}`;
  return `Using ${humanize(name) || 'a tool'}`;
}
const WRITE = /^(write_to_file|write_file|create_file|replace_file_content|multi_replace_file_content|edit_file|replace)$/;
const READ = /^(read_file|view_file)$/;
/** `{ path, op, at }` for a finished tool call that touched one file, or null (for the shared-file reader) */
export function touchOf(name, args, status, at) {
  if (status !== DONE) return null;
  const p = pathArg(args || {}), n = String(name || '').toLowerCase();
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  if (WRITE.test(n)) return { path: p, op: 'write', at };
  if (READ.test(n)) return { path: p, op: 'read', at };
  return null;
}

// ---------- reading copies ----------

async function sigOf(file) {
  const a = await stat(file);
  let w = null; try { w = await stat(`${file}-wal`); } catch { /* checkpointed: no -wal */ }
  return { sig: `${a.mtimeMs}:${a.size}:${w ? `${w.mtimeMs}:${w.size}` : '-'}`, mtimeMs: Math.max(a.mtimeMs, w?.mtimeMs || 0), bornMs: a.birthtimeMs || a.ctimeMs };
}
/** a private copy of a WAL database (main file + -wal) to read; refreshed only when the source changed */
async function copyOf(file, sig, now) {
  const hit = copies.get(file);
  if (hit && hit.sig === sig) { copies.touch(file, now); return hit.file; }
  // one scratch folder per source folder (the server reuses it across restarts; a test's fixture gets its own)
  const root = path.join(os.tmpdir(), `ai-office-agy-${createHash('sha1').update(path.dirname(file)).digest('hex').slice(0, 10)}`);
  if (!madeRoots.has(root)) { await mkdir(root, { recursive: true }); madeRoots.add(root); }
  const dest = path.join(root, path.basename(file));
  await copyFile(file, dest);
  try { await copyFile(`${file}-wal`, `${dest}-wal`); } catch { await writeFile(`${dest}-wal`, ''); } // no -wal: an empty one
  await writeFile(`${dest}-shm`, ''); // the copy's index is rebuilt from its -wal, never one left from an older copy
  copies.set(file, { sig, file: dest }, now);
  return dest;
}
async function query(file, sig, now, sql, params = []) {
  if (!DatabaseSync) ({ DatabaseSync } = await import('node:sqlite'));
  const copy = await copyOf(file, sig, now);
  const db = new DatabaseSync(copy);
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

async function loadSummaries(home, now) {
  const file = path.join(home, 'conversation_summaries.db');
  let s; try { s = await sigOf(file); } catch { return new Map(); }
  const last = summaries.get(home) || { sig: '', rows: new Map() };
  if (s.sig === last.sig) return last.rows;
  const rows = new Map();
  try {
    for (const r of await query(file, s.sig, now, 'select conversation_id, title, preview, workspace_uris, status, parent_conversation_id, agent_name, killed, not_fully_idle, last_modified_time from conversation_summaries')) rows.set(r.conversation_id, r);
  } catch { return last.rows; } // caught mid-write: keep the last good read
  summaries.set(home, { sig: s.sig, rows });
  return rows;
}

function workspaceOf(uris) {
  try { const u = JSON.parse(uris || '[]')[0]; return u ? decodeURIComponent(new URL(u).pathname) : null; } catch { return null; }
}

/** what a conversation is doing, from its newest steps */
export function readSteps(rows) {
  const info = { thought: null, asking: null, underWay: false, error: false, firstUser: null, touches: [], last: null };
  const steps = rows.filter(r => !QUIET_STEPS.has(Number(r.step_type))).sort((a, b) => b.idx - a.idx);
  info.last = steps[0] ? { type: Number(steps[0].step_type), status: Number(steps[0].status) } : null;
  for (const r of steps) {
    const t = Number(r.step_type), st = Number(r.status), p = r.step_payload ? Buffer.from(r.step_payload) : null;
    if (t === STEP.USER_INPUT) { const text = textOf(p); if (text) info.firstUser = snippet(text, 60); } // oldest last: ends on the first
    if (st === WAITING && !info.asking) {
      const tool = t === STEP.GENERIC ? toolOf(p) : null;
      const q = tool && questionOf(tool.name, tool.args);
      info.asking = t === STEP.ASK_QUESTION ? `Question for you: ${snippet(textOf(p), 60) || 'it asked you something'}`
        : q ? `Question for you: ${q}` : `Needs your OK: ${tool?.name ? describeTool(tool.name, tool.args) : 'a step'}`;
    }
    if (UNDER_WAY.has(st)) info.underWay = true;
    if (t === STEP.GENERIC && info.touches.length < (CONFIG.links?.touchesMax ?? 20)) { const tool = toolOf(p); const tc = touchOf(tool.name, tool.args, st, null); if (tc) info.touches.push(tc); }
    if (info.thought) continue;
    if (st === ERROR || t === STEP.ERROR_MESSAGE) { info.thought = { kind: 'error', text: 'Oops, that did not work. Trying again…' }; info.error = r === steps[0]; continue; }
    if (t === STEP.GENERIC) { const tool = toolOf(p); info.thought = { kind: 'tool', text: describeTool(tool.name, tool.args) }; continue; }
    if (t === STEP.PLANNER_RESPONSE) {
      const text = textOf(p);
      info.thought = st === 8 && !text ? { kind: 'think', text: 'Hmm… thinking it through' } : text ? { kind: 'say', text: snippet(text) } : null;
      continue;
    }
    if (t === STEP.USER_INPUT) { const text = textOf(p); if (text) info.thought = { kind: 'read', text: `New request: ${snippet(text, 50)}` }; continue; }
    if (t === STEP.INVOKE_SUBAGENT || t === STEP.BROWSER_SUBAGENT) { info.thought = { kind: 'tool', text: t === STEP.BROWSER_SUBAGENT ? 'Using the browser' : 'Delegating a side task' }; continue; }
  }
  return info;
}

async function conversation(id, file, s, now) {
  const hit = convCache.get(id);
  if (hit && hit.sig === s.sig) { convCache.touch(id, now); return hit.info; }
  let info;
  try {
    const recent = await query(file, s.sig, now, 'select idx, step_type, status, step_payload from steps order by idx desc limit 40');
    const first = await query(file, s.sig, now, 'select idx, step_type, status, step_payload from steps where step_type = ? order by idx limit 1', [STEP.USER_INPUT]);
    const rows = [...recent]; for (const r of first) if (!rows.some(x => x.idx === r.idx)) rows.push(r);
    info = readSteps(rows);
    // what it has made: every tool step of the conversation, oldest first
    const tools = await query(file, s.sig, now, 'select idx, status, step_payload from steps where step_type = ? order by idx', [STEP.GENERIC]);
    info.output = antigravityLedger(tools.map(r => { const p = r.step_payload ? Buffer.from(r.step_payload) : null; return { idx: r.idx, status: Number(r.status), tool: toolOf(p), texts: protoStrings(p) }; }));
  } catch { return hit?.info || null; } // caught mid-write: keep the last good read
  convCache.set(id, { sig: s.sig, info }, now);
  return info;
}

export async function collectAntigravity(now) {
  const agents = [];
  prune(now);
  for (const h of homes()) agents.push(...await collectHome(h, now));
  return agents;
}

async function collectHome({ dir: home, host, kind }, now) {
  const agents = [];
  const dir = path.join(home, 'conversations');
  let names = [];
  try { names = (await readdir(dir)).filter(f => /^[0-9a-f-]{36}\.db$/.test(f)); } catch { return agents; }
  let rows = null;
  for (const f of names) {
    const id = f.slice(0, -3), file = path.join(dir, f);
    let s; try { s = await sigOf(file); } catch { continue; }
    if (now - s.mtimeMs > ASKING_WINDOW_MS) continue;
    rows ??= await loadSummaries(home, now);
    const row = rows.get(id) || {};
    if (Number(row.killed)) continue;
    const info = await conversation(id, file, s, now);
    if (!info) continue;
    const activeAt = Math.max(s.mtimeMs, timeOf(row.last_modified_time));
    if (!info.asking && now - activeAt > CONFIG.activeWindowMs) continue;
    const working = !!info.asking || ((info.underWay || BUSY_RUN.test(row.status || '') || Number(row.not_fully_idle) > 0) && !info.error);
    const cwd = workspaceOf(row.workspace_uris);
    const lead = row.parent_conversation_id || null;
    const what = row.title || (row.preview ? snippet(row.preview, 60) : null) || info.firstUser;
    agents.push({
      id: `gemini:agy-${id}`, vendor: 'gemini', kind: lead ? 'subagent' : kind, host, nickname: row.agent_name || null,
      task: lead ? (what ? `Helper: ${snippet(what, 50)}` : 'Helper') : what || (cwd ? basename(cwd) : 'Antigravity session'),
      cwd, project: cwd ? basename(cwd) : 'Antigravity', model: null, branch: null,
      startedAt: s.bornMs || null, alive: true, status: working ? 'working' : 'idle', statusAt: activeAt, lastActivityAt: activeAt,
      thought: info.thought ? { ...info.thought, at: activeAt } : null, parentId: lead ? `gemini:agy-${lead}` : null,
      waiting: false, asking: info.asking, events: [], output: info.output || null,
      pid: null, touches: info.touches.map(t => ({ ...t, at: activeAt })), // no pid on record; cwd lets the process reader try a weak join
    });
  }
  return agents;
}
