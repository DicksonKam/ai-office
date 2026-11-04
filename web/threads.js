// Team threads: thin arcs on the floor from a lead's desk to each of its helpers on the floor you are looking at, in
// the lead's vendor colour. They stand for a real relationship, and their line style says how surely we know it
// (Worker.linkStyleFor: the strongest link seen between the two):
//  - solid: declared or structural (a spawn, a parent link, a record naming both parties);
//  - dashed: artifact (both touched the same file); dotted: inferred (timing or a content echo), a hint only;
//  - small dots flow along a thread toward the helper while that helper is really working (not along a dotted one);
//  - when the helper's real report lands, its thread brightens and pulses once, then settles back.
// The patterns are gaps in the one ribbon (no extra draw calls, no textures).
// One mesh (ribbon, vertex RGBA) and one point cloud (flow dots) per team; the arcs are rebuilt a few times a second
// (every frame only while a pulse runs), the dots move every frame. Nothing is drawn for floors you are not viewing,
// nor while the lead is hosting a kickoff in the meeting room (the team is gathered there, not at the pod).
// A focused team (focusLead: set by focus(), e.g. from the roster, or by hovering a member's name tag) is drawn
// stronger while the other teams step back.
import * as THREE from 'three';
import { VENDOR } from './palette.js';

const Y = 0.024;               // just above the carpet and rugs
const WIDTH = 0.05;            // ribbon width (m)
const DASH = 0.2, GAP = 0.13;  // artifact links: dash pattern along the arc (m)
const DOT = 0.05, DOT_GAP = 0.11; // inferred links: one sample on, two off: a row of small squares
const STEP = 0.05;             // resampling step along the arc (m)
const BASE_ALPHA = 0.45;       // a hint, not a highway
const SOLID_K = 0.8;           // a continuous line carries more ink than dashes: a little lighter for the same weight
const FOCUS_ALPHA = 0.8, FOCUS_WIDTH = 1.35; // the focused team
const DIM_ALPHA = 0.22;        // the other teams while one is in focus
const PULSE_MS = 2600;         // solid flash on a real report, then back to dashes
const DOTS = 3;                // flow dots per working helper
const MAX_SEG = 2400;          // ribbon segments per team (capacity)

let dotTex = null;
function dotTexture() {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.55, 'rgba(255,255,255,0.9)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  dotTex = new THREE.CanvasTexture(c);
  return dotTex;
}

/** pulse envelope: quick rise to full, slow fall back to 0 */
function envelope(ms) {
  if (ms < 0 || ms > PULSE_MS) return 0;
  const t = ms / PULSE_MS;
  return t < 0.1 ? t / 0.1 : Math.pow(1 - (t - 0.1) / 0.9, 1.6);
}

export class Threads {
  constructor(scene, mgr) {
    this.scene = scene; this.mgr = mgr;
    this.teams = new Map();   // lead id -> team
    this.pulses = new Map();  // helper id -> performance.now() of its real report
    this.t = 0; this.rebuildT = 0;
    this.focusLead = null;    // lead id whose threads are highlighted (focusUntil 0: until cleared)
    this.focusUntil = 0;
    this.hoverLead = null;    // lead id of the team whose name tag is under the pointer (wins over focusLead)
  }
  /** a helper's real report just landed: flash its thread */
  pulse(helperId) { this.pulses.set(helperId, performance.now()); this.rebuildT = 0; }
  /** highlight a team's threads: a lead (worker or id), for `seconds` (0: until focus(null)) */
  focus(lead, seconds = 14) {
    this.focusLead = lead == null ? null : (lead.id ?? lead);
    this.focusRaw = this.focusLead; // the worker itself (a delegated worker or its giver shows that line while focused)
    this.focusUntil = this.focusLead && seconds > 0 ? performance.now() + seconds * 1000 : 0;
    this.rebuildT = 0;
  }
  /** the pointer is on a worker's name tag (null: left it): that worker's team stands out */
  setHover(w) {
    const id = w ? (w.role === 'lead' ? w.id : w.lead?.id ?? null) : null;
    if (id !== this.hoverLead) { this.hoverLead = id; this.rebuildT = 0; }
    const raw = w ? w.id : null;
    if (raw !== this.hoverRaw) { this.hoverRaw = raw; this.rebuildT = 0; }
  }
  focusedId(now) {
    if (this.hoverLead) return this.hoverLead;
    if (this.focusLead && this.focusUntil && now > this.focusUntil) { this.focusLead = null; this.focusUntil = 0; }
    return this.focusLead;
  }

  update(dt, now) {
    this.t += dt; this.rebuildT -= dt;
    let pulsing = false;
    for (const [id, at] of this.pulses) { if (now - at > PULSE_MS) this.pulses.delete(id); else pulsing = true; }
    if (this.rebuildT <= 0 || pulsing) { this.rebuildT = 0.25; this.rebuild(now); }
    for (const team of this.teams.values()) this.updateDots(team);
  }

