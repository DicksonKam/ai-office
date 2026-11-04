// `?soak` page mode: a long-run anomaly monitor for the office. Every 2 s it looks over the workers and the spots they
// hold for things that should never happen (a walker stuck for minutes, two people in one chair, a chair still
// "taken" by someone who left, NaN positions, a tag off the screen …); every 60 s it samples heap, DOM size, fps, draw
// calls and the renderer's resource counts. Samples and anomalies live in memory and in localStorage, so a reload
// within two hours of the same URL continues the run (`?soak=new` starts afresh). `__office.soak()` returns the data;
// a small badge in the bottom-left corner shows the elapsed time and the anomaly count; clicking it (or `?soak&report`)
// opens the report. Nothing here runs per frame, and every check is wrapped: the monitor must never disturb the office.

const KEY = 'ai-office-soak'; // + the run's URL key: two soak tabs on one origin must not overwrite each other
const CHECK_MS = 2000, METRIC_MS = 60000, SAVE_MS = 10000;
const MAX_SAMPLES = 1500, MAX_ANOMALIES = 500, MAX_ERRORS = 20, STORE_MAX = 1_000_000, RESUME_MS = 2 * 3600e3;
const STUCK_WALK_MS = 90e3, LOOP_WINDOW_MS = 60e3, LOOP_ARRIVALS = 8, STACK_DIST = 0.15, FADE_STUCK_MS = 30e3;
const KINDS = {
  'stuck-walker': 'in state walk for more than 90 s (never reached its target)',
  loop: 'more than 8 arrivals in one minute (a worker ping-ponging between targets)',
  'double-seat': 'two workers sitting on the same seat',
  'stacked-standers': 'two standing, faded-in workers within 0.15 m of each other on one floor',
  leaked: 'a desk / helper slot / spot still taken by a worker who is done or gone',
  nan: 'a position or heading that is not a finite number',
  'done-in-map': 'a done worker still listed in mgr.workers',
  'fade-stuck': 'a worker half-faded (0.05 < fade < 0.95) for more than 30 s',
  'tag-offscreen': 'a visible name tag entirely outside the viewport',
  'empty-bubble': 'a bubble shown with no text',
  'dom-growth': 'DOM node count grew past 1.5× the warmed-up baseline (the third minute) + 500',
  'console-error': 'console.error, an uncaught error or an unhandled rejection',
};

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const who = w => w ? (w.name || w.id || '?') : '?';
export function fmtDur(ms) {
  if (!isNum(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}
const fmtT = at => { try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return String(at); } };
const fmtMB = b => isNum(b) ? `${(b / 1048576).toFixed(1)} MB` : '–';
const fmtN = v => isNum(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : '–';
/** the run's identity: path + query without the soak value and the report flag (so `?soak=new` / `&report` continue the same run) */
export function runKey(loc) {
  try {
    const q = new URLSearchParams(loc.search || '');
    q.delete('report'); if (q.has('soak')) q.set('soak', '');
    const pairs = [...q.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => v ? `${k}=${v}` : k);
    return `${loc.pathname || '/'}?${pairs.join('&')}`;
  } catch { return String(loc?.href || ''); }
}

/** The monitor itself: pure bookkeeping over an `env` ({ now, mgr, document, window, localStorage, performance }), no timers. */
export function createSoak({ mgr, env, url = '', fresh = false, startedAt, storeMax = STORE_MAX } = {}) {
  const now = () => env.now ? env.now() : Date.now();
  const store = env.localStorage;
  const state = { v: 1, url, startedAt: startedAt ?? now(), lastAt: now(), samples: [], anomalies: [], errors: [], errorCount: 0 };
  const byKey = new Map(); // anomaly key → record (the same record object as in state.anomalies)
  let dirty = false, lastSave = 0, firstDom = null;

  // ---- persistence ----
  const load = () => {
    if (fresh || !store) return false;
    try {
      const prev = JSON.parse(store.getItem(`${KEY}:${url}`) || 'null');
      if (!prev || prev.v !== 1 || prev.url !== url || !isNum(prev.lastAt) || now() - prev.lastAt > RESUME_MS) return false;
      state.startedAt = isNum(prev.startedAt) ? prev.startedAt : state.startedAt;
      state.samples = Array.isArray(prev.samples) ? prev.samples.slice(-MAX_SAMPLES) : [];
      state.anomalies = Array.isArray(prev.anomalies) ? prev.anomalies.filter(a => a && a.key).slice(-MAX_ANOMALIES) : [];
      state.errors = Array.isArray(prev.errors) ? prev.errors.slice(0, MAX_ERRORS) : [];
      state.errorCount = isNum(prev.errorCount) ? prev.errorCount : state.errors.length;
      for (const a of state.anomalies) byKey.set(a.key, a);
      firstDom = state.samples[0]?.dom ?? null;
      return true;
    } catch { return false; }
  };
  const save = (force = false) => {
    if (!store || (!dirty && !force)) return;
    if (!force && now() - lastSave < SAVE_MS) return;
    try {
      state.lastAt = now();
      let samples = state.samples, anomalies = state.anomalies, text = JSON.stringify({ ...state, samples, anomalies });
      for (let turn = 0; text.length > storeMax && (samples.length > 50 || anomalies.length > 50); turn++) { // drop the oldest half, samples and anomalies in turns, until it fits
        if ((turn % 2 === 0 && samples.length > 50) || anomalies.length <= 50) samples = samples.slice(Math.ceil(samples.length / 2));
        else anomalies = anomalies.slice(Math.ceil(anomalies.length / 2));
        text = JSON.stringify({ ...state, samples, anomalies });
      }
      store.setItem(`${KEY}:${url}`, text); dirty = false; lastSave = now();
    } catch { /* quota or a private window: the in-memory run goes on */ }
  };
  const resumed = load();

  // ---- anomalies ----
  const report = (kind, key, w, detail) => {
    const t = now(), k = `${kind}|${String(key).slice(0, 160)}`;
    detail = String(detail ?? '').slice(0, 300);
    let a = byKey.get(k);
    if (a) { a.last = t; a.count++; if (detail) a.detail = detail; a.who = who(w); }
    else {
      a = { kind, key: k, who: who(w), detail: detail || '', first: t, last: t, count: 1 };
      byKey.set(k, a); state.anomalies.push(a);
      while (state.anomalies.length > MAX_ANOMALIES) byKey.delete(state.anomalies.shift().key);
    }
    dirty = true; return a;
  };
  const error = msg => {
    state.errorCount++;
    const text = String(msg ?? '').slice(0, 400);
    if (state.errors.length < MAX_ERRORS) state.errors.push({ at: now(), msg: text });
    report('console-error', text.slice(0, 120), null, text);
  };

  // ---- the 2 s checks (per-worker memory lives here, never in the Worker) ----
  const track = new Map(); // id → { walkSince, lastState, arrivals: [t…], fadeMidSince }
  // a finished worker is dropped (and its seats released) on the next mgr.update: a sighting between frames is not a leak,
  // so these two kinds must be seen on two consecutive checks before they count
  let pending = new Set(), seenNow = new Set();
  const confirm = (kind, key, w, detail) => { const k = `${kind}|${key}`; seenNow.add(k); if (pending.has(k)) report(kind, key, w, detail); };
  const workersOf = () => { const m = mgr?.workers; if (!m) return []; return typeof m.values === 'function' ? [...m.values()] : Object.values(m); };
  const live = ws => ws.filter(w => w && !w.done);
  const checks = {
    stuckWalker(ws, t) {
      for (const w of live(ws)) {
        const tr = track.get(w.id) || track.set(w.id, { arrivals: [] }).get(w.id);
        if (w.state === 'walk') { if (tr.lastState !== 'walk') tr.walkSince = t; else if (t - tr.walkSince > STUCK_WALK_MS) report('stuck-walker', w.id, w, `walking to ${w.next ?? '?'} for ${fmtDur(t - tr.walkSince)} at (${fmtN(w.pos?.x)}, ${fmtN(w.pos?.z)}) floor ${w.floor}`); }
        else tr.walkSince = 0;
      }
    },
    loop(ws, t) {
      for (const w of live(ws)) {
        const tr = track.get(w.id) || track.set(w.id, { arrivals: [] }).get(w.id);
        if (tr.lastState === 'walk' && w.state !== 'walk') tr.arrivals.push(t); // a walk ended: an arrival
        tr.arrivals = tr.arrivals.filter(a => t - a <= LOOP_WINDOW_MS);
        if (tr.arrivals.length > LOOP_ARRIVALS) report('loop', w.id, w, `${tr.arrivals.length} arrivals in the last minute, now ${w.state}`);
        tr.lastState = w.state;
      }
      for (const id of track.keys()) if (!ws.some(w => w.id === id)) track.delete(id);
    },
    doubleSeat(ws) {
      const seats = new Map();
      for (const w of live(ws)) if (w.sittingOn && typeof w.sittingOn === 'object') { const l = seats.get(w.sittingOn) || []; l.push(w); seats.set(w.sittingOn, l); }
      for (const [seat, l] of seats) if (l.length > 1) report('double-seat', l.map(w => w.id).sort().join('+'), l[0], `${l.map(who).join(' and ')} on one seat at (${fmtN(seat.x)}, ${fmtN(seat.z)})`);
    },
    stackedStanders(ws) {
      const st = live(ws).filter(w => w.state !== 'walk' && !w.sittingOn && w.fade > 0.95 && w.pos && isNum(w.pos.x) && isNum(w.pos.z));
      for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
        const a = st[i], b = st[j];
        if (a.floor !== b.floor) continue;
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < STACK_DIST) report('stacked-standers', [a.id, b.id].sort().join('+'), a, `${who(a)} (${a.state}) and ${who(b)} (${b.state}) at (${fmtN(a.pos.x)}, ${fmtN(a.pos.z)}) floor ${a.floor}`);
      }
    },
    leaked(ws) {
      const present = new Set(live(ws));
      const leak = (v, where) => { if (v && typeof v === 'object' && (v.done || ('id' in v && !present.has(v)))) confirm('leaked', where, v, `${where} still taken by ${who(v)}${v.done ? ' (done)' : ' (gone)'}`); };
      (mgr?.floors || []).forEach((f, k) => {
        const F = k + 1;
        (f.desks || []).forEach(d => {
          leak(d.taken, `${F}F desk ${d.id}`); leak(d.owner, `${F}F desk ${d.id} owner`); leak(d.reviewSpot?.taken, `${F}F desk ${d.id} review spot`);
          (d.slots || []).forEach((s, i) => leak(s?.taken, `${F}F desk ${d.id} slot ${i}`));
        });
        const spots = { lounge: f.lounge?.seats, bar: f.barSpots || f.bar?.spots, foos: f.foos?.spots, qa: f.qa?.spots, meeting: f.meeting?.seats, coffee: f.coffee?.spots, cooler: f.cooler?.spots };
        for (const [name, list] of Object.entries(spots)) (Array.isArray(list) ? list : []).forEach((s, i) => leak(s?.taken, `${F}F ${name} ${i}`));
        for (const name of ['coffee', 'cooler']) leak(f[name]?.spot?.taken, `${F}F ${name}`);
      });
    },
    nan(ws) {
      for (const w of ws) if (w && (!isNum(w.pos?.x) || !isNum(w.pos?.z) || (w.pos && 'y' in w.pos && !isNum(w.pos.y)) || !isNum(w.heading))) report('nan', w.id, w, `pos (${w.pos?.x}, ${w.pos?.y}, ${w.pos?.z}) heading ${w.heading} state ${w.state}`);
    },
    doneInMap(ws) {
      for (const w of ws) if (w?.done) confirm('done-in-map', w.id, w, `done but still in mgr.workers (state ${w.state})`);
    },
    fadeStuck(ws, t) {
      for (const w of live(ws)) {
        const tr = track.get(w.id) || track.set(w.id, { arrivals: [] }).get(w.id);
        if (w.fade > 0.05 && w.fade < 0.95) { if (!tr.fadeMidSince) tr.fadeMidSince = t; else if (t - tr.fadeMidSince > FADE_STUCK_MS) report('fade-stuck', w.id, w, `fade ${w.fade.toFixed(2)} for ${fmtDur(t - tr.fadeMidSince)} in state ${w.state}`); }
        else tr.fadeMidSince = 0;
      }
    },
    tagsOffscreen() {
      const doc = env.document, win = env.window; if (!doc?.querySelectorAll || !win) return;
      const W = win.innerWidth || 0, H = win.innerHeight || 0; if (!W || !H) return;
      for (const el of doc.querySelectorAll('.tag:not(.gone)')) {
        const r = el.getBoundingClientRect?.(); if (!r || !(r.width > 0) || !(r.height > 0)) continue;
        if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) report('tag-offscreen', el.querySelector?.('.nm')?.textContent || el.textContent || '?', null, `tag "${(el.textContent || '').trim().slice(0, 40)}" at (${Math.round(r.left)}, ${Math.round(r.top)}) outside ${W}×${H}`);
      }
    },
    emptyBubbles() {
      const doc = env.document; if (!doc?.querySelectorAll) return;
      let i = 0;
      for (const el of doc.querySelectorAll('.bubble.show')) {
        i++;
        if ((el.textContent || '').trim()) continue;
        if (el.classList?.contains('dots') || el.classList?.contains('glyph')) continue;
        report('empty-bubble', String(el.className || i), null, `bubble "${el.className}" shown with no text`);
      }
    },
  };
  /** the simulation stood still (a hidden tab stops animation frames): time-based trackers restart now */
  const resetClocks = () => { const t = now(); for (const tr of track.values()) { if (tr.walkSince) tr.walkSince = t; if (tr.fadeMidSince) tr.fadeMidSince = t; tr.arrivals = []; } pending = new Set(); };
  const check = () => {
    const t = now(), ws = workersOf();
    seenNow = new Set();
    for (const [name, fn] of Object.entries(checks)) { try { fn(ws, t); } catch (err) { report('console-error', `soak check ${name}`, null, `soak check ${name} threw: ${err?.message || err}`); } }
    pending = seenNow;
    try { save(); } catch { /* never */ }
    return state.anomalies.length;
  };

  // ---- the 60 s metrics ----
  const sample = () => {
    const t = now(), s = { at: t };
    try { const m = env.performance?.memory; if (m) s.heap = m.usedJSHeapSize; } catch { /* no memory info */ }
    try { s.dom = env.document?.getElementsByTagName ? env.document.getElementsByTagName('*').length : undefined; } catch { /* no DOM */ }
    try { const c = env.window?.__office?.check?.(); if (c) { s.fps = c.fps; s.drawCalls = c.drawCalls; s.triangles = c.triangles; s.floors = c.floors; if (c.ok === false) report('console-error', 'check() not ok', null, `__office.check(): ${(c.bad || []).join('; ')}`); } } catch { /* check unavailable */ }
    try { s.workers = live(workersOf()).length; } catch { /* no mgr */ }
    try { const r = env.window?.__office?.renderer?.info?.memory; if (r) { s.geometries = r.geometries; s.textures = r.textures; } } catch { /* no renderer */ }
    s.errors = state.errorCount; s.anomalies = state.anomalies.reduce((n, a) => n + a.count, 0);
    state.samples.push(s); while (state.samples.length > MAX_SAMPLES) state.samples.shift();
    // the baseline is the third sample: the first minutes build tags, panels and the drawer, which is not growth
    if (isNum(s.dom)) { if (firstDom == null) { if (state.samples.length >= 3) firstDom = s.dom; } else if (s.dom > firstDom * 1.5 + 500) report('dom-growth', 'dom', null, `${s.dom} DOM nodes, baseline ${firstDom}`); }
    dirty = true; save(true);
    return s;
  };

  // ---- the summary ----
  const summary = () => {
    const stat = f => { const v = state.samples.map(s => s[f]).filter(isNum); return v.length ? { min: Math.min(...v), max: Math.max(...v), first: v[0], last: v[v.length - 1] } : null; };
    const anomalyCounts = {};
    for (const a of state.anomalies) anomalyCounts[a.kind] = (anomalyCounts[a.kind] || 0) + a.count;
    return { heap: stat('heap'), dom: stat('dom'), fps: stat('fps'), drawCalls: stat('drawCalls'), workers: stat('workers'),
      anomalyCounts, anomalyKinds: Object.keys(anomalyCounts).length, anomalies: state.anomalies.reduce((n, a) => n + a.count, 0), errors: state.errorCount, samples: state.samples.length };
  };
  const data = () => ({ startedAt: state.startedAt, elapsed: now() - state.startedAt, resumed, samples: state.samples.slice(), anomalies: state.anomalies.slice(), errors: state.errors.slice(), errorCount: state.errorCount, summary: summary() });

  return { state, resumed, check, resetClocks, sample, summary, data, error, report, save: () => save(true), KINDS };
}

