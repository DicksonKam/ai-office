// Seasonal decorations, by the real local date (the viewer's zone unless told otherwise):
//   halloween  Oct 20 – Nov 1   three carved pumpkins on the porch and its step, an orange / ink pennant garland on the
//                               canopy, two paper bats on a back window, a small pumpkin on the kitchen counter
//   winter     Dec 1 – Jan 2    a decorated tree in a planter on the porch, warm string lights along the canopy edge,
//                               a wreath on each door leaf (inside face: the face the camera sees)
//   lunar      LNY −7 … +15 d   two red lanterns with gold tassels at the canopy, red couplets either side of the door
//                               (inside), a mandarin tree in a red pot in the entrance corner
//   midautumn  festival −5 … +3 a festoon of five round paper lanterns (rabbit-white, peach, mustard) on the canopy
// `?season=halloween|winter|lunar|midautumn|none` overrides the date (`auto` or anything else: by date).
//
// Everything hangs off the ground floor group (which is never rebuilt or pruned), so it dims with the porch and the
// entrance when you look at an upper floor. One group per season, merged with freezeStatic: one baked draw for the plain
// toon parts, one for the ink hulls, one per glowing material (≤ 8 draws in the busiest season, winter). Glowing parts
// are emissive materials pushed into the ground floor's `lamps` list, which main.js's daylight cycle already drives with
// the night factor (and they start at the current NIGHT.lamps), so no per-frame hook is needed. Floor-standing pieces
// (the porch tree, the mandarin pot) are added to the ground floor's nav grid as obstacles; nothing sits on the approach
// path, the steps' walking line or the door swing.
//
// Hook (main.js, after the OfficeManager is built):
//   import('./seasons.js').then(m => m.decorate?.({ mgr, date: new Date(), params: _q })).catch(err => console.warn('seasons:', err));
// A minute timer re-checks the date (the office stays open across midnight) and re-decorates if the season changes.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon, outlined, gradientMap } from './toon.js';
import { PAL, NIGHT } from './office.js';
import { freezeStatic } from './merge.js';
import { setMode, disposeVariants } from './ghost.js';

export const SEASONS = ['halloween', 'winter', 'lunar', 'midautumn'];
export const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; // the viewer's own
// Lunar New Year's Day and the Mid-Autumn Festival (15th of the 8th lunar month), Gregorian dates
const LUNAR_NEW_YEAR = ['2026-02-17', '2027-02-06', '2028-01-26', '2029-02-13', '2030-02-03'];
const MID_AUTUMN = ['2026-09-25', '2027-09-15', '2028-10-03', '2029-09-22', '2030-09-12'];
const LUNAR_BEFORE = 7, LUNAR_AFTER = 15, MOON_BEFORE = 5, MOON_AFTER = 3;
const ALIASES = { halloween: 'halloween', winter: 'winter', christmas: 'winter', xmas: 'winter', lunar: 'lunar', cny: 'lunar', lny: 'lunar',
  midautumn: 'midautumn', 'mid-autumn': 'midautumn', moon: 'midautumn', none: null, off: null };

// ---- dates ------------------------------------------------------------------------------------------------------------
const dayNum = (y, m, d) => Date.UTC(y, m - 1, d) / 864e5;
const isoDay = s => { const [y, m, d] = s.split('-').map(Number); return dayNum(y, m, d); };
const LNY_DAYS = LUNAR_NEW_YEAR.map(isoDay), MOON_DAYS = MID_AUTUMN.map(isoDay);
const fmts = new Map();
function formatter(timeZone) {
  let f = fmts.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); fmts.set(timeZone, f); }
  return f;
}
/** a valid IANA zone name, or the default (Hong Kong) */
function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return DEFAULT_TZ;
  try { formatter(tz); return tz; } catch { return DEFAULT_TZ; }
}
/** { y, m, d } of `date` as a wall-calendar date in `tz` */
function localYMD(date, tz) {
  const parts = {};
  for (const p of formatter(validZone(tz)).formatToParts(date)) parts[p.type] = p.value;
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

/** The season for a moment, by its local calendar date in `tz` (default the viewer's zone): 'lunar' | 'midautumn' |
 *  'halloween' | 'winter' | null. Pure: no globals, no clock. Every window is inclusive at both ends. */
export function seasonFor(date = new Date(), tz = DEFAULT_TZ) {
  const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(t)) return null;
  const { y, m, d } = localYMD(new Date(t), tz);
  const n = dayNum(y, m, d);
  if (LNY_DAYS.some(x => n >= x - LUNAR_BEFORE && n <= x + LUNAR_AFTER)) return 'lunar';
  if (MOON_DAYS.some(x => n >= x - MOON_BEFORE && n <= x + MOON_AFTER)) return 'midautumn';
  const md = m * 100 + d;
  if (md >= 1020 && md <= 1101) return 'halloween';
  if (md >= 1201 || md <= 102) return 'winter';
  return null;
}
/** '?season=' value → a season, null (none) or undefined (by date) */
function parseSeason(v) {
  if (v === null || v === undefined) return undefined;
  const k = String(v).trim().toLowerCase();
  return k in ALIASES ? ALIASES[k] : undefined;
}

