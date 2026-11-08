// Codex collector: Codex Desktop, VS Code extension, CLI, subagents and Guardian reviewers.
//  - ~/.codex/state_5.sqlite  threads table: who exists, where, what they are called, who spawned whom
//  - rollout .jsonl per thread: task_started / task_complete, reasoning summaries, tool calls,
//    inter-agent messages (author → recipient), helper reports, Guardian verdicts
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexThreadLink } from '../open.js';
import { CONFIG } from '../config.js';
import { readTail, parseJsonl, snippet, basename, SeenMap, every } from '../tail.js';
import { readdir, readFile } from 'node:fs/promises';
import { nextOccurrence } from '../rrule.js';

let db = null;
// No process id anywhere in a rollout or the threads table (see server/links/process.js for what was looked at); the
// collector reports `pid: null` and the process reader may join a CLI process by cwd + start time (flagged weak).
// File touches (for the shared-file reader): apply_patch targets and FileChange items are writes; a CommandExecution's
// `parsed_cmd` names what a command read, and cat / sed -n / head / tail / rg / grep <path> in command text is a read.
const READ_CMDS = /(?:^|[\s;&|(`'"])(cat|head|tail|sed|rg|grep|less|more|bat)\s+([^\n;&|`)]*)/g;
const OPTION = /^-/;
const PATHISH = /^(?:~|\.{1,2}|\/)?[^\s'"`*?]*\/[^\s'"`*?]+$|^[^\s'"`*?/]+\.[A-Za-z0-9]{1,8}$/; // has a slash, or looks like file.ext

/** Paths a read-ish command names: the last path-like non-option token of each cat / sed -n / head / tail / rg / grep. */
export function readPathsOf(text) {
  const out = [];
  const s = String(text || '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'");
  for (const m of s.matchAll(READ_CMDS)) {
    const tokens = m[2].trim().split(/\s+/).map(t => t.replace(/^['"(]+|['")}\],]+$/g, '')).filter(Boolean); // quotes and the JS wrapper's `"}` fall off
    if (m[1] === 'sed' && !tokens.some(t => /^-n/.test(t))) continue; // only `sed -n …` is a read
    const paths = tokens.filter(t => !OPTION.test(t) && PATHISH.test(t));
    if (!paths.length) continue;
    const p = paths[paths.length - 1];
    if (/^(rg|grep)$/.test(m[1]) && paths.length === 1 && !/\//.test(p) && !/\.[A-Za-z0-9]+$/.test(p)) continue; // `rg foo` with no path
    out.push(p);
  }
  return out;
}

/** Touch paths to absolute ones: `~` expanded, relative ones against `base` (a CommandExecution's cwd, file:// or plain) or the thread's cwd. */
export function resolveTouches(touches, cwd) {
  const out = [];
  for (const t of touches || []) {
    let p = String(t.path || '');
    let base = String(t.base || cwd || '');
    if (base.startsWith('file://')) { try { base = decodeURIComponent(new URL(base).pathname); } catch { base = ''; } }
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    else if (!p.startsWith('/')) { if (!base.startsWith('/') || p.startsWith('-')) continue; p = path.resolve(base, p); }
    out.push({ path: path.normalize(p), op: t.op, at: t.at });
  }
  return out;
}
let DatabaseSync = null;
const tailCache = new SeenMap(); // rollout path -> { mtimeMs, size, info }; unused for an hour => dropped
const pruneCaches = every(60 * 1000, now => tailCache.prune(now));

let dbPath = null;
async function getDb() {
  if (db && dbPath === CONFIG.codex.stateDb) return db;
  if (db) { try { db.close(); } catch { /* ignore */ } db = null; }
  if (!DatabaseSync) ({ DatabaseSync } = await import('node:sqlite'));
  db = new DatabaseSync(CONFIG.codex.stateDb, { readOnly: true });
  dbPath = CONFIG.codex.stateDb;
  return db;
}

