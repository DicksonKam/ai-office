import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OfficeManager } from './agents.js';
import { dimVariantOf } from './ghost.js';
import { FLOOR_H, SLAB, NIGHT, officeClock } from './office.js';
import { sunPosition, skyDir, moonDir, lightAt, sunStrength } from './sun.js';
import { setBuilding } from './lightshader.js';
import { Overlay } from './bubbles.js';
import { VENDOR, ROLE, NAMES, hash } from './palette.js';
import { waitingOnJob, jobSummary } from './jobs.js';
import { startDemo, startCrowdDemo } from './demo.js';
import { Director, LAYOUT } from './director.js';
import { stage } from './stage.js';
import { createPlayer } from './player.js';
import { teamsOf } from './film.js';
import { startAway } from './away.js';
import { createAlerts } from './app/notify.js';
import { planHud, SECONDARY } from './hudfit.js';
import { createQualityStepper } from './autoquality.js';

const canvas = document.getElementById('scene');
// the public copy of the demo (scripts/build-pages.mjs marks it): no server behind it, and strangers' machines in front of it
const hosted = !!document.querySelector('meta[name="ai-office-hosted"]');
if (!document.createElement('canvas').getContext('webgl2')) {
  const box = document.createElement('div'); box.className = 'nogl';
  box.innerHTML = `<p>The office is drawn with WebGL 2, which this browser has turned off or does not have.</p>${hosted ? '<img src="office.webp" alt="Workers walking into the office and sitting down at their desks">' : ''}`;
  document.body.appendChild(box);
  throw new Error('no WebGL 2');
}
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
const CAM_DIR = new THREE.Vector3(1, 1.32, 1).normalize(); // ~43° elevation: rows spread apart, bubbles flatten

// lights. The sun moves with the clock and is kept out by the building, except through its openings (openings.js). The room
// light never moves: it keeps the furniture's own shadows on a floor the sun no longer reaches, and its shadow map holds the
// active floor alone, drawn only when something there changes, so it costs next to nothing and casts nothing outdoors.
const hemi = new THREE.HemisphereLight(0xdfeeff, 0xffe3c4, 0.75); scene.add(hemi);
const massMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const shadowLight = (color, intensity, shade) => {
  const L = new THREE.DirectionalLight(color, intensity);
  L.castShadow = true; L.shadow.intensity = shade; L.shadow.mapSize.set(2048, 2048); L.shadow.bias = -0.0004; L.shadow.normalBias = 0.03; L.shadow.radius = 5; L.shadow.blurSamples = 12;
  scene.add(L, L.target); return L;
};
const sun = shadowLight(0xfff1dd, 1, 0.85), room = shadowLight(0xfff4e6, 1.3, 0.8);
// the public demo gives up detail, least-missed first, if the visitor's machine is struggling (the local office never does)
const pixelSteps = [1.5, 1, 0.75].filter(r => r < renderer.getPixelRatio()).map(r => () => renderer.setPixelRatio(r));
const quality = hosted ? createQualityStepper({ steps: [...pixelSteps.slice(0, -1), () => { sun.castShadow = room.castShadow = false; }, ...pixelSteps.slice(-1)] }) : null;
sun.shadow.radius = 3; sun.shadow.blurSamples = 8;
room.shadow.radius = 3; room.shadow.blurSamples = 8;
room.shadow.autoUpdate = false;
// keeps the room light indoors: it stands in the room light's shadow map over everything outside the walls, and nowhere else
const parasol = new THREE.Mesh(new THREE.BufferGeometry(), massMat);
parasol.castShadow = true; parasol.visible = false; parasol.frustumCulled = false; scene.add(parasol);
// the rest of the building, for the sun: the floors below and above the one in view throw their shadow on the lawn
const massBelow = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), massMat), massAbove = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), massMat);
massBelow.castShadow = massAbove.castShadow = true; scene.add(massBelow, massAbove);
// fill from the camera side: warm by day so the cream walls stay cream, faint and cool at night
const fill = new THREE.DirectionalLight(0xfff0e2, 0.8); fill.position.set(8, 6, 10); scene.add(fill);
// night lighting: warm ceiling lights over the floor you are looking at, the entrance downlight and the street lamp
const interiorLights = Array.from({ length: 7 }, () => { const L = new THREE.PointLight(0xfff1e0, 0, 7, 2); L.visible = false; scene.add(L); return L; }); // one per ceiling light the floor plan lists; off (not just dark) by day
const porchLight = new THREE.PointLight(0xffd59a, 0, 6, 1.4); scene.add(porchLight);
const streetLight = new THREE.PointLight(0xffe2b0, 0, 9, 1.3); scene.add(streetLight);
function placeNightLights() {
  if (!mgrRef) return;
  const o = mgrRef.office, by = o.baseY || 0;
  interiorLights.forEach((L, i) => { const p = o.ceilingLights[i]; L.userData.placed = !!p; if (p) L.position.set(p.x, by + 2.85, p.z); });
  const g = mgrRef.ground; if (g?.door) porchLight.position.set(g.door.x - 0.7, 2.1, g.door.z);
  if (mgrRef.site?.lampPos) streetLight.position.copy(mgrRef.site.lampPos);
}

let fullView = null, viewTarget = null, viewNow = null, mgrRef = null;
const camInv = new THREE.Matrix4();
function camBounds(points, padX = 0.6, padTop = 1.2, padBottom = 0.6) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const p = new THREE.Vector3();
  for (const [x, y, z] of points) { p.set(x, y, z).applyMatrix4(camInv); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padBottom, maxY: maxY + padTop };
}
function toFrustum(b) {
  const W = window.innerWidth, H = window.innerHeight;
  // on a tall screen the stacked status card and pills cover the top of the frame: fit the office into what is left
  const cssPx = name => parseFloat(document.documentElement.style.getPropertyValue(name)) || 0;
  const hud = W / H < 0.8 ? Math.min(H * 0.4, cssPx('--hud-h')) : 0;
  const tl = Math.min(H * 0.45, cssPx('--tl-h')); // the Today drawer covers the bottom while open: fit above it
  // the Teams panel covers the right-hand column while open on a wide screen: fit the office into what is left of it
  const rp = document.getElementById('roster'), rr = rp?.classList.contains('on') && W / H >= 0.8 ? rp.getBoundingClientRect() : null;
  const side = rr && rr.height > H * 0.4 ? Math.min(W * 0.35, Math.max(0, W - rr.left + 8)) : 0;
  const free = Math.max(H * 0.4, H - hud - tl), freeW = W - side, aspect = freeW / free;
  let w = b.maxX - b.minX, h = b.maxY - b.minY;
  if (w / h > aspect) h = w / aspect; else w = h * aspect;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, above = h * hud / free, below = h * tl / free, beside = w * side / freeW;
  return { left: cx - w / 2, right: cx + w / 2 + beside, top: cy + h / 2 + above, bottom: cy - h / 2 - below };
}
function fitCamera(office, immediate = true) {
  const by = office.baseY || 0;
  const target = new THREE.Vector3(0, 0.7, 0);
  camera.position.copy(target).addScaledVector(CAM_DIR, 80); camera.lookAt(target); camera.updateMatrixWorld();
  camera.near = 0.1; camera.far = 300;
  camInv.copy(camera.matrixWorldInverse);
  const pts = [];
  // the west bound reaches the arrival: porch, path, bench and sign
  for (const x of [-office.hx - 5.0, office.hx + 0.3]) for (const y of [by - 0.3, by + 3.4]) for (const z of [-office.hz - 0.3, office.hz + 0.3]) pts.push([x, y, z]);
  fullView = toFrustum(camBounds(pts, 0.6, 1.8, 1.2));
  if (!viewNow) { viewNow = { ...fullView }; applyFrustum(viewNow); }
  placeLights(office);
  retarget(immediate);
}
function applyFrustum(f) { camera.left = f.left; camera.right = f.right; camera.top = f.top; camera.bottom = f.bottom; camera.updateProjectionMatrix(); }

// Auto-framing: frame the occupied part of the office (fixed angle, smooth zoom / pan); never zoom out past the room.
let autoZoom = false, focus = null; // focus = { pts: [...], until }
function retarget(immediate = false) {
  const office = mgrRef?.office; if (!office || !fullView) return;
  let f;
  if (debugView.zoom !== 1) {
    const fp = new THREE.Vector3(debugView.x, (office.baseY || 0) + 0.8, debugView.z).applyMatrix4(camInv);
    const w = (fullView.right - fullView.left) / debugView.zoom, h = (fullView.top - fullView.bottom) / debugView.zoom;
    f = { left: fp.x - w / 2, right: fp.x + w / 2, top: fp.y + h / 2, bottom: fp.y - h / 2 };
  } else {
    let pts = null;
    if (focus && performance.now() < focus.until) pts = focus.pts();
    else if (autoZoom) {
      pts = [];
      const by = office.baseY || 0;
      for (const w of mgrRef.list) {
        if (w.done || w.floor !== mgrRef.activeFloor) continue;
        if (mgrRef.site && w.floor === 0 && w.pos.x < -office.hx - 3.2) continue; // still out on the path
        pts.push([w.pos.x, by, w.pos.z], [w.pos.x, by + 2.2, w.pos.z]);
        const pod = w.desk || w.slot?.pod || w.reviewing || w.lead?.desk;
        if (pod && pod.floor === w.floor && w.state !== 'walk') for (const dx of [-2.2, 2.2]) for (const dz of [-2.1, 2.1]) pts.push([pod.cellX + dx, by, pod.cellZ + dz], [pod.cellX + dx, by + 1.2, pod.cellZ + dz]);
        if (w.state === 'walk' && office.door && w.pos.x < office.door.x + 2) pts.push([office.door.outside.x - 1, by, office.door.z], [office.door.x, by + 2.4, office.door.z]);
      }
      if (!pts.length) pts = null;
    }
    if (pts) {
      const b = camBounds(pts, 1.0, 2.0, 0.8);
      f = toFrustum(b);
      // do not zoom in absurdly close, and never out past the whole room
      const minW = (fullView.right - fullView.left) * 0.42;
      if (f.right - f.left < minW) { const c = (f.left + f.right) / 2, cy = (f.top + f.bottom) / 2, h = minW / (window.innerWidth / window.innerHeight); f = { left: c - minW / 2, right: c + minW / 2, top: cy + h / 2, bottom: cy - h / 2 }; }
      const w = f.right - f.left, h = f.top - f.bottom;
      if (w >= fullView.right - fullView.left) f = { ...fullView };
      else {
        // keep inside the full view
        if (f.left < fullView.left) { f.left = fullView.left; f.right = f.left + w; }
        if (f.right > fullView.right) { f.right = fullView.right; f.left = f.right - w; }
        if (f.bottom < fullView.bottom) { f.bottom = fullView.bottom; f.top = f.bottom + h; }
        if (f.top > fullView.top) { f.top = fullView.top; f.bottom = f.top - h; }
      }
    } else f = { ...fullView };
  }
  viewTarget = f;
  if (immediate) { viewNow = { ...f }; applyFrustum(viewNow); }
}
function easeCamera(dt) {
  if (!viewTarget || !viewNow) return;
  const k = Math.min(1, dt * 1.6);
  let moved = false;
  for (const key of ['left', 'right', 'top', 'bottom']) { const d = viewTarget[key] - viewNow[key]; if (Math.abs(d) > 1e-4) { viewNow[key] += d * k; moved = true; } }
  if (moved) applyFrustum(viewNow);
}
function focusOn(ptsFn, seconds = 12) { focus = { pts: ptsFn, until: performance.now() + seconds * 1000 }; retarget(); }