// ---- the page: badge, report, timers, error hooks ----
const CSS = `
.soak-badge { position: fixed; z-index: 29; left: var(--soak-left, 18px); bottom: calc(var(--tl-h, 0px) + 12px); display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px 4px 8px; border-radius: 999px; border: 1.5px solid #fff; background: var(--paper, rgba(255,253,250,.92)); color: var(--ink-soft, #7a7186);
  font: 700 11px/1.3 var(--font, system-ui, sans-serif); letter-spacing: .01em; font-variant-numeric: tabular-nums; cursor: pointer; user-select: none;
  box-shadow: 0 2px 0 rgba(90,70,110,.1), 0 6px 16px rgba(80,60,120,.1); transition: left .2s, background .3s, color .3s; }
.soak-badge:hover { background: #fff; color: var(--ink, #3b3346); }
.soak-badge .sd { width: 7px; height: 7px; border-radius: 50%; background: #67c88b; box-shadow: 0 0 0 2px rgba(103,200,139,.25); }
.soak-badge.warn { color: #6a4a12; background: #fff4dc; border-color: #f3d79a; }
.soak-badge.warn .sd { background: #e2b35d; box-shadow: 0 0 0 2px rgba(226,179,93,.35); animation: askpulse 1.4s ease-in-out infinite; }
.soak-badge:focus-visible { outline: 2px solid #f0b23a; outline-offset: 1px; }
.soak-report { position: fixed; z-index: 31; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(820px, calc(100vw - 36px)); max-height: min(84vh, calc(100vh - 36px));
  overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; background: var(--paper, rgba(255,253,250,.96)); color: var(--ink, #3b3346); border-radius: 18px; border: 1.5px solid #fff;
  padding: 14px 18px 16px; box-shadow: 0 2px 0 rgba(90,70,110,.12), 0 14px 40px rgba(80,60,120,.22); font: 500 12px/1.4 var(--font, system-ui, sans-serif); }
.soak-report .head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; padding-right: 28px; margin-bottom: 8px; }
.soak-report h2 { margin: 0; font-size: 14px; font-weight: 800; letter-spacing: .03em; }
.soak-report .sub { color: var(--ink-soft, #7a7186); font-weight: 600; font-size: 11px; }
.soak-report .close { position: absolute; right: 10px; top: 8px; border: 0; background: transparent; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 999px; cursor: pointer; color: var(--ink-soft, #7a7186); font-family: inherit; }
.soak-report .close:hover { color: var(--ink, #3b3346); background: rgba(236,232,240,.75); }
.soak-report h3 { margin: 12px 0 4px; font-size: 12px; font-weight: 800; letter-spacing: .03em; color: var(--ink, #3b3346); }
.soak-report h3 .n { color: var(--ink-soft, #7a7186); font-weight: 600; margin-left: 4px; }
.soak-report table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.soak-report th, .soak-report td { text-align: left; padding: 3px 8px 3px 0; border-top: 1px dashed #ece8f0; vertical-align: top; }
.soak-report th { color: var(--ink-soft, #7a7186); font-weight: 600; border-top: 0; font-size: 11px; }
.soak-report td.num, .soak-report th.num { text-align: right; padding-right: 10px; }
.soak-report td.d { color: var(--ink-soft, #7a7186); word-break: break-word; }
.soak-report .kind { display: inline-block; font-size: 9.5px; font-weight: 800; color: #6a4a12; background: #fff4dc; border: 1px solid #f3d79a; padding: 0 6px; border-radius: 999px; text-transform: uppercase; letter-spacing: .04em; }
.soak-report .kind.err { color: #7a2f22; background: #fde7e2; border-color: #f0b8ad; }
.soak-report .ok { color: #3f7d57; font-weight: 700; }
.soak-report .what { color: var(--ink-soft, #7a7186); font-size: 11px; margin: 0 0 4px; }
.soak-report .samples td, .soak-report .samples th { font-size: 11px; padding: 2px 8px 2px 0; }
.soak-report .foot { margin-top: 12px; font-size: 10.5px; color: var(--ink-soft, #7a7186); }
.soak-report .foot button { font: inherit; font-weight: 700; color: var(--ink, #3b3346); background: #fff; border: 1.5px solid #ece8f0; border-radius: 999px; padding: 2px 10px; cursor: pointer; margin-right: 6px; }
@media (max-width: 600px) { .soak-report { padding: 12px 12px 14px; } .soak-report th, .soak-report td { padding-right: 5px; } }
`;