// ---- shapes -----------------------------------------------------------------------------------------------------------
const OUT = 0.01;                       // one ink thickness for every decoration: all hulls merge into one draw
const GLOW_K = 1.2;                     // main.js drives a floor's `lamps` at NIGHT.lamps × 1.2
const C = {
  pumpkin: 0xe08a3c, pumpkinDeep: 0xd8803a, pumpkinLight: 0xe89a52, carve: 0x5a3628,
  red: 0xc9473d, gold: 0xd9a441, berry: 0xc4584a, mandarin: 0xe8913a, soil: 0x6b4b3a,
  moonWhite: 0xf6efe2, peach: 0xf2b49a,
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** a point on a lobed, squashed ball (pumpkin, red lantern): `ribs` lobes round the waist, crest at θ = 0 (+z), latitude
 *  φ; a dimple at the top, a slightly flattened base; pushed out by `off` along the radius */
function lobePoint(r, P, t, f, off = 0) {
  const R = r * (1 - P.depth * (0.5 - 0.5 * Math.cos(P.ribs * t)));
  const s = Math.sin(f), c = Math.cos(f);
  const y = r * P.sq * s * (s < 0 ? P.base : 1) - r * P.dimple * Math.pow(Math.max(0, s), 6);
  const p = new THREE.Vector3(R * c * Math.sin(t), y, R * c * Math.cos(t));
  return off ? p.multiplyScalar(1 + off / Math.max(1e-6, p.length())) : p;
}
/** a closed, smooth shell from a unit sphere, each vertex moved to fn(θ, φ); seams welded so the normals (and the ink
 *  hull pushed along them) stay unbroken */
function shell(fn, seg = 24) {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75));
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const q = fn(Math.atan2(p.getX(i), p.getZ(i)), Math.asin(clamp(p.getY(i), -1, 1)));
    p.setXYZ(i, q.x, q.y, q.z);
  }
  const m = mergeVertices(g); g.dispose(); m.computeVertexNormals();
  return m;
}
/** a curved patch on a surface: fn(u, v) → [θ, φ] for u, v in 0…1, surf(θ, φ) → point (a carved feature) */
function patch(fn, nu, nv, surf) {
  const pos = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { const [t, f] = fn(i / nu, j / nv); const q = surf(t, f); pos.push(q.x, q.y, q.z); }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; idx.push(a, b, d, a, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** a sagging run of cord from a to b (a catenary-ish parabola) */
const swagAt = (a, b, sag, t) => new THREE.Vector3().lerpVectors(a, b, t).add(new THREE.Vector3(0, -4 * sag * t * (1 - t), 0));
function swagPoints(a, b, sag, n = 14) { const out = []; for (let i = 0; i <= n; i++) out.push(swagAt(a, b, sag, i / n)); return out; }
function cordGeo(points, r = 0.005) { return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), points.length * 2, r, 5, false); }
/** an emissive toon material of our own (never a cached one: its intensity changes with the night) */
function glowMat(ctx, color, emissive, opts = {}) {
  const m = new THREE.MeshToonMaterial({ color, gradientMap: gradientMap(), emissive, emissiveIntensity: 0, ...opts });
  ctx.glow.push(m); ctx.owned.push(m);
  return m;
}

// ---- build context ----------------------------------------------------------------------------------------------------
function makeCtx(g, root) {
  const geos = new Map();
  const ctx = {
    g, root, glow: [], owned: [], textures: [], navRects: [], attached: [],
    /** a geometry shared within this build */
    geo(key, make) { let x = geos.get(key); if (!x) { x = make(); geos.set(key, x); } return x; },
    /** a mesh under parent at (x, y, z), optionally inked; returns it (never chain transforms on parent.add) */
    put(parent, geo, mat, x = 0, y = 0, z = 0, { outline = 0, cast = true } = {}) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = false;
      if (outline) outlined(m, outline);
      parent.add(m);
      return m;
    },
    group(parent, x = 0, y = 0, z = 0, ry = 0) { const o = new THREE.Group(); o.position.set(x, y, z); o.rotation.y = ry; parent.add(o); return o; },
  };
  return ctx;
}
/** porch and canopy landmarks, from the ground floor's door (office.js: a 3.0 × 2.5 m porch slab, a glass canopy 1 m
 *  deep with a light frame whose front bar runs 0.98 m out, bottom at 2.39 m, 0.25 m past each jamb) */