function parseArgs(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch { return {}; } }
const humanize = s => String(s || '').replace(/[_-]+/g, ' ').trim();

function describeFunction(name, ns, args) {
  const a = parseArgs(args);
  const n = (name || '').toLowerCase();
  if (n === 'shell' || n === 'shell_command' || n === 'exec_command' || n === 'container.exec') {
    const cmd = Array.isArray(a.command) ? a.command.join(' ') : (a.cmd || a.command || '');
    return `Running: ${snippet(String(cmd).split('\n')[0], 56) || 'a command'}`;
  }
  if (n === 'write_stdin') return 'Typing into a running program';
  if (n === 'apply_patch') return 'Editing files';
  if (n === 'update_plan') return 'Updating the plan';
  // the spawn itself shows as an amber "Calling for help" event bubble; the thought must not read the same
  if (n === 'spawn_agent') return `Spawning a helper: ${humanize(a.task_name) || 'new task'}`;
  if (n === 'send_message') return `Messaging ${humanize(a.target) || 'a teammate'}`;
  if (n === 'followup_task') return `Follow-up for ${humanize(a.target) || 'a helper'}`;
  // distinct from the lead's amber "Waiting for …" status line
  if (n === 'wait' || n === 'wait_agent' || n === 'wait_for_agent') return 'Checking on the team';
  if (n === 'list_agents') return 'Looking over the team';
  if (n === 'close_agent') return 'Thanking a helper, wrapping up';
  if (n === 'web_search' || n === 'search') return `Searching the web: ${snippet(a.query || a.q || '', 40)}`;
  if (n === 'view_image') return 'Looking at an image';
  if (n === 'read_file' || n === 'read') return `Reading ${basename(a.path || a.file_path) || 'a file'}`;
  if (n === 'js' || n === 'node_repl' || n === 'python') return 'Running some code';
  if (n === 'sleep') return 'Giving it a moment…';
  if (n.startsWith('request_user_input') || n === 'ask_user') return 'Asking the boss a question';
  if (ns && ns.startsWith('mcp__')) return `Using ${ns.replace(/^mcp__/, '').replace(/[_-]+/g, ' ')}: ${name}`;
  return `Using ${name}`;
}

