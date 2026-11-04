// Cursor collector: the IDE's Agent / Composer chats (and their "explore" subagents), plus agent transcripts that the
// DB does not know about (e.g. the cursor-agent CLI).
//  - <Cursor user data>/User/globalStorage/state.vscdb   (SQLite, WAL; opened read-only)
//      composerHeaders            one small row per chat: createdAt, lastUpdatedAt (= newest turn start),
//                                 checkpointAt (= newest turn end), isSubagent, subagentInfo.parentComposerId, workspace path,
//                                 hasBlockingPendingActions / hasPendingPlan (true only while something waits on you)
//      cursorDiskKV composerData:<id>            status ('generating' | 'completed' | 'aborted' | 'none'), name, model,
//                                                 fullConversationHeadersOnly (bubble ids, newest last)
//      cursorDiskKV bubbleId:<id>:<bubbleId>      one message: type 1 user / 2 assistant, text, thinking, toolFormerData
//    The DB is >1 GB on a heavy user's Mac, so a poll only reads composerHeaders (a few hundred rows), then single-key
//    lookups for the handful of chats active in the window, and re-reads nothing while the DB and its WAL are unchanged.
//    Never touched: agentKv / checkpoint blobs, and composerData fields other than the ones named above (the record also
//    holds encryption keys for Cursor's cloud blobs; they are never read into the snapshot).
//  - ~/.cursor/projects/<path-slug>/agent-transcripts/<id>/<id>.jsonl   untimed transcript lines + {"type":"turn_ended"}
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { readTail, readHead, parseJsonl, snippet, basename, SeenMap, every, readdirCached, statCached, logError, logRecovered } from '../tail.js';

const HOME = os.homedir();
function userDataDir() {
  if (process.env.AI_OFFICE_CURSOR_DATA) return process.env.AI_OFFICE_CURSOR_DATA;
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Cursor');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Cursor');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Cursor');
}
const DB_PATH = path.join(userDataDir(), 'User', 'globalStorage', 'state.vscdb');
const PROJECTS_DIR = path.join(HOME, '.cursor', 'projects');

const ASKING_WINDOW_MS = 6 * 60 * 60 * 1000; // a chat blocked on your approval writes nothing while it waits
const PHANTOM_ASK_MS = 30 * 60 * 1000;      // a "waits on you" flag on a chat untouched this long is left over from a crash
const THINK_GAP_MS = 2 * 60 * 1000;          // no status flag: a request with no answer yet counts as work this long
const STALE_ROWS_MS = 30 * 1000;             // while the DB is briefly unreadable, keep showing the last read this long
const BUBBLES_BACK = 6;                      // how many of the newest messages to look at for the thought bubble
const DONE_TOOL = new Set(['completed', 'error', 'cancelled', 'canceled', 'rejected', 'aborted', 'failed', 'success']);

let db = null, DatabaseSync = null, stmts = null;
let dbRetryAt = 0;
let lastSig = null, lastRows = null;          // DB+WAL signature -> extracted composer records (status recomputed per poll)
let lastRowsAt = 0;                           // when lastRows was last confirmed current
// the caches below drop entries unused for an hour (SeenMap.prune), so days of uptime do not keep every chat ever seen
const firstTextCache = new SeenMap();         // composerId -> first user request (for untitled chats)
const bubbleIndex = new SeenMap();            // composerId -> Map(bubble key -> header) for chats without a header list
const workspaceSlugs = { at: 0, map: new Map() }; // path slug -> workspace path, from composerHeaders
const transcriptCache = new SeenMap();        // transcript path -> { mtimeMs, size, info }
const knownIds = new SeenMap();               // transcript ids the DB knows as IDE chats (stays valid while the DB is closed)
const pruneCaches = every(60 * 1000, now => { firstTextCache.prune(now); bubbleIndex.prune(now); transcriptCache.prune(now); knownIds.prune(now); });