const _q = new URLSearchParams(location.search); // the URL query, parsed once
const debugView = { zoom: Number(_q.get('zoom')) || 1, x: Number((_q.get('focus') || '0,0').split(',')[0]) || 0, z: Number((_q.get('focus') || '0,0').split(',')[1]) || 0 };
const overlay = new Overlay(document.getElementById('overlay'), showCard, w => { lookAtWorker(w); showCard(w); });
let needDaylight = true;
const ROOM_REDRAW_MS = 20000, ROOM_FRUSTUM = 44, PARASOL_Y = 1.3;
let parasolFor = '';
const nowhere = new THREE.OrthographicCamera(-0.01, 0.01, 0.01, -0.01, 0.1, 0.2); nowhere.position.set(0, -500, 0); nowhere.updateMatrixWorld();
let lastDayKey = '', skyNow = { el: 60, az: 180 }, roomDirty = true, roomAt = 0;
const mgr = new OfficeManager(scene, m => { fitCamera(m.office); needDaylight = true; renderFloors(m); });
mgrRef = mgr; fitCamera(mgr.office); retarget(true); renderFloors(mgr);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  fitCamera(mgr.office);
}
window.addEventListener('resize', resize); resize();
window.addEventListener('office:drawer', () => fitCamera(mgr.office)); // the Today drawer opened, closed or changed height

// ---- time of day --------------------------------------------------------------
function lerpColor(a, b, t) { return new THREE.Color(a).lerp(new THREE.Color(b), t); }
function daylight(el, pm) {
  const { a, b, t } = lightAt(el, pm), mix = (k, i = 0) => lerpColor(a[k][i], b[k][i], t), level = k => THREE.MathUtils.lerp(a[k][a[k].length - 1], b[k][b[k].length - 1], t);
  return {
    skyTop: mix('sky', 0).getStyle(), skyBottom: mix('sky', 1).getStyle(),
    hemiSky: mix('hemi', 0), hemiGround: mix('hemi', 1), hemiI: level('hemi'),
    sunC: mix('sun'), sunI: level('sun'), roomC: mix('room'), roomI: level('room'), fillC: mix('fill'), fillI: level('fill'),
    glass: lerpColor(a.glass, b.glass, t), lamps: THREE.MathUtils.lerp(a.lamps, b.lamps, t),
  };
}
/** the sun's light covers the active floor and what stands around it; the moon takes over at the changeover, when the light is off */
function aimSun(office) {
  const by = office.baseY || 0, dir = skyNow.el > -1 ? skyDir(Math.max(skyNow.el, 3), skyNow.az) : moonDir(skyNow.el, skyNow.az);
  sun.position.set(dir[0] * 60, by + dir[1] * 60, dir[2] * 60); sun.target.position.set(0, by, 0);
  sun.target.updateMatrixWorld();
}
function placeLights(office) {
  setBuilding(office);
  const by = office.baseY || 0, r = Math.max(office.W, office.D) * 0.8;
  const frame = (L, half, far) => { const c = L.shadow.camera; c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.near = 1; c.far = far; c.updateProjectionMatrix(); };
  frame(sun, r, 130); frame(room, ROOM_FRUSTUM, 60);
  room.position.set(-office.hx * 0.5, by + 18, -office.hz * 0.4); room.target.position.set(0, by, 0); room.target.updateMatrixWorld();
  if (parasolFor !== office.W + 'x' + office.D) { // low over the ground, its hole set back along the light so the light lands on the floor
    parasolFor = office.W + 'x' + office.D;
    const hx = office.hx, hz = office.hz, sx = -hx * 0.5 * PARASOL_Y / 18, sz = -hz * 0.4 * PARASOL_Y / 18, far = 120;
    const x0 = -hx + sx, x1 = hx + sx, z0 = -hz + sz, z1 = hz + sz;
    const leaf = (a, b, c, d) => { const g = new THREE.BoxGeometry(b - a, 0.1, d - c); g.translate((a + b) / 2, 0, (c + d) / 2); return g; };
    parasol.geometry.dispose();
    parasol.geometry = mergeGeometries([leaf(-far, far, -far, z0), leaf(-far, far, z1, far), leaf(-far, x0, z0, z1), leaf(x1, far, z0, z1)], false);
  }
  parasol.position.y = by + PARASOL_Y; parasol.updateMatrixWorld();
  aimSun(office);
  const top = (mgrRef?.floors.length ?? 1) * FLOOR_H - SLAB;
  const stack = (m, y0, y1) => { m.visible = y1 > y0; if (m.visible) { m.position.set(0, (y0 + y1) / 2, 0); m.scale.set(office.W, y1 - y0, office.D); } };
  stack(massBelow, 0, by); stack(massAbove, by + FLOOR_H - SLAB, top);
  roomDirty = true;
}
/** draw the room light's shadow map from the active floor alone: no sun-proofing, no people (they have contact shadows), no garden */
function drawRoomShadow(now) {
  const active = mgr.floors[mgr.activeFloor]; if (!active) return;
  roomDirty = false; roomAt = now;
  const hidden = scene.children.filter(o => !o.isLight && o !== active.group && o.visible);
  for (const o of hidden) o.visible = false;
  active.shell.visible = false; parasol.visible = true;
  room.shadow.needsUpdate = true; sun.shadow.autoUpdate = false;
  renderer.render(scene, nowhere); // the shadow pass runs inside a render; this camera sees nothing, and the real render clears it next
  sun.shadow.autoUpdate = true;
  active.shell.visible = true; parasol.visible = false;
  for (const o of hidden) o.visible = true;
}
// ?timelapse plays a whole day in a minute (?timelapse=30 in 30 s) in this tab only, from 05:00 or from ?hour; ?date picks the day
const TIMELAPSE_S = _q.has('timelapse') ? (Number(_q.get('timelapse')) || 60) : 0;
let timelapseEl = null;
function timelapseLabel(d) {
  if (!timelapseEl) {
    timelapseEl = document.createElement('div');
    timelapseEl.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:50;padding:6px 14px;border-radius:999px;font:600 15px/1.3 ui-monospace,Menlo,monospace;background:rgba(251,248,242,.92);color:#3f3a4a;box-shadow:0 2px 8px rgba(0,0,0,.14);pointer-events:none';
    document.body.appendChild(timelapseEl);
  }
  const text = `${pad2(d.getHours())}:${pad2(d.getMinutes())} · ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
  if (timelapseEl.textContent !== text) timelapseEl.textContent = text;
}
function clockNow() {
  if (stage.film != null) return new Date(stage.film); // a film's own moment: its sun, its clocks
  const d = new Date();
  if (_q.has('date')) { const [y, m, day] = _q.get('date').split('-').map(Number); if (y && m && day) d.setFullYear(y, m - 1, day); }
  if (TIMELAPSE_S) {
    const from = _q.has('hour') ? Number(_q.get('hour')) : 5, h = (from + performance.now() / 1000 / TIMELAPSE_S * 24) % 24;
    d.setHours(Math.floor(h), Math.floor(h % 1 * 60), Math.floor(h * 3600 % 60), 0);
    timelapseLabel(d);
    return d;
  }
  if (_q.has('hour')) { const h = Number(_q.get('hour')); d.setHours(Math.floor(h), Math.round((h - Math.floor(h)) * 60), 0, 0); }
  return d;
}
officeClock.now = clockNow;
let sitePlace; // from the server; until then, and in a demo, sun.js's own default
function applyDaylight(force = false) {
  const now = clockNow(), key = String(Math.floor(now.getTime() / 3600)); // about every 3.6 s: small enough that nothing is seen to step
  if (!force && key === lastDayKey) return; lastDayKey = key;
  skyNow = sunPosition(now, sitePlace);
  const p = daylight(skyNow.el, skyNow.pm);
  document.documentElement.style.setProperty('--sky-top', p.skyTop);
  document.documentElement.style.setProperty('--sky-bottom', p.skyBottom);
  hemi.color.copy(p.hemiSky); hemi.groundColor.copy(p.hemiGround); hemi.intensity = p.hemiI;
  sun.color.copy(p.sunC); sun.intensity = sunStrength(skyNow.el, p.sunI);
  room.color.copy(p.roomC); room.intensity = p.roomI;
  fill.color.copy(p.fillC); fill.intensity = p.fillI;
  if (mgrRef) aimSun(mgrRef.office);
  for (const m of mgr.site?.lampMats || []) m.emissiveIntensity = p.lamps * 1.6;
  mgr.site?.setNight?.(p.lamps); // ground glows of lamps and bollards, window spill on the lawn
  NIGHT.lamps = p.lamps;
  placeNightLights();
  for (const L of interiorLights) { L.intensity = p.lamps * 16; L.visible = !!L.userData.placed && p.lamps > 0.02; } // a light that is off costs nothing
  porchLight.intensity = p.lamps * 6; streetLight.intensity = p.lamps * 9;
  for (const office of mgr.floors) {
    if (office.level > mgr.activeFloor) continue; // ghosted floors keep their ghost materials untouched
    for (const w of office.windows) w.material.color.copy(p.glass);
    for (const m of office.lamps || []) { m.emissiveIntensity = p.lamps * 1.2; const dv = dimVariantOf(m); if (dv) dv.emissiveIntensity = p.lamps * 1.2 * 0.3; } // a dimmed floor draws the dim copy: light that too, or the porch light freezes at the look it had when first dimmed
  }
}

// ---- HUD / card -------------------------------------------------------------------
// The worker card: who they are, a strip of their day (timeline.js agentDay, from data the timeline already holds: no
// fetch), status, time in the office, project, team (chips that jump to that person), what is in their head and their
// last few real actions (agents.js history). refreshCard runs on the 1 s HUD tick; each part touches the DOM only when
// its text or markup changed, so an open card costs nothing per frame.
const $ = id => document.getElementById(id);
let selected = null, timelineMod = null, firstSnapAt = 0; // firstSnapAt: when the first snapshot arrived (who was already in)
const cardHtml = new Map(); // element id -> the markup last written into it
function setHtml(id, html) { if (cardHtml.get(id) === html) return; cardHtml.set(id, html); $(id).innerHTML = html; }
function setText(id, text) { const el = $(id); if (el.textContent !== text) el.textContent = text; }
const pad2 = n => String(n).padStart(2, '0');
const hhmm = t => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
function durText(ms) {
  const m = Math.max(0, Math.round(ms / 60000)); if (m < 1) return '<1 min'; if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`;
}
function ago(t, now) {
  const s = (now - t) / 1000; if (s < 45) return 'just now';
  const m = Math.max(1, Math.round(s / 60)); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}