function porch(g) {
  const X0 = g.door.x, Z0 = g.door.z, half = (g.door.width || 1.8) / 2;
  return { X0, Z0, half, XC: X0 - 0.98 - 0.035, YC: 2.385, CZ: half + 0.25 };
}
/** keep pieces that stand on the floor out of the nav grid: the grid is rebuilt from scratch whenever a desk's obstacles
 *  change, so the extra rectangles are re-added after every reset (and dropped again on release) */
function holdNav(nav, rects) {
  if (!nav || typeof nav.block !== 'function' || !rects.length) return () => {};
  if (!nav.seasonal) {
    const base = nav.reset, extra = [];
    nav.seasonal = { base, extra };
    nav.reset = function () { base.call(this); for (const r of extra) this.block(...r); };
  }
  const { extra } = nav.seasonal;
  extra.push(...rects);
  for (const r of rects) nav.block(...r);
  return () => { for (const r of rects) { const i = extra.indexOf(r); if (i >= 0) extra.splice(i, 1); } };
}

// ---- pieces -----------------------------------------------------------------------------------------------------------
const PUMPKIN = { sq: 0.78, ribs: 8, depth: 0.06, dimple: 0.16, base: 0.92 };
const tooth = (u, a, b) => clamp((u - a) / 0.025, 0, 1) * clamp((b - u) / 0.025, 0, 1);
/** a carved pumpkin sitting on y, its face turned by yaw; mouth 'grin' (two teeth), 'smile' or 'o'. The cut-outs are
 *  dark by day and glow warm at night (faceMat) */