  // ---- teams on the active floor -------------------------------------------
  rebuild(now) {
    const mgr = this.mgr, active = mgr.activeFloor, office = mgr.floors[active];
    const seen = new Set();
    // the focused team, only if its threads are drawn here (otherwise nobody steps back for nothing)
    let fid = this.focusedId(now);
    const fl = fid ? mgr.workers.get(fid) : null;
    if (!fl || fl.done || fl.leaving || fl.desk?.floor !== active || fl.state === 'meet') fid = null;
    if (office) {
      const list = mgr.list, built = [];
      for (const lead of list) {
        if (lead.done || lead.leaving || lead.role !== 'lead' || !lead.desk || lead.desk.owner !== lead || lead.desk.floor !== active) continue;
        if (lead.state === 'meet') continue; // hosting a kickoff: the team is in the meeting room
        const helpers = list.filter(w => !w.done && w.isHelper && w.lead === lead && w.fade > 0.5 && !w.hiddenFloor && (w.visFloor ?? w.floor) === active);
        if (helpers.length) built.push([lead, helpers]);
      }
      // a focus on someone with no threads drawn here (a solo worker, a lead with no helpers in): nobody steps back
      if (fid && !built.some(([lead]) => lead.id === fid)) fid = null;
      for (const [lead, helpers] of built) {
        seen.add(lead.id);
        let team = this.teams.get(lead.id);
        if (!team) { team = this.makeTeam(lead); this.teams.set(lead.id, team); }
        team.group.position.y = office.baseY + Y;
        team.emph = fid ? (fid === lead.id ? 1 : -1) : 0;
        this.buildArcs(team, lead, helpers, now);
      }
    }
    // work one agent gave another (not a team): its line only while the pointer or the focus is on either of them
    if (office) this.buildDelegation(mgr, active, now, seen);
    for (const [id, team] of this.teams) if (!seen.has(id)) { this.disposeTeam(team); this.teams.delete(id); }
  }

  /** the line from a giver's desk to the workers it gave work to (`agent.delegator`), or to the chats it started
   *  (`agent.startedBy`), drawn only on hover / focus of either end: solid when certain, dotted when inferred. Adopted
   *  helpers already have their team's threads. */
  buildDelegation(mgr, active, now, seen) {
    const pid = this.hoverRaw || (this.focusRaw && this.focusLead === this.focusRaw && (!this.focusUntil || now <= this.focusUntil) ? this.focusRaw : null);
    const p = pid ? mgr.workers.get(pid) : null;
    if (!p || p.done) return;
    const giver = p.agent.delegator ? p.giver : p.agent.startedBy ? p.starter : p;
    if (!giver || giver.done || giver.leaving || !giver.desk || giver.desk.floor !== active || giver.desk.owner !== giver) return;
    const workers = mgr.list.filter(w => !w.done && !w.isHelper && (w.agent.delegator?.id ?? w.agent.startedBy?.id) === giver.id && (p === giver || w === p)
      && w.fade > 0.5 && !w.hiddenFloor && (w.visFloor ?? w.floor) === active);
    if (!workers.length) return;
    const key = `deleg:${giver.id}`;
    seen.add(key);
    let team = this.teams.get(key);
    if (!team) { team = this.makeTeam(giver); this.teams.set(key, team); }
    team.group.position.y = mgr.floors[active].baseY + Y;
    team.emph = 1;
    this.buildArcs(team, giver, workers, now);
    for (const arc of team.arcs) arc.style = arc.h.agent.delegator && !arc.h.agent.delegator.certain ? 'dotted' : 'solid';
    this.fillRibbon(team);
  }

