// App shell: dock badge + "(N)" title for the agents waiting on you, and opt-in alerts (a browser notification,
// optionally a soft generated chime) when an agent STARTS waiting on you. One alert per agent per waiting episode, also
// across server reconnects and a snapshot that briefly misses someone. While the server is unreachable the badge and the
// "(N)" are cleared (the number would be stale), and come back with the next snapshot.
// Off by default; the bell pill in the HUD turns it on (asking for notification permission the first time).

const KEY = { on: 'ai-office-alerts', chime: 'ai-office-chime' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window or blocked storage: keep it for this visit */ } },
};
const $ = id => document.getElementById(id);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/**
 * @param {object} o
 * @param {boolean} o.demo      ?demo: no alerts and no dock badge unless `force`
 * @param {boolean} o.force     ?notify: allow alerts in demo, and alert even while the window has focus (for checking)
 * @param {(agent) => string} o.nameOf  display name for an agent from the snapshot
 * @param {(id: string) => void} o.jumpTo  switch to the agent's floor and focus them
 * @param {() => void} o.onMenuOpen  the alerts menu is opening (main.js closes the Key popover)
 */
export function createAlerts({ demo = false, force = false, nameOf = a => a.nickname || 'An agent', jumpTo = () => {}, onMenuOpen = () => {} } = {}) {
  const supported = typeof window.Notification === 'function';
  const allowed = !demo || force;
  const perm = () => (supported ? Notification.permission : 'denied');
  let wanted = store.get(KEY.on) === '1';
  let chimeOn = store.get(KEY.chime) === '1';
  const active = () => wanted && supported && perm() === 'granted';

  // ---- bell pill + menu ------------------------------------------------------------
  const pill = $('bell'), btn = $('bellToggle'), more = $('bellMore'), pop = $('bellPop'), note = $('bellNote'), chimeBox = $('chimeToggle'), test = $('bellTest');
  function render() {
    if (!pill) return;
    const on = active(), p = perm();
    pill.classList.toggle('on', on);
    pill.classList.toggle('blocked', !supported || p === 'denied');
    btn.setAttribute('aria-pressed', String(on));
    btn.title = !supported ? 'this browser cannot show notifications'
      : p === 'denied' ? 'notifications are blocked for this site in the browser settings'
      : on ? 'alerts are on: a notification when an agent starts waiting on you (click to turn off)'
      : 'alerts are off: click to get a notification when an agent starts waiting on you';
    note.textContent = !supported ? 'This browser cannot show notifications.'
      : p === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then turn alerts on here.'
      : on ? `On. One notification when an agent starts waiting on you, ${force ? 'even while this window is focused (?notify)' : 'while this window is in the background'}.${allowed ? '' : ' Paused in demo mode.'}`
      : 'Off. Turn on to get a notification when an agent starts waiting on you.';
    chimeBox.checked = chimeOn;
    chimeBox.disabled = !on;
    chimeBox.closest('.chk')?.classList.toggle('dis', !on);
    test.disabled = !on;
  }
  function setMenu(open) {
    if (!pop) return;
    if (open && pop.hidden) { try { onMenuOpen(); } catch { /* ignore */ } }
    pop.hidden = !open; more.setAttribute('aria-expanded', String(open));
  }
  async function toggle() {
    if (!supported) { setMenu(true); return render(); }
    if (active()) { wanted = false; store.set(KEY.on, '0'); return render(); }
    let p = perm();
    if (p === 'default') {
      try { p = await Notification.requestPermission(); } catch { p = perm(); }
    }
    if (p !== 'granted') { render(); setMenu(true); return; }
    wanted = true; store.set(KEY.on, '1'); render();
    show('Alerts are on', 'You will get one notification when an agent starts waiting on you.', 'ai-office-hello');
  }
  btn?.addEventListener('click', e => { e.stopPropagation(); toggle(); });
  more?.addEventListener('click', e => { e.stopPropagation(); render(); setMenu(pop.hidden); });
  chimeBox?.addEventListener('change', () => {
    chimeOn = chimeBox.checked; store.set(KEY.chime, chimeOn ? '1' : '0');
    if (chimeOn) chime(); // the click is the user gesture that lets audio start; play one so they hear what it sounds like
  });
  test?.addEventListener('click', () => {
    show('Test alert', 'This is how it looks when an agent is waiting on you.', 'ai-office-test');
    if (chimeOn) chime();
  });
  document.addEventListener('click', e => { if (pop && !pop.hidden && !e.target.closest('.bellwrap')) setMenu(false); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
  // permission can change in the browser's site settings while the page is open
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  render();

  // ---- soft chime: two generated sine notes, quiet; WebAudio only, no files ------------
  let ctx = null;
  function audio() {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    try { ctx = ctx || new AC(); if (ctx.state === 'suspended') ctx.resume().catch(() => {}); } catch { return null; }
    return ctx;
  }
  function chime() {
    const c = audio(); if (!c) return;
    const t0 = c.currentTime + 0.03;
    for (const [f, at, len, peak] of [[659.25, 0, 1.1, 0.06], [987.77, 0.13, 1.4, 0.05]]) {
      for (const [mul, k] of [[1, 1], [2, 0.18]]) { // fundamental + a faint octave: a small bell, not a beep
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f * mul;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(peak * k, t0 + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len * (mul === 1 ? 1 : 0.6));
        o.connect(g); g.connect(c.destination);
        o.start(t0 + at); o.stop(t0 + at + len + 0.05);
      }
    }
  }
  // after a reload the audio context needs one user gesture before it may play
  if (chimeOn) {
    const unlock = () => { audio(); window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
    window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true);
  }

  // ---- notifications -----------------------------------------------------------------
  const open = new Map(); // agent id -> Notification currently showing
  function show(title, body, tag, id = null) {
    if (!active()) return null;
    try {
      const n = new Notification(title, { body, tag, icon: 'app/icon-192.png', badge: 'app/icon-192.png', silent: true, requireInteraction: false });
      n.onclick = e => {
        e.preventDefault?.();
        try { window.focus(); } catch { /* ignore */ }
        if (id) jumpTo(id);
        n.close();
      };
      if (id) { n.onclose = () => { if (open.get(id) === n) open.delete(id); }; open.set(id, n); }
      return n;
    } catch { return null; } // e.g. a browser that only allows notifications from a service worker
  }
  function alertFor(a) {
    if (!active() || !allowed) return;
    if (chimeOn) chime();
    const looking = document.visibilityState === 'visible' && document.hasFocus();
    if (looking && !force) return; // they can already see the hand go up
    show(`${nameOf(a)} is waiting on you`, clip(a.asking, 180), `ai-office-ask-${a.id}`, a.id);
  }

  // ---- badge + title -------------------------------------------------------------------
  const baseTitle = document.title.replace(/^\(\d+\)\s*/, '') || 'AI Office';
  let lastCount = -1;
  function setCount(n) {
    if (n === lastCount) return; lastCount = n;
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
    if (!allowed) return; // a demo tab must not touch the installed app's dock badge
    try {
      if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
      else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch { /* ignore */ }
  }
  // a closed window should not leave a stale number on the dock icon
  window.addEventListener('pagehide', () => { try { if (allowed) navigator.clearAppBadge?.().catch(() => {}); } catch { /* ignore */ } });

  const asking = new Map(); // agent id -> its question, for the agents in a waiting episode right now
  const ended = new Map();  // agent id -> { at, text } of an episode that just ended (a brief gap is the same episode)
  const SAME_EPISODE_MS = 90 * 1000;
  let primed = false, offline = false;
  return {
    /** call with every snapshot, after the office has synced it */
    update(snap) {
      const agents = snap?.agents || [];
      const t = Date.now();
      offline = false;
      const now = new Map();
      for (const a of agents) {
        if (!a.asking || a.askTo) continue; // only asks addressed to you
        now.set(a.id, a.asking);
        if (asking.has(a.id) || !primed) continue; // already waiting when the page opened: the badge says so, no alert
        const e = ended.get(a.id);
        if (e && t - e.at < SAME_EPISODE_MS && e.text === a.asking) continue; // missed by one snapshot (or a reconnect): same episode
        alertFor(a);
      }
      for (const [id, text] of asking) if (!now.has(id)) { ended.set(id, { at: t, text }); open.get(id)?.close(); open.delete(id); } // answered: drop the stale notification
      for (const [id, e] of ended) if (now.has(id) || t - e.at > SAME_EPISODE_MS) ended.delete(id);
      asking.clear(); for (const [id, text] of now) asking.set(id, text);
      primed = true;
      setCount(now.size);
    },
    /** the server is unreachable: no stale number on the dock or in the title; who was waiting is remembered, so the
     *  first snapshot after the reconnect alerts nobody twice */
    setOffline(v) {
      if (v === offline) return; offline = !!v;
      if (offline) setCount(0);
    },
    /** close the alerts menu (the Key popover is opening) */
    closeMenu() { setMenu(false); },
  };
}