function describeCustomTool(name, input) {
  const n = (name || '').toLowerCase();
  if (n === 'exec' || n === 'js' || n === 'repl') return 'Running some code';
  if (n === 'apply_patch') {
    const files = [...String(input || '').matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map(m => basename(m[1].trim()));
    return files.length ? `Editing ${files.slice(0, 2).join(', ')}${files.length > 2 ? '…' : ''}` : 'Editing files';
  }
  return `Using ${name}`;
}

/** The turn marker a line carries: `{ turn: 'working' | 'idle', turnAt, closed }`, or null. A `turn_aborted` ends the turn
 *  like a task_complete; for a helper thread it is also how its lead closed it (close_agent), so it is flagged `closed`. */
export function turnMarker(l) {
  if (l?.type !== 'event_msg') return null;
  const p = l.payload || {}, ts = Date.parse(l.timestamp) || 0;
  if (p.type === 'task_started') return { turn: 'working', turnAt: p.started_at ? p.started_at * 1000 : ts, closed: false };
  if (p.type === 'task_complete') return { turn: 'idle', turnAt: p.completed_at ? p.completed_at * 1000 : ts, closed: false };
  if (p.type === 'turn_aborted') return { turn: 'idle', turnAt: ts, closed: true };
  return null;
}

export function extractFromLines(lines) {
  const info = {
    thought: null, model: null, turn: null, turnAt: 0, closed: false, lastTs: 0, nickname: null, agentPath: null, parentThreadId: null,
    messages: [],   // { id, author, recipient, at }
    sends: [],      // { id, target, kind: 'send'|'followup'|'spawn', at }
    report: null,   // { turnId, text, at }
    verdict: null,  // { outcome, risk, at }
    waiting: false,
    lastCall: null, // the most recent tool call: { name, at, hasOutput, ask, quiet } (ask: why it would block on the user)
    approvalPolicy: null, approvalsReviewer: null, // newest turn settings: who answers an escalation ('user' or 'auto_review')
    touches: [],    // newest file touches { path, op: 'write' | 'read', at, base? } (paths as written; resolveTouches makes them absolute)
  };
  const touch = (p, op, at, base = null) => { if (p && info.touches.length < CONFIG.links.touchesMax) info.touches.push({ path: p, op, at, base }); };
  const outputsFor = new Set();
  let lastFunctionCall = null;
  let newer = 0; // lines after the newest tool call that show the turn moving on (bookkeeping such as token counts excluded)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const ts = Date.parse(l.timestamp) || 0;
    if (!info.lastTs) info.lastTs = ts;
    const p = l.payload || {};
    // Codex writes this note just for having opened a thread. It is not work, so it does not count as activity.
    const opened = l.type === 'event_msg' && p.type === 'thread_settings_applied';
    if (i === lines.length - 1) info.endsOnOpening = opened;
    if (!opened && !info.workTs) info.workTs = ts;
    if (!info.approvalsReviewer) {
      const st = l.type === 'turn_context' ? p : p.type === 'thread_settings_applied' ? p.thread_settings || {} : null;
      if (st && (st.approvals_reviewer || st.approval_policy)) { info.approvalsReviewer = st.approvals_reviewer || null; info.approvalPolicy = st.approval_policy || null; }
    }
    const bookkeeping = l.type === 'token_usage_record' || l.type === 'world_state' || (l.type === 'event_msg' && p.type === 'token_count');
    if (!info.lastCall && !bookkeeping && !(l.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call'))) newer++;
    if (l.type === 'event_msg') {
      if (!info.turn) { const m = turnMarker(l); if (m) Object.assign(info, m); }
      if (p.type === 'task_complete' && p.last_agent_message && !info.report) info.report = { turnId: p.turn_id, text: snippet(p.last_agent_message, 90), at: (p.completed_at ? p.completed_at * 1000 : ts) };
      if (!info.model && p.type === 'thread_settings_applied') info.model = p.thread_settings?.model || null;
      if (p.type === 'item_completed' && p.item) {
        const it = p.item;
        if (it.type === 'FileChange' && it.changes && typeof it.changes === 'object') for (const f of Object.keys(it.changes)) touch(f, 'write', ts);
        else if (it.type === 'CommandExecution') {
          const parsed = Array.isArray(it.parsed_cmd) ? it.parsed_cmd.filter(c => c?.type === 'read' && (c.path || c.name)) : [];
          if (parsed.length) for (const c of parsed) touch(c.path || c.name, 'read', ts, it.cwd || null);
          else for (const f of readPathsOf(Array.isArray(it.command) ? it.command.join(' ') : it.command)) touch(f, 'read', ts, it.cwd || null);
        }
      }
      if (!info.thought && p.type === 'item_completed' && p.item) {
        const t = p.item.type;
        if (t === 'CommandExecution') info.thought = { kind: 'tool', text: 'Ran a command, checking the output', at: ts };
        else if (t === 'ImageView') info.thought = { kind: 'tool', text: 'Looking at an image', at: ts };
        else if (t === 'SubAgentActivity') info.thought = { kind: 'tool', text: 'Coordinating the team', at: ts };
        else if (t === 'FileChange') info.thought = { kind: 'tool', text: 'Edited some files', at: ts };
        else if (t === 'WebSearch') info.thought = { kind: 'tool', text: 'Searching the web', at: ts };
      }
      continue;
    }
    if (l.type === 'session_meta') {
      if (!info.nickname && p.agent_nickname) info.nickname = p.agent_nickname;
      if (!info.agentPath && p.agent_path) info.agentPath = p.agent_path;
      if (!info.parentThreadId && p.parent_thread_id) info.parentThreadId = p.parent_thread_id;
      continue;
    }
    if (l.type === 'turn_context' && !info.model && p.model) { info.model = p.model; continue; }
    if (l.type !== 'response_item') continue;
    switch (p.type) {
      case 'agent_message':
        if (info.messages.length < 24) info.messages.push({ id: p.id, author: p.author, recipient: p.recipient, at: ts });
        break;
      case 'function_call_output': case 'custom_tool_call_output': {
        outputsFor.add(p.call_id);
        // a failed command is a real error (oops, the 💦 mark, a crumpled page in the bin), like Claude's tool errors
        if (!info.thought) {
          const o = p.output, txt = typeof o === 'string' ? o : Array.isArray(o) ? o.map(x => x?.text || '').join(' ') : '';
          const head = txt.trimStart().slice(0, 40);
          if (/^Script failed/.test(head) || /^Exit code: [1-9]/.test(head)) info.thought = { kind: 'error', text: 'Oops, that did not work. Trying again…', at: ts };
        }
        break;
      }
      case 'message': // a user line newer than a question answers it (replies arrive as user messages) or supersedes it
        if (p.role === 'user') info.userNewer = (info.userNewer || 0) + 1;
        break;
      case 'custom_tool_call': {
        if (!info.lastCall) {
          const esc = /require_escalated/.test(String(p.input || ''));
          info.lastCall = { name: (p.name || '').toLowerCase(), at: ts, hasOutput: outputsFor.has(p.call_id), ask: esc ? 'Needs your OK to run a command' : null, quiet: newer === 0 };
        }
        const cn = (p.name || '').toLowerCase();
        if (cn === 'apply_patch') for (const m of String(p.input || '').matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)) touch(m[1].trim(), 'write', ts);
        else if (cn === 'exec' || cn === 'js' || cn === 'repl') for (const f of readPathsOf(p.input)) touch(f, 'read', ts);
        break;
      }
      case 'function_call': {
        const a = parseArgs(p.arguments);
        const n = (p.name || '').toLowerCase();
        if (n === 'shell' || n === 'shell_command' || n === 'exec_command' || n === 'container.exec') {
          const cmd = Array.isArray(a.command) ? a.command.join(' ') : (a.cmd || a.command || '');
          for (const f of readPathsOf(cmd)) touch(f, 'read', ts, a.workdir || a.cwd || null);
        } else if (n === 'apply_patch') for (const m of String(a.patch || a.input || '').matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)) touch(m[1].trim(), 'write', ts);
        else if ((n === 'read_file' || n === 'read') && (a.path || a.file_path)) touch(a.path || a.file_path, 'read', ts);
        if (!lastFunctionCall) lastFunctionCall = { name: n, hasOutput: outputsFor.has(p.call_id) };
        const isQuestion = n.startsWith('request_user_input');
        const question = isQuestion ? `Question for you: ${snippet(a.questions?.[0]?.title || a.questions?.[0]?.question || 'needs your answer', 60)}` : null;
        if (!info.lastCall) {
          let ask = question;
          if (!ask && a.sandbox_permissions === 'require_escalated') ask = 'Needs your OK to run a command';
          info.lastCall = { name: n, at: ts, hasOutput: outputsFor.has(p.call_id), ask, quiet: newer === 0 };
        }
        // an async question (request_user_input_async, the desktop app's "Question" card) lets the turn carry on with
        // other calls: it stays open until a user line answers or supersedes it, not only while it is the newest call
        if (isQuestion && !info.pendingAsk && !outputsFor.has(p.call_id) && !info.userNewer) info.pendingAsk = { ask: question, at: ts };
        if (n === 'send_message' || n === 'followup_task') info.sends.push({ id: p.call_id || p.id, target: a.target, kind: n === 'send_message' ? 'send' : 'followup', at: ts });
        else if (n === 'spawn_agent') info.sends.push({ id: p.call_id || p.id, target: a.task_name, kind: 'spawn', at: ts });
        break;
      }
      default: break;
    }
    if (info.thought) continue;
    switch (p.type) {
      case 'message': {
        if (p.role !== 'assistant') break;
        const text = (p.content || []).filter(c => c.type === 'output_text').map(c => c.text).join(' ');
        if (!text.trim()) break;
        if (text.trim().startsWith('{')) {
          try { const j = JSON.parse(text); if (j.outcome) { info.verdict = { outcome: j.outcome, risk: j.risklevel || j.risk_level || null, at: ts }; info.thought = { kind: 'say', text: 'Review done.', at: ts }; break; } } catch { /* not json */ }
        }
        info.thought = { kind: 'say', text: snippet(text), at: ts };
        break;
      }
      case 'reasoning': {
        const s = (p.summary || []).map(x => x.text).join(' ');
        if (s.trim()) info.thought = { kind: 'think', text: snippet(s), at: ts };
        break;
      }
      case 'function_call': info.thought = { kind: 'tool', text: describeFunction(p.name, p.namespace, p.arguments), at: ts }; break;
      case 'custom_tool_call': info.thought = { kind: 'tool', text: describeCustomTool(p.name, p.input), at: ts }; break;
      case 'agent_message': info.thought = { kind: 'say', text: p.recipient === info.agentPath || p.recipient === '/root' && !info.agentPath ? 'Got a message from the team' : 'Messaging a teammate', at: ts }; break;
      default: break;
    }
  }
  if (lastFunctionCall && !lastFunctionCall.hasOutput && /wait/.test(lastFunctionCall.name)) info.waiting = true;
  return info;
}

