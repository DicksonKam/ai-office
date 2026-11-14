// The site the building stands on: lawn, paved apron, a street with sidewalks and a zebra crossing, the path from the
// street to the entrance, a monument sign, bench, bike rack, street lamps and bollards, a staff terrace behind the
// building by the fire exit, a low timber fence, a kerbed shrub bed and trees behind the back wall, parked cars and a bus
// stop on the street. Built once and never dimmed or ghosted with the floors.
// At night the lamps, bollards, sign and bus-stop panels glow (lampMats) and soft additive light pools lie on the ground (nightPools):
// under each lamp and bollard, in front of the sign, and spilling from every lit back window onto the lawn.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon, matte, box, sphere, cyl, mesh, roundedBox, gradientMap } from './toon.js';
import { PAL, tree } from './office.js';
import { freezeStatic } from './merge.js';
import { wallPoint } from './openings.js';

const GROUND = -0.3;           // the lawn sits a foundation's height below the ground-floor slab top

/** grass: a calm sage-green base (#a9c98f) with mowing stripes only ±0.75 % lightness apart (they render about twice
 *  that, and at ±1.5 % they read as bands across the whole frame) and a fine speckle; the
 *  meadow patches use the same speckle on their own base, without stripes (unmown) */
function lawnTexture({ stripes = true, base = 'hsl(93, 35%, 67.5%)' } = {}) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 256, 256);
  if (stripes) for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? 'hsl(93, 35%, 66.75%)' : 'hsl(93, 35%, 68.25%)'; g.fillRect(0, i * 64, 256, 64); } // soft mowing stripes
  for (let k = 0; k < 900; k++) { g.fillStyle = hash(k, 1) < 0.5 ? 'rgba(80,120,70,0.08)' : 'rgba(255,255,230,0.08)'; g.fillRect(hash(k, 2) * 256, hash(k, 3) * 256, 2, 2); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
/** soft meadow patches on the lawn: irregular rounded blobs (a few low harmonics on an ellipse), opaque inside a feathered
 *  rim (vertex alpha), UVs in world metres / 8 so the speckle lines up with the lawn's, all merged into one flat mesh */
function meadowPatches(spots, y) {
  const geos = [], SEG = 56;
  for (const [cx, cz, rx, rz, seed] of spots) {
    const ph = [1, 2, 3].map(k => hash(seed, k) * 6.283), feather = 0.7;
    const r = a => 1 + 0.11 * Math.sin(2 * a + ph[0]) + 0.07 * Math.sin(3 * a + ph[1]) + 0.04 * Math.sin(5 * a + ph[2]);
    const pos = [cx, y, cz], col = [1, 1, 1, 1], idx = [];
    for (let i = 0; i < SEG; i++) {
      const a = i / SEG * Math.PI * 2, k = r(a), ex = Math.cos(a) * rx * k, ez = Math.sin(a) * rz * k, len = Math.hypot(ex, ez), f = Math.max(0.2, 1 - feather / len);
      pos.push(cx + ex * f, y, cz + ez * f, cx + ex, y, cz + ez);
      col.push(1, 1, 1, 1, 1, 1, 1, 0);
    }
    for (let i = 0; i < SEG; i++) {
      const a = 1 + i * 2, b = 1 + ((i + 1) % SEG) * 2;       // inner ring a, b; outer ring a + 1, b + 1
      idx.push(0, b, a, a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    const uv = []; for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / 8, -pos[i + 2] / 8);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    geos.push(g);
  }
  const mat = new THREE.MeshStandardMaterial({ map: lawnTexture({ stripes: false, base: '#b4cd8a' }), roughness: 1, vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  mat.map.repeat.set(1, 1);
  const m = new THREE.Mesh(mergeGeometries(geos, false), mat); for (const g of geos) g.dispose();
  m.receiveShadow = true; m.castShadow = false; m.renderOrder = 1; m.userData.noMerge = true;
  return m;
}
function paverTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128; const g = c.getContext('2d');
  g.fillStyle = '#bdb4a7'; g.fillRect(0, 0, 128, 128);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) { g.fillStyle = (r + k) % 3 ? '#dcd5ca' : '#d5cdc1'; g.fillRect(k * 32 + 1.5, r * 32 + 1.5, 29, 29); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
/** a soft round light pool: white in the middle, fading to nothing at the rim (CircleGeometry UVs) */
function glowTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128; const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 63);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.3, 'rgba(255,255,255,0.62)'); r.addColorStop(0.65, 'rgba(255,255,255,0.2)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 128); g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
/** window spill: soft side edges, rises just past the wall, strongest a metre or two out, then fades away (v = 0 at the wall) */
function spillTexture() {
  const W = 64, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const img = g.createImageData(W, H), ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, v = 1 - (y + 0.5) / H;          // canvas top = far end (flipY)
    const edge = 1 - ss(0.3, 0.5, Math.abs(u - 0.5));
    const along = ss(0, 0.1, v) * Math.pow(1 - ss(0.15, 1, v), 1.3);
    const k = Math.round(255 * edge * along), i = (y * W + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = k; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}
function slabPlane(w, d, mat, x, z, y = GROUND + 0.012) {
  const m = mesh(new THREE.PlaneGeometry(w, d), mat, { x, y, z, cast: false, receive: true }); m.rotation.x = -Math.PI / 2; return m;
}
function shrub(scale = 1, { seg = 12, a = PAL.leaf, b = PAL.sageDeep } = {}) {
  const g = new THREE.Group();
  [[0, 0.22, 0, 0.28], [0.22, 0.17, 0.05, 0.2], [-0.2, 0.18, -0.04, 0.21], [0.05, 0.16, -0.2, 0.18]].forEach(([x, y, z, r], i) =>
    g.add(sphere(r * scale, toon(i % 2 ? b : a), { x: x * scale, y: y * scale, z: z * scale, outline: 0.012 }, seg)));
  return g;
}
/** a stable pseudo-random number in [0, 1) for (i, k): the same site always grows the same way */
const hash = (i, k = 0) => { const s = Math.sin(i * 12.9898 + k * 78.233 + 0.5) * 43758.5453; return s - Math.floor(s); };
/** one canvas for the bus stop: the shelter's backlit route-map panel on top, the stop flag below (one material, one draw) */
const BUS_SPLIT = 456 / 640, BUS_FLAG = [460 / 640, 638 / 640];   // canvas rows of the two prints, as fractions
function busTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 640; const g = c.getContext('2d');
  const font = (px, w = 'bold') => `${w} ${px}px "M PLUS Rounded 1c", sans-serif`;
  g.fillStyle = '#e6dccf'; g.fillRect(0, 0, 256, 640);
  // route map panel (0…456): a slate header with the route numbers, a mustard line of stops, "you are here" in terracotta
  g.fillStyle = '#fbf8f2'; g.fillRect(0, 0, 256, 456);
  g.fillStyle = '#565e6e'; g.fillRect(0, 0, 256, 70);
  g.fillStyle = '#fbf8f2'; g.font = font(30); g.textBaseline = 'middle'; g.fillText('12 · 27', 20, 36);
  g.fillStyle = '#e2b35d'; g.beginPath(); g.arc(222, 35, 18, 0, 7); g.fill();
  g.fillStyle = '#3f3a4a'; g.font = font(16); g.textAlign = 'center'; g.fillText('BUS', 222, 36); g.textAlign = 'left';
  const stops = ['Harbour', 'Market St', 'AI Office', 'Library', 'Park Gate', 'Station'];
  g.strokeStyle = '#e2b35d'; g.lineWidth = 9; g.lineCap = 'round'; g.beginPath(); g.moveTo(46, 112); g.lineTo(46, 112 + 54 * 5); g.stroke();
  stops.forEach((s, i) => {
    const y = 112 + i * 54, here = s === 'AI Office';
    g.fillStyle = here ? '#cf8466' : '#fbf8f2'; g.strokeStyle = here ? '#cf8466' : '#b79470'; g.lineWidth = 4;
    g.beginPath(); g.arc(46, y, here ? 13 : 9, 0, 7); g.fill(); g.stroke();
    g.fillStyle = here ? '#3f3a4a' : '#6f6878'; g.font = font(here ? 22 : 19, here ? 'bold' : '500'); g.fillText(s, 74, y + 1);
  });
  g.fillStyle = '#9db892'; g.fillRect(0, 440, 256, 16);
  // stop flag (460…638): slate band "BUS STOP", route numbers in mustard pills
  g.fillStyle = '#fbf8f2'; g.fillRect(0, 460, 256, 178);
  g.fillStyle = '#565e6e'; g.fillRect(0, 460, 256, 68);
  g.fillStyle = '#fbf8f2'; g.font = font(34); g.textAlign = 'center'; g.fillText('BUS STOP', 128, 496);
  [['12', 64], ['27', 128], ['41', 192]].forEach(([n, x]) => {
    g.fillStyle = '#e2b35d'; g.beginPath(); g.roundRect(x - 27, 552, 54, 52, 14); g.fill();
    g.fillStyle = '#3f3a4a'; g.font = font(30); g.fillText(n, x, 580);
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
/** a plane showing rows v0…v1 (fractions from the canvas top) of a canvas texture */
function printPlane(w, h, v0, v1) {
  const geo = new THREE.PlaneGeometry(w, h), uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, (1 - v1) + uv.getY(i) * (v1 - v0));
  return geo;
}
function signTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 160; const g = c.getContext('2d');
  g.fillStyle = '#fbf8f2'; g.fillRect(0, 0, 512, 160);
  g.fillStyle = '#3f3a4a'; g.font = 'bold 72px "M PLUS Rounded 1c", sans-serif'; g.textBaseline = 'middle'; g.fillText('AI Office', 40, 74);
  g.fillStyle = '#9db892'; g.fillRect(40, 118, 120, 8); g.fillStyle = '#cf8466'; g.fillRect(168, 118, 60, 8); g.fillStyle = '#e2b35d'; g.fillRect(236, 118, 40, 8);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
/** the safe-condition "assembly point" sign (a physical standard, in the office's softened exit green) */
function assemblyTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 160; const g = c.getContext('2d');
  g.fillStyle = '#4f9a6a'; g.fillRect(0, 0, 128, 160);
  g.strokeStyle = '#fbf8f2'; g.fillStyle = '#fbf8f2'; g.lineWidth = 4; g.strokeRect(6, 6, 116, 148);
  const person = (x, y, s) => { g.beginPath(); g.arc(x, y, 7 * s, 0, 7); g.fill(); g.beginPath(); g.roundRect(x - 8 * s, y + 10 * s, 16 * s, 24 * s, 6 * s); g.fill(); };
  person(44, 52, 0.8); person(84, 52, 0.8); person(64, 46, 1);
  const arrow = (x, y, a) => { g.save(); g.translate(x, y); g.rotate(a); g.fillRect(-13, -2.5, 10, 5); g.beginPath(); g.moveTo(6, 0); g.lineTo(-5, -7); g.lineTo(-5, 7); g.closePath(); g.fill(); g.restore(); };
  arrow(24, 24, Math.PI / 4); arrow(104, 24, Math.PI * 3 / 4); arrow(24, 100, -Math.PI / 4); arrow(104, 100, -Math.PI * 3 / 4);
  g.font = 'bold 15px "M PLUS Rounded 1c", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('ASSEMBLY', 64, 124); g.fillText('POINT', 64, 142);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

export function buildSite(scene, office) {
  const { hx, hz, door } = office;
  const group = new THREE.Group(); scene.add(group);
  const zDoor = door.z;
  const stone = matte(0xd8d2c8), stoneDark = matte(0xccc5b9);
  const iron = toon(PAL.slateDark), oak = toon(PAL.oak), oakMid = toon(PAL.oakMid), oakDark = toon(PAL.oakDark);

  // lawn: big enough that its edge never shows in the frame, a tall phone screen included
  const lt = lawnTexture(); lt.repeat.set(160 / 8, 160 / 8);
  group.add(slabPlane(160, 160, new THREE.MeshStandardMaterial({ map: lt, roughness: 1 }), 0, 0, GROUND));

  // meadow patches: large, soft, unmown drifts in a slightly warmer green (a paler one read as haze), on open lawn away from the paths, the terrace and the
  // street: east of the right hedge, behind the back fence, and west of the side fence
  group.add(meadowPatches([
    [hx + 6.8, -0.4, 3.4, 4.6, 1],
    [-hx * 0.3, -hz - 12.0, 6.0, 2.4, 2],
  ], GROUND + 0.006));

  // every paved surface shares one material (UVs scaled to a 2 m tile), so all paving merges into one draw
  const paverMat = new THREE.MeshStandardMaterial({ map: paverTexture(), roughness: 0.9 });
  const pavers = (w, d, x, z, y = GROUND + 0.012) => {
    const geo = new THREE.PlaneGeometry(w, d), uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 2, uv.getY(i) * d / 2);
    const m = mesh(geo, paverMat, { x, y, z, cast: false, receive: true }); m.rotation.x = -Math.PI / 2; group.add(m);
  };
  // paved apron hugging the foundation on the open front and right sides
  pavers(2 * hx + 1.2, 1.2, 0.6, hz + 0.6);          // front
  pavers(1.2, 2 * hz, hx + 0.6, 0);                  // right

  // the street along the front: near sidewalk and kerb, asphalt with a dashed centre line, far kerb and sidewalk
  const sz0 = hz + 4.0, zRoad = sz0 + 4.78;
  const px = -hx - 3.9;                              // the entrance path's centre line, and the zebra crossing's
  // kerbs drop flush at the zebra crossing, with a strip of tactile paving at each end, as a real crossing has
  const tactile = matte(0xd9a98f), kerbStone = matte(0xd8cfc3); // kerbs a shade warmer than the porch stone
  const kerb = (z, zPad) => {
    const xa = px - 1.6, xb = px + 1.6;
    group.add(box(xa + 80, 0.12, 0.18, kerbStone, { x: (xa - 80) / 2, y: GROUND + 0.06, z, cast: false, receive: true }));
    group.add(box(80 - xb, 0.12, 0.18, kerbStone, { x: (xb + 80) / 2, y: GROUND + 0.06, z, cast: false, receive: true }));
    group.add(box(xb - xa, 0.025, 0.18, kerbStone, { x: px, y: GROUND + 0.0125, z, cast: false, receive: true }));   // dropped kerb
    group.add(slabPlane(2.9, 0.55, tactile, px, zPad, GROUND + 0.016));
  };
  pavers(160, 1.6, 0, sz0 + 0.8);
  kerb(sz0 + 1.69, sz0 + 1.3);
  // a light, slightly cool asphalt: the day light (sun + fill + sky, neutral tone mapping) brings 0x898995 to about
  // #77727a on screen, a mid grey that sits with the pastels instead of a heavy dark band across the frame
  group.add(slabPlane(160, 6, matte(0x898995), 0, zRoad, GROUND + 0.004));
  const lineMat = matte(0xf1ece4);                   // lane and zebra paint: a soft warm white, not a glare
  for (let x = -79; x < 79; x += 3) if (Math.abs(x - px) > 2.3) group.add(slabPlane(1.4, 0.12, lineMat, x, zRoad, GROUND + 0.008));
  for (let i = 0; i < 6; i++) group.add(slabPlane(3.0, 0.5, lineMat, px, zRoad + (i - 2.5), GROUND + 0.008)); // zebra crossing
  kerb(sz0 + 7.87, sz0 + 8.26);
  pavers(160, 1.6, 0, sz0 + 8.76);

  // the path: sidewalk → north along the lawn → east onto the porch, with two steps up to porch level
  // (a hair above the sidewalk where the two overlap, so they never z-fight)
  pavers(1.3, sz0 - zDoor + 0.65, px, (sz0 + zDoor) / 2 + 0.3, GROUND + 0.014);
  const stepW = Math.max(1.4, (door.width || 1.0) + 0.3);  // the steps are as wide as the double door, and a bit
  pavers(0.9, stepW - 0.1, -hx - 3.0 - 0.45, zDoor);
  group.add(box(0.2, 0.1, stepW, stone, { x: -hx - 3.1, y: -0.05, z: zDoor, cast: false, receive: true }));       // upper step
  group.add(box(0.2, 0.2, stepW, stoneDark, { x: -hx - 3.3, y: -0.2, z: zDoor, cast: false, receive: true }));    // lower step

  // night light: one emissive material for every lamp head, bollard band and the sign's halo strip (driven by main.js),
  // and two additive ground layers (pools and window spill), each merged into a single mesh
  const headMat = toon(0xfff1c9, { emissive: 0xffd88a, emissiveIntensity: 0 });
  const pools = [], spills = [], lampSpots = [];
  const pool = (x, z, r, k) => pools.push({ geo: new THREE.CircleGeometry(r, 32), x, z, k });

  // street lamps along the near sidewalk: the original by the path (it carries the real night light), two more east
  const streetLamp = (x, z) => {
    const lamp = new THREE.Group(); lamp.position.set(x, GROUND, z); group.add(lamp);
    lamp.add(cyl(0.12, 0.15, 0.12, iron, { y: 0.06 }, 12));
    lamp.add(cyl(0.04, 0.05, 3.2, iron, { y: 1.7 }, 10));
    lamp.add(cyl(0.2, 0.12, 0.26, iron, { y: 3.38, outline: 0.01 }, 14));
    lamp.add(cyl(0.15, 0.15, 0.06, headMat, { y: 3.24, cast: false }, 14));
    lampSpots.push(new THREE.Vector3(x, GROUND + 3.1, z));
  };
  streetLamp(px + 1.0, sz0 + 0.3); pool(px + 1.0, sz0 + 0.5, 2.5, 0.6);   // already lit by a point light: a softer pool
  for (const x of [px + 10, px + 22]) { streetLamp(x, sz0 + 0.3); pool(x, sz0 + 0.5, 2.5, 0.9); }

  // street trees in iron grates near the kerb, every 6 m (static: the merged batch keeps them cheap)
  const grate = matte(PAL.slateDark), grateRim = matte(PAL.metal);
  [px + 7, px + 13, px + 19, px + 25].forEach((x, i) => {
    const z = sz0 + 1.0;
    group.add(slabPlane(0.9, 0.9, grate, x, z, GROUND + 0.016));
    for (const [w, d, dx, dz] of [[1.0, 0.05, 0, 0.475], [1.0, 0.05, 0, -0.475], [0.05, 0.9, 0.475, 0], [0.05, 0.9, -0.475, 0]]) group.add(box(w, 0.02, d, grateRim, { x: x + dx, y: GROUND + 0.02, z: z + dz, cast: false }));
    const t = tree(0.9 + (i % 2) * 0.1, i + 1, i % 2 ? 'hornbeam' : 'round'); t.position.set(x, GROUND, z); t.rotation.y = i * 2.1; group.add(t); // narrow hornbeams keep the pavement open
  });

  // bike rack on the sidewalk east of the path: three Sheffield stands, square to the kerb
  for (const x of [px + 2.55, px + 3.35, px + 4.15]) {
    const z = sz0 + 0.8;
    for (const dz of [-0.33, 0.33]) group.add(cyl(0.025, 0.025, 0.72, iron, { x, y: GROUND + 0.36, z: z + dz, outline: 0.005 }, 8));
    const top = cyl(0.025, 0.025, 0.66, iron, { x, y: GROUND + 0.72, z, outline: 0.005 }, 8); top.rotation.x = Math.PI / 2; group.add(top);
  }
  { // somebody cycled in: one mustard bicycle leaning on the outer stand, parallel to it
    const bike = new THREE.Group(); bike.position.set(px + 4.3, GROUND, sz0 + 0.8); bike.rotation.z = 0.07; group.add(bike);
    const frame = toon(PAL.mustard), tyre = toon(0x4a4656), up = new THREE.Vector3(0, 1, 0);
    const tube = (a, b, r = 0.018, mat = frame) => {
      const d = new THREE.Vector3().subVectors(b, a), t = cyl(r, r, d.length(), mat, { outline: 0.005 }, 6);
      t.position.copy(a).addScaledVector(d, 0.5); t.quaternion.setFromUnitVectors(up, d.normalize()); bike.add(t);
    };
    const V = (y, z) => new THREE.Vector3(0, y, z);
    const R = V(0.32, -0.47), F = V(0.32, 0.49), B = V(0.3, -0.04), S = V(0.78, -0.17), H = V(0.8, 0.36), Hb = V(0.64, 0.4);
    for (const c of [R, F]) {
      const w = mesh(new THREE.TorusGeometry(0.29, 0.024, 6, 22), tyre, { y: c.y, z: c.z, outline: 0.005 }); w.rotation.y = Math.PI / 2; bike.add(w);
      bike.add(sphere(0.035, iron, { y: c.y, z: c.z }, 8));
    }
    tube(B, S); tube(S, H); tube(B, Hb, 0.021); tube(B, R, 0.014); tube(S, R, 0.013); tube(Hb, F, 0.016); tube(H, V(0.92, 0.33), 0.016, iron);
    tube(S, V(0.84, -0.2), 0.013, iron);
    bike.add(box(0.1, 0.045, 0.22, toon(PAL.ink), { y: 0.865, z: -0.21, outline: 0.005 }));                 // saddle
    const bar = cyl(0.014, 0.014, 0.44, iron, { y: 0.92, z: 0.33, outline: 0.005 }, 6); bar.rotation.z = Math.PI / 2; bike.add(bar);
  }

  // parked cars along the near kerb, all facing the traffic of the near lane: one model in four muted paints, nose to tail
  // in two pairs, kept off the zebra crossing (and its approach) and out of the bus-stop bay
  const carGeo = (() => {
    const g = m => m.geometry;
    return {
      body: g(roundedBox(3.5, 0.56, 1.56, 0.3, iron)), cabin: g(roundedBox(1.95, 0.44, 1.38, 0.24, iron)), roof: g(roundedBox(2.02, 0.07, 1.44, 0.26, iron)),
      sill: new THREE.BoxGeometry(2.06, 0.035, 1.42), door: new THREE.BoxGeometry(0.018, 0.34, 1.58), arch: new THREE.CylinderGeometry(0.385, 0.385, 1.575, 18), mirror: new THREE.BoxGeometry(0.08, 0.07, 0.13),
      pillar: new THREE.BoxGeometry(0.09, 0.44, 1.43), bumper: new THREE.BoxGeometry(0.14, 0.14, 1.2), lamp: new THREE.BoxGeometry(0.05, 0.1, 0.24),
      tyre: new THREE.CylinderGeometry(0.3, 0.3, 0.22, 16), hub: new THREE.CylinderGeometry(0.14, 0.14, 0.23, 12),
    };
  })();
  const carGlass = toon(0x37434f), carTyre = toon(0x3c3946), carTrim = toon(PAL.metal), headLamp = toon(PAL.paper), tailLamp = toon(0xb9624d);
  const parkedCar = (x, z, paint, yaw) => {
    const car = new THREE.Group(); car.position.set(x, GROUND, z); car.rotation.y = yaw; group.add(car);
    const p = toon(paint);
    car.add(mesh(carGeo.body, p, { y: 0.62, outline: 0.012 }));
    car.add(mesh(carGeo.cabin, carGlass, { x: -0.2, y: 1.12, outline: 0.012 }));
    car.add(mesh(carGeo.roof, p, { x: -0.2, y: 1.375, outline: 0.012 }));
    car.add(mesh(carGeo.sill, carTrim, { x: -0.2, y: 0.905, cast: false }));                                   // a bright line under the windows
    car.add(mesh(carGeo.door, carTyre, { x: -0.2, y: 0.66, cast: false }));                                    // the shut line between the doors
    for (const dx of [-1.12, 1.12]) { const a = mesh(carGeo.arch, carTyre, { x: dx, y: 0.34, cast: false }); a.rotation.x = Math.PI / 2; car.add(a); } // wheel arches
    for (const sz of [-1, 1]) car.add(mesh(carGeo.mirror, p, { x: 0.62, y: 0.97, z: sz * 0.76, outline: 0.006 }));
    for (const dx of [-0.93, -0.2, 0.53]) car.add(mesh(carGeo.pillar, p, { x: dx, y: 1.12 }));                // C, B and A pillars (the rounded ends read as the screens)
    for (const s of [-1, 1]) {
      car.add(mesh(carGeo.bumper, carTrim, { x: s * 1.72, y: 0.42, outline: 0.008 }));
      for (const dz of [-0.42, 0.42]) car.add(mesh(carGeo.lamp, s > 0 ? headLamp : tailLamp, { x: s * 1.75, y: 0.72, z: dz, cast: false }));
      for (const dx of [-1.12, 1.12]) {
        const t = mesh(carGeo.tyre, carTyre, { x: dx, y: 0.3, z: s * 0.7, outline: 0.012 }); t.rotation.x = Math.PI / 2; car.add(t);
        const h = mesh(carGeo.hub, carTrim, { x: dx, y: 0.3, z: s * 0.7, cast: false }); h.rotation.x = Math.PI / 2; car.add(h);
      }
    }
  };
  const zCar = sz0 + 2.83;                           // 0.25 m off the kerb face
  [[px + 6.6, 0x8d9fb5, 0.04, 0.012], [px + 11.0, 0xeee4cf, -0.03, -0.01],   // dusty blue, cream
    [px + 22.2, PAL.terracotta, 0.06, 0.008], [px + 26.9, PAL.sage, 0, -0.015]] // terracotta, sage
    .forEach(([x, paint, dz, yaw]) => parkedCar(x, zCar + dz, paint, yaw));

  // ---- bus stop: a shelter on its own paved pad behind the sidewalk (the walkway stays clear), a stop flag at the kerb,
  //      and a mustard bus bay painted on the road. The route-map panel and the flag are backlit at night. ----
  const busTex = busTexture();
  const busMat = new THREE.MeshToonMaterial({ map: busTex, gradientMap: gradientMap(), emissive: 0xf0e4cc, emissiveMap: busTex, emissiveIntensity: 0 });
  busMat.color.setScalar(1.15);
  const bx = px + 16, bz = sz0 - 0.68;               // the shelter's centre: open side to the street, glass back to the hedge
  pavers(3.4, 1.36, bx, sz0 - 0.68);
  {
    const sh = new THREE.Group(); sh.position.set(bx, GROUND, bz); group.add(sh);
    const roofMat = toon(PAL.paper);
    for (const sx of [-1.36, 1.36]) for (const sz of [-0.5, 0.5]) sh.add(box(0.06, 2.3, 0.06, iron, { x: sx, y: 1.15, z: sz, outline: 0.008 }));
    sh.add(box(3.0, 0.06, 1.36, roofMat, { y: 2.33, outline: 0.008 }));
    sh.add(box(3.04, 0.14, 0.04, iron, { y: 2.31, z: 0.7, outline: 0.006 }));                                  // fascia
    sh.add(box(2.6, 0.025, 0.08, headMat, { y: 2.285, z: 0.32, cast: false }));                                // light strip
    for (const y of [0.16, 2.06]) sh.add(box(2.72, 0.05, 0.05, iron, { y, z: -0.5 }));                       // glass rails
    sh.add(box(2.66, 0.05, 0.025, roofMat, { y: 1.45, z: -0.5, cast: false }));                                // manifestation band
    { // the glass: back panel and a half-depth wind screen at the west end, merged (transparent: one draw)
      const back = new THREE.BoxGeometry(2.66, 1.86, 0.02).translate(0, 1.11, -0.5), side = new THREE.BoxGeometry(0.02, 1.86, 0.8).translate(-1.36, 1.11, -0.08);
      const glass = new THREE.Mesh(mergeGeometries([back, side], false), new THREE.MeshStandardMaterial({ color: 0xdfeaee, transparent: true, opacity: 0.3, roughness: 0.15, depthWrite: false }));
      back.dispose(); side.dispose(); glass.renderOrder = 1; sh.add(glass);
    }
    for (let i = 0; i < 3; i++) sh.add(box(1.9, 0.04, 0.12, oakMid, { x: -0.25, y: 0.46, z: -0.42 + i * 0.13, outline: 0.006 })); // bench
    for (const sx of [-1.0, 0.5]) sh.add(box(0.05, 0.44, 0.34, iron, { x: sx, y: 0.22, z: -0.29 }));
    // the backlit route-map panel closing the east end, facing along the pavement
    sh.add(box(0.12, 1.76, 0.98, iron, { x: 1.36, y: 1.12, z: -0.06, outline: 0.008 }));
    const face = mesh(printPlane(0.86, 1.56, 0, BUS_SPLIT), busMat, { x: 1.425, y: 1.12, z: -0.06, cast: false }); face.rotation.y = Math.PI / 2; sh.add(face);
  }
  { // the stop flag at the kerb, square to the road so an approaching bus sees it
    const fx0 = px + 17.5, fz0 = sz0 + 1.42;
    group.add(cyl(0.035, 0.04, 2.5, iron, { x: fx0, y: GROUND + 1.25, z: fz0, outline: 0.006 }, 8));
    group.add(box(0.05, 0.4, 0.58, iron, { x: fx0, y: GROUND + 2.26, z: fz0, outline: 0.006 }));
    const flag = mesh(printPlane(0.54, 0.36, BUS_FLAG[0], BUS_FLAG[1]), busMat, { x: fx0 + 0.03, y: GROUND + 2.26, z: fz0, cast: false }); flag.rotation.y = Math.PI / 2; group.add(flag);
  }
  { // the bay: a dashed mustard edge 2.6 m out from the kerb with closed ends — nobody parks here
    const bay = matte(0xd4af6b), z0 = sz0 + 1.78, z1 = z0 + 2.6, xa = px + 13.4, xb = px + 19.6;
    for (let x = xa + 0.35; x < xb - 0.2; x += 1.0) group.add(slabPlane(0.6, 0.1, bay, x, z1, GROUND + 0.008));
    for (const x of [xa, xb]) group.add(slabPlane(0.1, 2.6, bay, x, (z0 + z1) / 2, GROUND + 0.008));
  }
  pool(bx, sz0 - 0.55, 1.7, 0.55);

  // path bollards: knee-high, a warm band of light under the cap, staggered either side of the path
  [[1, 6.3], [-1, 7.2], [1, 8.1], [-1, 9.0], [1, 9.9]].forEach(([side, z]) => {
    const x = px + side * 0.95, b = new THREE.Group(); b.position.set(x, GROUND, z); group.add(b);
    b.add(cyl(0.075, 0.08, 0.48, iron, { y: 0.24, outline: 0.008 }, 12));
    b.add(cyl(0.068, 0.068, 0.07, headMat, { y: 0.515, cast: false }, 12));
    b.add(cyl(0.09, 0.08, 0.06, iron, { y: 0.58, outline: 0.008 }, 12));
    pool(x, z, 0.9, 0.85);
  });

  // monument sign by the entrance, turned to face the street and the camera, clear of the path and the hedge;
  // the face is backlit at night (an emissive print) and a slim halo strip glows where the panel meets the plinth
  const signTex = signTexture();
  const signFace = new THREE.MeshToonMaterial({ map: signTex, gradientMap: gradientMap(), emissive: 0xe8dcc4, emissiveMap: signTex, emissiveIntensity: 0 });
  signFace.color.setScalar(1.3); // reads as a crisp print by day (it faces away from the sun); the backlight takes over at night
  const signX = -hx - 0.95, signZ = hz + 2.7;
  const sign = new THREE.Group(); sign.position.set(signX, GROUND, signZ); sign.rotation.y = Math.PI / 4; group.add(sign);
  sign.add(box(1.9, 0.18, 0.4, stone, { y: 0.09 }));
  sign.add(box(1.74, 0.03, 0.24, headMat, { y: 0.195, cast: false }));
  sign.add(box(1.8, 0.6, 0.22, toon(PAL.paper), { y: 0.51, outline: 0.012 }));
  sign.add(mesh(new THREE.PlaneGeometry(1.66, 0.52), signFace, { y: 0.51, z: 0.112, cast: false }));
  for (const sx of [-0.7, 0.2, 0.75]) { const s = shrub(0.55); s.position.set(sx, 0, 0.42); sign.add(s); }
  pool(signX + 0.45, signZ + 0.45, 1.3, 0.45);

  const bench = new THREE.Group(); bench.position.set(px - 1.25, GROUND, zDoor - 0.4); bench.rotation.y = Math.PI / 2; group.add(bench);
  for (let i = 0; i < 3; i++) bench.add(box(1.3, 0.04, 0.12, oakMid, { y: 0.44, z: -0.14 + i * 0.14, outline: 0.006 }));
  for (let i = 0; i < 2; i++) bench.add(box(1.3, 0.1, 0.035, oakMid, { y: 0.62 + i * 0.13, z: -0.24, outline: 0.006 }));
  for (const sx of [-0.55, 0.55]) { bench.add(box(0.05, 0.44, 0.36, iron, { x: sx, y: 0.22 })); bench.add(box(0.05, 0.36, 0.05, iron, { x: sx, y: 0.62, z: -0.25 })); }

  // ---- staff terrace behind the building, by the fire exit (far enough out that the back wall does not hide it) ----
  const fx = office.fireExit?.door?.x ?? hx - 0.8;
  const tx0 = fx - 5.25, tx1 = fx + 0.6, tz0 = -hz - 3.4, tz1 = -hz - 7.0;     // 5.85 × 3.6 m, left of the door
  // a landing and a step outside the fire door (the floor is a foundation's height above the lawn), then a paved path
  group.add(box(1.4, 0.3, 0.9, stone, { x: fx, y: -0.15, z: -hz - 0.45, cast: false, receive: true }));
  group.add(box(1.4, 0.15, 0.32, stoneDark, { x: fx, y: GROUND + 0.075, z: -hz - 1.06, cast: false, receive: true }));
  pavers(1.2, (-hz - 1.22) - tz0, fx, (tz0 - hz - 1.22) / 2);
  pavers(tx1 - tx0, tz0 - tz1, (tx0 + tx1) / 2, (tz0 + tz1) / 2);
  const picnic = (x, z) => { // a picnic table with its benches on two A-frames
    const t = new THREE.Group(); t.position.set(x, GROUND, z); group.add(t);
    for (let i = 0; i < 3; i++) t.add(box(1.8, 0.05, 0.24, oak, { y: 0.745, z: (i - 1) * 0.255, outline: 0.006 }));
    for (const s of [-1, 1]) t.add(box(1.8, 0.045, 0.26, oak, { y: 0.45, z: s * 0.62, outline: 0.006 }));
    for (const lx of [-0.68, 0.68]) {
      for (const s of [-1, 1]) { const leg = box(0.07, 0.86, 0.08, oakMid, { x: lx, y: 0.38, z: s * 0.2, outline: 0.006 }); leg.rotation.x = -s * 0.5; t.add(leg); }
      t.add(box(0.07, 0.07, 1.5, oakMid, { x: lx, y: 0.4, outline: 0.006 }));     // carries the benches
      t.add(box(0.07, 0.06, 0.7, oakMid, { x: lx, y: 0.69 }));                    // carries the top
    }
    return t;
  };
  const tA = picnic(fx - 3.65, -hz - 4.7);
  picnic(fx - 0.95, -hz - 5.1);
  { // a terracotta parasol through the first table, on a weighted base
    const terra = toon(PAL.terracotta);
    tA.add(cyl(0.2, 0.22, 0.08, iron, { y: 0.04 }, 14));
    tA.add(cyl(0.022, 0.022, 2.3, toon(PAL.metal), { y: 1.15 }, 8));
    tA.add(cyl(0.03, 1.3, 0.36, terra, { y: 2.2, outline: 0.012 }, 8));
    tA.add(cyl(1.3, 1.3, 0.08, terra, { y: 1.98, cast: false }, 8));            // the valance
    tA.add(sphere(0.045, oakDark, { y: 2.41 }, 8));
  }
  const planter = (x0, x1, z) => { // a raised oak planter box with clipped shrubs and a few flowers
    const len = x1 - x0, cx = (x0 + x1) / 2;
    group.add(box(len, 0.5, 0.5, oakMid, { x: cx, y: GROUND + 0.25, z, outline: 0.01, receive: true }));
    group.add(box(len + 0.06, 0.05, 0.56, oakDark, { x: cx, y: GROUND + 0.52, z, cast: false }));
    group.add(box(len - 0.08, 0.02, 0.42, toon(0x6b4b3a), { x: cx, y: GROUND + 0.53, z, cast: false }));
    const n = Math.max(2, Math.round(len / 0.55));
    for (let i = 0; i < n; i++) {
      const s = shrub(0.5 + (i % 2) * 0.12); s.position.set(x0 + 0.3 + (len - 0.6) * i / (n - 1), GROUND + 0.52, z + (i % 2 ? 0.05 : -0.05)); group.add(s);
      group.add(sphere(0.05, toon([PAL.mustard, PAL.blush, PAL.paper][i % 3]), { x: x0 + 0.3 + (len - 0.6) * (i + 0.5) / n, y: GROUND + 0.62, z: z + 0.15, cast: false }, 8));
    }
  };
  planter(fx - 3.75, fx - 1.85, tz1 + 0.3);
  planter(fx - 1.35, fx + 0.45, tz1 + 0.3);
  { // the green assembly point sign on a post, on the lawn at the terrace's corner
    const a = new THREE.Group(); a.position.set(tx1 + 0.55, GROUND, tz0 - 0.5); a.rotation.y = Math.PI / 4; group.add(a);
    a.add(cyl(0.035, 0.035, 1.5, iron, { y: 0.75, outline: 0.006 }, 8));
    a.add(box(0.5, 0.62, 0.03, toon(0x4f9a6a), { y: 1.3, z: 0.03, outline: 0.006 }));
    const am = new THREE.MeshToonMaterial({ map: assemblyTexture(), gradientMap: gradientMap() }); am.color.setScalar(1.25);
    a.add(mesh(new THREE.PlaneGeometry(0.47, 0.59), am, { y: 1.3, z: 0.047, cast: false }));
  }
  { // the terrace lived in: a wall light over the fire door, knee-high bollards along the path and at the terrace's
    // front corners (all lit at night), tall planters against the facade left of the door, a slatted bench on the lawn
    // facing the tables, and a pair of bins (general / recycling) where the path meets the paving
    group.add(box(0.34, 0.1, 0.12, iron, { x: fx, y: 2.36, z: -hz - 0.07, outline: 0.006 }));
    group.add(box(0.28, 0.03, 0.08, headMat, { x: fx, y: 2.3, z: -hz - 0.09, cast: false }));
    pool(fx, -hz - 1.0, 1.3, 0.7);
    for (const [x, z] of [[fx - 0.9, -hz - 2.2], [fx + 0.9, -hz - 2.9], [tx0 + 0.25, tz0 - 0.25], [tx1 - 0.25, tz0 - 0.25]]) {
      const b = new THREE.Group(); b.position.set(x, GROUND, z); group.add(b);
      b.add(cyl(0.075, 0.08, 0.48, iron, { y: 0.24, outline: 0.008 }, 12));
      b.add(cyl(0.068, 0.068, 0.07, headMat, { y: 0.515, cast: false }, 12));
      b.add(cyl(0.09, 0.08, 0.06, iron, { y: 0.58, outline: 0.008 }, 12));
      pool(x, z, 0.9, 0.8);
    }
    for (const [x, sc] of [[fx - 1.25, 0.62], [fx - 2.7, 0.55]]) {   // under the balcony, clear of the apron and the door's landing
      group.add(box(0.55, 0.62, 0.55, toon(PAL.slateDark), { x, y: GROUND + 0.31, z: -hz - 0.45, outline: 0.01 }));
      group.add(box(0.47, 0.02, 0.47, toon(0x6b4b3a), { x, y: GROUND + 0.63, z: -hz - 0.45, cast: false }));
      const s1 = shrub(sc); s1.position.set(x, GROUND + 0.62, -hz - 0.45); group.add(s1);
    }
    const bench = new THREE.Group(); bench.position.set(tx0 - 0.55, GROUND, (tz0 + tz1) / 2); bench.rotation.y = Math.PI / 2; group.add(bench);
    for (let i = 0; i < 3; i++) bench.add(box(1.4, 0.04, 0.12, oakMid, { y: 0.44, z: -0.14 + i * 0.14, outline: 0.006 }));
    for (let i = 0; i < 2; i++) bench.add(box(1.4, 0.1, 0.035, oakMid, { y: 0.62 + i * 0.13, z: -0.24, outline: 0.006 }));
    for (const sx of [-0.6, 0.6]) { bench.add(box(0.05, 0.44, 0.36, iron, { x: sx, y: 0.22 })); bench.add(box(0.05, 0.36, 0.05, iron, { x: sx, y: 0.62, z: -0.25 })); }
    for (const [dx, lid] of [[0, PAL.slate], [0.42, PAL.sage]]) {
      const x = fx - 1.35 + dx, z = tz0 + 0.3;
      group.add(cyl(0.17, 0.15, 0.62, toon(PAL.slateDark), { x, y: GROUND + 0.31, z, outline: 0.008 }, 14));
      group.add(cyl(0.185, 0.185, 0.06, toon(lid), { x, y: GROUND + 0.65, z, outline: 0.006 }, 14));
    }
  }

  // ---- low timber fence along the back and left edges of the site: posts and two rails, with gaps where paths cross ----
  const fence = (x0, z0, x1, z1, gaps = []) => { // gaps: [[t0, t1], …] as fractions along the run
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(len / 2.0), alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const open = t => gaps.some(([a, b]) => t > a && t < b);
    for (let i = 0; i <= n; i++) {
      const t = i / n; if (open(t)) continue;
      group.add(box(0.09, 0.8, 0.09, oakDark, { x: x0 + (x1 - x0) * t, y: GROUND + 0.4, z: z0 + (z1 - z0) * t, outline: 0.008 }));
    }
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n; if (open(i / n) || open((i + 1) / n) || open(t)) continue;
      const cx = x0 + (x1 - x0) * t, cz = z0 + (z1 - z0) * t, sl = len / n;
      for (const y of [0.32, 0.64]) group.add(alongX ? box(sl, 0.08, 0.035, oakMid, { x: cx, y: GROUND + y, z: cz + 0.06, outline: 0.006 })
        : box(0.035, 0.08, sl, oakMid, { x: cx + 0.06, y: GROUND + y, z: cz, outline: 0.006 }));
    }
  };
  const fenceZ = -hz - 8.1, fenceX = -hx - 7.85;   // z -14.5, x -21.9 (inside: the terrace, the garden trees)
  fence(fenceX, fenceZ, hx + 6, fenceZ);
  fence(fenceX, fenceZ, fenceX, sz0 - 0.4);

  // planting: shrubs along the foundation, trees around the site, a flower bed by the porch
  // a continuous clipped hedge along the outer edge of the apron (front and right), as a real site would have
  const hedgeMat = toon(PAL.sageDeep), hedgeTop = toon(PAL.leaf);
  const hedge = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), along = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const w = along ? len : 0.5, d = along ? 0.5 : len, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    group.add(box(w, 0.42, d, hedgeMat, { x: cx, y: GROUND + 0.21, z: cz, outline: 0.012, receive: true }));
    group.add(box(w - 0.04, 0.06, d - 0.04, hedgeTop, { x: cx, y: GROUND + 0.45, z: cz, cast: false }));
  };
  hedge(-hx - 0.2, hz + 1.5, hx + 1.0, hz + 1.5);   // front
  hedge(hx + 1.5, -hz - 0.2, hx + 1.5, hz + 1.75);  // right, meets the front at the corner
  // behind the back wall: trees stand well off the wall (4.5–5.8 m out), spaced along the building with an irregular
  // rhythm of position, depth and size, behind a kerbed shrub bed
  const backRow = [];
  for (let i = 0, n = Math.max(5, Math.round((2 * hx - 4.7) / 4.6) + 1); i < n; i++) {
    const x = -hx + 1.2 + (2 * hx - 4.7) * i / (n - 1) + [0.3, -0.45, 0.55, -0.2, 0.15, -0.5][i % 6];
    backRow.push([x, -hz - [4.5, 5.5, 4.8, 5.8, 4.6, 5.3][i % 6], [1.0, 1.25, 1.05, 1.3, 1.1][i % 5]]);
  }
  { // the shrub bed: a low stone kerb round a strip of bark mulch, mounded shrubs in three sage tones, clipped balls,
    // some shrubs in flower (one accent colour each), in three runs with lawn gaps between. It sits 2.9–3.8 m out:
    // from the fixed camera the 3.4 m wall hides the ground nearer than ~2.7 m, so a bed hard against it would never show.
    const z0 = -hz - 2.9, z1 = -hz - 3.8, zc = (z0 + z1) / 2, d = z0 - z1, mulch = toon(0x6b4b3a);
    const pairs = [[PAL.leaf, PAL.sageDeep], [PAL.sage, PAL.sageDeep], [PAL.leaf, PAL.sage]], blooms = [PAL.mustard, PAL.blush, PAL.terracotta, PAL.paper];
    const bed = (x0, x1, seed) => {
      const len = x1 - x0, cx = (x0 + x1) / 2;
      for (const z of [z0 - 0.05, z1 + 0.05]) group.add(box(len, 0.14, 0.1, stone, { x: cx, y: GROUND + 0.07, z, cast: false, receive: true }));
      for (const x of [x0 + 0.05, x1 - 0.05]) group.add(box(0.1, 0.14, d - 0.2, stone, { x, y: GROUND + 0.07, z: zc, cast: false, receive: true }));
      group.add(box(len - 0.2, 0.08, d - 0.2, mulch, { x: cx, y: GROUND + 0.04, z: zc, cast: false, receive: true }));
      const y = GROUND + 0.08;
      for (let x = x0 + 0.42, i = 0; x < x1 - 0.38; i++) {
        const r = hash(seed, i), s = 0.6 + 0.36 * hash(seed, i + 50), z = zc + (i % 2 ? 0.11 : -0.09) + (hash(seed, i + 90) - 0.5) * 0.08;
        if (r < 0.18) { // a clipped box ball
          const ball = sphere(0.27 * s, toon(i % 3 ? PAL.sageDeep : PAL.sage), { x, y: y + 0.23 * s, z, outline: 0.012 }, 10); ball.scale.y = 0.88; group.add(ball);
        } else {
          const sh = shrub(s, { seg: 10, a: pairs[i % 3][0], b: pairs[i % 3][1] }); sh.position.set(x, y, z); sh.rotation.y = r * 6.3; group.add(sh);
          if (r > 0.6) { // in flower: a scatter of one colour over the camera side of the crown
            const col = toon(blooms[Math.floor(hash(seed, i + 7) * blooms.length)]);
            for (let k = 0; k < 6; k++) {
              const a = Math.PI / 4 + (k - 2.5) * 0.5 + (hash(seed * 3 + i, k) - 0.5) * 0.4, e = 0.25 + 0.75 * hash(i, seed + k), R = 0.29 * s;
              group.add(sphere(0.042 * (0.85 + 0.3 * hash(k, i)), col, { x: x + Math.cos(a) * Math.cos(e) * R, y: y + 0.22 * s + Math.sin(e) * R, z: z + Math.sin(a) * Math.cos(e) * R, cast: false }, 6));
            }
          }
        }
        x += 0.5 * s + 0.2 + 0.22 * hash(seed, i + 30);
      }
    };
    const bx0 = -hx + 0.8, bx1 = tx0 - 0.8, gap = 1.3, L = bx1 - bx0 - 2 * gap;   // stops short of the terrace
    if (L > 6) { const a = bx0 + L * 0.37, b = a + gap + L * 0.3; bed(bx0, a, 1); bed(a + gap, b, 2); bed(b + gap, bx1, 3); }
  }
  const treeSpots = [...backRow.filter(([x]) => x < tx0 - 1.0),                 // keep the terrace out of the canopy's shadow in view
    [tx0 - 1.4, fenceZ + 0.9, 1.15],                                           // a shade tree at the terrace's back corner
    [hx + 3.6, -hz + 1.5, 1.2], [hx + 4.4, hz - 3.5, 1.0], [hx + 3.4, hz + 2.4, 1.15], [px - 3.2, -2.0, 1.25], [px - 2.6, -hz + 0.5, 1.0], [-hx - 2.0, -hz - 1.6, 0.95]];
  const trees = [];
  const SPECIES = ['round', 'conifer', 'hornbeam', 'round', 'birch', 'conifer', 'round', 'hornbeam', 'birch', 'round', 'conifer', 'round', 'birch', 'hornbeam']; // a mixed planting, not a row of clones
  treeSpots.forEach(([x, z, sc], i) => { const t = tree(sc, i, SPECIES[i % SPECIES.length]); t.position.set(x, GROUND, z); t.rotation.y = i * 1.3; t.userData.phase = i * 1.7; t.userData.dynamic = true; freezeStatic(t); group.add(t); trees.push(t); }); // each tree sways as one piece
  // flower bed by the porch, clear of the wider porch slab
  // three shrubs of different sizes and drifts of flowers in one colour each, not a grid of dots
  for (const [dx, dz, sc, ry] of [[-2.72, 1.98, 0.5, 0.4], [-2.16, 2.08, 0.4, 2.2], [-1.98, 1.66, 0.33, 4.1]]) {
    const s = shrub(sc); s.position.set(-hx + dx, GROUND, zDoor + dz); s.rotation.y = ry; group.add(s);
  }
  [[-2.5, 1.6, PAL.blush, 5], [-2.86, 1.72, PAL.mustard, 3], [-2.32, 1.8, PAL.paper, 4], [-1.9, 2.02, PAL.blush, 3]].forEach(([dx, dz, col, n], j) => {
    for (let k = 0; k < n; k++) {
      const a = hash(j, k) * 6.3, r = 0.04 + 0.1 * hash(k, j + 9), rad = 0.05 + 0.025 * hash(j + 4, k);
      group.add(sphere(rad, toon(col), { x: -hx + dx + Math.cos(a) * r, y: GROUND + 0.06 + 0.05 * hash(k + 2, j), z: zDoor + dz + Math.sin(a) * r * 0.8, cast: false }, 8));
    }
  });

  // ---- next door: a quiet one-storey block on the lot west of the site, its lobby door on the pavement (shut: it is
  //      someone else's building, and people only walk past it on their way in). Quieter than the office (greige render,
  //      shaded windows, nothing lit inside), so the office stays what you look at. ----
  const NB = { x0: -hx - 8.55, x1: -hx - 19.0, z0: -hz + 6.0, z1: sz0 - 0.1, g: 3.6, u: 0 };     // x -25.2…-35.65, z -0.4…10.3; one storey, the office's height
  const lobbyX = NB.x0 - 0.95, lobbyW = 1.5, doorH = 2.35;                     // the door: its centre 0.95 m in from the east corner
  {
    const render = toon(0xd3d1cb), renderDark = toon(0xbdbab3), plinthMat = toon(0x9d9a94), trimMat = toon(0xe9e6e0);
    const winMat = toon(0x8d98a3), frameMat = toon(PAL.slateDark);
    const W = NB.x0 - NB.x1, D = NB.z1 - NB.z0, cx = (NB.x0 + NB.x1) / 2, cz = (NB.z0 + NB.z1) / 2, H = NB.g + NB.u, T = 0.25;
    const at = (o, y) => ({ x: o.x, y: GROUND + y, z: o.z, outline: o.outline ?? 0.015, receive: true });
    // walls as slabs: the street wall has the lobby door cut out of it
    const doorL = lobbyX - lobbyW / 2, doorR = lobbyX + lobbyW / 2;
    group.add(box(NB.x0 - doorR, H, T, render, at({ x: (NB.x0 + doorR) / 2, z: NB.z1 - T / 2 }, H / 2)));
    group.add(box(doorL - NB.x1, H, T, render, at({ x: (doorL + NB.x1) / 2, z: NB.z1 - T / 2 }, H / 2)));
    group.add(box(lobbyW, H - doorH, T, render, at({ x: lobbyX, z: NB.z1 - T / 2 }, doorH + (H - doorH) / 2)));
    group.add(box(W, H, T, render, at({ x: cx, z: NB.z0 + T / 2 }, H / 2)));
    for (const x of [NB.x0 - T / 2, NB.x1 + T / 2]) group.add(box(T, H, D, render, at({ x, z: cz }, H / 2)));
    group.add(box(W + 0.2, 0.3, D + 0.2, renderDark, at({ x: cx, z: cz }, H + 0.15)));                   // roof slab
    for (const [w, d, x, z] of [[W + 0.2, 0.18, cx, NB.z1 + 0.01], [W + 0.2, 0.18, cx, NB.z0 - 0.01], [0.18, D + 0.2, NB.x0 + 0.01, cz], [0.18, D + 0.2, NB.x1 - 0.01, cz]])
      group.add(box(w, 0.45, d, trimMat, at({ x, z }, H + 0.5)));                                           // parapet
    group.add(box(W + 0.06, 0.38, D + 0.06, plinthMat, at({ x: cx, z: cz, outline: 0.01 }, 0.19)));       // plinth
    // shaded windows: upper floor along both faces you see, ground floor beside the lobby
    const win = (x, y, z, w, h, alongX) => {
      group.add(box(alongX ? w : 0.06, h, alongX ? 0.06 : w, winMat, { x, y: GROUND + y, z, cast: false, receive: false }));
      group.add(box(alongX ? w + 0.16 : 0.1, 0.08, alongX ? 0.1 : w + 0.16, trimMat, { x: alongX ? x : x + 0.03, y: GROUND + y - h / 2 - 0.06, z: alongX ? z + 0.03 : z, outline: 0.006, receive: false }));
      group.add(box(alongX ? 0.05 : 0.07, h, alongX ? 0.07 : 0.05, frameMat, { x, y: GROUND + y, z, cast: false, receive: false }));
    };
    const zf = NB.z1 + 0.005, xf = NB.x0 + 0.005;
    for (const x of [NB.x1 + 1.6, NB.x1 + 4.4, NB.x1 + 7.2]) win(x, 1.65, zf, 1.7, 1.5, true);
    for (let i = 0; i < 3; i++) win(xf, 1.65, NB.z0 + 2.2 + i * (D - 4.4) / 2, 1.5, 1.5, false);
    // on the roof: two plant boxes, as any low block has
    group.add(box(1.6, 0.8, 1.1, toon(PAL.slateLight), at({ x: cx - 1.8, z: cz - 1.2, outline: 0.01 }, H + 0.7)));
    group.add(box(1.0, 0.6, 1.0, toon(PAL.metal), at({ x: cx + 2.4, z: cz + 0.8, outline: 0.01 }, H + 0.6)));
    // the lobby door: a dark frame, two frosted leaves, a canopy and a lamp
    group.add(box(lobbyW + 0.24, 0.12, 0.2, frameMat, at({ x: lobbyX, z: NB.z1 + 0.02, outline: 0.006 }, doorH + 0.06)));
    for (const sx of [-1, 1]) group.add(box(0.1, doorH, 0.2, frameMat, at({ x: lobbyX + sx * (lobbyW / 2 + 0.07), z: NB.z1 + 0.02, outline: 0.006 }, doorH / 2)));
    group.add(box(lobbyW + 1.0, 0.12, 1.3, renderDark, at({ x: lobbyX, z: NB.z1 + 0.65 }, doorH + 0.45)));  // canopy
    group.add(slabPlane(lobbyW + 0.5, 0.6, matte(0x6b6470), lobbyX, NB.z1 + 0.32, GROUND + 0.02));             // door mat
  }
  const leafMat = toon(0xc3ccd0);
  for (const sx of [-1, 1]) group.add(box(lobbyW / 2, doorH - 0.04, 0.05, leafMat, { x: lobbyX + sx * lobbyW / 4, y: GROUND + doorH / 2, z: NB.z1 - 0.08, outline: 0.006, receive: false }));
  const canopyLamp = toon(0xfff1c9, { emissive: 0xffd88a, emissiveIntensity: 0 });
  group.add(box(0.5, 0.04, 0.24, canopyLamp, { x: lobbyX, y: GROUND + doorH + 0.37, z: NB.z1 + 0.7, cast: false, receive: false }));
  pool(lobbyX, NB.z1 + 0.9, 1.6, 0.55);

  // warm light spilling from each lit back window onto the lawn behind, sheared like the office's sun pools
  const spillLen = 7.0, TURN = { back: 0, west: Math.PI / 2, front: Math.PI, east: -Math.PI / 2 };
  for (const o of office.openings || []) {
    const geo = new THREE.PlaneGeometry(1, spillLen), p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * (p.getY(i) < 0 ? 1.6 : 3.2));   // widens away from the wall
    geo.applyMatrix4(new THREE.Matrix4().makeShear(0.35, 0, 0, 0, 0, 0));                  // slanted ends
    const c = wallPoint(o.wall, office, o.at, 0, -0.45 - spillLen / 2);
    spills.push({ geo, x: c[0], z: c[2], k: 1, turn: TURN[o.wall] });
  }
  const layer = (parts, mat, y) => {
    if (!parts.length) return;
    const geos = parts.map(({ geo, x, z, k, turn = 0 }) => {
      geo.rotateX(-Math.PI / 2); if (turn) geo.rotateY(turn); geo.translate(x, y, z);
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(k), 3));
      return geo;
    });
    const m = new THREE.Mesh(mergeGeometries(geos, false), mat); for (const g of geos) g.dispose();
    m.castShadow = m.receiveShadow = false; m.renderOrder = 2; m.userData.noMerge = true; group.add(m);
  };
  const additive = (map, color, nightOpacity) => {
    const m = new THREE.MeshBasicMaterial({ map, color, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    m.userData.nightOpacity = nightOpacity; return m;
  };
  const poolMat = additive(glowTexture(), 0xffd49a, 0.42), spillMat = additive(spillTexture(), 0xffe2b8, 0.26);
  layer(pools, poolMat, GROUND + 0.02);
  layer(spills, spillMat, GROUND + 0.018);
  const nightPools = [poolMat, spillMat];
  const setNight = k => { for (const m of nightPools) { m.opacity = k * m.userData.nightOpacity; m.visible = k > 0.01; } };
  setNight(0);

  // the walk from the street to the door, and the height of the ground along it: in along the pavement from the west,
  // past next door, up the path. It starts 10.5 m short of the path, just beyond the edge of an ordinary picture (a phone,
  // 1280x800, 1512x860 and 1920x1080 show 0-9.5 m of that pavement): a short walk, so nobody is kept waiting off-screen.
  // A window that shows more starts the walk further along, beyond its own edge, at a brisker pace that keeps to the
  // planned time (Worker.streetEnd); past what a brisk walk can cover (21:9 and wider) they fade in far down the street.
  const westEnd = { x: px - 10.5, z: sz0 + 0.8 };
  const approach = [westEnd, { x: px, z: sz0 + 0.8 }, { x: px, z: zDoor }, { x: -hx - 3.4, z: zDoor }, { x: door.outside.x, z: door.outside.z }];
  const groundY = (x, z) => {
    if (x >= -hx - 3.0 && x <= -hx) return 0;                    // porch
    if (x > -hx - 3.4 && x < -hx - 3.0) return -0.1 - ((-hx - 3.0 - x) / 0.4) * 0.18; // steps
    return GROUND + 0.012;
  };
  let windT = 0;
  const update = dt => { // a gentle, irregular breeze: trees lean a degree or two, never in unison
    windT += dt;
    const gust = 0.6 + 0.4 * Math.sin(windT * 0.23) * Math.sin(windT * 0.11 + 1);
    for (const t of trees) { const p = t.userData.phase; t.rotation.z = Math.sin(windT * 0.9 + p) * 0.018 * gust; t.rotation.x = Math.sin(windT * 0.7 + p * 1.3) * 0.012 * gust; }
  };
  group.userData.batch = freezeStatic(group);
  return {
    group, update, approach, groundY, isOutdoor: (x) => x < -hx,
    lampMats: [headMat, signFace, busMat, canopyLamp], lampPos: lampSpots[0].clone(), lampSpots,
    nightPools, setNight,
  };
}
