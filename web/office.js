// The office set: floor, walls with windows, door, team pods (a main desk plus satellite helper desks),
// kitchenette, a work café, lounge, a review room for reviewers, a huddle room, a core with three WCs and the lift, a fire
// exit (a balcony and outdoor fire stairs above the ground floor), two focus pods, plants, clock, a cat.
import * as THREE from 'three';
import { toon as cachedToon, matte as cachedMatte, gradientMap, box, sphere, cyl, mesh, roundedBox, capsule } from './toon.js';
import { VENDOR } from './palette.js';
import { NavGrid } from './nav.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { freezeStatic } from './merge.js';
import { windowPlan, wallGeometry, shellGeometry, wallPoint, barsOf } from './openings.js';
import { buildJobKit } from './jobprops.js';
import { setMode as setDisplayMode, disposeVariants } from './ghost.js';
import { paintDayBoard, DAYBOARD_W, DAYBOARD_H } from './dayboard.js';

// Materials shared between floors (the toon()/matte() caches, the exit sign, the day board face) must survive a floor's
// dispose(); everything else a floor builds (canvases, screens, glows, carpets, posters) is its own and is freed with it.
const SHARED = new WeakSet();
const toon = (color, opts) => { const m = cachedToon(color, opts); SHARED.add(m); return m; };
const matte = (color, opts) => { const m = cachedMatte(color, opts); SHARED.add(m); return m; };
function isShared(m) {
  if (SHARED.has(m) || m.isShaderMaterial || m.userData?.baked || m.userData?.shared) return true;
  return !!(m.isMeshToonMaterial && m.gradientMap === gradientMap() && !m.userData?.own); // toon() from another module
}
const TEX_SLOTS = ['map', 'alphaMap', 'emissiveMap', 'aoMap', 'lightMap', 'bumpMap', 'normalMap', 'roughnessMap', 'metalnessMap'];
/** free a floor: geometry, its own materials (and their display variants), their textures and canvases */
function disposeFloor(group, extraTex = []) {
  const mats = new Set(), texs = new Set(extraTex);
  group.traverse(o => {
    if (o.geometry && !keepGeo.has(o.geometry)) o.geometry.dispose?.();
    const m = o.userData?.origMat || o.material; // a dimmed / ghosted mesh wears a cached variant: free the original
    for (const x of [m].flat()) if (x) mats.add(x);
  });
  for (const m of mats) {
    if (isShared(m)) continue;
    for (const k of TEX_SLOTS) { const t = m[k]; if (t?.isTexture && t !== gradientMap()) texs.add(t); }
    disposeVariants(m); m.dispose();
  }
  for (const t of texs) {
    t.dispose();
    const img = t.image; // a canvas keeps its backing store until it is shrunk (Safari holds it long after the last reference)
    if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) { img.width = 0; img.height = 0; }
  }
}
/** springs (the doors) integrate with at most this step, and recover from a non-finite state instead of vanishing */
const SPRING_DT = 1 / 30;

// Environment palette: cream, light oak, one slate upholstery; sage, terracotta and mustard are the only accents.
// Brand colours (Claude orange, Codex teal, helper lavender, reviewer blue) are reserved for people, screens and UI.
export const PAL = {
  cream: 0xfaf5ee, trim: 0xe6dccf, sageLight: 0xdfe6d6, sage: 0x9db892, sageDeep: 0x6f9a6c, leaf: 0x8fbf84,
  oak: 0xead8bb, oakMid: 0xd6b993, oakDark: 0xb79470, slate: 0x7a8599, slateLight: 0xb2bac8, slateDark: 0x565e6e,
  terracotta: 0xcf8466, blush: 0xead2c2, mustard: 0xe2b35d, paper: 0xfbf8f2, ink: 0x3f3a4a, metal: 0xb9b2a8,
};
const COLORS = {
  floor: 0xe6d2b5, floorSide: 0xc4bbac, wall: PAL.cream, wallTrim: PAL.trim, wainscot: PAL.sageLight, rail: 0xffffff,
  desk: PAL.oak, deskLeg: PAL.oakMid, chair: PAL.slateDark, chairSeat: PAL.slate, monitor: PAL.ink, keyboard: PAL.paper,
  helperDesk: PAL.oak, helperChair: PAL.slateLight,
  counter: PAL.oakMid, counterTop: PAL.paper, machine: PAL.slateDark, rug: PAL.blush, sofa: PAL.slate, sofaCushion: PAL.slateLight,
  table: PAL.oak, pot: PAL.terracotta, leaf: PAL.leaf, leaf2: PAL.sageDeep, shelf: PAL.oakMid, book: [PAL.terracotta, PAL.mustard, PAL.sage, PAL.slate, PAL.blush],
  frame: 0xffffff, glass: 0xdfe8ea, door: PAL.oakMid, doorKnob: PAL.mustard, cat: 0xf0b56b, catDark: 0xd99a4f, qa: PAL.oak,
  // physical standards, kept recognisable but softened to sit in the palette
  exitGreen: 0x4f9a6a, extRed: 0xc9554a, cold: 0x7fa6c9, hot: PAL.terracotta, water: 0xcfe3e6, screenOff: 0x4a4656,
  ledIdle: 0xd98a7c, ledOn: 0x8fd6a0, ledOff: 0x4f8a5c, felt: [PAL.sage, PAL.slateLight, PAL.oakMid, PAL.blush],
};
const SCREEN_OFF = COLORS.screenOff;
/** mark architecture (walls, stairs, the core, doors): it stays drawn when the floor is a ghost; furniture does not */
const arch = o => { o.traverse(c => { c.userData.arch = true; }); return o; };
/** props rebuilt at runtime join a floor that may be dimmed or ghosted: give the new subtree the floor's current mode */
function reapplyMode(floorGroup, node) {
  const m = floorGroup?.userData.mode;
  if (node && m && m !== 'normal') setDisplayMode(node, m, { force: true, floor: true });
}
const hash2 = (x, z) => { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); };

function plankTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#e6d3b7'; g.fillRect(0, 0, 512, 512);
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const y = r * (512 / rows), offset = (r % 2) * 128;
    for (let k = -1; k < 3; k++) {
      const x = offset + k * 256, shade = 0.97 + ((r * 7 + k * 13) % 5) * 0.015; // calm boards: a whisper of variation
      g.fillStyle = `rgb(${Math.round(Math.min(255, 230 * shade))}, ${Math.round(Math.min(255, 211 * shade))}, ${Math.round(Math.min(255, 183 * shade))})`;
      g.fillRect(x + 2, y + 2, 252, 512 / rows - 4);
    }
  }
  g.strokeStyle = 'rgba(120,80,50,0.10)'; g.lineWidth = 2;
  for (let r = 0; r <= rows; r++) { g.beginPath(); g.moveTo(0, r * 64); g.lineTo(512, r * 64); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

function carpetTexture() { // 60 cm carpet tiles laid in alternating pile direction, warm neutral
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) {
    const shade = (r + k) % 2 ? '#d2d4c0' : '#d8d9c6';
    g.fillStyle = shade; g.fillRect(k * 64, r * 64, 64, 64);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
    for (let i = 4; i < 64; i += 6) { g.beginPath(); if ((r + k) % 2) { g.moveTo(k * 64 + i, r * 64); g.lineTo(k * 64 + i, r * 64 + 64); } else { g.moveTo(k * 64, r * 64 + i); g.lineTo(k * 64 + 64, r * 64 + i); } g.stroke(); }
  }
  g.strokeStyle = 'rgba(90,96,78,0.08)'; g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function tileTexture() { // 30 cm porcelain tiles with grout
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = '#c9c4bd'; g.fillRect(0, 0, 256, 256);
  for (let r = 0; r < 8; r++) for (let k = 0; k < 8; k++) { g.fillStyle = (r * 3 + k * 5) % 7 < 3 ? '#f1eee9' : '#ebe7e1'; g.fillRect(k * 32 + 1.5, r * 32 + 1.5, 29, 29); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

/** a soft round light pool: white in the middle, fading to nothing at the rim (CircleGeometry UVs); one per floor */
function glowTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128; const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 63);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,0.6)'); r.addColorStop(0.7, 'rgba(255,255,255,0.16)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 128); g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** soft contact shadows under furniture: one blurred rounded-rectangle pool (alpha only), shared by every floor; each floor
 *  gathers its pools into one transparent mesh, so they cost a single draw and ground the furniture in flat daylight */
let contactMat = null;
function contactShadowMat() {
  if (contactMat) return contactMat;
  const N = 64, c = document.createElement('canvas'); c.width = N; c.height = N; const g = c.getContext('2d');
  const img = g.createImageData?.(N, N);
  if (img?.data) {
    const b = 0.5, r = 0.3, f = 0.5; // half-size of the solid core, its corner radius, the feather out to the rim
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const px = Math.abs((i + 0.5) / N * 2 - 1), py = Math.abs((j + 0.5) / N * 2 - 1);
      const d = Math.hypot(Math.max(px - b + r, 0), Math.max(py - b + r, 0)) - r;
      let a = Math.max(0, Math.min(1, 1 - d / f)); a = a * a * (3 - 2 * a);
      const k = (j * N + i) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  contactMat = new THREE.MeshBasicMaterial({ color: 0x4a3a30, map: t, transparent: true, opacity: 0.18, depthWrite: false });
  SHARED.add(contactMat);
  return contactMat;
}

function posterTexture(kind) { // room palette only: brand colours belong to the people
  const c = document.createElement('canvas'); c.width = 256; c.height = 320;
  const g = c.getContext('2d');
  if (kind === 'mountain') {
    const sky = g.createLinearGradient(0, 0, 0, 320); sky.addColorStop(0, '#ead2c2'); sky.addColorStop(1, '#faf5ee'); g.fillStyle = sky; g.fillRect(0, 0, 256, 320);
    g.fillStyle = '#e2b35d'; g.beginPath(); g.arc(180, 110, 42, 0, 7); g.fill();
    g.fillStyle = '#b2bac8'; g.beginPath(); g.moveTo(0, 300); g.lineTo(90, 150); g.lineTo(170, 300); g.fill();
    g.fillStyle = '#7a8599'; g.beginPath(); g.moveTo(110, 300); g.lineTo(200, 120); g.lineTo(256, 240); g.lineTo(256, 300); g.fill();
    g.fillStyle = '#fbf8f2'; g.beginPath(); g.moveTo(90, 150); g.lineTo(70, 185); g.lineTo(110, 185); g.fill();
    g.fillStyle = '#9db892'; g.fillRect(0, 290, 256, 30);
  } else if (kind === 'coffee') {
    g.fillStyle = '#faf5ee'; g.fillRect(0, 0, 256, 320);
    g.fillStyle = '#cf8466'; g.font = 'bold 40px "M PLUS Rounded 1c", sans-serif'; g.fillText('COFFEE', 32, 70);
    g.fillStyle = '#fbf8f2'; g.strokeStyle = '#3f3a4a'; g.lineWidth = 8; g.beginPath(); g.roundRect(60, 120, 120, 110, 14); g.fill(); g.stroke();
    g.beginPath(); g.arc(188, 175, 28, -1.3, 1.3); g.stroke();
    g.strokeStyle = '#b2bac8'; g.lineWidth = 6; for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(90 + i * 30, 105); g.quadraticCurveTo(100 + i * 30, 85, 90 + i * 30, 65); g.stroke(); }
    g.fillStyle = '#6f9a6c'; g.font = '22px "M PLUS Rounded 1c", sans-serif'; g.fillText('first, then code', 36, 285);
  } else {
    g.fillStyle = '#dfe6d6'; g.fillRect(0, 0, 256, 320);
    const cols = ['#cf8466', '#6f9a6c', '#e2b35d', '#7a8599', '#ead2c2'];
    for (let i = 0; i < 5; i++) { g.fillStyle = cols[i]; g.beginPath(); g.arc(50 + i * 40, 150 + Math.sin(i) * 50, 26, 0, 7); g.fill(); }
    g.fillStyle = '#3f3a4a'; g.font = 'bold 26px "M PLUS Rounded 1c", sans-serif'; g.fillText('one team', 70, 280);
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
/** A tree, `scale` 1 ≈ 2.5 m. Species (third argument, or a species name passed as `tint`):
 *   'round' (default) – the broad canopy of five blobs; 'hornbeam' – a columnar hornbeam, three narrow stacked crowns;
 *   'conifer' – a small fir of stacked sage cones; 'birch' – a pale trunk with dark marks and a light, airy crown.
 *  `tint` (a number) rotates the greens, so neighbours of one species are not identical. */
export const TREE_SPECIES = ['round', 'hornbeam', 'conifer', 'birch'];
export function tree(scale = 1, tint = 0, species = 'round') {
  if (typeof tint === 'string') { species = tint; tint = 0; }
  tint = Math.abs(Math.round(Number(tint) || 0));
  const g = new THREE.Group(), s = scale;
  const greens = [PAL.leaf, PAL.sageDeep, PAL.sage];
  if (species === 'hornbeam') {
    g.add(cyl(0.09 * s, 0.13 * s, 1.0 * s, toon(PAL.oakDark), { y: 0.5 * s, outline: 0.012 }, 10));
    [[0, 1.25, 0, 0.42], [0.04, 1.85, -0.03, 0.4], [-0.02, 2.4, 0.03, 0.3]].forEach(([x, y, z, r], i) => {
      const c = sphere(r * s, toon(greens[(i + tint) % 3]), { x: x * s, y: y * s, z: z * s, outline: 0.016 }, 14); c.scale.set(1, 1.4, 1); g.add(c);
    });
  } else if (species === 'conifer') {
    g.add(cyl(0.07 * s, 0.1 * s, 0.5 * s, toon(PAL.oakDark), { y: 0.25 * s, outline: 0.012 }, 8));
    const tiers = tint % 2 ? [[0.62, 0.85, 0.75], [0.46, 0.72, 1.3], [0.28, 0.6, 1.78]] : [[0.58, 0.9, 0.8], [0.36, 0.75, 1.42]];
    tiers.forEach(([r, h, y], i) => g.add(mesh(new THREE.ConeGeometry(r * s, h * s, 12), toon(i % 2 ? PAL.sage : PAL.sageDeep), { y: y * s, outline: 0.014 })));
  } else if (species === 'birch') {
    g.add(cyl(0.07 * s, 0.1 * s, 1.5 * s, toon(PAL.paper), { y: 0.75 * s, outline: 0.012 }, 10));
    for (const [y, a] of [[0.35, 0.4], [0.7, 2.6], [1.05, 4.4], [1.3, 1.5]]) g.add(box(0.05 * s, 0.025 * s, 0.03 * s, toon(PAL.ink), { x: Math.cos(a) * 0.085 * s, y: y * s, z: Math.sin(a) * 0.085 * s, cast: false }));
    const birchGreens = [PAL.leaf, PAL.sage, PAL.leaf];
    [[0, 1.85, 0, 0.5], [0.32, 1.6, 0.12, 0.34], [-0.3, 1.66, -0.1, 0.36], [0.05, 2.25, 0.05, 0.32]].forEach(([x, y, z, r], i) =>
      g.add(sphere(r * s, toon(birchGreens[(i + tint) % 3]), { x: x * s, y: y * s, z: z * s, outline: 0.016 }, 14)));
  } else {
    const trunk = cyl(0.12 * s, 0.16 * s, 1.2 * s, toon(PAL.oakDark), { y: 0.6 * s, outline: 0.012 }, 10); g.add(trunk);
    const blobs = [[0, 1.6, 0, 0.75], [0.45, 1.3, 0.2, 0.5], [-0.5, 1.35, -0.1, 0.52], [0.1, 1.25, -0.5, 0.45], [-0.1, 2.05, 0.1, 0.42]];
    blobs.forEach(([x, y, z, r], i) => g.add(sphere(r * s, toon(greens[(i + tint) % 3]), { x: x * s, y: y * s, z: z * s, outline: 0.016 }, 14)));
  }
  return g;
}

// Plants: four species and four pots, picked from the plant's position so the same spot always grows the same plant
//   round – the bushy default; snake – upright sword leaves; fiddle – a tall fiddle-leaf fig on a stem;
//   pothos – a small trailing plant for shelves, its vines hanging over the edge
const POTS = [PAL.terracotta, PAL.paper, PAL.sage, PAL.oakMid];
const SOIL = 0x6b4b3a;
function plant(scale = 1, { kind = 'round', pot = COLORS.pot } = {}) {
  const g = new THREE.Group(), s = scale;
  const potH = kind === 'fiddle' ? 0.34 : 0.3;
  g.add(cyl(0.2 * s, 0.15 * s, potH * s, toon(pot), { y: potH / 2 * s, outline: 0.012 }));
  g.add(cyl(0.17 * s, 0.17 * s, 0.02, toon(SOIL), { y: potH * s, cast: false }));
  const leafA = toon(COLORS.leaf), leafB = toon(COLORS.leaf2);
  if (kind === 'snake') {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + 0.4, r = (i % 2 ? 0.07 : 0.04) * s, h = (0.42 + ((i * 5) % 3) * 0.1) * s;
      const blade = capsule(0.045 * s, h, i % 3 ? leafB : toon(PAL.sage), { x: Math.cos(a) * r, y: potH * s + h / 2 + 0.03 * s, z: Math.sin(a) * r, outline: 0.01 });
      blade.scale.set(1, 1, 0.38); blade.rotation.set(Math.sin(a) * 0.14, -a, -Math.cos(a) * 0.14); g.add(blade);
    }
  } else if (kind === 'fiddle') {
    g.add(cyl(0.025 * s, 0.03 * s, 0.9 * s, toon(PAL.oakDark), { y: (potH + 0.45) * s }, 8));
    const leaves = [[0, 1.42, 0, 0.2], [0.17, 1.28, 0.07, 0.17], [-0.16, 1.32, -0.05, 0.18], [0.05, 1.18, -0.17, 0.16], [-0.06, 1.58, 0.08, 0.15], [0.12, 1.5, -0.1, 0.14], [-0.14, 1.12, 0.12, 0.15]];
    leaves.forEach(([x, y, z, r], i) => { const l = sphere(r * s, i % 2 ? leafB : leafA, { x: x * s, y: y * s, z: z * s, outline: 0.012 }, 12); l.scale.set(1, 1.25, 0.55); l.rotation.y = i * 1.1; g.add(l); });
  } else if (kind === 'pothos') {
    [[0, 0.4, 0, 0.15], [0.1, 0.36, 0.06, 0.11], [-0.1, 0.37, -0.04, 0.12]].forEach(([x, y, z, r], i) => g.add(sphere(r * s, i % 2 ? leafB : leafA, { x: x * s, y: y * s, z: z * s, outline: 0.01 }, 10)));
    for (const [a, len] of [[1.1, 4], [1.6, 3], [2.1, 5]]) { // vines trail forward over the shelf edge and down
      for (let k = 0; k < len; k++) {
        const rr = (0.2 + k * 0.08) * s, y = (0.3 - k * 0.12) * s;
        g.add(sphere(0.055 * s, k % 2 ? leafA : leafB, { x: Math.cos(a + k * 0.12) * rr, y, z: Math.sin(a + k * 0.12) * rr, outline: 0.008 }, 8));
      }
    }
  } else {
    const leaves = [[0, 0.52, 0, 0.24], [0.14, 0.42, 0.08, 0.17], [-0.15, 0.45, -0.05, 0.18], [0.04, 0.4, -0.16, 0.16], [-0.04, 0.62, 0.1, 0.14]];
    leaves.forEach(([x, y, z, r], i) => g.add(sphere(r * s, i % 2 ? leafB : leafA, { x: x * s, y: y * s, z: z * s, outline: 0.012 }, 14)));
  }
  return g;
}
/** a plant at a position, species and pot picked from the position (floor plants: round / snake / fiddle; shelf
 *  plants: round / snake / pothos). `kind` forces a species. */
function plantAt(scale, x, y, z, { shelf = false, kind = null, salt = 0 } = {}) {
  const h = hash2(x + salt * 3.1, z - salt * 1.7);
  const kinds = shelf ? ['pothos', 'round', 'snake', 'pothos'] : scale >= 0.8 ? ['fiddle', 'round', 'snake', 'fiddle'] : ['round', 'snake', 'round', 'snake'];
  const k = kind || kinds[Math.floor(h * 4) % 4];
  const p = plant(k === 'fiddle' ? scale * 0.95 : scale, { kind: k, pot: POTS[Math.floor(h * 97) % 4] });
  p.position.set(x, y, z); p.rotation.y = k === 'pothos' ? 0 : h * Math.PI * 2; // vines face the room
  return p;
}
function starBase(r = 0.27, color = PAL.slateDark) {
  const g = new THREE.Group(), mat = toon(color), wheel = toon(PAL.ink);
  g.add(cyl(0.05, 0.06, 0.06, mat, { y: 0.08 }, 10));
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * Math.PI * 2;
    const leg = box(r, 0.035, 0.05, mat, { x: Math.cos(a) * r / 2, y: 0.07, z: Math.sin(a) * r / 2 }); leg.rotation.y = -a; g.add(leg);
    g.add(sphere(0.03, wheel, { x: Math.cos(a) * r, y: 0.03, z: Math.sin(a) * r }, 8));
  }
  return g;
}
function canvasTex(w = 256, h = 64) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return { canvas: c, ctx: c.getContext('2d'), tex };
}
// green emergency exit sign (a physical standard, in a softened green): running figure, door and arrow in white
let exitSignMat = null;
function exitSign(arrow = 1) {
  if (!exitSignMat) {
    const { ctx, tex } = canvasTex(192, 64);
    ctx.fillStyle = '#4f9a6a'; ctx.fillRect(0, 0, 192, 64);
    ctx.strokeStyle = '#fbf8f2'; ctx.fillStyle = '#fbf8f2'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.strokeRect(20, 10, 30, 44);                                                                   // door
    ctx.beginPath(); ctx.arc(76, 15, 6, 0, 7); ctx.fill();                                          // running figure
    ctx.beginPath(); ctx.moveTo(74, 24); ctx.lineTo(68, 40); ctx.lineTo(58, 52); ctx.moveTo(68, 40); ctx.lineTo(80, 46); ctx.lineTo(84, 56); ctx.moveTo(73, 28); ctx.lineTo(86, 34); ctx.moveTo(73, 28); ctx.lineTo(62, 30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(110, 32); ctx.lineTo(166, 32); ctx.stroke();                           // arrow
    ctx.beginPath(); ctx.moveTo(150, 18); ctx.lineTo(170, 32); ctx.lineTo(150, 46); ctx.stroke();
    exitSignMat = new THREE.MeshBasicMaterial({ map: tex }); SHARED.add(exitSignMat);
  }
  const g = new THREE.Group();
  g.add(box(0.42, 0.16, 0.04, toon(COLORS.exitGreen), { cast: false, outline: 0.006 }));
  const face = mesh(new THREE.PlaneGeometry(0.38, 0.127), exitSignMat, { z: 0.024, cast: false }); if (arrow < 0) face.scale.x = -1; g.add(face);
  return g;
}
// the day board's face: one canvas shared by every floor's board (they all show the same day), so a floor built later
// shows the current content at once; dayboard.js decides what is written, paintDayBoard how it looks
let dayBoardFace = null;
function dayBoardSurface() {
  if (!dayBoardFace) {
    const t = canvasTex(DAYBOARD_W, DAYBOARD_H); t.tex.anisotropy = 8; // read at an angle: keep the marker text crisp
    let key = null;
    const draw = (view, force = false) => {
      const k = view ? JSON.stringify(view) : '';
      if (!force && k === key) return false; key = k;
      paintDayBoard(t.ctx, view || null, DAYBOARD_W, DAYBOARD_H); t.tex.needsUpdate = true; return true;
    };
    draw(null);
    dayBoardFace = { mat: new THREE.MeshBasicMaterial({ map: t.tex }), draw }; SHARED.add(dayBoardFace.mat);
  }
  return dayBoardFace;
}
function fitText(ctx, text, maxW) { let t = String(text || ''); if (ctx.measureText(t).width <= maxW) return t; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }

// personal desk items: one per agent, chosen from its id, so the same agent keeps the same desk character (all original)
export const PERSONAL_KINDS = ['photo', 'cactus', 'succulent', 'robot', 'headphones', 'books', 'plush', 'globe'];
function personalItem(kind) {
  const g = new THREE.Group();
  switch (kind) {
    case 'photo': {
      const f = new THREE.Group(); f.position.y = 0.075; f.rotation.set(-0.25, 0.8, 0); g.add(f);
      f.add(box(0.13, 0.16, 0.014, toon(PAL.oakMid), { outline: 0.006 }));
      f.add(box(0.105, 0.06, 0.004, toon(0x9fc3d9), { y: 0.035, z: -0.009, cast: false }));
      f.add(box(0.105, 0.075, 0.004, toon(PAL.sage), { y: -0.03, z: -0.009, cast: false }));
      f.add(box(0.012, 0.09, 0.05, toon(PAL.oakMid), { y: -0.04, z: 0.03 }));                 // easel stand
      break;
    }
    case 'cactus':
      g.add(cyl(0.045, 0.035, 0.06, toon(PAL.terracotta), { y: 0.03, outline: 0.006 }, 12));
      g.add(capsule(0.028, 0.07, toon(PAL.sageDeep), { y: 0.11, outline: 0.006 }));
      { const arm = capsule(0.016, 0.03, toon(PAL.sageDeep), { x: 0.035, y: 0.11 }); arm.rotation.z = -0.6; g.add(arm); }
      g.add(sphere(0.014, toon(PAL.blush), { y: 0.168 }, 8));
      break;
    case 'succulent':
      g.add(cyl(0.06, 0.045, 0.04, toon(PAL.paper), { y: 0.02, outline: 0.006 }, 14));
      for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const l = sphere(0.022, toon(i % 2 ? PAL.leaf : PAL.sage), { x: Math.cos(a) * 0.03, y: 0.05, z: Math.sin(a) * 0.03 }, 8); l.scale.set(1, 0.6, 1.4); l.rotation.y = -a; g.add(l); }
      g.add(sphere(0.02, toon(PAL.sageDeep), { y: 0.058 }, 8));
      break;
    case 'robot':
      g.add(box(0.06, 0.06, 0.045, toon(PAL.paper), { y: 0.03, outline: 0.006 }));
      g.add(box(0.07, 0.05, 0.05, toon(PAL.slate), { y: 0.085, outline: 0.006 }));
      for (const sx of [-0.016, 0.016]) g.add(sphere(0.008, toon(PAL.mustard), { x: sx, y: 0.09, z: 0.026, cast: false }, 6));
      g.add(cyl(0.004, 0.004, 0.03, toon(PAL.slateDark), { y: 0.125 }, 4)); g.add(sphere(0.01, toon(PAL.terracotta), { y: 0.142 }, 6));
      g.rotation.y = 2.6; // faces its owner, three-quarters to the camera
      break;
    case 'headphones': {
      const band = mesh(new THREE.TorusGeometry(0.07, 0.01, 6, 18, Math.PI), toon(PAL.slateDark), { y: 0.012 }); band.rotation.x = -Math.PI / 2; g.add(band);
      for (const sx of [-0.07, 0.07]) g.add(cyl(0.035, 0.035, 0.025, toon(PAL.slate), { x: sx, y: 0.013, outline: 0.006 }, 14));
      g.rotation.y = 0.5;
      break;
    }
    case 'books':
      [PAL.terracotta, PAL.sage, PAL.mustard].forEach((c, i) => { const b = box(0.16 - i * 0.01, 0.028, 0.11, toon(c), { y: 0.014 + i * 0.029, outline: 0.006 }); b.rotation.y = (i - 1) * 0.15; g.add(b); });
      break;
    case 'plush': {
      const body = sphere(0.05, toon(PAL.blush), { y: 0.045, outline: 0.006 }, 14); body.scale.set(1, 0.9, 0.9); g.add(body);
      for (const sx of [-0.03, 0.03]) g.add(sphere(0.018, toon(PAL.blush), { x: sx, y: 0.09, outline: 0.005 }, 8));
      for (const sx of [-0.016, 0.016]) g.add(sphere(0.006, toon(PAL.ink), { x: sx, y: 0.052, z: -0.044, cast: false }, 6));
      break;
    }
    case 'globe':
      g.add(cyl(0.035, 0.04, 0.012, toon(PAL.oakDark), { y: 0.006 }, 14));
      g.add(cyl(0.005, 0.005, 0.05, toon(PAL.oakDark), { y: 0.035 }, 6));
      g.add(sphere(0.05, toon(0x9fc3d9), { y: 0.1, outline: 0.006 }, 16));
      { const m = mesh(new THREE.TorusGeometry(0.056, 0.004, 6, 24), toon(PAL.metal), { y: 0.1 }); m.rotation.y = 0.4; g.add(m); }
      break;
  }
  return g;
}
const crumpleGeo = new THREE.IcosahedronGeometry(0.034, 0);

function book(w, h, color) { return box(w, h, 0.22, toon(color), { outline: 0.01 }); }

export const CELL_W = 4.4, CELL_D = 4.2, ROW_PITCH = 5.2;
export const FLOOR_H = 3.6;
export const officeClock = { now: () => new Date() }; // what the wall clocks read; a preview hour (?hour) moves it
const SHELL_MAT = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide }); SHELL_MAT.userData.shared = true;
const WINDOW_VARIANT = (() => { try { return new URLSearchParams(globalThis.location?.search || '').get('windows'); } catch { return null; } })(); // other windows to check the light with
export const NIGHT = { lamps: 0 };   // 0 by day → 1 at night; set by the daylight cycle        // floor-to-floor height
export const FLOOR_COLS = 3, FLOOR_ROWS = 2;
const STAIR_RUN = 5.2, STAIR_W = 0.95, STAIR_STEPS = 20; // 20 risers of 0.18 m on 0.26 m goings: a comfortable office stair
export const SLAB = 0.3;                 // floor slab thickness; walls rise to the underside of the slab above
// The floor is zoned by noise and privacy from the entrance inward (left to right):
//   entrance + stairs | social: pantry (back) and lounge (front) | shared rooms: meeting room (back), print island (front)
//   | open work: six pods on one rectangular carpet | quiet: the review room (back), huddle room and focus pods (front)
const LEFT = 6.0;                        // entrance band: door, the stairwell, the core (WCs, lift) and a small lobby
const SOCIAL = 4.6, BUFFER = 3.9, QUIET = 5.6;
const LANE_A = 0.2 + 0.02 + STAIR_W / 2;  // lane centres measured from the inner face of the left wall
const LANE_GAP = 0.2;                     // between the two lanes: room for one solid spine balustrade
const LANE_B = LANE_A + STAIR_W + LANE_GAP;
const SPINE_X = LANE_A + STAIR_W / 2 + LANE_GAP / 2, SPINE_W = 0.15, GUARD_H = 1.05;
/** Flight k runs in lane A (even k) or lane B (odd k), always rising toward the back wall, away from the camera, so you
 *  always see treads, never the tall back of a flight. Alternating lanes means each floor's flight sits beside, never on
 *  top of, the opening for the flight below (a scissor stack). */
