// Claude Code collector: desktop + CLI sessions, plus Agent-tool subagents.
//  - ~/.claude/sessions/<pid>.json                         live registry (status busy/idle, cwd, title)
//  - ~/.claude/projects/<slug>/<sessionId>.jsonl            transcript (what is in their head)
//  - ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl   subagent transcripts (helpers)
import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { readTail, parseJsonl, snippet, basename, isPidAlive, projectOf, SeenMap, every, readdirCached, statCached } from '../tail.js';

const tailCache = new SeenMap();      // transcript path -> { mtimeMs, size, info }
const registryCache = new Map();      // registry file name -> last good parse (only names still in the folder are kept)
const transcriptPaths = new SeenMap(); // sessionId -> { path, at } (found) or { path: null, at } (not written yet)
const pruneCaches = every(60 * 1000, now => { tailCache.prune(now); transcriptPaths.prune(now); metaCache.prune(now); });
const MISS_RECHECK_MS = 15 * 1000;    // how often to look again for a registered session's transcript that is not there yet
const metaCache = new SeenMap();      // subagent meta.json path -> { mtimeMs, size, meta }
const helperDescs = new Map();        // agentId -> { description, model, at }: outlives the lead transcript's tail (bounded)
const HELPER_DESCS_MAX = 500;
const TERMINAL_TOOLS = new Set(['SubagentHandback']); // a subagent's run is over once it hands its report back
// file touches for the shared-file reader: a write or a read of one path (searches are not reads)
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);

function slugify(cwd) { return cwd.replace(/[^A-Za-z0-9]/g, '-'); }

/** The folder a session started in. A transcript lives in the folder named after its starting cwd, while the cwd on its
 *  newest lines is wherever the session last changed into (a worker that `cd`s into outputs/x/claude-workspace would
 *  otherwise be filed under a project called "claude-workspace" once its registry entry goes). Returns the ancestor of
 *  `cwd` (or `cwd` itself) whose slug is the folder's name, else `cwd` unchanged. */
export function startingCwd(cwd, folderName) {
  if (!cwd || !folderName) return cwd || null;
  let cur = String(cwd).replace(/\/+$/, '') || '/';
  for (let guard = 0; guard < 64; guard++) {
    if (slugify(cur) === folderName) return cur;
    const up = cur.replace(/\/[^/]*$/, '');
    if (!up || up === cur) break;
    cur = up;
  }
  return cwd;
}

/** `{ path, op, at }` for a tool call that touched a file, or null. */
export function touchOf(name, input, at) {
  const i = input || {};
  const p = name === 'NotebookEdit' ? i.notebook_path : i.file_path;
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  if (WRITE_TOOLS.has(name)) return { path: p, op: 'write', at };
  if (READ_TOOLS.has(name)) return { path: p, op: 'read', at };
  return null;
}

function describeTool(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash': {
      if (i.description) return `Running: ${snippet(i.description, 56)}`;
      const cmd = String(i.command || '').split('\n')[0];
      return `Running: ${snippet(cmd, 56)}`;
    }
    case 'Read': return `Reading ${basename(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${basename(i.file_path)}`;
    case 'Write': return `Writing ${basename(i.file_path)}`;
    case 'NotebookEdit': return `Editing notebook ${basename(i.notebook_path)}`;
    case 'Grep': return `Searching for “${snippet(i.pattern, 30)}”`;
    case 'Glob': return `Looking for ${snippet(i.pattern, 36)}`;
    case 'Agent': case 'Task': return `Delegating: ${snippet(i.description || i.prompt, 48)}`;
    case 'TaskOutput': return 'Checking on a helper';
    case 'SendMessage': return `Messaging ${snippet(i.to || 'a teammate', 24)}`;
    case 'WebSearch': return `Searching the web: ${snippet(i.query, 44)}`;
    case 'WebFetch': { try { return `Reading ${new URL(i.url).hostname}`; } catch { return 'Reading a web page'; } }
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return 'Updating the task list';
    case 'AskUserQuestion': return 'Asking the boss a question';
    case 'EnterPlanMode': return 'Drafting a plan';
    case 'ExitPlanMode': return 'Presenting the plan';
    case 'Skill': return `Using the ${i.skill || ''} skill`.replace(/\s+/g, ' ');
    case 'Artifact': return 'Publishing an artifact';
    case 'SubagentHandback': return 'Handing in the report';
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
      if (m) return `Using ${m[2].replace(/[_-]+/g, ' ')}`;
      return `Using ${name}`;
    }
  }
}