const MARKER_RE = /"type":"(?:task_started|task_complete|turn_aborted)"/;
const SCAN_CHUNK = 1024 * 1024;
/** The newest turn marker in bytes [floor, end) of a rollout, read backwards a chunk at a time (a long turn writes
 *  megabytes of tool output after its task_started, so the 256 KB tail often holds none). Null when there is none. */
export async function findTurnMarker(filePath, end, floor) {
  const fh = await open(filePath, 'r');
  try {
    let hi = end, rest = Buffer.alloc(0); // rest: the head of the line that runs on into the chunk above
    while (hi > floor) {
      const lo = Math.max(floor, hi - SCAN_CHUNK);
      const buf = Buffer.alloc(hi - lo);
      await fh.read(buf, 0, buf.length, lo);
      const nl = lo > 0 ? buf.indexOf(10) : -1; // at lo === 0 the first line is whole; elsewhere it is cut
      let whole;
      if (nl < 0 && lo > 0) { rest = Buffer.concat([buf, rest]); hi = lo; continue; } // one very long line
      if (lo > 0) { whole = Buffer.concat([buf.subarray(nl + 1), rest]); rest = buf.subarray(0, nl); }
      else whole = Buffer.concat([buf, rest]);
      const lines = whole.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!MARKER_RE.test(lines[i])) continue;
        let l; try { l = JSON.parse(lines[i]); } catch { continue; }
        const m = turnMarker(l);
        if (m) return m;
      }
      hi = lo;
    }
    return null;
  } finally { await fh.close(); }
}