export function flightFor(k, hx, hz) {
  const front = hz - 1.2 - 1.5, back = front - STAIR_RUN;
  const even = k % 2 === 0;
  const x = -hx + (even ? LANE_A : LANE_B);
  const zs = front, ze = back, d = -1;
  return { k, x, zs, ze, d, lane: even ? 'A' : 'B',
    foot: { x, z: zs - d * 0.4 },        // stand here (floor k) before stepping onto the first tread
    top: { x, z: ze },                   // edge of the top tread (= edge of the opening in floor k+1)
    exit: { x, z: ze + d * 0.6 } };      // first spot on floor k+1 clear of the opening
}
export function stairHeight(f, z) { // height above floor k of a person standing at z on flight f (stepped, not a ramp)
  const rise = FLOOR_H / STAIR_STEPS;
  const u = Math.max(0, Math.min(1, (z - f.zs) / (f.ze - f.zs))) * STAIR_STEPS;
  const k = Math.floor(u), frac = u - k;
  const lift = Math.min(1, frac / 0.45); const s = lift * lift * (3 - 2 * lift);
  return Math.min(FLOOR_H, (k + s) * rise);
}

export function buildOffice(scene, cols, rows, { level = 0 } = {}) {
  const group = new THREE.Group(); group.userData.isFloor = true;
  const applyMode = node => reapplyMode(group, node);
  group.position.y = level * FLOOR_H;
  const hasDoor = level === 0, hasHole = level > 0;
  // wayfinding: one accent per floor (terracotta / sage / mustard, repeating upward) on the core's painted faces, the
  // lift surround and the floor sign, so you can tell the floors apart at a glance
  const ACCENT = [PAL.terracotta, PAL.sage, PAL.mustard][level % 3], ACCENT_DEEP = [0xb5705a, PAL.sageDeep, 0xc9963f][level % 3];
  const accentCss = c => '#' + c.toString(16).padStart(6, '0');
  let canopyLight = null; // set by the porch, lit at night
  let copier = null, cooler = null;
  const W = LEFT + SOCIAL + BUFFER + cols * CELL_W + QUIET;
  const D = 1.2 + rows * ROW_PITCH + 1.2;
  const hx = W / 2, hz = D / 2;
  const xSoc0 = -hx + LEFT, xBuf0 = xSoc0 + SOCIAL, xWork0 = xBuf0 + BUFFER, xQuiet0 = xWork0 + cols * CELL_W;
  const sx = xSoc0 + SOCIAL / 2;          // centre of the social band
  const wallH = FLOOR_H - SLAB; // walls meet the underside of the floor above: no gap
  const staticObs = [];                     // [x, z, w, d, rot]
  const obs = (x, z, w, d, rot = 0) => staticObs.push([x, z, w, d, rot]);
  const contacts = [];                      // soft contact shadows: [x, z, w, d], gathered into one mesh at the end
  const contact = (x, z, w, d) => contacts.push([x, z, w, d]);

  // ---------- floor & porch ----------
  const floorTex = plankTexture();
  const glowTex = glowTexture();     // night light pools: the ceiling lights' and the desk lamps'
  const zDoor = hz - 1.2;
  const flight = flightFor(level, hx, hz);                       // the flight that starts on this floor
  const below = hasHole ? flightFor(level - 1, hx, hz) : null;    // the flight arriving through this floor's opening
  const post = toon(PAL.oakDark), guardRail = toon(PAL.paper);
  const addRail = (x1, z1, x2, z2, y0 = 0, parent = group) => { // a 1.05 m guard rail: posts and a round top rail
    const len = Math.hypot(x2 - x1, z2 - z1), n = Math.max(2, Math.round(len / 0.75));
    for (let i = 0; i <= n; i++) parent.add(arch(cyl(0.025, 0.025, GUARD_H, post, { x: x1 + (x2 - x1) * i / n, y: y0 + GUARD_H / 2, z: z1 + (z2 - z1) * i / n }, 8)));
    const r = cyl(0.03, 0.03, len, guardRail, { x: (x1 + x2) / 2, y: y0 + GUARD_H, z: (z1 + z2) / 2 }, 8);
    r.rotation.z = Math.PI / 2; r.rotation.y = -Math.atan2(z2 - z1, x2 - x1); parent.add(arch(r));
  };
  const hw = STAIR_W / 2 + 0.03;
  let floor;
  if (!hasHole) {
    floorTex.repeat.set(W / 3, D / 3);
    floor = mesh(new THREE.BoxGeometry(W, SLAB, D), [
      matte(COLORS.floorSide), matte(COLORS.floorSide), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }),
      matte(COLORS.floorSide), matte(COLORS.floorSide), matte(COLORS.floorSide)], { y: -SLAB / 2, cast: false, receive: true });
  } else {
    floorTex.repeat.set(1 / 3, 1 / 3);
    const shape = new THREE.Shape(); shape.moveTo(-hx, -hz); shape.lineTo(hx, -hz); shape.lineTo(hx, hz); shape.lineTo(-hx, hz); shape.closePath();
    // the opening: lane of the flight below, from just beyond its foot to exactly its top tread edge
    const zA = below.zs - below.d * 0.1, zB = below.ze;
    const hole = new THREE.Path();
    hole.moveTo(below.x - hw, Math.min(zA, zB)); hole.lineTo(below.x + hw, Math.min(zA, zB)); hole.lineTo(below.x + hw, Math.max(zA, zB)); hole.lineTo(below.x - hw, Math.max(zA, zB)); hole.closePath();
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: SLAB, bevelEnabled: false });
    geo.rotateX(Math.PI / 2); // shape (x, y) -> world (x, z); extrude goes downward from the floor surface
    floor = mesh(geo, [new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }), matte(COLORS.floorSide)], { y: 0, cast: false, receive: true });
    // guard rails on the open sides of the opening: the room side and the front edge. The side between the two lanes
    // is the solid spine balustrade (built with the stairs), the wall side needs none, the arrival edge stays open.
    const xr = below.x + hw + 0.04, xl = below.x - hw - 0.04, zFar = below.zs - below.d * 0.1;
    const xSpine = -hx + SPINE_X;
    if (below.lane === 'B') { addRail(xr, zA, xr, zB); addRail(xSpine + SPINE_W / 2, zFar, xr, zFar); }
    else addRail(-hx + 0.2, zFar, xSpine - SPINE_W / 2, zFar);
  }
  floor.userData.slab = true;
  group.add(floor);
  const doorLeaf = 0.9, doorW = 2 * doorLeaf, doorH = 2.15, jamb = 0.08; // the entrance: a double door, two 0.9 m leaves
  if (hasDoor) {
    group.add(box(3.0, 0.3, 2.5, matte(0xd5d1ca), { x: -hx - 1.5, y: -0.15, z: zDoor, cast: false, receive: true }));
    group.add(box(0.8, 0.015, 1.5, toon(PAL.oakDark), { x: -hx - 0.75, y: 0.008, z: zDoor, cast: false, receive: true }));   // outdoor mat
    // glass canopy: a slim light frame with frosted glass, so it reads as a canopy and never hides who is under it
    const cFrame = toon(PAL.paper), cz2 = doorW / 2 + 0.25;
    for (const [w, d, x, z] of [[1.0, 0.05, -hx - 0.5, zDoor - cz2], [1.0, 0.05, -hx - 0.5, zDoor + cz2], [0.05, 2 * cz2 + 0.04, -hx - 0.98, zDoor]]) group.add(box(w, 0.06, d, cFrame, { x, y: 2.42, z, outline: 0.008 }));
    const cGlass = mesh(new THREE.BoxGeometry(0.94, 0.02, 2 * cz2 - 0.04), new THREE.MeshStandardMaterial({ color: 0xe4f0f4, transparent: true, opacity: 0.35, roughness: 0.2, depthWrite: false }), { x: -hx - 0.52, y: 2.43, z: zDoor, cast: false });
    cGlass.renderOrder = 3; group.add(cGlass);
    for (const dz of [-cz2, cz2]) { const br = box(0.7, 0.03, 0.03, toon(PAL.paper), { x: -hx - 0.35, y: 2.15, z: zDoor + dz, cast: false }); br.rotation.z = -0.55; group.add(br); }
    canopyLight = toon(0xfff1c9, { emissive: 0xffd88a, emissiveIntensity: 0 }).clone(); canopyLight.userData.own = true; // its own material: the street lamp heads share the cached one and are lit to a different level
    group.add(cyl(0.08, 0.08, 0.04, canopyLight, { x: -hx - 0.2, y: 2.3, z: zDoor, cast: false }, 14));  // downlight on the wall above the door
    for (const dz of [-1.0, 1.0]) {
      group.add(box(0.42, 0.42, 0.42, toon(PAL.slateDark), { x: -hx - 2.72, y: 0.21, z: zDoor + dz, outline: 0.01 }));
      group.add(box(0.36, 0.02, 0.36, toon(SOIL), { x: -hx - 2.72, y: 0.425, z: zDoor + dz, cast: false }));
      [[0, 0.62, 0, 0.2], [0.1, 0.55, 0.08, 0.14], [-0.1, 0.56, -0.06, 0.15]].forEach(([x, y, z, r], i) => group.add(sphere(r, toon(i % 2 ? PAL.sageDeep : PAL.leaf), { x: -hx - 2.72 + x, y, z: zDoor + dz + z, outline: 0.01 }, 12)));
    }
    group.add(box(1.0, 0.02, 1.6, toon(PAL.terracotta), { x: -hx + 0.75, y: 0.011, z: zDoor, cast: false, receive: true }));   // entrance mat
  }

  // ---------- walls ----------
  const wallMat = matte(COLORS.wall), trimMat = matte(COLORS.wallTrim);
  const addWallSeg = (w, h, d, x, y, z) => { const m = box(w, h, d, wallMat, { x, y, z, cast: false, receive: true }); group.add(arch(m)); return m; };
  const addA = m => { group.add(arch(m)); return m; };            // architecture that is not a plain wall segment
  const winW = 1.6, sillY = 0.85, winTop = 2.6;
  // the fire exit: a 1.0 m door in the back wall at the end of the 1.1 m aisle between the last desks and the review
  // room, on every floor, so it is seen straight down the back walkway and the aisle
  const fireW = 1.0, xFire = xQuiet0 + 0.52, xo0 = xFire - fireW / 2 - jamb, xo1 = xFire + fireW / 2 + jamb;
  // windows only behind the meeting room, the desks and the review room; the pantry and the entrance band keep a
  // solid wall for the counter, the core and the stairs; the windows stop short of the fire exit on both sides
  const winX = [];
  { const a = xBuf0 + 0.9, b = xo0 - 0.52, n = Math.max(2, Math.round((b - a) / 3.6)); for (let i = 0; i < n; i++) winX.push(a + winW / 2 + (b - a - winW) * i / (n - 1)); }
  { const a = xo1 + 0.45, b = hx - 0.35, n = Math.max(1, Math.round((b - a) / 1.8)); for (let i = 0; i < n; i++) winX.push(n === 1 ? (a + b) / 2 : a + winW / 2 + (b - a - winW) * i / (n - 1)); }
  // One list of openings: the walls are cut from it, the windows fitted to it, and the shell that stops the sun made from it
  const zo0 = zDoor - doorLeaf - jamb, zo1 = zDoor + doorLeaf + jamb; // the entrance opening, frames included
  const floorBox = { hx, hz };
  const openings = windowPlan(winX, { w: winW, sill: sillY, top: winTop }, WINDOW_VARIANT, { hx, hz, wallTop: wallH });
  const doorways = [{ wall: 'back', at: xFire, w: xo1 - xo0, sill: 0, top: doorH, light: false }];
  if (hasDoor) doorways.push({ wall: 'west', at: zDoor, w: zo1 - zo0, sill: 0, top: doorH, light: false });
  const holesIn = wall => [...openings, ...doorways].filter(o => o.wall === wall);
  const stripAround = (h, y, d, z, mat) => { // a band along the back wall, stopping at whatever opening it would cross
    const cuts = holesIn('back').filter(o => o.sill < y + h / 2 && o.top > y - h / 2).sort((p, q) => p.at - q.at);
    let c = -hx;
    for (const o of [...cuts, null]) {
      const end = o ? o.at - o.w / 2 : hx;
      if (end > c + 0.001) addA(box(end - c, h, d, mat, { x: (c + end) / 2, y, z, cast: false }));
      if (o) c = o.at + o.w / 2;
    }
  };
  addA(mesh(wallGeometry('back', floorBox, { u0: -hx, u1: hx, v0: -0.01, v1: wallH }, holesIn('back')), wallMat, { cast: false }));
  addA(mesh(wallGeometry('west', floorBox, { u0: -hz, u1: hz, v0: -0.01, v1: wallH }, holesIn('west')), wallMat, { cast: false }));
  obs(0, -hz + 0.1, W, 0.2);
  if (hasDoor) {
    obs(-hx + 0.1, (-hz + zo0) / 2, 0.2, zo0 + hz);
    obs(-hx + 0.1, (hz + zo1) / 2, 0.2, hz - zo1);
  } else {
    obs(-hx + 0.1, 0, 0.2, D);
  }
  const windows = [], windowSpots = [];
  const windowGlass = new THREE.MeshBasicMaterial({ color: COLORS.glass, transparent: true, opacity: 0.38 }); windowGlass.userData.mergeable = true; // one material: every pane batches into one draw
  const frameMat = matte(COLORS.frame), blindMat = matte(0xf3eee5), blindRail = matte(0xe3ddd2), blindCord = matte(0xd9d2c5);
  const WALL_TURN = { back: 0, west: Math.PI / 2, front: Math.PI, east: -Math.PI / 2 };
  for (const o of openings.filter(q => q.wall === 'back' || q.wall === 'west')) { // the cutaway has no front or east wall to fit a window in: there the opening only lets the sun in
    const { wall, at, w: ww, sill: s, top: t } = o, h = t - s, cv = (s + t) / 2, turn = WALL_TURN[wall];
    // frames and blinds are deeper than they are wide and would cut the sun down to slits: the shell's slim bars do that job
    const fit = (geo, mat, u, v, d, tilt = 0) => {
      const m = mesh(geo, mat, { cast: false, receive: false }), p = wallPoint(wall, floorBox, u, v, d);
      m.position.set(p[0], p[1], p[2]); m.rotation.set(tilt, turn, 0, 'YXZ');
      return addA(m);
    };
    const boxGeo = (a, b, c) => new THREE.BoxGeometry(a, b, c);
    if (o.shape === 'round') {
      const r = Math.min(ww, h) / 2;
      windows.push(fit(new THREE.CircleGeometry(r, 28), windowGlass, at, cv, 0.12));
      fit(new THREE.TorusGeometry(r, 0.05, 8, 28), frameMat, at, cv, 0.1);
      for (const b of barsOf(o)) fit(boxGeo(b.u1 - b.u0, b.v1 - b.v0, 0.14), frameMat, (b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2, 0.1);
    } else {
      windows.push(fit(new THREE.PlaneGeometry(ww, h), windowGlass, at, cv, 0.12));
      fit(boxGeo(ww + 0.12, 0.08, 0.26), frameMat, at, t + 0.02, 0.1);
      fit(boxGeo(ww + 0.12, 0.1, 0.34), frameMat, at, s - 0.03, 0.14);
      for (const side of [-1, 1]) fit(boxGeo(0.08, h, 0.26), frameMat, at + side * ww / 2, cv, 0.1);
      fit(boxGeo(0.05, h, 0.24), frameMat, at, cv, 0.1);
      fit(boxGeo(ww, 0.05, 0.24), frameMat, at, cv + 0.1, 0.1);
      // venetian blind, lowered about a third, slats tilted open
      fit(boxGeo(ww + 0.06, 0.07, 0.09), blindMat, at, t - 0.04, 0.24);
      for (let k = 0; k < 7; k++) fit(boxGeo(ww - 0.02, 0.012, 0.07), blindMat, at, t - 0.11 - k * 0.062, 0.25, 0.55);
      fit(boxGeo(ww, 0.03, 0.08), blindRail, at, t - 0.11 - 7 * 0.062, 0.25);
      fit(new THREE.CylinderGeometry(0.005, 0.005, 0.7, 4), blindCord, at + ww / 2 - 0.08, t - 0.45, 0.29);
    }
    if (wall === 'back') windowSpots.push({ x: at, z: -hz + 0.75, facing: Math.PI });
  }
  // the shell: never drawn, it only stops the sun (its own floor's only: main.js stands in for the rest of the building)
  const shell = new THREE.Mesh(shellGeometry(floorBox, [...openings, ...doorways], { height: wallH + 0.05 }), SHELL_MAT);
  shell.castShadow = true; shell.userData.noMode = shell.userData.noMerge = true; group.add(shell);
  // cut wall tops: a thin warm poché cap, so the cutaway reads as a crisp section line against the lawn
  const pocheMat = matte(0xbfb3a3);
  addA(box(W, 0.03, 0.2, pocheMat, { x: 0, y: wallH + 0.015, z: -hz + 0.1, cast: false }));
  addA(box(0.2, 0.03, D - 0.2, pocheMat, { x: -hx + 0.1, y: wallH + 0.015, z: 0.1, cast: false }));
  stripAround(0.12, 0.06, 0.05, -hz + 0.22, trimMat);
  // wainscot (lower band in soft sage) and a white picture rail
  const wainMat = matte(COLORS.wainscot), railMat = matte(COLORS.rail);
  stripAround(0.95, 0.475, 0.03, -hz + 0.215, wainMat);
  stripAround(0.06, 0.97, 0.06, -hz + 0.23, railMat);
  { const len = hasDoor ? zo0 + hz : D, zc = hasDoor ? (-hz + zo0) / 2 : 0;
    addA(box(0.05, 0.12, len, trimMat, { x: -hx + 0.22, y: 0.06, z: zc, cast: false }));
    addA(box(0.03, 0.95, len, wainMat, { x: -hx + 0.215, y: 0.475, z: zc, cast: false }));
    addA(box(0.06, 0.06, len, railMat, { x: -hx + 0.23, y: 0.97, z: zc, cast: false })); }
  // (the garden, trees and street outside are built once by site.js)
  // posters on the back wall between windows: the print sits just proud of its frame. Each poster (and the credenza
  // under it) is centred on the free part of its pier: clear of both windows and of the meeting room's side glass,
  // which can meet the wall partway along a pier; a pier with too little room for a 1.6 m credenza gets neither
  const posterKinds = ['mountain', 'coffee', 'team'];
  const posterX = winX.slice(1).map((x, i) => {
    const l = Math.max(winX[i] + winW / 2 + 0.08, xWork0 - 0.05), r = Math.min(x - winW / 2 - 0.08, xo0 - 0.3);
    return r - l >= 1.62 ? (l + r) / 2 : null;
  }).filter(x => x !== null).slice(0, 3);
  for (let i = 0; i < posterX.length; i++) {
    const px = posterX[i];
    const poster = mesh(new THREE.PlaneGeometry(0.62, 0.78), new THREE.MeshBasicMaterial({ map: posterTexture(posterKinds[i % 3]) }), { x: px, y: 1.95, z: -hz + 0.224, cast: false });
    group.add(poster);
    group.add(box(0.7, 0.86, 0.025, toon(PAL.paper), { x: px, y: 1.95, z: -hz + 0.205, cast: false, outline: 0.006 }));
  }
  // low credenzas on the piers between the work-zone windows, under the posters: team storage that breaks up the long
  // back wall. Each is dressed a little differently (binders, a tray, a plant), so the run never repeats itself. They
  // stand clear of the windows, so the window spots in front of the glass stay free.
  posterX.forEach((px, i) => {
    const cw = 1.6, cd = 0.42, ch = 0.75, czc = -hz + 0.25 + cd / 2;   // back against the wainscot
    const cr = new THREE.Group(); cr.position.set(px, 0, czc); group.add(cr); obs(px, czc, cw, cd); contact(px, czc + 0.04, cw + 0.3, cd + 0.28);
    cr.add(box(cw - 0.06, 0.07, cd - 0.06, toon(PAL.oakDark), { y: 0.035, z: -0.02, cast: false }));                         // recessed plinth
    cr.add(box(cw, ch - 0.1, cd, toon(PAL.oakMid), { y: 0.07 + (ch - 0.1) / 2, outline: 0.012 }));
    cr.add(box(cw + 0.03, 0.035, cd + 0.03, toon(PAL.oak), { y: ch - 0.0125, outline: 0.008 }));                         // oak top
    for (const dx of [-cw / 4, 0, cw / 4]) cr.add(box(0.012, ch - 0.16, 0.01, toon(PAL.oakDark), { x: dx, y: 0.07 + (ch - 0.1) / 2, z: cd / 2 + 0.005, cast: false })); // door joints
    for (const dx of [-cw / 4 - 0.06, -cw / 4 + 0.06, cw / 4 - 0.06, cw / 4 + 0.06]) cr.add(box(0.02, 0.12, 0.025, toon(PAL.metal), { x: dx, y: ch - 0.2, z: cd / 2 + 0.012, cast: false })); // pulls
    const top = ch + 0.005, binders = [PAL.sage, PAL.terracotta, PAL.mustard, PAL.sage, PAL.mustard];
    const kind = i % 3; // 0: binders left, plant right · 1: plant left, tray and a short binder row right · 2: tray left, binders right
    const binderRow = (x0, n, lean) => {
      for (let k = 0; k < n; k++) {
        const b = box(0.06, 0.3, 0.26, toon(binders[(k + i * 2) % binders.length]), { x: x0 + k * 0.065, y: top + 0.15, z: -0.03, outline: 0.006 }); cr.add(b);
        cr.add(box(0.035, 0.07, 0.004, toon(PAL.paper), { x: x0 + k * 0.065, y: top + 0.2, z: 0.102, cast: false }));    // spine label
      }
      if (lean) { const b = box(0.06, 0.3, 0.26, toon(binders[(n + i) % binders.length]), { x: x0 + n * 0.065 + 0.07, y: top + 0.145, z: -0.03, outline: 0.006 }); b.rotation.z = 0.28; cr.add(b); } // leans on the row
    };
    const tray = x => {
      cr.add(box(0.34, 0.012, 0.26, toon(PAL.slateDark), { x, y: top + 0.006 }));
      for (const [w, d, ox, oz] of [[0.34, 0.012, 0, -0.13], [0.34, 0.012, 0, 0.13], [0.012, 0.26, -0.17, 0], [0.012, 0.26, 0.17, 0]]) cr.add(box(w, 0.04, d, toon(PAL.slateDark), { x: x + ox, y: top + 0.02, z: oz, cast: false }));
      for (let k = 0; k < 3; k++) { const sh = box(0.29, 0.005, 0.21, toon(PAL.paper), { x, y: top + 0.016 + k * 0.006, cast: false }); sh.rotation.y = Math.sin(k * 2.3 + i) * 0.07; cr.add(sh); }
    };
    if (kind === 0) { binderRow(-0.68, 5, true); cr.add(plantAt(0.48, 0.5, top, -0.02, { salt: px })); cr.add(cyl(0.05, 0.045, 0.1, toon(PAL.paper), { x: 0.05, y: top + 0.05, z: 0.05, outline: 0.008 }, 12)); }
    else if (kind === 1) { cr.add(plantAt(0.55, -0.52, top, -0.02, { salt: px + 3 })); tray(0.12); binderRow(0.42, 4, false); }
    else { tray(-0.5); binderRow(0.0, 6, true); cr.add(plantAt(0.4, 0.66, top, 0.0, { kind: 'snake', salt: px })); }
  });
  // the fire exit door: closed (it is an emergency exit), a panic bar, a kick plate, a green exit sign above it
  let fireExit = null;
  {
    const fm = matte(0xfaf6f0), zf = -hz + 0.2;
    addA(box(xo1 - xo0, 0.08, 0.26, fm, { x: xFire, y: doorH + 0.04, z: -hz + 0.13, cast: false }));
    for (const sx of [-1, 1]) addA(box(jamb, doorH, 0.26, fm, { x: xFire + sx * (fireW / 2 + jamb / 2), y: doorH / 2, z: -hz + 0.13, cast: false }));
    addA(box(fireW - 0.02, doorH - 0.02, 0.05, toon(PAL.slateLight), { x: xFire, y: doorH / 2, z: zf - 0.03, outline: 0.01 }));
    addA(box(fireW - 0.1, 0.18, 0.012, toon(PAL.metal), { x: xFire, y: 0.12, z: zf + 0.002, cast: false }));                    // kick plate
    addA(box(fireW - 0.18, 0.05, 0.05, toon(PAL.metal), { x: xFire, y: 1.0, z: zf + 0.06, outline: 0.006 }));                  // panic bar
    for (const sx of [-1, 1]) addA(box(0.06, 0.1, 0.07, toon(PAL.slate), { x: xFire + sx * (fireW / 2 - 0.12), y: 1.0, z: zf + 0.035 }));
    const sign = exitSign(); sign.position.set(xFire, doorH + 0.22, zf + 0.03); addA(sign);
    fireExit = { x: xFire, z: -hz + 0.75, facing: Math.PI, door: { x: xFire, z: -hz + 0.2 } };
  }
  // ---------- outdoor fire stairs: from each upper floor's fire exit down to the floor below ----------
  // Painted steel, bolted to the building: a balcony from the fire door along the back facade round the corner, then two flights
  // down the side facade (the one the camera sees): out along the outer lane to a half landing, back along the inner
  // lane to the landing below. The first floor's pair lands on a concrete pad beside the ground floor's own fire door.
  // Each floor carries the stairs below its own landing, so they come and go (and ghost and dim) with the floor.
  let fireStairTopRail = null;
  if (level > 0) {
    const steel = toon(PAL.slateDark), grate = toon(PAL.slate), H = FLOOR_H, n = 9, rise = H / 2 / n, RUN = 2.4, tread = RUN / n;
    const xi0 = hx + 0.06, xi1 = hx + 0.64, xo0 = hx + 0.66, xo1 = hx + 1.24, zc = -hz, zl = -hz - 1.3, xl = xFire - 0.7;
    const g = new THREE.Group(); group.add(g);
    const put = m => { g.add(arch(m)); return m; };
    const plate = (x0, x1, z0, z1, y) => {
      put(box(x1 - x0, 0.05, z1 - z0, grate, { x: (x0 + x1) / 2, y: y - 0.025, z: (z0 + z1) / 2, outline: 0.006 }));
      for (const [w, d, x, z] of [[x1 - x0, 0.04, (x0 + x1) / 2, z0], [x1 - x0, 0.04, (x0 + x1) / 2, z1], [0.04, z1 - z0, x0, (z0 + z1) / 2], [0.04, z1 - z0, x1, (z0 + z1) / 2]])
        put(box(w, 0.12, d, steel, { x, y: y - 0.06, z, cast: false }));                                    // edge channel
    };
    const P = (x, y, z) => new THREE.Vector3(x, y, z);
    const rail = (a, b) => {                                                                                // posts, a mid rail and a top rail
      const len = a.distanceTo(b), k = Math.max(1, Math.round(len / 0.9));
      for (let i = 0; i <= k; i++) { const p = a.clone().lerp(b, i / k); put(rod(p, P(p.x, p.y + 1.0, p.z), 0.018, steel)); }
      put(rod(P(a.x, a.y + 1.0, a.z), P(b.x, b.y + 1.0, b.z), 0.024, steel));
      put(rod(P(a.x, a.y + 0.5, a.z), P(b.x, b.y + 0.5, b.z), 0.014, steel));
    };
    const flight = (x0, x1, zTop, dir, yTop) => {                                                         // treads and two stringers
      for (let i = 0; i < n - 1; i++) put(box(x1 - x0 - 0.04, 0.035, tread - 0.03, grate, { x: (x0 + x1) / 2, y: yTop - (i + 1) * rise - 0.018, z: zTop + dir * (i + 1) * tread, cast: false, outline: 0.005 }));
      const len = Math.hypot(RUN, H / 2), ang = Math.atan2(H / 2, RUN);
      for (const x of [x0, x1]) { const st = box(0.04, 0.2, len, steel, { x, y: yTop - H / 4 - 0.1, z: zTop + dir * RUN / 2 }); st.rotation.x = dir * ang; put(st); }
    };
    // the landing outside this floor's door (y = 0) and the half landing below it
    plate(xl, xo1, zl, zc, 0);
    rail(P(xl, 0, zl), P(xo1, 0, zl)); rail(P(xo1, 0, zl), P(xo1, 0, zc)); rail(P(xl, 0, zl), P(xl, 0, zc));
    plate(xi0, xo1, zc + RUN, zc + RUN + 0.9, -H / 2);
    rail(P(xi0, -H / 2, zc + RUN + 0.9), P(xo1, -H / 2, zc + RUN + 0.9)); rail(P(xo1, -H / 2, zc + RUN), P(xo1, -H / 2, zc + RUN + 0.9));
    // out along the outer lane, back along the inner lane to the landing below
    flight(xo0, xo1, zc, 1, 0); flight(xi0, xi1, zc + RUN, -1, -H / 2);
    rail(P(xo1, 0, zc), P(xo1, -H / 2, zc + RUN)); rail(P(xo0, 0, zc), P(xo0, -H / 2, zc + RUN));
    rail(P(xi1, -H / 2, zc + RUN), P(xi1, -H, zc));
    // the drop into the inner lane at this landing's edge: guarded while no floor above sends a flight down into it
    fireStairTopRail = new THREE.Group(); g.add(fireStairTopRail);
    { const a = P(xi0, 0, zc), b = P(xi1, 0, zc);
      for (const p of [a, b]) fireStairTopRail.add(arch(rod(p, P(p.x, 1.0, p.z), 0.018, steel)));
      fireStairTopRail.add(arch(rod(P(a.x, 1.0, a.z), P(b.x, 1.0, b.z), 0.024, steel)));
      fireStairTopRail.add(arch(rod(P(a.x, 0.5, a.z), P(b.x, 0.5, b.z), 0.014, steel))); }
    // brackets: diagonal braces from the facade up under the half landing, and under the landing's corner
    for (const z of [zc + RUN + 0.15, zc + RUN + 0.75]) put(rod(P(hx, -H / 2 - 0.9, z), P(xo1 - 0.05, -H / 2 - 0.08, z), 0.022, steel));
    for (const z of [zl + 0.15, zc - 0.15]) put(rod(P(hx, -0.9, z), P(xo1 - 0.05, -0.08, z), 0.022, steel));
    { const n = Math.max(1, Math.round((hx - 0.3 - xl - 0.2) / 1.6)); for (let i = 0; i <= n; i++) { const x = xl + 0.2 + (hx - 0.5 - xl) * i / n; put(rod(P(x, -0.9, zc), P(x, -0.08, zl + 0.1), 0.022, steel)); } }
    // the first floor's flights land on a concrete apron at ground-floor level that runs back along the facade to the
    // ground floor's own fire door, with a step down toward the terrace there
    if (level === 1) {
      const pad = matte(0xd5d1ca);
      put(box(xo1 - xl, 0.3, zc - zl + 0.02, pad, { x: (xl + xo1) / 2, y: -H - 0.15, z: (zl + zc) / 2, cast: false, receive: true }));
      put(box(1.4, 0.15, 0.32, pad, { x: xFire, y: -H - 0.225, z: zl - 0.16, cast: false, receive: true }));   // a step down toward the terrace
    }
  }
  let door = null;
  if (hasDoor) {
    const fm = matte(0xfaf6f0);
    addA(box(0.3, 0.1, zo1 - zo0 + 0.04, fm, { x: -hx + 0.1, y: doorH + 0.05, z: zDoor, cast: false }));
    for (const sz of [-1, 1]) addA(box(0.3, doorH, jamb, fm, { x: -hx + 0.1, y: doorH / 2, z: zDoor + sz * (doorLeaf + jamb / 2), cast: false }));
    // two leaves on hinges at the jambs, meeting in the middle; both swing out onto the porch
    const leaves = [-1, 1].map(side => {
      const hinge = new THREE.Group(); hinge.position.set(-hx + 0.1, 0, zDoor + side * doorLeaf); hinge.userData.dynamic = true; group.add(arch(hinge));
      const dir = -side, panel = box(0.06, doorH - 0.04, doorLeaf - 0.02, toon(COLORS.door), { x: 0, y: doorH / 2, z: dir * doorLeaf / 2, outline: 0.012 });
      panel.add(box(0.07, 1.25, 0.46, toon(COLORS.glass), { x: 0, y: 0.18, z: -dir * 0.04, cast: false }));                 // tall vision light
      panel.add(box(0.068, 0.18, doorLeaf - 0.08, toon(PAL.metal), { x: 0, y: -doorH / 2 + 0.13, z: 0, cast: false }));     // kick plate
      for (const sx of [-1, 1]) panel.add(cyl(0.014, 0.014, 0.46, toon(PAL.metal), { x: sx * 0.07, y: -0.05, z: dir * (doorLeaf / 2 - 0.1) }, 8)); // pull handles at the meeting stiles
      hinge.add(arch(panel)); freezeStatic(hinge);                                                      // the leaf swings as one piece
      return hinge;
    });
    door = {
      x: -hx, z: zDoor, width: doorW, inside: { x: -hx + 1.0, z: zDoor }, outside: { x: -hx - 1.4, z: zDoor }, wantOpen: false, angle: 0, vel: 0, hold: 0,
      update(dt) {
        this.hold = this.wantOpen ? 1.1 : Math.max(0, this.hold - dt);           // stays open a moment after the last person
        const target = this.hold > 0 ? -1.75 : 0, k = 34, c = 2 * Math.sqrt(k) * 0.8; // slightly under-damped: a soft settle
        const h = Math.min(Math.max(dt, 0), SPRING_DT);                           // a long frame must not blow the spring up
        this.vel += (k * (target - this.angle) - c * this.vel) * h; this.angle += this.vel * h;
        if (!Number.isFinite(this.angle) || !Number.isFinite(this.vel)) { this.angle = target; this.vel = 0; }
        this.angle = Math.max(-1.85, Math.min(0.02, this.angle));
        if (this.angle <= -1.85 || this.angle >= 0.02) this.vel *= 0.5;          // the stops soak up momentum
        leaves[0].rotation.y = this.angle; leaves[1].rotation.y = -this.angle * 0.97; // a hair out of step, as real leaves are
      },
    };
  }

  // ---------- team pods ----------
  const desks = [];
  const xL = -hx + 0.95, xR = xBuf0 - 0.2; // xR: a standing spot at the edge of the social band
  const walkways = [];
  for (let r = 0; r < rows; r++) {
    const zWalk = -hz + 1.2 + r * ROW_PITCH;
    walkways.push(zWalk);
    const cz = zWalk + 2.7;
    for (let c = 0; c < cols; c++) {
      const cx = xWork0 + CELL_W / 2 + c * CELL_W;
      const pod = makePod(group, cx, cz, r, c, obs, glowTex, level); pod.floor = level; desks.push(pod);
      contact(pod.x, pod.z, 1.4, 0.9);
    }
  }
  walkways.push(-hz + 1.2 + rows * ROW_PITCH); // front walkway (also the door line)
  desks.sort((a, b) => (b.row - a.row) || (a.col - b.col)); // nearest-camera rows first

  // glass partitions to the slab with slim light frames and a frosted privacy band: the meeting room and the review room
  const glazing = (() => {
    const frameMat = matte(PAL.slateLight), H = wallH; // not toon: a rail just above a night lamp must stay dark on the side turned away from it
    const glassMat = new THREE.MeshStandardMaterial({ color: COLORS.glass, transparent: true, opacity: 0.2, roughness: 0.1, depthWrite: false });
    const frost = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, roughness: 1, depthWrite: false }); // lit, or it glows at night
    glassMat.userData.mergeable = frost.userData.mergeable = true;                                       // all the partitions: two draws
    const glassWall = (ax, az, bx, bz, y0 = 0, y1 = H, block = true) => {
      const len = Math.hypot(bx - ax, bz - az), ang = Math.atan2(bz - az, bx - ax), mx = (ax + bx) / 2, mz = (az + bz) / 2, h = y1 - y0;
      const pane = mesh(new THREE.BoxGeometry(len, h - 0.06, 0.02), glassMat, { x: mx, y: (y0 + y1) / 2, z: mz, cast: false }); pane.rotation.y = -ang; pane.renderOrder = 3; addA(pane);
      if (y0 < 1.2) { const band = mesh(new THREE.BoxGeometry(len, 0.22, 0.025), frost, { x: mx, y: 1.2, z: mz, cast: false }); band.rotation.y = -ang; band.renderOrder = 4; addA(band); } // privacy frosting
      for (const yy of [y0 + 0.025, y1 - 0.025]) { const rl = box(len, 0.05, 0.06, frameMat, { x: mx, y: yy, z: mz, cast: false }); rl.rotation.y = -ang; addA(rl); }
      const n = Math.max(1, Math.round(len / 1.6));
      for (let i = 0; i <= n; i++) addA(box(0.035, h, 0.035, frameMat, { x: ax + (bx - ax) * i / n, y: (y0 + y1) / 2, z: az + (bz - az) * i / n }));
      if (block) obs(mx, mz, Math.abs(bx - ax) + 0.08, Math.abs(bz - az) + 0.08);
    };
    return { frameMat, glassMat, frost, glassWall };
  })();

  // ---------- glass meeting room: shared-rooms band at the back, by a window, between the pantry and the desks ----------
  const meeting = (() => {
    const x0 = xBuf0 + 0.2, x1 = xBuf0 + BUFFER - 0.2, z0 = -hz + 0.2, z1 = -hz + 5.0, doorW = 1.1;
    for (let i = windowSpots.length - 1; i >= 0; i--) if (windowSpots[i].x > x0 - 0.3 && windowSpots[i].x < x1 + 0.3) windowSpots.splice(i, 1);
    const { frameMat, glassMat, frost, glassWall } = glazing, H = wallH, doorTop = 2.2;
    glassWall(x0, z0, x0, z1); glassWall(x1, z0, x1, z1); glassWall(x0 + doorW, z1, x1, z1);
    glassWall(x0, z1, x0 + doorW, z1, doorTop, H, false);                                                        // transom over the door
    // sliding glass door: runs on a track on the inside, parks behind the fixed glass when open
    addA(box(doorW * 2 + 0.1, 0.06, 0.05, frameMat, { x: x0 + doorW, y: doorTop + 0.03, z: z1 - 0.07, cast: false }));     // track
    const slider = new THREE.Group(); slider.position.set(x0 + doorW / 2, 0, z1 - 0.07); slider.userData.dynamic = true; group.add(arch(slider));
    { const leaf = mesh(new THREE.BoxGeometry(doorW + 0.04, doorTop - 0.04, 0.02), glassMat, { y: (doorTop - 0.02) / 2, cast: false }); leaf.renderOrder = 3; slider.add(leaf);
      const lb = mesh(new THREE.BoxGeometry(doorW + 0.04, 0.22, 0.025), frost, { y: 1.2, cast: false }); lb.renderOrder = 4; slider.add(lb);
      for (const sx of [-1, 1]) slider.add(box(0.035, doorTop - 0.02, 0.035, frameMat, { x: sx * (doorW / 2 + 0.02), y: (doorTop - 0.02) / 2, cast: false }));
      slider.add(box(doorW + 0.07, 0.04, 0.035, frameMat, { y: 0.02, cast: false }));
      slider.add(cyl(0.012, 0.012, 0.5, toon(PAL.metal), { x: -doorW / 2 + 0.1, y: 1.0, z: 0.035 }, 8));               // pull bar
      arch(slider); freezeStatic(slider); }
    const slide = { open: 1, target: 1, vel: 0 };
    const updateDoor = dt => {
      const k = 30, c = 2 * Math.sqrt(k) * 0.9, h = Math.min(Math.max(dt, 0), SPRING_DT);
      slide.vel += (k * (slide.target - slide.open) - c * slide.vel) * h; slide.open = Math.max(-0.02, Math.min(1.02, slide.open + slide.vel * h));
      if (!Number.isFinite(slide.open) || !Number.isFinite(slide.vel)) { slide.open = slide.target; slide.vel = 0; }
      slider.position.x = x0 + doorW / 2 + slide.open * (doorW - 0.06);
    };
    // table with six chairs, a mobile whiteboard and a plant
    const tx = (x0 + x1) / 2, tz = (z0 + z1) / 2 + 0.25;
    group.add(roundedBox(0.95, 0.06, 2.2, 0.08, toon(PAL.oak), { x: tx, y: 0.72, z: tz, outline: 0.012 }));
    for (const dz of [-0.7, 0.7]) group.add(box(0.12, 0.69, 0.5, toon(COLORS.deskLeg), { x: tx, y: 0.345, z: tz + dz }));
    obs(tx, tz, 0.95, 2.2); contact(tx, tz, 1.25, 2.5);
    const seats = [];
    for (const side of [-1, 1]) for (const dz of [-0.7, 0, 0.7]) {
      const sx = tx + side * 0.92, sz = tz + dz, facing = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      const ch = new THREE.Group(); ch.position.set(sx, 0, sz); ch.rotation.y = facing; group.add(ch);
      ch.add(roundedBox(0.46, 0.08, 0.46, 0.08, toon(COLORS.chairSeat), { y: 0.42, outline: 0.012 }));
      ch.add(roundedBox(0.46, 0.42, 0.08, 0.08, toon(COLORS.chairSeat), { y: 0.68, z: -0.22, outline: 0.012 }));
      ch.add(cyl(0.03, 0.03, 0.34, toon(COLORS.chair), { y: 0.2 }, 10)); ch.add(starBase(0.24, COLORS.chair));
      seats.push({ x: sx, z: sz, facing, seatY: 0.46, meeting: true, taken: null, floor: level });
    }
    const wb = new THREE.Group(); wb.position.set(x0 + 0.6, 0, z0 + 0.55); wb.rotation.y = 0.55; group.add(wb);
    const board = canvasTex(512, 320);
    wb.add(mesh(new THREE.PlaneGeometry(1.0, 0.62), new THREE.MeshBasicMaterial({ map: board.tex }), { y: 1.35, z: 0.025, cast: false }));
    let boardKey = null;
    const drawBoard = data => {
      const key = data ? JSON.stringify(data) : 'idle'; if (key === boardKey) return; boardKey = key;
      const { ctx } = board; ctx.fillStyle = '#fbfaf7'; ctx.fillRect(0, 0, 512, 320);
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      if (!data) { // free room: faint leftovers of an earlier session
        ctx.strokeStyle = 'rgba(122,133,153,0.35)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(40, 230); ctx.bezierCurveTo(140, 120, 260, 260, 460, 110); ctx.stroke();
        ctx.fillStyle = 'rgba(122,133,153,0.45)'; ctx.font = '28px "M PLUS Rounded 1c", sans-serif'; ctx.fillText('meeting room · free', 40, 70);
      } else {
        ctx.fillStyle = '#3f3a4a'; ctx.font = 'bold 34px "M PLUS Rounded 1c", sans-serif'; ctx.fillText(fitText(ctx, data.title, 440), 36, 62);
        ctx.strokeStyle = '#cf8466'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(36, 78); ctx.lineTo(300, 78); ctx.stroke();
        ctx.font = '27px "M PLUS Rounded 1c", sans-serif';
        (data.items || []).slice(0, 4).forEach((t, i) => { ctx.fillStyle = ['#6f9a6c', '#7a8599', '#b5705a', '#6f9a6c'][i]; ctx.fillText(fitText(ctx, '☐ ' + t, 440), 40, 128 + i * 46); });
      }
      board.tex.needsUpdate = true;
    };
    drawBoard(null);
    wb.add(box(1.06, 0.68, 0.04, toon(PAL.paper), { y: 1.35, outline: 0.01 }));
    for (const sx of [-0.48, 0.48]) wb.add(box(0.04, 1.05, 0.04, toon(PAL.slateDark), { x: sx, y: 0.53 }));
    wb.add(box(1.0, 0.04, 0.3, toon(PAL.slateDark), { y: 0.06 }));
    obs(x0 + 0.6, z0 + 0.55, 0.9, 0.5, 0.55);
    group.add(plantAt(0.65, x1 - 0.35, 0, z0 + 0.35)); obs(x1 - 0.35, z0 + 0.35, 0.3, 0.3);
    // door sign on the glass beside the door: free (sage) / in use by a team (terracotta, with the project)
    const sign = canvasTex(256, 112);
    group.add(box(0.7, 0.32, 0.02, toon(PAL.slateDark), { x: x0 + doorW + 0.45, y: 1.72, z: z1 + 0.03, cast: false }));
    group.add(mesh(new THREE.PlaneGeometry(0.66, 0.28), new THREE.MeshBasicMaterial({ map: sign.tex }), { x: x0 + doorW + 0.45, y: 1.72, z: z1 + 0.045, cast: false }));
    let signKey = null;
    const drawSign = (busy, text) => {
      const key = busy ? `busy|${text}` : 'free'; if (key === signKey) return; signKey = key;
      const { ctx } = sign; ctx.fillStyle = '#fbf8f2'; ctx.fillRect(0, 0, 256, 112);
      ctx.fillStyle = busy ? '#cf8466' : '#9db892'; ctx.beginPath(); ctx.arc(30, 38, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3f3a4a'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = 'bold 34px "M PLUS Rounded 1c", sans-serif'; ctx.fillText(busy ? 'In use' : 'Free', 54, 40);
      ctx.font = '24px "M PLUS Rounded 1c", sans-serif'; ctx.fillStyle = '#6d6578'; ctx.fillText(fitText(ctx, busy ? text : 'meeting room', 220), 18, 86);
      sign.tex.needsUpdate = true;
    };
    drawSign(false);
    return { setBoard: drawBoard, setSign: drawSign, x0, x1, z0, z1, seats, presenter: { x: tx, z: z0 + 0.8, facing: 0 }, floor: level,
      team: null, expected: new Set(), session: false, sessionEnd: 0, deadline: 0, cool: new Map(),
      // the sliding door: open by default (closing it does not block navigation, so whoever closes it opens it for
      // people passing); door = the doorway centre, doorWantOpen mirrors the last request
      door: { x: x0 + doorW / 2, z: z1 }, doorWantOpen: true,
      setDoor(open) { this.doorWantOpen = !!open; slide.target = open ? 1 : 0; },
      updateDoor };
  })();

  // ---------- pantry: social band, along the back wall, a few steps from the entrance ----------
  // a 2.6 m kitchenette run: microwave, coffee machine, sink over the dishwasher, pull-out bins, a tall fridge at the
  // far end and the water cooler beside it
  const cz = -hz + 0.6, kx0 = xSoc0 + 0.1, kx1 = kx0 + 2.6, kcx = (kx0 + kx1) / 2, kFront = cz + 0.375;
  const mx = kx0 + 1.6;                                 // coffee machine: the queue runs from here into the room
  const sinkX = kx1 - 0.25, fx = kx1 + 0.4;            // sink near the fridge end, fridge just past the counter
  obs(kcx, cz, 2.7, 0.85); contact(kcx, cz + 0.06, 2.9, 1.0);
  {
    const cab = toon(COLORS.counter), gap = toon(PAL.oakDark), handle = toon(PAL.metal);
    group.add(box(2.6, 0.78, 0.75, cab, { x: kcx, y: 0.47, z: cz, outline: 0.012 }));
    group.add(box(2.56, 0.08, 0.68, toon(PAL.oakDark), { x: kcx, y: 0.04, z: cz - 0.03, cast: false }));                 // recessed plinth
    group.add(box(2.66, 0.05, 0.8, toon(COLORS.counterTop), { x: kcx, y: 0.885, z: cz + 0.02, outline: 0.008 }));       // worktop
    group.add(box(2.6, 0.55, 0.015, toon(PAL.paper), { x: kcx, y: 1.185, z: -hz + 0.208, cast: false }));                // backsplash
    // fronts, left to right: cupboard | drawers | pull-out bins | dishwasher | sink cupboard
    const fronts = [[0.5, 'door'], [0.5, 'drawers'], [0.5, 'bins'], [0.6, 'dish'], [0.5, 'door']];
    let x = kx0;
    for (const [w, kind] of fronts) {
      const fxc = x + w / 2; x += w;
      group.add(box(0.012, 0.74, 0.01, gap, { x: x, y: 0.47, z: kFront + 0.006, cast: false }));                      // joint
      if (kind === 'door') group.add(box(0.02, 0.16, 0.025, handle, { x: fxc + w / 2 - 0.07, y: 0.7, z: kFront + 0.015, cast: false }));
      if (kind === 'drawers') for (let k = 0; k < 3; k++) { group.add(box(w - 0.04, 0.008, 0.01, gap, { x: fxc, y: 0.34 + k * 0.2, z: kFront + 0.006, cast: false })); group.add(box(0.14, 0.02, 0.025, handle, { x: fxc, y: 0.27 + k * 0.2 + 0.14, z: kFront + 0.015, cast: false })); }
      if (kind === 'bins') { group.add(box(0.2, 0.02, 0.025, handle, { x: fxc, y: 0.78, z: kFront + 0.015, cast: false }));
        for (const [dx, c] of [[-0.1, PAL.sage], [0.1, PAL.slate]]) group.add(box(0.12, 0.05, 0.012, toon(c), { x: fxc + dx, y: 0.66, z: kFront + 0.008, cast: false })); } // recycling labels
      if (kind === 'dish') { group.add(box(w - 0.03, 0.7, 0.02, toon(PAL.trim), { x: fxc, y: 0.47, z: kFront + 0.01, outline: 0.006 }));
        group.add(box(w - 0.03, 0.07, 0.022, toon(PAL.slateDark), { x: fxc, y: 0.79, z: kFront + 0.012, cast: false }));    // control strip
        group.add(box(0.36, 0.02, 0.03, handle, { x: fxc, y: 0.72, z: kFront + 0.03, cast: false })); }
    }
    // microwave and mugs on the worktop, sink with a gooseneck tap and a soap bottle
    const mw = new THREE.Group(); mw.position.set(kx0 + 0.32, 0.91, cz - 0.05); group.add(mw);
    mw.add(box(0.5, 0.3, 0.38, toon(PAL.trim), { y: 0.15, outline: 0.01 }));
    mw.add(box(0.32, 0.2, 0.01, toon(PAL.slateDark), { x: -0.06, y: 0.15, z: 0.195, cast: false }));
    mw.add(box(0.08, 0.22, 0.01, toon(PAL.slateLight), { x: 0.18, y: 0.15, z: 0.195, cast: false }));
    for (let i = 0; i < 3; i++) group.add(cyl(0.055, 0.045, 0.1, toon([PAL.paper, PAL.sageLight, PAL.blush][i]), { x: kx0 + 0.75 + i * 0.2, y: 0.96, z: cz - 0.1, outline: 0.01 }, 14));
    group.add(box(0.46, 0.012, 0.38, toon(PAL.metal), { x: sinkX, y: 0.912, z: cz + 0.04, cast: false }));
    group.add(box(0.38, 0.006, 0.3, toon(PAL.slate), { x: sinkX, y: 0.918, z: cz + 0.04, cast: false }));
    group.add(cyl(0.016, 0.02, 0.3, handle, { x: sinkX, y: 1.06, z: cz - 0.2 }, 8));
    { const spout = cyl(0.013, 0.013, 0.17, handle, { x: sinkX, y: 1.2, z: cz - 0.12 }, 8); spout.rotation.x = Math.PI / 2; group.add(spout); }
    group.add(cyl(0.012, 0.012, 0.05, handle, { x: sinkX, y: 1.18, z: cz - 0.04 }, 8));
    group.add(cyl(0.03, 0.03, 0.14, toon(PAL.sage), { x: sinkX - 0.31, y: 0.98, z: cz - 0.2, outline: 0.006 }, 10)); // soap
    // tall fridge (freezer below), its own footprint
    const fr = new THREE.Group(); fr.position.set(fx, 0, -hz + 0.2 + 0.35); group.add(fr); obs(fx, -hz + 0.2 + 0.35, 0.74, 0.72); contact(fx, -hz + 0.59, 0.95, 0.95);
    fr.add(box(0.7, 1.95, 0.68, toon(PAL.paper), { y: 0.975, outline: 0.012 }));
    fr.add(box(0.66, 0.012, 0.01, toon(PAL.trim), { y: 0.72, z: 0.345, cast: false }));                                   // freezer door joint
    fr.add(box(0.6, 0.06, 0.01, toon(PAL.slateLight), { y: 0.05, z: 0.345, cast: false }));                               // grille
    fr.add(box(0.025, 0.42, 0.03, handle, { x: -0.28, y: 1.35, z: 0.355 })); fr.add(box(0.025, 0.26, 0.03, handle, { x: -0.28, y: 0.5, z: 0.355 }));
    fr.add(box(0.12, 0.09, 0.008, toon(PAL.mustard), { x: 0.12, y: 1.5, z: 0.345, cast: false }));                        // a note on the door
    // open shelf over the run: plants and a canister
    group.add(box(2.0, 0.05, 0.3, toon(COLORS.shelf), { x: kcx + 0.15, y: 1.75, z: -hz + 0.35, outline: 0.01 }));
    for (let i = 0; i < 3; i++) group.add(plantAt(0.32 + (i % 2) * 0.1, kcx - 0.55 + i * 0.6, 1.78, -hz + 0.35, { shelf: true }));
    group.add(cyl(0.07, 0.06, 0.16, toon(PAL.sageLight), { x: kcx + 0.95, y: 1.86, z: -hz + 0.35, outline: 0.008 }, 12));
  }
  const machine = new THREE.Group(); machine.position.set(mx, 0.91, cz - 0.05); group.add(machine);
  machine.add(box(0.42, 0.5, 0.36, toon(COLORS.machine), { y: 0.25, outline: 0.012 }));
  machine.add(box(0.44, 0.08, 0.38, toon(PAL.ink), { y: 0.5 }));
  machine.add(box(0.1, 0.06, 0.08, toon(PAL.ink), { y: 0.18, z: 0.2 }));
  const led = sphere(0.025, new THREE.MeshBasicMaterial({ color: COLORS.ledIdle }), { x: 0.14, y: 0.4, z: 0.185, cast: false }, 8); machine.add(led);
  machine.add(cyl(0.06, 0.05, 0.1, toon(PAL.paper), { y: 0.05, z: 0.2, outline: 0.01 }, 14));
  const steamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const puffs = Array.from({ length: 5 }, (_, i) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), steamMat.clone()); m.userData.phase = i / 5; m.userData.dynamic = true; machine.add(m); return m; });
  const coffee = { stand: { x: mx, z: cz + 1.1 }, facing: Math.PI, brewing: 0, t: 0, steam: 0,
    queue: [], // people waiting for the machine, first = brewing; the line runs out into the room
    spotFor(i) { return i === 0 ? this.stand : { x: this.stand.x + (i % 2 ? 0.16 : -0.1), z: this.stand.z + 0.72 * i, facing: Math.PI }; },
    update(dt) {
      this.t += dt; led.material.color.setHex(this.brewing > 0 ? (Math.sin(this.t * 10) > 0 ? COLORS.ledOn : COLORS.ledOff) : COLORS.ledIdle);
      this.steam += ((this.brewing > 0 ? 1 : 0) - this.steam) * Math.min(1, dt * 2);       // steam fades in and out
      for (const m of puffs) {
        const u = (this.t * 0.55 + m.userData.phase) % 1;
        m.position.set(Math.sin((u + m.userData.phase) * 9) * 0.03, 0.56 + u * 0.55, 0.05 + u * 0.05);
        m.scale.setScalar(0.7 + u * 1.6); m.material.opacity = this.steam * 0.5 * Math.sin(u * Math.PI);
      }
    } };

  // ---------- standing table: middle of the social band, a few steps from the coffee machine ----------
  const barSpots = [];
  {
    const tx = sx + 1.0, tz = -hz + 4.6; // clear of the coffee line, which runs from the machine into the room
    group.add(cyl(0.42, 0.42, 0.05, toon(PAL.oak), { x: tx, y: 1.05, z: tz, outline: 0.012 }, 28));
    group.add(cyl(0.04, 0.04, 1.02, toon(PAL.slateDark), { x: tx, y: 0.51, z: tz }, 10));
    group.add(cyl(0.26, 0.28, 0.03, toon(PAL.slateDark), { x: tx, y: 0.015, z: tz }, 20));
    group.add(cyl(0.05, 0.045, 0.1, toon(PAL.blush), { x: tx + 0.12, y: 1.12, z: tz - 0.06, outline: 0.008 }, 12));
    obs(tx, tz, 0.84, 0.84);
    for (const a of [Math.PI * 0.25, Math.PI * 1.25, -Math.PI * 0.25]) barSpots.push({ x: tx + Math.sin(a) * 0.78, z: tz + Math.cos(a) * 0.78, facing: a + Math.PI, taken: null });
  }

  // ---------- lounge: social band, at the front. Same footprint on every floor, its own character per floor:
  //            ground floor a sofa lounge, then a reading lounge, then a game corner (repeating upward) ----------
  const lx = sx + 0.3, lz = hz - 2.6;
  const variant = level % 3;
  let foos = null; // the game corner's foosball table
  const rug = mesh(new THREE.CircleGeometry(1.75, 48), matte([COLORS.rug, PAL.sageLight, 0xf3e3bf][variant]), { x: lx, y: 0.012, z: lz, cast: false, receive: true }); rug.rotation.x = -Math.PI / 2; group.add(rug);
  const rugEdge = mesh(new THREE.RingGeometry(1.6, 1.7, 48), matte([PAL.terracotta, PAL.sage, PAL.mustard][variant]), { x: lx, y: 0.014, z: lz, cast: false, receive: true }); rugEdge.rotation.x = -Math.PI / 2; group.add(rugEdge);
  const lampG = new THREE.Group(); lampG.position.set(lx - 1.15, 0, lz + 1.35); group.add(lampG); obs(lx - 1.15, lz + 1.35, 0.4, 0.4);
  lampG.add(cyl(0.18, 0.2, 0.04, toon(PAL.slateDark), { y: 0.02 }, 16));
  lampG.add(cyl(0.025, 0.025, 1.5, toon(PAL.slateDark), { y: 0.77 }, 8));
  const shadeMat = toon(0xfff1c9, { side: THREE.DoubleSide, emissive: 0xffe29a, emissiveIntensity: 0 });
  const shade = mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.36, 18, 1, true), shadeMat, { y: 1.62, outline: 0.012 }); lampG.add(shade);
  const seatAt = (x, z, facing, seatY, back = 0.6) => ({ x, z, facing, seatY, taken: false, approach: { x: x + Math.sin(facing) * back, z: z + Math.cos(facing) * back } });
  let loungeSeats = [];
  if (variant === 0) { // sofa lounge: the sofa backs onto the entrance band and faces into the room
    obs(lx - 1.0, lz, 0.8, 1.9); obs(lx + 0.1, lz, 1.05, 1.05); contact(lx - 1.0, lz, 1.1, 2.2); contact(lx + 0.1, lz, 1.15, 1.15);
    const sofa = new THREE.Group(); sofa.position.set(lx - 1.0, 0, lz); sofa.rotation.y = Math.PI; group.add(sofa);
    sofa.add(roundedBox(0.8, 0.42, 1.9, 0.12, toon(COLORS.sofa), { y: 0.21, outline: 0.012 }));
    sofa.add(roundedBox(0.25, 0.5, 1.9, 0.1, toon(COLORS.sofa), { x: 0.3, y: 0.62, outline: 0.012 }));
    for (const s of [-1, 1]) sofa.add(roundedBox(0.7, 0.14, 0.86, 0.1, toon(COLORS.sofaCushion), { x: -0.08, y: 0.47, z: s * 0.47, outline: 0.012 }));
    sofa.add(sphere(0.14, toon(PAL.mustard), { x: -0.05, y: 0.62, z: -0.8 }));
    const table = new THREE.Group(); table.position.set(lx + 0.1, 0, lz); group.add(table);
    table.add(cyl(0.52, 0.5, 0.06, toon(COLORS.table), { y: 0.44, outline: 0.012 }, 32));
    table.add(cyl(0.05, 0.05, 0.42, toon(COLORS.deskLeg), { y: 0.21 }, 12));
    table.add(cyl(0.3, 0.3, 0.03, toon(COLORS.deskLeg), { y: 0.015 }, 24));
    table.add(box(0.26, 0.015, 0.2, toon(PAL.terracotta), { x: 0.1, y: 0.48, z: 0.1, outline: 0.008 }));
    for (const [stx, stz, facing] of [[lx + 1.2, lz, -Math.PI / 2], [lx + 0.1, lz + 1.05, Math.PI], [lx + 0.1, lz - 1.05, 0]]) {
      const st = new THREE.Group(); st.position.set(stx, 0, stz); group.add(st);
      st.add(cyl(0.26, 0.24, 0.1, toon(PAL.mustard), { y: 0.38, outline: 0.012 }, 24));
      st.add(cyl(0.05, 0.05, 0.34, toon(COLORS.deskLeg), { y: 0.17 }, 12));
      st.add(cyl(0.2, 0.2, 0.03, toon(COLORS.deskLeg), { y: 0.015 }, 20));
      obs(stx, stz, 0.52, 0.52);
      const ax = stx + (stx - (lx + 0.1)) * 0.85, az = stz + (stz - lz) * 0.85; // step back, away from the table
      loungeSeats.push({ x: stx, z: stz, facing, seatY: 0.43, taken: false, approach: { x: ax === stx ? stx : ax, z: az === stz ? stz : az } });
    }
    loungeSeats.unshift(
      // the gap between the sofa and the coffee table is too narrow to stand in: step in from the sofa's ends
      { x: lx - 0.9, z: lz - 0.47, facing: Math.PI / 2, seatY: 0.54, taken: false, approach: { x: lx - 0.55, z: lz - 1.45 } },
      { x: lx - 0.9, z: lz + 0.47, facing: Math.PI / 2, seatY: 0.54, taken: false, approach: { x: lx - 0.55, z: lz + 1.45 } });
  } else if (variant === 1) { // reading lounge: a tall bookshelf, armchairs, a low table
    const shelf = new THREE.Group(); shelf.position.set(lx - 1.5, 0, lz); shelf.rotation.y = Math.PI / 2; group.add(shelf); obs(lx - 1.5, lz, 0.45, 1.9); contact(lx - 1.5, lz, 0.75, 2.15);
    shelf.add(box(1.8, 1.7, 0.4, toon(COLORS.shelf), { y: 0.85, outline: 0.012 }));
    for (let lvl = 0; lvl < 4; lvl++) {
      shelf.add(box(1.72, 0.03, 0.36, toon(PAL.oak), { y: 0.32 + lvl * 0.4, z: 0.02 }));
      let x = -0.8;
      for (let b = 0; b < 12 && x < 0.72; b++) { const w = 0.07 + ((b * 7 + lvl * 3) % 3) * 0.025, h = 0.22 + ((b + lvl) % 3) * 0.04; if ((b + lvl) % 5 === 4) { x += 0.12; continue; } shelf.add(box(w, h, 0.24, toon(COLORS.book[(b + lvl) % 5]), { x: x + w / 2, y: 0.335 + lvl * 0.4 + h / 2, z: 0.06, outline: 0.006 })); x += w + 0.012; }
    }
    const armchair = (x, z, facing, col) => {
      const a = new THREE.Group(); a.position.set(x, 0, z); a.rotation.y = facing; group.add(a); obs(x, z, 0.72, 0.72); contact(x, z, 0.98, 0.98);
      a.add(roundedBox(0.66, 0.36, 0.64, 0.1, toon(col), { y: 0.18, outline: 0.012 }));
      a.add(roundedBox(0.66, 0.46, 0.16, 0.08, toon(col), { y: 0.55, z: -0.26, outline: 0.012 }));
      for (const sx of [-0.3, 0.3]) a.add(roundedBox(0.1, 0.2, 0.6, 0.05, toon(col), { x: sx, y: 0.44, outline: 0.01 }));
      a.add(roundedBox(0.48, 0.08, 0.46, 0.06, toon(COLORS.sofaCushion), { y: 0.39, z: 0.04, outline: 0.008 }));
      loungeSeats.push({ ...seatAt(x, z, facing, 0.46, 0.7), style: 'read' });
    };
    armchair(lx - 0.8, lz - 0.8, Math.PI / 2, PAL.sage); armchair(lx - 0.8, lz + 0.72, Math.PI / 2, PAL.sage); armchair(lx + 1.2, lz - 0.9, -Math.PI / 2, PAL.terracotta);
    const tbl = new THREE.Group(); tbl.position.set(lx + 0.25, 0, lz); group.add(tbl); obs(lx + 0.25, lz, 0.62, 0.62); contact(lx + 0.25, lz, 0.85, 0.85);
    tbl.add(cyl(0.3, 0.3, 0.05, toon(COLORS.table), { y: 0.4, outline: 0.01 }, 24)); tbl.add(cyl(0.04, 0.04, 0.38, toon(COLORS.deskLeg), { y: 0.19 }, 10));
    tbl.add(box(0.18, 0.04, 0.24, toon(PAL.slate), { y: 0.445, outline: 0.006 })); tbl.add(box(0.16, 0.03, 0.22, toon(PAL.mustard), { y: 0.48, z: 0.02, outline: 0.006 }));
  } else { // game corner: a foosball table and bean bags
    const ft = new THREE.Group(); ft.position.set(lx + 0.2, 0, lz); group.add(ft); obs(lx + 0.2, lz, 1.3, 0.8); contact(lx + 0.2, lz, 1.55, 1.05);
    ft.add(box(1.2, 0.26, 0.7, toon(PAL.oakMid), { y: 0.74, outline: 0.012 }));
    ft.add(box(1.08, 0.02, 0.58, toon(PAL.sage), { y: 0.86 }));
    for (const [x, z] of [[-0.52, -0.28], [0.52, -0.28], [-0.52, 0.28], [0.52, 0.28]]) ft.add(box(0.07, 0.62, 0.07, toon(PAL.oakDark), { x, y: 0.31, z }));
    const rods = [];
    for (let i = 0; i < 6; i++) {
      const x = -0.45 + i * 0.18, team = i % 2 ? PAL.terracotta : PAL.slate;
      const rg = new THREE.Group(); rg.position.set(x, 0.93, 0); rg.userData.dynamic = true; ft.add(rg); rods.push(rg);
      const rod = cyl(0.01, 0.01, 0.95, toon(PAL.metal), { cast: false }, 6); rod.rotation.x = Math.PI / 2; rg.add(rod);
      for (let k = 0; k < 3; k++) rg.add(box(0.04, 0.1, 0.03, toon(team), { y: -0.03, z: -0.18 + k * 0.18, cast: false }));
    }
    let ft_t = 0;
    foos = { // two players stand at the long sides, facing each other over the table
      spots: [{ x: lx + 0.2, z: lz - 0.78, facing: 0, taken: null }, { x: lx + 0.2, z: lz + 0.78, facing: Math.PI, taken: null }],
      players: 0,
      update(dt) {
        ft_t += dt; const on = this.players >= 2;
        rods.forEach((r, i) => { const tgt = on ? Math.sin(ft_t * (6 + i) + i) * 0.9 : 0; r.rotation.z += (tgt - r.rotation.z) * Math.min(1, dt * 8); r.position.z = on ? Math.sin(ft_t * (2.3 + i * 0.4)) * 0.05 : 0; });
      },
    };
    ft.add(sphere(0.022, toon(PAL.paper), { x: 0.08, y: 0.88, z: 0.05, cast: false }, 8));
    const beanBag = (x, z, facing, col) => {
      const b = sphere(0.4, toon(col), { x, y: 0.2, z, outline: 0.012 }, 18); b.scale.set(1, 0.55, 1); group.add(b);
      const back = sphere(0.3, toon(col), { x: x - Math.sin(facing) * 0.22, y: 0.36, z: z - Math.cos(facing) * 0.22, outline: 0.01 }, 16); back.scale.set(1, 0.8, 0.7); back.rotation.y = facing; group.add(back);
      obs(x, z, 0.75, 0.75); contact(x, z, 1.0, 1.0);
      loungeSeats.push({ ...seatAt(x, z, facing, 0.3, 0.62), style: 'beanbag' });
    };
    beanBag(lx - 1.25, lz - 1.05, 0.93, PAL.mustard); beanBag(lx - 1.5, lz + 0.1, 1.63, PAL.terracotta); /* well clear of the floor lamp */ beanBag(lx + 1.55, lz + 1.15, -2.25, PAL.sage);
  }
  const lounge = { center: { x: lx, z: lz }, kind: ['lounge', 'reading lounge', 'game corner'][variant], seats: loungeSeats };

  // ---------- work café: a long oak table with six chairs in the lobby beside the kitchen, clear of the lift landing
  //            and of the coffee queue: somewhere to sit with a cup (coffee breaks sit here or in the lounge) ----------
  const cafe = { seats: [] };
  {
    const tx = -hx + 4.9, tz = -0.3, len = 2.6, wid = 0.85;
    obs(tx, tz, wid, len); contact(tx, tz, wid + 0.25, len + 0.25);
    group.add(roundedBox(wid, 0.05, len, 0.04, toon(PAL.oak), { x: tx, y: 0.725, z: tz, outline: 0.012 }));
    for (const sz of [-1, 1]) {                                                                             // two trestle legs
      group.add(box(0.06, 0.7, wid - 0.16, toon(PAL.slateDark), { x: tx, y: 0.35, z: tz + sz * (len / 2 - 0.3), cast: false }));
      group.add(box(0.5, 0.04, wid - 0.1, toon(PAL.slateDark), { x: tx, y: 0.02, z: tz + sz * (len / 2 - 0.3), cast: false }));
    }
    group.add(box(0.05, 0.05, len - 0.6, toon(PAL.slateDark), { x: tx, y: 0.36, z: tz, cast: false }));          // stretcher
    group.add(cyl(0.05, 0.04, 0.16, toon(PAL.sageLight), { x: tx, y: 0.83, z: tz + 0.1, outline: 0.006 }, 14)); // a bud vase
    group.add(sphere(0.06, toon(PAL.blush), { x: tx, y: 0.94, z: tz + 0.1 }, 10));
    group.add(cyl(0.035, 0.03, 0.08, toon(PAL.paper), { x: tx + 0.16, y: 0.79, z: tz - 0.62, outline: 0.005 }, 12));   // a cup someone left
    const chairSeat = toon(PAL.oak), chairLeg = toon(PAL.slateDark);
    for (const side of [-1, 1]) for (const dz of [-0.85, 0, 0.85]) {
      const x = tx + side * 0.72, z = tz + dz, facing = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      const ch = new THREE.Group(); ch.position.set(x, 0, z); ch.rotation.y = facing; group.add(ch); obs(x, z, 0.42, 0.42);
      ch.add(roundedBox(0.42, 0.05, 0.4, 0.04, chairSeat, { y: 0.45, outline: 0.01 }));
      ch.add(roundedBox(0.4, 0.16, 0.04, 0.03, chairSeat, { y: 0.72, z: -0.2, outline: 0.008 }));          // curved back rail
      for (const sx of [-1, 1]) ch.add(box(0.025, 0.3, 0.025, chairLeg, { x: sx * 0.17, y: 0.6, z: -0.2, cast: false }));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) ch.add(box(0.03, 0.44, 0.03, chairLeg, { x: sx * 0.17, y: 0.22, z: sz * 0.16, cast: false }));
      cafe.seats.push({ ...seatAt(x, z, facing, 0.47, 0.55), style: 'cafe', approach: { x: x - side * 0.55, z } });
    }
    cafe.center = { x: tx, z: tz };
  }

  // ---------- review room: the quiet band at the far end, away from the pantry and the door ----------
  // A small glass office where reviewers sign work off, the finest desk on the floor: a deep-wood partners' desk with a
  // sage leather inlay, two cognac leather high-backs facing each other across it, two club armchairs by the front
  // glass, a brass-and-sage banker's lamp, the stamp and the in/out trays. Seats 4 (desk first, then the armchairs);
  // more wait by the door. It stands against the back wall (its two windows, the library bookcase inside), with a
  // 1.1 m aisle past the last pod's helper desks that leads straight to the fire exit.
  const rx0 = xQuiet0 + 1.1, rx1 = hx - 0.2, rz0 = -hz + 0.2, rz1 = rz0 + 5.2, rcx = (rx0 + rx1) / 2, rDoor = 1.0;  // 4.3 × 5.2 m
  for (let i = windowSpots.length - 1; i >= 0; i--) if (windowSpots[i].x > rx0 - 0.3) windowSpots.splice(i, 1);   // its windows are its own
  const qx = rcx, qz = rz0 + 1.65;                                  // the desk
  let catSpot = null;
  const WOOD = 0xa47c5b, WOOD_DEEP = 0x8d6a4e, LEATHER = 0xb5705a, LEATHER_DEEP = 0x9a5c48, BRASS = PAL.mustard;
  const wood = toon(WOOD), woodDeep = toon(WOOD_DEEP), leather = toon(LEATHER), leatherDeep = toon(LEATHER_DEEP), brass = toon(BRASS);
  {
    const { frameMat, glassMat, frost, glassWall } = glazing, doorTop = 2.2, dl = rcx + 0.35, dr = dl + rDoor;
    glassWall(rx0, rz0, rx0, rz1);
    glassWall(rx0, rz1, dl, rz1); glassWall(dr, rz1, rx1, rz1); glassWall(dl, rz1, dr, rz1, doorTop, wallH, false);
    // the glass door stands open, parked behind the fixed pane to the left of the doorway
    const lx0 = dl - rDoor / 2 - 0.02;
    const leaf = mesh(new THREE.BoxGeometry(rDoor, doorTop - 0.04, 0.02), glassMat, { x: lx0, y: (doorTop - 0.02) / 2, z: rz1 - 0.07, cast: false }); leaf.renderOrder = 3; addA(leaf);
    const lb = mesh(new THREE.BoxGeometry(rDoor, 0.22, 0.025), frost, { x: lx0, y: 1.2, z: rz1 - 0.07, cast: false }); lb.renderOrder = 4; addA(lb);
    for (const ex of [lx0 - rDoor / 2, lx0 + rDoor / 2]) addA(box(0.035, doorTop - 0.02, 0.035, frameMat, { x: ex, y: (doorTop - 0.02) / 2, z: rz1 - 0.07, cast: false }));
    addA(box(rDoor * 2 + 0.1, 0.06, 0.05, frameMat, { x: dl, y: doorTop + 0.03, z: rz1 - 0.07, cast: false }));                // track
    addA(cyl(0.012, 0.012, 0.5, brass, { x: dl - 0.12, y: 1.0, z: rz1 - 0.035 }, 8));                                          // brass pull
    // a brass plaque on the glass beside the door
    const plaque = canvasTex(256, 80), { ctx } = plaque;
    ctx.fillStyle = '#e2b35d'; ctx.fillRect(0, 0, 256, 80); ctx.strokeStyle = '#b8893a'; ctx.lineWidth = 6; ctx.strokeRect(5, 5, 246, 70);
    ctx.fillStyle = '#3f3a4a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 40px "M PLUS Rounded 1c", sans-serif'; ctx.fillText('Review', 128, 42);
    plaque.tex.needsUpdate = true;
    group.add(mesh(new THREE.PlaneGeometry(0.46, 0.144), new THREE.MeshBasicMaterial({ map: plaque.tex }), { x: dr + 0.4, y: 1.55, z: rz1 + 0.03, cast: false }));
  }
  // rug under the desk and its chairs: sage with a deeper border
  group.add(box(3.0, 0.012, 2.9, matte(PAL.sage), { x: qx, y: 0.006, z: qz + 0.05, cast: false, receive: true }));
  group.add(box(2.8, 0.014, 2.7, matte(PAL.sageLight), { x: qx, y: 0.007, z: qz + 0.05, cast: false, receive: true }));
  // the partners' desk: two drawer pedestals, a kneehole on each side, a leather inlay with a brass hairline
  obs(qx, qz, 1.06, 1.76); contact(qx, qz, 1.3, 2.0);
  group.add(roundedBox(1.06, 0.06, 1.76, 0.03, wood, { x: qx, y: 0.735, z: qz, outline: 0.012 }));     // top surface at 0.78 (the bevel adds 0.015)
  group.add(box(0.84, 0.004, 1.5, brass, { x: qx, y: 0.782, z: qz, cast: false }));
  group.add(box(0.8, 0.006, 1.46, toon(PAL.sageDeep), { x: qx, y: 0.784, z: qz, cast: false }));
  for (const sz of [-1, 1]) {
    const pz = qz + sz * 0.64;
    group.add(box(0.98, 0.68, 0.42, woodDeep, { x: qx, y: 0.38, z: pz, outline: 0.012 }));
    group.add(box(1.0, 0.04, 0.44, toon(PAL.oakDark), { x: qx, y: 0.02, z: pz, cast: false }));                              // plinth
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
      const y = 0.18 + i * 0.2;
      group.add(box(0.006, 0.006, 0.36, toon(0x6e533e), { x: qx + sx * 0.492, y: y + 0.09, z: pz, cast: false }));            // drawer seam
      group.add(box(0.02, 0.02, 0.1, brass, { x: qx + sx * 0.5, y, z: pz, cast: false }));                                    // brass pull
    }
  }
  group.add(box(0.04, 0.42, 0.86, woodDeep, { x: qx, y: 0.5, z: qz, cast: false }));                                          // modesty panel
  // on the desk: in and out trays (reviews in progress / verdicts stamped on this floor), the stamp on its ink pad, a
  // pen cup, a page in front of each seat, a nameplate facing the door and the banker's lamp
  const trays = [];
  for (const tz of [qz + 0.5, qz + 0.18]) {
    const t = new THREE.Group(); t.position.set(qx + 0.02, 0.787, tz); t.rotation.y = Math.PI / 2; group.add(t);
    t.add(box(0.27, 0.012, 0.2, toon(PAL.ink), { y: 0.006 }));
    for (const [w, d, x, z] of [[0.27, 0.012, 0, -0.1], [0.27, 0.012, 0, 0.1], [0.012, 0.2, -0.135, 0], [0.012, 0.2, 0.135, 0]]) t.add(box(w, 0.04, d, brass, { x, y: 0.02, z, cast: false }));
    const sheets = new THREE.Group(); sheets.userData.dynamic = true; t.add(sheets); trays.push({ sheets, n: -1 });
  }
  group.add(box(0.14, 0.012, 0.1, toon(PAL.ink), { x: qx + 0.22, y: 0.79, z: qz - 0.28, cast: false }));                     // ink pad
  group.add(cyl(0.035, 0.045, 0.1, wood, { x: qx + 0.22, y: 0.85, z: qz - 0.12, outline: 0.006 }, 12));                       // stamp
  group.add(sphere(0.03, wood, { x: qx + 0.22, y: 0.91, z: qz - 0.12 }, 10));
  group.add(cyl(0.04, 0.04, 0.1, brass, { x: qx - 0.32, y: 0.84, z: qz + 0.62, outline: 0.006 }, 12));                        // pen cup
  for (const sx of [-1, 1]) { const pg = box(0.21, 0.004, 0.29, toon(PAL.paper), { x: qx + sx * 0.25, y: 0.79, z: qz - 0.02, cast: false }); pg.rotation.y = sx * 0.12; group.add(pg); }
  {
    const np = canvasTex(256, 64), { ctx } = np;
    ctx.fillStyle = '#e2b35d'; ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#3f3a4a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 34px "M PLUS Rounded 1c", sans-serif'; ctx.fillText('Review', 128, 34);
    np.tex.needsUpdate = true;
    const wedge = box(0.34, 0.08, 0.05, woodDeep, { x: qx, y: 0.825, z: qz + 0.8, outline: 0.006 }); wedge.rotation.x = -0.35; group.add(wedge);
    const face = mesh(new THREE.PlaneGeometry(0.3, 0.075), new THREE.MeshBasicMaterial({ map: np.tex }), { x: qx, y: 0.827, z: qz + 0.828, cast: false }); face.rotation.x = -0.35; group.add(face);
  }
  // banker's lamp: brass base and stem, a sage glass shade over its own warm bulb (lit at night while anyone is in)
  const reviewLampMat = toon(0xfff1c9, { emissive: 0xffd88a, emissiveIntensity: 0 }).clone(); reviewLampMat.userData.own = true;
  const reviewShadeMat = toon(PAL.sageDeep, { side: THREE.DoubleSide, emissive: 0x9fd49a, emissiveIntensity: 0 }).clone(); reviewShadeMat.userData.own = true; // the green glass glows a little when lit
  let reviewLampPool = null;
  {
    const lx = qx - 0.24, lz = qz - 0.6;
    const lg0 = new THREE.Group(); lg0.userData.dynamic = true; group.add(lg0);
    group.add(cyl(0.09, 0.1, 0.03, brass, { x: lx, y: 0.8, z: lz, outline: 0.006 }, 16));
    group.add(cyl(0.012, 0.012, 0.3, brass, { x: lx, y: 0.95, z: lz }, 8));
    const shade = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.34, 18, 1, true, 0, Math.PI), reviewShadeMat, { x: lx, y: 1.1, z: lz, outline: 0.008 });
    shade.rotation.z = Math.PI / 2; shade.rotation.y = Math.PI / 2; lg0.add(shade);
    for (const dz of [-0.17, 0.17]) { const ring = cyl(0.076, 0.076, 0.012, brass, { x: lx, y: 1.1, z: lz + dz, cast: false }, 18); ring.rotation.x = Math.PI / 2; group.add(ring); }
    const bulb = mesh(new THREE.PlaneGeometry(0.12, 0.3), reviewLampMat, { x: lx, y: 1.075, z: lz, cast: false }); bulb.rotation.x = Math.PI / 2;
    const lg = new THREE.Group(); lg.userData.dynamic = true; lg.add(bulb); group.add(lg);
    reviewLampPool = mesh(new THREE.CircleGeometry(0.62, 28), new THREE.MeshBasicMaterial({ color: 0xffcf86, map: glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), { x: qx, y: 0.79, z: qz - 0.25, cast: false });
    reviewLampPool.rotation.x = -Math.PI / 2; reviewLampPool.scale.set(0.8, 1, 1); reviewLampPool.userData.dynamic = true; group.add(reviewLampPool);
  }
  // two cognac leather high-backs, tufted, facing each other across the desk
  const reviewSeats = [];
  const highBack = (x, z, facing) => {
    const ch = new THREE.Group(); ch.position.set(x, 0, z); ch.rotation.y = facing; group.add(ch); obs(x, z, 0.5, 0.5);
    ch.add(roundedBox(0.56, 0.12, 0.54, 0.06, leather, { y: 0.46, outline: 0.012 }));
    ch.add(roundedBox(0.58, 0.84, 0.13, 0.06, leather, { y: 0.92, z: -0.26, outline: 0.012 }));
    ch.add(roundedBox(0.6, 0.1, 0.15, 0.05, leatherDeep, { y: 1.36, z: -0.26, outline: 0.01 }));                 // the rolled top
    for (let r = 0; r < 3; r++) for (let c = -1; c <= 1; c++) if ((r + c) % 2 === 0) ch.add(sphere(0.018, leatherDeep, { x: c * 0.15, y: 0.72 + r * 0.19, z: -0.19, cast: false }, 6));
    for (const sx of [-1, 1]) {
      ch.add(roundedBox(0.08, 0.08, 0.46, 0.04, leatherDeep, { x: sx * 0.31, y: 0.68, z: 0.0, outline: 0.008 }));
      ch.add(box(0.04, 0.16, 0.04, brass, { x: sx * 0.31, y: 0.58, z: 0.12, cast: false }));
    }
    ch.add(cyl(0.035, 0.035, 0.32, brass, { y: 0.24 }, 10)); ch.add(starBase(0.28, PAL.ink));
    reviewSeats.push({ x, z, facing, seatY: 0.52, taken: null, approach: { x, z: qz + 1.25 } });
  };
  highBack(qx - 0.95, qz, Math.PI / 2); highBack(qx + 0.95, qz, -Math.PI / 2);
  // two club armchairs by the front glass, turned toward the room
  const clubChair = (x, z, facing) => {
    const ch = new THREE.Group(); ch.position.set(x, 0, z); ch.rotation.y = facing; group.add(ch); obs(x, z, 0.7, 0.7); contact(x, z, 0.85, 0.85);
    ch.add(roundedBox(0.7, 0.3, 0.68, 0.08, leather, { y: 0.24, outline: 0.012 }));
    ch.add(roundedBox(0.56, 0.1, 0.52, 0.05, leatherDeep, { y: 0.42, z: 0.04, outline: 0.008 }));             // cushion
    ch.add(roundedBox(0.7, 0.42, 0.16, 0.08, leather, { y: 0.55, z: -0.27, outline: 0.012 }));
    for (const sx of [-1, 1]) ch.add(roundedBox(0.15, 0.24, 0.66, 0.07, leather, { x: sx * 0.29, y: 0.5, outline: 0.012 }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) ch.add(cyl(0.025, 0.02, 0.09, woodDeep, { x: sx * 0.28, y: 0.045, z: sz * 0.26 }, 8));
    reviewSeats.push({ x, z, facing, seatY: 0.46, taken: null, approach: { x: x + Math.sin(facing) * 0.65, z: z + Math.cos(facing) * 0.65 } });
  };
  // a reading nook at the front left: two club armchairs side by side, a small round table and lamp between them
  clubChair(rx0 + 0.6, rz0 + 3.35, Math.PI / 2); clubChair(rx0 + 0.6, rz0 + 4.55, Math.PI / 2);
  {
    const tx = rx0 + 0.42, tz = rz0 + 3.95; obs(tx, tz, 0.42, 0.42);
    group.add(cyl(0.2, 0.2, 0.03, wood, { x: tx, y: 0.56, z: tz, outline: 0.008 }, 20));
    group.add(cyl(0.025, 0.025, 0.54, woodDeep, { x: tx, y: 0.28, z: tz }, 8)); group.add(cyl(0.14, 0.14, 0.02, woodDeep, { x: tx, y: 0.01, z: tz }, 16));
    group.add(box(0.16, 0.04, 0.22, toon(PAL.terracotta), { x: tx + 0.03, y: 0.595, z: tz + 0.04, outline: 0.005 }));   // a book
    group.add(cyl(0.05, 0.06, 0.02, brass, { x: tx - 0.08, y: 0.585, z: tz - 0.08 }, 12)); group.add(cyl(0.008, 0.008, 0.3, brass, { x: tx - 0.08, y: 0.73, z: tz - 0.08 }, 6));
    group.add(cyl(0.05, 0.09, 0.1, toon(PAL.paper), { x: tx - 0.08, y: 0.9, z: tz - 0.08, outline: 0.005 }, 14));       // reading lamp
  }
  // plants: both back corners and the front right, by the door
  for (const [px, pz, sc] of [[rx0 + 0.35, rz0 + 0.35, 0.75], [rx1 - 0.35, rz0 + 0.35, 0.7], [rx1 - 0.4, rz1 - 0.45, 0.85]]) { group.add(plantAt(sc, px, 0, pz, { salt: px + pz })); obs(px, pz, 0.36, 0.36); }
  // a low credenza along the back wall under the windows: books, a framed print on the pier between them, a plant
  {
    const cw = 2.4, cdz = rz0 + 0.28, inRoom = winX.filter(x => x > rx0), pierX = inRoom.length === 2 ? (inRoom[0] + inRoom[1]) / 2 : rcx;
    obs(rcx, cdz, cw, 0.4); contact(rcx, cdz, cw + 0.2, 0.55);
    group.add(box(cw, 0.62, 0.36, woodDeep, { x: rcx, y: 0.35, z: cdz, outline: 0.012 }));
    group.add(box(cw + 0.04, 0.04, 0.4, wood, { x: rcx, y: 0.68, z: cdz, outline: 0.008 }));
    group.add(box(cw, 0.04, 0.36, toon(PAL.oakDark), { x: rcx, y: 0.02, z: cdz, cast: false }));
    for (const ox of [-0.68, 0.68]) { group.add(box(0.006, 0.5, 0.006, toon(0x6e533e), { x: rcx + ox, y: 0.36, z: cdz + 0.181, cast: false })); group.add(box(0.016, 0.1, 0.02, brass, { x: rcx + ox + (ox < 0 ? 0.05 : -0.05), y: 0.42, z: cdz + 0.19, cast: false })); }
    let x = rcx - 0.62;                                                                                  // books in the open middle bay
    for (let b = 0; b < 8 && x < rcx + 0.6; b++) { const w = 0.07 + (b % 3) * 0.025, h = 0.3 + ((b * 2) % 3) * 0.05; group.add(box(w, h, 0.24, toon(COLORS.book[(b + 1) % 5]), { x: x + w / 2, y: 0.1 + h / 2, z: cdz + 0.04, outline: 0.006 })); x += w + 0.02; }
    const pr = new THREE.Group(); pr.position.set(pierX, 1.3, -hz + 0.24); pr.scale.setScalar(0.72); group.add(pr);  // the print hangs on the pier
    pr.add(box(0.7, 0.52, 0.03, brass, { y: 0.27, outline: 0.008 }));
    pr.add(box(0.62, 0.44, 0.01, toon(PAL.paper), { y: 0.27, z: 0.017, cast: false }));
    pr.add(box(0.46, 0.14, 0.008, toon(PAL.sage), { y: 0.2, z: 0.024, cast: false }));
    { const sun = sphere(0.08, toon(PAL.terracotta), { x: 0.12, y: 0.36, z: 0.022, cast: false }, 14); sun.scale.set(1, 1, 0.1); pr.add(sun); }
    pr.add(box(0.3, 0.06, 0.008, toon(PAL.sageDeep), { x: -0.08, y: 0.15, z: 0.026, cast: false }));
    group.add(plantAt(0.42, rcx + 0.92, 0.7, cdz, { shelf: true, salt: rcx }));
  }
  { // low bookcase against the review room's side glass, behind the left high-back, its books toward the room: the library
    const bcx = rx0 + 0.21, bcz = qz - 0.1;
    const bc = new THREE.Group(); bc.position.set(bcx, 0, bcz); bc.rotation.y = Math.PI / 2; group.add(bc); obs(bcx, bcz, 0.4, 1.5); contact(bcx + 0.04, bcz, 0.6, 1.75);
    { const sh = toon(COLORS.shelf); // an open case (back, sides, top, plinth), so the books show
      bc.add(box(1.45, 0.82, 0.03, sh, { y: 0.41, z: -0.155, outline: 0.012 }));
      for (const sx of [-1, 1]) bc.add(box(0.035, 0.82, 0.34, sh, { x: sx * 0.7075, y: 0.41, outline: 0.012 }));
      bc.add(box(1.45, 0.035, 0.34, sh, { y: 0.8025, outline: 0.012 }));
      bc.add(box(1.45, 0.06, 0.34, sh, { y: 0.03, outline: 0.012 })); }
    bc.add(box(1.37, 0.03, 0.3, toon(PAL.oak), { y: 0.42, z: 0.01 }));
    for (let lvl = 0; lvl < 2; lvl++) {
      let x = -0.62;
      for (let b = 0; b < 9 && x < 0.55; b++) { const w = 0.07 + ((b * 5 + lvl) % 3) * 0.025, h = 0.22 + ((b + lvl * 2) % 3) * 0.04; const bk = box(w, h, 0.22, toon(COLORS.book[(b + lvl * 2) % 5]), { x: x + w / 2, y: 0.06 + lvl * 0.39 + h / 2, z: 0.02, outline: 0.006 }); bc.add(bk); x += w + 0.015; }
    }
    bc.add(plantAt(0.42, 0.45, 0.82, 0, { shelf: true, salt: bcx }));
    catSpot = { x: bcx + 0.01, y: 0.82, z: bcz + 0.33, rot: 1.25 + Math.PI / 2 };    // the cat naps on the library bookcase
  }
  const fillTray = (tray, n, stamped) => {
    n = Math.max(0, Math.min(8, n)); if (n === tray.n) return; tray.n = n; clearProps(tray.sheets);
    for (let i = 0; i < n; i++) {
      tray.sheets.add(box(0.22, 0.005, 0.16, toon(PAL.paper), { y: 0.016 + i * 0.006, cast: false }));
      if (stamped && i === n - 1) tray.sheets.add(box(0.05, 0.004, 0.035, toon(PAL.sageDeep), { x: 0.05, y: 0.02 + i * 0.006, z: 0.04, cast: false }));
    }
    applyMode(tray.sheets);
  };
  const qa = { setTrays(inN, outN) { fillTray(trays[0], inN, false); fillTray(trays[1], outN, true); }, stand: { x: rcx, z: rz1 + 0.15 }, facing: 0,
    spots: reviewSeats, wait: { x: rcx + 0.85, z: rz1 + 0.85, facing: Math.PI }, room: { x0: rx0, x1: rx1, z0: rz0, z1: rz1 } };

  // ---------- huddle room: a small glazed room for 2–4 at the front of the quiet band (glass in front of the camera, so
  //            whoever meets there is seen; the focus pods stand behind it, across a strip from the review room). A short kickoff (a lead with one or two new helpers) is held here; bigger crews use the meeting room.
  //            Same glazing, sliding door and sign as the meeting room; a round-cornered table for four and a wall screen ----------
  const huddle = (() => {
    const x0 = xQuiet0 + 1.65, x1 = hx - 0.2, z0 = hz - 2.7, z1 = hz - 0.2, doorW = 1.0, doorTop = 2.2;
    const { frameMat, glassMat, frost, glassWall } = glazing, H = wallH;
    const dx0 = x0 + 0.15, dx1 = dx0 + doorW;                                                          // the door, in the back glass
    glassWall(x0, z0, x0, z1); glassWall(x0, z1, x1, z1); glassWall(x0, z0, dx0, z0); glassWall(dx1, z0, x1, z0);
    glassWall(dx0, z0, dx1, z0, doorTop, H, false);                                                    // transom over the door
    addA(box(doorW * 2 + 0.1, 0.06, 0.05, frameMat, { x: dx1, y: doorTop + 0.03, z: z0 + 0.07, cast: false }));    // track
    const slider = new THREE.Group(); slider.position.set(dx0 + doorW / 2, 0, z0 + 0.07); slider.userData.dynamic = true; group.add(arch(slider));
    { const leaf = mesh(new THREE.BoxGeometry(doorW + 0.04, doorTop - 0.04, 0.02), glassMat, { y: (doorTop - 0.02) / 2, cast: false }); leaf.renderOrder = 3; slider.add(leaf);
      const lb = mesh(new THREE.BoxGeometry(doorW + 0.04, 0.22, 0.025), frost, { y: 1.2, cast: false }); lb.renderOrder = 4; slider.add(lb);
      for (const sx of [-1, 1]) slider.add(box(0.035, doorTop - 0.02, 0.035, frameMat, { x: sx * (doorW / 2 + 0.02), y: (doorTop - 0.02) / 2, cast: false }));
      slider.add(box(doorW + 0.07, 0.04, 0.035, frameMat, { y: 0.02, cast: false }));
      slider.add(cyl(0.012, 0.012, 0.5, toon(PAL.metal), { x: -doorW / 2 + 0.1, y: 1.0, z: -0.035 }, 8));
      arch(slider); freezeStatic(slider); }
    const slide = { open: 1, target: 1, vel: 0 };
    const updateDoor = dt => {
      const k = 30, c = 2 * Math.sqrt(k) * 0.9, h = Math.min(Math.max(dt, 0), SPRING_DT);
      slide.vel += (k * (slide.target - slide.open) - c * slide.vel) * h; slide.open = Math.max(-0.02, Math.min(1.02, slide.open + slide.vel * h));
      if (!Number.isFinite(slide.open) || !Number.isFinite(slide.vel)) { slide.open = slide.target; slide.vel = 0; }
      slider.position.x = dx0 + doorW / 2 + slide.open * (doorW - 0.06);
    };
    // the table for four runs from the screen toward the front glass, two chairs down each side turned a little toward
    // the screen, so everyone faces the presenter and the screen faces the room (and the camera)
    const tx = (x0 + x1) / 2 - 0.1, tz = (z0 + z1) / 2 + 0.2;
    group.add(roundedBox(0.85, 0.05, 1.3, 0.2, toon(PAL.oak), { x: tx, y: 0.725, z: tz, outline: 0.012 }));
    for (const sz of [-0.35, 0.35]) { group.add(cyl(0.05, 0.05, 0.68, toon(PAL.slateDark), { x: tx, y: 0.36, z: tz + sz }, 10)); group.add(box(0.6, 0.03, 0.12, toon(PAL.slateDark), { x: tx, y: 0.015, z: tz + sz, cast: false })); }
    obs(tx, tz, 0.85, 1.3); contact(tx, tz, 1.1, 1.55);
    group.add(cyl(0.05, 0.05, 0.03, toon(PAL.slateDark), { x: tx, y: 0.765, z: tz + 0.3, outline: 0.005 }, 16));   // a conference speaker
    const seats = [];
    for (const side of [-1, 1]) for (const dz of [-0.33, 0.33]) {
      const sx = tx + side * 0.64, sz = tz + dz, facing = side < 0 ? Math.PI / 2 + 0.35 : -Math.PI / 2 - 0.35;
      const ch = new THREE.Group(); ch.position.set(sx, 0, sz); ch.rotation.y = facing; group.add(ch);
      ch.add(roundedBox(0.44, 0.08, 0.44, 0.08, toon(PAL.sage), { y: 0.42, outline: 0.012 }));
      ch.add(roundedBox(0.44, 0.38, 0.08, 0.08, toon(PAL.sage), { y: 0.66, z: -0.21, outline: 0.012 }));
      ch.add(cyl(0.03, 0.03, 0.34, toon(COLORS.chair), { y: 0.2 }, 10)); ch.add(starBase(0.23, COLORS.chair));
      seats.push({ x: sx, z: sz, facing, seatY: 0.46, meeting: true, taken: null, floor: level });
    }
    // a screen on a slim stand against the back glass, facing the table (the kickoff list shows on it)
    const sw = 1.0, shh = 0.6, scz = z0 + 0.16, scy = 1.35;
    const scr = canvasTex(512, 300);
    group.add(box(0.5, 1.1, 0.06, toon(PAL.slateDark), { x: tx, y: 0.55, z: scz - 0.03, cast: false }));                         // stand
    group.add(box(0.6, 0.04, 0.42, toon(PAL.slateDark), { x: tx, y: 0.02, z: scz + 0.08, cast: false }));   // base: its back edge stays inside the glass
    group.add(box(sw + 0.06, shh + 0.06, 0.05, toon(PAL.ink), { x: tx, y: scy, z: scz, outline: 0.008 }));
    group.add(mesh(new THREE.PlaneGeometry(sw, shh), new THREE.MeshBasicMaterial({ map: scr.tex }), { x: tx, y: scy, z: scz + 0.03, cast: false }));
    obs(tx, scz + 0.08, 0.6, 0.42);
    let scrKey = null;
    const drawScreen = data => {
      const key = data ? JSON.stringify(data) : 'idle'; if (key === scrKey) return; scrKey = key;
      const { ctx } = scr; ctx.fillStyle = data ? '#2f3442' : '#3a4050'; ctx.fillRect(0, 0, 512, 300);
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      if (!data) { ctx.fillStyle = 'rgba(219,226,214,0.55)'; ctx.font = '30px "M PLUS Rounded 1c", sans-serif'; ctx.fillText('huddle room', 40, 160); }
      else {
        ctx.fillStyle = '#fbf8f2'; ctx.font = 'bold 34px "M PLUS Rounded 1c", sans-serif'; ctx.fillText(fitText(ctx, data.title, 440), 36, 62);
        ctx.strokeStyle = '#9db892'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(36, 78); ctx.lineTo(300, 78); ctx.stroke();
        ctx.font = '27px "M PLUS Rounded 1c", sans-serif';
        (data.items || []).slice(0, 4).forEach((t, i) => { ctx.fillStyle = ['#c9e0bf', '#d9dde6', '#f0c2ad', '#c9e0bf'][i]; ctx.fillText(fitText(ctx, '☐ ' + t, 440), 40, 128 + i * 44); });
      }
      scr.tex.needsUpdate = true;
    };
    drawScreen(null);
    group.add(plantAt(0.6, x0 + 0.35, 0, z1 - 0.35)); obs(x0 + 0.35, z1 - 0.35, 0.3, 0.3);
    // door sign on the glass beside the door: free / in use, like the meeting room's
    const sign = canvasTex(256, 112);
    group.add(box(0.62, 0.28, 0.02, toon(PAL.slateDark), { x: dx1 + 0.42, y: 1.72, z: z0 - 0.03, cast: false }));
    for (const side of [-1, 1]) { // a sign on glass reads from both sides: the walkway's and the room's (and the camera's)
      const pl = mesh(new THREE.PlaneGeometry(0.58, 0.24), new THREE.MeshBasicMaterial({ map: sign.tex }), { x: dx1 + 0.42, y: 1.72, z: z0 + side * 0.045, cast: false }); if (side < 0) pl.rotation.y = Math.PI; group.add(pl); }
    group.add(box(0.62, 0.28, 0.02, toon(PAL.slateDark), { x: dx1 + 0.42, y: 1.72, z: z0 + 0.03, cast: false }));
    let signKey = null;
    const drawSign = (busy, text) => {
      const key = busy ? `busy|${text}` : 'free'; if (key === signKey) return; signKey = key;
      const { ctx } = sign; ctx.fillStyle = '#fbf8f2'; ctx.fillRect(0, 0, 256, 112);
      ctx.fillStyle = busy ? '#cf8466' : '#9db892'; ctx.beginPath(); ctx.arc(30, 38, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3f3a4a'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = 'bold 34px "M PLUS Rounded 1c", sans-serif'; ctx.fillText(busy ? 'In use' : 'Free', 54, 40);
      ctx.font = '24px "M PLUS Rounded 1c", sans-serif'; ctx.fillStyle = '#6d6578'; ctx.fillText(fitText(ctx, busy ? text : 'huddle room', 220), 18, 86);
      sign.tex.needsUpdate = true;
    };
    drawSign(false);
    return { setBoard: drawScreen, setSign: drawSign, x0, x1, z0, z1, seats, small: true, presenter: { x: tx - 0.75, z: z0 + 0.5, facing: 0.35 }, floor: level,   // on the door side, clear of the screen as the camera sees it
      team: null, expected: new Set(), session: false, sessionEnd: 0, deadline: 0, cool: new Map(),
      door: { x: dx0 + doorW / 2, z: z0 }, doorWantOpen: true,
      setDoor(open) { this.doorWantOpen = !!open; slide.target = open ? 1 : 0; },
      updateDoor };
  })();

  // ---------- decor ----------
  const plantSpots = [];
  // plants near the camera stay low (a tall fig in the foreground would hide the room behind it)
  const floorPlant = (scale, x, z, spot, size = 0.45, kind = null) => { group.add(plantAt(scale, x, 0, z, { kind })); obs(x, z, size, size); plantSpots.push(spot); };
  floorPlant(1.1, -hx + 3.25, hz - 0.55, { x: -hx + 3.25, z: hz - 1.45, facing: 0 }, 0.45, 'snake');                 // front of the entrance band, clear of the doors
  floorPlant(0.9, xQuiet0 + 0.5, hz - 0.55, { x: xQuiet0 + 0.5, z: hz - 1.35, facing: 0 }, 0.4, 'round');         // quiet corner, at the front beside the huddle room
  floorPlant(0.8, xBuf0 - 0.3, -hz + 0.5, { x: xBuf0 - 0.3, z: -hz + 1.3, facing: Math.PI }, 0.35);     // between the pantry and the meeting room
  floorPlant(1.0, hx - 0.5, rz1 + 0.45, { x: hx - 1.25, z: rz1 + 0.45, facing: Math.PI / 2 }, 0.4, 'round');      // quiet corner, by the review room's front glass
  // the stair head wall: floor number over a cork board, the extinguisher, and (upper floors) the exit sign
  {
    const fs = canvasTex(256, 160); const { ctx } = fs;
    ctx.fillStyle = accentCss(ACCENT); ctx.fillRect(0, 0, 256, 160);                       // the floor's wayfinding accent
    ctx.fillStyle = '#fbf8f2'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.font = 'bold 92px "M PLUS Rounded 1c", sans-serif'; ctx.fillText(`${level + 1}F`, 128, 70);
    ctx.font = '26px "M PLUS Rounded 1c", sans-serif'; ctx.globalAlpha = 0.85; ctx.fillText(level > 0 ? '↑ up · ↓ down' : '↑ upstairs', 128, 134); ctx.globalAlpha = 1;
    const zs = -3.35;
    group.add(box(0.03, 0.56, 0.86, toon(ACCENT_DEEP), { x: -hx + 0.215, y: 2.5, z: zs, cast: false }));
    const pl = mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshBasicMaterial({ map: fs.tex }), { x: -hx + 0.235, y: 2.5, z: zs, cast: false }); pl.rotation.y = Math.PI / 2; group.add(pl);
    group.add(box(0.03, 0.62, 0.9, toon(PAL.oakDark), { x: -hx + 0.215, y: 1.6, z: zs, cast: false, outline: 0.006 }));       // cork board
    [[0xf3e2a0, -0.28, 0.1], [PAL.sageLight, 0.05, -0.08], [PAL.blush, 0.3, 0.12], [PAL.paper, -0.05, 0.16]].forEach(([c, dz, dy]) => group.add(box(0.035, 0.18, 0.2, toon(c), { x: -hx + 0.235, y: 1.6 + dy, z: zs + dz, cast: false })));
    const ze = -2.6;
    group.add(box(0.04, 0.32, 0.18, toon(PAL.paper), { x: -hx + 0.22, y: 0.9, z: ze, cast: false }));
    group.add(cyl(0.07, 0.07, 0.42, toon(COLORS.extRed), { x: -hx + 0.32, y: 0.42, z: ze, outline: 0.008 }, 14));
    group.add(cyl(0.03, 0.03, 0.08, toon(PAL.ink), { x: -hx + 0.32, y: 0.66, z: ze }, 8));
    obs(-hx + 0.3, ze, 0.2, 0.2);
    if (hasHole) { const es = exitSign(-1); es.position.set(-hx + 0.225, 2.55, -2.0); es.rotation.y = Math.PI / 2; group.add(es); } // arrow toward the stairs down
  }
  const cat = new THREE.Group(); cat.position.set(catSpot.x, catSpot.y, catSpot.z); cat.userData.dynamic = true; group.add(cat);
  const catBody = sphere(0.19, toon(COLORS.cat), { y: 0.12, outline: 0.012 }); catBody.scale.set(1, 0.65, 1.3); cat.add(catBody);
  const catHead = sphere(0.14, toon(COLORS.cat), { y: 0.2, z: 0.2, outline: 0.012 }); cat.add(catHead);
  for (const s of [-1, 1]) { const ear = mesh(new THREE.ConeGeometry(0.05, 0.09, 8), toon(COLORS.cat), { x: s * 0.08, y: 0.32, z: 0.18, outline: 0.01 }); ear.rotation.z = -s * 0.3; cat.add(ear); }
  for (const s of [-1, 1]) cat.add(box(0.05, 0.006, 0.01, toon(PAL.ink), { x: s * 0.05, y: 0.19, z: 0.335, cast: false }));
  for (const s of [-1, 1]) cat.add(box(0.06, 0.03, 0.08, toon(COLORS.catDark), { x: s * 0.07, y: 0.28, z: 0.1, cast: false }));
  const tail = new THREE.Group(); tail.position.set(0.08, 0.1, -0.22); cat.add(tail);
  const tailMesh = capsule(0.035, 0.3, toon(COLORS.catDark), { z: -0.12, outline: 0.01 }); tailMesh.rotation.x = Math.PI / 2 - 0.3; tail.add(tailMesh);
  cat.rotation.y = catSpot.rot;
  tail.userData.dynamic = true; catBody.userData.dynamic = true; freezeStatic(cat);
  const catCtl = { t: 0, update(dt) { this.t += dt; tail.rotation.y = Math.sin(this.t * 1.3) * 0.5; catBody.scale.y = 0.65 + Math.sin(this.t * 1.8) * 0.02; } };
  const clockG = new THREE.Group(); clockG.position.set(-hx + 0.22, 2.35, zDoor - 1.5); clockG.rotation.y = Math.PI / 2; clockG.userData.dynamic = true; group.add(clockG);
  const face = cyl(0.3, 0.3, 0.05, toon(PAL.paper), { outline: 0.012, cast: false }, 32); face.rotation.x = Math.PI / 2; clockG.add(face);
  const hourHand = box(0.03, 0.17, 0.02, toon(PAL.ink), { cast: false }); hourHand.geometry.translate(0, 0.07, 0); hourHand.position.z = 0.035; clockG.add(hourHand);
  const minHand = box(0.02, 0.25, 0.02, toon(PAL.ink), { cast: false }); minHand.geometry.translate(0, 0.1, 0); minHand.position.z = 0.04; clockG.add(minHand);
  clockG.add(sphere(0.025, toon(PAL.terracotta), { z: 0.05 }, 10));
  const clock = { update() { const d = officeClock.now(); const m = d.getMinutes() + d.getSeconds() / 60; const h = (d.getHours() % 12) + m / 60; minHand.rotation.z = -m / 60 * Math.PI * 2; hourHand.rotation.z = -h / 12 * Math.PI * 2; } };

  scene.add(group);

  // ---------- floor zones: one finish per zone, edges on zone boundaries ----------
  {
    // uv in metres, so textures keep their real tile size; `origin` [x, z] lines the tile grid up with another zone's
    const zoneFloor = (x0, z0, x1, z1, mat, y, origin = null) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0); const uv = g.attributes.uv;
      const ou = origin ? x0 - origin[0] : 0, ov = origin ? origin[1] - z1 : 0;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (x1 - x0) + ou, uv.getY(i) * (z1 - z0) + ov);
      const m = mesh(g, mat, { x: (x0 + x1) / 2, y, z: (z0 + z1) / 2, cast: false, receive: true }); m.rotation.x = -Math.PI / 2; group.add(m);
    };
    const strip = matte(0xa99a83);
    const trimRect = (x0, z0, x1, z1) => { // the thin carpet trim round a rectangle
      group.add(box(x1 - x0 + 0.06, 0.012, 0.04, strip, { x: (x0 + x1) / 2, y: 0.008, z: z0, cast: false }));
      group.add(box(x1 - x0 + 0.06, 0.012, 0.04, strip, { x: (x0 + x1) / 2, y: 0.008, z: z1, cast: false }));
      group.add(box(0.04, 0.012, z1 - z0, strip, { x: x0, y: 0.008, z: (z0 + z1) / 2, cast: false }));
      group.add(box(0.04, 0.012, z1 - z0, strip, { x: x1, y: 0.008, z: (z0 + z1) / 2, cast: false }));
    };
    // open work: one rectangular carpet under all six pods, with a thin trim
    const zs = desks.map(d => d.cellZ);
    const x0 = xWork0 + 0.15, x1 = xQuiet0 - 0.15;
    const z0 = Math.min(...zs) - CELL_D / 2 - 0.3, z1 = Math.max(...zs) + CELL_D / 2 + 0.2;
    const ct = carpetTexture(); ct.repeat.set(1 / 2.4, 1 / 2.4);
    const tint = (c, k) => new THREE.Color(0xffffff).lerp(new THREE.Color(c), k);
    const hue = [PAL.sage, PAL.terracotta, PAL.mustard][variant], hueK = [0.18, 0.15, 0.18][variant]; // each floor its own hue: sage / blush / mustard-cream
    zoneFloor(x0, z0, x1, z1, new THREE.MeshStandardMaterial({ map: ct, color: tint(hue, hueK), roughness: 1 }), 0.006);
    trimRect(x0, z0, x1, z1);
    // team zones: a clearly deeper tint of the same carpet under each pod (its desk, chair and all four helper desks), laid
    // like taped-out rectangles with no trim of their own, so a pod reads as a neighbourhood even when few people are in;
    // tiles line up with the carpet around them, and a sliver of the base carpet stays between neighbours and the trim
    const rugMat = new THREE.MeshStandardMaterial({ map: ct, color: tint(hue, hueK + 0.18).multiplyScalar(0.9), roughness: 1 });
    for (const d of desks) {
      const rx0 = Math.max(d.cellX - 2.1, x0 + 0.08), rx1 = Math.min(d.cellX + 2.1, x1 - 0.08), rz0 = d.cellZ - 0.3 - 1.8, rz1 = d.cellZ - 0.3 + 1.8;
      zoneFloor(rx0, rz0, rx1, rz1, rugMat, 0.0068, [x0, z1]);
    }
    // meeting room: its own carpet in the slate of its chairs, exactly inside the glass
    const mt = carpetTexture(); mt.repeat.set(1 / 2.4, 1 / 2.4);
    zoneFloor(meeting.x0, meeting.z0, meeting.x1, meeting.z1, new THREE.MeshStandardMaterial({ map: mt, color: PAL.slateLight, roughness: 1 }), 0.007);
    zoneFloor(huddle.x0, huddle.z0, huddle.x1, huddle.z1, new THREE.MeshStandardMaterial({ map: mt, color: PAL.sageLight, roughness: 1 }), 0.007);   // the huddle room: sage, like its chairs
    // quiet corner: a warmer, softer carpet across the whole band (the library, the review room, the focus pod)
    const qt = carpetTexture(); qt.repeat.set(1 / 2.4, 1 / 2.4);
    zoneFloor(xQuiet0 + 0.05, -hz + 0.2, hx - 0.2, hz - 0.2, new THREE.MeshStandardMaterial({ map: qt, color: tint(PAL.oakMid, 0.35), roughness: 1 }), 0.006);
    group.add(box(0.04, 0.012, D - 0.4, strip, { x: xQuiet0 + 0.05, y: 0.008, z: 0, cast: false }));
    // pantry: porcelain tiles across the social band along the back wall
    const tt = tileTexture(); tt.repeat.set(1 / 2.4, 1 / 2.4);
    zoneFloor(xSoc0, -hz + 0.2, xBuf0, -hz + 2.3, new THREE.MeshStandardMaterial({ map: tt, roughness: 0.6 }), 0.006);
  }

  // ---------- the two walls nearest the camera, cut down to a low stub (cutaway view): the room is enclosed ----------
  {
    const stubH = 0.34, capMat = matte(0xfdfaf4);
    obs(hx - 0.1, 0, 0.2, D); obs(0, hz - 0.1, W, 0.2);
    addA(box(0.2, stubH, D, wallMat, { x: hx - 0.1, y: stubH / 2, z: 0, cast: false, receive: true }));
    addA(box(0.26, 0.05, D + 0.06, capMat, { x: hx - 0.1, y: stubH + 0.025, z: 0, cast: false, receive: true }));
    addA(box(W, stubH, 0.2, wallMat, { x: 0, y: stubH / 2, z: hz - 0.1, cast: false, receive: true }));
    addA(box(W + 0.06, 0.05, 0.26, capMat, { x: 0, y: stubH + 0.025, z: hz - 0.1, cast: false, receive: true }));
    addA(box(0.05, 0.12, D - 0.4, trimMat, { x: hx - 0.225, y: 0.06, z: 0, cast: false }));     // skirting, inside face
    addA(box(W - 0.4, 0.12, 0.05, trimMat, { x: 0, y: 0.06, z: hz - 0.225, cast: false }));
  }

  // ---------- office infrastructure ----------
  {
    const dark = toon(PAL.ink), light = toon(PAL.trim);
    if (hasDoor) {
      // coat rack and umbrella stand along the front wall, clear of both door leaves; exit sign over the door
      const rx = -hx + 2.3, rz = hz - 0.5;
      const rack = new THREE.Group(); rack.position.set(rx, 0, rz); group.add(rack); obs(rx, rz, 0.45, 0.45);
      rack.add(cyl(0.2, 0.22, 0.04, dark, { y: 0.02 }, 16));
      rack.add(cyl(0.025, 0.025, 1.7, toon(PAL.oakDark), { y: 0.87 }, 8));
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; const hook = cyl(0.015, 0.015, 0.22, toon(PAL.oakDark), { x: Math.sin(a) * 0.08, y: 1.62, z: Math.cos(a) * 0.08 }, 6); hook.rotation.set(Math.cos(a) * 0.9, 0, -Math.sin(a) * 0.9); rack.add(hook); }
      const coat = new THREE.Group(); coat.position.set(0.13, 1.56, 0.02); coat.rotation.z = -0.12; rack.add(coat);
      const body = cyl(0.09, 0.17, 0.62, toon(PAL.slateDark), { y: -0.36, outline: 0.01 }, 14); body.scale.set(1, 1, 0.55); coat.add(body);
      coat.add(sphere(0.07, toon(PAL.slateDark), { y: -0.04 }, 10));                               // collar over the hook
      coat.add(box(0.02, 0.5, 0.012, toon(PAL.ink), { y: -0.38, z: 0.09, cast: false }));         // front opening
      const scarf = capsule(0.035, 0.34, toon(PAL.mustard), { x: -0.1, y: 1.38, z: -0.03 }); scarf.rotation.z = 0.15; rack.add(scarf);
      rack.add(cyl(0.11, 0.11, 0.08, toon(PAL.oakDark), { y: 1.79 }, 16));                         // hat on top
      rack.add(cyl(0.17, 0.17, 0.015, toon(PAL.oakDark), { y: 1.75 }, 18));
      const ux = -hx + 2.85, uz = hz - 0.45;
      const stand = new THREE.Group(); stand.position.set(ux, 0, uz); group.add(stand); obs(ux, uz, 0.3, 0.3);
      stand.add(cyl(0.11, 0.1, 0.5, toon(PAL.slateDark), { y: 0.25, outline: 0.008 }, 14));
      for (const [dx, col] of [[0.03, PAL.sage], [-0.04, PAL.terracotta]]) { const u = cyl(0.025, 0.02, 0.75, toon(col), { x: dx, y: 0.55, z: 0.02 }, 8); u.rotation.z = dx * 3; stand.add(u); }
      const es = exitSign(); es.position.set(-hx + 0.225, 2.5, zDoor); es.rotation.y = Math.PI / 2; group.add(es);
    }
    // print island: front of the shared-rooms band, between the lounge and the desks; a low storage cabinet with
    // plants on top, the copier in front of it with its output facing the room and the camera
    const bx = (meeting.x0 + meeting.x1) / 2, bz = hz - 2.75;
    group.add(roundedBox(1.8, 0.86, 0.5, 0.05, toon(PAL.oakMid), { x: bx, y: 0.43, z: bz, outline: 0.012 }));
    group.add(box(1.84, 0.04, 0.54, toon(PAL.oak), { x: bx, y: 0.88, z: bz, outline: 0.008 }));
    for (const dx of [-0.45, 0, 0.45]) group.add(box(0.02, 0.6, 0.012, toon(PAL.oakDark), { x: bx + dx, y: 0.45, z: bz + 0.255, cast: false })); // door gaps
    for (const [dx, sc] of [[-0.6, 0.45], [0.55, 0.38]]) group.add(plantAt(sc, bx + dx, 0.9, bz));
    group.add(box(0.3, 0.22, 0.24, toon(PAL.paper), { x: bx, y: 1.0, z: bz, outline: 0.008 }));        // paper reams
    obs(bx, bz, 1.85, 0.55); contact(bx, bz, 2.05, 0.75);
    const cop = new THREE.Group(); cop.position.set(bx, 0, bz + 0.62); group.add(cop); obs(bx, bz + 0.62, 0.85, 0.65); contact(bx, bz + 0.64, 1.05, 0.85);
    cop.add(box(0.8, 0.82, 0.6, light, { y: 0.41, outline: 0.012 }));
    cop.add(box(0.82, 0.08, 0.62, toon(PAL.slateLight), { y: 0.86 }));
    cop.add(box(0.5, 0.03, 0.34, dark, { y: 0.915, z: -0.05 }));                       // scanner glass
    cop.add(box(0.22, 0.06, 0.14, toon(PAL.slateDark), { x: 0.24, y: 0.92, z: 0.2 }));      // control panel
    cop.add(box(0.46, 0.02, 0.26, toon(PAL.paper), { y: 0.62, z: 0.33, cast: false })); // output tray
    const printed = new THREE.Group(); printed.userData.dynamic = true; cop.add(printed);
    const panelLed = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshBasicMaterial({ color: PAL.slateDark })); panelLed.position.set(0.3, 0.955, 0.24); cop.add(panelLed);
    copier = {
      queue: 0, active: null, count: 0,
      pickup: { x: bx, z: bz + 1.45, facing: Math.PI }, // stand here, facing the output tray
      print() { this.queue++; },
      take() { // someone collects the newest finished sheet from the tray
        const done = printed.children.filter(c => c !== this.active?.sh);
        const sh = done[done.length - 1]; if (sh) { printed.remove(sh); sh.geometry.dispose(); this.count = Math.max(0, this.count - 1); }
      },
      update(dt) {
        if (!this.active && this.queue > 0) {
          this.queue--; const sh = box(0.21, 0.004, 0.29, toon(PAL.paper), { y: 0.635, z: 0.05, cast: false }); printed.add(sh); applyMode(sh); this.active = { sh, t: 0 };
        }
        if (this.active) {
          const a = this.active; a.t += dt; const k = Math.min(1, a.t / 1.1);
          a.sh.position.set(Math.sin(this.count * 2.3) * 0.02, 0.635 + Math.min(this.count, 12) * 0.005, 0.05 + k * 0.28);
          a.sh.rotation.y = Math.sin(this.count * 1.7) * 0.06;
          panelLed.material.color.setHex(Math.sin(a.t * 14) > 0 ? COLORS.ledOn : COLORS.ledOff);
          if (k >= 1) { this.active = null; this.count++; panelLed.material.color.setHex(PAL.slateDark); if (printed.children.length > 12) { const old = printed.children[0]; printed.remove(old); old.geometry.dispose(); } }
        }
      },
    };
    for (let i = 0; i < 3; i++) cop.add(box(0.7, 0.02, 0.02, toon(PAL.slateLight), { y: 0.2 + i * 0.18, z: 0.302, cast: false }));
    // water cooler beside the fridge (the recycling lives in pull-out bins under the counter)
    const wcx = fx + 0.66;
    const wcg = new THREE.Group(); wcg.position.set(wcx, 0, -hz + 0.48); group.add(wcg); obs(wcx, -hz + 0.48, 0.38, 0.38);
    wcg.add(box(0.32, 0.95, 0.32, light, { y: 0.475, outline: 0.01 }));
    wcg.add(cyl(0.13, 0.13, 0.4, new THREE.MeshStandardMaterial({ color: COLORS.water, transparent: true, opacity: 0.75, roughness: 0.2 }), { y: 1.15, cast: false }, 18));
    const bubbles = Array.from({ length: 6 }, (_, i) => { const b = new THREE.Mesh(new THREE.SphereGeometry(0.018 + (i % 3) * 0.006, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })); b.userData.phase = i / 6; b.userData.dynamic = true; b.renderOrder = 4; wcg.add(b); return b; });
    cooler = {
      spot: { x: wcx, z: -hz + 1.25, facing: Math.PI }, inUse: 0, t: 0,
      use(seconds = 2.5) { this.inUse = Math.max(this.inUse, seconds); },
      update(dt) {
        this.t += dt; this.inUse = Math.max(0, this.inUse - dt);
        for (const b of bubbles) {
          const u = (this.t * 0.9 + b.userData.phase) % 1;
          b.position.set(Math.sin(b.userData.phase * 20) * 0.06, 0.97 + u * 0.36, Math.cos(b.userData.phase * 13) * 0.05);
          b.material.opacity = this.inUse > 0 ? 0.7 * Math.sin(u * Math.PI) : 0;
        }
      },
    };
    wcg.add(box(0.06, 0.05, 0.05, toon(COLORS.cold), { x: -0.06, y: 0.72, z: 0.17 })); wcg.add(box(0.06, 0.05, 0.05, toon(COLORS.hot), { x: 0.06, y: 0.72, z: 0.17 }));
  }

  // ---------- zone edges: a low planter trough between the lounge and the print island (the main aisle stays open),
  //            and a tall plant marking where the quiet corner begins ----------
  {
    const px = xBuf0 + 0.45, pz0 = 2.3, pz1 = hz - 0.6, len = pz1 - pz0, pzc = (pz0 + pz1) / 2;
    group.add(box(0.36, 0.42, len, toon(PAL.oakMid), { x: px, y: 0.21, z: pzc, outline: 0.012 }));
    group.add(box(0.38, 0.04, len + 0.02, toon(PAL.oak), { x: px, y: 0.43, z: pzc, cast: false }));     // rim
    group.add(box(0.3, 0.02, len - 0.06, toon(SOIL), { x: px, y: 0.44, z: pzc, cast: false }));         // soil
    group.add(roundedBox(0.34, 0.2, len - 0.08, 0.1, toon(PAL.leaf), { x: px, y: 0.5, z: pzc, outline: 0.012 }));   // continuous low planting
    for (let i = 0; i < 3; i++) { const tp = plant(0.55 + (i % 2) * 0.15, { kind: ['snake', 'round', 'snake'][i], pot: PAL.oakMid }); tp.position.set(px, 0.42, pz0 + 0.45 + (len - 0.9) * i / 2); tp.rotation.y = i * 1.7; group.add(tp); } // taller accents
    obs(px, pzc, 0.38, len + 0.04); contact(px, pzc, 0.6, len + 0.25);
    group.add(plantAt(1.15, xQuiet0 + 0.45, 0, 1.0, { kind: 'fiddle' })); obs(xQuiet0 + 0.45, 1.0, 0.45, 0.45);   // clear of the aisle to the fire exit
  }

  // ---------- the core: two WCs, an accessible WC and the lift along the back wall of the entrance band, full height,
  //            on every floor. Sized for a floor of 30 (≈3 WCs for 26–50 people): the WC doors face the stair head, and
  //            the lift stands between them and the kitchen, so no WC door opens beside the counter ----------
  const core = { x0: -hx + 0.2, x1: -hx + 5.6, z0: -hz + 0.2, z1: -hz + 2.3 };
  let wc = null, lift = null, dayBoard = null;
  const wcs = [];
  {
    const { x0, x1, z0, z1 } = core, cw = x1 - x0, cd = z1 - z0, ccx = (x0 + x1) / 2, ccz = (z0 + z1) / 2;
    const t = 0.12, tp = 0.1;                                       // outer walls and partitions (as cut at the top)
    const rooms = [['wc', 0.95], ['wc', 0.95], ['acc', 1.55], ['lift', 0]];
    { let x = x0 + t; for (const r of rooms) { const w = r[1] || x1 - t - x; r.push(x, x + w); x += w + tp; } }
    const lx = (rooms[3][2] + rooms[3][3]) / 2;
    const doors = rooms.slice(0, 3).map(([kind, , a, b]) => ({ kind, x: (a + b) / 2, leaf: kind === 'acc' ? 0.9 : 0.7 }));
    obs(ccx, ccz, cw, cd);
    addA(box(cw, wallH, cd, wallMat, { x: ccx, y: wallH / 2, z: ccz, cast: false, receive: true }));
    // skirting, wainscot and rail continue round the core's two room faces, interrupted by the doors
    const gaps = [...doors.map(d => [d.x - d.leaf / 2 - 0.08, d.x + d.leaf / 2 + 0.08]), [lx - 0.64, lx + 0.64]];
    const alongFront = (h, y, d, mat) => { let a = x0; for (const [g0, g1] of [...gaps, [x1 + d, x1 + d]]) { if (g0 - a > 0.01) addA(box(g0 - a, h, d, mat, { x: (a + g0) / 2, y, z: z1 + d / 2, cast: false })); a = g1; } };
    alongFront(0.12, 0.06, 0.05, trimMat); alongFront(0.95, 0.475, 0.03, wainMat); alongFront(0.06, 0.97, 0.06, railMat);
    addA(box(0.05, 0.12, cd + 0.05, trimMat, { x: x1 + 0.025, y: 0.06, z: ccz + 0.025, cast: false }));
    addA(box(0.03, 0.95, cd + 0.03, wainMat, { x: x1 + 0.015, y: 0.475, z: ccz + 0.015, cast: false }));
    addA(box(0.06, 0.06, cd + 0.06, railMat, { x: x1 + 0.03, y: 0.97, z: ccz + 0.03, cast: false }));
    // above the rail the core's two room faces are clad in mid oak boards (light enough to read as a warm object in a wide
    // shot, not a dark lump), with the floor's accent as one band at door-head height for wayfinding
    { const clad = matte(PAL.oakMid), joint = matte(new THREE.Color(PAL.oakMid).lerp(new THREE.Color(PAL.oakDark), 0.4).getHex()), ph = wallH - 1.0, yc = 1.0 + ph / 2;
      const bandM = matte(new THREE.Color(ACCENT).lerp(new THREE.Color(PAL.cream), 0.12).getHex()), bandY = 2.42, BOARD = 0.42;
      addA(box(cw + 0.012, ph, 0.012, clad, { x: ccx + 0.006, y: yc, z: z1 + 0.006, cast: false, receive: true }));
      addA(box(0.012, ph, cd, clad, { x: x1 + 0.006, y: yc, z: ccz, cast: false, receive: true }));
      for (let x = x0 + BOARD; x < x1 - 0.1; x += BOARD) addA(box(0.014, ph, 0.004, joint, { x, y: yc, z: z1 + 0.013, cast: false }));
      for (let z = z0 + BOARD; z < z1 - 0.1; z += BOARD) addA(box(0.004, ph, 0.014, joint, { x: x1 + 0.013, y: yc, z, cast: false }));
      addA(box(cw + 0.024, 0.12, 0.018, bandM, { x: ccx + 0.012, y: bandY, z: z1 + 0.009, cast: false }));
      addA(box(0.018, 0.12, cd + 0.024, bandM, { x: x1 + 0.009, y: bandY, z: ccz + 0.012, cast: false })); }
    // cut top: the section of a hollow core (thick outer walls, partitions between the WCs and the lift shaft), so from
    // above it reads as four rooms, not as one solid block
    { const fill = matte(0xefe6d9);
      addA(box(cw - 2 * t, 0.03, cd - 2 * t, fill, { x: ccx, y: wallH + 0.015, z: ccz, cast: false }));
      for (const zz of [z0 + t / 2, z1 - t / 2]) addA(box(cw, 0.032, t, pocheMat, { x: ccx, y: wallH + 0.016, z: zz, cast: false }));
      for (const xx of [x0 + t / 2, x1 - t / 2]) addA(box(t, 0.032, cd - 2 * t, pocheMat, { x: xx, y: wallH + 0.016, z: ccz, cast: false }));
      for (const r of rooms.slice(0, 3)) addA(box(tp, 0.032, cd - 2 * t, pocheMat, { x: r[3] + tp / 2, y: wallH + 0.016, z: ccz, cast: false })); }
    // lift: steel doors in an accent surround, a floor indicator above, call buttons beside (on the WC side)
    addA(box(1.28, 2.34, 0.05, toon(ACCENT_DEEP), { x: lx, y: 1.17, z: z1 + 0.025, cast: false }));
    for (const sx of [-1, 1]) addA(box(0.5, 2.14, 0.03, toon(PAL.metal), { x: lx + sx * 0.256, y: 1.08, z: z1 + 0.06, outline: 0.006 }));
    addA(box(0.012, 2.14, 0.006, toon(PAL.slateDark), { x: lx, y: 1.08, z: z1 + 0.078, cast: false }));
    addA(box(0.48, 0.16, 0.03, toon(PAL.ink), { x: lx, y: 2.52, z: z1 + 0.015, cast: false, outline: 0.006 }));
    { const tx = canvasTex(192, 64); const { ctx } = tx; ctx.fillStyle = '#3f3a4a'; ctx.fillRect(0, 0, 192, 64);
      ctx.fillStyle = '#e2b35d'; ctx.font = 'bold 44px "M PLUS Rounded 1c", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`▲ ${level + 1} ▼`, 96, 34);
      addA(mesh(new THREE.PlaneGeometry(0.44, 0.14), new THREE.MeshBasicMaterial({ map: tx.tex }), { x: lx, y: 2.52, z: z1 + 0.034, cast: false })); }
    const bx = rooms[2][3] + tp / 2;                                 // on the partition between the accessible WC and the lift
    addA(box(0.09, 0.22, 0.02, toon(PAL.metal), { x: bx, y: 1.1, z: z1 + 0.01, cast: false, outline: 0.005 }));
    for (const dy of [0.05, -0.05]) addA(sphere(0.018, toon(PAL.mustard), { x: bx, y: 1.1 + dy, z: z1 + 0.022, cast: false }, 8));
    // the WC doors: oak in a light frame, lever handle, kick plate, a sign plate and an occupancy dot (sage free,
    // terracotta while someone is in)
    const fm = matte(0xfaf6f0);
    const signTex = acc => { const tx = canvasTex(128, 128); const { ctx } = tx; ctx.fillStyle = '#565e6e'; ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#fbf8f2'; ctx.strokeStyle = '#fbf8f2'; ctx.lineWidth = 7; ctx.lineCap = 'round';
      if (acc) { ctx.beginPath(); ctx.arc(52, 26, 8, 0, 7); ctx.fill();                                    // accessible symbol
        ctx.beginPath(); ctx.moveTo(52, 38); ctx.lineTo(52, 62); ctx.lineTo(72, 62); ctx.lineTo(80, 80); ctx.stroke();
        ctx.beginPath(); ctx.arc(50, 72, 18, 0.4, 5.2); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(64, 28, 9, 0, 7); ctx.fill(); ctx.fillRect(52, 42, 24, 40); }         // a person
      ctx.font = 'bold 30px "M PLUS Rounded 1c", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('WC', 64, 110);
      tx.tex.needsUpdate = true; return tx.tex; };
    const plainSign = signTex(false), accSign = signTex(true);
    for (const d of doors) {
      const { x: wx, leaf } = d, acc = d.kind === 'acc';
      for (const sx of [-1, 1]) addA(box(0.07, 2.15, 0.06, fm, { x: wx + sx * (leaf / 2 + 0.04), y: 1.075, z: z1 + 0.03, cast: false }));
      addA(box(leaf + 0.15, 0.07, 0.06, fm, { x: wx, y: 2.185, z: z1 + 0.03, cast: false }));
      addA(box(leaf, 2.12, 0.04, toon(PAL.oak), { x: wx, y: 1.06, z: z1 + 0.02, outline: 0.01 }));
      addA(box(leaf - 0.06, 0.18, 0.01, toon(PAL.metal), { x: wx, y: 0.13, z: z1 + 0.045, cast: false }));
      { const rose = cyl(0.03, 0.03, 0.02, toon(PAL.metal), { x: wx - leaf / 2 + 0.11, y: 1.0, z: z1 + 0.05 }, 10); rose.rotation.x = Math.PI / 2; addA(rose); }
      addA(box(0.13, 0.022, 0.025, toon(PAL.metal), { x: wx - leaf / 2 + 0.16, y: 1.0, z: z1 + 0.07, cast: false }));
      const dotMat = toon(PAL.sage, { emissive: PAL.sage, emissiveIntensity: 0.25 }).clone(); dotMat.userData.own = true;
      const dot = sphere(0.022, dotMat, { x: wx - leaf / 2 + 0.11, y: 1.14, z: z1 + 0.05, cast: false }, 8); dot.userData.dynamic = true; group.add(dot);
      const ss = acc ? 0.24 : 0.2;
      addA(box(ss, ss, 0.012, toon(PAL.slateDark), { x: wx, y: 1.55, z: z1 + 0.046, cast: false }));
      addA(mesh(new THREE.PlaneGeometry(ss - 0.02, ss - 0.02), new THREE.MeshBasicMaterial({ map: acc ? accSign : plainSign }), { x: wx, y: 1.55, z: z1 + 0.056, cast: false }));
      wcs.push({ spot: { x: wx, z: z1 + 0.6, facing: Math.PI, accessible: acc }, door: { x: wx, z: z1 }, accessible: acc, dotMat, shown: false });
    }
    // the day board on the core's side, facing the pantry: a 1.76 × 1.1 m whiteboard in a slim light frame with a marker
    // tray, written by dayboard.js with what was really finished today (the face is a canvas: its own material, unmerged)
    {
      const bw = 1.76, bh = 1.1, by = 1.72, fx = x1, frameMat = toon(PAL.metal);
      const face = dayBoardSurface();
      group.add(box(0.02, bh + 0.06, bw + 0.06, toon(PAL.paper), { x: fx + 0.01, y: by, z: ccz, cast: false }));             // backing
      const plane = mesh(new THREE.PlaneGeometry(bw, bh), face.mat, { x: fx + 0.03, y: by, z: ccz, cast: false }); plane.rotation.y = Math.PI / 2; group.add(plane); // proud of the backing, inside the frame
      for (const sy of [-1, 1]) group.add(box(0.034, 0.04, bw + 0.08, frameMat, { x: fx + 0.017, y: by + sy * (bh / 2 + 0.02), z: ccz, cast: false, outline: 0.006 }));
      for (const sz of [-1, 1]) group.add(box(0.034, bh + 0.08, 0.04, frameMat, { x: fx + 0.017, y: by, z: ccz + sz * (bw / 2 + 0.02), cast: false, outline: 0.006 }));
      const ty = by - bh / 2 - 0.06;                                                                                          // marker tray under the board
      group.add(box(0.085, 0.022, bw * 0.82, frameMat, { x: fx + 0.045, y: ty, z: ccz, cast: false, outline: 0.006 }));
      group.add(box(0.012, 0.034, bw * 0.82, frameMat, { x: fx + 0.084, y: ty + 0.016, z: ccz, cast: false }));             // lip
      [[PAL.ink, -0.52], [PAL.sageDeep, -0.38], [PAL.terracotta, -0.24], [PAL.mustard, -0.1]].forEach(([c, dz]) => {
        const pen = cyl(0.012, 0.012, 0.13, toon(PAL.paper), { x: fx + 0.045, y: ty + 0.023, z: ccz + dz, cast: false }, 8); pen.rotation.x = Math.PI / 2; group.add(pen);
        const cap = cyl(0.0135, 0.0135, 0.04, toon(c), { x: fx + 0.045, y: ty + 0.023, z: ccz + dz - 0.065, cast: false }, 8); cap.rotation.x = Math.PI / 2; group.add(cap);
      });
      group.add(box(0.05, 0.03, 0.14, toon(PAL.slateDark), { x: fx + 0.045, y: ty + 0.026, z: ccz + 0.45, cast: false, outline: 0.005 })); // eraser: felt
      group.add(box(0.05, 0.022, 0.14, toon(PAL.oak), { x: fx + 0.045, y: ty + 0.052, z: ccz + 0.45, cast: false }));                       // and its grip
      dayBoard = { draw: face.draw, x: fx + 0.03, y: by, z: ccz, w: bw, h: bh }; // faces +x (the pantry)
    }
    wc = wcs[2];                                                     // the accessible one (kept for older callers)
    lift = { spot: { x: lx, z: z1 + 0.7, facing: Math.PI }, door: { x: lx, z: z1 } };
  }

  // ---------- quiet corner: two focus pods side by side between the walkway and the huddle room, felt panels by the fire exit ----------
  const podGlass = new THREE.MeshStandardMaterial({ color: COLORS.glass, transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false }); podGlass.userData.mergeable = true;
  const makeFocusPod = (bxp, bzp) => {
    // a focus pod (the kind of acoustic pod open-plan offices put in for calls and quiet work): slim dark frame, glass on
    // the two sides that face the room, oak outside and sage felt inside the other two, a ventilated roof, an occupancy
    // light over the door; inside, an upholstered bench facing out and a low table with a laptop
    const bw = 1.3, bh = 2.3, frameC = toon(PAL.slate), oakT = toon(PAL.oak), felt = toon(PAL.sage), shell = toon(PAL.paper);
    obs(bxp, bzp, bw + 0.04, bw + 0.04); contact(bxp, bzp, bw + 0.3, bw + 0.3);
    const booth = new THREE.Group(); booth.position.set(bxp, 0, bzp); group.add(booth);
    const hb = bw / 2;
    booth.add(box(bw, 0.07, bw, toon(PAL.oakDark), { y: 0.035 }));                                                      // plinth
    booth.add(box(bw, bh - 0.14, 0.06, oakT, { y: bh / 2, z: -hb + 0.03, outline: 0.012 }));                            // back (oak)
    booth.add(box(0.06, bh - 0.14, bw, oakT, { x: -hb + 0.03, y: bh / 2, outline: 0.012 }));                            // left side (oak)
    booth.add(box(bw - 0.14, bh - 0.3, 0.02, felt, { y: bh / 2, z: -hb + 0.07, cast: false }));                          // felt lining
    booth.add(box(0.02, bh - 0.3, bw - 0.14, felt, { x: -hb + 0.07, y: bh / 2, cast: false }));
    for (const dx of [-0.36, -0.12, 0.12, 0.36]) booth.add(box(0.1, bh - 0.5, 0.012, toon(PAL.sageDeep), { x: dx, y: bh / 2 + 0.05, z: -hb + 0.085, cast: false })); // acoustic slats
    for (const [x, z] of [[-hb, -hb], [hb, -hb], [-hb, hb], [hb, hb]]) booth.add(box(0.05, bh - 0.06, 0.05, frameC, { x: x - Math.sign(x) * 0.025, y: bh / 2, z: z - Math.sign(z) * 0.025 }));
    for (const [w, d, x, z] of [[bw - 0.1, 0.015, 0, hb - 0.03], [0.015, bw - 0.1, hb - 0.03, 0]]) { const g = mesh(new THREE.BoxGeometry(w, bh - 0.2, d), podGlass, { x, y: bh / 2, z, cast: false }); g.renderOrder = 3; booth.add(g); }
    booth.add(box(0.02, bh - 0.2, 0.03, frameC, { x: 0.12, y: bh / 2, z: hb - 0.03, cast: false }));                   // door edge
    booth.add(box(0.02, 0.7, 0.03, toon(PAL.metal), { x: 0.06, y: 1.05, z: hb + 0.0, cast: false }));                  // long pull
    booth.add(box(bw + 0.06, 0.12, bw + 0.06, shell, { y: bh - 0.01, outline: 0.012 }));                                 // roof
    booth.add(box(bw + 0.07, 0.03, bw + 0.07, oakT, { y: bh - 0.08, cast: false }));                                   // oak band under it
    for (let i = 0; i < 5; i++) booth.add(box(0.5, 0.02, 0.04, toon(PAL.slateLight), { x: -0.2, y: bh + 0.06, z: -0.24 + i * 0.12, cast: false })); // ventilation grille
    booth.add(cyl(0.11, 0.12, 0.06, toon(PAL.slateLight), { x: 0.34, y: bh + 0.08, z: 0.3, outline: 0.006 }, 14));     // fan cap
    // inside: bench against the back, a low table with a laptop
    booth.add(box(bw - 0.2, 0.36, 0.42, oakT, { y: 0.25, z: -hb + 0.3, outline: 0.008 }));
    booth.add(roundedBox(bw - 0.24, 0.1, 0.4, 0.05, toon(PAL.slate), { y: 0.43, z: -hb + 0.3, outline: 0.008 }));
    booth.add(roundedBox(bw - 0.24, 0.42, 0.1, 0.05, toon(PAL.slate), { y: 0.78, z: -hb + 0.14, outline: 0.008 }));
    booth.add(box(0.5, 0.03, 0.34, oakT, { y: 0.5, z: 0.18, outline: 0.006 }));
    booth.add(cyl(0.02, 0.02, 0.48, frameC, { y: 0.25, z: 0.18 }, 8)); booth.add(cyl(0.15, 0.15, 0.02, frameC, { y: 0.01, z: 0.18 }, 16));
    booth.add(box(0.3, 0.012, 0.2, toon(PAL.metal), { y: 0.522, z: 0.2, cast: false }));                                 // laptop base
    { const lid = box(0.3, 0.2, 0.01, toon(PAL.metal), { y: 0.62, z: 0.29, cast: false }); lid.rotation.x = 0.25; booth.add(lid); }
    // lit while someone is in: a warm downlight (at night) and the occupancy light over the door (sage free, terracotta busy)
    const podLight = toon(0xfff1c9, { emissive: 0xffd88a, emissiveIntensity: 0 }).clone(); podLight.userData.own = true;
    const podLed = toon(PAL.sage, { emissive: PAL.sage, emissiveIntensity: 0.6 }).clone(); podLed.userData.own = true;
    const podDyn = new THREE.Group(); podDyn.userData.dynamic = true; booth.add(podDyn);
    { const dl = mesh(new THREE.CircleGeometry(0.16, 20), podLight, { y: bh - 0.08, cast: false }); dl.rotation.x = Math.PI / 2; podDyn.add(dl); }
    podDyn.add(box(0.16, 0.04, 0.02, podLed, { x: -0.3, y: bh - 0.12, z: hb + 0.01, cast: false }));
    let podK = 0;
    return { seat: { x: bxp, z: bzp - hb + 0.36, facing: 0, seatY: 0.47, approach: { x: bxp, z: bzp + hb + 0.45 } }, taken: null, floor: level,
      update(dt) {
        podK += ((this.taken ? 1 : 0) - podK) * Math.min(1, dt * 3);
        podLight.emissiveIntensity = podK * (0.25 + NIGHT.lamps);
        podLed.color.setHex(this.taken ? PAL.terracotta : PAL.sage); podLed.emissive.setHex(this.taken ? PAL.terracotta : PAL.sage);
      } };
  };
  const pods = [makeFocusPod(hx - 1.25, hz - 4.5), makeFocusPod(hx - 2.75, hz - 4.5)], pod = pods[0]; // furniture only: agents work at their own desks (no real status maps to a booth); doors face the huddle room's back glass
  {
    // felt panels and the second extinguisher on the strip of wall between the last desk window and the fire exit
    const fpx = (Math.max(...winX.filter(x => x < xFire)) + winW / 2 + 0.06 + xo0) / 2;
    [[1.32, COLORS.felt[0]], [1.8, COLORS.felt[2]], [2.28, COLORS.felt[1]]].forEach(([y, c]) => group.add(box(0.32, 0.42, 0.04, toon(c), { x: fpx, y, z: -hz + 0.22, cast: false, outline: 0.006 })));
    group.add(box(0.18, 0.32, 0.04, toon(PAL.paper), { x: fpx, y: 0.9, z: -hz + 0.22, cast: false }));
    group.add(cyl(0.07, 0.07, 0.42, toon(COLORS.extRed), { x: fpx, y: 0.42, z: -hz + 0.32, outline: 0.008 }, 14));
    group.add(cyl(0.03, 0.03, 0.08, toon(PAL.ink), { x: fpx, y: 0.66, z: -hz + 0.32 }, 8));
  }

  // ---------- stairs ----------
  const stair = flight;
  {
    const g = new THREE.Group(); g.userData.dynamic = true; group.add(g); stair.group = g; // merged on its own: seen through the opening above when the rest of a dimmed floor is not drawn
    const rise = FLOOR_H / STAIR_STEPS, run = STAIR_RUN / STAIR_STEPS;
    const treadMat = toon(PAL.oak), stringerMat = toon(PAL.trim), nosing = toon(PAL.oakDark);
    // The room-facing side of the flight (+x) is built-in shelving: the painted mass under the treads is set back by the
    // shelf depth, and an oak carcass fills the stepped triangle, one bay per two treads, boards every ~0.38 m, holding
    // books, archive boxes and the odd plant in the room palette. The first bays are too low for a shelf and stay solid.
    const SD = 0.3, xFace = stair.x + STAIR_W / 2, shelfMat = toon(PAL.oak), shelfEdge = toon(PAL.oakMid);
    const bayTop = c => 2 * c * rise - 0.02;                             // just under the pitch line: the guard posts stand on the band above
    const hasBay = c => bayTop(c) >= 0.48;
    for (let i = 0; i < STAIR_STEPS; i++) {
      const h = (i + 1) * rise, z = stair.zs + stair.d * (i + 0.5) * run, c = Math.floor(i / 2);
      if (hasBay(c)) {
        const yb = bayTop(c);
        g.add(box(STAIR_W - SD, h, run, stringerMat, { x: stair.x - SD / 2, y: h / 2, z, cast: false, receive: true }));  // the mass behind the shelves
        g.add(box(SD, h - yb, run, stringerMat, { x: xFace - SD / 2, y: (h + yb) / 2, z, cast: false, receive: true })); // over the bay, under the tread
      } else g.add(box(STAIR_W, h, run, stringerMat, { x: stair.x, y: h / 2, z, cast: false, receive: true }));       // solid stringer block, painted
      g.add(box(STAIR_W + 0.02, 0.035, run + 0.015, treadMat, { x: stair.x, y: h + 0.017, z, cast: false, receive: true, outline: 0.01 }));
      g.add(box(STAIR_W + 0.02, 0.02, 0.025, nosing, { x: stair.x, y: h + 0.02, z: z - stair.d * (run / 2), cast: false }));
    }
    {
      const boxCols = [PAL.sage, PAL.terracotta, PAL.mustard, PAL.paper, PAL.slateLight];
      for (let c = 0; c < STAIR_STEPS / 2; c++) {
        if (!hasBay(c)) continue;
        const za = stair.zs + stair.d * 2 * c * run, zb = za + stair.d * 2 * run, zc = (za + zb) / 2, bw = Math.abs(zb - za), yb = bayTop(c);
        const xm = xFace - SD / 2;
        g.add(box(SD, 0.025, bw, shelfMat, { x: xm, y: yb - 0.0125, z: zc, cast: false }));                                 // top board
        g.add(box(0.02, 0.07, bw, toon(PAL.oakDark), { x: xFace - 0.02, y: 0.035, z: zc, cast: false }));                  // kick
        g.add(box(SD, 0.025, bw, shelfMat, { x: xm, y: 0.0825, z: zc, cast: false }));                                     // bottom board
        g.add(box(SD, yb, 0.024, shelfEdge, { x: xm, y: yb / 2, z: za, cast: false, outline: 0.006 }));                    // divider at the bay's front
        const n = Math.max(1, Math.round((yb - 0.095) / 0.38)), hc = (yb - 0.095) / n;
        for (let k = 0; k < n; k++) {
          const y0 = 0.095 + k * hc, y1 = y0 + hc - 0.025;
          if (k > 0) g.add(box(SD, 0.025, bw, shelfMat, { x: xm, y: y0 - 0.0125, z: zc, cast: false }));
          const h = hash2(stair.x * 3 + c * 1.7, k * 2.9 + level), room = y1 - y0;
          const z0 = Math.max(za, zb) - 0.03, z1 = Math.min(za, zb) + 0.03;               // fill from the front (+z) toward the back
          if (y0 > 2.3 || (h > 0.72 && room > 0.2)) {                                    // archive boxes (all the high cells)
            const nb = bw > 0.45 ? 2 : 1, bwid = (z0 - z1 - 0.03 * (nb - 1)) / nb, bh = Math.min(0.26, room - 0.03);
            for (let b = 0; b < nb; b++) {
              const col = boxCols[Math.floor((h * 7 + b * 3 + k) * 13) % boxCols.length];
              g.add(box(0.24, bh, bwid, toon(col), { x: xFace - 0.14, y: y0 + bh / 2, z: z0 - bwid / 2 - b * (bwid + 0.03), cast: false, outline: 0.006 }));
              g.add(box(0.004, 0.035, bwid * 0.4, toon(PAL.paper), { x: xFace - 0.018, y: y0 + bh * 0.6, z: z0 - bwid / 2 - b * (bwid + 0.03), cast: false })); // label
            }
          } else if (h < 0.1 && room > 0.3 && y0 < 1.8) {                               // a trailing plant
            const p = plant(0.42, { kind: 'pothos', pot: POTS[Math.floor(h * 40) % 4] }); p.position.set(xFace - 0.15, y0, zc); p.rotation.y = -Math.PI / 2; g.add(p);
          } else {                                                                        // books, spines to the room
            let z = z0, b = 0;
            const gapAt = Math.floor(h * 9) % 7;
            while (z > z1 + 0.06 && b < 14) {
              const w = 0.035 + ((b * 5 + k * 3 + c) % 3) * 0.012, bh = Math.min(room - 0.02, 0.2 + ((b + k + c) % 4) * 0.035);
              if (b === gapAt) { z -= 0.08; b++; continue; }
              if (z - w < z1) break;
              g.add(box(0.2, bh, w, toon(COLORS.book[(b + k * 2 + c) % 5]), { x: xFace - 0.115, y: y0 + bh / 2, z: z - w / 2, cast: false, outline: 0.005 }));
              z -= w + 0.006; b++;
            }
            if (z - 0.16 > z1) { const lean = box(0.2, Math.min(room - 0.04, 0.24), 0.04, toon(COLORS.book[(c + k) % 5]), { x: xFace - 0.115, y: y0 + Math.min(room - 0.04, 0.24) / 2 + 0.01, z: z - 0.06, cast: false, outline: 0.005 }); lean.rotation.x = 0.3; g.add(lean); } // leans on the row
          }
        }
      }
      // the divider closing the last bay, at the top of the flight
      const zEnd = stair.ze; g.add(box(SD, bayTop(STAIR_STEPS / 2 - 1), 0.024, shelfEdge, { x: xFace - SD / 2, y: bayTop(STAIR_STEPS / 2 - 1) / 2, z: zEnd, cast: false, outline: 0.006 }));
    }
    const len = Math.hypot(STAIR_RUN, FLOOR_H), tilt = Math.atan2(stair.d * STAIR_RUN, FLOOR_H), pitch = Math.atan2(FLOOR_H, STAIR_RUN);
    // Two versions of everything that rises above the room: `through` carries on into the floor above (its guard), `top`
    // (no floor above) stops at wall height so nothing pokes out over the cut wall tops. setCeiling picks one.
    const through = new THREE.Group(), top = new THREE.Group();
    for (const v of [through, top]) { v.userData.dynamic = true; g.add(v); }
    const yTop = wallH, uClip = (yTop - GUARD_H) / FLOOR_H;                  // where the pitched rail line meets wall height
    const zClip = stair.zs + (stair.ze - stair.zs) * uClip;
    if (stair.lane === 'B') { // the open (room) side of lane B gets a guard rail; lane A has the wall on that side
      const x = stair.x + (STAIR_W / 2 + 0.05);
      for (const [v, clip] of [[through, Infinity], [top, yTop]]) {
        for (let i = 0; i <= STAIR_STEPS; i += 2) {
          const y0 = Math.min(FLOOR_H, i * rise), y1 = Math.min(clip, y0 + GUARD_H);
          if (y1 - y0 > 0.2) v.add(cyl(0.022, 0.022, y1 - y0, post, { x, y: (y0 + y1) / 2, z: stair.zs + stair.d * i * run }, 8));
        }
        const f = clip === Infinity ? 1 : uClip;                                  // the pitched part of the rail
        const r = cyl(0.03, 0.03, len * f, guardRail, { x, y: GUARD_H + FLOOR_H * f / 2, z: stair.zs + (stair.ze - stair.zs) * f / 2 }, 8); r.rotation.x = tilt; v.add(r);
        if (f < 1) { const fl = cyl(0.03, 0.03, Math.abs(stair.ze - zClip), guardRail, { x, y: yTop, z: (zClip + stair.ze) / 2 }, 8); fl.rotation.x = Math.PI / 2; v.add(fl); }
      }
    } // lane A runs along the wall; its handrail is the spine balustrade on the open side (a thin wall rail read as a
      // stray wire at normal viewing size)
    // the spine between the two lanes: a closed painted stringer band just above the treads, oak slats (35 mm square at
    // 110 mm centres) up to the oak cap 1.05 m above the pitch line, and a solid newel at the foot. It continues through
    // the slab above as that floor's guard (or, on the top floor, levels off at wall height). No shadows: the stair stands
    // against the wall, its shadow only muddied the entrance band.
    {
      const zf = stair.zs + 0.12, xs = -hx + SPINE_X, BAND = 0.2, SLAT = 0.035, SLAT_C = 0.11;
      const lineY = z => FLOOR_H * (z - stair.zs) / (stair.ze - stair.zs);          // the pitch line through the nosings
      for (const [v, clipped] of [[through, false], [top, true]]) {
        const sh = new THREE.Shape();
        sh.moveTo(zf, 0); sh.lineTo(zf, GUARD_H); sh.lineTo(stair.zs, GUARD_H); sh.lineTo(stair.zs, BAND);
        if (clipped) { sh.lineTo(stair.zs + (stair.ze - stair.zs) * (yTop - BAND) / FLOOR_H, yTop); sh.lineTo(stair.ze, yTop); } else sh.lineTo(stair.ze, FLOOR_H + BAND);
        sh.lineTo(stair.ze, FLOOR_H - 0.35); sh.lineTo(stair.zs - 0.35 / FLOOR_H * STAIR_RUN, 0); sh.closePath();
        const sg = new THREE.ExtrudeGeometry(sh, { depth: SPINE_W, bevelEnabled: false });
        sg.rotateY(-Math.PI / 2); sg.translate(xs + SPINE_W / 2, 0, 0);   // shape x becomes world z, the extrusion runs toward -x
        v.add(mesh(sg, stringerMat, { cast: false, receive: true, outline: 0.012 }));
        for (let j = 0; ; j++) {
          const dz = 0.07 + j * SLAT_C; if (dz > STAIR_RUN - 0.03) break;
          const z = stair.zs + stair.d * dz, yl = lineY(z), y0 = yl + BAND - 0.02, y1 = clipped ? Math.min(yl + GUARD_H, yTop) : yl + GUARD_H;
          if (y1 - y0 > 0.06) v.add(box(SLAT, y1 - y0, SLAT, treadMat, { x: xs, y: (y0 + y1) / 2, z, cast: false, outline: 0.004 }));
        }
        const f = clipped ? uClip : 1, fb = clipped ? (yTop - BAND) / FLOOR_H : 1;
        const cap = box(SPINE_W + 0.04, 0.05, len * f, treadMat, { x: xs, y: GUARD_H + FLOOR_H * f / 2 + 0.025, z: stair.zs + (stair.ze - stair.zs) * f / 2, cast: false, outline: 0.008 }); cap.rotation.x = pitch; v.add(cap);
        const shoe = box(SPINE_W + 0.012, 0.025, len * fb, treadMat, { x: xs, y: BAND + FLOOR_H * fb / 2 + 0.0125, z: stair.zs + (stair.ze - stair.zs) * fb / 2, cast: false }); shoe.rotation.x = pitch; v.add(shoe); // oak shoe on the band
        if (clipped) v.add(box(SPINE_W + 0.04, 0.05, Math.abs(stair.ze - zClip) + 0.03, treadMat, { x: xs, y: yTop + 0.025, z: (zClip + stair.ze) / 2 - 0.015, cast: false, outline: 0.008 }));
      }
      g.add(box(SPINE_W + 0.04, 0.05, zf - stair.zs + 0.02, treadMat, { x: xs, y: GUARD_H + 0.025, z: (zf + stair.zs) / 2, cast: false, outline: 0.008 }));
    }
    obs(-hx + SPINE_X, (stair.zs + 0.12 + stair.ze) / 2, SPINE_W, stair.zs + 0.12 - stair.ze);
    // top floor: the flight arrives at an opaque stub of cut slab (the landing of a floor not built yet). It runs back to
    // the lift/WC core and bears on it and on the side wall, with a light cap like the cut walls, so it reads as a section,
    // never as a slab floating in mid-air; a guard rail runs along its open edges (the arrival lane stays open)
    {
      const sx0 = -hx, sx1 = -hx + LANE_B + STAIR_W / 2 + 0.35, sz0 = core.z1 - 0.25, sz1 = stair.ze;
      top.add(box(sx1 - sx0, SLAB, sz1 - sz0, matte(COLORS.floorSide), { x: (sx0 + sx1) / 2, y: FLOOR_H - SLAB / 2, z: (sz0 + sz1) / 2, cast: false, receive: true, outline: 0.008 }));
      top.add(box(sx1 - sx0 + 0.015, 0.025, sz1 - sz0 + 0.015, matte(0xfdfaf4), { x: (sx0 + sx1 + 0.015) / 2, y: FLOOR_H + 0.0125, z: (sz0 + sz1 - 0.015) / 2, cast: false, receive: true }));
      // its two open edges read as a finished slab: a 0.18 m edge band in the facade's spandrel tone, oak nosing along the
      // top, and below the band (and on the soffit) the floor's accent, so the stub belongs to this floor's wayfinding
      {
        const bandM = matte(0xd9cfc0), soffit = matte(new THREE.Color(PAL.cream).lerp(new THREE.Color(ACCENT), 0.55).getHex()), nose = toon(PAL.oak);
        const lx = sx1 - sx0, lz = sz1 - sz0, xm = (sx0 + sx1) / 2, zm = (sz0 + sz1) / 2, yb = FLOOR_H - 0.09, ys = FLOOR_H - 0.18 - (SLAB - 0.18) / 2;
        top.add(box(0.012, 0.18, lz + 0.012, bandM, { x: sx1 + 0.006, y: yb, z: zm + 0.006, cast: false, receive: true }));                  // band, room side
        top.add(box(lx + 0.012, 0.18, 0.012, bandM, { x: xm + 0.006, y: yb, z: sz1 + 0.006, cast: false, receive: true }));                  // band, front
        top.add(box(0.01, SLAB - 0.18, lz + 0.01, soffit, { x: sx1 + 0.005, y: ys, z: zm + 0.005, cast: false, receive: true }));
        top.add(box(lx + 0.01, SLAB - 0.18, 0.01, soffit, { x: xm + 0.005, y: ys, z: sz1 + 0.005, cast: false, receive: true }));
        top.add(box(lx, 0.008, lz, soffit, { x: xm, y: FLOOR_H - SLAB - 0.004, z: zm, cast: false, receive: true }));                         // underside
        top.add(box(0.05, 0.035, lz + 0.05, nose, { x: sx1 - 0.013, y: FLOOR_H + 0.03, z: zm + 0.012, cast: false, outline: 0.008 }));
        top.add(box(lx + 0.05, 0.035, 0.05, nose, { x: xm + 0.012, y: FLOOR_H + 0.03, z: sz1 - 0.013, cast: false, outline: 0.008 }));
      }
      const LAND_H = 0.9; // the landing's guard stays low: it stands over the cut wall tops
      const railTop = (x1, z1, x2, z2) => { // like addRail, but part of the top-floor variant (not architecture)
        const l = Math.hypot(x2 - x1, z2 - z1); if (l < 0.15) return;
        const n = Math.max(1, Math.round(l / 0.75));
        for (let i = 0; i <= n; i++) top.add(cyl(0.022, 0.022, LAND_H, post, { x: x1 + (x2 - x1) * i / n, y: FLOOR_H + LAND_H / 2, z: z1 + (z2 - z1) * i / n }, 8));
        const r = cyl(0.03, 0.03, l, guardRail, { x: (x1 + x2) / 2, y: FLOOR_H + LAND_H, z: (z1 + z2) / 2 }, 8);
        r.rotation.z = Math.PI / 2; r.rotation.y = -Math.atan2(z2 - z1, x2 - x1); top.add(r);
      };
      const xe = sx1 - 0.05, ze = sz1 - 0.05, laneL = stair.x - hw - 0.02, laneR = stair.x + hw + 0.02;
      railTop(xe, sz0 + 0.3, xe, ze);                                    // the long open side, over the room
      railTop(laneR, ze, xe, ze);                                        // the front edge beside the arrival lane
      if (stair.lane === 'B') railTop(-hx + 0.25, ze, laneL, ze);       // and the other lane's side, toward the wall
    }
    freezeStatic(through); freezeStatic(top);
    through.visible = false;                     // until the manager says there is a floor above
    stair.rim = top; stair.through = through;
    freezeStatic(g);
    // not architecture: on a ghosted floor its own flight (leading further up) is hidden like furniture, so it never
    // draws stray rails over the floor you are looking at; the guard rails around the arrival opening stay
  }
  function setCeiling(hasAbove) { stair.through.visible = !!hasAbove; stair.rim.visible = !hasAbove; if (fireStairTopRail) fireStairTopRail.visible = !hasAbove; }

  // ---------- night interior: light pools under the ceiling lights, and pendants over the rooms in use ----------
  // 7 warm ceiling lights (main.js puts a point light at each); each throws a soft additive pool on the floor, all one
  // mesh with its own material (opacity follows NIGHT.lamps in update), shown only on the floor you look at
  const ceilingLights = [sx + 0.6, xWork0 + CELL_W * 0.55, xWork0 + CELL_W * 2.3].flatMap(x => [-hz + 3.4, hz - 3.4].map(z => ({ x, z }))).concat([{ x: xQuiet0 + 0.4, z: -1.0 }]);
  const ceilingPoolMat = new THREE.MeshBasicMaterial({ color: 0xffe4bd, map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const ceilingPools = (() => {
    const geos = ceilingLights.map(p => { const c = new THREE.CircleGeometry(2.2, 40); c.rotateX(-Math.PI / 2); c.translate(p.x, 0.018, p.z); return c; });
    const m = new THREE.Mesh(mergeGeometries(geos, false), ceilingPoolMat); for (const x of geos) x.dispose();
    m.castShadow = m.receiveShadow = false; m.renderOrder = 1; m.visible = false; m.userData.dynamic = true; m.userData.noMode = true; m.userData.noMerge = true;
    group.add(m); return m;
  })();
  // pendants: one over the meeting table, one over the lounge; each lights (at night) only while its room is in use.
  // Shade, cord and ceiling rose are static; the diffuser and bulb share one own material under a dynamic group.
  const pendant = (x, z, shadeCol) => {
    const y = 2.3, top = y + 0.1;
    group.add(cyl(0.006, 0.006, wallH - top, toon(PAL.ink), { x, y: (wallH + top) / 2, z, cast: false }, 6));                 // cord
    group.add(cyl(0.06, 0.05, 0.03, toon(PAL.paper), { x, y: wallH - 0.015, z, cast: false, outline: 0.005 }, 14));           // ceiling rose
    group.add(cyl(0.035, 0.035, 0.06, toon(PAL.slateDark), { x, y: top + 0.01, z, cast: false }, 10));                          // lamp holder
    group.add(mesh(new THREE.CylinderGeometry(0.075, 0.25, 0.2, 28, 1, true), toon(shadeCol, { side: THREE.DoubleSide }), { x, y, z, outline: 0.008 }));
    const lit = toon(0xfff1c9, { emissive: 0xffd88a, emissiveIntensity: 0 }).clone(); lit.userData.own = true;
    const lg = new THREE.Group(); lg.position.set(x, 0, z); lg.userData.dynamic = true; group.add(lg);
    const diff = mesh(new THREE.CircleGeometry(0.235, 28), lit, { y: y - 0.085, cast: false }); diff.rotation.x = Math.PI / 2; lg.add(diff); // diffuser, facing down
    lg.add(sphere(0.055, lit, { y: y - 0.02, cast: false }, 12));                                                             // bulb
    freezeStatic(lg);                                                                                                          // diffuser + bulb: one draw
    return { mat: lit, k: 0 };
  };
  const meetingPendant = pendant((meeting.x0 + meeting.x1) / 2, (meeting.z0 + meeting.z1) / 2 + 0.25, PAL.mustard);
  const reviewPendant = pendant(qx, qz, PAL.sage);
  const huddlePendant = pendant((huddle.x0 + huddle.x1) / 2 - 0.1, (huddle.z0 + huddle.z1) / 2, PAL.slate);
  const loungePendant = pendant(lx + [0.1, 0.25, 0.2][variant], lz, [PAL.sage, PAL.terracotta, PAL.slate][variant]);
  const cafePendants = [-0.65, 0.65].map(dz => pendant(cafe.center.x, cafe.center.z + dz, PAL.mustard));
  const updatePendants = dt => {
    const meetOn = !!meeting.team, loungeOn = lounge.seats.some(s => s.taken) || !!foos?.spots.some(s => s.taken);
    const reviewOn = qa.spots.some(s => s.taken);
    const cafeOn = cafe.seats.some(s => s.taken);
    for (const [p, on] of [[meetingPendant, meetOn], [loungePendant, loungeOn], [reviewPendant, reviewOn], [huddlePendant, !!huddle.team], ...cafePendants.map(cp => [cp, cafeOn])]) {
      p.k += ((on ? 1 : 0) - p.k) * Math.min(1, dt * 3);                 // a soft switch-on, not a pop
      p.mat.emissiveIntensity = p.k * NIGHT.lamps * 1.3;
    }
    reviewLampMat.emissiveIntensity = reviewPendant.k * NIGHT.lamps * 1.2; reviewShadeMat.emissiveIntensity = reviewPendant.k * NIGHT.lamps * 0.55; reviewLampPool.material.opacity = reviewPendant.k * NIGHT.lamps * 0.6;
  };

  // ---------- navigation ----------
  const nav = new NavGrid(-hx - 3.4, -hz - 0.3, hx + 0.3, hz + 0.3, 0.2, 0.3);
  function rebuildNav() {
    nav.reset();
    for (const o of staticObs) nav.block(...o);
    for (const d of desks) for (const list of d.dynamicObs.values()) for (const o of list) nav.block(...o);
    nav.block(stair.x, (stair.zs + stair.ze) / 2, STAIR_W + 0.1, STAIR_RUN + 0.05);          // this floor's flight
    if (below) nav.block(below.x, (below.zs + below.ze) / 2, STAIR_W + 0.1, STAIR_RUN + 0.25); // the opening for the flight below
  }
  for (const d of desks) d.onObstaclesChanged = rebuildNav;
  rebuildNav();
  function route(from, to) {
    const path = nav.find(from, to);
    if (path && path.length) return [{ x: from.x, z: from.z }, ...path];
    return [{ x: from.x, z: from.z }, { x: to.x, z: to.z }];
  }

  // ghost floors: only the slab's outer edge, faint (no hole edges or slab thickness floating over the lawn)
  const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => new THREE.Vector3(x, 0.002, z))),
    new THREE.LineBasicMaterial({ color: PAL.slate, transparent: true, opacity: 0.25 }));
  outline.visible = false; group.add(outline);

  // ---------- facade: a floor below the one you look at is seen from outside ----------
  // In 'dim' mode the cutaway closes: the front and right walls rise full height in a warm render, with a spandrel band
  // at each slab under a light coping, tall punched windows on the back wall's rhythm (0.08 m mullions) and glass in the
  // daylight glass colour. At night the render takes a faint warm wash, and each bay glows warm on its own, only while
  // someone works at a desk within ~4 m of it (and the floor has people at all: setFacadeLit); a few lit bays have their
  // blinds drawn. Hidden in every other mode.
  const facade = new THREE.Group(); facade.userData.dynamic = true; group.add(facade);
  const glassBase = new THREE.Color(COLORS.glass), warm = new THREE.Color(0xffd9a0), tmpC = new THREE.Color(), tmpW = new THREE.Color();
  const BAY_REACH = 4.0;
  const bays = [];                       // { x, z, v0, v1, shade, blinds, lit } – one per facade window, its vertex range
  const bayGeos = [];
  let facadeLit = true, facadeGlassMesh = null, facadeRender = null;
  {
    // the render is the facade's own material: at night it takes a faint warm wash (emissive ≈ 0.08 × NIGHT.lamps, see
    // updateFacade), so a lit office below never reads as a muddy box
    const render = new THREE.MeshStandardMaterial({ color: 0xf0e7da, roughness: 0.9, metalness: 0, emissive: 0xffc98a, emissiveIntensity: 0 });
    render.userData.live = true; facadeRender = render;
    // tall windows (sill 0.75 m, head 2.5 m) with slim 0.08 m mullions: the facade reads as an office, not a warehouse
    const fSill = 0.75, fTop = 2.5, MULL = 0.08;
    const band = matte(0xd9cfc0), plinth = matte(0xc4b9a8), frameM = matte(0xf7f3ec), sillM = matte(0xe9e0d3);
    const OUT = 0.04, IN = -0.2, nc = (IN + OUT) / 2, nd = OUT - IN; // the skin runs from the wall's inner face to 4 cm proud
    const pitch = winX.length > 1 ? winX[1] - winX[0] : 3.6;
    // a run along 'x' (the front, outer face z = hz) or 'z' (the right side, outer face x = hx), from u0 to u1;
    // n is measured outward from the outer face
    const run = (axis, plane, u0, u1, wins, salt) => {
      const put = (u, y, n, lu, ly, ln, mat) => facade.add(axis === 'x'
        ? box(lu, ly, ln, mat, { x: u, y, z: plane + n, cast: false, receive: true })
        : box(ln, ly, lu, mat, { x: plane + n, y, z: u, cast: false, receive: true }));
      const L = u1 - u0, uc = (u0 + u1) / 2;
      put(uc, fSill / 2, nc, L, fSill, nd, render);                                        // under the sills
      put(uc, (fTop + wallH) / 2, nc, L, wallH - fTop, nd, render);                    // over the window heads
      let a = u0;
      for (const w of [...wins, null]) {                                                   // piers between the windows
        const b = w === null ? u1 : w - winW / 2;
        if (b - a > 0.001) put((a + b) / 2, (fSill + fTop) / 2, nc, b - a, fTop - fSill, nd, render);
        if (w !== null) a = w + winW / 2;
      }
      // spandrel: the edge of the slab above, a darker band 3 cm proud of the render; on the ground floor a 0.45 m plinth
      // from the lawn up, 2 cm proud
      put(uc + 0.015, (wallH + FLOOR_H) / 2, nc + 0.015, L + 0.03, FLOOR_H - wallH, nd + 0.03, band);
      if (level === 0) put(uc + 0.01, -SLAB + 0.225, nc + 0.01, L + 0.02, 0.45, nd + 0.02, plinth);
      put(uc + 0.02, FLOOR_H - 0.025, nc + 0.03, L + 0.04, 0.05, nd + 0.06, frameM);                // coping: a crisp light cap on the slab edge, 6 cm proud
      const wh = fTop - fSill, wy = (fSill + fTop) / 2;
      for (const w of wins) {
        { // glass, set back in the reveal: gathered into one vertex-coloured mesh so each bay can light on its own
          const gg = new THREE.BoxGeometry(...(axis === 'x' ? [winW, wh, 0.01] : [0.01, wh, winW]));
          gg.translate(axis === 'x' ? w : plane - 0.07, wy, axis === 'x' ? plane - 0.07 : w);
          const h = hash2(w + salt, level * 3.7), hb = hash2(w * 1.7 - salt, level * 5.1 + 2.3);
          bays.push({ x: axis === 'x' ? w : plane, z: axis === 'x' ? plane : w, shade: h > 0.64 ? 0.86 : 1, blinds: hb < 0.15, lit: false, geo: gg });
          bayGeos.push(gg);
        }
        for (const y of [fTop - 0.03, fSill + 0.03]) put(w, y, -0.045, winW, 0.06, 0.05, frameM);       // frame head and foot
        for (const sd of [-1, 1]) put(w + sd * (winW / 2 - 0.03), wy, -0.045, 0.06, wh - 0.12, 0.05, frameM); // jambs
        put(w, wy, -0.045, MULL, wh - 0.12, 0.05, frameM);                                             // the slim mullion
        put(w, fSill + wh * 0.7, -0.045, winW - 0.12, 0.05, 0.05, frameM);                             // transom under the top lights
        put(w, fSill - 0.015, 0.04, winW + 0.12, 0.05, 0.2, sillM);                                    // projecting sill
      }
    };
    const along = (lo, hi, first) => { const out = []; for (let u = first + Math.ceil((lo - first) / pitch) * pitch; u <= hi + 1e-6; u += pitch) out.push(u); return out; };
    const nr = Math.max(1, Math.floor((D - 1.4 - winW) / pitch) + 1);
    run('x', hz, -hx, hx + OUT, along(-hx + 0.7 + winW / 2, hx - 0.7 - winW / 2, winX[0] ?? 0), 0);    // front: aligned with the back windows
    run('z', hx, -hz, hz + IN, Array.from({ length: nr }, (_, i) => (i - (nr - 1) / 2) * pitch), 7.3);  // right side: centred
    if (bayGeos.length) {
      let v = 0;
      const ngs = bays.map(b => { const ng = b.geo.toNonIndexed(); b.geo.dispose(); const n = ng.attributes.position.count; b.v0 = v; b.v1 = v + n; v += n; return ng; });
      const geo = mergeGeometries(ngs, false); for (const g of ngs) g.dispose();
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
      facadeGlassMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
      facadeGlassMesh.castShadow = facadeGlassMesh.receiveShadow = false; facadeGlassMesh.userData.noMerge = true;
      facade.add(facadeGlassMesh);
      for (const b of bays) delete b.geo;
    }
    freezeStatic(facade);
    facade.traverse(o => { if (o.isMesh) o.userData.noMode = true; }); // keeps its own look: it is only ever shown on dim floors
    facade.visible = false;
  }
  const occupied = [];
  const updateFacade = () => {
    if (facadeRender) facadeRender.emissiveIntensity = 0.08 * NIGHT.lamps;
    if (!facadeGlassMesh) return;
    occupied.length = 0;
    if (facadeLit) for (const d of desks) {
      if (d.owner) occupied.push(d.x, d.z);
      for (const sl of d.slots) if (sl.taken && sl.mesh && !sl.mesh.userData.closing) occupied.push(sl.deskX, sl.deskZ);
    }
    const base = windows[0]?.material.color ?? glassBase, k = 0.5 * NIGHT.lamps;
    const col = facadeGlassMesh.geometry.attributes.color, a = col.array;
    let changed = false;
    for (const b of bays) {
      let lit = false;
      for (let i = 0; i < occupied.length && !lit; i += 2) lit = Math.hypot(occupied[i] - b.x, occupied[i + 1] - b.z) <= BAY_REACH;
      b.lit = lit;
      tmpC.copy(base).multiplyScalar(b.shade);
      if (lit && k > 0) tmpC.add(tmpW.copy(warm).multiplyScalar(k * (b.blinds ? 0.6 : 1)));
      if (Math.abs(a[b.v0 * 3] - tmpC.r) + Math.abs(a[b.v0 * 3 + 1] - tmpC.g) + Math.abs(a[b.v0 * 3 + 2] - tmpC.b) < 1e-4) continue;
      for (let v = b.v0; v < b.v1; v++) { a[v * 3] = tmpC.r; a[v * 3 + 1] = tmpC.g; a[v * 3 + 2] = tmpC.b; }
      changed = true;
    }
    if (changed) col.needsUpdate = true;
  };
  function setMode(mode) { shell.visible = mode === 'normal'; outline.visible = mode === 'ghost'; facade.visible = mode === 'dim'; if (contactMesh) contactMesh.visible = mode === 'normal'; if (facade.visible) updateFacade(); }

  // soft contact shadows under the furniture: every pool of the floor in one transparent mesh (one draw), just above the
  // carpets and rugs; drawn only on the floor you look at (a dimmed floor is closed by its facade, a ghost has no furniture)
  let contactMesh = null;
  if (contacts.length) {
    const geos = contacts.map(([x, z, w, d]) => { const p = new THREE.PlaneGeometry(w, d); p.rotateX(-Math.PI / 2); p.translate(x, 0.016, z); return p; });
    const sm = new THREE.Mesh(mergeGeometries(geos, false), contactShadowMat()); for (const x of geos) x.dispose();
    sm.castShadow = sm.receiveShadow = false; sm.userData.noMerge = true; sm.userData.dynamic = true; group.add(sm); contactMesh = sm;
  }
  const batch = freezeStatic(group); // one draw per material for everything that never moves
  group.userData.batch = batch;
  // what a dimmed floor's closed facade hides completely: not drawn there, and so not in the sun's shadow map either (VSM draws whatever receives)
  const bounds = new THREE.Box3();
  group.traverse(o => {
    if (!o.isMesh || o.userData.noMode) return;
    bounds.setFromObject(o);
    o.userData.sealed = bounds.min.x > -hx && bounds.max.x < hx && bounds.min.z > -hz && bounds.max.z < hz;
  });
  stair.group.traverse(o => { o.userData.sealed = false; }); // the flight rises into the floor above, through its opening

  return {
    ceilingLights, // 7 warm ceiling lights for the night (each with a floor pool)
    foos, barSpots, group, level, baseY: level * FLOOR_H, setCeiling, setMode, openings, shell, W, D, hx, hz, desks, door, coffee, copier, cooler, lounge, qa, meeting, stair, cat: catCtl, clock, windows, windowSpots, plantSpots, lamps: canopyLight ? [shadeMat, canopyLight] : [shadeMat], xL, xR, walkways, route, nav, huddle,
    wc, wcs, fireExit, lift, core, dayBoard, facade, pod, pods, cafe, obstacles: staticObs,
    /** lower floors' facade: this floor has people (default: true). At night a bay glows only while an occupied desk
     *  (lead or helper) is within ~4 m of it; `facadeBays` lists each bay's position and current lit state */
    setFacadeLit(v) { facadeLit = !!v; if (facade.visible) updateFacade(); },
    facadeBays: bays,
    update(dt) {
      if (facade.visible) updateFacade();
      ceilingPools.visible = (group.userData.mode || 'normal') === 'normal' && NIGHT.lamps > 0.01;
      ceilingPoolMat.opacity = 0.2 * NIGHT.lamps;
      if ((group.userData.mode || 'normal') !== 'normal') { door?.update(dt); return; } // a floor you are not looking at animates nothing but its entrance door (people still walk in through it)
      updatePendants(dt); for (const r of [meeting, huddle]) { const t = r.team; r.setSign(!!t, t ? (t.agent?.project || t.name || '') : ''); r.updateDoor(dt); } door?.update(dt); foos?.update(dt); coffee.update(dt); copier?.update(dt); cooler?.update(dt); catCtl.update(dt); clock.update(); for (const p of pods) p.update(dt); for (const d of desks) d.update(dt);
      for (const w of wcs) { const busy = !!w.spot.taken; if (busy !== w.shown) { w.shown = busy; const c = busy ? PAL.terracotta : PAL.sage; w.dotMat.color.setHex(c); w.dotMat.emissive.setHex(c); } } },
    dispose() { scene.remove(group); disposeFloor(group, [floorTex]); },
  };
}