// No process id anywhere (agent-cli-state.json, ide_state.json, the composer headers): IDE chats run inside the Cursor
// app itself and cursor-agent transcripts carry no start time, so the collector reports `pid: null` and nothing joins one.
// File touches for the shared-file reader come from tool calls: a read of one file, or an edit / write of one.
const WRITE_TOOLS = new Set(['write', 'create_file', 'edit_file', 'search_replace', 'strreplace', 'str_replace', 'multi_edit', 'apply_patch', 'edit']);
const READ_TOOLS = new Set(['read_file', 'read']);
/** `{ path, op, at }` for a tool call that touched a file (the path as given: relative ones are resolved by the caller), or null. */
export function touchOf(name, p, at) {
  const n = String(name || '').toLowerCase().replace(/_v\d+$/, '');
  p = p || {};
  let file = p.targetFile || p.target_file || p.relativeWorkspacePath || p.file_path || p.filePath || p.path || null;
  if (typeof file !== 'string' || !file) return null;
  if (file.startsWith('file://')) { try { file = decodeURIComponent(new URL(file).pathname); } catch { return null; } }
  if (WRITE_TOOLS.has(n)) return { path: file, op: 'write', at };
  if (READ_TOOLS.has(n)) return { path: file, op: 'read', at };
  return null;
}
/** Touch paths made absolute against the chat's workspace; ones that cannot be are dropped. */
function resolveTouches(touches, cwd) {
  const out = [];
  for (const t of touches || []) {
    if (!t) continue;
    let p = t.path;
    if (p.startsWith('~/')) p = path.join(HOME, p.slice(2));
    else if (!p.startsWith('/')) { if (!cwd) continue; p = path.resolve(cwd, p); }
    out.push({ path: path.normalize(p), op: t.op, at: t.at });
  }
  return out;
}