/** a time today as 09:12, on another day as "Mon 22:10" */
function whenText(t) { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? hhmm(t) : `${d.toLocaleDateString([], { weekday: 'short' })} ${hhmm(t)}`; }
/** a project path for the card: the home folder as ~, a long one as …/last/two (the full path stays in the tooltip) */
function shortPath(p) {
  const s = String(p || '').replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
  if (s.length <= 34) return s;
  const parts = s.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : s;
}
const STATE_DOT = { working: '#67c88b', idle: '#b9b3c4', asking: '#e2b35d' }; // the Key's dots
const STATE_WORDS = { working: 'working', idle: 'on a break', asking: 'waiting on you' };
const stateOf = w => (w.asksYou ? 'asking' : w.agent.status === 'working' ? 'working' : 'idle');
const SEG_WORDS = { work: 'Working', idle: 'On a break', ask: 'Waiting on you' };
const markCls = m => (m.k === 'report' ? 'rep' : m.k === 'verdict' ? ((m.outcome ?? 'allow') === 'allow' ? 'ok' : 'flag') : m.k === 'handoff' ? 'hand' : m.k === 'launch' ? 'launch' : 'spawn');
const MARK_WORDS = { rep: 'Report', ok: 'Approved', flag: 'Flagged', spawn: 'Called for help', hand: 'Handed over', launch: 'Started' };
// the card's "Messages": one glyph per confidence level (how surely the office knows a link happened)
const CONF_GLYPH = {
  declared: ['●', 'declared: a record names both parties'], structural: ['◆', 'structural: a spawn, a parent link or a launch'],
  artifact: ['◌', 'artifact: both touched the same file'], inferred: ['?', 'inferred: timing or a content echo only, a hint'],
};

function showCard(worker) {
  if (!worker || worker.done) return;
  if (selected !== worker) { cardHtml.clear(); $('card').scrollTop = 0; }
  selected = worker; $('card').hidden = false; refreshCard();
  mgr.threads?.focus?.(worker.lead || worker, 14); // light up their team's threads
}
function closeCard() {
  const card = $('card');
  if (card.contains(document.activeElement)) document.activeElement.blur(); // focus never left in a hidden card
  card.hidden = true; selected = null;
  mgr.threads?.focus?.(null); // done looking: the highlighted lines go with the card (hover still shows them)
}
/** the worker's own chat (Claude Desktop, Codex): the page names the agent, the server knows the link */
async function openChat(id) {
  const r = await fetch('api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  if (!r.ok) throw new Error(String(r.status));
}
/** what can be opened for a worker: live, its own; in a film, only someone still in the office now */
const openFor = a => (player.active ? liveSnap?.agents.find(x => x.id === a.id)?.open : a.open) || null;
$('cardOpen').addEventListener('click', async () => {
  const id = selected?.agent?.id, b = $('cardOpen'); if (!id) return;
  b.disabled = true; b.textContent = 'Opening…';
  try { await openChat(id); b.disabled = false; refreshCard(); }
  catch { b.textContent = 'Could not open it'; setTimeout(() => { b.disabled = false; refreshCard(); }, 1800); }
});
overlay.chat = {
  can: w => openFor(w.agent),
  async open(w, btn) {
    if (btn.disabled) return;
    btn.disabled = true; btn.classList.add('busy');
    try { await openChat(w.agent.id); btn.classList.remove('busy'); }
    catch { btn.classList.replace('busy', 'bad'); btn.title = 'Could not open it'; setTimeout(() => { btn.classList.remove('bad'); btn.title = openFor(w.agent)?.label || ''; }, 1800); }
    finally { btn.disabled = false; }
  },
};
function refreshCard() {
  const w = selected; if (!w || w.done) { closeCard(); return; }
  const a = w.agent, now = stage.wall();
  $('cardDot').style.setProperty('--c', VENDOR[w.look.vendorKey].css);
  setText('cardName', w.name);
  { const open = openFor(a);
    const b = $('cardOpen'); b.hidden = !open; if (open && !b.disabled) setText('cardOpen', open.label); }
  setText('cardHost', `${a.host}${a.kind === 'subagent' ? ' · helper' : a.kind === 'guardian' ? ' · reviewer' : ''}${mgr.floors.length > 1 ? ` · ${w.floor + 1}F` : ''}`);
  setText('cardTask', a.task || '—');
  const path = a.cwd || a.project || '';
  setText('cardProject', shortPath(path) || '—'); $('cardProject').title = path;
  const mins = a.idleSince ? Math.round((stage.wall() - a.idleSince) / 60000) : 0;
  // the same words as the header, the bubbles and the log: waiting on you, finished · your turn, working, on a break
  setText('cardStatus', a.asking ? (a.askTo ? `asking: ${w.askLine()}` : `waiting on you: ${a.asking}`) : w.isReady?.(stage.perf()) ? 'finished · your turn'
    : w.isHandedBack?.(stage.perf()) ? `finished · ${w.turnWords()}`
    : a.status === 'working' ? 'working' : waitingOnJob(a, now) ? jobWaitWords(a, now) : `on a break (${mins} min)`);
  setText('cardModel', a.model || '—');
  const day = timelineMod?.agentDay?.(w.id) || null;
  const since = inOfficeSince(w, day, now);
  setText('cardSince', since.before ? `since before ${whenText(since.t)} (page opened)` : `since ${whenText(since.t)} · ${durText(now - since.t)}`);
  renderTeam(w);
  setText('cardThought', a.thought ? a.thought.text : '—');
  renderDay(w, day);
  renderJobs(w, now);
  renderRecent(w, now);
  renderMsgs(w, now);
  // the newest recent action is what is in their head: one line, not two
  const newest = w.history?.[w.history.length - 1];
  const dup = !!(a.thought && newest && newest.text === String(a.thought.text ?? '').replace(/\s+/g, ' ').trim());
  $('cardThought').hidden = dup; $('cardThoughtDt').hidden = dup;
}
/** when they walked in: the start of their current run in today's journal; without it, when this page saw them walk
 *  in (someone already in when the page opened: their session's start if that was today, else "before" the page opened) */
function inOfficeSince(w, day, now) {
  const segs = day && !day.partial ? day.segs : [];
  let i = segs.length - 1;
  if (i >= 0 && segs[i].live) {
    while (i > 0 && segs[i - 1].to === segs[i].from) i--;
    return { t: segs[i].from };
  }
  const seen = now - (stage.perf() - w.enteredAt);
  if (!firstSnapAt || seen > firstSnapAt + 3000) return { t: seen };
  let started = Number(w.agent.startedAt) || 0;
  if (started && started < 1e12) started *= 1000; // seconds, from an older collector
  if (started && started <= seen && new Date(started).toDateString() === new Date(now).toDateString()) return { t: started };
  return { t: seen, before: true };
}
/** team: the line in words, then chips (a lead: everyone in the team; a helper or reviewer: the lead) that jump there */
function renderTeam(w) {
  const lead = w.lead;
  const team = lead ? [] : mgr.list.filter(x => x.lead === w && !x.done && !x.leaving)
    .sort((x, y) => (x.isReviewer - y.isReviewer) || x.name.localeCompare(y.name));
  // the team as it is now: helpers who have gone home no longer count, and a lead without helpers is still a lead
  const helpers = team.filter(x => x.isHelper && x.parent === w).length;
  setText('cardTeam', w.role === 'reviewer' ? (lead ? `reviewer (Guardian) for ${lead.name}'s team` : 'reviewer (Guardian)')
    : lead ? `${w.role} in ${lead.name}'s team`
    : helpers ? `lead of ${helpers} helper${helpers > 1 ? 's' : ''}`
    : w.role === 'lead' ? 'team lead · no helpers in right now' : 'works solo');
  // started by another chat, or started others: a relationship beside the team, shown in the same line
  const started = mgr.list.filter(x => x.starter === w && !x.done && !x.leaving), from = w.agent.startedBy;
  const words = [from ? `started by ${w.starter?.name || (from.task ? `“${from.task}”` : 'another chat')}` : '', started.length ? `started ${started.map(x => x.name).join(', ')}` : ''].filter(Boolean).join(' · ');
  if (words) setText('cardTeam', `${$('cardTeam').textContent === 'works solo' ? '' : `${$('cardTeam').textContent} · `}${words}`);
  const mates = [...(lead ? (lead.done ? [] : [lead]) : team), ...(w.starter ? [w.starter] : []), ...started];
  const MAX = 8;
  const chip = x => {
    const st = stateOf(x), glyph = x === lead ? '★ ' : x.isReviewer ? '✓ ' : x === w.starter || x.starter === w ? '↗ ' : x.parent !== w ? '↳ ' : '';
    const tip = `${x.name} · ${STATE_WORDS[st]}${mgr.floors.length > 1 ? ` · ${x.floor + 1}F` : ''} · click to look at them`;
    return `<button type="button" class="mate" data-id="${esc(x.id)}" style="--c:${VENDOR[x.look.vendorKey]?.css || '#9aa0b0'};--s:${STATE_DOT[st]}" title="${esc(tip)}">`
      + `<i class="sd"></i><span class="nm">${esc(glyph + x.name)}</span></button>`;
  };
  setHtml('cardMates', mates.slice(0, MAX).map(chip).join('') + (mates.length > MAX ? `<span class="mate more">+${mates.length - MAX}</span>` : ''));
}
/** today strip: working (vendor colour) / on a break (pale) / waiting on you (ink, mustard edge), event marks on top */
function renderDay(w, day) {
  const box = $('cardDay');
  if (!day || !day.segs.length) { box.hidden = true; return; }
  box.hidden = false;
  const span = Math.max(1, day.end - day.start);
  const pct = t => Math.max(0, Math.min(100, (t - day.start) / span * 100));
  let html = '';
  day.segs.forEach((s, i) => {
    const s0 = !(i && day.segs[i - 1].to === s.from), s1 = !(day.segs[i + 1] && day.segs[i + 1].from === s.to);
    const l = pct(s.from), wd = Math.max(0, pct(s.to) - l);
    const tip = `${SEG_WORDS[s.st]} · ${hhmm(s.from)}–${s.live ? 'now' : hhmm(s.to)} · ${durText(s.to - s.from)}${s.st === 'ask' && s.text ? ` · ${s.text}` : ''}`;
    html += `<i class="cs ${s.st}${s0 ? ' s0' : ''}${s1 ? ' s1' : ''}" style="left:${l.toFixed(2)}%;width:${wd.toFixed(2)}%" title="${esc(tip)}"></i>`;
  });
  for (const m of day.marks) {
    const c = markCls(m), to = (m.to ? mgr.workers.get(m.to)?.name : null) || m.toLabel || null;
    const word = c === 'spawn' && m.linkKind === 'brief' ? 'Briefed' : c === 'rep' && m.linkKind === 'reply' ? 'Reply' : MARK_WORDS[c];
    const tip = `${word}${m.by ? ` by ${m.by}` : to ? ` · ${to}` : ''} · ${hhmm(m.t)}${m.channel ? ` · via ${m.channel}` : ''}${m.text ? ` · ${String(m.text).slice(0, 120)}` : ''}`;
    html += `<b class="cm ${c}" style="left:${pct(m.t).toFixed(2)}%" title="${esc(tip)}"></b>`;
  }
  const strip = $('cardStrip'), work = durText(day.workMs);
  strip.style.setProperty('--c', VENDOR[w.look.vendorKey].css);
  strip.setAttribute('aria-label', `today: ${work} working`);
  setHtml('cardStrip', html);
  setText('cardDayFrom', hhmm(day.start));
  const first = day.first ?? day.segs[0].from;
  setHtml('cardDayMeta', `${day.partial ? 'seen since' : 'first seen'} <b>${hhmm(first)}</b> · <b>${work}</b> working today`);
  $('cardDayMeta').title = day.partial ? `what this page has seen since ${hhmm(day.since)}; open Today for the whole day` : '';
}
/** the last five real actions, newest first, with how long ago (rebuilt when the history changes, or every 15 s for
 *  the times) */
function renderRecent(w, now) {
  const h = w.history || [];
  $('cardRecentWrap').hidden = !h.length;
  if (!h.length) return;
  const key = `${w.id}|${w.historyV}|${Math.floor(now / 15000)}`;
  if (cardHtml.get('cardRecentKey') === key) return;
  cardHtml.set('cardRecentKey', key);
  setHtml('cardRecent', h.slice(-5).reverse().map(e => `<li class="k-${esc(e.kind)}"><span class="i" aria-hidden="true">${esc(e.icon)}</span>`
    + `<span class="x" title="${esc(e.text)}">${esc(e.text)}</span><time title="${hhmm(e.at)}">${ago(e.at, now)}</time></li>`).join(''));
}
/** "Messages": this agent's links today (agents.js Worker.links: briefs, messages, replies, hand-overs, approvals,
 *  launches, with either end), newest first, each with its channel and a confidence glyph; the Recent list stays as is */
function renderMsgs(w, now) {
  const L = w.links || [];
  $('cardMsgsWrap').hidden = !L.length;
  if (!L.length) return;
  const key = `${w.id}|${w.historyV}|${Math.floor(now / 15000)}`;
  if (cardHtml.get('cardMsgsKey') === key) return;
  cardHtml.set('cardMsgsKey', key);
  setHtml('cardMsgs', L.slice(-8).reverse().map(e => {
    const m = e.meta || {}, conf = CONF_GLYPH[m.confidence] ? m.confidence : 'structural', [glyph, tip] = CONF_GLYPH[conf];
    const ch = m.channel ? `<span class="ch" title="${esc(`channel: ${m.channel}`)}">${esc(m.channel)}</span>` : '<span class="ch none"></span>';
    return `<li class="k-${esc(e.kind)}"><span class="i" aria-hidden="true">${esc(e.icon)}</span><span class="x" title="${esc(e.text)}">${esc(e.text)}</span>`
      + `${ch}<span class="cf cf-${conf}" title="${esc(tip)}">${glyph}</span><time title="${hhmm(e.at)}">${ago(e.at, now)}</time></li>`;
  }).join(''));
}
$('cardClose').addEventListener('click', closeCard);
$('card').addEventListener('click', e => { // a team chip: look at that person and open their card
  const b = e.target.closest('button.mate'); if (!b) return;
  const x = mgr.workers.get(b.dataset.id); if (!x || x.done) return;
  lookAtWorker(x); showCard(x);
});

// ---- keyboard: Tab / Shift+Tab walks through the people on the floor you are looking at; Esc closes the card -------
// Only while nothing has focus (the page or the scene): a focused control, a field or an open popover keeps its Tab.
// Leads first, then by name; past either end the card closes and Tab carries on into the page's controls as usual.
const popoverOpen = () => ['keyPop', 'morePop', 'bellPop'].some(id => { const el = $(id); return el && !el.hidden; });
function floorPeople() {
  return mgr.list.filter(w => !w.done && !w.leaving && w.floor === mgr.activeFloor)
    .sort((x, y) => ((y.role === 'lead') - (x.role === 'lead')) || x.name.localeCompare(y.name) || String(x.id).localeCompare(String(y.id)));
}
window.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey || popoverOpen()) return;
  const f = document.activeElement;
  if (f && f !== document.body && f !== document.documentElement && f !== canvas) return;
  const people = floorPeople(); if (!people.length) return;
  const i = selected ? people.indexOf(selected) : -1;
  const j = i < 0 ? (e.shiftKey ? people.length - 1 : 0) : i + (e.shiftKey ? -1 : 1);
  if (j < 0 || j >= people.length) { closeCard(); return; }
  e.preventDefault();
  lookAtWorker(people[j]); showCard(people[j]);
});
// capture phase, so it runs before the Today drawer's own Esc: one layer per press (an open popover first, then the
// card, then the drawer)
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || $('card').hidden || popoverOpen()) return;
  if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
  closeCard(); e.stopPropagation();
}, true);