function pumpkin(ctx, parent, { x, y, z, r, color, yaw, mouth, faceMat }) {
  const P = PUMPKIN;
  const g = ctx.group(parent, x, y + r * P.sq * P.base - 0.004, z, yaw);
  ctx.put(g, ctx.geo(`pumpkin${r}`, () => shell((t, f) => lobePoint(r, P, t, f))), toon(color), 0, 0, 0, { outline: OUT });
  const top = r * P.sq - r * P.dimple;
  const stem = ctx.put(g, ctx.geo(`stem${r}`, () => new THREE.CylinderGeometry(r * 0.07, r * 0.11, r * 0.36, 7)), toon(PAL.sageDeep), r * 0.03, top + r * 0.15, 0, { outline: OUT });
  stem.rotation.set(-0.12, 0, -0.24);
  const at = (t, f) => lobePoint(r, P, t, f, r * 0.03 + 0.002);
  const tri = (b0, b1, apex) => patch((u, v) => { const bx = b0[0] + (b1[0] - b0[0]) * u, by = b0[1] + (b1[1] - b0[1]) * u; return [bx + (apex[0] - bx) * v, by + (apex[1] - by) * v]; }, 6, 3, at);
  const face = [tri([-0.52, 0.12], [-0.16, 0.12], [-0.33, 0.42]), tri([0.16, 0.12], [0.52, 0.12], [0.33, 0.42]), tri([-0.08, -0.03], [0.08, -0.03], [0, 0.1])];
  if (mouth === 'o') face.push(patch((u, v) => [0.13 * v * Math.cos(u * Math.PI * 2), -0.21 + 0.1 * v * Math.sin(u * Math.PI * 2)], 24, 2, at));
  else {
    const teeth = mouth === 'grin';
    face.push(patch((u, v) => {
      const s = Math.sin(Math.PI * u);
      let hi = -0.07 - 0.13 * s, lo = hi - (teeth ? 0.04 + 0.15 * s : 0.03 + 0.08 * s);
      if (teeth) { hi -= 0.07 * tooth(u, 0.3, 0.4); lo += 0.07 * tooth(u, 0.6, 0.7); }
      return [-0.6 + 1.2 * u, lo + (hi - lo) * v];
    }, 48, 2, at));
  }
  for (const geo of face) ctx.put(g, geo, faceMat, 0, 0, 0, { cast: false });
  return g;
}
/** a paper bat cut-out (wingspan 0.4 × s) in the xy plane, facing +z */
function batGeo(s) {
  const sh = new THREE.Shape(), P = (x, y) => [x * s, y * s];
  sh.moveTo(...P(0, 0.04));
  sh.lineTo(...P(0.022, 0.072)); sh.lineTo(...P(0.032, 0.038)); sh.lineTo(...P(0.06, 0.03));
  sh.quadraticCurveTo(...P(0.12, 0.04), ...P(0.2, 0.075));
  sh.lineTo(...P(0.175, 0.005));
  sh.quadraticCurveTo(...P(0.15, 0.035), ...P(0.122, -0.008));
  sh.quadraticCurveTo(...P(0.098, 0.022), ...P(0.07, -0.018));
  sh.lineTo(...P(0.025, -0.03)); sh.lineTo(...P(0, -0.05)); sh.lineTo(...P(-0.025, -0.03)); sh.lineTo(...P(-0.07, -0.018));
  sh.quadraticCurveTo(...P(-0.098, 0.022), ...P(-0.122, -0.008));
  sh.quadraticCurveTo(...P(-0.15, 0.035), ...P(-0.175, 0.005));
  sh.lineTo(...P(-0.2, 0.075));
  sh.quadraticCurveTo(...P(-0.12, 0.04), ...P(-0.06, 0.03));
  sh.lineTo(...P(-0.032, 0.038)); sh.lineTo(...P(-0.022, 0.072)); sh.closePath();
  return new THREE.ShapeGeometry(sh, 6);
}
/** a hanging cord from the canopy bar down to y (thin ink) */
function drop(ctx, parent, x, yTop, yBottom, z) {
  const len = yTop - yBottom;
  if (len > 0.005) ctx.put(parent, ctx.geo(`drop${len.toFixed(3)}`, () => new THREE.CylinderGeometry(0.004, 0.004, len, 5)), toon(PAL.ink), x, (yTop + yBottom) / 2, z);
}
/** warm string-light bulbs on a run of swags (cord in ink, bulbs a glow material) */
function stringLights(ctx, parent, anchors, sag, bulbMat) {
  for (let i = 0; i + 1 < anchors.length; i++) {
    const a = anchors[i], b = anchors[i + 1];
    ctx.put(parent, cordGeo(swagPoints(a, b, sag)), toon(PAL.ink), 0, 0, 0);
    const n = Math.max(2, Math.round(a.distanceTo(b) / 0.115));
    for (let k = 0; k < n; k++) {
      const p = swagAt(a, b, sag, (k + 0.5) / n);
      ctx.put(parent, ctx.geo('bulb', () => new THREE.SphereGeometry(0.017, 8, 6)), bulbMat, p.x, p.y - 0.021, p.z, { cast: false });
    }
  }
}
/** a wreath ring in the yz plane, its front facing +x: sage ring, leaf clumps, berries and a bow at the bottom */
function wreath(ctx) {
  const w = new THREE.Group(), R = 0.15; w.name = 'season:wreath';
  const ring = new THREE.TorusGeometry(R, 0.042, 8, 26); ring.rotateY(Math.PI / 2);
  ctx.put(w, ring, toon(PAL.sageDeep), 0, 0, 0, { outline: OUT });
  const clump = ctx.geo('clump', () => new THREE.SphereGeometry(0.032, 8, 6)), berry = ctx.geo('berry', () => new THREE.SphereGeometry(0.014, 6, 5));
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2 + 0.2, rr = R + (i % 2 ? 0.018 : -0.014);
    ctx.put(w, clump, toon(i % 3 ? PAL.leaf : PAL.sage), 0.022, Math.sin(a) * rr, Math.cos(a) * rr);
  }
  for (const a of [0.5, 0.75, 1.9, 2.25, 2.6, 3.9]) ctx.put(w, berry, toon(C.berry), 0.05, Math.sin(a) * (R + 0.02), Math.cos(a) * (R + 0.02));
  const bowMat = toon(C.berry), by = -R - 0.01;
  ctx.put(w, ctx.geo('knot', () => new THREE.SphereGeometry(0.022, 8, 6)), bowMat, 0.055, by, 0, { outline: OUT });
  for (const s of [-1, 1]) {
    const loop = ctx.put(w, ctx.geo('loop', () => new THREE.SphereGeometry(0.04, 10, 8)), bowMat, 0.045, by + 0.008, s * 0.045, { outline: OUT });
    loop.scale.set(0.45, 0.7, 1); loop.rotation.x = s * 0.35;
    const tail = ctx.put(w, ctx.geo('tail', () => new THREE.BoxGeometry(0.012, 0.09, 0.026)), bowMat, 0.05, by - 0.055, s * 0.024);
    tail.rotation.x = -s * 0.28;
  }
  freezeStatic(w);
  return w;
}
/** the door leaves of the ground floor: the dynamic hinge groups office.js puts at each jamb */
function doorLeaves(g) {
  const out = [];
  for (const o of g.group.children) {
    if (o.isMesh || !o.userData.dynamic) continue;
    const dz = o.position.z - g.door.z;
    if (Math.abs(o.position.x - (g.door.x + 0.1)) < 0.06 && Math.abs(Math.abs(dz) - (g.door.width || 1.8) / 2) < 0.06) out.push({ hinge: o, side: Math.sign(dz) });
  }
  return out;
}
/** two vertical couplets, gold calligraphy on red, one canvas for both (left column / right column) */
function coupletMaterial(ctx, lines) {
  if (typeof document === 'undefined') return toon(C.red);
  const W = 64, H = 512, c = document.createElement('canvas'); c.width = W * 2; c.height = H;
  const g = c.getContext('2d');
  lines.forEach((text, k) => {
    const x0 = k * W;
    g.fillStyle = '#c9473d'; g.fillRect(x0, 0, W, H);
    g.strokeStyle = 'rgba(217,164,65,0.85)'; g.lineWidth = 2; g.strokeRect(x0 + 5, 5, W - 10, H - 10);
    g.fillStyle = '#e0b04e'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '600 48px "Kaiti TC", "STKaiti", "BiauKai", "Songti TC", "PingFang HK", "Hiragino Sans", serif';
    const chars = [...text], step = (H - 28) / chars.length;
    chars.forEach((ch, i) => g.fillText(ch, x0 + W / 2, 14 + step * (i + 0.5)));
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const m = new THREE.MeshToonMaterial({ map: tex, gradientMap: gradientMap() });
  m.color.setScalar(1.18);              // the inner face of the west wall is out of the sun: keep the red clear
  ctx.textures.push(tex); ctx.owned.push(m);
  return m;
}
/** a plane facing +x showing column `col` (0 | 1) of a two-column canvas */
function couplet(ctx, parent, mat, col, x, yc, zc, w, h) {
  const geo = new THREE.PlaneGeometry(w, h), uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (col + uv.getX(i)) / 2);
  geo.rotateY(Math.PI / 2);
  return ctx.put(parent, geo, mat, x, yc, zc, { cast: false });
}

// ---- seasons ----------------------------------------------------------------------------------------------------------
const BUILD = {
  halloween(ctx) {
    const { g, root } = ctx;
    const faceMat = glowMat(ctx, C.carve, 0xff9a3a, { side: THREE.DoubleSide });
    if (g.door) {
      const { X0, Z0, XC, YC, CZ } = porch(g);
      // three pumpkins: a big and a middle one on the porch's street-side corner beside the planter, a small one on the
      // upper step's end; all ≥ 0.7 m off the walking line (z = door), faces turned toward the camera
      pumpkin(ctx, root, { x: X0 - 2.25, y: 0, z: Z0 + 0.95, r: 0.2, color: C.pumpkin, yaw: 0.72, mouth: 'grin', faceMat });
      pumpkin(ctx, root, { x: X0 - 1.86, y: 0, z: Z0 + 1.06, r: 0.15, color: C.pumpkinDeep, yaw: 0.5, mouth: 'smile', faceMat });
      pumpkin(ctx, root, { x: X0 - 3.1, y: 0, z: Z0 + 0.8, r: 0.1, color: C.pumpkinLight, yaw: 1.0, mouth: 'o', faceMat });
      // a pennant garland under the canopy's front bar, in two swags, orange and ink alternating
      const pts = [-1.1, 0, 1.1].map(dz => new THREE.Vector3(XC, YC, Z0 + Math.min(dz, CZ)));
      const pen = ctx.geo('pennant', () => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.065, 0, 0, 0.065, 0, -0.17, 0], 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
        return geo;
      });
      const sag = 0.09;
      let k = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        ctx.put(root, cordGeo(swagPoints(a, b, sag)), toon(PAL.ink), 0, 0, 0);
        for (let j = 0; j < 6; j++, k++) {
          const t = (j + 0.5) / 6, p = swagAt(a, b, sag, t), slope = -4 * sag * (1 - 2 * t) / a.distanceTo(b);
          const m = ctx.put(root, pen, toon(k % 2 ? PAL.ink : C.pumpkin, { side: THREE.DoubleSide }), p.x, p.y - 0.004, p.z);
          m.rotation.set(-Math.atan(slope), 0, ((k * 37) % 7 - 3) * 0.04);   // top edge along the cord, a little sway
        }
      }
    }
    // two paper bats on a back window, below the blinds
    const win = g.windows?.[1] || g.windows?.[0];
    if (win) {
      const wp = win.position;
      for (const [dx, dy, s, rz] of [[-0.36, -0.12, 0.7, 0.18], [0.18, -0.32, 0.52, -0.12]]) {
        const bat = ctx.put(root, ctx.geo(`bat${s}`, () => batGeo(s)), toon(PAL.ink), wp.x + dx, wp.y + dy, wp.z + 0.014);
        bat.rotation.z = rz;
      }
    }
    // a small pumpkin on the kitchen worktop, between the mugs and the coffee machine
    const st = g.coffee?.stand;
    if (st) pumpkin(ctx, root, { x: st.x - 0.42, y: 0.91, z: st.z - 1.1 + 0.2, r: 0.075, color: C.pumpkin, yaw: 0.6, mouth: 'grin', faceMat });
  },

  winter(ctx) {
    const { g, root } = ctx;
    const bulbMat = glowMat(ctx, 0xfff3d8, 0xffcf7a), starMat = glowMat(ctx, C.gold, 0xffc24a);
    if (g.door) {
      const { X0, Z0, XC, YC, CZ } = porch(g);
      // a 1.8 m tree in a slate planter matching the porch's own, on the porch's street-side half, clear of the door swing
      // (0.9 m) and 0.5 m off the walking line
      const tx = X0 - 1.85, tz = Z0 + 0.88, tree = ctx.group(root, tx, 0, tz, 0);
      ctx.put(tree, new THREE.BoxGeometry(0.42, 0.42, 0.42), toon(PAL.slateDark), 0, 0.21, 0, { outline: OUT });
      ctx.put(tree, new THREE.BoxGeometry(0.36, 0.02, 0.36), toon(C.soil), 0, 0.425, 0);
      ctx.put(tree, new THREE.CylinderGeometry(0.04, 0.05, 0.2, 8), toon(PAL.oakDark), 0, 0.52, 0);
      const cones = [[0.4, 0.62, 0.56], [0.32, 0.52, 0.92], [0.22, 0.42, 1.24]];         // radius, height, base y
      for (const [r, h, y0] of cones) ctx.put(tree, new THREE.ConeGeometry(r, h, 18), toon(PAL.sageDeep), 0, y0 + h / 2, 0, { outline: OUT });
      const radiusAt = y => Math.max(0, ...cones.map(([r, h, y0]) => (y >= y0 && y <= y0 + h ? r * (1 - (y - y0) / h) : 0)));
      const bauble = ctx.geo('bauble', () => new THREE.SphereGeometry(0.034, 10, 8));
      const cols = [PAL.terracotta, PAL.mustard, PAL.paper, PAL.blush, C.gold, PAL.slateLight];
      for (let i = 0; i < 13; i++) {
        const y = 0.66 + i * 0.065, a = i * 2.4 + 0.4, r = radiusAt(y) + 0.012;
        ctx.put(tree, bauble, toon(cols[i % cols.length]), Math.sin(a) * r, y, Math.cos(a) * r, { outline: OUT });
      }
      for (let i = 0; i < 14; i++) { // a spiral of warm bulbs (the same glow as the canopy lights)
        const y = 0.62 + i * 0.068, a = i * 1.15, r = radiusAt(y) + 0.008;
        ctx.put(tree, ctx.geo('bulb', () => new THREE.SphereGeometry(0.017, 8, 6)), bulbMat, Math.sin(a) * r, y, Math.cos(a) * r, { cast: false });
      }
      const star = new THREE.Shape();
      for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.036 : 0.085; star[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); }
      star.closePath();
      const sg = new THREE.ExtrudeGeometry(star, { depth: 0.022, bevelEnabled: false }); sg.translate(0, 0, -0.011);
      const sm = ctx.put(tree, sg, starMat, 0, 1.71, 0, { outline: OUT });
      sm.rotation.y = Math.PI / 4;                                                          // faces the camera
      ctx.navRects.push([tx, tz, 0.5, 0.5]);
      // warm string lights in swags under the canopy's front bar, and along its street-side edge
      const front = [-1, -0.5, 0, 0.5, 1].map(f => new THREE.Vector3(XC, YC, Z0 + f * (CZ - 0.02)));
      stringLights(ctx, root, front, 0.06, bulbMat);
      const side = [0, 0.5, 1].map(f => new THREE.Vector3(XC + f * (X0 - 0.06 - XC), YC, Z0 + CZ + 0.035));
      stringLights(ctx, root, side, 0.05, bulbMat);
    }
    // a wreath on the inside face of each door leaf, over the vision glass (it swings with the leaf)
    if (g.door) for (const { hinge, side } of doorLeaves(g)) {
      const w = wreath(ctx); w.position.set(0.078, 1.5, -side * 0.45);
      hinge.add(w); ctx.attached.push(w);
    }
  },

  lunar(ctx) {
    const { g, root } = ctx;
    const lanternMat = glowMat(ctx, C.red, 0x7a160c); // a deep red glow: a brighter, oranger one washed the lantern out to pink
    if (g.door) {
      const { X0, Z0, half, XC, YC } = porch(g);
      // a pair of red lanterns either side of the door under the canopy's front bar: lobed body, gold caps, gold tassel
      const LP = { sq: 0.84, ribs: 12, depth: 0.045, dimple: 0, base: 1 }, r = 0.17;
      const body = ctx.geo('lantern', () => shell((t, f) => lobePoint(r, LP, t, f), 28));
      const capGeo = ctx.geo('cap', () => new THREE.CylinderGeometry(0.07, 0.078, 0.035, 16));
      const gold = toon(C.gold);
      // (0.62 m either side: clear of the walking line and of the leaves, which open flat against the sides; hung from the
      // bar's outer face so the swing arc, which reaches 0.8 m out, stays 7 cm clear)
      const lx = XC - 0.03;
      for (const s of [-1, 1]) {
        const z = Z0 + s * 0.62, hb = r * LP.sq, yb = YC - 0.07 - 0.035 - hb;
        drop(ctx, root, lx, YC, yb + hb + 0.028, z);
        ctx.put(root, capGeo, gold, lx, yb + hb + 0.012, z, { outline: OUT });
        ctx.put(root, body, lanternMat, lx, yb, z, { outline: OUT });
        ctx.put(root, capGeo, gold, lx, yb - hb - 0.012, z, { outline: OUT });
        ctx.put(root, ctx.geo('tcord', () => new THREE.CylinderGeometry(0.005, 0.005, 0.06, 5)), gold, lx, yb - hb - 0.06, z);
        ctx.put(root, ctx.geo('bead', () => new THREE.SphereGeometry(0.018, 8, 6)), toon(C.red), lx, yb - hb - 0.095, z);
        ctx.put(root, ctx.geo('tassel', () => new THREE.CylinderGeometry(0.014, 0.03, 0.16, 10)), gold, lx, yb - hb - 0.19, z, { outline: OUT });
      }
      // couplets on the inside face of the wall either side of the doorway (the outside face is turned from the camera):
      // the first line on the right as you face the door from outside (+z), the second on the left
      const jamb = 0.08, x = X0 + 0.2 + 0.004, yc = 1.575, h = 1.05;
      const zPlus0 = Z0 + half + jamb, wPlus = Math.min(0.17, (g.hz - zPlus0) - 0.04);
      const mat = coupletMaterial(ctx, ['生意興隆通四海', '財源茂盛達三江']);
      if (wPlus > 0.08) couplet(ctx, root, mat, 0, x, yc, (zPlus0 + g.hz) / 2, wPlus, h);
      couplet(ctx, root, mat, 1, x, yc, Z0 - half - jamb - 0.11, 0.17, h);
      // a mandarin tree in a red pot with a gold band, in the entrance corner beside the doorway (inside, off the mat's
      // walking line and clear of the stair foot on the other side)
      const mx = X0 + 0.5, mz = Math.min(g.hz - 0.24, Z0 + half + 0.2), pot = ctx.group(root, mx, 0, mz, 0);
      ctx.put(pot, new THREE.CylinderGeometry(0.16, 0.12, 0.26, 18), toon(C.red), 0, 0.13, 0, { outline: OUT });
      ctx.put(pot, new THREE.CylinderGeometry(0.166, 0.163, 0.026, 18), gold, 0, 0.215, 0);
      ctx.put(pot, new THREE.CylinderGeometry(0.145, 0.145, 0.012, 16), toon(C.soil), 0, 0.256, 0);
      ctx.put(pot, new THREE.CylinderGeometry(0.018, 0.024, 0.2, 7), toon(PAL.oakDark), 0, 0.35, 0);
      const crown = [[0, 0.56, 0, 0.2, PAL.sageDeep], [0.08, 0.62, 0.07, 0.15, PAL.leaf], [-0.09, 0.52, -0.05, 0.14, PAL.leaf], [0.02, 0.7, -0.04, 0.12, PAL.sageDeep]];
      for (const [cx, cy, cz, cr, col] of crown) ctx.put(pot, new THREE.SphereGeometry(cr, 14, 10), toon(col), cx, cy, cz, { outline: OUT });
      const fruit = ctx.geo('fruit', () => new THREE.SphereGeometry(0.028, 10, 8));
      for (let i = 0; i < 13; i++) {
        const a = i * 2.4 + 0.3, e = -0.45 + (i % 5) * 0.3, rr = 0.205;
        ctx.put(pot, fruit, toon(C.mandarin), Math.sin(a) * Math.cos(e) * rr, 0.57 + Math.sin(e) * rr, Math.cos(a) * Math.cos(e) * rr, { outline: OUT });
      }
      const packet = ctx.put(pot, new THREE.BoxGeometry(0.05, 0.076, 0.006), toon(C.red), 0.15, 0.47, 0.13, { outline: OUT });  // a red packet tied on
      packet.rotation.y = Math.PI / 4;
      const seal = ctx.put(pot, new THREE.BoxGeometry(0.02, 0.02, 0.004), gold, 0.153, 0.475, 0.133);
      seal.rotation.y = Math.PI / 4;
      ctx.navRects.push([mx, mz, 0.36, 0.36]);
    }
  },

  midautumn(ctx) {
    const { g, root } = ctx;
    if (!g.door) return;
    const { Z0, XC, YC, CZ } = porch(g);
    // a festoon of five round paper lanterns on one swag under the canopy's front bar; each colour its own glow
    const mats = {
      white: glowMat(ctx, C.moonWhite, 0xffd6a0), peach: glowMat(ctx, C.peach, 0xffa77e), mustard: glowMat(ctx, PAL.mustard, 0xffbe5a),
    };
    const a = new THREE.Vector3(XC, YC, Z0 - CZ + 0.03), b = new THREE.Vector3(XC, YC, Z0 + CZ - 0.03), sag = 0.1;
    ctx.put(root, cordGeo(swagPoints(a, b, sag)), toon(PAL.ink), 0, 0, 0);
    const ball = r => ctx.geo(`moon${r}`, () => shell((t, f) => {
      const k = 1 - 0.035 * (0.5 - 0.5 * Math.cos(12 * f)), c = Math.cos(f);  // the paper's wire rings
      return new THREE.Vector3(r * k * c * Math.sin(t), r * 0.92 * k * Math.sin(f), r * k * c * Math.cos(t));
    }, 26));
    const cap = ctx.geo('mcap', () => new THREE.CylinderGeometry(0.036, 0.04, 0.022, 12));
    const lanterns = [['white', 0.1], ['peach', 0.112], ['mustard', 0.122], ['peach', 0.112], ['white', 0.1]];
    lanterns.forEach(([col, r], i) => {
      const p = swagAt(a, b, sag, 0.1 + i * 0.2), hb = r * 0.92, yb = p.y - 0.05 - 0.022 - hb;
      drop(ctx, root, p.x, p.y, yb + hb + 0.011, p.z);
      ctx.put(root, cap, toon(PAL.slateDark), p.x, yb + hb + 0.004, p.z);
      ctx.put(root, ball(r), mats[col], p.x, yb, p.z, { outline: OUT });
      ctx.put(root, cap, toon(PAL.slateDark), p.x, yb - hb - 0.004, p.z);
      ctx.put(root, ctx.geo('mtassel', () => new THREE.CylinderGeometry(0.006, 0.012, 0.07, 6)), toon(PAL.terracotta), p.x, yb - hb - 0.05, p.z);
    });
  },
};

