// Office sounds (opt-in): a quiet ambient layer, synthesized with WebAudio (no files), tied to REAL activity only.
//   arrival      someone walks in through the door (outdoors -> indoors; at once when there is no street) -> door chime:
//                two soft sines, a descending major third ("ding-dong")                       at most one per 4 s
//   working      people at work on the floor you are looking at (seated, not asking) -> a bed of soft filtered-noise
//                key ticks: one virtual typist per person (bursts and pauses, own stereo spot), 0 = silence, max 8
//   needs you    agent.asking starts (one per waiting episode; the same question again within 30 s is the same ask)
//                -> a gentle two-note bell, softer than the Alerts chime in app/notify.js            at most one per 5 s
//                (skipped while the Alerts chime is on, live: that one already rings for the same ask)
//   finished     worker.isReady() turns on (once until they really work or ask again) -> a soft marimba-like ding
//                                                                                                    at most one per 4 s
//   phone        a worker takes a call: work handed to it by another agent's tool (worker.ringAt, set by a launch
//                link) -> two short, soft desk-phone trills                                          at most one per 6 s
//   report       a new 'report' event in a snapshot (mgr.sync is wrapped, as timeline.js does) -> a paper rustle
//                                                                                                    at most one per 8 s
// Cues never pile up: they are spaced ≥ 0.5 s apart and dropped rather than queued for more than 2.5 s (?demo: limits
// ×1.5, so a crowd demo stays calm). Everyone already in when sound starts (or within the first seconds after the page
// loaded, when the first snapshot walks the whole office in from the street) is a baseline, never a cue.
// Off by default. The "Sound" section is injected into the Alerts popover (#bellPop); no popover, nothing at all. On/off
// and volume are remembered per browser. The AudioContext is created only from a user gesture (the checkbox, or the first
// click / key after a reload with sound saved on): never autoplay. A hidden tab fades out and suspends; showing it again
// fades back in softly. Master gain -> gentle DynamicsCompressor -> speakers. While off: no timers, no audio nodes.
// The Alerts chime (app/notify.js, #chimeToggle) is separate and untouched.

const KEY = { on: 'ai-office-sound', vol: 'ai-office-sound-vol' };
const POLL_MS = 400;
const LIMIT_MS = { arrive: 4000, ask: 5000, ready: 4000, rustle: 8000, ring: 6000 };
const GAP_S = 0.5, MAX_DELAY_S = 2.5, LOOKAHEAD_S = 0.6;
const MAX_TYPISTS = 8;
const SAME_ASK_MS = 30000;
const GRACE_MS = 8000, PAGE_YOUNG_MS = 20000; // the first snapshot after a page load walks everyone in from the street
const EVENT_FRESH_MS = 20000, EVENT_FORGET_MS = 60 * 60 * 1000;

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Start the office sounds. Called once by main.js after the scene is up.
 * @param {object} o
 * @param {object} o.mgr   the OfficeManager (workers Map, activeFloor, sync)
 * @param {boolean} o.demo ?demo: stricter rate limits
 * Test seams (all optional): win, doc, store, AudioCtx, clock (ms)
 */