export async function rolloutInfo(filePath, now = Date.now()) {
  let st;
  try { st = await stat(filePath); } catch { return null; }
  const cached = tailCache.get(filePath);
  if (cached) tailCache.touch(filePath, now);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return { ...cached.info, mtimeMs: st.mtimeMs };
  let text, size;
  try { ({ text, size } = await readTail(filePath, CONFIG.tailBytes)); }
  catch { return cached ? { ...cached.info, mtimeMs: cached.mtimeMs } : null; } // vanished or locked mid-read
  const info = extractFromLines(parseJsonl(text));
  if (!info.turn) {
    // no marker in the tail: the file is append-only, so the newest marker is the one already known for this file unless
    // it grew by more than a tail since (then the gap is searched); a file seen for the first time is searched backwards once
    const tailStart = Math.max(0, size - CONFIG.tailBytes);
    const floor = cached ? Math.min(cached.size, tailStart) : Math.max(0, tailStart - (CONFIG.codex.scanBackBytes ?? 0));
    let m = null;
    if (tailStart > floor) { try { m = await findTurnMarker(filePath, tailStart, floor); } catch { /* vanished mid-read: fall back below */ } }
    if (!m && cached?.info.turn) m = { turn: cached.info.turn, turnAt: cached.info.turnAt, closed: cached.info.closed };
    if (m) Object.assign(info, m);
  }
  tailCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, info }, now);
  return { ...info, mtimeMs: st.mtimeMs };
}