/** What a person actually typed in a user line: text blocks without image placeholders ("[Image #1]", "[Image: original
 *  1628x2225, …]") or system reminders. Meta lines (image companions, task notifications) are not requests at all. */
function requestText(l) {
  if (l.isMeta) return '';
  const c = l.message?.content;
  const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/\[Image\b[^\]]*\]/g, ' ')
    .trim();
}

// a turn is over: the hook summary written after the last reply, or (CLI) the turn's duration
const TURN_END_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration']);

function extractFromLines(lines) {
  const info = {
    thought: null, model: null, lastTs: 0, entrypoint: null, cwd: null, sessionId: null, gitBranch: null,
    agentDescs: {},        // agentId -> { description, model, at }  (from Agent tool results)
    firstUserText: null,   // the brief a subagent received
    lastText: null,        // { text, uuid, at } last assistant prose (a report when the agent is done)
    waiting: false,        // blocked on a helper / a question for the boss
    pendingTool: null, pendingInput: null, pendingAt: 0,  // the newest tool call still without a result
    awaitingModel: null,   // newest user/assistant line is from the user side (prompt or tool results): the model is replying
    lastToolName: null,    // name of the newest tool call (a hand-back ends a subagent's run)
    lastToolAt: 0,         // when the newest tool call was made
    turnEnded: null,       // the newest turn line closes the turn (end_turn reply, stop-hook summary, an interrupt)
    turnEndAt: 0,
    handback: null,        // { id, text, at } the newest SubagentHandback call (a subagent's report to its caller)
    toolAfterHandback: false, // a newer tool call than that hand-back (the helper was picked up again)
    touches: [],           // newest file touches { path, op: 'write' | 'read', at } (for the shared-file reader)
  };
  const resultsFor = new Set();
  let newerTool = false; // a tool call newer than the line being looked at
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const ts = Date.parse(l.timestamp) || 0;
    if (!info.lastTs && ts) info.lastTs = ts;
    if (info.awaitingModel === null && (l.type === 'user' || l.type === 'assistant') && l.message) {
      const c = l.message.content, txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
      info.awaitingModel = l.type === 'user' && !/^\s*\[Request interrupted/.test(txt); // Esc writes a user line, but nobody is replying
    }
    if (info.turnEnded === null) {
      if (l.type === 'system' && TURN_END_SUBTYPES.has(l.subtype)) { info.turnEnded = true; info.turnEndAt = ts; }
      else if (l.type === 'assistant' && l.message) {
        const blocks = Array.isArray(l.message.content) ? l.message.content : [];
        info.turnEnded = l.message.stop_reason === 'end_turn' && !blocks.some(b => b.type === 'tool_use');
        if (info.turnEnded) info.turnEndAt = ts;
      } else if (l.type === 'user' && l.message) {
        info.turnEnded = info.awaitingModel === false; // only an interrupt: any other user line starts (or continues) a turn
        if (info.turnEnded) info.turnEndAt = ts;
      }
    }
    if (!info.entrypoint && l.entrypoint) info.entrypoint = l.entrypoint;
    if (!info.cwd && l.cwd) info.cwd = l.cwd;
    if (!info.sessionId && l.sessionId) info.sessionId = l.sessionId;
    if (!info.gitBranch && l.gitBranch) info.gitBranch = l.gitBranch;
    if (l.toolUseResult && typeof l.toolUseResult === 'object' && l.toolUseResult.agentId && !info.agentDescs[l.toolUseResult.agentId]) {
      info.agentDescs[l.toolUseResult.agentId] = { description: l.toolUseResult.description || '', model: l.toolUseResult.resolvedModel || null, at: ts, status: l.toolUseResult.status };
    }
    if (l.type === 'user' && Array.isArray(l.message?.content)) {
      for (const b of l.message.content) if (b.type === 'tool_result') resultsFor.add(b.tool_use_id);
    }
    if (l.type === 'assistant' && l.message?.content) {
      if (!info.model && l.message.model) info.model = l.message.model;
      const blocks = Array.isArray(l.message.content) ? l.message.content : [];
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j];
        if (b.type === 'text' && b.text?.trim() && !info.lastText) info.lastText = { text: snippet(b.text, 90), uuid: l.uuid, at: ts };
        if (b.type === 'tool_use') {
          if (!info.lastToolAt) info.lastToolAt = ts;
          if (TERMINAL_TOOLS.has(b.name) && !info.handback) {
            info.handback = { id: b.id || l.uuid, text: snippet(b.input?.message || b.input?.result || '', 90), at: ts };
            info.toolAfterHandback = newerTool;
          }
          newerTool = true;
          if (info.touches.length < CONFIG.links.touchesMax) { const t = touchOf(b.name, b.input, ts); if (t) info.touches.push(t); }
        }
        if (info.thought) continue;
        if (b.type === 'tool_use' && !info.lastToolName) info.lastToolName = b.name;
        if (b.type === 'tool_use') {
          info.thought = { kind: 'tool', text: describeTool(b.name, b.input), at: ts };
          if (!resultsFor.has(b.id)) {
            info.pendingTool = b.name; info.pendingInput = b.input || null; info.pendingAt = ts;
            if (b.name === 'Agent' || b.name === 'Task' || b.name === 'TaskOutput') info.waiting = true;
          }
        } else if (b.type === 'text' && b.text?.trim()) info.thought = { kind: 'say', text: snippet(b.text), at: ts };
        else if (b.type === 'thinking') info.thought = { kind: 'think', text: snippet(b.thinking) || 'Hmm… thinking it through', at: ts };
      }
    } else if (l.type === 'user' && l.message) {
      const c = l.message.content;
      const isToolResult = Array.isArray(c) && c.some(b => b.type === 'tool_result');
      if (isToolResult) {
        if (!info.thought && c.some(b => b.type === 'tool_result' && b.is_error)) info.thought = { kind: 'error', text: 'Oops, that did not work. Trying again…', at: ts };
        continue; // keep looking back for the tool_use that caused it
      }
      const text = requestText(l);
      if (text) {
        if (!info.thought) info.thought = /^\[Request interrupted/.test(text)
          ? { kind: 'say', text: 'Stopped by you', at: ts } // Esc in the app: not a request
          : { kind: 'read', text: `New request: ${snippet(text, 50)}`, at: ts };
        info.firstUserText = snippet(text, 70); // keeps overwriting while scanning backwards -> ends at the earliest in the tail
      }
    }
  }
  info.jobs = jobsFromLines(lines);
  info.sessionStarts = sessionStartsFromLines(lines);
  return info;
}

