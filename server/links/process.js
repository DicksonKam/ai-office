// Process ancestry: evidence the office reads without anyone's help. When the process running one agent is an ancestor
// of the process running another, the first launched the second (`launch`, confidence `structural`, channel
// `process`). When two agents' nearest common ancestor is a plain program that is neither of them and not a shell,
// terminal, launchd or an app bundle, that program launched both: a `launch` link from a stub `name:<program>` to each,
// so the office can show "launched by X" without knowing X.
//
// Where agent pids come from (Milestone 12, E1), per vendor:
//   Claude   ~/.claude/sessions/<pid>.json names pid + sessionId -> claude:<sessionId>  (explicit: structural). The
//            collector carries it as `agent.pid`. Agent-tool subagents run inside the lead's process: no pid of their own.
//   Codex    nothing explicit anywhere we looked: no pid in the rollout's `session_meta` (cwd, originator, cli_version,
//            source, parent_thread_id) or `turn_context`, none in the threads table, none in session_index.jsonl; the
//            thread-writer-locks are empty files. `CommandExecution.process_id` is the OS pid of a short-lived command
//            child (gone by the next poll; under Codex Desktop its parent is a `codex sandbox` helper shared by every
//            thread of that workspace), so it cannot name the agent. What exists is the process table: a CLI run
//            (`codex`, `codex exec`) is one process per thread in the thread's cwd started when the thread was created;
//            Codex Desktop runs one `codex app-server --listen stdio://` per workspace cwd (under a `node_repl` helper),
//            shared by every thread in that cwd. Hence the weak join below: same cwd, start within a minute, exactly one
//            candidate, exactly one agent; a Desktop thread matches only when it is alone and started with its server.
//   Cursor   nothing: no pid in agent-cli-state.json, ide_state.json or the composer headers; IDE chats live inside the
//            Cursor app (an app bundle: excluded from ancestry anyway); cursor-agent CLI transcripts carry no start
//            time, so not even the weak join applies.
//   Gemini   nothing explicit; current CLI session files carry startTime and the project root, so a `gemini` process
//            in that root started at that time qualifies for the weak join (this Mac only has the legacy prompt log:
//            untested live).
// A weak mapping is flagged (`ctx.pidWeak`, `agent.pidWeak`) and every launch link touching it carries confidence
// `artifact` (dashed; it never drives behaviour). `pid:<n>` refs in links already read this poll count as pids too.
// `ps -axo pid,ppid,lstart,command` runs at most every CONFIG.links.psEveryMs through execFile (never a shell); when it
// fails the last table is kept. A process's cwd comes from `lsof -a -p <pid> -d cwd` (~25 ms), only for the few
// candidates that already match a vendor and a start time, once per process.
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { basename } from '../tail.js';
import { makeLink, parseParty } from './link.js';