function statRow(label, st, fmt) { return `<tr><th>${label}</th>${['first', 'last', 'min', 'max'].map(k => `<td class="num">${st ? fmt(st[k]) : '–'}</td>`).join('')}</tr>`; }
export function renderReport(d) {
  const s = d.summary, kinds = Object.entries(s.anomalyCounts).sort((a, b) => b[1] - a[1]);
  const groups = new Map();
  for (const a of d.anomalies) { const l = groups.get(a.kind) || []; l.push(a); groups.set(a.kind, l); }
  const last = d.samples.slice(-30).reverse();
  return `
  <div class="head"><h2>Soak report</h2><span class="sub">started ${esc(fmtT(d.startedAt))} · ${esc(fmtDur(d.elapsed))} elapsed${d.resumed ? ' · continued after a reload' : ''} · ${d.samples.length} samples</span></div>
  <button type="button" class="close" aria-label="close">✕</button>
  <h3>Summary</h3>
  <table><tr><th></th><th class="num">first</th><th class="num">last</th><th class="num">min</th><th class="num">max</th></tr>
    ${statRow('heap', s.heap, fmtMB)}${statRow('DOM nodes', s.dom, fmtN)}${statRow('fps', s.fps, fmtN)}${statRow('draw calls', s.drawCalls, fmtN)}${statRow('workers', s.workers, fmtN)}
  </table>
  <h3>Anomalies<span class="n">${s.anomalies} in ${kinds.length} kind${kinds.length === 1 ? '' : 's'} · ${d.errorCount} console error${d.errorCount === 1 ? '' : 's'}</span></h3>
  ${kinds.length ? `<table><tr><th>kind</th><th class="num">count</th><th>what it means</th></tr>${kinds.map(([k, n]) => `<tr><td><span class="kind${k === 'console-error' ? ' err' : ''}">${esc(k)}</span></td><td class="num">${n}</td><td class="d">${esc(KINDS[k] || '')}</td></tr>`).join('')}</table>` : '<p class="ok">none so far</p>'}
  ${[...groups.entries()].map(([k, l]) => `<h3><span class="kind${k === 'console-error' ? ' err' : ''}">${esc(k)}</span><span class="n">${l.length} distinct · ${l.reduce((n, a) => n + a.count, 0)} seen</span></h3><p class="what">${esc(KINDS[k] || '')}</p>
    <table><tr><th>who</th><th>first</th><th>last</th><th class="num">count</th><th>detail</th></tr>${l.slice().sort((a, b) => b.last - a.last).map(a => `<tr><td><b>${esc(a.who)}</b></td><td>${esc(fmtT(a.first))}</td><td>${esc(fmtT(a.last))}</td><td class="num">${a.count}</td><td class="d">${esc(a.detail)}</td></tr>`).join('')}</table>`).join('')}
  <h3>Console errors<span class="n">${d.errorCount} total, first ${d.errors.length} kept</span></h3>
  ${d.errors.length ? `<table>${d.errors.map(e => `<tr><td>${esc(fmtT(e.at))}</td><td class="d">${esc(e.msg)}</td></tr>`).join('')}</table>` : '<p class="ok">none</p>'}
  <h3>Last ${last.length} samples<span class="n">newest first, one per minute</span></h3>
  <table class="samples"><tr><th>time</th><th class="num">heap</th><th class="num">DOM</th><th class="num">fps</th><th class="num">draws</th><th class="num">tris</th><th class="num">people</th><th class="num">geom</th><th class="num">tex</th><th class="num">errors</th><th class="num">anomalies</th></tr>
    ${last.map(x => `<tr><td>${esc(fmtT(x.at))}</td><td class="num">${fmtMB(x.heap)}</td><td class="num">${fmtN(x.dom)}</td><td class="num">${fmtN(x.fps)}</td><td class="num">${fmtN(x.drawCalls)}</td><td class="num">${fmtN(x.triangles)}</td><td class="num">${fmtN(x.workers)}</td><td class="num">${fmtN(x.geometries)}</td><td class="num">${fmtN(x.textures)}</td><td class="num">${fmtN(x.errors)}</td><td class="num">${fmtN(x.anomalies)}</td></tr>`).join('')}
  </table>
  <div class="foot"><button type="button" class="refresh">refresh</button><button type="button" class="copy">copy JSON</button> <code>__office.soak()</code> returns the same data · Esc closes · <code>?soak=new</code> starts a fresh run</div>`;
}