const STARTED_RE = /Started session "[^"]*" \(session_id: (local_[0-9a-f-]+)/;
/** Chats this one started: a session-starting tool call whose result gives the new chat's id, the same id its registry
 *  entry names as `hostSessionId`. Only the result of that very call counts, not a mention of one anywhere else. */
export function sessionStartsFromLines(lines) {
  const calls = new Set(), out = [];
  for (const l of lines) {
    const c = l.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use' && String(b.name || '').endsWith('start_session')) calls.add(b.id);
      else if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const m = STARTED_RE.exec(typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x?.text || '').join(' ') : '');
        // `by`: the session the line itself names. A continued chat's file carries copies of its history, still stamped with the
        // session that really made the call
        if (m) out.push({ hostId: m[1], at: Date.parse(l.timestamp) || 0, by: l.sessionId ? `claude:${l.sessionId}` : null });
      }
    }
  }
  return out;
}
/** Start calls already scrolled out of the transcripts' tails: read once, line by line, for the transcripts of the last
 *  `withinMs`. Gives way between files, so the office keeps running. */
export async function scanSessionStarts(note, { now = Date.now(), withinMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  let dirs = [];
  try { dirs = await readdir(CONFIG.claude.projectsDir); } catch { return 0; }
  let found = 0;
  for (const dir of dirs) {
    let names = [];
    try { names = (await readdir(path.join(CONFIG.claude.projectsDir, dir))).filter(n => n.endsWith('.jsonl') && !n.startsWith('.')); } catch { continue; }
    for (const n of names) {
      const p = path.join(CONFIG.claude.projectsDir, dir, n);
      try { if (now - (await stat(p)).mtimeMs > withinMs) continue; } catch { continue; }
      const kept = [];
      try {
        for await (const line of createInterface({ input: createReadStream(p), crlfDelay: Infinity })) {
          if (!line.includes('start_session') && !line.includes('Started session')) continue;
          try { kept.push(JSON.parse(line)); } catch { /* a line being written */ }
        }
      } catch { continue; }
      for (const s of sessionStartsFromLines(kept)) { note(s.by || `claude:${n.slice(0, -6)}`, s.hostId, s.at); found++; }
      await new Promise(r => setImmediate(r));
    }
  }
  return found;
}

const NOTE_LINES = new Set(['queue-operation', 'attachment']);
const JOB_END = { completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped' };
const plainText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text || '').join(' ') : ''; // never a tool's output, which may only be quoting one
/** What this transcript says about work outside its turns: a background command starts with `backgroundTaskId` on its tool
 *  result and ends with a task notification; a wake-up timer is a ScheduleWakeup call, replaced by the next one. A
 *  background helper is a worker of its own, so it is not a job. Observations for the job book (server/jobbook.js). */
export function jobsFromLines(lines) {
  const calls = new Map(), jobs = new Map();
  let timer = null;
  for (const l of lines) {
    const ts = Date.parse(l.timestamp) || 0, c = l.message?.content;
    if (l.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type !== 'tool_use') continue;
        calls.set(b.id, b);
        if (b.name !== 'ScheduleWakeup') continue;
        if (timer) { jobs.set(timer.key, { ...timer, state: 'stopped', endedAt: ts }); timer = null; }
        const delay = Number(b.input?.delaySeconds);
        if (!b.input?.stop && delay > 0) { timer = { key: `wake:${b.id}`, kind: 'timer', state: 'waiting', label: snippet(b.input?.reason || 'Wake up and carry on', 60), startedAt: ts, nextAt: ts + delay * 1000 }; jobs.set(timer.key, timer); }
      }
    } else if (l.type === 'user') {
      const taskId = l.toolUseResult && typeof l.toolUseResult === 'object' ? l.toolUseResult.backgroundTaskId : null;
      if (taskId && Array.isArray(c)) {
        const call = calls.get(c.find(b => b.type === 'tool_result')?.tool_use_id);
        if (!call || !HELPER_TOOLS.has(call.name)) jobs.set(`job:${taskId}`, { key: `job:${taskId}`, kind: 'run', state: 'running', label: call?.input?.description ? snippet(call.input.description, 60) : call ? describeTool(call.name, call.input) : null, startedAt: ts, needsShell: !call || call.name === 'Bash' });
      }
    }
    // the end note: a user line when it starts a turn; when it arrives mid-turn, a queue-operation or attachment line
    const note = l.type === 'user' ? plainText(c) : NOTE_LINES.has(l.type) ? JSON.stringify(l) : '';
    if (note.includes('<task-notification')) {
      for (const m of note.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        const id = /<task-id>([^<]+)</.exec(m[0])?.[1], status = /<status>([^<]+)</.exec(m[0])?.[1];
        if (!id || !status) continue;
        const key = `job:${id}`, had = jobs.get(key);
        // the first note wins (the same one is written more than once). A job started before this tail begins gets an
        // end note alone, which the book matches to the job it remembers
        if (!had?.endedAt) jobs.set(key, { ...(had || { key }), state: JOB_END[status] || 'unknown', endedAt: ts });
      }
    }
  }
  return [...jobs.values()];
}

