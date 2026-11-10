// While you were away: each browser remembers when it last had the office in view. Back after a real absence in which
// something happened, it offers the stretch you missed as a film. It never starts by itself, and says nothing if nothing
// happened. Remembered in this browser only (localStorage); a private window simply never offers.
import { buildFilm } from './film.js';

const KEY = 'ai-office-seen';
const SAVE_MS = 10000;          // how often a page in view says "seen"
const MIN_AWAY_MS = 10 * 60000; // shorter than this is not being away
const MAX_BACK_MS = 3 * 86400000; // a film of at most the last three days
const read = () => { try { const v = Number(localStorage.getItem(KEY)); return v > 0 ? v : 0; } catch { return 0; } };
const save = t => { try { localStorage.setItem(KEY, String(t)); } catch { /* private window: no offer, no harm */ } };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function awayWords(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r && h < 6 ? `${h} h ${r} min` : `${h} h`;
  const d = Math.floor(h / 24); return d === 1 && h % 24 ? `1 day ${h % 24} h` : plural(d, 'day');
}
/** what happened, in a few words: who came, who needed you, what was reported */
export function happenedWords(film) {
  const n = k => film.marks.filter(m => m.kind === k).length;
  const parts = [];
  const came = n('in'), asked = n('ask'), reports = n('report');
  if (came) parts.push(`${plural(came, 'arrival')}`);
  if (asked) parts.push(`${asked} waited on you`);
  if (reports) parts.push(plural(reports, 'report'));
  return parts;
}

export function startAway({ player, source, enabled = true }) {
  if (!enabled) return null;
  const el = document.createElement('section');
  el.id = 'away'; el.hidden = true; el.setAttribute('aria-label', 'While you were away');
  el.innerHTML = `<div class="aw-text"><b id="awTitle"></b><span id="awWhat"></span></div>
    <button type="button" class="aw-watch" id="awWatch"></button>
    <button type="button" class="aw-close" id="awClose" aria-label="No thanks" title="No thanks">×</button>`;
  document.body.appendChild(el);
  const $ = id => el.querySelector(`#${id}`);
  let offer = null, checking = false;
  const hide = () => { el.hidden = true; offer = null; };

  async function check(lastSeen) {
    const now = Date.now();
    if (checking || !lastSeen || now - lastSeen < MIN_AWAY_MS || player.active) return;
    checking = true;
    try {
      const from = Math.max(lastSeen, now - MAX_BACK_MS), query = `from=${from}&to=${now}`;
      const rec = await source(query);
      if (!rec?.entries?.length) return;
      const film = await buildFilm(rec.entries, { from: rec.from, to: rec.to, dayStarts: rec.dayStarts || [], gaps: rec.gaps || [] });
      if (!film.changes.length) return; // nothing worth a look happened
      if (player.active) return;
      offer = { query, rec, film };
      const what = happenedWords(film), secs = Math.max(5, Math.round(film.autoLength() / 5) * 5);
      $('awTitle').textContent = `While you were away · ${awayWords(now - lastSeen)}`;
      $('awWhat').textContent = what.length ? what.join(' · ') : 'people came and went';
      $('awWatch').textContent = `▶ Watch · ${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`}`;
      el.hidden = false;
    } catch (err) { console.warn('away:', err); } finally { checking = false; }
  }
  $('awWatch').addEventListener('click', () => {
    if (!offer) return;
    const { query, rec, film } = offer; hide();
    player.open(query, { away: true, prebuilt: { rec, film } });
  });
  $('awClose').addEventListener('click', hide);

  // seen: now, every few seconds while in view, and on the way out; the time before this visit is read first
  const before = read();
  const mark = () => { if (document.visibilityState === 'visible') save(Date.now()); };
  let hiddenSince = document.visibilityState === 'visible' ? 0 : Date.now();
  mark();
  setInterval(mark, SAVE_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { save(Date.now()); hiddenSince = Date.now(); return; }
    const last = Math.max(read(), hiddenSince); // another tab may have had it in view meanwhile
    hiddenSince = 0; mark();
    check(last);
  });
  window.addEventListener('pagehide', () => mark());
  check(before);
  return { check, hide, get offer() { return offer; } };
}