// ---- floors -----------------------------------------------------------------------
function renderFloors(m) {
  const el = document.getElementById('floors'); if (!el) return;
  const counts = m.floorCounts();
  const asks = m.floors.map(() => 0);
  for (const w of m.workers.values()) if (!w.done && w.asksYou && asks[w.floor] !== undefined) asks[w.floor]++;
  const html = m.floors.map((f, k) => `<button class="pill floor ${k === m.activeFloor ? 'on' : ''}" data-floor="${k}" title="${k === 0 ? 'ground floor' : `floor ${k + 1}`}${counts[k] ? ` · ${counts[k]} in` : ''}${asks[k] ? ` · ${asks[k]} waiting on you` : ''}">${k + 1}F${counts[k] ? ` <span class="n">${counts[k]}</span>` : ''}${asks[k] ? ` <span class="ask" title="${asks[k]} waiting">🙋${asks[k] > 1 ? ` ${asks[k]}` : ''}</span>` : ''}</button>`).join(''); // compact: only the asking badge stays, as an amber dot (style.css)
  if (el.innerHTML !== html) el.innerHTML = html;
  el.hidden = m.floors.length < 2;
}
$('floors').addEventListener('click', e => { const b = e.target.closest('[data-floor]'); if (!b) return; focus = null; mgr.setActiveFloor(Number(b.dataset.floor)); fitCamera(mgr.office); retarget(true); });
window.addEventListener('keydown', e => { // like the floor pills: a floor switch drops any focus on a person or a team
  if (e.metaKey || e.ctrlKey || e.altKey || e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
  const d = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0; if (!d) return;
  focus = null; mgr.setActiveFloor(mgr.activeFloor + d); fitCamera(mgr.office); retarget(true);
});

// a toggle pill: highlight and aria-pressed together, wherever it sits (the row or the ⋯ menu)
function setPressed(btn, on) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); if (btn.parentNode?.id === 'morePop') syncMore(); }

// ---- auto zoom toggle ---------------------------------------------------------------
try { const z = localStorage.getItem('ai-office-autozoom-v2'); if (z !== null) autoZoom = z !== '0'; } catch { /* ignore */ } // off unless you turn it on (a new key: the old one saved the days when it was on by default)
setPressed($('zoomToggle'), autoZoom);
function setAutoZoom(v) { // the pill and a double-click on the scene: same toggle, same saved state
  autoZoom = v; focus = null; setPressed($('zoomToggle'), autoZoom);
  try { localStorage.setItem('ai-office-autozoom-v2', autoZoom ? '1' : '0'); } catch { /* ignore */ }
  retarget();
}
$('zoomToggle').addEventListener('click', () => setAutoZoom(!autoZoom));
canvas.addEventListener('dblclick', () => setAutoZoom(!autoZoom));