async function transcriptInfo(filePath, now = Date.now()) {
  let st;
  try { st = await stat(filePath); } catch { return null; }
  const cached = tailCache.get(filePath);
  if (cached) tailCache.touch(filePath, now);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return { ...cached.info, activeAt: cached.info.lastTs || st.mtimeMs };
  let text;
  try { ({ text } = await readTail(filePath, CONFIG.tailBytes)); }
  catch { return cached ? { ...cached.info, activeAt: cached.info.lastTs || cached.mtimeMs } : null; } // vanished or locked mid-read
  const info = extractFromLines(parseJsonl(text));
  tailCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, info }, now);
  // activity = the last timestamped entry, not the file's mtime: the desktop app appends untimed bookkeeping lines
  // (title, agent name, last prompt) to idle sessions, which must not count as work
  return { ...info, activeAt: info.lastTs || st.mtimeMs };
}

/** Where a registered session's transcript is: the folder named after its cwd, else any project folder (a session that
 *  changed directory). Remembered per session; a transcript not written yet is looked for again every MISS_RECHECK_MS
 *  rather than every poll (the fallback checks every project folder). */
async function findTranscript(cwd, sessionId, now) {
  const hit = transcriptPaths.get(sessionId);
  if (hit?.path) {
    try { await stat(hit.path); transcriptPaths.touch(sessionId, now); return hit.path; } catch { /* moved: look again */ }
  } else if (hit && now - hit.at < MISS_RECHECK_MS) { transcriptPaths.touch(sessionId, now); return null; }
  let found = null;
  const direct = path.join(CONFIG.claude.projectsDir, slugify(cwd || ''), `${sessionId}.jsonl`);
  try { await stat(direct); found = direct; } catch { /* fall through */ }
  if (!found) {
    try {
      for (const dir of await readdirCached(CONFIG.claude.projectsDir, now)) {
        const p = path.join(CONFIG.claude.projectsDir, dir, `${sessionId}.jsonl`);
        try { await stat(p); found = p; break; } catch { /* next */ }
      }
    } catch { /* no projects dir */ }
  }
  transcriptPaths.set(sessionId, { path: found, at: now }, now);
  return found;
}

