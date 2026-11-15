// What each agent has really made, as running totals for its session: files written, test runs (passed / failed, and
// whether one is running now), commits. Counts only: no file names, commands or messages leave this module.
//
// A test run is a command that runs a test suite (npm test, jest, pytest, go test, cargo test, …) with a real result
// from the agent's own record: an exit code or the tool's own error flag. A run whose result is unknown (interrupted,
// killed, not recorded) is not counted either way. A commit is a `git commit` that succeeded. A file counts once
// however often it is written.
//
// Transcripts are read incrementally (`readNewLines`): each poll reads only what was appended since the last one, so a
// long session is read once; a server that restarts reads a live session from its start, once.
import { open, stat } from 'node:fs/promises';
import { SeenMap, every } from './tail.js';

const SEP = String.raw`(?:^|[\s;&|(])`;
// a test runner, as a command word (not "test" anywhere: `ls test/`, `grep test` are not test runs)
export const TEST_RE = new RegExp(SEP + String.raw`(?:` + [
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?\b`,
  String.raw`(?:npx|pnpm\s+exec|yarn|bunx)\s+(?:jest|vitest|mocha|ava|playwright\s+test|cypress\s+run)\b`,
  String.raw`(?:jest|vitest|mocha|pytest|py\.test|phpunit|rspec|ctest|nextest)\b`,
  String.raw`python3?\s+-m\s+(?:pytest|unittest)\b`,
  String.raw`go\s+test\b`, String.raw`cargo\s+(?:test|nextest)\b`, String.raw`deno\s+test\b`, String.raw`bun\s+test\b`,
  String.raw`node\s+(?:--[\w-]+\s+)*--test\b`, String.raw`swift\s+test\b`, String.raw`dotnet\s+test\b`,
  String.raw`make\s+(?:test|check)\b`, String.raw`(?:\./)?gradlew?\s+(?:\S+\s+)*(?:\S*:)?test\b`, String.raw`mvn\s+(?:\S+\s+)*test\b`,
  String.raw`xcodebuild\s+(?:\S+\s+)*test\b`,
].join('|') + ')', 'i');
// git commit, also with options before the subcommand (git -C dir commit, git -c k=v commit); not a dry run
export const COMMIT_RE = new RegExp(SEP + String.raw`git(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b(?![^;&|]*--dry-run)`);

/** A test runner's own verdict from its output: true (all passed), false (something failed) or null (no summary seen).
 *  Read before the exit code, which a pipe (`npm test | tail`) hides. */
export function testVerdict(text) {
  const t = String(text || '').slice(-20000);
  if (!t) return null;
  const n = re => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const fails = [n(/^[#ℹ]\s*fail(?:ed)?\s+(\d+)/mi), n(/\bTests?:\s+(\d+)\s+failed/i), n(/Test Files\s+(\d+)\s+failed/i), n(/\b(\d+)\s+failed\b/i), n(/\b(\d+)\s+failing\b/i)];
  if (fails.some(x => x > 0) || /^FAIL\b/m.test(t) || /test result: FAILED/.test(t) || /^not ok\b/m.test(t)) return false;
  if (fails.some(x => x === 0) || /\b\d+\s+(?:passed|passing)\b/i.test(t) || /^ok\s+\S+/m.test(t) || /test result: ok/.test(t) || /\ball \d+ passed\b/i.test(t) || /^[#ℹ]\s*pass\s+\d+/mi.test(t)) return true;
  return null;
}
/** a pipe after the command (not ||), without pipefail: its exit code is the last command's, not the runner's */
export const pipedOf = cmd => /[^|]\|[^|]/.test(String(cmd || '')) && !/pipefail/.test(String(cmd || ''));

/** 'test' | 'commit' | null for a shell command line */
export function classify(cmd) {
  const c = String(cmd || '');
  if (!c) return null;
  if (COMMIT_RE.test(c)) return 'commit';
  if (TEST_RE.test(c)) return 'test';
  return null;
}

/** Running totals for one session. `pending` holds calls started but not answered yet (a test running now). */
export class Ledger {
  constructor() { this.files = new Set(); this.pass = 0; this.fail = 0; this.last = null; this.lastAt = 0; this.commits = 0; this.commitAt = 0; this.pending = new Map(); this.counted = new Set(); }
  write(path) { if (typeof path === 'string' && path) this.files.add(path); }
  /** a call began: remember what it is until its result comes */
  start(id, what) { if (id && what) this.pending.set(id, what); }
  /** its result: ok true / false, or null when it is not known (then nothing is counted); `text`, its output */
  finish(id, ok, at = 0, text = '') {
    const what = this.pending.get(id); if (!what) return;
    this.pending.delete(id);
    this.done(what, ok, at, id, text);
  }
  /** a call seen only once it has ended (start and result in one record). A test run's verdict is the runner's own
   *  summary when its output shows one; else its exit code, unless a pipe hid it */
  done(what, ok, at = 0, id = null, text = '') {
    if (id != null) { if (this.counted.has(id)) return; this.counted.add(id); }
    if (what.kind === 'test' && ok != null) { const v = testVerdict(text); ok = v ?? (what.piped ? null : ok); }
    if (ok == null) return;
    if (what.kind === 'write') { if (ok) this.write(what.path); return; }
    if (what.kind === 'test') { if (ok) this.pass++; else this.fail++; this.last = ok ? 'pass' : 'fail'; this.lastAt = at; return; }
    if (what.kind === 'commit' && ok) { this.commits++; this.commitAt = at; }
  }
  summary() {
    const running = [...this.pending.values()].some(w => w.kind === 'test');
    return { files: this.files.size, tests: { pass: this.pass, fail: this.fail, last: this.last, lastAt: this.lastAt || null, running }, commits: this.commits, commitAt: this.commitAt || null };
  }
}
export const EMPTY = Object.freeze({ files: 0, tests: Object.freeze({ pass: 0, fail: 0, last: null, lastAt: null, running: false }), commits: 0, commitAt: null });
export const hasOutput = o => !!o && (o.files > 0 || o.commits > 0 || o.tests.pass + o.tests.fail > 0 || o.tests.running);

// ---------- incremental JSONL ----------

const READ_MAX = 8 * 1024 * 1024; // per poll: a huge backlog is read over a few polls, not in one
const states = new SeenMap(); // file -> { ino, offset, rest, ledger, ctx }
const prune = every(60 * 1000, now => states.prune(now));

/** Feed the lines appended to `file` since the last call to `onLine(obj, ledger, ctx)`; returns the ledger's summary,
 *  or null until the file has been read to its end once (a long session read over several polls would otherwise show
 *  its totals climbing, as if the work were happening now). A file that shrank or was replaced is read again. */
export async function ledgerOf(file, onLine, now = Date.now(), ctx = {}) {
  prune(now);
  let st; try { st = await stat(file); } catch { const old = states.get(file); return old?.ready ? old.ledger.summary() : null; }
  let s = states.get(file);
  if (!s || s.ino !== st.ino || st.size < s.offset) { s = { ino: st.ino, offset: 0, rest: '', ledger: new Ledger(), ctx: { ...ctx } }; states.set(file, s, now); }
  else states.touch(file, now);
  if (st.size > s.offset) {
    const len = Math.min(st.size - s.offset, READ_MAX), buf = Buffer.alloc(len);
    let fh; try { fh = await open(file, 'r'); await fh.read(buf, 0, len, s.offset); } catch { return s.ready ? s.ledger.summary() : null; } finally { await fh?.close(); }
    s.offset += len;
    const text = s.rest + buf.toString('utf8');
    const lines = text.split('\n');
    s.rest = lines.pop(); // a line still being written
    if (s.rest.length > 4 * 1024 * 1024) s.rest = ''; // a runaway line: drop it rather than hold it
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      try { onLine(obj, s.ledger, s.ctx); } catch { /* one odd line never stops the count */ }
    }
  }
  if (s.offset >= st.size) s.ready = true;
  return s.ready ? s.ledger.summary() : null;
}
/** forget everything (tests) */
export function resetLedgers() { states.clear(); }

// ---------- each vendor's records ----------

const textOf = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(textOf).join(' ') : v && typeof v === 'object' ? (typeof v.text === 'string' ? v.text : typeof v.output === 'string' ? v.output : JSON.stringify(v)) : '';
const tsOf = v => (typeof v === 'number' ? v : Date.parse(v) || 0);

const CLAUDE_WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Claude Code transcript line (also a subagent's). `ctx.sessionId`: a continued chat's file starts with copies of the
 *  old chat's lines, stamped with the old id; those were counted there, not here. */
export function claudeLine(l, led, ctx = {}) {
  if (ctx.sessionId && l.sessionId && l.sessionId !== ctx.sessionId) return;
  const c = l.message?.content;
  if (!Array.isArray(c)) return;
  const at = tsOf(l.timestamp);
  if (l.type === 'assistant') {
    for (const b of c) {
      if (b?.type !== 'tool_use') continue;
      const i = b.input || {};
      if (CLAUDE_WRITE.has(b.name)) led.start(b.id, { kind: 'write', path: b.name === 'NotebookEdit' ? i.notebook_path : i.file_path });
      else if (b.name === 'Bash' && !i.run_in_background) { const k = classify(i.command); if (k) led.start(b.id, { kind: k, piped: pipedOf(i.command) }); } // a background run's result is not in its reply
    }
  } else if (l.type === 'user') {
    for (const b of c) {
      if (b?.type !== 'tool_result') continue;
      const text = textOf(b.content), interrupted = /interrupted by user|\[Request interrupted/i.test(text.slice(0, 400));
      led.finish(b.tool_use_id, interrupted ? null : !b.is_error, at, text);
    }
  }
}

/** an exit code in a tool's output text ("Exit code: 1", "exited with code 6", "Exit Code: 0", JSON metadata), or null */
export function exitCodeOf(text) {
  const t = String(text || '');
  const m = /\bexit(?:ed with)? code[:\s]+(-?\d+)/i.exec(t) || /"exit_code"\s*:\s*(-?\d+)/.exec(t);
  return m ? Number(m[1]) : null;
}
const okOf = code => (code == null || code < 0 ? null : code === 0); // negative: killed or aborted, not a result

const CODEX_SHELL = new Set(['shell', 'shell_command', 'exec_command', 'container.exec', 'local_shell']);
/** Codex rollout line. Current rollouts end each command as an item with its exit code and each edit as a FileChange;
 *  older ones (no such items) are read from the shell / apply_patch calls and their outputs. */
export function codexLine(l, led, ctx = {}) {
  const p = l.payload || {}, at = tsOf(l.timestamp);
  if (l.type === 'event_msg' && p.type === 'item_completed' && p.item) {
    const it = p.item;
    if (it.type === 'CommandExecution') {
      ctx.items = true;
      const cmd = Array.isArray(it.command) ? it.command.join(' ') : it.command, k = classify(cmd);
      if (k) led.done({ kind: k, piped: pipedOf(cmd) }, okOf(typeof it.exit_code === 'number' ? it.exit_code : null), at, it.id || null, it.aggregated_output || it.stdout || '');
    } else if (it.type === 'FileChange') {
      ctx.items = true;
      if (it.status === 'completed' && it.changes && typeof it.changes === 'object') for (const f of Object.keys(it.changes)) led.write(f);
    }
    return;
  }
  if (l.type !== 'response_item' || ctx.items) return;
  if (p.type === 'function_call') {
    const n = String(p.name || '').toLowerCase();
    let a = {}; try { a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || {}; } catch { /* odd args */ }
    if (CODEX_SHELL.has(n)) { const cmd = Array.isArray(a.command) ? a.command.join(' ') : a.cmd || a.command, k = classify(cmd); if (k) led.start(p.call_id, { kind: k, piped: pipedOf(cmd) }); }
    else if (n === 'apply_patch') led.start(p.call_id, { kind: 'patch', paths: [...String(a.patch || a.input || '').matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)].map(m => m[1].trim()) });
  } else if (p.type === 'custom_tool_call' && String(p.name || '').toLowerCase() === 'apply_patch') {
    led.start(p.call_id, { kind: 'patch', paths: [...String(p.input || '').matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)].map(m => m[1].trim()) });
  } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const what = led.pending.get(p.call_id); if (!what) return;
    const text = textOf(p.output);
    if (what.kind === 'patch') { led.pending.delete(p.call_id); if (/^\s*(?:\{"output":"\s*)?Success/.test(text)) for (const f of what.paths) led.write(f); return; }
    led.finish(p.call_id, okOf(exitCodeOf(text)), at, text);
  }
}

const GEMINI_WRITE = new Set(['write_file', 'replace', 'edit', 'smart_edit']);
const GEMINI_SHELL = new Set(['run_shell_command', 'shell']);
const GEMINI_OPEN = new Set(['validating', 'scheduled', 'executing', 'awaiting_approval']);
/** Gemini CLI session line (a message, written again whole as its tool calls move on; the last copy wins, so a call
 *  is counted once, when it first shows an ending) */
export function geminiLine(l, led) {
  const calls = l?.type === 'gemini' && Array.isArray(l.toolCalls) ? l.toolCalls : l?.type === 'message' && Array.isArray(l.message?.toolCalls) ? l.message.toolCalls : null;
  if (!calls) return;
  for (const c of calls) {
    if (!c?.id) continue;
    const n = String(c.name || '').toLowerCase(), st = String(c.status || '').toLowerCase(), a = c.args || {}, at = tsOf(c.timestamp);
    const what = GEMINI_WRITE.has(n) ? { kind: 'write', path: a.file_path || a.absolute_path || a.path } : GEMINI_SHELL.has(n) ? (k => k && { kind: k, piped: pipedOf(a.command) })(classify(a.command)) : null;
    if (!what) continue;
    if (GEMINI_OPEN.has(st)) { if (!led.counted.has(c.id)) led.start(c.id, what); continue; }
    const out = textOf(c.result), code = exitCodeOf(out), ok = st === 'success' ? (what.kind === 'write' ? true : code == null ? true : code === 0) : st === 'error' ? false : null;
    led.pending.delete(c.id);
    led.done(what, ok, at, c.id, out);
  }
}

const AGY_WRITE = /^(write_to_file|write_file|create_file|replace_file_content|multi_replace_file_content|edit_file|replace)$/;
/** Antigravity: the tool steps of one conversation (every one, oldest first), as `{ idx, status, tool: { name, args },
 *  texts }` (texts: the strings in the step, where its "Exited with code N" is) */
export function antigravityLedger(steps) {
  const led = new Ledger();
  for (const s of steps) {
    const n = String(s.tool?.name || '').toLowerCase(), a = s.tool?.args || {};
    if (AGY_WRITE.test(n)) { if (s.status === 3) led.write(a.TargetFile || a.Path || a.AbsolutePath || a.FilePath || a.file_path || a.path); continue; }
    if (!/^(run_command|shell|run_shell_command)$/.test(n)) continue;
    const cmd = a.CommandLine || a.command, k = classify(cmd); if (!k) continue;
    if ([1, 2, 8, 11].includes(s.status)) { led.start(`s${s.idx}`, { kind: k }); continue; }
    if (s.status !== 3) continue; // an error or cancel of the step itself is not the test's result
    const code = (s.texts || []).map(exitCodeOf).find(x => x != null);
    led.done({ kind: k, piped: pipedOf(cmd) }, okOf(code ?? null), 0, `s${s.idx}`, (s.texts || []).join('\n'));
  }
  return led.summary();
}
