// HTML overlay: name tags with role chips, thought / event / ambient bubbles, and little emotion marks.
import * as THREE from 'three';
import { VENDOR, ROLE } from './palette.js';
import { jobSummary } from './jobs.js';
import { stage } from './stage.js';

const ICON = { tool: '⌨️', think: '💭', say: '💬', read: '📩', error: '💦' };
const v = new THREE.Vector3();

// tag spots, tried in order: { c: compact, l: lift (rows up on a leader), s: side (-1 left / +1 right of the head) }
const TAGS_NEAR = [{ c: false, l: 0, s: 0 }, { c: true, l: 0, s: 0 }, { c: true, l: 1, s: 0 }, { c: true, l: 2, s: 0 }];
const TAGS_FAR = [{ c: true, l: 0, s: 0 }, { c: true, l: 0, s: -1 }, { c: true, l: 0, s: 1 }, { c: true, l: 1, s: 0 }]; // far zoom: compact, beside the head before lifting, lift at most 1
const FAR_IN = 30, FAR_OUT = 34;   // median px per world unit: below FAR_IN the view counts as far (back above FAR_OUT)
const MIN_SHOW_MS = 2000;          // a bubble once shown stays at least this long (no blinking)
const MIN_HELD_MS = 1500;          // a bubble once held back on a busy floor stays held at least this long
const isReal = k => k === 'event' || k === 'done';
// far zoom: only these keep a bubble (asks in full, the rest as icon chips); routine thoughts and office life drop out
const FAR_KINDS = new Set(['ask', 'error', 'event', 'done']);
const FAR_FULL = 2;                // far zoom: the freshest real lines (event / done) that still show their text
const PING_MS = 1300;              // far zoom: the ring around a tag when something new happens to that worker
// near zoom: routine bubbles (thoughts, tool lines, "still working" dots, office life) on screen at once; the rest shrink
// to the icon chip (hover the tag or the chip to read it). Asks, errors and real events / interactions never count.
const ROUTINE_MAX = 3;
const ROUTINE_MIN_MS = 6000;       // a routine bubble given a full spot keeps it at least this long, then may rotate out
const isRoutine = b => !!b && !isReal(b.kind) && b.kind !== 'ask' && b.kind !== 'error';
const ERR_TAG_MS = 20000;          // a fresh error keeps the status dot on the tag (red) this long
const EDGE = 8;                    // tags and bubbles keep this far inside the left / right edges of the window
const BELOW_HUD = 6;               // ... and at least this far below the header (--hud-h)
// overlap cost per obstacle kind, for bubble placement (own face is fair game; other people's tags weigh most of the
// people layer, so a bubble never reads as someone else's)
const COST = { face: 3, body: 2, ownBody: 1.5, tag: 2.5, ownTag: 1.5, panel: 4, hud: 4 };
const taskLine = t => String(t || '').replace(/^Helper:\s*/, '').trim();
const HUD_FALLBACK = 56;           // px clear of the top when main.js has not measured the HUD yet (--hud-b)
const PANEL_MS = 250;              // how often the panel / HUD rectangles are re-read (they rarely move)
const PANELS = ['#roster', '#log', '#card', '#timeline']; // the Today drawer covers the front rows while open