const HELPER_TOOLS = new Set(['Agent', 'Task', 'TaskOutput']);
/** Is the session blocked on the user? A question or a plan waiting for approval is an open tool call; a permission
 *  prompt is any other open tool call while the session itself reports idle (it is not running anything). */
function askingFor(info, registryStatus, now) {
  if (!info?.pendingTool || HELPER_TOOLS.has(info.pendingTool)) return null;
  if (info.pendingTool === 'AskUserQuestion') {
    const q = info.pendingInput?.questions?.[0]?.question || info.pendingInput?.question;
    return `Question for you: ${snippet(q || 'needs your answer', 60)}`;
  }
  if (info.pendingTool === 'ExitPlanMode') return 'Plan ready for your review';
  if (registryStatus && registryStatus !== 'busy' && now - info.pendingAt > 3000) return `Needs your OK: ${describeTool(info.pendingTool, info.pendingInput)}`;
  return null;
}

/** A tool call still running (a long build, a test suite, a helper's own subagent) is work even though the transcript is
 *  silent meanwhile, unless the open call is really the session waiting on the user. */
function toolOpen(info, asking, now) {
  return !!(info?.pendingTool && !asking && now - info.pendingAt < CONFIG.activeWindowMs);
}

/** A turn handed to the model (last line is a prompt or tool results) writes nothing until the reply arrives, which
 *  can take minutes for a long think; without a registry status (subagents, headless runs) that still counts as work. */