  makeTeam(lead) {
    const col = new THREE.Color(VENDOR[lead.look.vendorKey]?.accent ?? 0x9aa0b0);
    const group = new THREE.Group(); group.name = 'team-threads';
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_SEG * 6 * 3), rgba = new Float32Array(MAX_SEG * 6 * 4);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const ribbon = new THREE.Mesh(geo, mat); ribbon.frustumCulled = false; ribbon.renderOrder = 1; ribbon.userData.noMode = true;
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    dgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(64 * 4), 4).setUsage(THREE.DynamicDrawUsage));
    dgeo.setDrawRange(0, 0);
    const dmat = new THREE.PointsMaterial({ size: 0.13, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true });
    const dots = new THREE.Points(dgeo, dmat); dots.frustumCulled = false; dots.renderOrder = 1; dots.position.y = 0.012; dots.userData.noMode = true;
    group.add(ribbon); group.add(dots);
    this.scene.add(group);
    return { lead, col, group, ribbon, dots, arcs: [], emph: 0 };
  }

  disposeTeam(team) {
    this.scene.remove(team.group);
    team.ribbon.geometry.dispose(); team.ribbon.material.dispose();
    team.dots.geometry.dispose(); team.dots.material.dispose();
  }

  /** one arc per helper: from the edge of the lead's desk to just short of the helper, bowed outward from the desk */
  buildArcs(team, lead, helpers, now) {
    const d = lead.desk, hw = 1.0 + 0.12, hd = 0.4 + 0.12;
    team.arcs = [];
    for (const h of helpers) {
      let dx = h.pos.x - d.x, dz = h.pos.z - d.z;
      const len0 = Math.hypot(dx, dz); if (len0 < 0.9) continue;
      dx /= len0; dz /= len0;
      const k = Math.min(Math.abs(dx) > 1e-4 ? hw / Math.abs(dx) : 1e9, Math.abs(dz) > 1e-4 ? hd / Math.abs(dz) : 1e9);
      const a = { x: d.x + dx * k, z: d.z + dz * k };
      const b = { x: h.pos.x - dx * 0.32, z: h.pos.z - dz * 0.32 };
      const L = Math.hypot(b.x - a.x, b.z - a.z); if (L < 0.4) continue;
      // control point: perpendicular to the chord, on the side away from the desk centre
      let px = -(b.z - a.z) / L, pz = (b.x - a.x) / L;
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if ((mx - d.x) * px + (mz - d.z) * pz < 0) { px = -px; pz = -pz; }
      const bow = Math.min(0.9, 0.2 * L);
      const c = { x: mx + px * bow, z: mz + pz * bow };
      const pts = []; const n = Math.max(8, Math.ceil(L * 1.3 / STEP));
      for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        pts.push(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.z + 2 * u * t * c.z + t * t * b.z);
      }
      const cum = [0]; for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
      const at = this.pulses.get(h.id);
      team.arcs.push({ h, pts, cum, total: cum[n], pulse: at ? envelope(now - at) : 0, style: h.linkStyleFor?.(lead) || 'solid' });
    }
    this.fillRibbon(team);
  }

  fillRibbon(team) {
    const geo = team.ribbon.geometry, pos = geo.attributes.position.array, rgba = geo.attributes.color.array, col = team.col;
    let v = 0;
    const quad = (x0, z0, x1, z1, w, alpha) => {
      if (v + 6 > MAX_SEG * 6) return;
      const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1, nx = -dz / l * w / 2, nz = dx / l * w / 2;
      const P = [[x0 + nx, z0 + nz], [x0 - nx, z0 - nz], [x1 + nx, z1 + nz], [x1 + nx, z1 + nz], [x0 - nx, z0 - nz], [x1 - nx, z1 - nz]];
      for (const [x, z] of P) {
        pos[v * 3] = x; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = z;
        rgba[v * 4] = col.r; rgba[v * 4 + 1] = col.g; rgba[v * 4 + 2] = col.b; rgba[v * 4 + 3] = alpha; v++;
      }
    };
    const base = team.emph > 0 ? FOCUS_ALPHA : team.emph < 0 ? DIM_ALPHA : BASE_ALPHA;
    const width = team.emph > 0 ? WIDTH * FOCUS_WIDTH : WIDTH;
    for (const arc of team.arcs) {
      const { pts, cum, total, pulse, style } = arc;
      const w = width * (1 + pulse * 0.9);
      const n = cum.length - 1;
      // the line style: solid (declared / structural), dashed (artifact) or dotted (inferred), as gaps along the arc
      const on = style === 'dashed' ? DASH : style === 'dotted' ? DOT : 0, period = style === 'dashed' ? DASH + GAP : DOT + DOT_GAP;
      const lineAlpha = on ? base : base * SOLID_K;
      for (let i = 0; i < n; i++) {
        const s = (cum[i] + cum[i + 1]) / 2;
        const inDash = !on || (s % period) < on;
        const ends = Math.min(1, s / 0.25, (total - s) / 0.25); // soft ends
        let alpha = inDash ? lineAlpha : 0;
        if (pulse > 0) alpha = Math.max(alpha, 0.9 * pulse); // solid while it flashes
        alpha *= Math.max(0, ends);
        if (alpha < 0.01) continue;
        quad(pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3], w, alpha);
      }
    }
    geo.setDrawRange(0, v);
    geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
  }

  /** dots flow from the lead toward each helper that is really working right now */
  updateDots(team) {
    const geo = team.dots.geometry, pos = geo.attributes.position.array, rgba = geo.attributes.color.array, col = team.col;
    let n = 0;
    const da = team.emph > 0 ? 0.95 : team.emph < 0 ? 0.4 : 0.75;
    for (const arc of team.arcs) {
      if (arc.h.done || arc.h.agent.status !== 'working' || arc.style === 'dotted') continue; // an inferred link never shows traffic
      const speed = 0.55; // m/s along the arc
      for (let k = 0; k < DOTS && n < 64; k++) {
        const s = ((this.t * speed + k * arc.total / DOTS + (arc.h.look?.seed ?? 0) * 3) % arc.total);
        // find the sample segment for arc length s
        const cum = arc.cum; let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
        const f = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        const x = arc.pts[(i - 1) * 2] + (arc.pts[i * 2] - arc.pts[(i - 1) * 2]) * f;
        const z = arc.pts[(i - 1) * 2 + 1] + (arc.pts[i * 2 + 1] - arc.pts[(i - 1) * 2 + 1]) * f;
        pos[n * 3] = x; pos[n * 3 + 1] = 0; pos[n * 3 + 2] = z;
        rgba[n * 4] = col.r; rgba[n * 4 + 1] = col.g; rgba[n * 4 + 2] = col.b; rgba[n * 4 + 3] = da * Math.sin(Math.PI * s / arc.total);
        n++;
      }
    }
    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
  }
}