// ---- roster -----------------------------------------------------------------------
const rosterEl = $('roster');
// toggling the panel refits the camera: the frame makes room for it, or takes the space back
$('rosterToggle').addEventListener('click', () => { rosterEl.classList.toggle('on'); setPressed($('rosterToggle'), rosterEl.classList.contains('on')); fitCamera(mgr.office, false); try { localStorage.setItem('ai-office-roster', rosterEl.classList.contains('on') ? '1' : '0'); } catch { /* ignore */ } });
try { if (localStorage.getItem('ai-office-roster') !== '0' && window.innerWidth > 1000) { rosterEl.classList.add('on'); setPressed($('rosterToggle'), true); } } catch { /* ignore */ }
// the panel grows as teams arrive: once it covers the column (or stops covering it), the frame eases to make room
if (typeof ResizeObserver === 'function') {
  let covers = null;
  new ResizeObserver(() => {
    const now = rosterEl.classList.contains('on') && rosterEl.getBoundingClientRect().height > window.innerHeight * 0.4;
    if (now !== covers) { const first = covers === null; covers = now; if (!first) fitCamera(mgr.office, false); }
  }).observe(rosterEl);
}
const clockAt = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const dayClock = (t, now) => { const d = new Date(t), n = new Date(now); return d.toDateString() === n.toDateString() ? clockAt(t) : `${d.toLocaleDateString([], { weekday: 'short' })} ${clockAt(t)}`; };
const SAID = { done: ['✓', 'finished'], failed: ['⚠', 'failed'], stopped: ['■', 'stopped'], unknown: ['?', 'no word on how it ended'] };
/** what their status says while their turn is over but something they started is still going */
function jobWaitWords(a, now) {
  const { running, nextAt } = jobSummary(a, now);
  return running ? `waiting on ${running > 1 ? `${running} jobs` : 'a job'}` : `waiting for a timer at ${clockAt(nextAt)}`;
}
function jobLine(j, now) {
  if (j.kind === 'schedule') return { i: '⏱', k: 'schedule', x: j.label, when: j.nextAt ? `${j.approx ? 'about ' : ''}${dayClock(j.nextAt, now)}` : 'no next time' };
  if (j.kind === 'timer') return { i: '⏱', k: 'timer', x: j.label, when: j.nextAt ? dayClock(j.nextAt, now) : '' };
  if (j.state === 'running') return { i: '⚙', k: 'running', x: j.label, when: j.startedAt ? durText(now - j.startedAt) : 'running' };
  const [i, word] = SAID[j.state] || SAID.unknown;
  return { i, k: j.state, x: `${j.label} · ${word}`, when: j.endedAt ? clockAt(j.endedAt) : '' };
}
function renderJobs(w, now) {
  const jobs = w.agent.jobs || [];
  $('cardJobsWrap').hidden = !jobs.length;
  setHtml('cardJobs', jobs.map(j => { const l = jobLine(j, now); return `<li class="k-${l.k}"><span class="i">${l.i}</span><span class="x" title="${esc(l.x)}">${esc(l.x)}</span><span class="t">${esc(l.when)}</span></li>`; }).join(''));
}
function renderNext(snap, now) {
  const list = (snap.schedules || []).slice(0, 4);
  $('rosterNext').hidden = !list.length;
  const name = s => { const w = s.owner && mgr.workers.get(s.owner); return w?.name ? `${esc(w.name)}: ` : ''; };
  setHtml('rosterNext', list.length ? `<div class="lab">Scheduled</div>${list.map(s => `<div class="s" title="${esc(s.label)}"><span class="t">${s.approx ? '~' : ''}${esc(dayClock(s.nextAt, now))}</span><span class="n">${name(s)}${esc(s.label)}</span></div>`).join('')}` : '');
}
function rosterRow(a, cls) {
  const w = mgr.workers.get(a.id);
  const role = ROLE[a.role] || ROLE.member;
  const name = w?.name || a.nickname || '…';
  const col = (VENDOR[a.vendor] || VENDOR.other).css;
  const mine = !!a.asking && !a.askTo; // waiting on you (an ask to the agent that gave the work is shown, not flagged)
  const task = a.asking ? (a.askTo && w ? w.askLine() : a.asking) : a.role === 'reviewer' ? (a.verdict ? `${a.verdict.outcome} · ${a.verdict.risk || ''} risk` : 'reviewing') : (a.task || '');
  const fl = (cls === '' && mgr.floors.length > 1 && w) ? `<span class="chip fl">${w.floor + 1}F</span>` : '';
  const st = mine ? 'asking' : a.status === 'working' ? 'working' : 'idle';
  // waiting on you: 🙋 and the question instead of the task (style.css styles .row.asking; the inline amber dot is the fallback)
  const ask = mine ? '<span class="ask" title="waiting on you" aria-label="waiting on you">🙋</span>' : '';
  const st8r = w?.starter ? `<span class="chip from" title="started by ${esc(w.starter.name)}">↗ ${esc(w.starter.name)}</span>` : '';
  const js = jobSummary(a, stage.wall());
  const jb = js.failed ? '<span class="chip jb bad" title="a background job failed">⚠</span>' : js.running ? `<span class="chip jb" title="background jobs running">⚙ ${js.running}</span>` : js.nextAt ? `<span class="chip jb" title="a timer is set">⏱ ${clockAt(js.nextAt)}</span>` : '';
  return `<div class="row ${cls} ${st}" style="--c:${col}"><span class="dot"></span><span class="nm">${esc(name)}</span>${role.label ? `<span class="chip" style="--r:${role.css}">${role.label}</span>` : ''}${st8r}${jb}${fl}${ask}<span class="task" title="${esc(mine ? `waiting on you: ${task}` : task)}">${esc(task)}</span><span class="st"${mine ? ' style="background:#e2b35d"' : ''}></span></div>`;
}
function renderRoster(snap) {
  const byId = new Map(snap.agents.map(a => [a.id, a]));
  const teams = (snap.teams || []).map(t => ({ ...t, leadAgent: byId.get(t.lead) })).filter(t => t.leadAgent);
  teams.sort((x, y) => (y.members.length + y.reviewers.length) - (x.members.length + x.reviewers.length));
  const count = snap.agents.length ? `· ${snap.agents.length} in` : '';
  if ($('rosterCount').textContent !== count) $('rosterCount').textContent = count;
  const html = teams.map(t => {
    const rows = [rosterRow(t.leadAgent, '')];
    const members = t.members.map(id => byId.get(id)).filter(Boolean).sort((a, b) => (a.depth || 0) - (b.depth || 0));
    for (const m of members) rows.push(rosterRow(m, (m.depth || 1) >= 2 ? 'sub sub2' : 'sub'));
    for (const r of t.reviewers.map(id => byId.get(id)).filter(Boolean)) rows.push(rosterRow(r, 'sub'));
    return `<div class="team" data-team="${esc(t.id)}" title="click to look at this team">${rows.join('')}</div>`;
  }).join('') || '<div class="row"><span class="task">nobody in yet</span></div>';
  if (html !== rosterHtml) { rosterHtml = html; $('rosterBody').innerHTML = html; } // unchanged: keep the DOM (hover, a click in progress)
}
let rosterHtml = null;
$('rosterBody').addEventListener('click', e => {
  const team = e.target.closest('.team'); if (!team) return;
  const lead = mgr.workers.get(team.dataset.team); if (!lead) return;
  if (lead.floor !== mgr.activeFloor) { mgr.setActiveFloor(lead.floor); fitCamera(mgr.office); retarget(true); }
  focusOn(() => {
    const pts = [], by = mgr.office.baseY || 0;
    const members = mgr.list.filter(w => (w === lead || w.lead === lead) && w.floor === mgr.activeFloor);
    for (const w of members) pts.push([w.pos.x, by, w.pos.z], [w.pos.x, by + 2.2, w.pos.z]);
    const pod = lead.desk; if (pod) for (const dx of [-2.2, 2.2]) for (const dz of [-2.1, 2.1]) pts.push([pod.cellX + dx, by, pod.cellZ + dz], [pod.cellX + dx, by + 1.4, pod.cellZ + dz]);
    return pts;
  }, 14);
});
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let countHtml = null;
function updateHud(snapshot) {
  const agents = snapshot.agents;
  // exclusive counts that add up: waiting on you, then finished · your turn, then working, then on a break
  const readyIds = new Set((mgr.readyList?.() || []).map(w => w.id)); // sessions that finished and handed back to you (green desk flag)
  let asking = 0, ready = 0, working = 0, onBreak = 0, onJob = 0, runs = 0;
  const jobNow = stage.wall();
  for (const a of agents) {
    if (a.asking && !a.askTo) asking++; // asking the agent that gave the work: still working, not waiting on you
    else if (readyIds.has(a.id)) ready++;
    else if (a.status === 'working') working++;
    else if (waitingOnJob(a, jobNow)) onJob++;
    else onBreak++;
    runs += jobSummary(a, jobNow).running;
  }
  const teams = (snapshot.teams || []).filter(t => t.members.length).length;
  // each "· segment" in its own nowrap span: a narrow status card breaks the line between segments, never inside one
  const segs = [working || (!asking && !ready) ? `${working} working` : '', onBreak ? `${onBreak} on a break` : '', onJob ? `${onJob} waiting on a job` : '', runs ? `⚙ ${runs} job${runs > 1 ? 's' : ''} running` : '', teams ? `${teams} team${teams > 1 ? 's' : ''}` : '',
    mgr.floors.length > 1 ? `${mgr.floors.length} floors` : ''].filter(Boolean);
  const parts = segs.map((t, i) => `${i ? ' · ' : ''}<span class="seg">${t}</span>`).join('');
  const html = agents.length === 0 ? 'nobody in yet' : `${asking ? `<button class="ask" type="button" title="show who is waiting on you">🙋 ${asking} waiting on you</button>` : ''}${ready ? `<button class="ready" type="button" title="sessions that finished: your turn">✓ ${ready} ready for you</button>` : ''}${parts}`;
  // night: the name tags turn dark and translucent so they do not glare (style.css, body.night); a little hysteresis
  const lamps = NIGHT.lamps || 0, night = document.body.classList.contains('night');
  if (night ? lamps < 0.4 : lamps > 0.6) document.body.classList.toggle('night', !night);
  if (html !== countHtml) { countHtml = html; $('count').innerHTML = html; } // unchanged: keep the buttons (hover, a click in progress)
  $('empty').hidden = agents.length > 0;
}

// waiting on you: the header chip takes you to each asker in turn, on whatever floor they are
function lookAtWorker(w) {
  if (!w || w.done) return;
  if (w.floor !== mgr.activeFloor) { mgr.setActiveFloor(w.floor); fitCamera(mgr.office); retarget(true); renderFloors(mgr); }
  focusOn(() => {
    const by = mgr.office.baseY || 0;
    const pts = [[w.pos.x, by, w.pos.z], [w.pos.x, by + 2.2, w.pos.z]];
    for (const dx of [-2, 2]) for (const dz of [-2, 2]) pts.push([w.pos.x + dx, by, w.pos.z + dz]);
    return pts;
  }, 10);
}
let askTurn = 0;
let readyTurn = 0;
$('count').addEventListener('click', e => {
  if (e.target.closest('.ready')) { const r = mgr.readyList?.() || []; if (r.length) { const w = r[readyTurn++ % r.length]; lookAtWorker(w); showCard(w); } return; }
  if (!e.target.closest('.ask')) return;
  const askers = mgr.list.filter(w => !w.done && w.asksYou);
  if (!askers.length) return;
  const w = askers[askTurn++ % askers.length];
  lookAtWorker(w); showCard(w);
});