const REPLY_GAP_MS = 3 * 60 * 1000; // a model reply rarely takes longer than this; past it the turn was abandoned
// a subagent's reply is written in one piece when it is complete, and a long one (a big file written in one call, a
// long think) took 146–345 s in the live audit: give helpers up to the active window before calling the turn abandoned
const SUBAGENT_REPLY_GAP_MS = 10 * 60 * 1000;
function modelReplying(info, now, gapMs = REPLY_GAP_MS) {
  return !!(info?.awaitingModel && !TERMINAL_TOOLS.has(info.lastToolName) && now - info.activeAt < gapMs);
}

function hostOf(entrypoint) {
  if (!entrypoint) return 'Claude Code';
  if (entrypoint.includes('desktop')) return 'Claude Desktop';
  if (entrypoint.includes('sdk')) return 'Claude Agent SDK';
  if (entrypoint.includes('vscode') || entrypoint.includes('ide')) return 'Claude Code (IDE)';
  return 'Claude Code CLI';
}

/** agent-<id>.meta.json beside a subagent's transcript: { description, agentType, finished, … }, written at launch and
 *  rewritten (finished: true) when the run ends. Re-read only when it changes. */
async function readMeta(file, now) {
  let st;
  try { st = await stat(file); } catch { metaCache.delete(file); return null; }
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { metaCache.touch(file, now); return hit.meta; }
  let meta = null;
  try { meta = { ...JSON.parse(await readFile(file, 'utf8')), mtimeMs: st.mtimeMs }; }
  catch { return hit?.meta || null; } // caught mid-write: keep the last good read
  metaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta }, now);
  return meta;
}

/** A helper's brief, model and launch time, remembered for the process lifetime: the Agent tool result that carries them
 *  scrolls out of the lead transcript's tail within minutes. */
function rememberHelper(agentId, fromParent, meta) {
  const prev = helperDescs.get(agentId);
  const next = {
    description: (typeof meta?.description === 'string' && meta.description.trim()) || fromParent?.description || prev?.description || '',
    model: fromParent?.model || prev?.model || null,
    at: fromParent?.at || prev?.at || null,
  };
  helperDescs.delete(agentId); // re-insert: most recently seen last, so the oldest go first
  helperDescs.set(agentId, next);
  while (helperDescs.size > HELPER_DESCS_MAX) helperDescs.delete(helperDescs.keys().next().value);
  return next;
}

/** When a subagent's run ended, or 0 while it is still on it: it called SubagentHandback (and nothing since), or its
 *  meta.json says finished and no tool call came after that was written (a helper picked up again works on). */
const RESUME_SLACK_MS = 2000;
function finishedAt(info, meta) {
  if (info.handback && !info.toolAfterHandback) return info.handback.at || info.activeAt;
  if (meta?.finished === true && !(info.lastToolAt > meta.mtimeMs + RESUME_SLACK_MS)) return meta.mtimeMs;
  return 0;
}