const clockText = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export class Overlay {
  constructor(el, onSelect, onFocus) {
    this.el = el; this.onSelect = onSelect; this.onFocus = onFocus; this.items = new Map(); this.far = false;
    this.panels = []; this.hudRects = []; this.panelT = -Infinity;
    this.leadN = new Map(); // lead id -> helpers present (reused every frame)
    // the last known pointer position: a tag that slides out from under a still pointer never gets mouseleave, so
    // update() drops the hover itself once the pointer is no longer over it (read only while a tag is hovered)
    this.px = -1e4; this.py = -1e4;
    const track = e => { this.px = e.clientX; this.py = e.clientY; };
    window.addEventListener('pointermove', track, { passive: true });
    window.addEventListener('pointerdown', track, { passive: true });
    window.addEventListener('pointerout', e => { if (!e.relatedTarget) { this.px = -1e4; this.py = -1e4; } }, { passive: true }); // left the window
    // the rounded web font arriving late changes every text width: measure tags, bubbles and edge chips again
    document.fonts?.addEventListener?.('loadingdone', () => { for (const it of this.items.values()) { it.wKey = null; it.bDirty = true; it.ew = 0; } });
  }
  /** visible panels (roster, log, card) and the HUD cards, as screen rectangles; read before any overlay writes */
  readPanels() {
    const rect = (el, pad, kind) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? { l: b.left - pad, t: b.top - pad, r: b.right + pad, b: b.bottom + pad, kind } : null; };
    this.panels = PANELS.map(sel => document.querySelector(sel)).filter(Boolean).map(el => rect(el, 6, 'panel')).filter(Boolean);
    this.hudRects = [...document.querySelectorAll('#hud .title, #hud .legend')].map(el => rect(el, 4, 'hud')).filter(Boolean);
  }
  ensure(worker) {
    if (this.items.has(worker.id)) return this.items.get(worker.id);
    const tag = document.createElement('div'); tag.className = 'tag';
    // .rdy: "✓ your turn" (finished, ready for you); .hov: the current task, shown above the tag on hover (absolute, so
    // the tag never changes size when it appears)
    tag.innerHTML = `<span class="dot"></span><span class="role" hidden></span><span class="nm"></span><span class="proj"></span><span class="rdy" hidden>✓ your turn</span><span class="jb" hidden></span><span class="st"></span><span class="hov" hidden></span>`;
    tag.addEventListener('click', () => this.onSelect?.(worker));
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    const mark = document.createElement('div'); mark.className = 'mark';
    // an off-screen agent waiting on you: a small chip on the screen edge pointing toward them
    const edge = document.createElement('button'); edge.className = 'edge'; edge.type = 'button';
    edge.innerHTML = `<span class="ar">➜</span><span class="en"></span>`;
    edge.addEventListener('click', () => (this.onFocus || this.onSelect)?.(worker));
    this.el.append(bubble, tag, mark, edge);
    const it = { tag, bubble, mark, edge, lastText: null, lastKey: null, lastB: null, shownAt: 0, textAt: 0, heldUntil: 0, wasHeld: false, hover: false, hoverUntil: 0,
      lastMark: null, bw: 120, bh: 34, bDirty: true, ew: 0, eh: 26, nm: tag.querySelector('.nm'), proj: tag.querySelector('.proj'), role: tag.querySelector('.role'), dot: tag.querySelector('.dot'),
      jb: tag.querySelector('.jb'), rdy: tag.querySelector('.rdy'), hov: tag.querySelector('.hov'), ar: edge.querySelector('.ar'), en: edge.querySelector('.en'),
      worker, ready: false, pinging: false, taskRaw: undefined, lc: '', tailSide: 0, bodyR: { l: 0, t: 0, r: 0, b: 0, kind: 'body', owner: worker } };
    // hover the tag (or an icon chip) for the full bubble text at far zoom; the worker's team threads stand out meanwhile
    tag.addEventListener('mouseenter', () => { it.hover = true; worker.mgr?.threads?.setHover?.(worker); });
    tag.addEventListener('mouseleave', () => { it.hover = false; it.hoverUntil = performance.now() + 600; worker.mgr?.threads?.setHover?.(null); });
    bubble.addEventListener('mouseenter', () => { it.hoverUntil = performance.now() + 3000; });
    this.items.set(worker.id, it);
    return it;
  }
  remove(id) {
    const it = this.items.get(id); if (!it) return;
    if (it.hover) it.worker.mgr?.threads?.setHover?.(null); // a hovered tag that goes away never sends mouseleave
    it.tag.remove(); it.bubble.remove(); it.mark.remove(); it.edge.remove(); this.items.delete(id);
  }

  /** a hovered tag that is gone, hidden or no longer under the pointer (it slid away, or the pointer left the window)
   *  loses its hover; one rectangle read per hovered tag, none otherwise */
  checkHover(t) {
    for (const it of this.items.values()) {
      if (!it.hover) continue;
      let on = !it.tag.classList.contains('gone') && !it.tag.hidden;
      if (on) { const b = it.tag.getBoundingClientRect(); on = this.px >= b.left && this.px <= b.right && this.py >= b.top && this.py <= b.bottom; }
      if (!on) { it.hover = false; it.hoverUntil = t + 600; it.worker.mgr?.threads?.setHover?.(null); }
    }
  }

  update(allWorkers, camera, width, height, now, activeFloor = 0) {
    // layout inputs first, before this frame writes any style (no forced layout): the HUD's measured bottoms (main.js
    // sets --hud-b, the pill row, and --hud-h, the whole header, on the root; they wrap to 2+ rows on narrow windows),
    // the open panels / HUD cards, and whether a hovered tag is still under the pointer
    const rootStyle = document.documentElement.style;
    const hudB = parseFloat(rootStyle.getPropertyValue('--hud-b')), hudH = parseFloat(rootStyle.getPropertyValue('--hud-h'));
    const hudTop = hudB > 0 ? Math.max(HUD_FALLBACK, hudB + 6) : HUD_FALLBACK;
    const topMin = (hudH > 0 ? hudH : Math.max(hudB || 0, HUD_FALLBACK - BELOW_HUD)) + BELOW_HUD; // nothing above this line
    const t = performance.now();
    if (t - this.panelT > PANEL_MS) { this.panelT = t; this.readPanels(); }
    this.checkHover(t);
    const { panels, hudRects } = this;
    // helpers present per lead (for "★ LEAD · N"), counted on every floor
    const leadN = this.leadN; leadN.clear();
    for (const w of allWorkers) {
      if (!w.isHelper || w.done || w.leaving) continue;
      const l = w.lead; if (l) leadN.set(l.id, (leadN.get(l.id) || 0) + 1);
    }
    const workers = [];
    for (const w of allWorkers) {
      if ((w.visFloor ?? w.floor) === activeFloor && !w.hiddenFloor) { workers.push(w); continue; } // on the stairs: the floor that owns the flight
      // someone on another floor: invisible and unclickable (an invisible tag at an old spot would catch clicks and
      // open the wrong card; .tag:hover would bring it back)
      const it = this.items.get(w.id);
      if (it) {
        it.tag.style.opacity = 0; it.tag.classList.add('gone');
        it.bubble.style.opacity = 0; it.bubble.classList.add('out', 'gone');
        it.mark.style.opacity = 0; it.mark.classList.add('gone');
        it.edge.classList.remove('show');
      }
    }
    // pass 1: screen anchors and sizes
    const rows = [];
    const up = new THREE.Vector3();
    for (const w of workers) {
      const it = this.ensure(w);
      w.anchor(v); up.copy(v); up.y += 1;
      v.project(camera); up.project(camera);
      const sx = (v.x + 1) / 2 * width, sy = (1 - v.y) / 2 * height;
      const pxPerUnit = Math.max(1, Math.abs((1 - up.y) / 2 * height - sy)); // pixels per world unit, vertically
      const depth = Math.round((1 - v.z) * 1000);
      const off = sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20; // speaker out of view: no bubble
      rows.push({ w, it, sx, sy, k: pxPerUnit * w.look.scale, depth, off });
    }
    // zoom level: far away, tags go compact and ordinary bubbles shrink to icon chips
    if (rows.length) {
      const ks = rows.map(r => r.k).sort((a, b) => a - b), med = ks[ks.length >> 1];
      if (this.far ? med > FAR_OUT : med < FAR_IN) this.far = !this.far;
    }
    const far = this.far;
    // tag text first (its size drives the layout)
    for (const r of rows) {
      const { w, it } = r;
      const role = ROLE[w.role] || ROLE.member;
      if (it.nm.textContent !== w.name) it.nm.textContent = w.name;
      const lead = w.lead;
      const revFor = w.reviewing?.taken || w.reviewTask?.to;
      let roleTxt = '', roleKey = w.role, lc = '';
      if (w.role === 'lead') { const n = this.leadN.get(w.id) || 0; roleTxt = n ? `${role.icon} ${role.label} · ${n}` : `${role.icon} ${role.label}`; }
      else if (w.role === 'reviewer') roleTxt = revFor ? `✓ for ${revFor.name}` : `${role.icon} ${role.label}`;
      else if (lead) {
        // one helper chip everywhere: "↳ Lead" in the lead's colour (a tight tag truncates the name, never drops it)
        roleTxt = `↳ ${lead.name}`; roleKey = 'mini'; lc = VENDOR[lead.look.vendorKey]?.css || '';
      }
      else if (w.starter) { // a chat of its own that another chat started: the same chip, a different arrow
        roleTxt = `↗ ${w.starter.name}`; roleKey = 'mini'; lc = VENDOR[w.starter.look.vendorKey]?.css || '';
      }
      else if (role.label) roleTxt = `${role.icon} ${role.label}`;
      if (it.role.textContent !== roleTxt) it.role.textContent = roleTxt;
      if (it.roleKey !== roleKey) { it.roleKey = roleKey; it.role.className = `role r-${roleKey}`; }
      if (it.lc !== lc) { it.lc = lc; it.role.style.setProperty('--lc', lc || 'transparent'); }
      it.role.hidden = !roleTxt; // no empty chip
      // finished · your turn: a sage "✓ your turn" chip (calm; the amber ask outranks it)
      const ready = !w.agent.asking && !!w.isReady?.(now);
      // handed back to the agent that gave the work: "✓ Sora's turn" in the same place, quieter, never a ping for you
      const handed = !w.agent.asking && !ready && !!w.isHandedBack?.(now);
      const rdyTxt = ready ? '✓ your turn' : handed ? `✓ ${w.turnWords()}` : '';
      if (ready !== it.ready || handed !== it.handed || rdyTxt !== it.rdyTxt) {
        it.ready = ready; it.handed = handed; it.rdyTxt = rdyTxt;
        it.tag.classList.toggle('ready', ready); it.tag.classList.toggle('handed', handed);
        it.rdy.hidden = !ready && !handed; if (rdyTxt) it.rdy.textContent = rdyTxt; r.readyOn = ready;
      }
      // work going on outside the turn, wherever this worker is: runs, the next timer, or one that failed
      const js = jobSummary(w.agent, stage.wall());
      const jbTxt = js.failed ? `⚠ job failed` : [js.running ? `⚙ ${js.running} job${js.running > 1 ? 's' : ''}` : '', js.nextAt ? `⏱ ${clockText(js.nextAt)}` : ''].filter(Boolean).join(' ');
      if (it.jbTxt !== jbTxt) { it.jbTxt = jbTxt; it.jb.textContent = jbTxt; it.jb.hidden = !jbTxt; it.jb.classList.toggle('bad', !!js.failed); }
      // the current task, on hover (set only when it changes)
      if (it.taskRaw !== w.agent.task) { it.taskRaw = w.agent.task; const tl = taskLine(w.agent.task); it.hov.textContent = tl; it.hov.hidden = !tl; }
      // the project once per team: always on the lead's tag; people working alone (and the QA desk) show it on hover
      const projName = w.role === 'reviewer' ? (revFor ? '' : 'QA') : (w.role === 'lead' || !lead) ? (w.agent.project || '') : '';
      const proj = projName ? `· ${projName}` : '';
      if (it.proj.textContent !== proj) it.proj.textContent = proj;
      it.proj.hidden = !proj;
      const projHover = w.role !== 'lead';
      it.tag.classList.toggle('ph', projHover);
      it.tag.classList.toggle('small', w.look.scale < 1);
      // the status dot only when it says something: waiting on you, a fresh error, or on a break (not while simply working)
      const working = w.agent.status === 'working', asking = !!w.asksYou; // an ask to another agent is not an alarm for you
      const err = w.agent.thought?.kind === 'error' && now - w.thoughtAt < ERR_TAG_MS;
      it.tag.classList.toggle('working', working); it.tag.classList.toggle('idle', !working);
      it.tag.classList.toggle('asking', asking); it.tag.classList.toggle('err', err);
      const stOn = !ready && !handed && (asking || err || !working);
      // simply sitting and working, nothing for you: in a crowd this tag yields first (see the declutter pass)
      r.quiet = working && !asking && !err && !ready && !handed && w.state === 'work' && !it.hover && !w.agent.askTo;
      const key = `${w.name}|${roleTxt}|${proj}|${projHover}|${w.look.scale < 1}|${rdyTxt}|${stOn}|${jbTxt}`;
      if (it.wKey !== key) { // measure the full and the compact (name only) width once per text change
        it.wKey = key; const was = it.tag.classList.contains('compact'), wasFaded = it.tag.classList.contains('faded');
        it.tag.classList.remove('faded', 'compact'); it.fullW = it.tag.offsetWidth || 90; it.th = it.tag.offsetHeight || 22;
        it.tag.classList.add('compact'); it.compactW = it.tag.offsetWidth || 60;
        it.tag.classList.toggle('compact', was); it.tag.classList.toggle('faded', wasFaded);
      }
    }
    // faces: a box over each head; bodies: a box from the neck down (shorter seated), kept clear by tags and bubbles
    for (const r of rows) {
      const hr = 0.42 * r.k; r.face = { l: r.sx - hr, t: r.sy, r: r.sx + hr, b: r.sy + 2 * hr, kind: 'face', owner: r.w };
      const bd = r.it.bodyR, bw = 0.3 * r.k;
      bd.l = r.sx - bw; bd.r = r.sx + bw; bd.t = r.sy + 2 * hr; bd.b = r.sy + (r.w.chibi?.pose === 'sit' ? 1.25 : 1.55) * r.k;
      r.body = bd;
    }
    // name tags, declutter: people in front keep the full tag; a tag that would overlap one already placed drops to
    // the compact form (name + role), then (far zoom: beside the head, then) stacks upward on a thin leader; if nothing
    // fits it collapses to its dot. A tag never sits on the face of someone in front of its owner; a moved tag clears every face.
    // Someone who is simply sitting and working never lifts a tag onto a leader or beside the head: where the tag will
    // not fit at its own spot it shrinks to the coloured dot (the full tag on hover). Everyone else is placed first, so
    // asks, errors, finished work and people on the move keep their tags in a crowd.
    rows.sort((a, b) => (a.quiet - b.quiet) || (b.sy - a.sy));
    const placedTags = [];
    const CANDS_ALL = far ? TAGS_FAR : TAGS_NEAR, CANDS_QUIET = CANDS_ALL.filter(c => !c.l && !c.s);
    for (const r of rows) {
      const { it, sx, sy } = r;
      const CANDS = r.quiet ? CANDS_QUIET : CANDS_ALL;
      if (it.tagFar !== far || it.tagQuiet !== r.quiet) { it.tagFar = far; it.tagQuiet = r.quiet; it.tagCand = 0; it.upT = 0; }
      const step = it.th + 4, hr = 0.42 * r.k;
      // a tag stays inside the window: x in [EDGE, width - EDGE - tag width], and clear below the header
      const inView = (rc, tw) => {
        const l = rc.l + 2, dx = Math.max(EDGE, Math.min(width - EDGE - tw, l)) - l, dy = Math.max(0, topMin - (rc.t + 1));
        if (dx || dy) { rc.l += dx; rc.r += dx; rc.t += dy; rc.b += dy; }
        return rc;
      };
      const rectFor = cd => {
        const tw = cd.c ? it.compactW : it.fullW;
        if (cd.s) { // beside the head, vertically centred on it
          const cy = sy + hr, r0 = cd.s < 0 ? sx - hr - 4 : sx + hr + 4 + tw;
          return inView({ l: r0 - tw - 2, t: cy - it.th / 2 - 1, r: r0 + 2, b: cy + it.th / 2 + 1, kind: 'tag', owner: r.w, s: cd.s }, tw);
        }
        const b = sy - 4 - cd.l * step;
        return inView({ l: sx - tw / 2 - 2, t: b - it.th - 1, r: sx + tw / 2 + 2, b: b + 1, kind: 'tag', owner: r.w, s: 0 }, tw);
      };
      const clean = (rect, cd) => (!cd.s || (rect.l > 2 && rect.r < width - 2)) && !placedTags.some(o => overlap(rect, o)) && !rows.some(o => o !== r && (cd.l > 0 || cd.s || o.sy > sy) && (overlap(rect, o.face) || overlap(rect, o.body)))
        && !hudRects.some(o => overlap(rect, o)); // tags keep clear of the HUD cards too
      const prev = Math.min(it.tagCand ?? 0, CANDS.length - 1);
      let pick = -1;
      for (let i = r.w.outdoors && !CANDS[0].c ? 1 : 0; i < CANDS.length && pick < 0; i++) if (clean(rectFor(CANDS[i]), CANDS[i])) pick = i; // still outside: compact tag (far zoom: index 0 already is)
      // no flicker when people walk past each other: step down at once, step back up only after the better spot
      // has stayed free for a moment
      if (pick >= 0 && pick < prev && clean(rectFor(CANDS[prev]), CANDS[prev])) { it.upT = (it.upT || 0) + 1; if (it.upT < 24) pick = prev; else it.upT = 0; }
      else it.upT = 0;
      r.tagFaded = pick < 0; if (pick < 0) pick = far ? 0 : 1;
      it.tagCand = pick;
      const cd = CANDS[pick];
      r.tagCompact = cd.c;
      r.tagRect = rectFor(cd);
      r.tagLift = cd.s ? 0 : Math.max(0, sy - 4 - (r.tagRect.b - 1)); // the leader's length (none when pushed down below the header)
      if (!r.tagFaded) placedTags.push(r.tagRect);
    }
    const obstacles = [...panels, ...hudRects]; // open panels and HUD cards: bubbles keep clear of them
    for (const r of rows) obstacles.push(r.face, r.body, r.tagRect);
    const placedBubbles = [];
    // pass 2a: what each person says (with a minimum display time), and how much of it fits at this zoom
    const crowded = rows.length > 8; // a busy floor: only fresh thoughts and real interactions get a bubble
    for (const r of rows) {
      const { w, it } = r;
      let b = w.bubbleFor(now);
      if (b && w.outdoors && !isReal(b.kind) && b.kind !== 'error' && b.kind !== 'ask') b = null; // on the path: no chatter until inside
      if (b && crowded) {
        const fresh = now - w.thoughtAt < 5000;
        if (b.kind === 'ambient' || b.kind === 'dots' || (!isReal(b.kind) && b.kind !== 'error' && b.kind !== 'ask' && !fresh)) b = null;
      }
      // far away: routine thoughts, "still working" dots and office life are noise (hover the tag to read them)
      const hovered = it.hover || t < it.hoverUntil; r.hovered = hovered;
      const farDrop = x => far && !hovered && !FAR_KINDS.has(x.kind);
      if (b && farDrop(b)) b = null;
      // a bubble once up stays a moment (no blinking when a state flips back and forth); an answered ask goes at once
      if (!b && it.lastB && it.lastB.kind !== 'ask' && !farDrop(it.lastB) && now - it.shownAt < MIN_SHOW_MS && w.fade > 0.5) b = it.lastB;
      r.b = b;
      r.textAt = b ? (b.text === it.lastText ? it.textAt : now) : 0;
    }
    // far zoom: full text only for asks, the two freshest real lines (event / done) and whatever you hover; errors and
    // the other real lines become icon chips
    if (far) {
      const lines = rows.filter(r => r.b && isReal(r.b.kind) && now - r.textAt < 6000);
      lines.sort((a, b) => b.textAt - a.textAt);
      const keep = new Set(lines.slice(0, FAR_FULL));
      for (const r of rows) {
        const b = r.b; if (!b) continue;
        r.glyph = b.kind !== 'ask' && !keep.has(r) && !r.hovered;
      }
    } else this.routineBudget(rows, now);
    for (const r of rows) {
      const { w, it, sx, sy, depth, b } = r;
      const col = VENDOR[w.look.vendorKey].css;
      it.tag.style.setProperty('--c', col); it.bubble.style.setProperty('--c', col);

      let ping = r.readyOn === true; // just became ready for you
      // b.cls: a look modifier on top of the kind (links: 'weak' for an artifact link, 'weak inferred' for an inferred
      // one, which also gets a "?" chip; 'calm' for an approval)
      const cls = b?.cls || '';
      const bkey = b ? `${b.kind}|${cls}|${b.text}|${r.glyph ? 1 : 0}` : null;
      if (b && bkey !== it.lastKey) {
        const newText = b.text !== it.lastText;
        it.lastKey = bkey; it.lastText = b.text; it.lastB = b;
        if (newText) { it.shownAt = now; it.textAt = now; if (FAR_KINDS.has(b.kind)) ping = true; }
        it.bubble.className = `bubble show ${b.kind || ''}${cls ? ` ${cls}` : ''}${r.glyph ? ' glyph' : ''}`; it.tailSide = 0;
        const q = cls.includes('inferred') ? '<span class="q" title="inferred: timing or a content echo only, never certain">?</span>' : '';
        if (r.glyph) it.bubble.innerHTML = `<span class="k">${escapeHtml(glyphFor(b))}</span>`;
        else if (b.kind === 'dots') it.bubble.innerHTML = `<span class="dots"><span>•</span><span>•</span><span>•</span></span>`;
        else it.bubble.innerHTML = `<span class="tx">${b.icon ? `<span class="k">${b.icon}</span>` : ''}${escapeHtml(b.text)}${q}</span>`;
        it.bubble.title = r.glyph ? b.text : '';
        it.bDirty = true; // size measured once, before placement (not every frame)
        if (newText) { it.bubble.classList.add('pop'); setTimeout(() => it.bubble.classList.remove('pop'), 500); }
        it.cand = 0;
      } else if (!b && it.lastKey !== null) { it.lastKey = null; it.lastText = null; it.lastB = null; it.bubble.classList.remove('show'); }
      it.bubble.classList.remove('gone');

      const m = w.marks[w.marks.length - 1];
      const mk = m ? `${m.sym}@${m.at}` : null;
      if (mk !== it.lastMark) {
        it.lastMark = mk;
        if (m) {
          const ambient = m.ambient || m.sym === '♪'; // humming is office life: grey, not an attention colour
          it.mark.textContent = m.sym; it.mark.className = ambient ? 'mark show ambient' : 'mark show'; it.mark.classList.add('pop'); setTimeout(() => it.mark.classList.remove('pop'), 400);
          if (!ambient) ping = true;
        } else it.mark.className = 'mark';
      }
      // far zoom: a ring around the tag when something new happens to this worker (the bubble may be only a chip)
      if (ping && far && !it.pinging && w.fade > 0.5) {
        it.pinging = true; it.tag.classList.add('ping');
        setTimeout(() => { it.pinging = false; it.tag.classList.remove('ping'); }, PING_MS);
      }
      it.mark.style.left = `${(sx + 0.62 * r.k).toFixed(1)}px`; it.mark.style.top = `${(sy + 0.85 * r.k).toFixed(1)}px`; // beside the head (manga sweat-drop spot), clear of the tag
      it.mark.style.zIndex = depth + 2; // above tags and bubbles
      it.mark.style.opacity = ''; it.mark.classList.remove('gone');

      // name tag: just above the head (or beside it / stacked above it on a leader when the spot is taken); no room at all: the dot only
      const tr = r.tagRect;
      it.tag.classList.toggle('compact', r.tagCompact); it.tag.classList.toggle('lifted', r.tagLift > 0 && !r.tagFaded); it.tag.classList.toggle('faded', r.tagFaded);
      if (r.tagLift > 0) it.tag.style.setProperty('--lift', `${r.tagLift.toFixed(0)}px`);
      const tx = (tr.l + tr.r) / 2, ty = tr.b - 1; // the placed (and kept-in-view) rectangle
      it.tag.style.transform = `translate(-50%, -100%) translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
      it.tag.style.zIndex = depth;
      it.tag.style.opacity = w.fade * (r.tagFaded ? 0.8 : 1);
      it.tag.classList.toggle('gone', !(w.fade > 0.05)); // walking in or out, not yet visible: no clicks, no hover
    }
    // bubble sizes: only bubbles whose text or class changed, all read together (at most one layout per frame)
    for (const r of rows) {
      const it = r.it;
      if (it.bDirty && it.bubble.classList.contains('show')) { it.bw = it.bubble.offsetWidth || 120; it.bh = it.bubble.offsetHeight || 34; it.bDirty = false; }
    }
    // pass 2b: bubble placement. Asks always go first; on a crowded floor the rest follow by priority
    // (error > interaction > transit > thought); within a rank the front-most first, so people in front keep the natural spot
    const rank = b => !b ? 9 : b.kind === 'ask' ? 0 : !crowded ? 1 : b.kind === 'error' ? 1 : isReal(b.kind) ? (b.transit ? 3 : 2) : 4;
    rows.sort((a, b) => (rank(a.b) - rank(b.b)) || (b.sy - a.sy));
    for (const r of rows) {
      const { w, it, sx, sy, depth, b } = r;
      const showing = it.bubble.classList.contains('show');
      let held = showing && r.off; // the speaker is out of view: a bubble pointing at nothing helps nobody
      if (showing && !r.off) {
        const bw = it.bw, bh = it.bh + 10;
        const tagTop = r.tagRect.s && !r.tagFaded ? sy - 4 : r.tagRect.t; // a tag beside the head: the bubble still goes above the head
        const cands = [
          [sx, tagTop - 6], [sx + bw * 0.45, tagTop - 6], [sx - bw * 0.45, tagTop - 6],
          [sx + bw * 0.55 + 14, sy + 0.9 * r.k], [sx - bw * 0.55 - 14, sy + 0.9 * r.k],
          [sx + bw * 0.9, tagTop - 30], [sx - bw * 0.9, tagTop - 30], [sx, tagTop - 6 - bh * 0.9],
        ];
        // inside the window (EDGE from the sides) and clear below the header
        const rectAt = ([x, y]) => { const cx = Math.max(bw / 2 + EDGE, Math.min(width - bw / 2 - EDGE, x)), yb = Math.max(y, topMin + it.bh); return { l: cx - bw / 2, t: yb - bh, r: cx + bw / 2, b: yb, cx }; };
        const score = rect => {
          let sc = 0;
          // everyone's face and tag, the speaker's own tag included (a bubble never covers its own name); only the
          // speaker's own face is fair game
          for (const o of obstacles) {
            if (o.owner === w && o.kind === 'face') continue;
            const a = overlap(rect, o); if (!a) continue;
            const own = o.owner === w;
            sc += a * (o.kind === 'face' ? COST.face : o.kind === 'body' ? (own ? COST.ownBody : COST.body) : o.kind === 'tag' ? (own ? COST.ownTag : COST.tag) : COST.panel);
          }
          for (const o of placedBubbles) sc += overlap(rect, o) * 2;
          if (rect.t < hudTop) sc += (hudTop - rect.t) * bw; // keep clear of the HUD, however many rows it wraps to
          return sc;
        };
        let best = null, bestScore = Infinity, bestIdx = 0;
        // hysteresis: keep the previous spot while it is still clean
        const prev = it.cand || 0;
        const order = [prev, ...cands.map((_, i) => i).filter(i => i !== prev)];
        for (const i of order) {
          const rect = rectAt(cands[i]);
          // pushed too far from its speaker (e.g. clamped at the screen edge) it would read as someone else's; the spot
          // straight above always stays allowed so there is a fallback
          if (i !== 0 && Math.abs(rect.cx - sx) > 1.2 * bw) continue;
          const sc = score(rect);
          if (sc === 0) { best = rect; bestScore = 0; bestIdx = i; break; }
          if (sc < bestScore) { best = rect; bestScore = sc; bestIdx = i; }
        }
        it.cand = bestIdx;
        // busy floor: an ordinary thought or a walk-state line that cannot find a clear spot waits; asks, errors and
        // real interactions always show. Once held, it stays held a moment (no blinking in and out).
        const urgent = b?.kind === 'ask' || b?.kind === 'error' || (isReal(b?.kind) && !b.transit);
        held = crowded && bestScore > bw * bh * 0.12 && !urgent;
        if (held && !it.wasHeld) it.heldUntil = now + MIN_HELD_MS;
        if (!held && !urgent && now < it.heldUntil) held = true;
        if (!held) placedBubbles.push({ l: best.l, t: best.t, r: best.r, b: best.b });
        it.bubble.style.left = `${best.cx.toFixed(1)}px`; it.bubble.style.top = `${best.b.toFixed(1)}px`;
        // pushed sideways (the head is beyond the bubble's span): the tail leaves from the side, toward the head
        const off = best.cx - sx, side = Math.abs(off) >= bw * 0.5 ? (off > 0 ? -1 : 1) : 0;
        if (side) {
          const top = best.b - it.bh, ty = Math.max(9, Math.min(it.bh - 9, sy + 0.42 * r.k - top));
          it.bubble.style.setProperty('--tail-y', `${ty.toFixed(1)}px`);
        } else it.bubble.style.setProperty('--tail', `${Math.max(8, Math.min(92, (sx - best.l) / bw * 100)).toFixed(1)}%`);
        if (it.tailSide !== side) { it.tailSide = side; it.bubble.classList.toggle('tail-l', side < 0); it.bubble.classList.toggle('tail-r', side > 0); }
      }
      it.wasHeld = held;
      it.bubble.style.zIndex = depth + 1;
      const op = showing && !held ? w.fade : 0;
      it.bubble.style.opacity = op;
      it.bubble.classList.toggle('out', !(op > 0)); // going away: a quick fade, not a slow ghost

      // an ask from someone out of view: a chip on the screen edge pointing toward them
      const edgeOn = r.off && b?.kind === 'ask' && !(b.cls || '').includes('agent'); // only asks to you point from the screen edge
      it.edge.classList.toggle('show', edgeOn);
      if (edgeOn) {
        const label = `🙋 ${w.name}`;
        if (it.en.textContent !== label) { it.en.textContent = label; it.ew = 0; }
        if (!it.ew) { it.ew = it.edge.offsetWidth || 90; it.eh = it.edge.offsetHeight || 26; } // measured once per label
        const ew = it.ew / 2 + 10, eh = it.eh / 2 + 10;
        let ex = Math.max(ew, Math.min(width - ew, sx));
        const ey = Math.max(eh + hudTop + 4, Math.min(height - eh, sy)); // clear of the HUD
        // an open panel (roster, log, card) would cover the chip: slide it to the panel's inner side
        for (const p of panels) {
          if (ex + ew - 10 > p.l && ex - ew + 10 < p.r && ey + eh - 10 > p.t && ey - eh + 10 < p.b) ex = (p.l + p.r) / 2 > width / 2 ? p.l - ew + 10 : p.r + ew - 10;
        }
        ex = Math.max(ew, Math.min(width - ew, ex));
        it.edge.style.left = `${ex.toFixed(1)}px`; it.edge.style.top = `${ey.toFixed(1)}px`;
        it.ar.style.transform = `rotate(${Math.atan2(sy - ey, sx - ex).toFixed(3)}rad)`;
        it.edge.title = `${w.name} is waiting on you: ${b.text}`;
      }
    }
  }

  /** near zoom: at most ROUTINE_MAX routine bubbles in full on screen; the rest become icon chips (r.glyph). Order: a
   *  full one inside its ROUTINE_MIN_MS, then waiting ones with text not yet shown (newest first), then waiting ones
   *  already shown (least recently first), then full ones past their minimum: they rotate. Hovered and off-screen ones
   *  do not count. */
  routineBudget(rows, now) {
    const cands = this.budgetRows || (this.budgetRows = []); cands.length = 0;
    for (const r of rows) {
      if (isRoutine(r.b) && !r.off && !r.hovered) cands.push(r);
      else if (!r.hovered) r.it.fullSince = 0;
    }
    if (cands.length > ROUTINE_MAX) {
      for (const r of cands) {
        const it = r.it;
        r.bg = it.fullSince ? (now - it.fullSince < ROUTINE_MIN_MS ? 0 : 3) : r.textAt > (it.seenAt || 0) ? 1 : 2;
      }
      cands.sort((a, b) => (a.bg - b.bg) || (a.bg === 1 ? b.textAt - a.textAt : a.bg === 2 ? (a.it.seenAt || 0) - (b.it.seenAt || 0) : a.it.fullSince - b.it.fullSince));
    }
    for (let i = 0; i < cands.length; i++) {
      const r = cands[i], it = r.it;
      if (i < ROUTINE_MAX) { if (!it.fullSince) it.fullSince = now; it.seenAt = now; r.glyph = false; }
      else { it.fullSince = 0; r.glyph = true; }
    }
    cands.length = 0; // no rows held past the frame
  }
}

/** the one symbol an icon chip shows: the bubble's icon, else its first symbol (a letter would read as nothing) */
function glyphFor(b) {
  if (b.icon) return b.icon;
  const first = [...String(b.text || '').trim()][0] || '•';
  return /[\p{L}\p{N}]/u.test(first) ? '•' : first;
}

function overlap(a, b) { const x = Math.min(a.r, b.r) - Math.max(a.l, b.l), y = Math.min(a.b, b.b) - Math.max(a.t, b.t); return x > 0 && y > 0 ? x * y : 0; }

export function iconFor(kind) { return ICON[kind] || ''; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