export function startSound({ mgr, demo = false, win = globalThis.window, doc = globalThis.document, store, AudioCtx, clock } = {}) {
  if (!mgr || mgr.__sound) return mgr?.__sound;
  const pop = doc?.getElementById?.('bellPop');
  if (!pop) return undefined; // no Alerts popover: no control, so no sound at all
  const now = clock || (() => performance.now());
  const AC = AudioCtx || win?.AudioContext || win?.webkitAudioContext || null;
  const ls = store || {
    get(k) { try { return win.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { win.localStorage.setItem(k, v); } catch { /* private window or blocked storage: this visit only */ } },
  };
  const slow = demo ? 1.5 : 1;

  let enabled = ls.get(KEY.on) === '1';
  let volume = Math.max(0, Math.min(100, Number(ls.get(KEY.vol) ?? 50)));
  if (!Number.isFinite(volume)) volume = 50;

  // ---- the control: a "Sound" section in the Alerts popover ---------------------------------------------------
  const sec = doc.createElement('div');
  sec.className = 'sec'; sec.id = 'soundSec';
  sec.innerHTML = '<h3>Sound</h3>'
    + '<p class="note" id="soundNote"></p>'
    + '<label class="chk" id="soundChk"><input type="checkbox" id="soundToggle"><span>Office sounds</span></label>'
    + '<label id="soundVolRow" style="display:flex;align-items:center;gap:8px;padding:3px 0;font-weight:700">'
    + '<span>Volume</span><input type="range" id="soundVol" min="0" max="100" step="1" aria-label="office sounds volume"'
    + ' style="flex:1;min-width:0;margin:0;accent-color:#e2b35d"></label>'
    + '<button type="button" class="mini" id="soundTest">Test sounds</button>';
  pop.appendChild(sec);
  const q = s => sec.querySelector(s);
  const box = q('#soundToggle'), vol = q('#soundVol'), volRow = q('#soundVolRow'), test = q('#soundTest'), note = q('#soundNote');
  box.checked = enabled; vol.value = String(volume);

  function render() {
    const unlocked = !!ctx && ctx.state !== 'closed';
    note.textContent = !AC ? 'This browser cannot play generated sound.'
      : !enabled ? 'Off. Quiet sounds for what really happens: a door chime, soft typing, a bell when someone needs you, a ding when someone finishes.'
      : !unlocked ? 'On. Starts with your first click or key press on this page.'
      : 'On. Muted while this tab is hidden.';
    box.disabled = !AC;
    vol.disabled = !enabled; test.disabled = !enabled || !AC;
    volRow.style.opacity = enabled ? '' : '.5';
    q('#soundChk').classList.toggle('dis', !AC);
  }

  // ---- audio graph (built once, on the first user gesture after sound is on) ---------------------------------
  let ctx = null, master = null, cueBus = null, keysBus = null, noise = null, suspendT = null;
  const level = () => 1.2 * (volume / 100) ** 2; // 50 % -> 0.3: quiet; cue peaks are ~0.1 before this
  function ensureAudio() {
    if (ctx) { if (ctx.state === 'suspended' && !doc.hidden) ctx.resume?.().catch?.(() => {}); return ctx; }
    if (!AC) return null;
    try { ctx = new AC(); } catch { ctx = null; return null; }
    master = ctx.createGain(); master.gain.value = 0.0001;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.3;
    master.connect(comp); comp.connect(ctx.destination);
    // cues get a hint of room: a short, dark feedback echo
    cueBus = ctx.createGain(); cueBus.gain.value = 1; cueBus.connect(master);
    const dly = ctx.createDelay(1); dly.delayTime.value = 0.11;
    const fb = ctx.createGain(); fb.gain.value = 0.22;
    const dark = ctx.createBiquadFilter(); dark.type = 'lowpass'; dark.frequency.value = 2400;
    const wet = ctx.createGain(); wet.gain.value = 0.18;
    cueBus.connect(dly); dly.connect(dark); dark.connect(fb); fb.connect(dly); dark.connect(wet); wet.connect(master);
    // keys: their own bus, softened at the top end
    keysBus = ctx.createGain(); keysBus.gain.value = 0.7;
    const soft = ctx.createBiquadFilter(); soft.type = 'lowpass'; soft.frequency.value = 6000;
    keysBus.connect(soft); soft.connect(master);
    // one second of white noise, shared by every tick and rustle
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    if (ctx.state === 'suspended') ctx.resume?.().catch?.(() => {});
    return ctx;
  }
  const running = () => !!ctx && ctx.state === 'running';
  const audible = () => enabled && running() && !doc.hidden;
  function fadeTo(v, tc) {
    if (!master) return;
    const t = ctx.currentTime, g = master.gain;
    g.cancelScheduledValues?.(t); g.setValueAtTime(Math.max(0.0001, g.value), t); g.setTargetAtTime(Math.max(0.0001, v), t, tc);
  }

  // ---- voices -------------------------------------------------------------------------------------------------
  function tone(at, f, peak, decay, { attack = 0.008, dest = cueBus, type = 'sine' } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    o.connect(g); g.connect(dest);
    o.start(at); o.stop(at + attack + decay + 0.05);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }
  function noiseHit(at, { freq, q = 1, peak, decay, attack = 0.0015, pan = 0, dest = keysBus, sweepTo = null }) {
    const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise;
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(freq, at); bp.Q.value = q;
    if (sweepTo) bp.frequency.exponentialRampToValueAtTime(sweepTo, at + attack + decay);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    s.connect(bp); bp.connect(g);
    let p = null;
    if (pan && ctx.createStereoPanner) { p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(dest); } else g.connect(dest);
    const len = attack + decay + 0.02;
    s.start(at, Math.random() * (1 - len), len);
    s.onended = () => { s.disconnect(); bp.disconnect(); g.disconnect(); p?.disconnect(); };
  }
  const VOICE = {
    // door: a soft "ding-dong", F5 down to C#5 (a major third), each with a faint octave and a slow beat
    arrive(at) {
      for (const [f, dt, peak, decay] of [[698.46, 0, 0.13, 1.3], [554.37, 0.34, 0.115, 1.8]]) {
        tone(at + dt, f, peak, decay, { attack: 0.012 });
        tone(at + dt, f * 1.004, peak * 0.3, decay, { attack: 0.012 });
        tone(at + dt, f * 2, peak * 0.1, decay * 0.4, { attack: 0.012 });
      }
      return 2.1;
    },
    // needs you: B4 up to E5 with bell partials (inharmonic, quickly gone): asks, never alarms
    ask(at) {
      for (const [f, dt, peak] of [[493.88, 0, 0.085], [659.25, 0.24, 0.075]]) {
        tone(at + dt, f, peak, 1.6, { attack: 0.006 });
        tone(at + dt, f * 2.76, peak * 0.16, 0.55, { attack: 0.004 });
        tone(at + dt, f * 5.4, peak * 0.05, 0.22, { attack: 0.003 });
      }
      return 1.9;
    },
    // finished: one marimba-like ding, G5 with a quickly decaying 3.9x overtone
    ready(at) {
      tone(at, 783.99, 0.12, 0.8, { attack: 0.003 });
      tone(at, 783.99 * 3.93, 0.045, 0.07, { attack: 0.002 });
      tone(at, 391.995, 0.02, 0.5, { attack: 0.004 });
      return 0.9;
    },
    // phone: a desk phone heard across the room, two short trills (a fast warble between two soft tones)
    ring(at) {
      for (const start of [0, 0.42]) for (let i = 0; i < 6; i++) {
        const t = at + start + i * 0.045;
        tone(t, i % 2 ? 1046.5 : 880, 0.035, 0.05, { attack: 0.004, type: 'triangle' });
      }
      return 0.8;
    },
    // report: a short paper rustle, three band-passed noise flutters
    rustle(at) {
      let t = at;
      for (let i = 0; i < 3; i++) {
        noiseHit(t, { freq: rand(1700, 2400), sweepTo: rand(2800, 3600), q: 0.8, peak: rand(0.03, 0.05), decay: rand(0.06, 0.11), attack: 0.01, pan: rand(-0.15, 0.15), dest: cueBus });
        t += rand(0.06, 0.1);
      }
      return t - at + 0.1;
    },
  };
  function keyTick(at, pan) {
    if (Math.random() < 0.08) noiseHit(at, { freq: rand(700, 1100), q: 1.2, peak: rand(0.035, 0.05), decay: rand(0.04, 0.06), pan }); // space bar
    else noiseHit(at, { freq: rand(1800, 4200), q: rand(1, 2.5), peak: rand(0.018, 0.04), decay: rand(0.018, 0.04), pan });
  }

  // ---- cues: rate-limited, spaced, never a backlog ------------------------------------------------------------
  const lastAt = {}; let nextFree = 0;
  const stats = { played: { arrive: 0, ask: 0, ready: 0, rustle: 0, ring: 0 }, limited: 0, dropped: 0, deferred: 0, ticks: 0, log: [] };
  // the Alerts chime (app/notify.js) already rings for a new ask when alerts and its chime are on: never ring twice
  const chimeBox = doc.getElementById('chimeToggle');
  const alertChimes = () => !demo && !!chimeBox?.checked && !chimeBox.disabled;
  function cue(kind) {
    if (!audible()) return false;
    if (kind === 'ask' && alertChimes()) { stats.deferred++; return false; }
    const t = now();
    if (t - (lastAt[kind] ?? -Infinity) < LIMIT_MS[kind] * slow) { stats.limited++; return false; }
    const ct = ctx.currentTime, at = Math.max(ct + 0.03, nextFree);
    if (at - ct > MAX_DELAY_S) { stats.dropped++; return false; }
    lastAt[kind] = t; nextFree = at + GAP_S;
    try { VOICE[kind](at); } catch (err) { console.warn('sound:', err); return false; }
    stats.played[kind]++; stats.log.push(kind); if (stats.log.length > 40) stats.log.shift();
    return true;
  }

  // ---- keyboard bed: one virtual typist per person at work on the active floor ---------------------------------
  const typists = [];
  function setTypists(n) {
    n = Math.min(MAX_TYPISTS, n);
    while (typists.length > n) typists.pop();
    const ct = ctx ? ctx.currentTime : 0;
    while (typists.length < n) { // a newcomer starts after a short pause, somewhere in the room
      const s = ct + rand(0.2, 2);
      typists.push({ typing: false, until: s, next: s, pan: rand(-0.55, 0.55) });
    }
  }
  function scheduleKeys() {
    if (!typists.length || !audible()) return;
    const ct = ctx.currentTime, end = ct + LOOKAHEAD_S;
    keysBus.gain.setTargetAtTime(0.7 / (1 + 0.07 * typists.length), ct, 0.5); // more people: denser, not much louder
    for (const p of typists) {
      if (p.next < ct - 0.1) { p.next = ct + rand(0, 0.3); if (p.until < p.next) p.until = p.next; } // after a gap (hidden tab)
      while (p.next < end) {
        if (p.next >= p.until) {
          p.typing = !p.typing;
          p.until = p.next + (p.typing ? rand(1.2, 4.5) : rand(1.5, 7.0));
          if (!p.typing) { p.next = p.until; continue; }
        }
        if (p.typing) { keyTick(p.next, p.pan); stats.ticks++; }
        p.next += Math.random() < 0.1 ? rand(0.25, 0.45) : rand(0.075, 0.2);
      }
    }
  }

  // ---- watching the office ---------------------------------------------------------------------------------------
  const seen = new Map(); // id -> { inside, asking, askText, askEndAt, rang, base }
  let timer = null; // the poll, while sound is on and audio has started
  let graceUntil = 0, baselineNext = true;
  function poll() {
    const t = now(), perf = t;
    const quiet = baselineNext || !audible(); // a baseline pass (start, hidden tab) records state and plays nothing
    if (baselineNext && mgr.workers.size === 0 && t < PAGE_YOUNG_MS) graceUntil = t + GRACE_MS;
    let working = 0;
    for (const [id, w] of mgr.workers) {
      const a = w?.agent; if (!a) continue;
      const gone = !!(w.done || w.leaving);
      const inside = !w.outdoors;
      const asking = !!a.asking && !a.askTo; // an ask to the agent that gave the work rings nothing
      const ready = !gone && !!w.isReady?.(perf);
      let r = seen.get(id);
      if (!r) {
        const base = quiet || t < graceUntil;
        r = { inside, asking, askText: asking ? String(a.asking) : null, askEndAt: 0, rang: ready, base, ringAt: base ? w.ringAt : null };
        seen.set(id, r);
        if (!base && !gone) {
          if (inside) cue('arrive'); // no street: they appear at the door
          if (asking) cue('ask');
        }
      } else {
        if (!r.inside && inside && !gone) { if (!quiet && !r.base) cue('arrive'); }
        if (inside) r.base = false; // a later walk-in (back from outside) is a real arrival
        r.inside = inside;
        if (asking && !r.asking && !gone) {
          const text = String(a.asking);
          const same = text === r.askText && t - r.askEndAt < SAME_ASK_MS;
          if (!quiet && !same) cue('ask');
          r.askText = text;
        }
        if (!asking && r.asking) r.askEndAt = t;
        r.asking = asking;
        if (ready && !r.rang) { r.rang = true; if (!quiet) cue('ready'); }
        if (w.ringAt && w.ringAt !== r.ringAt && !gone) { r.ringAt = w.ringAt; if (!quiet && !r.base) cue('ring'); }
        else if (!ready && r.rang && (a.status === 'working' || asking)) r.rang = false; // really back at work: the next finish counts
      }
      if (!gone && !asking && a.status === 'working' && !w.outdoors && w.state !== 'walk' && w.state !== 'spawn'
        && (w.visFloor ?? w.floor) === mgr.activeFloor) working++;
    }
    for (const id of seen.keys()) if (!mgr.workers.has(id)) seen.delete(id);
    baselineNext = false;
    setTypists(audible() ? working : 0);
    scheduleKeys();
    return working;
  }

  // reports arrive as events in a snapshot: watch mgr.sync the way timeline.js does
  const eventsSeen = new Map(); // event id -> when it was first seen
  let prunedAt = Date.now();
  const sync = mgr.sync;
  mgr.sync = function (agents, events) {
    const r = sync.apply(this, arguments);
    try {
      const wall = Date.now();
      for (const ev of events || []) {
        if (!ev || !ev.id || ev.kind !== 'report' || eventsSeen.has(ev.id)) continue;
        eventsSeen.set(ev.id, wall);
        const at = typeof ev.at === 'number' ? ev.at : Date.parse(ev.at) || wall;
        if (wall - at < EVENT_FRESH_MS && timer) cue('rustle'); // replayed or old: no sound
      }
      if (wall - prunedAt > 5 * 60000) { prunedAt = wall; for (const [id, at] of eventsSeen) if (wall - at > EVENT_FORGET_MS) eventsSeen.delete(id); }
    } catch (err) { console.warn('sound:', err); }
    return r;
  };

  // ---- on / off, unlock, hidden tab ------------------------------------------------------------------------------
  function begin() { // audio is running: start watching (the first pass is a silent baseline)
    if (timer || !enabled || !running()) return;
    baselineNext = true; seen.clear(); nextFree = 0;
    if (!doc.hidden) fadeTo(level(), 0.4);
    timer = setInterval(() => { try { poll(); } catch (err) { console.warn('sound:', err); } }, POLL_MS);
    poll();
    render();
  }
  function halt() {
    if (timer) { clearInterval(timer); timer = null; }
    typists.length = 0; seen.clear();
    if (ctx) { fadeTo(0, 0.08); clearTimeout(suspendT); suspendT = setTimeout(() => { if (!enabled || doc.hidden) ctx.suspend?.().catch?.(() => {}); }, 500); }
  }
  function start(gesture, preview) { // gesture: we are inside a click / key handler, so an AudioContext may start
    if (!gesture && !ctx) { render(); return; }
    const c = ensureAudio(); if (!c) { render(); return; }
    const go = () => { begin(); if (preview && audible()) { fadeTo(level(), 0.05); try { VOICE.arrive(ctx.currentTime + 0.05); } catch { /* ignore */ } } render(); };
    if (c.state === 'running') go(); else Promise.resolve(c.resume?.()).then(go, () => render());
  }
  function setEnabled(on, gesture) {
    enabled = on; ls.set(KEY.on, on ? '1' : '0');
    if (on) start(gesture, gesture); else halt();
    render();
  }
  box.addEventListener('change', () => setEnabled(box.checked, true));
  vol.addEventListener('input', () => {
    volume = Math.max(0, Math.min(100, Number(vol.value) || 0)); ls.set(KEY.vol, String(volume));
    if (audible()) fadeTo(level(), 0.05);
  });
  test.addEventListener('click', () => { if (enabled) { start(true, false); Promise.resolve(ctx?.resume?.()).then(playTest, () => {}); } });
  function playTest() { // each sound once, in order; bypasses the rate limits
    if (!audible()) return;
    fadeTo(level(), 0.05);
    const t0 = ctx.currentTime + 0.08;
    VOICE.arrive(t0);
    for (let k = 0, t = t0 + 2.0; t < t0 + 3.8; k++) { keyTick(t, Math.sin(k * 1.7) * 0.4); t += Math.random() < 0.1 ? rand(0.25, 0.4) : rand(0.08, 0.18); }
    VOICE.ask(t0 + 4.3);
    VOICE.ready(t0 + 6.5);
    VOICE.rustle(t0 + 7.8);
    nextFree = Math.max(nextFree, t0 + 8.4);
  }
  // after a reload with sound saved on, audio may only start from a user gesture
  const unlock = () => {
    win?.removeEventListener?.('pointerdown', unlock, true); win?.removeEventListener?.('keydown', unlock, true);
    if (enabled) start(true, false);
  };
  if (enabled) { win?.addEventListener?.('pointerdown', unlock, true); win?.addEventListener?.('keydown', unlock, true); }
  doc.addEventListener?.('visibilitychange', () => {
    if (!enabled || !ctx) return;
    if (doc.hidden) { // fade out, then suspend; watching continues (silently) so nothing stale plays on return
      fadeTo(0, 0.08); typists.length = 0;
      clearTimeout(suspendT); suspendT = setTimeout(() => { if (doc.hidden) ctx.suspend?.().catch?.(() => {}); }, 500);
    } else {
      clearTimeout(suspendT);
      Promise.resolve(ctx.resume?.()).then(() => { if (!doc.hidden && enabled) { if (!timer) begin(); fadeTo(level(), 0.7); } }, () => {});
    }
  });
  render();

  const handle = {
    poll, stats, typists,
    get enabled() { return enabled; }, get ctx() { return ctx; },
    setEnabled: on => setEnabled(!!on, true), test: playTest,
    stop() { halt(); mgr.sync = sync; sec.remove(); win?.removeEventListener?.('pointerdown', unlock, true); win?.removeEventListener?.('keydown', unlock, true); delete mgr.__sound; },
  };
  mgr.__sound = handle;
  return handle;
}