/** Subagents launched with the Agent tool live next to the parent transcript. Returns how many are working. */
async function collectSubagents(parentId, transcriptPath, parentInfo, now, out) {
  if (!transcriptPath) return 0;
  const dir = transcriptPath.replace(/\.jsonl$/, '') + '/subagents';
  let entries = [];
  try { entries = await readdirCached(dir, now); } catch { return 0; }
  let busy = 0;
  for (const e of entries) {
    const m = /^agent-(.+)\.jsonl$/.exec(e);
    if (!m) continue;
    const p = path.join(dir, e);
    const st = await statCached(p, now, { staleMs: CONFIG.activeWindowMs });
    if (!st || now - st.mtimeMs > CONFIG.activeWindowMs) continue;
    const info = await transcriptInfo(p, now);
    if (!info) continue;
    const agentId = m[1];
    const meta = await readMeta(path.join(dir, `agent-${agentId}.meta.json`), now);
    const desc = rememberHelper(agentId, parentInfo?.agentDescs?.[agentId], meta);
    const doneAt = finishedAt(info, meta);
    const working = !doneAt && (now - info.activeAt < CONFIG.idleAfterMs || toolOpen(info, askingFor(info, null, now), now) || modelReplying(info, now, SUBAGENT_REPLY_GAP_MS));
    if (working) busy++;
    const id = `${parentId}/${agentId}`;
    const events = [];
    if (desc.at && desc.description) events.push({ id: `claude-spawn:${agentId}`, kind: 'spawn', from: parentId, to: id, text: snippet(desc.description, 60), at: desc.at });
    if (info.handback) {
      // the report it handed back (every subagent ends with a SubagentHandback call, not with a final reply)
      if (info.handback.text) events.push({ id: `claude-report:${agentId}:${info.handback.id}`, kind: 'report', from: id, to: parentId, text: info.handback.text, at: info.handback.at || info.activeAt });
    } else if (!working && info.lastText && info.thought?.kind !== 'tool') {
      events.push({ id: `claude-report:${agentId}:${info.lastText.uuid}`, kind: 'report', from: id, to: parentId, text: info.lastText.text, at: info.lastText.at || info.activeAt });
    }
    const statusAt = doneAt ? Math.min(doneAt, now) : info.activeAt;
    out.push({
      id, vendor: 'claude', kind: 'subagent', host: hostOf(info.entrypoint),
      nickname: null,
      task: desc.description ? `Helper: ${snippet(desc.description, 50)}` : (info.firstUserText ? `Helper: ${info.firstUserText}` : 'Helper'),
      taskRank: desc.description ? 2 : info.firstUserText ? 1 : 0,
      cwd: info.cwd, project: projectOf(info.cwd), model: desc.model || info.model || null, branch: info.gitBranch,
      startedAt: desc.at || null, alive: true,
      status: working ? 'working' : 'idle', statusAt, lastActivityAt: info.activeAt,
      finished: !!doneAt, finishedAt: doneAt || null,
      thought: info.thought, parentId, waiting: false, events,
      pid: null, touches: info.touches, jobObs: info.jobs, // a subagent runs inside the lead's process
    });
  }
  return busy;
}

/** A session whose turn is over (its last reply ended the turn) is not working whatever the registry still says (it
 *  stayed "busy" for hours in the live audit): it waits on its helpers while any of them works, else it is your turn. */
function leadState(info, helpersWorking) {
  if (!info?.turnEnded) return null;
  return helpersWorking > 0 ? { status: 'working', waiting: true } : { status: 'idle', waiting: false };
}