const MAX_DEPTH = 64; // longest ancestor chain followed (a cycle in a torn table must not spin)
const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|tsx|ts-node)$/i;
const EXCLUDED_NAMES = /^(launchd|launchctl|login|zsh|bash|fish|sh|dash|tcsh|ksh|tmux|screen|sshd|ssh|sudo|su|xpcproxy|distnoted|open|Terminal|iTerm2?|Warp|Hyper|Alacritty|kitty|WezTerm|Finder|Dock|Claude|Codex|Cursor|Code|Electron|Visual Studio Code|Code Helper.*)$/i;
// `ps` prints lstart as "Sun Oct 25 04:10:14 2026" (day padded with a space); Date.parse reads it in the local zone
const LSTART_RE = /^(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/;
// what the vendor's own CLI looks like in a command line (the weak join only considers these)
const VENDOR_CLI = {
  claude: cmd => /^claude$/.test(labelOf(cmd)),
  codex: cmd => /^codex$/.test(labelOf(cmd)) && !/\bcodex\s+sandbox\b/.test(cmd),
  cursor: cmd => /^cursor-agent$/.test(labelOf(cmd)),
  gemini: cmd => /^gemini(\.js)?$/.test(labelOf(cmd)) || /gemini-cli|\/bin\/gemini(\s|$)/.test(cmd),
};

// a vendor's host: the program its chats run inside (the CLI, the Desktop app's `codex app-server`, Cursor's app). An
// agent process with one of these above it was started from inside that vendor's chat, by a tool that chat called.
const VENDOR_HOST = {
  ...VENDOR_CLI,
  cursor: cmd => VENDOR_CLI.cursor(cmd) || /\/Cursor\.app\/Contents\/MacOS\/Cursor(\s|$)/.test(cmd),
};
const HOST_WORKING_SLACK_MS = 2 * 60 * 1000; // a lead counts as "at work" when the worker started if active this recently

/** A shell a person types into (`-zsh`, `zsh -il`), as opposed to one running a command for a tool (`zsh -lc "…"`). */
export function interactiveShell(command) {
  const tokens = String(command || '').trim().split(/\s+/);
  const exe = basename(tokens[0] || '');
  if (!/^-?(zsh|bash|sh|fish|dash|tcsh|ksh|nu|pwsh)$/.test(exe)) return false;
  return exe.startsWith('-') || !tokens.slice(1).some(t => /^-[a-z]*c[a-z]*$/i.test(t));
}

/** The first vendor host above `pid` (not passing through another agent's process): `{ vendor, pid }` or null. */
export function hostOf(pid, table, agentPids = new Map()) {
  for (const p of ancestorsOf(pid, table)) {
    if (agentPids.has(p)) return null; // another agent is in between: the pairwise launch link covers it
    const proc = table.get(p);
    if (!proc) return null;
    if (interactiveShell(proc.command)) return null; // a person typed it, in a terminal (even one inside an editor)
    for (const [vendor, is] of Object.entries(VENDOR_HOST)) if (is(proc.command)) return { vendor, pid: p };
  }
  return null;
}

const projectKey = a => a?.project || (a?.cwd ? stripSlash(a.cwd) : null);

/**
 * Who started whom, inferred (N1): an agent whose process runs under a vendor's host was started from a chat of that
 * vendor. When exactly one top-level agent of that vendor is present in the same project and was at work when the
 * process started, that chat is the delegator. Pure. `agents` are the present agents (vendor, project, parentId,
 * status, lastActivityAt, pid); `agentPids` maps known agent pids. Returns [{ from, to, hostPid, workerPid, at }].
 */
export function inferDelegations(table, agents, agentPids = new Map()) {
  const out = [];
  for (const w of agents || []) {
    if (!w || w.parentId || !Number.isInteger(w.pid) || !table.has(w.pid)) continue;
    const host = hostOf(w.pid, table, agentPids);
    if (!host) continue;
    const startedAt = table.get(w.pid).startedAt ?? null;
    const key = projectKey(w);
    const cands = (agents || []).filter(a => a && a.id !== w.id && a.vendor === host.vendor && !a.parentId && a.status !== 'gone'
      && key && projectKey(a) === key
      && (a.status === 'working' || (startedAt != null && (a.lastActivityAt || 0) >= startedAt - HOST_WORKING_SLACK_MS)));
    if (cands.length !== 1) continue;
    out.push({ from: cands[0].id, to: w.id, hostPid: host.pid, workerPid: w.pid, at: startedAt ?? null });
  }
  return out;
}

/** `ps -axo pid,ppid,lstart,command` as text. */
export function defaultPs() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid,ppid,lstart,command'], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });
}

/** The working directory of a process (`lsof -a -p <pid> -d cwd -Fn`), or null. */
export function defaultCwdOf(pid) {
  return new Promise(resolve => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const n = String(stdout).split('\n').find(l => l.startsWith('n'));
      resolve(n ? n.slice(1) : null);
    });
  });
}

/** ps text -> Map(pid -> { pid, ppid, startedAt, command }). Tolerates a header, ragged spacing and a table without lstart. */
export function parsePs(text) {
  const table = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    let rest = m[3].trim(), startedAt = null;
    const ls = LSTART_RE.exec(rest);
    if (ls) { const t = Date.parse(ls[1]); if (Number.isFinite(t)) { startedAt = t; rest = ls[2].trim(); } }
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), startedAt, command: rest });
  }
  return table;
}

