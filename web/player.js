// The player: a film of the office, with a bar you can drag. It owns the film's moment and tells the office what to show.
// The office stays the office: you can turn it, change floor and click people while a film plays or stands still.
import { stage } from './stage.js';
import { buildFilm } from './film.js';

const FIXED = [1, 4, 16, 60];
const CUT_MS = 70; // while dragging, the office follows at most this often
const SNAP_PX = 7; // a click this near a mark goes to the mark
const LEAD_IN_MS = 4000; // a jump to a mark lands a moment before it, so you see it happen
const HOLD_AT_END_MS = 1800; // "while you were away" rests on its last moment before going back to live
const pad = n => String(n).padStart(2, '0');
const clockOf = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dateOf = t => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const MARK_WORDS = { ask: 'waiting on you', in: 'walked in', report: 'a report' };
const MARK_COLOR = { ask: '#d99a2b', in: '#6f86ad', report: '#5f9460' };
const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.6v10.8c0 .5.5.8 1 .5l8.4-5.4c.4-.3.4-.8 0-1.1L5.5 2c-.5-.2-1 .1-1 .6z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.4" y="2.4" width="3.4" height="11.2" rx="1"/><rect x="9.2" y="2.4" width="3.4" height="11.2" rx="1"/></svg>',
};

/**
 * @param {object} o
 * @param {object} o.mgr                  the office
 * @param {(query:string)=>Promise<any>} o.source  the records for a span or day
 * @param {()=>any} o.config              the office's settings
 * @param {()=>void} o.onEnter            a film is starting: put the live office aside
 * @param {(agents:any[],t:number,plan:any,jumped:boolean)=>void} o.onShow  this is the moment now on stage
 * @param {()=>void} o.onCleared          everyone has just been taken off the stage
 * @param {()=>void} o.onRestaged         ... and put back
 * @param {()=>void} o.onLeave            back to live
 */