function hostOf(originator, source) {
  const o = (originator || '').toLowerCase();
  if (source === 'vscode') return 'Codex (VS Code)';
  if (o.includes('desktop')) return 'Codex Desktop';
  if (o.includes('cli') || o.includes('tui') || o.includes('exec')) return 'Codex CLI';
  return 'Codex';
}

function parseSource(src) {
  if (!src || src[0] !== '{') return { plain: src, parentId: null, nickname: null, agentPath: null };
  try {
    const j = JSON.parse(src);
    const spawn = j.subagent?.thread_spawn;
    if (spawn) return { plain: 'subagent', parentId: spawn.parent_thread_id, nickname: spawn.agent_nickname, depth: spawn.depth, agentPath: spawn.agent_path };
    if (j.subagent?.other) return { plain: j.subagent.other, parentId: null, nickname: null, agentPath: null };
  } catch { /* ignore */ }
  return { plain: 'unknown', parentId: null, nickname: null, agentPath: null };
}

/** Is the thread blocked on the user? Rollouts carry no approval request / decision events, so:
 *  - an open request_user_input call is a question, at once;
 *  - an escalated command (sandbox_permissions: require_escalated) only waits on the user when the user reviews
 *    approvals (approvals_reviewer 'user', policy not 'never'); with 'auto_review' a Guardian reviewer decides, and that
 *    reviewer shows up as its own worker. Even then it counts only once the call has had no output and the turn has
 *    written nothing else for escalationQuietMs: an approved command runs, and its sibling commands and item events
 *    show the turn moving. */
export function askingFor(info, now) {
  if (info?.turn !== 'working') return null;
  if (info.pendingAsk) return info.pendingAsk.ask;
  const lc = info.lastCall;
  if (!lc || lc.hasOutput || !lc.ask) return null;
  if (lc.name.startsWith('request_user_input')) return lc.ask;
  if (info.approvalsReviewer === 'auto_review' || info.approvalPolicy === 'never') return null;
  if (!lc.quiet || now - lc.at < (CONFIG.codex.escalationQuietMs ?? 20000)) return null;
  return lc.ask;
}