const humanize = s => String(s || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const slugify = p => String(p || '').replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9]/g, '-');
function parseJson(s, fallback = null) { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? fallback); } catch { return fallback; } }
function tsOf(v) { if (!v) return 0; if (typeof v === 'number') return v; const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
function fileOf(uriOrPath) {
  if (!uriOrPath) return '';
  let s = String(uriOrPath);
  if (s.startsWith('file://')) { try { s = decodeURIComponent(new URL(s).pathname); } catch { /* keep */ } }
  return basename(s);
}

/** Tool names from the IDE (read_file_v2, run_terminal_command_v2, mcp-<server>-<tool>, …) and from transcripts
 *  (Read, Shell, Glob, …) to a short bubble line. */
export function describeTool(name, p = {}) {
  const raw = String(name || '');
  const n = raw.toLowerCase().replace(/_v\d+$/, '');
  p = p || {};
  const file = () => fileOf(p.targetFile || p.target_file || p.relativeWorkspacePath || p.file_path || p.filePath || p.path || p.effectiveUri) || 'a file';
  switch (n) {
    case 'read_file': case 'read': return `Reading ${file()}`;
    case 'edit_file': case 'search_replace': case 'strreplace': case 'str_replace': case 'multi_edit': case 'apply_patch': case 'edit': return `Editing ${file()}`;
    case 'write': case 'create_file': return `Writing ${file()}`;
    case 'delete_file': case 'delete': return `Deleting ${file()}`;
    case 'run_terminal_command': case 'run_terminal_cmd': case 'shell': case 'bash': {
      const d = p.commandDescription || p.description || p.explanation;
      return `Running: ${snippet(d || String(p.command || '').split('\n')[0], 56) || 'a command'}`;
    }
    case 'ripgrep_raw_search': case 'grep': case 'grep_search': case 'ripgrep': return `Searching for “${snippet(p.pattern || p.query || '', 30)}”`;
    case 'glob_file_search': case 'glob': case 'file_search': return `Looking for ${snippet(p.globPattern || p.glob_pattern || p.query || p.pattern || 'files', 36)}`;
    case 'semantic_search_full': case 'semantic_search': case 'codebase_search': return `Searching the code: ${snippet(p.query || '', 40)}`;
    case 'list_dir': case 'ls': return `Looking around ${fileOf(p.targetDirectory || p.relativeWorkspacePath || p.path) || 'the project'}`;
    case 'web_search': return `Searching the web: ${snippet(p.searchTerm || p.query || '', 44)}`;
    case 'web_fetch': case 'fetch': { try { return `Reading ${new URL(p.url).hostname}`; } catch { return 'Reading a web page'; } }
    case 'todo_write': case 'todowrite': return 'Updating the task list';
    case 'create_plan': return 'Drafting a plan';
    case 'ask_question': return 'Asking the boss a question';
    case 'task': return `Delegating: ${snippet(p.description || p.name || p.prompt || 'a side task', 48)}`;
    case 'await': return 'Checking on a background job'; // the amber status line already says "Waiting for …"
    case 'read_lints': return 'Checking for lint errors';
    case 'get_mcp_tools': return 'Looking up tools';
    default: {
      if (n.startsWith('mcp-') || n.startsWith('mcp_')) return `Using ${humanize(raw.split(/-/).pop())}`;
      return `Using ${humanize(raw) || 'a tool'}`;
    }
  }
}

// ---------- the IDE database ----------

async function getDb() {
  if (db) return db;
  if (Date.now() < dbRetryAt) return null;
  try { await stat(DB_PATH); } catch { dbRetryAt = Date.now() + 30000; return null; }
  if (!DatabaseSync) ({ DatabaseSync } = await import('node:sqlite'));
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'composerHeaders'").get();
  stmts = {
    // composerHeaders: one row per chat, a few hundred rows at most; the window filter keeps the result tiny
    headers: has ? db.prepare(`
      SELECT composerId, createdAt, lastUpdatedAt, checkpointAt, isSubagent, isArchived, subagentTypeName, value
      FROM composerHeaders
      WHERE MAX(COALESCE(lastUpdatedAt, 0), COALESCE(checkpointAt, 0), COALESCE(recency, 0)) > ?
      ORDER BY recency DESC LIMIT 80`) : null,
    // older builds without composerHeaders: timestamps straight from composerData (range scan on the key index)
    legacyHeaders: has ? null : db.prepare(`
      SELECT substr(key, 14) AS composerId, json_extract(value, '$.createdAt') AS createdAt,
             json_extract(value, '$.lastUpdatedAt') AS lastUpdatedAt,
             json_extract(value, '$.conversationCheckpointLastUpdatedAt') AS checkpointAt
      FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'
        AND MAX(COALESCE(json_extract(value, '$.lastUpdatedAt'), 0), COALESCE(json_extract(value, '$.conversationCheckpointLastUpdatedAt'), 0)) > ?`),
    workspaces: has ? db.prepare("SELECT DISTINCT json_extract(value, '$.workspaceIdentifier.uri.fsPath') AS p FROM composerHeaders") : null,
    known: has ? db.prepare('SELECT 1 FROM composerHeaders WHERE composerId = ?') : db.prepare('SELECT 1 FROM cursorDiskKV WHERE key = ?'),
    kv: db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?'),
    bubbleKeys: db.prepare('SELECT key FROM cursorDiskKV WHERE key >= ? AND key < ?'),
    bubbleMeta: db.prepare("SELECT json_extract(value, '$.createdAt') AS c, json_extract(value, '$.type') AS t, json_extract(value, '$.startedAtMs') AS s FROM cursorDiskKV WHERE key = ?"),
  };
  return db;
}

function closeDb() { try { db?.close(); } catch { /* ignore */ } db = null; stmts = null; lastSig = null; dbRetryAt = Date.now() + 5000; }

async function dbSignature() {
  const parts = [];
  for (const suffix of ['', '-wal']) {
    try { const s = await stat(DB_PATH + suffix); parts.push(`${s.mtimeMs}:${s.size}`); } catch { parts.push('-'); }
  }
  return parts.join('|');
}

function kvJson(key) {
  const r = stmts.kv.get(key);
  if (!r || r.value == null) return null;
  return parseJson(typeof r.value === 'string' ? r.value : Buffer.from(r.value).toString('utf8'));
}

function bubbleText(b) { return typeof b?.text === 'string' ? b.text : ''; }

/** Newest bubbles first: the thought, the open tool call, the newest timestamp. */
function readBubbles(composerId, heads) {
  const out = { thought: null, lastAt: 0, openTool: null, lastSay: null, touches: [] };
  const recent = heads.slice(-BUBBLES_BACK).reverse();
  for (const h of recent) out.lastAt = Math.max(out.lastAt, tsOf(h.createdAt), tsOf(h.startedAtMs), tsOf(h.completedAtMs));
  for (let i = 0; i < recent.length; i++) {
    const h = recent[i];
    const b = kvJson(`bubbleId:${composerId}:${h.bubbleId}`);
    if (!b) continue;
    const at = Math.max(tsOf(b.completedAtMs), tsOf(b.startedAtMs), tsOf(b.createdAt), tsOf(h.createdAt), tsOf(h.startedAtMs));
    out.lastAt = Math.max(out.lastAt, at);
    const type = b.type ?? h.type;
    const tf = b.toolFormerData;
    if (type === 2 && tf && tf.name) {
      const params = parseJson(tf.params, null) || parseJson(tf.rawArgs, {}) || {};
      const status = String(tf.status || '').toLowerCase();
      if (DONE_TOOL.has(status) && out.touches.length < CONFIG.links.touchesMax) { const t = touchOf(tf.name, params, at); if (t) out.touches.push(t); }
      if (!out.openTool && i === 0 && !DONE_TOOL.has(status)) out.openTool = { name: String(tf.name).toLowerCase().replace(/_v\d+$/, ''), params, at };
      if (!out.thought) {
        out.thought = (status === 'error' || status === 'failed') && i === 0
          ? { kind: 'error', text: 'Oops, that did not work. Trying again…', at }
          : { kind: 'tool', text: describeTool(tf.name, params), at };
      }
    } else if (type === 2 && b.thinking?.text && !out.thought) {
      out.thought = { kind: 'think', text: snippet(b.thinking.text) || 'Hmm… thinking it through', at };
    }
    if (type === 2 && bubbleText(b).trim()) {
      if (!out.lastSay) out.lastSay = { text: snippet(bubbleText(b), 90), at };
      if (!out.thought) out.thought = { kind: 'say', text: snippet(bubbleText(b)), at };
    }
    if (type === 1 && bubbleText(b).trim() && !out.thought) out.thought = { kind: 'read', text: `New request: ${snippet(bubbleText(b), 50)}`, at };
    if (out.thought && out.lastSay) break;
  }
  return out;
}

function firstRequest(composerId, heads) {
  if (firstTextCache.has(composerId)) { firstTextCache.touch(composerId); return firstTextCache.get(composerId); }
  const h = heads.find(x => x.type === 1);
  const b = h ? kvJson(`bubbleId:${composerId}:${h.bubbleId}`) : null;
  const text = b ? snippet(bubbleText(b), 60) : null;
  if (h) firstTextCache.set(composerId, text);
  return text;
}

/** Bubble headers rebuilt from the bubble keys (index-only range scan); each new bubble's timestamp is read once. */
function bubbleHeads(composerId) {
  const lo = `bubbleId:${composerId}:`;
  let keys;
  try { keys = stmts.bubbleKeys.all(lo, `bubbleId:${composerId};`); } catch { return []; }
  const idx = bubbleIndex.get(composerId) || new Map();
  const live = new Set();
  for (const { key } of keys) {
    live.add(key);
    if (idx.has(key)) continue;
    const m = stmts.bubbleMeta.get(key) || {};
    idx.set(key, { bubbleId: key.slice(lo.length), type: m.t ?? null, createdAt: m.c ?? null, startedAtMs: m.s ?? null });
  }
  for (const k of idx.keys()) if (!live.has(k)) idx.delete(k);
  bubbleIndex.set(composerId, idx);
  return [...idx.values()].sort((a, b) => (tsOf(a.createdAt) || tsOf(a.startedAtMs)) - (tsOf(b.createdAt) || tsOf(b.startedAtMs)));
}

/** One composer row -> the time-independent facts about it (cached until the DB changes). */
function extractComposer(row, now) {
  const head = parseJson(row.value, {}) || {};
  const last = Math.max(row.lastUpdatedAt || 0, row.checkpointAt || 0);
  const blocking = !!(head.hasBlockingPendingActions || head.hasPendingPlan);
  // a turn started and not ended yet: it may sit on an ask_question tool, which raises no flag and writes nothing
  const turnOpen = (row.lastUpdatedAt || 0) > (row.checkpointAt || 0);
  // outside the working window only chats that (may) wait on you are worth a lookup
  if (now - Math.max(last, row.createdAt || 0) > CONFIG.activeWindowMs && !blocking && !turnOpen) return null;
  const data = kvJson(`composerData:${row.composerId}`);
  if (!data) return null; // drafts and never-used chats have no data
  let heads = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  if (!heads.length) heads = bubbleHeads(row.composerId); // some chats keep no header list: order their bubbles by time
  if (!heads.length && !data.name) return null;
  const bub = heads.length ? readBubbles(row.composerId, heads) : { thought: null, lastAt: 0, openTool: null, lastSay: null, touches: [] };
  const ws = head.workspaceIdentifier?.uri || data.workspaceIdentifier?.uri || null;
  const sub = head.subagentInfo || data.subagentInfo || null;
  return {
    id: row.composerId,
    createdAt: row.createdAt || data.createdAt || null,
    turnStart: row.lastUpdatedAt || data.lastUpdatedAt || 0,
    turnEnd: row.checkpointAt || data.conversationCheckpointLastUpdatedAt || 0,
    turnOpen,
    status: String(data.status || 'none').toLowerCase(),
    generating: (Array.isArray(data.generatingBubbleIds) && data.generatingBubbleIds.length > 0),
    blockingActions: !!head.hasBlockingPendingActions, pendingPlan: !!head.hasPendingPlan,
    archived: !!(row.isArchived || head.isArchived),
    isSub: !!(row.isSubagent || sub), subType: row.subagentTypeName || sub?.subagentTypeName || null,
    parent: sub?.parentComposerId || null,
    name: data.name || head.name || null,
    firstText: heads.length ? firstRequest(row.composerId, heads) : null,
    cwd: ws?.fsPath || null,
    model: data.modelConfig?.modelName && data.modelConfig.modelName !== 'default' ? data.modelConfig.modelName : null,
    mode: data.unifiedMode || head.unifiedMode || null,
    ...bub,
  };
}

/** Is the chat blocked on you? An open ask_question counts for the whole asking window while its turn is open; the
 *  pending-approval / pending-plan flags only while the chat was touched within PHANTOM_ASK_MS (Cursor leaves them set
 *  when it quits or crashes mid-prompt, and nothing would ever clear them). */
function askingFor(c, activeAt, now) {
  const recent = now - activeAt < PHANTOM_ASK_MS;
  if (c.openTool?.name === 'ask_question' && (c.turnOpen || recent)) {
    const q = c.openTool.params?.questions?.[0];
    return `Question for you: ${snippet(c.openTool.params?.title || q?.prompt || q?.question || q?.title || 'needs your answer', 60)}`;
  }
  if (!recent) return null;
  if (c.pendingPlan) return 'Plan ready for your review';
  if (c.blockingActions) return c.openTool ? `Needs your OK: ${describeTool(c.openTool.name, c.openTool.params)}` : 'Needs your OK to continue';
  return null;
}

function statusOf(c, now) {
  const activeAt = Math.max(c.turnStart, c.turnEnd, c.lastAt, c.createdAt || 0);
  const asking = askingFor(c, activeAt, now);
  if (asking && now - activeAt < ASKING_WINDOW_MS) return { status: 'working', statusAt: c.turnStart || activeAt, activeAt, asking };
  if (now - activeAt > CONFIG.activeWindowMs) return null;
  if (c.generating || c.status === 'generating') return { status: 'working', statusAt: c.turnStart || activeAt, activeAt, asking: null };
  if (c.status === 'completed' || c.status === 'aborted' || c.status === 'cancelled') {
    // a turn newer than the last turn end with fresh messages means the status has not caught up yet
    const fresh = c.turnStart > c.turnEnd + 1000 && c.lastAt >= c.turnStart && now - c.lastAt < CONFIG.idleAfterMs && c.status !== 'aborted';
    if (!fresh) return { status: 'idle', statusAt: Math.max(c.turnEnd, c.lastAt) || activeAt, activeAt, asking: null };
  }
  const open = c.openTool && now - c.openTool.at < CONFIG.activeWindowMs;
  const waitingAnswer = c.thought?.kind === 'read' && now - activeAt < THINK_GAP_MS;
  const working = now - activeAt < CONFIG.idleAfterMs || open || waitingAnswer;
  return { status: working ? 'working' : 'idle', statusAt: working ? (c.turnStart || activeAt) : activeAt, activeAt, asking: null };
}

/** The last good read, while it is recent: a DB error closes the DB for a few seconds, and in that gap every IDE chat
 *  would otherwise vanish (and walk back in) and their transcripts would show up as separate CLI agents. */
function recentRows(now) { return lastRows && now - lastRowsAt < STALE_ROWS_MS ? lastRows : null; }

async function collectFromDb(now) {
  let d;
  try { d = await getDb(); } catch (e) { closeDb(); logError('[cursor] db open', e, now); return recentRows(now); }
  if (!d) return recentRows(now);
  const sig = await dbSignature();
  let records = lastRows;
  if (sig !== lastSig || !records) {
    try {
      const since = now - ASKING_WINDOW_MS;
      const rows = stmts.headers ? stmts.headers.all(since) : stmts.legacyHeaders.all(since);
      records = [];
      for (const r of rows) { const c = extractComposer(r, now); if (c && !c.archived) records.push(c); }
      lastSig = sig; lastRows = records;
    } catch (e) {
      // busy during a checkpoint, or a schema change: keep the last good read this time, reopen next time
      closeDb();
      if (!lastRows) throw e;
      logError('[cursor] db read', e, now);
      return recentRows(now);
    }
  }
  lastRowsAt = now;
  logRecovered('[cursor] db open'); logRecovered('[cursor] db read');
  for (const c of records) { firstTextCache.touch(c.id, now); bubbleIndex.touch(c.id, now); }
  return records;
}

function knownComposer(id, now) {
  if (knownIds.has(id)) { knownIds.touch(id, now); return true; }
  if (!stmts) return false;
  let known = false;
  try { known = !!stmts.known.get(stmts.headers ? id : `composerData:${id}`); } catch { /* DB busy */ }
  if (known) knownIds.set(id, true, now);
  return known;
}

function workspaceForSlug(slug, now) {
  if (stmts?.workspaces && now - workspaceSlugs.at > 60000) {
    try {
      const map = new Map();
      for (const r of stmts.workspaces.all()) if (r.p) map.set(slugify(r.p), r.p);
      workspaceSlugs.map = map; workspaceSlugs.at = now;
    } catch { /* keep the old map */ }
  }
  return workspaceSlugs.map.get(slug) || null;
}

// ---------- transcripts (sessions the DB does not know about) ----------

/** Transcript lines carry no timestamps: touches come from the newest turn only (the lines after the last turn_ended
 *  marker, or before a closing one) and are stamped with the file's mtime by the caller. */
export function extractTranscript(lines) {
  const info = { thought: null, ended: false, firstUser: null, openTool: null, paths: [], touches: [] };
  let turnStart = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].type === 'turn_ended' && i < lines.length - 1) { turnStart = i + 1; break; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (i === lines.length - 1 && l.type === 'turn_ended') { info.ended = true; continue; }
    const blocks = Array.isArray(l.message?.content) ? l.message.content : typeof l.message?.content === 'string' ? [{ type: 'text', text: l.message.content }] : [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type === 'tool_use') {
        const inp = b.input || {};
        for (const k of ['path', 'file_path', 'target_file', 'cwd', 'working_directory', 'target_directory']) if (typeof inp[k] === 'string' && inp[k].startsWith('/')) info.paths.push(inp[k]);
        if (i >= turnStart && info.touches.length < CONFIG.links.touchesMax) { const t = touchOf(b.name, inp, 0); if (t) info.touches.push(t); }
        if (!info.thought) { info.thought = { kind: 'tool', text: describeTool(b.name, inp) }; if (!info.ended && i === lines.length - 1) info.openTool = b.name; }
      } else if (b.type === 'text' && b.text?.trim()) {
        if (l.role === 'user') { info.firstUser = snippet(b.text, 60); if (!info.thought) info.thought = { kind: 'read', text: `New request: ${snippet(b.text, 50)}` }; }
        else if (!info.thought) info.thought = { kind: 'say', text: snippet(b.text) };
      } else if ((b.type === 'thinking' || b.type === 'reasoning') && !info.thought) {
        info.thought = { kind: 'think', text: snippet(b.thinking || b.text) || 'Hmm… thinking it through' };
      }
    }
  }
  return info;
}