// ---- lifecycle --------------------------------------------------------------------------------------------------------
let state = null;          // { season, ground, root, ctx, releaseNav }
let mgrRef = null, zone = DEFAULT_TZ, forced, timer = 0;

function clear() {
  if (!state) return;
  const { root, ctx, ground, releaseNav } = state;
  const lamps = ground.lamps;
  if (Array.isArray(lamps)) for (const m of ctx.glow) { const i = lamps.indexOf(m); if (i >= 0) lamps.splice(i, 1); }
  for (const o of [root, ...ctx.attached]) {
    o.parent?.remove(o);
    o.traverse(c => { if (c.isMesh) c.geometry.dispose(); });
  }
  for (const m of ctx.owned) { disposeVariants(m); m.dispose(); }
  for (const t of ctx.textures) t.dispose();
  releaseNav();
  state = null;
}
function build(season, g) {
  const root = new THREE.Group(); root.name = `season:${season}`; root.userData.season = season;
  const ctx = makeCtx(g, root);
  BUILD[season](ctx);
  g.group.add(root);
  freezeStatic(root);
  const mode = g.group.userData.mode;                  // joining a dimmed floor: take its look now (setMode only re-runs on a change)
  if (mode && mode !== 'normal') for (const o of [root, ...ctx.attached]) setMode(o, mode, { force: true, floor: true });
  const k = (NIGHT.lamps || 0) * GLOW_K;
  for (const m of ctx.glow) m.emissiveIntensity = k;
  if (Array.isArray(g.lamps)) g.lamps.push(...ctx.glow);
  state = { season, ground: g, root, ctx, releaseNav: holdNav(g.nav, ctx.navRects) };
}
function apply(season) {
  const g = mgrRef?.ground;
  if (!g?.group) return null;
  if (state && state.season === season && state.ground === g) return state;
  clear();
  if (season && BUILD[season]) build(season, g);
  return state;
}
function recheck() {
  if (!mgrRef) return;
  apply(forced !== undefined ? forced : seasonFor(new Date(), zone));
}
const handle = () => (state ? { season: state.season, group: state.root } : null);