export async function collectCodex(now) {
  const agents = [];
  pruneCaches(now);
  let d;
  try { d = await getDb(); } catch { return agents; }
  let rows = [];
  try {
    rows = d.prepare(`
      SELECT id, rollout_path, cwd, title, name, agent_nickname, thread_source, originator, source, model,
             created_at_ms, updated_at_ms, first_user_message, preview
      FROM threads
      WHERE archived = 0 AND COALESCE(updated_at_ms, updated_at * 1000) > ?
      ORDER BY updated_at_ms DESC LIMIT 80`).all(now - Math.max(CONFIG.activeWindowMs, CONFIG.codex.askingWindowMs || 0));
  } catch {
    try { d.close(); } catch { /* ignore */ }
    db = null;
    return agents;
  }

  const userThreadsByCwd = new Map();
  for (const r of rows) if (r.thread_source === 'user' || !r.thread_source) userThreadsByCwd.set(r.cwd, userThreadsByCwd.get(r.cwd) || r.id);

  for (const r of rows) {
    const src = parseSource(r.source);
    const isGuardian = r.thread_source === 'guardian_review' || src.plain === 'guardian';
    if (isGuardian && !CONFIG.codex.showGuardian) continue;
    const isSub = r.thread_source === 'subagent' || !!src.parentId;
    if (['avatar_quick_chat', 'onboarding_checklist', 'voice_chat'].includes(r.thread_source)) continue;

    const info = r.rollout_path ? await rolloutInfo(r.rollout_path, now) : null;
    // Codex prepares an empty reviewer when a chat is opened (a setup note and no more): one that never started is nobody
    if (isGuardian && !info?.turn) continue;
    // a chat only looked at: its file and its time moved, but its last work is what counts
    const lastActivity = info?.endsOnOpening ? (info.workTs || 0) : Math.max(r.updated_at_ms || 0, info?.mtimeMs || 0);
    let status, statusAt;
    if (info?.turn === 'working') {
      status = now - lastActivity < CONFIG.activeWindowMs ? 'working' : 'idle';
      statusAt = info.turnAt || lastActivity;
    } else if (info?.turn === 'idle') {
      status = 'idle'; statusAt = Math.max(info.turnAt, 0) || lastActivity;
    } else {
      status = now - lastActivity < CONFIG.idleAfterMs ? 'working' : 'idle';
      statusAt = lastActivity;
    }
    // a review is a 1–5 s turn: hold the reviewer at "working" a little after its task_complete so it does not flicker
    if (isGuardian && status === 'idle' && info?.turn === 'idle' && now - info.turnAt < (CONFIG.codex.reviewHoldMs ?? 0)) status = 'working';
    const asking = askingFor(info, now);
    if (asking) status = 'working'; // blocked on you: stays at the desk however long the answer takes
    else if (now - lastActivity > CONFIG.activeWindowMs) continue; // the wide window is only for threads waiting on you

    const kind = isGuardian ? 'guardian' : isSub ? 'subagent' : (hostOf(r.originator, r.source) === 'Codex CLI' ? 'cli' : 'desktop');
    const nickname = r.agent_nickname || src.nickname || info?.nickname || (isGuardian ? 'Guardian' : null);
    const parentThread = src.parentId || info?.parentThreadId || null;
    const parentId = parentThread ? `codex:${parentThread}` : (isGuardian && userThreadsByCwd.get(r.cwd) ? `codex:${userThreadsByCwd.get(r.cwd)}` : null);
    const agentPath = src.agentPath || info?.agentPath || (isSub ? null : '/root');
    const id = `codex:${r.id}`;

    // raw events, with agent paths; model.js resolves paths to ids within the team
    const events = [];
    for (const m of info?.messages || []) events.push({ id: `codex-msg:${m.id}`, kind: 'message', fromPath: m.author, toPath: m.recipient, at: m.at, origin: id });
    for (const s of info?.sends || []) {
      if (!agentPath) continue;
      const toPath = `${agentPath === '/root' ? '/root' : agentPath}/${s.target}`;
      if (s.kind === 'spawn') events.push({ id: `codex-spawn:${s.id}`, kind: 'spawn', from: id, toPath, text: humanize(s.target), at: s.at, origin: id });
      else events.push({ id: `codex-send:${s.id}`, kind: 'message', from: id, toPath, text: s.kind === 'followup' ? 'follow-up task' : null, at: s.at, origin: id });
    }
    if (isSub && info?.report && parentId) events.push({ id: `codex-report:${r.id}:${info.report.turnId}`, kind: 'report', from: id, to: parentId, text: info.report.text, at: info.report.at, origin: id });
    if (isGuardian && parentId) {
      events.push({ id: `review-start:${r.id}`, kind: 'review', from: id, to: parentId, text: null, at: r.created_at_ms || lastActivity, origin: id });
      if (info?.verdict) events.push({ id: `review-done:${r.id}`, kind: 'verdict', from: id, to: parentId, text: null, verdict: info.verdict, at: info.verdict.at, origin: id });
    }

    agents.push({
      id, vendor: 'codex', kind, host: hostOf(r.originator, r.source), nickname,
      openUrl: !isGuardian && !isSub && /desktop/i.test(r.originator || '') ? codexThreadLink(r.id) : null,
      task: isGuardian ? 'Guardian review'
        : isSub ? `Helper: ${humanize((agentPath || '').split('/').filter(Boolean).pop()) || r.title || 'side task'}`
        : (r.name || r.title || snippet(r.first_user_message || r.preview, 60) || basename(r.cwd)),
      taskRank: isGuardian || isSub ? 2 : r.name || r.title ? 2 : (r.first_user_message || r.preview) ? 1 : 0, // model.js keeps the strongest label seen
      cwd: r.cwd, project: basename(r.cwd), model: r.model || info?.model || null, branch: null,
      startedAt: r.created_at_ms || null, alive: true, status, statusAt, lastActivityAt: lastActivity,
      thought: isGuardian
        ? (status === 'working' ? { kind: 'think', text: 'Reviewing the latest work for risks…', at: lastActivity } : { kind: 'say', text: 'Review done.', at: lastActivity })
        : info?.thought || null,
      parentId, agentPath, waiting: !!(status === 'working' && info?.waiting), asking, verdict: info?.verdict || null, events,
      pid: null, touches: resolveTouches(info?.touches, r.cwd), // no pid on record (see the note above)
      // for model.js (not kept in the snapshot): the turn is open; its newest own call still runs; a helper thread was
      // closed (turn_aborted). A lead with an open turn, nothing of its own running and helpers at work is waiting on them;
      // a helper / reviewer thread persists until closed or its lead's turn is over, so that is when it leaves.
      turnOpen: info?.turn === 'working', callOpen: !!(info?.lastCall && !info.lastCall.hasOutput), closed: !!info?.closed,
    });
  }
  return agents;
}