// ---- key (legend) -------------------------------------------------------------------
const keyBtn = $('keyToggle'), keyPop = $('keyPop');
function setKey(open) {
  if (open) { alerts?.closeMenu?.(); setMore(false); } // one popover at a time: the Key closes the alerts and ⋯ menus (and they close the Key)
  keyPop.hidden = !open; keyBtn.classList.toggle('on', open); keyBtn.setAttribute('aria-expanded', String(open));
}
keyBtn.addEventListener('click', e => { e.stopPropagation(); setKey(keyPop.hidden); });
document.addEventListener('click', e => { if (!keyPop.hidden && !e.target.closest('.keywrap')) setKey(false); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') setKey(false); });

// ---- ⋯ overflow menu: holds the folded secondary pills (the same elements, so ids, listeners and state carry over) ---
const moreBtn = $('moreToggle'), morePop = $('morePop');
function setMore(open) {
  if (open) { setKey(false); alerts?.closeMenu?.(); }
  if (!open && morePop.contains(document.activeElement)) moreBtn.focus({ preventScroll: true }); // focus never left in a closed menu
  morePop.hidden = !open; moreBtn.classList.toggle('on', open); moreBtn.setAttribute('aria-expanded', String(open));
}
moreBtn.addEventListener('click', e => {
  e.stopPropagation(); const open = morePop.hidden; setMore(open);
  if (open && e.detail === 0) morePop.querySelector('button')?.focus(); // opened from the keyboard: into the menu
});
document.addEventListener('click', e => { if (!morePop.hidden && e.target.isConnected && !e.target.closest('.morewrap')) setMore(false); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') setMore(false); });
// a toggle that is on while folded in the menu shows as a small dot on the ⋯ pill
function syncMore() { moreBtn.classList.toggle('lit', [...morePop.querySelectorAll('.pill.toggle')].some(b => b.classList.contains('on'))); }
morePop.addEventListener('click', syncMore); // runs after the pill's own handler (bubbling)

// ---- data -------------------------------------------------------------------------
const params = _q;
const isDemo = hosted || params.has('demo');
// dock badge, "(N)" in the title and the opt-in alerts bell (app/notify.js)
const alerts = createAlerts({
  demo: isDemo, force: params.has('notify'),
  nameOf: a => mgr.workers.get(a.id)?.name || a.nickname || 'An agent',
  jumpTo: id => { const w = mgr.workers.get(id); if (w && !w.done) { lookAtWorker(w); showCard(w); } },
  onMenuOpen: () => { setKey(false); setMore(false); },
});
let latest = null, localDirector = null, liveSnap = null;
const waitingIn = snap => (snap?.agents || []).filter(a => a.asking && !a.askTo).length;
// a film of the office (web/player.js): runs in this tab only, off to one side of the live office
let filmSelected = null, away = null;
const filmSource = isDemo ? () => import('./demofilm.js').then(m => m.demoDay()) : q => fetch(`api/film?${q}`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
const player = createPlayer({
  mgr,
  note: isDemo ? 'A made-up day, played back like your own would be.' : null,
  source: filmSource,
  config: () => liveSnap?.config || null,
  onEnter() {
    away?.hide(); setConn('◉', 'replay'); player.setWaiting(waitingIn(liveSnap)); },
  onCleared() {
    filmSelected = selected?.id ?? null;
    for (const id of [...overlay.items.keys()]) overlay.remove(id);
  },
  onRestaged() {
    if (!filmSelected) return;
    const w = mgr.workers.get(filmSelected);
    if (w && !w.done) { selected = w; refreshCard(); } else closeCard();
    filmSelected = null;
  },
  onShow(agents, t, plan, jumped) {
    latest = { agents, events: [], now: t, plan, teams: teamsOf(agents), schedules: [], config: liveSnap?.config };
    if (jumped) { updateHud(latest); renderRoster(latest); applyDaylight(true); renderFloors(mgr); }
  },
  onLeave() {
    setConn('●', isDemo ? 'demo' : 'live');
    latest = null; reprimeLog = true; needDaylight = true;
    if (liveSnap) onSnapshot(liveSnap);
  },
});
/** from Today or Week: that day on film, a few seconds before the moment clicked, with whoever's row it was in view */
async function watchMoment({ day, at = null, id = null }) {
  const ok = await player.open(`day=${day}`, { at: at == null ? null : at - 5000 });
  if (!ok || !id) return;
  const w = mgr.workers.get(id);
  if (w && !w.done) { lookAtWorker(w); showCard(w); }
}
away = startAway({ player, source: filmSource, enabled: !isDemo }); // back after a while: an offer of what you missed
$('filmToggle').addEventListener('click', () => { if (player.active) player.leave(); else player.open('day=today'); });
let prevStatus = new Map(); // id -> status from the previous snapshot (for the log diff)
let prevAsking = new Map(); // id -> what the agent is asking the user, if anything
let reprimeLog = false; // set on a reconnect: the first snapshot after it is a new baseline for the log diff
function onSnapshot(snap) {
  sitePlace = snap.config?.site || sitePlace;
  mgr.setConfig?.(snap.config); // finishedMinMs, leaveAfterIdleMs (defaults when missing)
  if (!firstSnapAt) firstSnapAt = Date.now();
  // the server's director runs the office; a tab only runs one for `?demo`, whose snapshots it makes up itself
  if (!snap.plan) snap.plan = (localDirector ??= new Director()).update(snap.agents, snap.events || [], Number(snap.now) || Date.now(), snap.config);
  liveSnap = snap;
  if (player.active) { alerts.update(snap); player.setWaiting(waitingIn(snap)); return; } // a film is on: the live office waits, its alerts do not
  mgr.schedules = snap.schedules || [];
  mgr.sync(snap.agents, snap.events || [], snap.now, snap.plan);
  renderNext(snap, Date.now());
  if (pendingJournal) { replayJournal(pendingJournal, snap); pendingJournal = null; }
  logFromSnapshot(snap, prevStatus, !reprimeLog); reprimeLog = false;
  prevStatus = new Map(snap.agents.map(a => [a.id, a.status]));
  prevAsking = new Map(snap.agents.map(a => [a.id, a.asking || null]));
  latest = snap; updateHud(snap); renderRoster(snap);
  alerts.update(snap);
}

// ---- office log: what really happened, newest first ---------------------------------
const LOG_MAX = 200; // a whole day restored from the journal fits
const log = []; const loggedEvents = new Map(); // event id -> its time (forgotten after an hour)
const EVENT_KEEP_MS = 60 * 60 * 1000;
const logEl = $('log'), logBody = $('logBody');
try { if (localStorage.getItem('ai-office-log') === '1') { logEl.classList.add('on'); setPressed($('logToggle'), true); } } catch { /* ignore */ }
$('logToggle').addEventListener('click', () => { logEl.classList.toggle('on'); setPressed($('logToggle'), logEl.classList.contains('on')); try { localStorage.setItem('ai-office-log', logEl.classList.contains('on') ? '1' : '0'); } catch { /* ignore */ } });
function nameOf(id, snap) { const w = mgr.workers.get(id); if (w) return w.name; const a = snap?.agents.find(a => a.id === id); return a?.nickname || 'someone'; }
function addLog(at, icon, html, cls = '', render = true) {
  log.unshift({ at, icon, html, cls });
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  if (render) renderLog();
}
// one wording for live snapshots and the replayed journal; names are raw strings, escaped here
function logLine(kind, d) {
  const b = s => `<b>${esc(s)}</b>`;
  switch (kind) {
    case 'arrived': return ['🚪', d.role === 'reviewer' ? `${b(d.name)} came to review ${d.lead ? `${b(d.lead)}'s work` : ''}` : d.lead ? `${b(d.name)} joined ${b(d.lead)}'s team · ${esc(d.task || '')}` : `${b(d.name)} walked in · ${esc(d.task || d.project || '')}`];
    case 'left': return ['👋', `${b(d.name)} left the office`];
    case 'asking': return d.to ? ['🙋', `${b(d.name)} is asking ${b(d.to)} · ${esc(d.text)}`] : ['🙋', `${b(d.name)} is waiting on you · ${esc(d.text)}`, 'event'];
    case 'handedBack': return ['↩', `${b(d.name)} finished · ${b(d.to)}'s turn`];
    case 'finished': return ['✅', `${b(d.name)} finished · your turn`];
    case 'idle': return ['☕', `${b(d.name)} is on a break`];
    case 'working': return ['⌨️', `${b(d.name)} is back at work`];
    case 'spawn': return ['📣', `${b(d.name)} called for help: ${esc(d.text || '')}`, 'event'];
    case 'message': return ['📨', `${b(d.name)} → ${b(d.to)}${d.text ? ` · ${esc(d.text)}` : ' · message'}`, 'event'];
    case 'report': return ['📝', `${b(d.name)} reported to ${b(d.to)}: “${esc(d.text || '')}”`, 'event'];
    case 'review': return ['🔍', `${b(d.name)} is reviewing ${b(d.to)}'s work`, 'event'];
    case 'verdict': { const ok = (d.outcome || 'allow') === 'allow'; return [ok ? '✅' : '⚠️', `${b(d.name)} ${ok ? 'approved' : 'flagged'} ${b(d.to)}'s work${d.risk ? ` · ${esc(d.risk)} risk` : ''}`, 'event']; }
    case 'handoff': return ['⇄', `${b(d.name)} handed over to ${b(d.to)}${d.text ? ` · ${esc(d.text)}` : ''}`, 'event'];
    case 'approval': return ['👍', `${b(d.name)} approved ${b(d.to)}${d.text ? ` · ${esc(d.text)}` : ''}`, 'event'];
    case 'launch': return ['▶', `${b(d.to)} was started by ${b(d.name)}`, 'event'];
    default: return null;
  }
}
/** a link end the office could not resolve shows its label instead of an id */
function endName(ev, side, nm) { return ev.stub?.side === side ? ev.stub.label : nm(ev[side]); }
function logAs(at, kind, d, render = true) { const l = logLine(kind, d); if (l) addLog(at, l[0], l[1], l[2] || '', render); }
function renderLog() {
  logBody.innerHTML = log.map(e => `<div class="entry ${e.cls}"><span class="t">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="i">${e.icon}</span><span class="m">${e.html}</span></div>`).join('') || '<div class="entry"><span class="m">quiet so far</span></div>';
}
let logPrimed = false;
function logFromSnapshot(snap, before, diff = true) {
  const now = snap.now || Date.now();
  const ids = new Set(snap.agents.map(a => a.id));
  if (logPrimed && diff) {
    for (const a of snap.agents) {
      const w = mgr.workers.get(a.id); const name = w?.name || a.nickname || '?';
      if (!before.has(a.id)) {
        logAs(now, 'arrived', { name, role: a.role, lead: a.parentId ? nameOf(a.parentId, snap) : null, task: a.task, project: a.project });
      } else {
        const prev = before.get(a.id);
        if (a.asking && !prevAsking.get(a.id)) logAs(now, 'asking', a.askTo ? { name, to: nameOf(a.askTo, snap), text: a.asking } : { name, text: a.asking });
        const fin = w?.justFinished?.() || w?.isReady?.(stage.perf()) || w?.isHandedBack?.(stage.perf());
        if (prev === 'working' && a.status !== 'working') logAs(now, fin && a.delegator ? 'handedBack' : fin ? 'finished' : 'idle', fin && a.delegator ? { name, to: nameOf(a.delegator.id, snap) } : { name }); // a finish in this very snapshot, or a blip inside a hand-back that still holds
        else if (prev !== 'working' && a.status === 'working') logAs(now, 'working', { name });
      }
    }
    for (const [id] of before) if (!ids.has(id)) logAs(now, 'left', { name: nameOf(id, snap) });
  } else if (!logPrimed) {
    logPrimed = true;
    if (snap.agents.length && !journalRestored) addLog(now, '🏢', `office opened with <b>${snap.agents.length}</b> already in`);
  }
  for (const ev of snap.events || []) {
    if (loggedEvents.has(ev.id)) continue;
    if (!(now - ev.at < EVENT_KEEP_MS)) continue; // older than the id memory: never logged twice
    loggedEvents.set(ev.id, ev.at);
    if (journalHas(ev.kind, ev.from, ev.to, ev.at)) continue; // already restored from today's journal
    logAs(ev.at, ev.kind, { name: endName(ev, 'from', id => nameOf(id, snap)), to: endName(ev, 'to', id => nameOf(id, snap)), text: ev.text, outcome: ev.verdict?.outcome, risk: ev.verdict?.risk });
  }
}

// ---- the log survives reloads: today's journal from the server, replayed in the same words ---------------------
// GET /api/journal?since=<local midnight> -> [{ t, kind, id, parentId, role, nickname, task, project, text, to, outcome }]
// Missing endpoint, network error or odd data: the log just starts empty, as before.
let pendingJournal = null, journalRestored = false, journalAt = 0;
const journalSigs = new Map(); // `${kind}|${from}|${to}` -> [t, ...] of replayed interactions, so their live echo is skipped once
async function loadJournal() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), 2500);
  try {
    const res = await fetch(`/api/journal?since=${midnight.getTime()}`, { cache: 'no-store', signal: ctl?.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const list = Array.isArray(j) ? j : Array.isArray(j?.entries) ? j.entries : null;
    journalAt = Date.now();
    return list ? list.filter(e => e && typeof e === 'object' && e.kind && Number(e.t) >= midnight.getTime()) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
function journalHas(kind, from, to, at) {
  if (!journalRestored || !(at <= journalAt + 5000)) return false; // only events from before the reload can be echoes
  const ts = journalSigs.get(`${kind}|${from}|${to ?? ''}`); if (!ts) return false;
  const i = ts.findIndex(t => Math.abs(t - at) < 120000); if (i < 0) return false;
  ts.splice(i, 1); return true;
}
function replayJournal(entries, snap) {
  if (!entries?.length) return;
  const nick = new Map();
  for (const e of entries) if (e.nickname && e.id) nick.set(e.id, e.nickname);
  // live agents keep the name they have in the office; people who left earlier get the name the office would give them
  const nm = id => {
    if (!id) return 'someone';
    const w = mgr.workers.get(id); if (w) return w.name;
    return snap?.agents.find(x => x.id === id)?.nickname || nick.get(id) || NAMES[hash(String(id)) % NAMES.length];
  };
  const status = new Map(); // id -> 'arrived' | 'working' | 'idle', so status lines read like the live diff
  for (const e of entries.slice().sort((a, b) => Number(a.t) - Number(b.t))) {
    const t = Number(e.t), id = e.id, name = nm(id), st = status.get(id);
    switch (e.kind) {
      case 'arrived': status.set(id, 'arrived'); logAs(t, 'arrived', { name, role: e.role, lead: e.parentId ? nm(e.parentId) : null, task: e.task, project: e.project }, false); break;
      case 'left': status.delete(id); logAs(t, 'left', { name }, false); break;
      case 'working': if (st === 'idle' || st === undefined) logAs(t, 'working', { name }, false); status.set(id, 'working'); break;
      case 'idle': { // a top-level session after a real piece of work: finished · your turn (the journal's own rule)
        const top = !e.parentId && e.agentKind !== 'subagent' && e.agentKind !== 'guardian' && e.role !== 'helper' && e.role !== 'reviewer';
        const fin = top && Number(e.workedMs) >= (mgr.finishedMinMs || 120000);
        if (st !== 'idle') logAs(t, fin && e.delegatedBy ? 'handedBack' : fin ? 'finished' : 'idle', fin && e.delegatedBy ? { name, to: nm(e.delegatedBy) } : { name }, false);
        status.set(id, 'idle'); break;
      }
      case 'asking-start': logAs(t, 'asking', e.askTo ? { name, to: nm(e.askTo), text: e.text || '' } : { name, text: e.text || e.asking || '' }, false); break;
      case 'spawn': case 'message': case 'report': case 'review': case 'verdict': {
        const from = e.from ?? id, to = e.to ?? e.parentId ?? null;
        const at = Number(e.at ?? e.t); // the event's own time, which is what the live echo check compares against
        logAs(at, e.kind, { name: e.stub?.side === 'from' ? e.stub.label : nm(from), to: e.stub?.side === 'to' ? e.stub.label : nm(to), text: e.text, outcome: e.outcome ?? e.verdict?.outcome, risk: e.risk ?? e.verdict?.risk }, false);
        const k = `${e.kind}|${from}|${to ?? ''}`; if (!journalSigs.has(k)) journalSigs.set(k, []); journalSigs.get(k).push(at);
        break;
      }
      default: break; // asking-end, role-change: no line in the live log either
    }
  }
  journalRestored = log.length > 0;
  renderLog();
}
renderLog();

// ---- connection: a clear state while the server is away -----------------------------------------------------------
// After ~5 s without the server the office keeps showing the last snapshot, says so in a small banner and dims a little;
// the dock badge and the "(N)" in the title are cleared (they would be stale). A reconnect re-primes the log diff, and the
// alerts remember who was already waiting, so nothing is logged or notified twice.
const OFFLINE_AFTER_MS = 5000, STALE_AFTER_MS = 20000;
const banner = document.createElement('div');
banner.id = 'offline'; banner.className = 'offline'; banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite'); banner.hidden = true;
banner.style.cssText = 'position:fixed;left:50%;top:calc(var(--hud-h, 72px) + 10px);transform:translateX(-50%);z-index:40;max-width:calc(100vw - 32px);box-sizing:border-box;'
  + 'padding:7px 14px;border-radius:999px;background:rgba(63,58,74,.9);color:#fbf8f2;font:600 12.5px/1.35 "M PLUS Rounded 1c",system-ui,sans-serif;'
  + 'text-align:center;box-shadow:0 6px 18px rgba(63,58,74,.22);pointer-events:none';
document.body.appendChild(banner);
canvas.style.transition = 'filter .8s ease';
let everConnected = false, downSince = Date.now(), offlineKey = '';
function setConn(dot, label, off = false) { // dot and label apart, so a tight row can show just the dot
  const c = $('conn'); c.querySelector('.cd').textContent = dot; c.querySelector('.lbl').textContent = label;
  c.classList.toggle('off', off); c.title = `connection to the office server: ${label}`;
}
function setOffline(on) {
  const text = !on ? '' : everConnected ? 'Showing the last known office — reconnecting…' : 'Can’t reach the AI Office server on this Mac (npm start)';
  if (text === offlineKey) return; offlineKey = text;
  banner.hidden = !on; banner.textContent = text;
  canvas.style.filter = on ? 'saturate(.55) brightness(.93)' : '';
  alerts.setOffline?.(on);
}

if (hosted) {
  document.body.classList.add('hosted');
  const note = document.createElement('div'); note.className = 'hostedNote';
  note.innerHTML = '<span>A made-up demo. Run it on your own machine to watch your real AI agents.</span> <a href="https://github.com/DicksonKam/ai-office" target="_blank" rel="noopener">See how →</a><button type="button" aria-label="Close">×</button>';
  note.querySelector('button').addEventListener('click', () => note.remove());
  document.body.appendChild(note);
}
if (isDemo) {
  setConn('●', 'demo'); if (params.has('crowd')) startCrowdDemo(onSnapshot, Number(params.get('crowd')) || 24, { reviewers: params.has('reviewers') }); else startDemo(onSnapshot, { scene: params.get('demo') || null });
} else {
  let ws = null, retry = 1000, lastMsgAt = 0, beats = 0, heartbeat = false;
  const closed = () => {
    if (downSince == null) downSince = Date.now();
    setConn('○', 'reconnecting', true);
    setTimeout(connect, retry); retry = Math.min(retry * 1.6, 10000);
  };
  const connect = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 1000; setConn('●', 'live');
      if (everConnected) reprimeLog = true; // the first snapshot after a reconnect is a new baseline: nothing is logged twice
      everConnected = true; downSince = null; lastMsgAt = Date.now(); beats = 0;
      setOffline(false);
    };
    ws.onmessage = e => {
      const t = Date.now();
      beats = t - lastMsgAt < 8000 ? beats + 1 : 0; if (beats >= 3) heartbeat = true; // a steady beat: silence now means trouble
      lastMsgAt = t;
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type && msg.type !== 'snapshot') { if (/beat|ping/i.test(msg.type)) heartbeat = true; return; } // a heartbeat: alive, nothing to draw
      if (!Array.isArray(msg.agents)) return;
      try { onSnapshot(msg); } catch (err) { console.error(err); }
    };
    ws.onclose = closed;
    ws.onerror = () => ws.close();
  };
  setInterval(() => {
    // a server that beats has gone quiet (a half-open socket after the laptop slept): drop it and dial again at once
    if (heartbeat && ws?.readyState === WebSocket.OPEN && Date.now() - lastMsgAt > STALE_AFTER_MS) {
      const old = ws; old.onclose = old.onmessage = old.onerror = null; try { old.close(); } catch { /* ignore */ }
      closed();
    }
    setOffline(downSince != null && Date.now() - downSince > OFFLINE_AFTER_MS);
  }, 1000);
  // restore today's log first, so the first snapshot continues it instead of starting over (gives up after 2.5 s)
  loadJournal().then(j => { pendingJournal = j; }, () => {}).finally(connect);
}

// ---- HUD layout: one row of pills that never wraps; panels and popovers start below the HUD -----------------------
// Natural widths are measured on hidden clones (cached by markup, so only changed pills are measured again) and
// web/hudfit.js decides what folds into ⋯, what compacts and whether the card clamps or the pills drop under it.
// Re-run (debounced) when the HUD resizes, the floors / counts / connection change, fonts load or the pointer changes.
// Root variables for the panels: --hud-b bottom of the pill row (bubbles.js keeps bubbles below it), --hud-h bottom of
// the whole HUD (full-width and left-hand things), --hud-r what the right-hand panels (roster, log) must clear.
{
  const hud = $('hud'), title = hud.querySelector('.title'), legend = hud.querySelector('.legend');
  const keyWrap = hud.querySelector('.keywrap'), moreWrap = $('moreWrap');
  const pills = { key: $('keyToggle'), zoom: $('zoomToggle'), teams: $('rosterToggle'), log: $('logToggle') };
  const TITLE_MIN = 210; // the card clamps no narrower than this (logo, name, clock and the first chip) beside the pills
  const RIGHT_COL = 340; // the roster / log column at the right edge, with its margin
  const meas = document.createElement('div'); meas.className = 'hud-measure'; meas.setAttribute('aria-hidden', 'true');
  hud.appendChild(meas);
  const cache = new Map();
  // clones keep their ids for the few synchronous lines they exist (styles like `#count .ask` must apply to them)
  const widthOf = (el, variant = '') => {
    if (!el || el.hidden) return 0;
    const key = `${variant}|${el.outerHTML}`;
    let w = cache.get(key);
    if (w === undefined) {
      meas.className = `hud-measure ${variant}`;
      const c = meas.appendChild(el.cloneNode(true));
      w = Math.ceil(c.getBoundingClientRect().width); c.remove();
      if (cache.size > 300) cache.clear();
      cache.set(key, w);
    }
    return w;
  };
  let applied = '';
  const apply = p => {
    const sig = JSON.stringify(p); if (sig === applied) return; applied = sig;
    // folded pills go to the menu, the rest back to the row, both in their usual order; untouched ones are not moved
    let anchor = null;
    for (const id of [...SECONDARY].reverse()) {
      if (!p.fold.includes(id)) continue;
      const el = pills[id]; if (el.parentNode !== morePop || el.nextElementSibling !== anchor) morePop.insertBefore(el, anchor); anchor = el;
    }
    anchor = moreWrap;
    for (const id of [...SECONDARY].reverse()) {
      if (p.fold.includes(id)) continue;
      const el = pills[id];
      if (id === 'key') { if (el.parentNode !== keyWrap) keyWrap.insertBefore(el, keyWrap.firstChild); continue; }
      if (el.parentNode !== legend || el.nextElementSibling !== anchor) legend.insertBefore(el, anchor); anchor = el;
    }
    keyWrap.classList.toggle('folded', p.fold.includes('key')); // the Key popover stays, anchored to the row's right edge
    moreWrap.hidden = !p.fold.length; if (moreWrap.hidden && !morePop.hidden) setMore(false);
    legend.classList.toggle('fl-compact', p.compactFloors);
    legend.classList.toggle('bell-ic', p.bellIcon);
    legend.classList.toggle('conn-ic', p.connIcon);
    legend.classList.toggle('scroll', p.scroll);
    hud.classList.toggle('stack', p.stack);
    hud.classList.toggle('clamp', p.clamp);
    syncMore();
  };
  const vars = {};
  const setVar = (name, px) => { const v = `${Math.round(Math.max(px, 0))}px`; if (vars[name] !== v) { vars[name] = v; document.documentElement.style.setProperty(name, v); } };
  const edges = () => {
    const tb = title.getBoundingClientRect(), lb = legend.getBoundingClientRect();
    setVar('--hud-b', lb.bottom);
    const hudWas = vars['--hud-h'];
    setVar('--hud-h', Math.max(tb.bottom, lb.bottom));
    if (vars['--hud-h'] !== hudWas && window.innerWidth / window.innerHeight < 0.8) fitCamera(mgr.office); // tall screens frame below the HUD
    setVar('--hud-r', Math.max(lb.bottom, tb.right > window.innerWidth - RIGHT_COL ? tb.bottom : 0));
  };
  const layout = () => {
    const floors = $('floors'), bell = $('bell'), conn = $('conn');
    apply(planHud({
      avail: hud.clientWidth,
      gap: parseFloat(getComputedStyle(legend).columnGap) || 0,
      hudGap: parseFloat(getComputedStyle(hud).columnGap) || 0,
      title: { natural: widthOf(title), min: hosted && hud.clientWidth < 520 ? Infinity : TITLE_MIN }, // the public demo has no Alerts pill: on a phone the card must still get its own row
      w: {
        floors: widthOf(floors), floorsCompact: widthOf(floors, 'fl-compact'),
        key: widthOf(pills.key), zoom: widthOf(pills.zoom), teams: widthOf(pills.teams), log: widthOf(pills.log), more: widthOf(moreBtn),
        today: widthOf($('todayToggle')), bell: hosted ? 0 : widthOf(bell), bellIcon: hosted ? 0 : widthOf(bell, 'bell-ic'), conn: widthOf(conn), connIcon: widthOf(conn, 'conn-ic'),
      },
    }));
    edges();
  };
  let timer = 0;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(layout, 60); };
  const remeasure = () => { cache.clear(); schedule(); };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { edges(); schedule(); }); // the edges at once (panels follow), the fit debounced
    for (const el of [hud, title, legend]) ro.observe(el);
  }
  window.addEventListener('resize', schedule);
  // floor buttons appear / change counts, the Today pill loads, the status line or the connection changes
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(schedule);
    for (const el of [title, $('floors'), $('conn'), $('todayToggle')]) mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  }
  document.fonts?.addEventListener?.('loadingdone', remeasure);
  document.fonts?.ready?.then(remeasure, () => {});
  window.matchMedia?.('(pointer: coarse)').addEventListener?.('change', remeasure);
  layout();
}