function cwdFromSlug(slug, paths, now) {
  const known = workspaceForSlug(slug, now);
  if (known) return known;
  for (const p of paths) {
    let cur = p;
    for (let guard = 0; guard < 24 && cur && cur !== '/'; guard++) {
      if (slugify(cur) === slug) return cur;
      cur = path.dirname(cur);
    }
  }
  return null;
}

/** Recent transcript files. Folder listings are reused while a folder is unchanged and files already older than the
 *  window are stat'ed again only every 15 s, so the scan does not grow with every chat ever written. */
async function transcriptFiles(now, windowMs = CONFIG.activeWindowMs) {
  const out = [];
  let dirs = [];
  try { dirs = await readdirCached(PROJECTS_DIR, now, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const tdir = path.join(PROJECTS_DIR, d.name, 'agent-transcripts');
    let entries = [];
    try { entries = await readdirCached(tdir, now, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const cand = e.isDirectory() ? path.join(tdir, e.name, `${e.name}.jsonl`) : e.name.endsWith('.jsonl') ? path.join(tdir, e.name) : null;
      if (!cand) continue;
      const st = await statCached(cand, now, { staleMs: windowMs });
      if (!st || now - st.mtimeMs > windowMs) continue;
      out.push({ path: cand, slug: d.name, id: e.isDirectory() ? e.name : e.name.slice(0, -6), st });
    }
  }
  return out;
}

async function collectTranscripts(now, seen, agents) {
  const dbIds = new Set((lastRows || []).map(c => c.id)); // IDE chats, even while the DB is closed for a retry
  for (const f of await transcriptFiles(now)) {
    if (seen.has(f.id) || dbIds.has(f.id) || knownComposer(f.id, now)) continue;
    let cached = transcriptCache.get(f.path);
    if (cached) transcriptCache.touch(f.path, now);
    if (!cached || cached.mtimeMs !== f.st.mtimeMs || cached.size !== f.st.size) {
      let text = null;
      try { ({ text } = await readTail(f.path, CONFIG.tailBytes)); } catch { /* vanished or locked: keep the last read */ }
      if (text != null) {
        cached = { mtimeMs: f.st.mtimeMs, size: f.st.size, info: extractTranscript(parseJsonl(text)) };
        transcriptCache.set(f.path, cached, now);
      }
      if (!cached) continue;
    }
    const info = cached.info, at = f.st.mtimeMs;
    const working = !info.ended && now - at < CONFIG.idleAfterMs;
    const cwd = cwdFromSlug(f.slug, info.paths, now);
    seen.add(f.id);
    agents.push({
      id: `cursor:${f.id}`, vendor: 'cursor', kind: 'cli', host: 'Cursor Agent', nickname: null,
      task: info.firstUser || (cwd ? basename(cwd) : 'Cursor agent'),
      cwd, project: cwd ? basename(cwd) : (/^\d+$/.test(f.slug) ? 'Cursor' : f.slug.split('-').filter(Boolean).pop()), model: null, branch: null,
      startedAt: null, alive: true, status: working ? 'working' : 'idle', statusAt: at, lastActivityAt: at,
      thought: info.thought ? { ...info.thought, at } : null, parentId: null, waiting: false, asking: null, events: [],
      pid: null, touches: resolveTouches(info.touches.map(t => ({ ...t, at })), cwd), // untimed lines: the file's mtime stands in
    });
  }
}

export async function collectCursor(now) {
  const agents = [];
  const seen = new Set();
  pruneCaches(now);
  let records = null;
  try { records = await collectFromDb(now); logRecovered('[cursor] db'); } catch (e) { logError('[cursor] db', e, now); }

  if (records) {
    const live = [];
    for (const c of records) {
      const st = statusOf(c, now);
      if (st) live.push({ c, st });
    }
    const liveIds = new Set(live.map(x => x.c.id));
    for (const { c, st } of live) {
      seen.add(c.id);
      const id = `cursor:${c.id}`;
      const parentId = c.isSub && c.parent && liveIds.has(c.parent) ? `cursor:${c.parent}` : null;
      const events = [];
      if (parentId) {
        events.push({ id: `cursor-spawn:${c.id}`, kind: 'spawn', from: parentId, to: id, text: humanize(c.subType) || null, at: c.createdAt || st.activeAt });
        if (st.status === 'idle' && c.lastSay && c.status === 'completed') events.push({ id: `cursor-report:${c.id}:${c.lastSay.at}`, kind: 'report', from: id, to: parentId, text: c.lastSay.text, at: c.lastSay.at || st.activeAt });
      }
      const waiting = st.status === 'working' && !st.asking && (c.openTool?.name === 'task' || c.openTool?.name === 'await');
      agents.push({
        id, vendor: 'cursor', kind: c.isSub ? 'subagent' : 'desktop', host: 'Cursor', nickname: null,
        task: c.isSub
          ? `Helper: ${snippet(c.name || humanize(c.subType) || 'side task', 50)}`
          : (c.name || c.firstText || (c.cwd ? basename(c.cwd) : 'Cursor chat')),
        cwd: c.cwd, project: c.cwd ? basename(c.cwd) : 'Cursor', model: c.model, branch: null,
        startedAt: c.createdAt, alive: true, status: st.status, statusAt: st.statusAt, lastActivityAt: st.activeAt,
        thought: c.thought, parentId, waiting, asking: st.asking, events,
        pid: null, touches: resolveTouches(c.touches, c.cwd), // the chat lives inside the Cursor app: no process of its own
      });
    }
  }
  try { await collectTranscripts(now, seen, agents); logRecovered('[cursor] transcripts'); } catch (e) { logError('[cursor] transcripts', e, now); }
  return agents;
}

// ---- background commands: a Shell call that does not wait (block_until_ms 0) in the chat's transcript, then its terminal file
// under the project's terminals/ (pid and command up top, exit_code and ended_at at the end once it is over). A terminal file
// alone could be the person's own shell, so only a command the chat itself started counts as its job.
const JOB_WINDOW_MS = 12 * 60 * 60 * 1000;
const shellCache = new SeenMap(); // transcript -> { mtimeMs, size, shells }
export function backgroundShells(lines) {
  const out = new Map();
  for (const l of lines) for (const b of Array.isArray(l.message?.content) ? l.message.content : []) {
    if (b.type !== 'tool_use' || b.name !== 'Shell' || typeof b.input?.command !== 'string') continue;
    if (b.input.block_until_ms === 0 || b.input.is_background === true) out.set(b.input.command.trim(), snippet(b.input.description || b.input.command.split('\n')[0], 60));
  }
  return out;
}
export function terminalState(head, tail) {
  const field = (t, k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(t)?.[1]?.trim() ?? null;
  const unq = v => (v && v.startsWith('"') ? v.replace(/^"|"$/g, '') : v);
  const exit = field(tail, 'exit_code');
  return { pid: Number(field(head, 'pid')) || null, command: unq(field(head, 'command')), startedAt: Date.parse(field(head, 'started_at')) || null, exit: exit == null ? null : Number(exit), endedAt: Date.parse(field(tail, 'ended_at')) || null };
}
export async function cursorJobs(now = Date.now()) {
  const out = [];
  for (const f of await transcriptFiles(now, JOB_WINDOW_MS)) {
    let hit = shellCache.get(f.path);
    if (hit) shellCache.touch(f.path, now);
    if (!hit || hit.mtimeMs !== f.st.mtimeMs || hit.size !== f.st.size) {
      let text = null;
      try { ({ text } = await readTail(f.path, CONFIG.tailBytes)); } catch { /* being written */ }
      if (text == null) continue;
      hit = { mtimeMs: f.st.mtimeMs, size: f.st.size, shells: backgroundShells(parseJsonl(text)) };
      shellCache.set(f.path, hit, now);
    }
    if (!hit.shells.size) continue;
    const dir = path.join(PROJECTS_DIR, f.slug, 'terminals');
    let names = [];
    try { names = await readdirCached(dir, now, { ttlMs: 5000 }); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.txt')) continue;
      const p = path.join(dir, n);
      let t;
      try { t = terminalState(await readHead(p, 8192), (await readTail(p, 512)).text); } catch { continue; }
      const label = t.command && hit.shells.get(t.command.trim());
      if (!label) continue;
      out.push({ id: `cursor:${f.id}:terminal:${n}`, owner: `cursor:${f.id}`, kind: 'run', label, startedAt: t.startedAt, pid: t.pid, evidence: 'reported',
        state: t.exit == null ? 'running' : t.exit === 0 ? 'done' : 'failed', endedAt: t.exit == null ? null : (t.endedAt || now) });
    }
  }
  return out;
}