// ---- schedules: ~/.codex/automations/<id>/automation.toml, each naming the chat it wakes (target_thread_id). The run itself
// is an ordinary turn in that chat. Next times are worked out from the rule: Codex adds an offset of its own (a
// .run-jitter-salt file; seen live, a run at 23:58:24 for a rule due at 00:00), so they are close, not exact.
const SCHEDULES_EVERY_MS = 30 * 1000;
let schedulesAt = 0, schedulesRaw = [];
export function parseAutomation(text) {
  const str = k => new RegExp(`^${k}\\s*=\\s*"([^"\\n]*)"`, 'm').exec(text)?.[1] ?? null;
  const num = k => Number(new RegExp(`^${k}\\s*=\\s*(\\d+)`, 'm').exec(text)?.[1]) || null;
  return { id: str('id'), name: str('name'), status: str('status'), rrule: str('rrule'), thread: str('target_thread_id'), createdAt: num('created_at') };
}
export async function codexSchedules(now = Date.now()) {
  if (now - schedulesAt >= SCHEDULES_EVERY_MS) {
    schedulesAt = now;
    const dir = path.join(CONFIG.codex.home, 'automations');
    let names = [];
    try { names = await readdir(dir); } catch { names = []; }
    const out = [];
    for (const n of names) {
      if (n.startsWith('.')) continue;
      try { out.push(parseAutomation(await readFile(path.join(dir, n, 'automation.toml'), 'utf8'))); } catch { /* not an automation */ }
    }
    schedulesRaw = out;
  }
  return schedulesRaw.filter(a => a.id && a.status === 'ACTIVE').map(a => ({
    id: `codex:schedule:${a.id}`, owner: a.thread ? `codex:${a.thread}` : null, kind: 'schedule', state: 'waiting', label: snippet(a.name || 'Scheduled task', 60),
    startedAt: a.createdAt, nextAt: nextOccurrence(a.rrule, a.createdAt, now), approx: true, evidence: 'reported',
  }));
}