// ---- loop ---------------------------------------------------------------------------
// The office is a monitor kept open all day: the simulation must survive a sleeping laptop, a hidden tab and a frozen
// page. A frame steps once (in 50 ms sub-steps after a hitch); a gap over GAP_S is simulated for at most GAP_SIM_S and
// the rest is dropped (the next snapshot puts everyone where they really are); while the page is hidden a 1 s timer
// steps coarsely, and becoming visible again fast-forwards at once.
const clockEl = $('clock');
const SUB_DT = 0.05, GAP_S = 5, GAP_SIM_S = 30, GAP_DT = 0.1, HIDDEN_DT = 0.25;
let last = performance.now(), hudT = 0;
function step(now, coarse = false) {
  let dt = (now - last) / 1000; last = now;
  if (!document.hidden) quality?.tick(dt * 1000); // the page's own pause while hidden says nothing about the machine
  if (!(dt > 0)) return;
  if (player.active) {
    const rate = player.advance(dt, document.hidden), sim = Math.min(dt * rate, 1.2);
    if (sim > 0) { const n = Math.max(1, Math.ceil(sim / (rate > 30 ? 0.2 : SUB_DT))); for (let i = 0; i < n; i++) mgr.update(sim / n, stage.perf()); }
    return;
  }
  const gap = dt > GAP_S;
  if (gap) dt = Math.min(dt, GAP_SIM_S);
  if (dt <= 0.1 && !coarse) { mgr.update(dt, stage.perf()); return; }
  const n = Math.ceil(dt / (coarse ? HIDDEN_DT : gap ? GAP_DT : SUB_DT));
  for (let i = 0; i < n; i++) mgr.update(dt / n, stage.perf());
}
setInterval(() => { if (document.hidden) step(performance.now(), true); }, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  step(performance.now()); // fast-forward now, not on the first frame
  needDaylight = true; hudT = 1; // light, HUD and camera target catch up on the next frame
});
// long-running memory: event ids the log has seen are forgotten after an hour (the server resends only minutes)
setInterval(() => {
  const t = Date.now();
  for (const [id, at] of loggedEvents) if (!(t - at < EVENT_KEEP_MS + 5 * 60000)) loggedEvents.delete(id);
  if (journalSigs.size && t - journalAt > 10 * 60000) journalSigs.clear(); // echoes of the replayed journal are long past
}, 60000);
let fpsAcc = 0, fpsN = 0, lastFrame = performance.now();
function frame(now) {
  const raw = Math.max(0, (now - lastFrame) / 1000); lastFrame = now; // the real frame time (clamped below)
  fpsN++; if (now - fpsAcc > 2000) { document.documentElement.dataset.fps = String(Math.round(fpsN * 1000 / (now - fpsAcc))); fpsAcc = now; fpsN = 0; }
  if (needDaylight || TIMELAPSE_S) { needDaylight = false; applyDaylight(true); } else if (player.active) applyDaylight();
  step(now);
  easeCamera(Math.min(raw, 0.1));
  overlay.update(mgr.list, camera, window.innerWidth, window.innerHeight, stage.perf(), mgr.activeFloor);
  for (const id of [...overlay.items.keys()]) if (!mgr.workers.has(id)) overlay.remove(id);
  hudT += Math.min(raw, 1);
  if (hudT >= 1) { hudT = 0; applyDaylight(); if (latest) updateHud(latest); for (const f of mgr.floors) f.setFacadeLit?.(mgr.list.some(w => !w.done && w.floor === f.level)); retarget(); renderFloors(mgr); if (latest) renderRoster(latest); clockEl.textContent = clockNow().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); applyDaylight(); if (selected) refreshCard(); }
  if (roomDirty || now - roomAt > ROOM_REDRAW_MS) drawRoomShadow(now); // chairs and desk things move now and then
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
window.__office = { mgr, scene, camera, renderer, THREE, player, stage,
  /** Done-check used by MILESTONE.md: every floor / desk group untransformed, plus frame rate and counts. */
  check() {
    const bad = [];
    const isRot0 = o => Math.abs(o.rotation.x) + Math.abs(o.rotation.y) + Math.abs(o.rotation.z) < 1e-6;
    const isScale1 = o => Math.abs(o.scale.x - 1) + Math.abs(o.scale.y - 1) + Math.abs(o.scale.z - 1) < 1e-6;
    mgr.floors.forEach((f, k) => {
      const g = f.group;
      // the director's idea of a floor must match the floor that got built
      const counts = { desks: [f.desks.length, LAYOUT.desks.length], cafe: [f.cafe?.seats.length, LAYOUT.cafe], lounge: [f.lounge?.seats.length, LAYOUT.lounge(k)], wcs: [f.wcs?.length, LAYOUT.wcs], bar: [f.barSpots?.length, LAYOUT.bar], plants: [f.plantSpots?.length, LAYOUT.plants], windows: [f.windowSpots?.length, LAYOUT.windows], qa: [f.qa?.spots.length, LAYOUT.qa], meeting: [f.meeting?.seats.length, LAYOUT.rooms.meeting], huddle: [f.huddle?.seats.length, LAYOUT.rooms.huddle] };
      for (const [name, [have, want]] of Object.entries(counts)) if (have !== want) bad.push(`${k + 1}F ${name}: built ${have}, director expects ${want}`);
      for (const d of LAYOUT.desks) if (!f.desks.some(x => x.id === d)) bad.push(`${k + 1}F desk ${d} missing`);
      if (!isRot0(g) || !isScale1(g) || Math.abs(g.position.x) + Math.abs(g.position.z) > 1e-6 || Math.abs(g.position.y - k * FLOOR_H) > 1e-6) bad.push(`floor ${k + 1}F group transformed`);
      for (const d of f.desks) if (!isRot0(d.group) || !isScale1(d.group)) bad.push(`desk ${k + 1}F/${d.id} transformed`);
      // furniture through a wall, a glass partition or other furniture: footprints that overlap by more than 3 cm both
      // ways (two thin pieces, walls or glass, meeting at a corner are joints, not clashes; rotated footprints skipped)
      const ob = (f.obstacles || []).filter(o => !o[4]);
      for (let i = 0; i < ob.length; i++) for (let j = i + 1; j < ob.length; j++) {
        const [a, c] = [ob[i], ob[j]];
        if (Math.min(a[2], a[3]) <= 0.2 && Math.min(c[2], c[3]) <= 0.2) continue;
        const ix = Math.min(a[0] + a[2] / 2, c[0] + c[2] / 2) - Math.max(a[0] - a[2] / 2, c[0] - c[2] / 2);
        const iz = Math.min(a[1] + a[3] / 2, c[1] + c[3] / 2) - Math.max(a[1] - a[3] / 2, c[1] - c[3] / 2);
        if (ix > 0.03 && iz > 0.03) bad.push(`${k + 1}F footprints overlap at (${a[0].toFixed(2)}, ${a[1].toFixed(2)}) and (${c[0].toFixed(2)}, ${c[1].toFixed(2)})`);
      }
    });
    if (!isRot0(scene) || !isScale1(scene)) bad.push('scene transformed');
    return { ok: bad.length === 0, bad, fps: Number(document.documentElement.dataset.fps || 0), floors: mgr.floors.length,
      workers: mgr.list.length, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  }, stepNow() { step(performance.now(), true); }, view(zoom = 1, x = 0, z = 0) { Object.assign(debugView, { zoom, x, z }); retarget(true); }, focusOn };
requestAnimationFrame(frame);

// day board (web/dayboard.js, optional): the scene is up, hand it the office
import('./dayboard.js').then(m => m.startDayBoard?.({ mgr, demo: isDemo })).catch(() => {});
// today timeline (web/timeline.js, optional): the Today pill appears only once the module has loaded
import('./timeline.js').then(m => { timelineMod = m; m.startTimeline?.({ mgr, demo: isDemo, lookAtWorker, showCard, watch: isDemo ? null : watchMoment }); }).catch(err => console.warn('timeline:', err));
import('./sound.js').then(m => m.startSound?.({ mgr, demo: isDemo })).catch(err => console.warn('sound:', err));
import('./seasons.js').then(m => m.decorate?.({ mgr, date: new Date(), params: _q })).catch(err => console.warn('seasons:', err)); // Halloween, winter, Lunar New Year, Mid-Autumn by the real date (?season= to check)
if (_q.has('perf')) import('./perf.js').then(m => m.startPerf?.({ renderer, mgr, demo: isDemo, post: !hosted })).catch(err => console.warn('perf:', err)); // ?perf: frame-time readout, numbers to /api/perf
if (_q.has('soak')) import('./soak.js').then(m => m.startSoak?.({ mgr, params: _q })).catch(err => console.warn('soak:', err)); // ?soak: the long-run anomaly monitor (web/soak.js); ?soak&report opens its report