/** a thin rod from a to b (Vector3s, parent space) */
function rod(a, b, r, mat) {
  const v = new THREE.Vector3().subVectors(b, a), m = cyl(r, r, v.length(), mat, { cast: false }, 8);
  m.position.copy(a).addScaledVector(v, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
  return m;
}
function makeMonitor(stand = 'foot', housing = COLORS.monitor) { // a low-set screen: top ~0.365 above the desk (about 1.12 m
  // from the floor), just under a seated person's chin from the camera's point of view, so faces stay readable over it.
  // stand: 'foot' (a round foot and a short neck) or 'arm' (clamped to the desk's back edge, the desk top left clear)
  const mon = new THREE.Group(), shell = toon(housing);
  if (stand === 'arm') {
    const armMat = toon(PAL.slateDark), V = (x, y, z) => new THREE.Vector3(x, y, z);
    mon.add(box(0.06, 0.04, 0.09, armMat, { x: 0.2, y: 0.02, z: 0.2, outline: 0.006 }));         // clamp on the back edge
    mon.add(cyl(0.016, 0.016, 0.3, armMat, { x: 0.2, y: 0.17, z: 0.2 }, 8));                     // pole
    mon.add(rod(V(0.2, 0.29, 0.2), V(0.07, 0.26, 0.1), 0.014, armMat));                          // upper arm
    mon.add(rod(V(0.07, 0.26, 0.1), V(0, 0.21, 0.04), 0.012, armMat));                           // forearm to the mount
    mon.add(box(0.09, 0.09, 0.02, armMat, { y: 0.2, z: 0.032, cast: false }));                   // mount plate
  } else {
    mon.add(cyl(0.11, 0.13, 0.025, shell, { y: 0.0125, z: 0.03 }, 20));
    mon.add(box(0.05, 0.12, 0.035, shell, { y: 0.08, z: 0.035 }));                               // short neck behind the screen
  }
  const screen = box(0.6, 0.33, 0.035, shell, { y: 0.2, outline: 0.012 }); screen.rotation.x = 0.06; mon.add(screen);
  const panelMat = new THREE.MeshBasicMaterial({ color: SCREEN_OFF });
  const panel = box(0.55, 0.28, 0.005, panelMat, { y: 0.2, z: -0.0185, cast: false }); panel.rotation.x = 0.06; mon.add(panel);
  const logoMat = new THREE.MeshBasicMaterial({ color: 0x8884a0 });
  const logo = box(0.52, 0.04, 0.008, logoMat, { y: 0.08, z: 0.0145, cast: false }); logo.rotation.x = 0.06; mon.add(logo); // status light across the monitor back, faces the room
  mon.userData = { panelMat, logoMat };
  return mon;
}
// Desk kits: each pod gets one of three desks, picked from its place so neighbours and floors differ — the oak desk, a
// white sit-stand desk on slim graphite legs, or the oak desk with a low hutch shelf — and each desk its own screen setup
// (one monitor centred, a monitor on an arm, a monitor set further right). Footprints, seat and approach spots are the
// same for every kit: navigation and people rely on them.
const DESK_KITS = ['oak', 'white', 'hutch'], SCREEN_KITS = ['single', 'arm', 'laptop'];
// each of a floor's six team areas has its own colour (its hanging sign, its helpers' chairs), so neighbouring teams
// never share one: terracotta, sage, mustard, slate, mauve, sky
const TEAM_HUES = [PAL.terracotta, PAL.sageDeep, PAL.mustard, PAL.slate, 0xb48aa8, 0x6aa3b8];
const WHITE_TOP = 0xf3efe8;

const keepGeo = new Set([crumpleGeo]);
/** empty a prop group that is rebuilt at runtime, freeing its (merged or one-off) geometries */
function clearProps(node) {
  node.traverse(o => { if (o !== node && o.isMesh && o.geometry && !keepGeo.has(o.geometry)) o.geometry.dispose(); });
  node.clear();
}

function makePod(group, cx, cz, row, col, obs, glowTex = null, level = 0) {
  const applyMode = node => reapplyMode(group, node);
  obs(cx, cz + 0.6, 2.05, 0.8); obs(cx, cz + 0.6 - 0.78, 0.5, 0.5);
  const g = new THREE.Group(); g.position.set(cx, 0, cz + 0.6); group.add(g);
  // the kit: across a row the three desks differ, the row behind is shifted by one and each floor by one more
  const kit = DESK_KITS[(col + row * 2 + level) % 3], screens = SCREEN_KITS[(col + row + level * 2) % 3];
  const white = kit === 'white', hutch = kit === 'hutch', laptop = screens === 'laptop';
  const teamHue = TEAM_HUES[(row * 3 + col) % TEAM_HUES.length];
  const helperChairCol = new THREE.Color(COLORS.helperChair).lerp(new THREE.Color(teamHue), 0.6).getHex();
  const frameCol = white ? PAL.slateDark : COLORS.deskLeg;
  const deskTop = roundedBox(2, 0.06, 0.78, 0.06, toon(white ? WHITE_TOP : COLORS.desk), { y: 0.72, outline: 0.012 }); g.add(deskTop); // every desk is this size, whoever sits at it
  const legs = [-1, 1].map(s => {
    if (!white) { const m = box(0.06, 0.69, 0.7, toon(COLORS.deskLeg), { x: s * 0.95, y: 0.345 }); g.add(m); return m; }
    // sit-stand frame: a telescoping column on a foot, a bracket under the top
    const lg = new THREE.Group(); lg.position.x = s * 0.95; g.add(lg);
    const fm = toon(frameCol);
    lg.add(box(0.07, 0.36, 0.055, fm, { y: 0.21 }));
    lg.add(box(0.054, 0.3, 0.042, fm, { y: 0.51 }));
    lg.add(box(0.06, 0.03, 0.68, fm, { y: 0.015 }));
    lg.add(box(0.05, 0.03, 0.6, fm, { y: 0.675 }));
    freezeStatic(lg); return lg;
  });
  // modesty panel on the room side, between the legs: hides the cable and carries the pod sign
  const modesty = box(1.84, 0.38, 0.02, toon(white ? PAL.slateLight : COLORS.deskLeg), { y: 0.49, z: 0.33, outline: 0.008 }); g.add(modesty);
  if (white) { // a white mobile pedestal on a graphite plinth, and the sit-stand paddle under the front edge
    g.add(box(0.36, 0.46, 0.6, toon(PAL.paper), { x: 0.5, y: 0.27, z: 0, outline: 0.006 }));
    g.add(box(0.32, 0.04, 0.56, toon(PAL.slateDark), { x: 0.5, y: 0.02, z: 0, cast: false }));
    for (const y of [0.47, 0.3]) g.add(box(0.14, 0.02, 0.02, toon(PAL.slateLight), { x: 0.5, y, z: 0.31, cast: false }));
    g.add(box(0.12, 0.025, 0.05, toon(PAL.slateDark), { x: 0.6, y: 0.68, z: -0.36, cast: false }));
  } else {
    g.add(box(0.36, 0.5, 0.6, toon(COLORS.deskLeg), { x: 0.5, y: 0.25, z: 0 }));
    g.add(box(0.14, 0.02, 0.02, toon(PAL.paper), { x: 0.5, y: 0.5, z: 0.31, cast: false }));
    g.add(box(0.14, 0.02, 0.02, toon(PAL.paper), { x: 0.5, y: 0.3, z: 0.31, cast: false }));
  }
  // the screen sits toward the desk's far edge, a little left of the sitter (right of it when a laptop shares the desk)
  const MON_X = laptop ? 0.06 : screens === 'arm' ? -0.08 : -0.1;
  const housing = white ? PAL.paper : screens === 'arm' ? PAL.slateDark : COLORS.monitor;
  const mon = makeMonitor(screens === 'arm' ? 'arm' : 'foot', housing); mon.position.set(MON_X, 0.75, 0.16); if (screens === 'arm') mon.rotation.y = 0.07; g.add(mon);
  const glow = mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }), { x: MON_X, y: 0.755, z: -0.03, cast: false });
  glow.rotation.x = -Math.PI / 2; glow.scale.set(1, 0.6, 1); g.add(glow);
  g.add(box(0.44, 0.025, 0.15, toon(COLORS.keyboard), { y: 0.765, z: -0.12, outline: 0.008 }));
  const mouse = sphere(0.035, toon(COLORS.keyboard), { x: 0.33, y: 0.775, z: -0.12 }, 10); mouse.scale.set(1, 0.7, 1.3); g.add(mouse);
  // the hutch: a low open oak shelf on the desk's back-left corner (clear of the monitor and its status strip), books
  // inside, the plant or the lamp on top
  const HUTCH_H = 0.3, hutchZ = 0.2875;
  if (hutch) {
    const x0 = -0.795, x1 = -0.475, hd = 0.195, hw = x1 - x0, hcx = (x0 + x1) / 2, y0 = 0.755, carcass = toon(PAL.oakMid);
    for (const sx of [x0 + 0.009, x1 - 0.009]) g.add(box(0.018, HUTCH_H, hd, carcass, { x: sx, y: y0 + HUTCH_H / 2, z: hutchZ, outline: 0.006 }));
    g.add(box(hw + 0.02, 0.022, hd + 0.01, toon(PAL.oak), { x: hcx, y: y0 + HUTCH_H + 0.011, z: hutchZ, outline: 0.006 }));
    g.add(box(hw - 0.036, 0.016, hd - 0.01, carcass, { x: hcx, y: y0 + 0.15, z: hutchZ }));
    const hb = hash2(cx * 0.53 + level, cz * 0.77);
    for (const [yb, room] of [[y0, 0.142], [y0 + 0.158, 0.13]]) {
      let x = x0 + 0.024, b = 0;
      while (b < 6) {
        const w = 0.03 + ((b * 5 + Math.floor(hb * 7)) % 3) * 0.008, h = room - 0.025 - ((b + Math.floor(hb * 5)) % 3) * 0.012;
        if (x + w > x1 - 0.06) break;
        g.add(box(w, h, 0.15, toon(COLORS.book[(b + Math.floor(hb * 11) + (yb > y0 ? 2 : 0)) % 5]), { x: x + w / 2, y: yb + h / 2, z: hutchZ, cast: false, outline: 0.005 }));
        x += w + 0.004; b++;
      }
      const lean = box(0.03, room - 0.04, 0.15, toon(COLORS.book[(b + 3) % 5]), { x: x + 0.025, y: yb + (room - 0.04) / 2 + 0.004, z: hutchZ, cast: false, outline: 0.005 }); lean.rotation.z = -0.32; g.add(lean);
    }
  }
  // plant or lamp at the back-left corner: on the hutch, or moved back to clear a laptop
  const propX = hutch ? -0.635 : laptop ? -0.72 : -0.7, propY = hutch ? 0.755 + HUTCH_H + 0.022 : 0.75, propZ = hutch ? hutchZ : laptop ? 0.26 : 0.14;
  let lamp = null, lampMat = null, lampPool = null;
  if ((row + col) % 2 === 0) g.add(plantAt(hutch ? 0.36 : 0.4, propX, propY, propZ, { salt: cx * 1.3 + cz }));
  else {
    const lg = new THREE.Group(); lg.position.set(propX, propY, propZ); g.add(lg);
    lg.add(cyl(0.08, 0.1, 0.03, toon(PAL.slateDark), { y: 0.015 }, 16));
    const arm = cyl(0.015, 0.015, 0.45, toon(PAL.slateDark), { y: 0.22 }, 8); arm.rotation.z = 0.35; arm.position.x = 0.08; lg.add(arm);
    lampMat = toon(PAL.mustard, { side: THREE.DoubleSide }).clone(); lampMat.emissive = new THREE.Color(0xffe29a); lampMat.emissiveIntensity = 0; lampMat.userData.own = true; // own material: lit per desk
    lamp = mesh(new THREE.ConeGeometry(0.11, 0.13, 16, 1, true), lampMat, { x: 0.17, y: 0.43, outline: 0.01 }); lamp.rotation.z = -0.5; lg.add(lamp);
    // a soft pool of lamplight over the desk's left half; squashed front-to-back so it stays on the 0.78 m top
    lampPool = mesh(new THREE.CircleGeometry(0.6, 28), new THREE.MeshBasicMaterial({ color: 0xffcf86, map: glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), { x: -0.3, y: 0.757, z: -0.02, cast: false });
    lampPool.rotation.x = -Math.PI / 2; lampPool.scale.set(1, 0.62, 1); lampPool.userData.dynamic = true; g.add(lampPool);
    g.userData.lamp = lamp;
  }
  const mug = cyl(0.05, 0.045, 0.09, toon(PAL.paper), { x: 0.52, y: 0.8, z: -0.02, outline: 0.01 }, 14); mug.visible = false; mug.userData.dynamic = true; g.add(mug);
  {
    const seed = (row * 7 + col * 13) % 4;
    const cover = [PAL.slate, PAL.sage, PAL.mustard, PAL.terracotta][seed];
    const nb = box(0.2, 0.016, 0.15, toon(cover), { x: -0.3, y: 0.758, z: -0.25, outline: 0.006 }); nb.rotation.y = 0.18 - seed * 0.08; g.add(nb);
    const page = box(0.18, 0.004, 0.13, toon(PAL.paper), { x: -0.3, y: 0.768, z: -0.25, cast: false }); page.rotation.y = nb.rotation.y; g.add(page);
    const pen = cyl(0.006, 0.006, 0.14, toon(PAL.ink), { x: -0.16, y: 0.763, z: -0.27, cast: false }, 6); pen.rotation.set(Math.PI / 2, 0, 0.5); g.add(pen);
    if (seed % 2 === 0) for (let i = 0; i < 3; i++) g.add(box(0.06, 0.003, 0.06, toon([0xf3e2a0, PAL.sageLight, PAL.blush][i]), { x: 0.24 + i * 0.012, y: 0.756 + i * 0.003, z: -0.3, cast: false })); // sticky-note pad
    // monitor cable: from the stand along the desk to a grommet, then down behind the modesty panel to a floor box
    // under the desk (nothing trails into the aisle)
    g.add(cyl(0.028, 0.028, 0.006, toon(PAL.ink), { x: 0.2, y: 0.752, z: 0.27, cast: false }, 12));                 // grommet
    const cx0 = screens === 'arm' ? MON_X + 0.2 : MON_X + 0.04, cz0 = screens === 'arm' ? 0.33 : 0.21;           // from the foot, or down the arm's pole
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(cx0, 0.765, cz0), new THREE.Vector3((cx0 + 0.2) / 2, 0.758, (cz0 + 0.27) / 2 + 0.01), new THREE.Vector3(0.2, 0.745, 0.27), new THREE.Vector3(0.2, 0.6, 0.27), new THREE.Vector3(0.22, 0.25, 0.26), new THREE.Vector3(0.24, 0.03, 0.22)]);
    g.add(mesh(new THREE.TubeGeometry(curve, 24, 0.008, 6, false), toon(PAL.ink), { cast: false }));
    g.add(box(0.12, 0.03, 0.12, toon(PAL.slate), { x: 0.26, y: 0.015, z: 0.18, cast: false }));                      // floor box
  }
  // waste bin beside the desk's right end, in view (the crumples in and around it are real tool errors). Each is set down
  // a little differently (a few cm, any angle: its recycling label shows which way), in a bin that suits the desk
  const hb = hash2(cx * 0.71 + level * 3.3, cz * 1.37 - level), hb2 = hash2(cz * 0.43 + level, cx * 0.29 + 1.7);
  const binX = 1.12 + (hb - 0.5) * 0.06, binZ = 0.15 + (hb2 - 0.5) * 0.06;
  {
    const bin = new THREE.Group(); bin.position.set(binX, 0, binZ); bin.rotation.y = hb * Math.PI * 2; g.add(bin);
    bin.add(cyl(0.1, 0.085, 0.27, toon(white ? PAL.slateDark : hutch ? PAL.oakMid : PAL.metal), { y: 0.135, outline: 0.008 }, 14));
    bin.add(cyl(0.088, 0.088, 0.01, toon(PAL.slate), { y: 0.272, cast: false }, 14));
    bin.add(box(0.07, 0.05, 0.012, toon(white ? PAL.paper : PAL.sage), { y: 0.17, z: 0.096, cast: false }));
  }
  // chair behind the desk (worker sits facing +z)
  const chair = new THREE.Group(); chair.position.set(0, 0, -0.56); chair.userData.dynamic = true; g.add(chair); // tucked in until someone uses the desk
  const swivel = new THREE.Group(); swivel.userData.dynamic = true; chair.add(swivel); // seat and back turn on the column; the star base stays planted
  swivel.add(roundedBox(0.5, 0.09, 0.5, 0.08, toon(COLORS.chairSeat), { y: 0.42, outline: 0.012 }));
  const chairBack = roundedBox(0.5, 0.5, 0.09, 0.08, toon(COLORS.chairSeat), { y: 0.72, z: -0.24, outline: 0.012 }); swivel.add(chairBack);
  chair.add(cyl(0.035, 0.035, 0.34, toon(COLORS.chair), { y: 0.2 }, 10));
  chair.add(starBase(0.27, COLORS.chair));
  const jobKit = buildJobKit(g, { toon, PAL, applyMode: node => reapplyMode(group, node) }); // a closed laptop and a timer, until there is a job
  // on every desk, for whoever leads a team from it: nothing here appears; the screen comes on and reports land in the tray
  const leadKit = new THREE.Group(); g.add(leadKit);
  const mon2 = makeMonitor('foot', housing); mon2.position.set(0.66, 0.75, 0.14); mon2.rotation.y = 0.6; mon2.scale.setScalar(0.85); leadKit.add(mon2); // turned in toward the person in the chair

  const seatOf = (x, z, rot, back = 0.6) => ({ x: x - Math.sin(rot) * back, z: z - Math.cos(rot) * back, facing: rot, seatY: 0.44 });
  // helper desks: the two behind the lead first (they never crowd a neighbour), then two slimmer ones at the sides; all
  // square to the room, like the lead desk. The side desks leave 0.1 m to the widened lead desk, 0.4 m to the next pod's
  // side desk and 0.4 m to the meeting-room glass
  const slotDefs = [
    { x: cx - 1.0, z: cz - 1.4, rot: 0, w: 1.0 }, { x: cx + 1.0, z: cz - 1.4, rot: 0, w: 1.0 },
    { x: cx - 1.55, z: cz + 0.1, rot: 0, w: 0.9 }, { x: cx + 1.55, z: cz + 0.1, rot: 0, w: 0.9 },
  ];
  const slots = slotDefs.map((d, i) => {
    const seat = seatOf(d.x, d.z, d.rot);
    // the side seats are stepped into from the outside (straight behind them is the corner of a back helper desk)
    const side = i >= 2 ? Math.sign(d.x - cx) : 0;
    const approach = side ? { x: seat.x + side * 0.45, z: seat.z - 0.6 } : { x: seat.x - Math.sin(d.rot) * 0.8, z: seat.z - Math.cos(d.rot) * 0.8 };
    return { index: i, deskX: d.x, deskZ: d.z, rot: d.rot, deskW: d.w, ...seat, approach, taken: null, mesh: null, t: 0 };
  });

  // ---- owner props: things on and around the desk that mirror the owner's real status ----
  // the desk's sign: a plaque on the modesty panel with its owner's real project, facing the aisle; blank on a free desk.
  // On the desk itself, so it can only be this desk's. Not lit: under the desk's own shadow it would be too dark to read
  const podSign = new THREE.Group(); podSign.position.set(0, 0, 0.34); podSign.userData.dynamic = true; g.add(podSign);
  podSign.add(box(1.12, 0.26, 0.025, toon(PAL.slateDark), { y: 0.47, z: 0.0125, outline: 0.008 }));
  const podTex = canvasTex(520, 112);
  podSign.add(mesh(new THREE.PlaneGeometry(1.08, 0.23), new THREE.MeshBasicMaterial({ map: podTex.tex }), { y: 0.47, z: 0.028, cast: false }));
  freezeStatic(podSign);
  let podKey = null;
  const drawPodSign = (text, accent) => {
    const key = `${text}|${accent}`; if (key === podKey) return; podKey = key;
    const { ctx } = podTex; ctx.fillStyle = '#565e6e'; ctx.fillRect(0, 0, 520, 112);
    if (text) {
      ctx.fillStyle = '#' + (accent ?? 0xb2bac8).toString(16).padStart(6, '0'); ctx.beginPath(); ctx.arc(36, 56, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fbf8f2'; ctx.font = 'bold 56px "M PLUS Rounded 1c", sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(fitText(ctx, text, 450), 62, 59);
    }
    podTex.tex.needsUpdate = true;
  };
  drawPodSign('', null);
  // desk flag: up while the owner is blocked on the user (a question, a plan to approve, a permission prompt)
  const flag = new THREE.Group(); flag.position.set(-0.74, 0.755, 0.33); flag.visible = false; flag.userData.dynamic = true; g.add(flag);
  flag.add(cyl(0.035, 0.04, 0.03, toon(PAL.slateDark), { y: 0.015 }, 12));
  flag.add(cyl(0.01, 0.01, 0.78, toon(PAL.paper), { y: 0.41 }, 6));
  const cloth = new THREE.Group(); cloth.position.y = 0.78; flag.add(cloth);
  { const tri = new THREE.Shape(); tri.moveTo(0, 0); tri.lineTo(0.32, -0.09); tri.lineTo(0, -0.2); tri.closePath();
    cloth.add(mesh(new THREE.ShapeGeometry(tri), toon(PAL.mustard, { side: THREE.DoubleSide }), { outline: 0.006 })); }
  cloth.userData.dynamic = true; { const v = flag.visible; flag.visible = true; freezeStatic(flag); flag.visible = v; }
  const own = new THREE.Group(); own.userData.dynamic = true; g.add(own);
  // a work order clipped over the desk's front edge (the side the room sees), left of the plaque: another agent gave
  // the owner this work
  const order = new THREE.Group(); order.position.set(0.5, 0.75 - 0.2, 0.405); order.rotation.z = 0.04; order.visible = false; own.add(order);
  let orderKey = '';
  const stack = new THREE.Group(); own.add(stack);        // paper stack: grows with how long the session has been working
  const crumples = new THREE.Group(); own.add(crumples);  // crumpled paper in / around the bin: one per tool error
  const jacket = new THREE.Group(); jacket.visible = false; swivel.add(jacket); // left on the chair while on a break
  // in-tray on the desk's left wing: printouts helpers handed in (real reports)
  const tray = new THREE.Group(); tray.position.set(-0.86, 0.757, -0.12); tray.rotation.y = 0.2; leadKit.add(tray);
  tray.add(box(0.27, 0.012, 0.34, toon(PAL.slateDark), { y: 0.006 }));
  for (const [w, d, x, z] of [[0.27, 0.012, 0, -0.17], [0.27, 0.012, 0, 0.17], [0.012, 0.34, -0.135, 0], [0.012, 0.34, 0.135, 0]]) tray.add(box(w, 0.045, d, toon(PAL.slateDark), { x, y: 0.022, z, cast: false }));
  const reports = new THREE.Group(); reports.position.set(-0.86, 0.757, -0.12); reports.rotation.y = 0.2; own.add(reports);
  let reportN = 0;
  let personal = null, stackN = -1, crumpleN = -1;
  const paperMat = toon(PAL.paper), folderMats = [toon(PAL.sage), toon(PAL.mustard), toon(PAL.slate)], crumpleMat = new THREE.MeshLambertMaterial({ color: 0xf1ede4, flatShading: true });
  const ledTmp = new THREE.Color();
  let occupant = null;
  const paintSecondScreen = () => { // the second screen comes on for someone leading a team from this desk
    const on = desk.isLead && occupant;
    mon2.userData.panelMat.color.setHex(on ? (VENDOR[occupant]?.screen ?? 0xffffff) : SCREEN_OFF);
    mon2.userData.logoMat.color.setHex(on ? VENDOR[occupant].accent : 0x8884a0);
  };
  const desk = {
    id: `${row}-${col}`, row, col, x: cx, z: cz + 0.6, cellX: cx, cellZ: cz, group: g, taken: null, isLead: false,
    chair: { x: cx, z: cz + 0.6 - 0.78, facing: 0, seatY: 0.46, approach: { x: cx, z: cz + 0.6 - 0.78 - 0.8 } },
    dynamicObs: new Map(),
    briefSpot: { x: cx - 1.15, z: cz + 1.6, facing: Math.PI / 2 },
    reviewSpot: { x: cx, z: cz - 1.15, facing: 0.35, taken: null },
    slots, glowTarget: 0, t: 0,
    owner: null, led: null, chairTarget: -0.56, chairSwivel: 0, jobKit,
    setChairOut(v) { this.chairTarget = v ? -0.78 : -0.56; },
    setOwner(worker) {
      if (this.owner === worker) return;
      this.owner = worker; this.led = null;
      if (personal) { own.remove(personal); clearProps(personal); personal = null; }
      flag.visible = false;  clearProps(reports); reportN = 0; clearProps(order); order.visible = false; orderKey = ''; clearProps(jacket); jacket.visible = false; clearProps(stack); clearProps(crumples); stackN = -1; crumpleN = -1;
      if (!worker) { drawPodSign('', null); this.setChairOut(false); return; }
      const h = worker.look?.seed ?? Math.random();
      personal = personalItem(PERSONAL_KINDS[Math.floor(h * 997) % PERSONAL_KINDS.length]);
      personal.position.set(0.86, 0.755, -0.05); own.add(personal);
      const jc = toon([PAL.mustard, PAL.sage, PAL.terracotta, PAL.oakMid][Math.floor(h * 131) % 4]);
      jacket.add(box(0.5, 0.34, 0.1, jc, { y: 0.8, z: -0.255, outline: 0.008 }));
      jacket.add(box(0.53, 0.06, 0.15, jc, { y: 0.98, z: -0.25, outline: 0.008 }));       // collar over the top of the back
      for (const sx of [-0.26, 0.26]) { const sl = capsule(0.045, 0.24, jc, { x: sx, y: 0.6, z: -0.2, outline: 0.006 }); sl.rotation.z = sx > 0 ? 0.12 : -0.12; jacket.add(sl); }
      const jv = jacket.visible; jacket.visible = true; freezeStatic(jacket); jacket.visible = jv; freezeStatic(personal);
      applyMode(jacket); applyMode(personal);
    },
    /** called a few times a second with the owner's real status */
    setWorkState({ mode, accent, away, minutes, errors, project }) {
      if (!this.owner) return;
      this.led = { mode, accent };
      flag.visible = mode === 'asking';
      if (project) drawPodSign(project, accent);
      jacket.visible = !!away;
      if (this.glowTarget > 0) this.glowTarget = away ? 0.12 : mode === 'idle' ? 0.3 : 0.55;  // screen locks while away
      const n = Math.max(0, Math.min(10, Math.round(Math.log2(1 + minutes / 2) * 1.7)));
      if (n !== stackN) {
        stackN = n; clearProps(stack);
        stack.position.set(0.58, 0.757, -0.26);
        for (let i = 0; i < n; i++) { const sh = box(0.2, 0.012, 0.145, i % 4 === 3 ? folderMats[i % 3] : paperMat, { y: 0.006 + i * 0.013, cast: i === n - 1 }); sh.rotation.y = Math.sin(i * 2.7) * 0.12; stack.add(sh); }
        freezeStatic(stack); applyMode(stack); // a stack is one piece until it changes
      }
      const e = Math.max(0, Math.min(6, errors));
      if (e !== crumpleN) {
        crumpleN = e; clearProps(crumples);
        const spots = [[0, 0.26, 0], [0.04, 0.27, 0.03], [-0.04, 0.275, -0.03], [0.18, 0.03, -0.09], [0.15, 0.03, 0.19], [-0.1, 0.03, 0.27]].map(([x, y, z]) => [binX + x, y, binZ + z]); // in and around the bin
        for (let i = 0; i < e; i++) { const b = mesh(crumpleGeo, crumpleMat, { x: spots[i][0], y: spots[i][1], z: spots[i][2] }); b.rotation.set(i, i * 1.7, i * 0.6); crumples.add(b); }
        freezeStatic(crumples); applyMode(crumples);
      }
    },
    /** the hanging team sign: the lead's real project while it has helpers with it, '' to take it down */
    teamHue,
    setOccupant(vendorKey) {
      const c = vendorKey ? (VENDOR[vendorKey]?.screen ?? 0xffffff) : SCREEN_OFF;
      mon.userData.panelMat.color.setHex(c); mon.userData.logoMat.color.setHex(vendorKey ? VENDOR[vendorKey].accent : 0x8884a0);
      occupant = vendorKey; paintSecondScreen();
      if (vendorKey) { glow.material.color.setHex(c); this.glowTarget = 0.55; } else this.glowTarget = 0;
    },
    setLead(v) {
      if (this.isLead === v) return; this.isLead = v;
      paintSecondScreen();
    },
    setMug(v) { mug.visible = v; },
    /** the work order hanging from the desk's front edge: `{ color, guess }` (the giver's accent; `guess` when who gave it is only inferred: the slip is
     *  dog-eared) or null to take it down. Rebuilt only when it changes. */
    setWorkOrder(o) {
      const key = o ? `${o.color}|${o.guess ? 1 : 0}` : '';
      if (key === orderKey) return;
      orderKey = key; clearProps(order); order.visible = !!o;
      if (!o) return;
      const W = 0.22, H = 0.2;
      const tint = toon(new THREE.Color(PAL.paper).lerp(new THREE.Color(o.color), 0.14).getHex());     // paper, faintly the giver's
      order.add(box(W, H, 0.006, tint, { y: H / 2, outline: 0.007, cast: false }));                       // the slip
      order.add(box(W, 0.05, 0.008, toon(o.color), { y: H - 0.04, cast: false }));                        // the giver's band
      for (let i = 0; i < 3; i++) order.add(box(W * (i === 2 ? 0.42 : 0.7), 0.012, 0.008, toon(PAL.slate), { x: -W * (i === 2 ? 0.2 : 0.09), y: 0.11 - i * 0.03, cast: false })); // typed lines
      order.add(box(0.07, 0.024, 0.04, toon(PAL.slateDark), { y: H - 0.006, z: -0.012, cast: false }));    // the clip on the desk's edge
      if (o.guess) { // dog-eared: the bottom-right corner turned up (the paler underside of the paper showing)
        const k = 0.06, tri = new THREE.Shape(); tri.moveTo(0, 0); tri.lineTo(-k, 0); tri.lineTo(0, k); tri.closePath();
        order.add(mesh(new THREE.ShapeGeometry(tri), toon(0xf6f2ea, { side: THREE.DoubleSide }), { x: W / 2, y: 0, z: 0.0065, outline: 0.005, cast: false }));
      }
      freezeStatic(order); applyMode(order);
    },
    addReport() { // a helper's printout lands on the pile, slightly askew; a green tick on the newest one
      if (reportN >= 8) return; reportN++;
      const i = reportN - 1;
      const sh = box(0.22, 0.004, 0.29, toon(PAL.paper), { y: 0.015 + i * 0.007, cast: false }); sh.rotation.y = Math.sin(i * 2.1) * 0.08; reports.add(sh);
      reports.children.filter(c => c.userData.tick).forEach(c => { reports.remove(c); c.geometry.dispose(); });
      const tick = box(0.06, 0.004, 0.035, toon(PAL.sageDeep), { x: 0.05, y: 0.019 + i * 0.007, z: -0.08, cast: false }); tick.rotation.y = sh.rotation.y; tick.userData.tick = true; tick.userData.noMerge = true; reports.add(tick);
      freezeStatic(reports); applyMode(reports); // the previous merged pile is disposed by the re-merge
    },
    ensureHelperDesk(i) {
      const s = slots[i];
      if (s.mesh) { // still there: if it was folding away, unfold it again and put its footprint back
        if (s.mesh.userData.closing) {
          s.mesh.userData.closing = false; s.t = Math.min(0.4, s.mesh.scale.x / 2.5);
          this.dynamicObs.set(i, [[s.deskX, s.deskZ, s.deskW, 0.55, s.rot], [s.x, s.z, 0.44, 0.44, s.rot]]);
          this.onObstaclesChanged?.();
        }
        return s;
      }
      const w = s.deskW;
      const hg = new THREE.Group(); hg.position.set(s.deskX, 0, s.deskZ); hg.rotation.y = s.rot; group.add(hg);
      hg.add(roundedBox(w, 0.05, 0.55, 0.05, toon(COLORS.helperDesk), { y: 0.7, outline: 0.012 }));
      for (const sx of [-1, 1]) hg.add(cyl(0.03, 0.03, 0.68, toon(COLORS.deskLeg), { x: sx * (w / 2 - 0.08), y: 0.34, z: 0.1 }, 8));
      for (const sx of [-1, 1]) hg.add(cyl(0.03, 0.03, 0.68, toon(COLORS.deskLeg), { x: sx * (w / 2 - 0.08), y: 0.34, z: -0.15 }, 8));
      // open laptop facing the sitter (-z)
      hg.add(box(0.32, 0.02, 0.22, toon(PAL.paper), { y: 0.735, z: 0.02, outline: 0.01 }));
      const lid = box(0.32, 0.2, 0.015, toon(PAL.paper), { y: 0.83, z: 0.12, outline: 0.01 }); lid.rotation.x = -0.2; hg.add(lid);
      const lidGlow = box(0.28, 0.16, 0.004, new THREE.MeshBasicMaterial({ color: 0xd8c8f5 }), { y: 0.83, z: 0.11, cast: false }); lidGlow.rotation.x = -0.2; hg.add(lidGlow);
      hg.add(cyl(0.04, 0.035, 0.08, toon(PAL.paper), { x: w / 2 - 0.14, y: 0.76, z: -0.05, outline: 0.008 }, 12));
      const ch = new THREE.Group(); ch.position.set(0, 0, -0.6); hg.add(ch);
      ch.add(roundedBox(0.42, 0.08, 0.42, 0.08, toon(helperChairCol), { y: 0.4, outline: 0.012 }));             // in the team's colour
      ch.add(roundedBox(0.42, 0.36, 0.08, 0.08, toon(helperChairCol), { y: 0.62, z: -0.2, outline: 0.012 }));
      ch.add(cyl(0.03, 0.03, 0.34, toon(COLORS.chair), { y: 0.19 }, 10));
      ch.add(starBase(0.23, COLORS.chair));
      freezeStatic(hg); // the pop-in scales the whole desk, so its parts can be one piece
      applyMode(hg);
      hg.scale.setScalar(0.01); s.mesh = hg; s.t = 0; s.lidGlow = lidGlow;
      this.dynamicObs.set(i, [[s.deskX, s.deskZ, w, 0.55, s.rot], [s.x, s.z, 0.44, 0.44, s.rot]]);
      this.onObstaclesChanged?.();
      return s;
    },
    removeHelperDesk(i) { const s = slots[i]; if (!s.mesh) return; s.mesh.userData.closing = true; this.dynamicObs.delete(i); this.onObstaclesChanged?.(); },
    update(dt) {
      this.t += dt;
      const flicker = this.glowTarget > 0 ? 1 + Math.sin(this.t * 7.3) * 0.05 + Math.sin(this.t * 2.1) * 0.05 : 1;
      glow.material.opacity += (this.glowTarget * flicker * (1 + NIGHT.lamps * 0.5) - glow.material.opacity) * Math.min(1, dt * 4);
      chair.position.z += (this.chairTarget - chair.position.z) * Math.min(1, dt * 5);
      swivel.rotation.y = this.chairSwivel;
      jobKit.update(dt);
      if (flag.visible) cloth.rotation.y = Math.sin(this.t * 3.1) * 0.35 + Math.sin(this.t * 7.3) * 0.08;
      if (lampMat) { const on = NIGHT.lamps * (this.owner ? 1 : 0); lampMat.emissiveIntensity = on * 1.1; lampPool.material.opacity = on * 0.42; } // a lamp burns only where someone works
      if (this.led) {
        let col = this.led.accent, k = 1;
        switch (this.led.mode) {
          case 'thinking': k = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(this.t * 3.6)); break;
          case 'waiting': col = 0xf0b23a; k = Math.sin(this.t * 2.4) > -0.3 ? 1 : 0.25; break;
          case 'error': col = 0xe05a4f; k = Math.sin(this.t * 16) > 0 ? 1 : 0.2; break;
          case 'idle': k = 0.35; break;
          case 'away': col = 0x8884a0; k = 0.7; break;
          case 'asking': { col = 0xffffff; const ph = (this.t * 1.4) % 1; k = ph < 0.12 || (ph > 0.24 && ph < 0.36) ? 1 : 0.12; break; } // double blink: a call light
        }
        ledTmp.setHex(col).multiplyScalar(k);
        mon.userData.logoMat.color.copy(ledTmp); if (this.isLead) mon2.userData.logoMat.color.copy(ledTmp);
      }
      for (const s of slots) {
        if (!s.mesh) continue;
        if (s.mesh.userData.closing) {
          s.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 6));
          if (s.mesh.scale.x < 0.02) { group.remove(s.mesh); s.mesh.traverse(o => o.isMesh && o.geometry?.dispose?.()); s.mesh = null; }
        } else {
          s.t += dt; const k = Math.min(1, s.t * 2.5); const over = 1 + Math.sin(k * Math.PI) * 0.12;
          s.mesh.scale.setScalar(Math.max(0.01, k * over));
        }
      }
    },
  };
  // batch each rigid part on its own: the chair slides as one piece and its seat swivels as another
  jacket.userData.dynamic = true;
  freezeStatic(swivel); freezeStatic(chair);
  return desk;
}