/** Decorate the office for the current season. Call once the OfficeManager exists (its site and ground floor are built
 *  in its constructor). Safe to call again: same season → nothing changes; another season → the old one is removed.
 *  - params: URLSearchParams; `?season=` overrides the date (`none` = no decorations)
 *  - date:   the moment to judge (default now); tz: IANA zone for the local date (default the viewer's zone)
 *  - season: an explicit season (or null), overriding both
 *  Returns { season, group } or null. In a browser a one-minute timer re-checks the date and re-decorates if needed. */
export function decorate({ mgr, date, params, tz, season } = {}) {
  if (!mgr?.ground?.group) return null;
  mgrRef = mgr;
  if (tz) zone = validZone(tz);
  const want = season !== undefined ? parseSeason(season ?? 'none') : parseSeason(params?.get?.('season'));
  forced = want;
  apply(want !== undefined ? want : seasonFor(date || new Date(), zone));
  if (!timer && typeof window !== 'undefined') timer = setInterval(recheck, 60000);
  return handle();
}
/** The zone whose calendar decides the season (e.g. snapshot.config.timeZone); re-checks at once. */
export function setTimeZone(tz) {
  const z = validZone(tz);
  if (z !== zone) { zone = z; recheck(); }       // cheap to call with every snapshot: only a new zone re-checks
  return handle();
}
/** Remove the decorations (and stop re-checking). */
export function undecorate() { clear(); if (timer) { clearInterval(timer); timer = 0; } }
