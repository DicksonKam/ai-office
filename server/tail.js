import { open, readdir, stat } from 'node:fs/promises';

/** Read the last `maxBytes` of a file, trimmed to whole lines. */
export async function readTail(filePath, maxBytes = 262144) {
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, size };
  } finally {
    await fh.close();
  }
}

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial or corrupt line */ }
  }
  return out;
}

/** Collapse whitespace, strip light markdown, cut to a brief bubble-sized snippet. */
export function snippet(text, max = 72) {
  if (!text) return '';
  let s = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > max * 0.5) return cut.slice(0, stop + 1).trim();
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim() + '…';
}

export function basename(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** Project name for a working directory. Agents in git worktrees made by Claude Code (<repo>/.claude/worktrees/<x>)
 *  belong to the repository, not to the worktree folder. */
export function projectOf(cwd) {
  const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/.exec(String(cwd || ''));
  return basename(m ? m[1] : cwd);
}

/** Read the first `maxBytes` of a file (for metadata that sits at the top, past the reach of readTail). */
export async function readHead(filePath, maxBytes = 16384) {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ---------- caches that stay small over days of uptime ----------

export const FORGET_AFTER_MS = 60 * 60 * 1000; // cache entries not used for this long are dropped

/** A Map whose entries remember when they were last used; prune(now) drops the ones unused for FORGET_AFTER_MS. */
export class SeenMap extends Map {
  constructor() { super(); this.seen = new Map(); }
  touch(key, now = Date.now()) { if (super.has(key)) this.seen.set(key, now); return this; }
  set(key, value, now = Date.now()) { this.seen.set(key, now); return super.set(key, value); }
  delete(key) { this.seen.delete(key); return super.delete(key); }
  clear() { this.seen.clear(); return super.clear(); }
  prune(now = Date.now(), maxAgeMs = FORGET_AFTER_MS) {
    for (const [k, t] of this.seen) if (now - t > maxAgeMs) { this.seen.delete(k); super.delete(k); }
    return this;
  }
}

/** Run fn at most once per `everyMs` (cache housekeeping from inside a poll). */
export function every(everyMs, fn) {
  let last = 0;
  return (now = Date.now()) => { if (now - last >= everyMs) { last = now; fn(now); } };
}

const dirCache = new SeenMap();  // dir -> { mtimeMs, at, entries }
const statCache = new SeenMap(); // file -> { st, at }
const pruneFsCaches = every(60 * 1000, now => { dirCache.prune(now); statCache.prune(now); });

/** readdir, re-listed only when the directory's own mtime changed (a file was added, removed or renamed) or the listing
 *  is older than `ttlMs`. Appending to a file does not change its directory, so this never hides fresh activity. */
export async function readdirCached(dir, now = Date.now(), { withFileTypes = false, ttlMs = 60 * 1000 } = {}) {
  pruneFsCaches(now);
  const key = (withFileTypes ? 'T:' : 'N:') + dir;
  const st = await stat(dir); // throws like readdir when the folder is missing
  const hit = dirCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && now - hit.at < ttlMs) { dirCache.touch(key, now); return hit.entries; }
  const entries = await readdir(dir, { withFileTypes });
  dirCache.set(key, { mtimeMs: st.mtimeMs, at: now, entries }, now);
  return entries;
}

/** stat that skips re-checking a file already older than `staleMs` (or missing) for `recheckMs`: histories of
 *  hundreds of old transcripts cost one stat each per `recheckMs` instead of one per poll. Returns null when missing. */
export async function statCached(file, now = Date.now(), { staleMs, recheckMs = 15 * 1000 } = {}) {
  pruneFsCaches(now);
  const hit = statCache.get(file);
  if (hit && now - hit.at < recheckMs && (!hit.st || now - hit.st.mtimeMs > staleMs)) { statCache.touch(file, now); return hit.st; }
  let st = null;
  try { st = await stat(file); } catch { /* missing or unreadable */ }
  statCache.set(file, { st, at: now }, now);
  return st;
}

// ---------- quiet error log ----------

const errorLog = new Map(); // tag -> { msg, count, loggedAt, seenAt }
const REPEAT_LOG_MS = 10 * 60 * 1000;
/** Log a recurring error once, then only a count every REPEAT_LOG_MS while it keeps happening (polls run every 1.5 s
 *  and the log is not rotated). */
export function logError(tag, err, now = Date.now()) {
  const msg = String(err?.message || err);
  const e = errorLog.get(tag);
  if (!e || e.msg !== msg) {
    if (e?.count) console.error(`${tag} (previous error repeated ${e.count} more time${e.count === 1 ? '' : 's'})`);
    console.error(tag, msg);
    errorLog.set(tag, { msg, count: 0, loggedAt: now, seenAt: now });
    for (const [k, v] of errorLog) if (now - v.seenAt > FORGET_AFTER_MS) errorLog.delete(k);
    return;
  }
  e.count++; e.seenAt = now;
  if (now - e.loggedAt >= REPEAT_LOG_MS) {
    console.error(`${tag} ${msg} (repeated ${e.count} time${e.count === 1 ? '' : 's'} in the last ${Math.round((now - e.loggedAt) / 60000)} min)`);
    e.count = 0; e.loggedAt = now;
  }
}
/** The source behind `tag` works again: say so once if it had been failing. */
export function logRecovered(tag) {
  const e = errorLog.get(tag);
  if (!e) return;
  errorLog.delete(tag);
  console.error(`${tag} ok again${e.count ? ` (after ${e.count} more failure${e.count === 1 ? '' : 's'})` : ''}`);
}