/** Entry point from main.js: `?soak` starts the monitor, `?soak&report` also opens the report, `?soak=new` discards a resumable run. */
export function startSoak({ mgr, params } = {}) {
  const win = globalThis.window, doc = globalThis.document;
  if (!win || !doc || !mgr) return null;
  let store = null; try { store = win.localStorage; } catch { /* blocked storage */ }
  const env = { now: () => Date.now(), document: doc, window: win, localStorage: store, performance: globalThis.performance };
  const url = runKey(win.location || {});
  const fresh = (params?.get?.('soak') || '') === 'new';
  const soak = createSoak({ mgr, env, url, fresh });

  // console errors and uncaught failures, counted and kept (the first 20 messages)
  try {
    const orig = console.error.bind(console);
    console.error = (...args) => { try { soak.error(args.map(a => a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); } catch { /* never */ } return orig(...args); };
    win.addEventListener('error', e => { try { soak.error(`${e.message || 'error'}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`); } catch { /* never */ } });
    win.addEventListener('unhandledrejection', e => { try { const r = e.reason; soak.error(`unhandled rejection: ${r instanceof Error ? (r.stack || r.message) : String(r)}`); } catch { /* never */ } });
  } catch { /* console not writable */ }

  // badge and report
  let badge = null, panel = null, refreshTimer = 0;
  try {
    const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
    badge = doc.createElement('button'); badge.type = 'button'; badge.className = 'soak-badge'; badge.title = 'soak monitor: click for the report';
    badge.innerHTML = '<span class="sd"></span><span class="tx">soak</span>';
    doc.body.appendChild(badge);
    badge.addEventListener('click', () => toggleReport());
  } catch { /* no DOM: headless */ }
  const updateBadge = () => {
    if (!badge) return;
    const d = soak.data(), n = d.summary.anomalies;
    const tx = `soak ${fmtDur(d.elapsed)} · ${n} anomal${n === 1 ? 'y' : 'ies'}`;
    const el = badge.querySelector('.tx'); if (el && el.textContent !== tx) el.textContent = tx;
    badge.classList.toggle('warn', n > 0);
    // the worker card sits in the same corner: step aside while it is open
    const card = doc.getElementById('card');
    const shift = card && !card.hidden && card.offsetWidth > 0 ? `${card.offsetWidth + 28}px` : '';
    if (badge.style.getPropertyValue('--soak-left') !== shift) badge.style.setProperty('--soak-left', shift);
  };
  const closeReport = () => { if (!panel) return; panel.remove(); panel = null; clearInterval(refreshTimer); refreshTimer = 0; doc.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape' && panel) { closeReport(); e.stopPropagation(); } };
  const paint = () => { if (!panel) return; const top = panel.scrollTop; panel.innerHTML = renderReport(soak.data()); panel.scrollTop = top; };
  const openReport = () => {
    if (panel) return paint();
    panel = doc.createElement('div'); panel.className = 'soak-report'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'soak report');
    doc.body.appendChild(panel); paint();
    panel.addEventListener('click', e => {
      const t = e.target.closest?.('button'); if (!t) return;
      if (t.classList.contains('close')) closeReport();
      else if (t.classList.contains('refresh')) paint();
      else if (t.classList.contains('copy')) { try { navigator.clipboard?.writeText(JSON.stringify(soak.data(), null, 1)); t.textContent = 'copied'; setTimeout(() => { t.textContent = 'copy JSON'; }, 1200); } catch { /* clipboard unavailable */ } }
    });
    doc.addEventListener('keydown', onKey, true);
    refreshTimer = setInterval(paint, METRIC_MS);
  };
  const toggleReport = () => panel ? closeReport() : openReport();

  // timers: 2 s checks, 60 s metrics, a save when the page goes away
  // a hidden tab stops animation frames, so the office stands still while these intervals keep running: a worker
  // frozen mid-walk is not stuck. A tick with no frame since the last one resets the time-based trackers and is skipped.
  let frames = 0, lastFrames = -1;
  const rafTick = () => { frames++; try { win.requestAnimationFrame?.(rafTick); } catch { /* no raf */ } };
  try { win.requestAnimationFrame?.(rafTick); } catch { /* no raf */ }
  const tick = () => {
    try {
      const advanced = frames !== lastFrames && !doc.hidden; lastFrames = frames;
      if (advanced) soak.check(); else { soak.state.pausedTicks = (soak.state.pausedTicks || 0) + 1; soak.resetClocks(); }
      updateBadge();
    } catch { /* never into the page */ }
  };
  const metric = () => { try { soak.sample(); if (panel) paint(); } catch { /* never */ } };
  metric(); tick();
  const timers = [setInterval(tick, CHECK_MS), setInterval(metric, METRIC_MS)];
  try { win.addEventListener('pagehide', () => soak.save()); doc.addEventListener('visibilitychange', () => { if (doc.hidden) soak.save(); }); } catch { /* never */ }
  if (params?.has?.('report')) { try { openReport(); } catch { /* never */ } }

  const handle = { soak, data: soak.data, openReport, closeReport, stop() { for (const t of timers) clearInterval(t); closeReport(); badge?.remove(); } };
  try { if (win.__office) win.__office.soak = () => soak.data(); } catch { /* never */ }
  console.info(`soak: ${soak.resumed ? `continuing the run started ${fmtT(soak.state.startedAt)}` : 'new run'} (${url})`);
  return handle;
}
