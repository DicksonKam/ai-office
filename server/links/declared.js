// Declared links: any tool writes one JSON line per link into a *.jsonl file under CONFIG.links.dir (the link contract
// v1 in LINKS.md). Read incrementally by byte offset (offset + inode + size remembered per file; a truncated or
// replaced file is read again from the start), validated line by line (malformed lines are skipped and counted), with
// bounded memory: the newest `maxPerFile` links per file, none older than `maxAgeMs`.
//
//   {"v":1,"id":"mytool:run-42:brief","at":"2026-10-26T06:12:16Z","kind":"brief",
//    "from":"codex:<thread>","to":"claude:<session>","text":"Audit the native auth route","channel":"mytool"}
import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { makeLink, LINK_KINDS, parseParty } from './link.js';

const MAX_LINE = 64 * 1024; // a line longer than this is junk, not a link

/** Epoch ms from the contract's `at` (ISO 8601 or epoch ms), or null. */
export function parseAt(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v === 'string' && v.trim()) {
    if (/^\d{10,16}$/.test(v.trim())) return Number(v.trim());
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** One line of the contract -> Link, or null when malformed (`file` names the file for the derived id). */
export function parseDeclaredLine(line, file = 'links.jsonl', textMax = CONFIG.links.textMax) {
  if (typeof line !== 'string' || line.length > MAX_LINE) return null;
  const s = line.trim();
  if (!s || s[0] !== '{') return null;
  let o;
  try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.v != null && o.v !== 1) return null;
  if (!LINK_KINDS.has(o.kind)) return null; // the contract's seven kinds, plus `launch` for tools that know who started whom
  if (!parseParty(o.from) || !parseParty(o.to) || o.from === o.to) return null;
  const at = parseAt(o.at);
  if (at == null) return null;
  if (o.text != null && typeof o.text !== 'string') return null;
  if (o.id != null && (typeof o.id !== 'string' || !o.id.trim())) return null;
  const id = o.id ? o.id.trim() : `declared:${path.basename(file)}:${createHash('sha1').update(s).digest('hex').slice(0, 16)}`;
  const channel = typeof o.channel === 'string' && o.channel.trim() ? o.channel.trim() : path.basename(file).replace(/\.jsonl$/, '');
  return makeLink({ id, kind: o.kind, from: o.from, to: o.to, at, text: o.text, channel, confidence: 'declared' }, textMax);
}

/**
 * The reader. `dir` may be a path or a function returning one (default: CONFIG.links.dir at read time, so tests and
 * the env can point it elsewhere). `read(now)` returns every retained link (newest `maxPerFile` per file, within
 * `maxAgeMs`); the resolver dedupes by id, so returning them again each poll is harmless and keeps a brief's team
 * adoption alive for as long as both parties are in.
 */
export function createDeclaredReader({ dir = null, maxAgeMs = null, maxPerFile = null, textMax = null } = {}) {
  const dirOf = () => (typeof dir === 'function' ? dir() : dir) || CONFIG.links.dir;
  const limits = () => ({
    maxAgeMs: maxAgeMs ?? CONFIG.links.maxAgeMs,
    maxPerFile: maxPerFile ?? CONFIG.links.maxPerFile,
    textMax: textMax ?? CONFIG.links.textMax,
  });
  const files = new Map(); // path -> { offset, ino, size, rest, links: Link[], ids: Set, malformed }
  let malformed = 0, lastRead = null, fileCount = 0, readCount = 0;

  async function readFile(file, st, now, lim) {
    let f = files.get(file);
    if (f && (f.ino !== st.ino || st.size < f.offset)) f = null; // rotated or truncated: start over
    if (!f) { f = { offset: 0, ino: st.ino, size: 0, rest: '', links: [], ids: new Set(), malformed: 0 }; files.set(file, f); }
    if (st.size > f.offset) {
      const fh = await open(file, 'r');
      try {
        const buf = Buffer.alloc(st.size - f.offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, f.offset);
        f.offset += bytesRead;
        const lines = (f.rest + buf.toString('utf8', 0, bytesRead)).split('\n');
        f.rest = lines.pop();
        if (f.rest.length > MAX_LINE) f.rest = ''; // never a link: do not let a runaway line grow forever
        for (const line of lines) {
          if (!line.trim()) continue;
          const link = parseDeclaredLine(line, file, lim.textMax);
          if (!link) { f.malformed++; malformed++; continue; }
          if (now - link.at > lim.maxAgeMs) continue; // old news
          if (f.ids.has(link.id)) continue;           // the same id written twice
          f.ids.add(link.id);
          f.links.push(link);
        }
      } finally { await fh.close(); }
    }
    f.size = st.size;
    // bounded memory: drop what is too old, then the oldest beyond the cap
    if (f.links.length) {
      f.links = f.links.filter(l => now - l.at <= lim.maxAgeMs);
      if (f.links.length > lim.maxPerFile) f.links.sort((a, b) => a.at - b.at).splice(0, f.links.length - lim.maxPerFile);
      f.ids = new Set(f.links.map(l => l.id));
    }
    return f.links;
  }

  return {
    name: 'declared',
    async read(now = Date.now()) {
      const lim = limits();
      const root = dirOf();
      let names = [];
      try { names = (await readdir(root)).filter(n => n.endsWith('.jsonl') && !n.startsWith('.')); }
      catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; } // no folder yet: no links, not an error
      const seen = new Set();
      const out = [];
      for (const n of names) {
        const file = path.join(root, n);
        let st;
        try { st = await stat(file); } catch { continue; } // vanished between listing and stat
        if (!st.isFile()) continue;
        seen.add(file);
        try { out.push(...await readFile(file, st, now, lim)); }
        catch { const f = files.get(file); if (f) out.push(...f.links); } // locked mid-write: serve what we had
      }
      for (const file of files.keys()) if (!seen.has(file)) files.delete(file); // removed files are forgotten
      fileCount = seen.size; lastRead = now; readCount = out.length;
      return out;
    },
    stats() { return { files: fileCount, malformed, lastRead, read: readCount }; },
    /** For tests: the per-file offsets. */
    _files() { return files; },
  };
}