export async function collectClaude(now) {
  const agents = [];
  const seen = new Set();

  pruneCaches(now);

  // 1. Registered live sessions
  let files = [];
  try { files = (await readdirCached(CONFIG.claude.sessionsDir, now, { ttlMs: 5000 })).filter(f => f.endsWith('.json')); } catch { /* none */ }
  for (const f of registryCache.keys()) if (!files.includes(f)) registryCache.delete(f); // session ended, file removed
  for (const f of files) {
    let s;
    try { s = JSON.parse(await readFile(path.join(CONFIG.claude.sessionsDir, f), 'utf8')); registryCache.set(f, s); }
    catch { s = registryCache.get(f); if (!s) continue; } // caught mid-write: keep the last good read
    if (!s.sessionId) continue;
    const alive = isPidAlive(s.pid);
    seen.add(s.sessionId);
    const transcript = await findTranscript(s.cwd, s.sessionId, now);
    const info = transcript ? await transcriptInfo(transcript, now) : null;
    const transcriptActive = info && now - info.activeAt < CONFIG.idleAfterMs;
    const asking = alive ? askingFor(info, s.status, now) : null;
    const id = `claude:${s.sessionId}`;
    const helpers = [];
    const helpersWorking = alive ? await collectSubagents(id, transcript, info, now, helpers) : 0;
    const turn = alive && !asking ? leadState(info, helpersWorking) : null;
    // someone waiting on you stays at the desk; an open tool call counts unless the registry says the session is idle
    const busy = turn ? turn.status === 'working'
      : s.status === 'busy' || transcriptActive || !!asking || (alive && s.status !== 'idle' && toolOpen(info, asking, now));
    const statusAt = s.statusUpdatedAt || s.updatedAt || s.startedAt || now;
    agents.push({
      id, vendor: 'claude',
      kind: s.entrypoint === 'claude-desktop' ? 'desktop' : 'cli',
      host: hostOf(s.entrypoint),
      task: s.name || basename(s.cwd), taskRank: s.name ? 2 : 0, cwd: s.cwd, project: projectOf(s.cwd), // the registry's title, else the folder
      model: info?.model || null, branch: info?.gitBranch || null, startedAt: s.startedAt || null, alive,
      status: !alive ? 'gone' : busy ? 'working' : 'idle',
      statusAt: turn && !busy ? (info.turnEndAt || info.activeAt) : transcriptActive ? info.activeAt : statusAt,
      lastActivityAt: Math.max(statusAt, info?.activeAt || 0),
      thought: info?.thought || null, parentId: null, waiting: turn ? turn.waiting : !!(busy && info?.waiting), asking, events: [],
      pid: alive && Number.isInteger(s.pid) && s.pid > 0 ? s.pid : null, touches: info?.touches || [], jobObs: info?.jobs, startCalls: info?.sessionStarts, hostId: s.hostSessionId || null, // the registry names the process
    });
    agents.push(...helpers);
  }

  // 2. Unregistered sessions (headless `claude -p`, SDK runs): recently modified transcripts
  //    Folder listings are reused while the folder is unchanged, and transcripts already older than the window are
  //    stat'ed again only every 15 s, so the pass stays cheap however much history has piled up.
  let dirs = [];
  try { dirs = await readdirCached(CONFIG.claude.projectsDir, now); } catch { /* none */ }
  for (const dir of dirs) {
    const full = path.join(CONFIG.claude.projectsDir, dir);
    let entries = [];
    try { entries = await readdirCached(full, now); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const sessionId = e.slice(0, -6);
      if (seen.has(sessionId)) continue;
      const p = path.join(full, e);
      const st = await statCached(p, now, { staleMs: CONFIG.activeWindowMs });
      if (!st || now - st.mtimeMs > CONFIG.activeWindowMs) continue;
      const info = await transcriptInfo(p, now);
      if (!info || !info.sessionId || now - info.activeAt > CONFIG.activeWindowMs) continue;
      seen.add(sessionId);
      const id = `claude:${sessionId}`;
      info.cwd = startingCwd(info.cwd, dir); // the project the session belongs to, not the subfolder it last worked in
      const helpers = [];
      const helpersWorking = await collectSubagents(id, p, info, now, helpers);
      const asking = askingFor(info, null, now);
      const turn = !asking ? leadState(info, helpersWorking) : null;
      const working = turn ? turn.status === 'working'
        : now - info.activeAt < CONFIG.idleAfterMs || toolOpen(info, asking, now) || modelReplying(info, now);
      agents.push({
        id, vendor: 'claude',
        kind: info.entrypoint === 'claude-desktop' ? 'desktop' : 'cli',
        host: hostOf(info.entrypoint),
        // the first prompt in the tail is a weaker label than a registry title: model.js keeps the title a session had
        // while registered (the registry file goes when the session ends, this path then reports it as it leaves)
        task: info.firstUserText || basename(info.cwd), taskRank: info.firstUserText ? 1 : 0, cwd: info.cwd, project: projectOf(info.cwd),
        model: info.model, branch: info.gitBranch, startedAt: null, alive: true,
        status: working ? 'working' : 'idle', statusAt: turn && !working ? (info.turnEndAt || info.activeAt) : info.activeAt, lastActivityAt: info.activeAt,
        thought: info.thought, parentId: null, waiting: turn ? turn.waiting : !!(working && info.waiting), events: [],
        pid: null, touches: info.touches, jobObs: info.jobs, startCalls: info.sessionStarts, // unregistered (headless / SDK): no pid on record and no start time to join one by
      });
      agents.push(...helpers);
    }
  }
  return agents;
}