export function createPlayer({ mgr, note = null, source, config, onEnter, onShow, onCleared, onRestaged, onLeave }) {
  let film = null, active = false, playing = false, speed = 'auto', mode = 'day', meta = null, shown = -1, drag = null, lastCut = 0, wantCut = null, holdUntil = 0, token = 0;
  const el = document.createElement('section');
  el.id = 'player'; el.hidden = true; el.setAttribute('aria-label', 'Replay');
  el.innerHTML = `
    <div class="pl-top">
      <div class="pl-when">
        <button type="button" class="pl-day" id="plPrev" aria-label="the day before" title="the day before">‹</button>
        <div class="pl-stamp"><span class="pl-rec">Replay</span><b id="plDate"></b><span class="pl-sep">·</span><span id="plClock"></span></div>
        <button type="button" class="pl-day" id="plNext" aria-label="the day after" title="the day after">›</button>
      </div>
      <p class="pl-note" id="plNote">Who was in, when and doing what is real. The walks and breaks between are acted out again.</p>
      <div class="pl-out">
        <span class="pl-waiting" id="plWaiting" hidden></span>
        <button type="button" class="pl-back" id="plBack">Back to live</button>
      </div>
    </div>
    <div class="pl-bar">
      <button type="button" class="pl-play" id="plPlay" aria-label="Play"></button>
      <div class="pl-track" id="plTrack" role="slider" tabindex="0" aria-label="Position in the replay" aria-valuemin="0" aria-valuemax="100">
        <canvas id="plCanvas"></canvas>
        <div class="pl-done" id="plDone"></div>
        <div class="pl-thumb" id="plThumb"></div>
        <div class="pl-tip" id="plTip" hidden></div>
      </div>
      <div class="pl-speeds" role="group" aria-label="Speed">
        <button type="button" data-s="auto" title="races the quiet stretches and slows down when something happens">Auto</button>
        ${FIXED.map(s => `<button type="button" data-s="${s}">${s}×</button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(el);
  const $ = id => el.querySelector(`#${id}`);
  const NOTE = note || 'Who was in, when and doing what is real. The walks and breaks between are acted out again.';
  $('plNote').textContent = NOTE;
  const track = $('plTrack'), canvas = $('plCanvas'), thumb = $('plThumb'), done = $('plDone'), tip = $('plTip');

  const setSpeed = s => {
    speed = s;
    for (const b of el.querySelectorAll('.pl-speeds button')) b.classList.toggle('on', b.dataset.s === String(s));
  };
  const setPlaying = on => {
    playing = on; holdUntil = 0;
    const b = $('plPlay'); b.innerHTML = on ? ICON.pause : ICON.play; b.setAttribute('aria-label', on ? 'Pause' : 'Play'); b.title = on ? 'Pause (space)' : 'Play (space)';
  };
  const fraction = t => (film && film.length > 0 ? Math.min(1, Math.max(0, (t - film.from) / film.length)) : 0);
  function label() {
    const t = stage.film; if (t == null || !film) return;
    const f = fraction(t) * 100;
    thumb.style.left = `${f}%`; done.style.width = `${f}%`;
    const clock = clockOf(t), date = dateOf(t);
    if ($('plClock').textContent !== clock) $('plClock').textContent = clock;
    if ($('plDate').textContent !== date) $('plDate').textContent = date;
    track.setAttribute('aria-valuenow', String(Math.round(f)));
    track.setAttribute('aria-valuetext', `${date}, ${clock}`);
  }
  function drawTrack() {
    if (!film) return;
    const w = track.clientWidth, h = track.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    // how busy each stretch was
    const n = film.heat.length, top = Math.max(2, ...film.heat), base = h - 3, room = h - 15;
    c.fillStyle = '#b6a6d8';
    for (let x = 0; x < w; x++) {
      const v = film.heat[Math.min(n - 1, Math.floor(x / w * n))];
      if (v > 0.01) { const bar = Math.max(2, Math.pow(v / top, 0.7) * room); c.fillRect(x, base - bar, 1, bar); }
    }
    // the office was not running
    c.save(); c.strokeStyle = 'rgba(90,70,110,.28)'; c.lineWidth = 1;
    for (const g of film.gaps) {
      const a = fraction(g.from) * w, b = fraction(g.to) * w;
      c.save(); c.beginPath(); c.rect(a, 0, b - a, h); c.clip();
      for (let x = a - h; x < b; x += 6) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + h, 0); c.stroke(); }
      c.restore();
    }
    c.restore();
    // what you might want to find
    for (const kind of ['in', 'report', 'ask']) {
      c.fillStyle = MARK_COLOR[kind];
      for (const m of film.marks) {
        if (m.kind !== kind) continue;
        const x = fraction(m.t) * w;
        if (kind === 'ask') { c.beginPath(); c.arc(x, 6, 3.6, 0, Math.PI * 2); c.fill(); } else c.fillRect(Math.round(x) - 0.5, 3, 1.5, 6);
      }
    }
  }
  const timeAtX = clientX => { const r = track.getBoundingClientRect(); return film.from + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * film.length; };
  const markNear = clientX => {
    const r = track.getBoundingClientRect();
    let best = null, bestD = SNAP_PX;
    for (const m of film.marks) { const d = Math.abs(r.left + fraction(m.t) * r.width - clientX); if (d < bestD || (d === bestD && m.kind === 'ask')) { best = m; bestD = d; } }
    return best;
  };

  // ---- on stage ------------------------------------------------------------------------------------------------------
  function cut(t) {
    t = Math.min(film.to, Math.max(film.from, t));
    stage.film = t; lastCut = performance.now();
    const i = film.indexAt(t);
    if (i !== shown) {
      onCleared?.(); mgr.clearStage();
      const f = film.frame(i), plan = film.planOf(f);
      stage.film = t;
      mgr.apply(f.agents, [], t, plan, true);
      for (let k = 0; k < 3; k++) mgr.update(0.02, stage.perf()); // sit down, stand up, land where the plan says
      shown = i;
      onRestaged?.();
      onShow?.(f.agents, t, plan, true);
    }
    label();
  }
  /** the frames between where we were and now, in one go */
  function roll(t) {
    const i = film.indexAt(t);
    if (i === shown) return;
    const events = [];
    for (let k = shown + 1; k <= i; k++) events.push(...film.frame(k).events);
    const f = film.frame(i), plan = film.planOf(f);
    mgr.apply(f.agents, events, t, plan, false);
    shown = i;
    onShow?.(f.agents, t, plan, false);
  }
  /** One step of the page's clock. Returns how fast the film is running now. */
  function advance(dt, hidden = false) {
    if (!active) return 1;
    const ms = dt * 1000, nowReal = performance.now();
    if (drag) {
      stage.skew -= ms; // the world stands still while you drag
      if (wantCut != null && nowReal - lastCut >= CUT_MS) { cut(wantCut); wantCut = null; }
      return 0;
    }
    if (holdUntil && nowReal >= holdUntil) { leave(); return 0; }
    if (!playing || hidden || !film) { stage.skew -= ms; return 0; }
    const t0 = stage.film;
    const rate = speed === 'auto' ? film.rateAt(t0) : speed;
    let t = t0 + Math.min(ms, 250) * rate;
    stage.skew += ms * (rate - 1);
    if (t >= film.to) {
      t = film.to; setPlaying(false);
      if (mode === 'away') holdUntil = nowReal + HOLD_AT_END_MS;
    }
    stage.film = t;
    roll(t); label();
    return rate;
  }

  // ---- open and close ------------------------------------------------------------------------------------------------
  function setBusy(text) {
    el.classList.toggle('busy', !!text);
    $('plNote').textContent = text || NOTE;
  }
  function enter() {
    if (active) return;
    active = true; document.body.classList.add('filming'); onEnter?.();
  }
  function leave() {
    if (!active && el.hidden) return;
    token++;
    el.hidden = true; document.body.classList.remove('filming'); setPlaying(false);
    if (active) {
      active = false; film = null; shown = -1; drag = null; wantCut = null;
      onCleared?.(); mgr.clearStage(); stage.film = null; onLeave?.();
    }
  }
  /** @param {string} query what to ask for: `day=2026-11-07`, or `from=..&to=..`
   *  @param {object} [o] at: the moment to start at; away: this is the stretch you missed, and it ends on the live office */
  async function open(query, { at = null, away = false, autoplay = true, prebuilt = null } = {}) {
    const mine = ++token;
    el.hidden = false; setBusy('Putting the film together…'); setPlaying(false); drawTrackSoon();
    let rec = prebuilt?.rec;
    if (!rec) try { rec = await source(query); } catch (err) { if (mine === token) failed('The records could not be read.', err); return false; }
    if (mine !== token) return false;
    if (!rec?.entries?.length) { failed(rec?.day ? 'Nothing was recorded that day.' : 'Nothing was recorded in that time.'); applyDays(rec); return false; }
    let made = prebuilt?.film;
    if (!made) try { made = await buildFilm(rec.entries, { from: rec.from, to: rec.to, dayStarts: rec.dayStarts || [], gaps: rec.gaps || [], config: config?.() }); }
    catch (err) { if (mine === token) failed('That film could not be put together.', err); return false; }
    if (mine !== token) return false;
    meta = rec; mode = away ? 'away' : 'day';
    enter();
    film = made; shown = -1; holdUntil = 0;
    applyDays(rec);
    setBusy(''); drawTrack();
    setSpeed(speed);
    cut(at ?? film.from);
    setPlaying(!!autoplay);
    return true;
  }
  function failed(text, err) {
    if (err) console.warn('film:', err);
    setBusy(text);
    if (!active) setTimeout(() => { if (!active) el.hidden = true; }, 2600);
  }
  function applyDays(rec) {
    const prev = $('plPrev'), next = $('plNext');
    prev.disabled = !rec?.prev; next.disabled = !rec?.next;
    prev.dataset.day = rec?.prev || ''; next.dataset.day = rec?.next || '';
  }
  function drawTrackSoon() { requestAnimationFrame(drawTrack); }

  // ---- the controls --------------------------------------------------------------------------------------------------
  const togglePlay = () => {
    if (!film) return;
    if (!playing && stage.film >= film.to) cut(film.from);
    setPlaying(!playing);
  };
  $('plPlay').addEventListener('click', togglePlay);
  $('plBack').addEventListener('click', leave);
  for (const id of ['plPrev', 'plNext']) $(id).addEventListener('click', e => { const d = e.currentTarget.dataset.day; if (d) open(`day=${d}`); });
  el.querySelector('.pl-speeds').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; setSpeed(b.dataset.s === 'auto' ? 'auto' : Number(b.dataset.s)); if (film && stage.film < film.to) setPlaying(true); });
  track.addEventListener('pointerdown', e => {
    if (!film) return;
    track.setPointerCapture(e.pointerId);
    drag = { was: playing, x: e.clientX, moved: false };
    const m = markNear(e.clientX);
    const t = m ? m.t - LEAD_IN_MS : timeAtX(e.clientX);
    cut(t); e.preventDefault(); track.focus({ preventScroll: true });
  });
  track.addEventListener('pointermove', e => {
    if (!film) return;
    const t = timeAtX(e.clientX);
    const m = drag ? null : markNear(e.clientX);
    const x = Math.min(track.clientWidth - 44, Math.max(44, e.clientX - track.getBoundingClientRect().left));
    tip.hidden = false; tip.style.left = `${x}px`;
    tip.textContent = m ? `${clockOf(m.t)} · ${MARK_WORDS[m.kind]}` : clockOf(t);
    if (drag) {
      if (Math.abs(e.clientX - drag.x) > 2) drag.moved = true;
      if (drag.moved) { wantCut = t; stage.film = Math.min(film.to, Math.max(film.from, t)); label(); }
    }
  });
  const endDrag = () => { if (!drag) return; if (wantCut != null) { cut(wantCut); wantCut = null; } drag = null; };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('pointerleave', () => { tip.hidden = true; });
  document.addEventListener('keydown', e => {
    if (!active || !film || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable) return;
    const big = Math.max(60000, film.length / 40);
    if (e.key === ' ') { if (e.target?.tagName === 'BUTTON') e.target.blur(); togglePlay(); }
    else if (e.key === 'ArrowLeft') cut(stage.film - (e.shiftKey ? big * 4 : big));
    else if (e.key === 'ArrowRight') cut(stage.film + (e.shiftKey ? big * 4 : big));
    else if (e.key === 'Home') cut(film.from);
    else if (e.key === 'End') cut(film.to);
    else if (e.key === 'Escape' && document.getElementById('card')?.hidden !== false) leave();
    else return;
    e.preventDefault();
  });
  new ResizeObserver(drawTrack).observe(track);
  new ResizeObserver(() => { if (el.offsetHeight) document.documentElement.style.setProperty('--player-h', `${el.offsetHeight + 14}px`); }).observe(el);
  setSpeed('auto'); setPlaying(false);

  return {
    get active() { return active; },
    get film() { return film; },
    get playing() { return playing; },
    get meta() { return meta; },
    open, leave, advance, seek: t => { if (film) cut(t); },
    pause: () => setPlaying(false), setSpeed,
    /** the live office's own waiting count, shown while the film runs */
    setWaiting(n) {
      const w = $('plWaiting'); w.hidden = !n;
      const text = n ? `${n} waiting on you now` : '';
      if (w.textContent !== text) w.textContent = text;
    },
  };
}