const SHELL = /^-?(?:\S*\/)?(?:zsh|bash|sh|dash|fish|ksh|tcsh)(?:\s|$)/;
/** How many shells run under this process, however deep; null when the process is not in the table. */
export function shellsUnder(table, pid) {
  if (!table?.has(pid)) return null;
  const kids = new Map();
  for (const p of table.values()) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  let n = 0, guard = 0;
  const walk = id => { for (const k of kids.get(id) || []) { if (guard++ > 4096) return; if (SHELL.test(k.command)) n++; walk(k.pid); } };
  walk(pid);
  return n;
}

/** A short label for a process: the program's basename, or the script's when it is an interpreter (`node relay.mjs` -> relay.mjs). */
export function labelOf(command) {
  const tokens = String(command || '').trim().split(/\s+/);
  const exe = basename(tokens[0] || '');
  if (INTERPRETERS.test(exe)) {
    const script = tokens.slice(1).find(t => !t.startsWith('-'));
    if (script) return basename(script);
  }
  return exe || 'process';
}

/** Processes that never count as "the program that launched both": the system, shells, terminals and app bundles. */
export function isExcluded(proc) {
  if (!proc || proc.pid <= 1) return true;
  const cmd = String(proc.command || '');
  if (/\.app\/Contents\//.test(cmd) || /\/Applications\//.test(cmd)) return true;
  const exe = basename(cmd.split(/\s+/)[0] || '');
  if (EXCLUDED_NAMES.test(exe) || /helper/i.test(exe)) return true;
  if (/^-?(zsh|bash|sh|fish|login)$/.test(exe)) return true; // login shells show as "-zsh"
  return false;
}

/** The ancestor chain of `pid` (parent first), stopping at the root or after MAX_DEPTH. */
export function ancestorsOf(pid, table) {
  const out = [];
  const seen = new Set([pid]);
  let cur = table.get(pid);
  while (cur && out.length < MAX_DEPTH) {
    const p = cur.ppid;
    if (p == null || p === cur.pid || seen.has(p)) break;
    out.push(p); seen.add(p);
    cur = table.get(p);
  }
  return out;
}

/**
 * Pure part: launch links among the agent pids in a process table.
 * `agentPids`: Map(pid -> party ref). `firstSeen`: Map(link id -> at) so a link's `at` is when it was first noticed.
 * `weak`: Set of pids whose mapping is a cwd/time guess; a link touching one is `artifact`, never `structural`.
 */
export function linksFromTable(table, agentPids, { now = Date.now(), firstSeen = new Map(), excluded = isExcluded, weak = new Set() } = {}) {
  const pids = [...agentPids.keys()].filter(p => table.has(p)).sort((a, b) => a - b);
  const chains = new Map(pids.map(p => [p, ancestorsOf(p, table)]));
  const sets = new Map(pids.map(p => [p, new Set(chains.get(p))]));
  const out = [];
  const produced = new Set();
  const push = (id, from, to, ...involved) => {
    if (produced.has(id)) return;
    produced.add(id);
    if (!firstSeen.has(id)) firstSeen.set(id, now);
    const confidence = involved.some(p => weak.has(p)) ? 'artifact' : 'structural';
    const l = makeLink({ id, kind: 'launch', from, to, at: firstSeen.get(id), channel: 'process', confidence });
    if (l) out.push(l);
  };
  for (let i = 0; i < pids.length; i++) {
    for (let j = i + 1; j < pids.length; j++) {
      const a = pids[i], b = pids[j];
      if (sets.get(b).has(a)) { push(`process:launch:${a}:${b}`, agentPids.get(a), agentPids.get(b), a, b); continue; }
      if (sets.get(a).has(b)) { push(`process:launch:${b}:${a}`, agentPids.get(b), agentPids.get(a), a, b); continue; }
      const common = chains.get(a).find(p => sets.get(b).has(p));
      if (common == null || agentPids.has(common)) continue; // a third agent in between is reported by its own pairs
      const proc = table.get(common);
      if (!proc || excluded(proc)) continue;
      const stub = `name:${labelOf(proc.command)}`;
      push(`process:launch:${common}:${a}`, stub, agentPids.get(a), a);
      push(`process:launch:${common}:${b}`, stub, agentPids.get(b), b);
    }
  }
  for (const id of firstSeen.keys()) if (!produced.has(id)) firstSeen.delete(id); // pids gone: forget the pair
  return out;
}

const stripSlash = p => String(p || '').replace(/\/+$/, '') || '/';

/**
 * The weak join: agents with a cwd and a start time but no pid, against processes that look like their vendor's CLI,
 * started within `slackMs` of the agent, running in the agent's cwd (asked through `cwdOf`, cached by the caller).
 * An agent must have exactly one such process and a process exactly one such agent. Returns Map(pid -> agent id).
 */
export async function weakJoins(table, agents, cwdOf, { taken = new Set(), slackMs = CONFIG.links.pidJoinSlackMs } = {}) {
  const claims = new Map(); // pid -> [agent id]
  for (const a of agents || []) {
    if (!a || a.pid || !a.cwd || !Number.isFinite(a.startedAt) || !VENDOR_CLI[a.vendor]) continue;
    const want = stripSlash(a.cwd);
    const cands = [];
    for (const p of table.values()) {
      if (taken.has(p.pid) || p.startedAt == null || Math.abs(p.startedAt - a.startedAt) > slackMs || !VENDOR_CLI[a.vendor](p.command)) continue;
      const cwd = await cwdOf(p.pid, p.startedAt);
      if (cwd && stripSlash(cwd) === want) cands.push(p.pid);
      if (cands.length > 1) break;
    }
    if (cands.length !== 1) continue;
    const list = claims.get(cands[0]) || [];
    list.push(a.id); claims.set(cands[0], list);
  }
  const out = new Map();
  for (const [pid, ids] of claims) if (ids.length === 1) out.set(pid, ids[0]);
  return out;
}

/**
 * The reader. Options (all for tests): `ps` an async function returning ps text; `everyMs` how often it runs;
 * `registryDir` a path or function (default CONFIG.claude.sessionsDir at read time); `cwdOf(pid)` the cwd of a process
 * (default lsof). Fills `ctx.pidMap` (pid -> party ref) and `ctx.pidWeak` (Set of weakly joined pids) for the resolver
 * and the snapshot.
 */
export function createProcessReader({ ps = defaultPs, everyMs = null, registryDir = null, cwdOf = defaultCwdOf } = {}) {
  const dirOf = () => (typeof registryDir === 'function' ? registryDir() : registryDir) || CONFIG.claude.sessionsDir;
  const period = () => everyMs ?? CONFIG.links.psEveryMs;
  let table = null, lastPs = 0, psFailures = 0, lastError = null;
  const registry = new Map();  // file -> { mtimeMs, size, pid, ref }
  const firstSeen = new Map(); // link id -> at
  const cwdCache = new Map();  // `${pid}:${startedAt}` -> cwd | null (a pid is reused only after its process is gone)
  let weakMap = new Map();     // pid -> agent id, recomputed whenever the table or the set of agents changes
  let weakFor = null;          // { table, key } the weak map was computed against
  const early = new Set();     // agent pids ps was run early for (a new agent's process not in the last table yet)
  const delegated = new Map(); // worker id -> { from, at, workerPid, hostPid }: kept while both are in (a worker whose
                               // process ended, or that is resumed in a new one, keeps who gave it the work)

  async function refreshRegistry() {
    const dir = dirOf();
    let names = [];
    try { names = (await readdir(dir)).filter(n => n.endsWith('.json')); } catch { names = []; }
    const seen = new Set();
    for (const n of names) {
      const file = path.join(dir, n);
      seen.add(file);
      let st;
      try { st = await stat(file); } catch { continue; }
      const hit = registry.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) continue;
      try {
        const s = JSON.parse(await readFile(file, 'utf8'));
        const pid = Number(s?.pid);
        if (Number.isInteger(pid) && pid > 0 && typeof s.sessionId === 'string' && s.sessionId) registry.set(file, { mtimeMs: st.mtimeMs, size: st.size, pid, ref: `claude:${s.sessionId}` });
        else registry.set(file, { mtimeMs: st.mtimeMs, size: st.size, pid: null, ref: null });
      } catch { /* caught mid-write: keep the last good read, or try again next time */ }
    }
    for (const file of registry.keys()) if (!seen.has(file)) registry.delete(file);
  }

  const cachedCwd = async (pid, startedAt) => {
    const key = `${pid}:${startedAt}`;
    if (!cwdCache.has(key)) cwdCache.set(key, await cwdOf(pid));
    return cwdCache.get(key);
  };

  return {
    name: 'process',
    async read(now = Date.now(), ctx = {}) {
      ctx.psTable = () => table; // the newest table, for whoever else reads the process tree (the job book)
      const pidMap = ctx.pidMap || (ctx.pidMap = new Map());
      const pidWeak = ctx.pidWeak || (ctx.pidWeak = new Set());
      // a new agent whose process the last ps did not have yet (a job just started): ps now, once per pid, so who
      // launched it is known as it walks in rather than up to a period later
      const pids = (ctx.agents || []).map(a => a?.pid).filter(p => Number.isInteger(p) && p > 0);
      for (const p of early) if (!pids.includes(p)) early.delete(p);
      const fresh = table ? pids.filter(p => !table.has(p) && !early.has(p)) : [];
      const due = !table || now - lastPs >= period() || fresh.length > 0;
      for (const p of fresh) early.add(p);
      if (due) {
        lastPs = now;
        try { table = parsePs(await ps()); lastError = null; }
        catch (e) { psFailures++; lastError = e?.message || String(e); if (!table) return []; } // keep the last table
        await refreshRegistry();
        for (const key of cwdCache.keys()) if (!table.has(Number(key.split(':')[0]))) cwdCache.delete(key);
      }
      // explicit pids: the Claude registry, what collectors report, pid: refs in links read so far this poll
      const agentPids = new Map();
      for (const r of registry.values()) if (r.pid) agentPids.set(r.pid, r.ref);
      for (const a of ctx.agents || []) if (Number.isInteger(a?.pid) && a.pid > 0 && !agentPids.has(a.pid)) agentPids.set(a.pid, a.id);
      for (const l of ctx.links || []) {
        for (const ref of [l?.from, l?.to]) {
          const p = parseParty(ref);
          if (p?.scheme === 'pid' && !agentPids.has(Number(p.id))) agentPids.set(Number(p.id), ref);
        }
      }
      // weak pids: recomputed when the table changes (every ps) or the set of present agents does (cwds are cached)
      const explicit = new Set(agentPids.keys());
      const key = (ctx.agents || []).map(a => a?.id).sort().join('\n');
      if (weakFor?.table !== table || weakFor.key !== key) { weakMap = await weakJoins(table, ctx.agents, cachedCwd, { taken: explicit }); weakFor = { table, key }; }
      const weak = new Set();
      for (const [pid, id] of weakMap) if (!explicit.has(pid)) { agentPids.set(pid, id); weak.add(pid); }
      for (const [pid, ref] of agentPids) if (!ref.startsWith('pid:')) { pidMap.set(pid, ref); if (weak.has(pid)) pidWeak.add(pid); }
      if (!table) return [];
      const out = linksFromTable(table, agentPids, { now, firstSeen, weak });
      // inferred delegations: a new unambiguous answer replaces the remembered one; an ambiguous moment keeps it
      const present = new Set((ctx.agents || []).map(a => a?.id));
      for (const d of inferDelegations(table, ctx.agents, agentPids)) {
        const cur = delegated.get(d.to);
        if (!cur || cur.workerPid !== d.workerPid) delegated.set(d.to, { from: d.from, at: d.at ?? now, workerPid: d.workerPid, hostPid: d.hostPid });
      }
      for (const [to, d] of delegated) if (!present.has(to) || !present.has(d.from)) delegated.delete(to);
      const delegations = ctx.delegations || (ctx.delegations = new Map());
      for (const [to, d] of delegated) {
        delegations.set(to, { from: d.from, confidence: 'inferred', at: d.at });
        if (!table.has(d.workerPid)) continue; // the job's process is over: the relation stays, the launch is history
        const l = makeLink({ id: `process:host:${d.hostPid}:${d.workerPid}`, kind: 'launch', from: d.from, to, at: d.at, channel: 'process', confidence: 'inferred' });
        if (l) out.push(l);
      }
      return out;
    },
    stats() { return { processes: table ? table.size : 0, agentPids: registry.size, weakPids: weakMap.size, delegations: delegated.size, lastPs: lastPs || null, psFailures, lastError }; },
  };
}
