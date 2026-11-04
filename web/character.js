// Procedural chibi office worker: big round head, tiny body, toon shading, ink outlines.
import * as THREE from 'three';
import { toon, box, cyl, mesh } from './toon.js';
import { VENDOR, SKIN, HAIR, PANTS, SHOES, GARMENTS, UNDERSHIRT, BROWS, MOUTHS, FRECKLE_CHANCE, HAIR_STYLES, ACCESSORIES, ACC_CHANCE, ACC_COLORS, CLIP_COLORS, FRAMES, hash, pick, rand01, roll, pickW } from './palette.js';
import { freezeStatic } from './merge.js';
import { setMode } from './ghost.js';

// soft contact shadow under every character: a radial falloff disc on the ground, so nobody seems to hover
let contactMat = null;
function contactShadowMaterial() {
  if (contactMat) return contactMat;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(40,32,50,0.55)'); grad.addColorStop(0.55, 'rgba(40,32,50,0.28)'); grad.addColorStop(1, 'rgba(40,32,50,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  contactMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  return contactMat;
}
const contactGeo = new THREE.PlaneGeometry(0.72, 0.72);
const silhouetteMats = new Map();
function silhouetteMaterial(hex) {
  if (!silhouetteMats.has(hex)) {
    const c = new THREE.Color(hex).lerp(new THREE.Color(0xffffff), 0.45);
    silhouetteMats.set(hex, new THREE.MeshBasicMaterial({ color: c, depthFunc: THREE.GreaterDepth, depthWrite: false }));
  }
  return silhouetteMats.get(hex);
}
const silHead = new THREE.SphereGeometry(0.34, 16, 12), silBody = new THREE.CapsuleGeometry(0.2, 0.32, 4, 10);
const steamGeo = new THREE.SphereGeometry(0.025, 8, 6);
const SHARED_GEOS = new Set([contactGeo, silHead, silBody, steamGeo]); // module-level: never disposed with a person
// Every body, hair and accessory part is built from a cached geometry keyed by its shape, never one per person: the
// rigid-part batching below bakes each person's parts into a few merged meshes, and the parts it leaves unmerged
// (torso, face, single pieces) reference these shared geometries directly.
const GEO = new Map();
function geo(key, make) { let g = GEO.get(key); if (!g) { g = make(); GEO.set(key, g); SHARED_GEOS.add(g); } return g; }
const gSphere = (r, w = 16, h = 12) => geo(`sp|${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h));
const gDome = (r, frac, w = 28, h = 12) => geo(`dm|${r}|${frac}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, Math.PI * frac));
const gTorus = (r, tube, rs, ts, arc = Math.PI * 2) => geo(`to|${r}|${tube}|${rs}|${ts}|${arc}`, () => new THREE.TorusGeometry(r, tube, rs, ts, arc));
const gCyl = (rt, rb, h, seg = 24) => geo(`cy|${rt}|${rb}|${h}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
const gBox = (w, h, d) => geo(`bx|${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d));
// same signatures (and segment counts) as the toon.js helpers, on cached geometry
const sp = (r, mat, o, seg = 24) => mesh(gSphere(r, seg, Math.floor(seg * 0.75)), mat, o);
const cap = (r, len, mat, o) => mesh(geo(`ca|${r}|${len}`, () => new THREE.CapsuleGeometry(r, len, 6, 16)), mat, o);
const cy = (rt, rb, h, mat, o, seg = 24) => mesh(gCyl(rt, rb, h, seg), mat, o);
const bx = (w, h, d, mat, o) => mesh(gBox(w, h, d), mat, o);
// A patch of the torso's own surface (the 0.215 capsule centred 0.5 up the rig, half-length 0.1), lifted `off` above
// it, from y0 to y1 (rig heights); `half(v)` gives its [left, right] angle around the body at height fraction v
// (0 = straight ahead, +x = the wearer's left). Garment panels, plackets, V-necks and ribbed hems hug the body this way;
// a mesh wearing one sits at y 0.5 with the torso's own scale, so it widens with the build.
function gWrap(key, y0, y1, off, half, nu = 12, nv = 8) {
  return geo(`wr|${key}|${y0}|${y1}|${off}`, () => {
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= nv; j++) {
      const v = j / nv, y = y0 + (y1 - y0) * v, dy = Math.max(0, Math.abs(y - 0.5) - 0.1);
      const r = Math.sqrt(Math.max(0, 0.215 * 0.215 - dy * dy)) + off, [a0, a1] = half(v);
      for (let i = 0; i <= nu; i++) { const a = a0 + (a1 - a0) * i / nu; pos.push(r * Math.sin(a), y - 0.5, r * Math.cos(a)); uv.push(i / nu, v); }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { // counter-clockwise seen from outside
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  });
}
const AROUND = () => [-Math.PI, Math.PI];
const shade = (hex, k) => new THREE.Color(hex).multiplyScalar(k).getHex();
const tint = (hex, k) => new THREE.Color(hex).lerp(new THREE.Color(0xffffff), k).getHex();
const ease = (dt, k) => 1 - Math.exp(-dt * k);
const wrapAngle = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// anims in which a standing person shifts their weight from foot to foot
const WEIGHT_SHIFT = new Set(['idle', 'wait', 'inspect', 'host', 'listen', 'gaze', 'phone', 'chat']);

// Head-worn accessories only go with hairstyles they sit on cleanly (no hat over a bun, no headband through a puff);
// neck pieces only on plain members (the lead's tie and lanyard, the helper's hood, the reviewer's lapels stay clear).
const FITS = {
  beanie: new Set(['short', 'sidepart', 'bob', 'long', 'twin']),
  cap: new Set(['short', 'sidepart', 'bob', 'long', 'twin', 'ponytail']),
  headphones: new Set(['short', 'sidepart', 'bob', 'long', 'ponytail']),
};
const NECK = new Set(['scarf', 'neckphones']);
// fringe per hairstyle: a full row of bangs, curtain bangs parted in the middle, a side-swept swoop, or none
const FRINGE = { short: 'full', sidepart: 'swoop', bob: 'full', long: 'curtain', ponytail: 'curtain', bun: 'curtain', twin: 'full', curly: 'full' };
const REVIEWER_STYLES = [['short', 3], ['sidepart', 3], ['bun', 2], ['bob', 2]];
const ACC_TINTED = new Set(['cap', 'beanie', 'headphones', 'neckphones']);

export function lookFor(agent) {
  const h = hash(agent.id);
  const role = agent.role || (agent.kind === 'guardian' ? 'reviewer' : agent.kind === 'subagent' ? 'helper' : 'member');
  const vendorKey = VENDOR[agent.vendor] ? agent.vendor : 'other';
  const v = VENDOR[vendorKey];
  const depth = agent.depth || (role === 'helper' ? 1 : 0);
  const traits = { coffee: rand01(h, 11), fidget: rand01(h, 12), sleepy: rand01(h, 13), cheer: rand01(h, 14), social: rand01(h, 15), plants: rand01(h, 16), tidy: rand01(h, 17) };
  // every pick below draws from its own mixed hash (roll / pickW), so hairstyle, colours and accessory vary independently
  const hairStyle = pickW(role === 'reviewer' ? REVIEWER_STYLES : HAIR_STYLES, h, 3);
  let accessory = 'none';
  if (role === 'reviewer') accessory = 'glasses'; // part of the reviewer's outfit
  else if (roll(h, 20) < ACC_CHANCE) accessory = pickW(ACCESSORIES.filter(([k]) => !(NECK.has(k) && role !== 'member') && (!FITS[k] || FITS[k].has(hairStyle))), h, 21);
  // hats and headphones now and then in the vendor's own colour (it is on a person); otherwise a soft wearable colour
  const accColor = accessory === 'clip' ? CLIP_COLORS[Math.floor(roll(h, 23) * CLIP_COLORS.length)]
    : ACC_TINTED.has(accessory) && roll(h, 24) < 0.25 ? v.accent : ACC_COLORS[Math.floor(roll(h, 25) * ACC_COLORS.length)];
  const roleScale = role === 'reviewer' ? 0.9 : role === 'helper' ? (depth >= 2 ? 0.76 : 0.84) : role === 'lead' ? 1.04 : 1;
  const height = 0.95 + (roll(h, 30) + roll(h, 31)) * 0.05; // ±5 %, most people near the middle
  return {
    vendorKey, role, accent: v.accent,
    skin: SKIN[Math.floor(roll(h, 1) * SKIN.length)],
    hair: pickW(HAIR, h, 2),
    hairStyle,
    side: roll(h, 26) < 0.5 ? -1 : 1, // the side of the parting; a hair clip goes on the other side
    shirt: role === 'reviewer' ? 0x4a5478 : role === 'helper' ? pick(v.helperShirts || v.shirts, h, 4) : pick(v.shirts, h, 4),
    pants: role === 'reviewer' ? 0x3d3a46 : pickW(PANTS, h, 5),
    shoes: pickW(SHOES, h, 40),
    garment: role === 'member' ? pickW(GARMENTS, h, 41) : role, // leads, helpers and reviewers wear their role outfit
    under: UNDERSHIRT[Math.floor(roll(h, 42) * UNDERSHIRT.length)],
    stripes: roll(h, 43) < 0.4, // a striped tee
    brow: pickW(BROWS, h, 44), mouth: pickW(MOUTHS, h, 45), freckles: roll(h, 46) < FRECKLE_CHANCE,
    accessory, accColor,
    frame: role === 'reviewer' ? 0x3a3340 : pickW(FRAMES, h, 27),
    variant: roll(h, 28), // a cap worn backwards, a beanie's pompom, flower / bow / clip
    eye: pick([0x5a3a2a, 0x3b6ea5, 0x3f8a5a, 0x7a5cc4, 0x2f4858, 0xb5673a, 0x4a3328, 0x2b6f7a], h, 7),
    height, width: 0.94 + (roll(h, 32) + roll(h, 33)) * 0.07, // shoulders: slim to sturdy
    roleScale, scale: roleScale * height,
    seed: rand01(h, 9), traits,
  };
}

// Brow shapes (all centred, so the raise / knit animation moves them the same way) and mouths at rest. A beaming
// person (smile(), a cheer) swaps the resting mouth for the big smile: same mesh and material, a cached geometry swap.
const BROW_GEO = {
  straight: () => gBox(0.1, 0.022, 0.02),
  arched: () => geo('browArch', () => { const g = new THREE.TorusGeometry(0.058, 0.011, 6, 12, 1.7); g.rotateZ(Math.PI / 2 - 0.85); g.translate(0, -0.048, 0); return g; }),
  soft: () => geo('browSoft', () => { const g = new THREE.CapsuleGeometry(0.016, 0.055, 4, 8); g.rotateZ(Math.PI / 2); g.scale(1, 1, 0.6); return g; }),
};
const MOUTH = {
  smile: { geo: () => gTorus(0.036, 0.011, 8, 14, Math.PI), y: -0.145, rz: Math.PI, s: [1, 1, 1] },
  dot: { geo: () => gSphere(0.018, 10, 8), y: -0.165, rz: 0, s: [1.15, 0.85, 0.5] },
  o: { geo: () => gTorus(0.017, 0.008, 6, 14), y: -0.165, rz: 0, s: [0.9, 1.1, 1] },
  beam: { geo: () => gTorus(0.045, 0.011, 8, 14, Math.PI), y: -0.14, rz: Math.PI, s: [1, 1, 1] },
};
function setMouth(m, shape) { const d = MOUTH[shape] || MOUTH.smile; m.geometry = d.geo(); m.position.y = d.y; m.rotation.z = d.rz; m.scale.set(...d.s); }
// freckles: a little cluster on each cheek under the eye, inside the blush (head-local, mirrored per side)
const FRECKLES = [[0.104, -0.13], [0.13, -0.124], [0.156, -0.131], [0.124, -0.148]];

function pivot(x, y, z) { const g = new THREE.Group(); g.position.set(x, y, z); return g; }

const SHARED = { // face materials every character uses: one instance each, so faces batch across people
  sclera: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  pupil: new THREE.MeshBasicMaterial({ color: 0x1b1520 }),
  blush: new THREE.MeshBasicMaterial({ color: 0xf59cb0, transparent: true, opacity: 0.6 }),
};
const PAL_BOOK = [0xcf8466, 0x9db892, 0x7a8599]; // terracotta, sage, slate: environment accents for props

export class Chibi {
  constructor(look) {
    this.look = look;
    this.group = new THREE.Group();
    this.rig = new THREE.Group();
    this.group.add(this.rig);
    // build: the group scale carries height (feet stay on the floor); width widens the torso and shoulders only, so the
    // tie, badge and lapels on the chest stay put. update() keeps a seated person's hips at the same seat height.
    this.group.scale.setScalar(look.scale);
    this.bw = look.width || 1; this.hk = look.height || 1;

    const skin = toon(look.skin), shirt = toon(look.shirt), pants = toon(look.pants), hair = toon(look.hair);
    const shoeMat = toon(look.shoes ?? 0x4a3a3f);
    // the garment sets the sleeves and the collar ring: the vendor accent on a tee (and on every role outfit), ribbing
    // on a sweater, the light shirt under a cardigan or a vest, the shirt's own colour on a rolled-sleeve shirt
    const form = look.garment || look.role;
    const cut = form === 'tee' ? 'short' : form === 'rolled' ? 'rolled' : 'long';
    const sleeve = form === 'vest' ? toon(look.under) : shirt;
    const cuff = form === 'sweater' || form === 'cardigan' ? shade(look.shirt, 0.86) : form === 'vest' ? shade(look.under, 0.9) : null;
    const collarCol = form === 'sweater' ? shade(look.shirt, 0.86) : form === 'cardigan' || form === 'vest' ? look.under
      : form === 'rolled' ? shade(look.shirt, 0.93) : look.accent;

    // legs
    this.legL = pivot(-0.09, 0.32, 0); this.legR = pivot(0.09, 0.32, 0);
    for (const leg of [this.legL, this.legR]) {
      leg.add(cap(0.075, 0.15, pants, { y: -0.12, outline: true }));
      const shoe = sp(0.1, shoeMat, { y: -0.26, z: 0.035, outline: true }, 18);
      shoe.scale.set(0.95, 0.65, 1.3);
      leg.add(shoe);
      this.rig.add(leg);
    }
    // body
    this.torso = cap(0.215, 0.2, shirt, { y: 0.5, outline: true });
    this.torso.scale.set(this.bw, 1, 0.92);
    this.rig.add(this.torso);
    // collar / accent stripe
    const collar = cy(0.17, 0.2, 0.06, toon(collarCol), { y: 0.69 }, 20);
    collar.scale.x = this.bw;
    this.rig.add(collar);
    this.buildOutfit(skin, shirt);
    // arms (the shoulders follow the torso width)
    const ax = 0.255 + (this.bw - 1) * 0.2;
    this.armL = pivot(-ax, 0.64, 0); this.armR = pivot(ax, 0.64, 0);
    for (const arm of [this.armL, this.armR]) {
      if (cut === 'long') {
        arm.add(cap(0.065, 0.19, sleeve, { y: -0.13, outline: true }));
        if (cuff !== null) arm.add(cy(0.071, 0.071, 0.04, toon(cuff), { y: -0.225, outline: true }, 16));
      } else { // a bare forearm under a short sleeve, or under a sleeve rolled to the elbow
        arm.add(cap(0.05, 0.16, skin, { y: -0.17, outline: true }));
        if (cut === 'short') arm.add(cap(0.072, 0.05, sleeve, { y: -0.055, outline: true }));
        else {
          arm.add(cap(0.067, 0.07, sleeve, { y: -0.065, outline: true }));
          const rolled = mesh(gTorus(0.058, 0.02, 8, 18), toon(tint(look.shirt, 0.22)), { y: -0.155, outline: true }); rolled.rotation.x = Math.PI / 2; arm.add(rolled);
        }
      }
      arm.add(sp(0.078, skin, { y: -0.29, outline: true }, 18)); // every part an opaque toon with the 0.016 ink: still one bake + one hull
      this.rig.add(arm);
    }
    this.handR = pivot(0, -0.3, 0.02); this.armR.add(this.handR);
    this.handL = pivot(0, -0.3, 0.02); this.armL.add(this.handL);

    // head
    this.head = pivot(0, 1.0, 0);
    const headMesh = sp(0.36, skin, { outline: 0.02 }, 32);
    headMesh.scale.set(1, 0.94, 0.96);
    this.head.add(headMesh);
    this.face = new THREE.Group(); this.head.add(this.face);
    const irisMat = toon(look.eye);
    const scleraMat = SHARED.sclera, pupilMat = SHARED.pupil; // shared by everyone, so they batch
    const hlMat = scleraMat; // same white: the highlights merge with the sclera
    const browMat = toon(this.look.hair);
    this.eyes = []; this.brows = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Group(); eye.position.set(side * 0.135, -0.01, 0.31);
      eye.rotation.y = side * 0.35; // wrap the eye around the head curve
      const sclera = mesh(gSphere(0.075, 20, 14), scleraMat, { cast: false }); sclera.scale.set(0.9, 1.35, 0.5); eye.add(sclera);
      const iris = mesh(gSphere(0.052, 18, 14), irisMat, { y: -0.01, z: 0.03, cast: false }); iris.scale.set(0.95, 1.3, 0.5); eye.add(iris);
      const pupil = mesh(gSphere(0.028, 12, 10), pupilMat, { y: -0.012, z: 0.052, cast: false }); pupil.scale.set(0.9, 1.3, 0.5); eye.add(pupil);
      const hl1 = mesh(gSphere(0.02, 10, 8), hlMat, { x: -side * 0.022, y: 0.03, z: 0.062, cast: false }); eye.add(hl1);
      const hl2 = mesh(gSphere(0.01, 8, 6), hlMat, { x: side * 0.02, y: -0.035, z: 0.062, cast: false }); eye.add(hl2);
      const lid = mesh(gDome(0.08, 0.45, 16, 10), toon(look.skin), { y: 0.0, cast: false }); lid.scale.set(0.95, 1.35, 0.55); lid.visible = false; eye.add(lid);
      eye.userData.lid = lid;
      this.face.add(eye); this.eyes.push(eye);
      const brow = mesh((BROW_GEO[look.brow] || BROW_GEO.straight)(), browMat, { x: side * 0.135, y: 0.12, z: 0.33, cast: false });
      brow.rotation.y = side * 0.35; brow.rotation.z = -side * 0.1; brow.userData.side = side;
      this.face.add(brow); this.brows.push(brow);
      const blush = mesh(geo('blush', () => new THREE.CircleGeometry(0.06, 16)), SHARED.blush,
        { x: side * 0.225, y: -0.12, z: 0.28, cast: false });
      blush.lookAt(side * 0.6, -0.2, 1.2); blush.position.add(new THREE.Vector3(side * 0.01, 0, 0.01));
      this.face.add(blush);
    }
    this.mouth = mesh(gTorus(0.045, 0.011, 8, 14, Math.PI), toon(0xb5566b), { z: 0.345, cast: false });
    this.mouthRest = MOUTH[look.mouth] ? look.mouth : 'smile'; this.beaming = false;
    setMouth(this.mouth, this.mouthRest);
    this.face.add(this.mouth);
    if (look.freckles) { // on the head, not the face group: opaque toon dots that bake into the head's batch (no draw call)
      const fm = toon(shade(look.skin, 0.6));
      for (const side of [-1, 1]) for (const [x, y] of FRECKLES) {
        const z = 0.96 * 0.36 * Math.sqrt(1 - (x / 0.36) ** 2 - (y / (0.94 * 0.36)) ** 2);
        const f = mesh(gSphere(0.014, 8, 6), fm, { x: side * x, y, z }); f.scale.set(1, 1, 0.6); this.head.add(f);
      }
    }
    this.mouthOpen = mesh(gSphere(0.03, 12, 8), pupilMat, { y: -0.16, z: 0.345, cast: false }); this.mouthOpen.scale.set(1, 0.8, 0.4); this.mouthOpen.visible = false;
    this.face.add(this.mouthOpen);

    this.buildHair(hair);
    this.buildAccessory();
    this.rig.add(this.head);
    this.contact = new THREE.Mesh(contactGeo, contactShadowMaterial());
    this.contact.rotation.x = -Math.PI / 2; this.contact.position.y = 0.015; this.contact.renderOrder = 1;
    this.group.add(this.contact); // on the group, not the rig: it stays on the ground while the body bobs or sits
    // draw order: scenery (0) → silhouette (1, only where scenery is in front) → character outlines (2) → character (3);
    // where the character is visible it simply paints over its own silhouette
    this.rig.traverse(o => { if (o.isMesh) o.renderOrder = o.material?.isShaderMaterial ? 2 : 3; });
    const sm = silhouetteMaterial(VENDOR[look.vendorKey]?.accent ?? 0x9aa0b0);
    this.silhouette = new THREE.Group(); this.silhouette.visible = false;
    for (const [geo, y] of [[silHead, 1.0], [silBody, 0.48]]) { const m = new THREE.Mesh(geo, sm); m.position.y = y; m.renderOrder = 1; m.userData.noMode = true; this.silhouette.add(m); }
    this.group.add(this.silhouette);

    this.rig.traverse(o => { if (o.isMesh) o.castShadow = o.castShadow !== false && !(o.material?.transparent); });
    // batch each rigid body part (limbs, head shell, body extras); moving parts stay separate. Hair and head-worn
    // accessories are opaque toon parts with the head's own ink thicknesses (0.02 / 0.016), so whatever the hairstyle
    // or accessory the head stays three draws (baked colour + two ink hulls); neck pieces join the rig's baked mesh.
    for (const p of [this.legL, this.legR, this.armL, this.armR, this.head, this.torso, this.face]) p.userData.dynamic = true;
    for (const p of [this.rig, this.head, this.legL, this.legR, this.armL, this.armR]) freezeStatic(p);
    for (const e of this.eyes) { e.userData.lid.userData.dynamic = true; freezeStatic(e); } // an eye blinks as one piece

    this.props = {};      // props currently held (agents.js reads the keys)
    this.propCache = {};  // every prop is built once per person and re-attached on demand
    this.ownMats = [];    // per-person materials (not from the shared toon cache) to dispose with the person
    this.anim = 'idle'; this.pose = 'stand'; this.seatY = 0.42;
    this.t = look.seed * 10; this.blinkT = 2 + look.seed * 3; this.blinking = 0; this.eyesClosed = false;
    this.lookTarget = 0; this.lookCur = 0; this.lookT = 2 + look.seed * 2;
    this.steam = [];

    // ---- pose blending state: each frame an anim writes TARGET rotations (t*); the joints ease toward them (c*);
    // fast cycles (typing, strides, nods, waves) are ADDED after easing (a* raw → d* lightly smoothed)
    const V = () => new THREE.Vector3();
    this.tH = V(); this.tTO = V(); this.tAL = V(); this.tAR = V(); this.tLL = V(); this.tLR = V();
    this.joints = [ // [object, target, current, additive, additive (smoothed), ease rate]
      [this.head, this.tH, V(), V(), V(), 6], [this.torso, this.tTO, V(), V(), V(), 6],
      [this.armL, this.tAL, V(), V(), V(), 12], [this.armR, this.tAR, V(), V(), V(), 12],
      [this.legL, this.tLL, V(), V(), V(), 12], [this.legR, this.tLR, V(), V(), V(), 12],
    ];
    this.aH = this.joints[0][3]; this.aTO = this.joints[1][3]; this.aAL = this.joints[2][3]; this.aAR = this.joints[3][3]; this.aLL = this.joints[4][3]; this.aLR = this.joints[5][3];
    this.ch = { rigX: 0, faceY: 0, liftL: 0, liftR: 0, browRaise: 0, browAngry: 0, seatY: 0.42 }; // eased scalars
    this.tg = { rigX: 0, faceY: 0, liftL: 0, liftR: 0 };
    this.add = { rigY: 0, twist: 0 }; this.addCur = { rigY: 0, twist: 0 };
    this.seatLin = 0; this.snap = true; // the first update places the pose directly
    this.walkPhase = 0; this.walkFedT = 1; this.walkAmp = 0;
    this.lastYaw = null; this.yawRate = 0; this.turnAmt = 0; this.turnPhase = 0;
    const tr = look.traits || {};
    this.typeRate = 11 + (tr.fidget ?? 0.5) * 4; this.typePhase = look.seed * 20; this.typing = true; this.typeT = 2; this.typeMouse = false;
    this.hostT = 2 + look.seed * 3; this.hostGlance = 0; this.hostBeckon = false; this.hostSide = look.seed > 0.5 ? 1 : -1;
    this.mouthBig = false;
  }

  /** 0 = standing, 1 = seated; eases over ~0.35 s after setPose */
  get seatedness() { const s = this.seatLin; return s * s * (3 - 2 * s); }

  buildOutfit(skin, shirt) {
    const { role, accent } = this.look;
    const bw = this.bw;
    if (role === 'lead') {
      // tie + lanyard badge: the one who signs things off
      const tie = bx(0.07, 0.22, 0.03, toon(accent), { y: 0.56, z: 0.2, outline: 0.008 }); tie.rotation.x = -0.15; this.rig.add(tie);
      this.rig.add(bx(0.1, 0.05, 0.03, toon(accent), { y: 0.675, z: 0.185 }));
      const badge = bx(0.1, 0.13, 0.015, toon(0xfffdf7), { x: -0.12, y: 0.5, z: 0.21, outline: 0.006 }); badge.rotation.x = -0.15; this.rig.add(badge);
      this.rig.add(bx(0.08, 0.03, 0.016, toon(accent), { x: -0.12, y: 0.54, z: 0.215, cast: false }));
      this.rig.add(bx(0.012, 0.14, 0.012, toon(0x3a3340), { x: -0.12, y: 0.63, z: 0.2, cast: false }));
    } else if (role === 'helper') {
      // hoodie: hood bump behind the neck, drawstrings in front
      const hood = sp(0.16, shirt, { y: 0.7, z: -0.14, outline: 0.012 }, 16); hood.scale.set(1.2 * bw, 0.7, 0.9); this.rig.add(hood);
      for (const s of [-1, 1]) this.rig.add(cy(0.012, 0.012, 0.16, toon(0xfffdf7), { x: s * 0.07, y: 0.58, z: 0.21 }, 6));
      const pocket = bx(0.3, 0.1, 0.02, toon(this.look.shirt), { y: 0.42, z: 0.2, cast: false }); pocket.scale.x = bw; this.rig.add(pocket); // kangaroo pocket seam
    } else if (role === 'reviewer') {
      // blazer lapels + a small tie, very proper
      for (const s of [-1, 1]) { const lapel = bx(0.09, 0.24, 0.02, toon(0xf4f1ff), { x: s * 0.07, y: 0.58, z: 0.205, outline: 0.006 }); lapel.rotation.z = -s * 0.35; this.rig.add(lapel); }
      const tie = bx(0.05, 0.18, 0.02, toon(0x9b7bd6), { y: 0.55, z: 0.215 }); this.rig.add(tie);
      this.rig.add(bx(0.12, 0.02, 0.02, toon(0xf4f1ff), { y: 0.675, z: 0.2, cast: false }));
    } else this.buildGarment();
  }

  // A plain member's top, in the vendor colour (the torso and, but for the vest, the sleeves). The details are rigid
  // parts of the rig: opaque toons that bake into the rig's one merged mesh with the collar ring, so a tee, sweater or
  // cardigan costs no draw call; the collar tabs of a vest or a shirt carry the scarf's 0.012 ink, one more hull (shared
  // with a scarf when they wear one). Patches hug the torso (gWrap) and take its build width.
  buildGarment() {
    const L = this.look, bw = this.bw, rig = this.rig;
    const body = (g, mat) => { const m = mesh(g, mat, { y: 0.5 }); m.scale.set(bw, 1, 0.92); rig.add(m); return m; };
    const onBody = (a, y, off) => { // a point on the torso surface: angle a round the body (0 = front), height y
      const dy = Math.max(0, Math.abs(y - 0.5) - 0.1), r = Math.sqrt(0.215 * 0.215 - dy * dy) + off;
      return { x: r * Math.sin(a) * bw, y, z: r * Math.cos(a) * 0.92 };
    };
    const dark = toon(shade(L.shirt, 0.86)), under = toon(L.under);
    const tabs = mat => { // collar tabs either side of the neck, pointing down to the middle
      for (const sd of [-1, 1]) { const c = bx(0.082, 0.048, 0.018, mat, { x: sd * 0.052, y: 0.652, z: 0.19, outline: 0.012 }); c.rotation.set(-0.45, sd * 0.2, sd * 0.55); rig.add(c); }
    };
    switch (L.garment) {
      case 'tee': // a plain tee, or a breton with two light stripes across the chest
        if (L.stripes) for (const y of [0.43, 0.51]) body(gWrap(`stripe${y}`, y, y + 0.035, 0.003, AROUND, 28, 1), under);
        break;
      case 'sweater': // ribbed crew neck (the collar ring), ribbed hem and cuffs
        body(gWrap('hem', 0.3, 0.36, 0.006, AROUND, 28, 2), dark);
        break;
      case 'cardigan': { // worn open over a light tee: the tee down the middle, darker front edges, a ribbed hem
        body(gWrap('cardiTee', 0.29, 0.665, 0.004, () => [-0.42, 0.42], 8, 8), under);
        for (const sd of [-1, 1]) body(gWrap(`cardiEdge${sd}`, 0.29, 0.665, 0.008, () => (sd < 0 ? [-0.5, -0.36] : [0.36, 0.5]), 2, 8), dark);
        body(gWrap('cardiHem', 0.3, 0.35, 0.007, () => [0.5, Math.PI * 2 - 0.5], 24, 2), dark);
        for (const y of [0.56, 0.46]) rig.add(sp(0.015, under, onBody(-0.43, y, 0.011), 8));
        break;
      }
      case 'vest': // a sweater vest over a light collared shirt: ribbed V-neck, the shirt in the V, ribbed hem
        body(gWrap('vestRib', 0.49, 0.67, 0.004, v => [-0.04 - 0.62 * v, 0.04 + 0.62 * v], 6, 6), dark);
        body(gWrap('vestV', 0.52, 0.67, 0.007, v => [-0.01 - 0.5 * v, 0.01 + 0.5 * v], 6, 6), under);
        body(gWrap('hem', 0.3, 0.36, 0.006, AROUND, 28, 2), dark);
        tabs(under);
        break;
      case 'rolled': { // a button-up with the sleeves rolled: placket, buttons, a breast pocket, collar tabs
        body(gWrap('placket', 0.29, 0.665, 0.004, () => [-0.06, 0.06], 2, 8), dark);
        const btn = toon(tint(L.shirt, 0.7));
        for (const y of [0.58, 0.49, 0.4]) rig.add(sp(0.0125, btn, onBody(0, y, 0.008), 8));
        body(gWrap('pocket', 0.49, 0.58, 0.004, () => [0.3, 0.56], 3, 2), dark);
        tabs(toon(tint(L.shirt, 0.3)));
        break;
      }
      default: break;
    }
  }

  // Ten hairstyles, each a hair cap (or a puff) plus a fringe and a few cached shapes, all outlined in the head's two
  // ink weights. Head-local frame: the skull is a 0.36 sphere at the origin, the face looks down +z.
  buildHair(mat) {
    const { hairStyle: style, side: s } = this.look, head = this.head;
    const add = (m, sx = 1, sy = 1, sz = 1) => { m.scale.set(sx, sy, sz); head.add(m); return m; };
    const acc = toon(this.look.accent);
    if (style !== 'afro') { const c = add(mesh(gDome(0.385, 0.6, 30, 20), mat, { y: 0.02, outline: 0.02 }), 1, 0.95, 1); c.rotation.x = -0.42; }
    // under a hat the fringe sits a touch lower and further in, so it peeks out below the brim instead of through it
    const hat = this.look.accessory === 'beanie' || this.look.accessory === 'cap', dy = hat ? -0.025 : 0, dz = hat ? 0.97 : 1;
    const puff = (r, a, y, z0 = 0.28) => sp(r, mat, { x: Math.sin(a) * 0.3 * dz, y: y + dy, z: Math.cos(a) * z0 * dz, outline: 0.016 }, 14);
    switch (FRINGE[style]) {
      case 'full': // a row of flattened puffs along the hairline
        for (let i = 0; i < 5; i++) { const a = (i / 4 - 0.5) * 1.5; add(puff(0.1 + (i % 2) * 0.02, a, 0.2 - Math.abs(a) * 0.06), 1, 0.75, 0.8); }
        break;
      case 'curtain': // parted in the middle, falling away to the temples
        for (const sd of [-1, 1]) for (let i = 0; i < 2; i++) {
          const p = add(puff(0.11 + i * 0.015, sd * (0.32 + i * 0.42), 0.23 - i * 0.075), 1.05, 0.72, 0.8);
          p.rotation.z = -sd * (0.35 + i * 0.2);
        }
        break;
      case 'swoop': // side-swept from the parting, lower on the far side, a tuft at the part
        for (let i = 0; i < 4; i++) {
          const p = add(puff((0.125 - i * 0.008) * (hat ? 0.8 : 1), s * (0.62 - i * 0.42), 0.25 - i * 0.04 - (hat ? 0.04 : 0)), 1.2, 0.68, 0.8);
          p.rotation.z = s * 0.38;
        }
        if (!hat) add(puff(0.085, s * 0.95, 0.31, 0.24), 1, 0.8, 1);
        break;
      default: break;
    }
    switch (style) {
      case 'bob': // chin-length: side panels and a rounded back
        for (const sd of [-1, 1]) add(sp(0.15, mat, { x: sd * 0.3, y: -0.08, z: 0.02, outline: 0.016 }), 0.55, 1.5, 1);
        add(sp(0.3, mat, { y: -0.04, z: -0.12, outline: 0.016 }, 20), 1.2, 0.85, 1);
        break;
      case 'spiky':
        for (let i = 0; i < 5; i++) {
          const c = mesh(geo('spike', () => new THREE.ConeGeometry(0.1, 0.26, 10)), mat, { x: Math.sin(i * 1.3) * 0.18, y: 0.36, z: Math.cos(i * 1.3) * 0.16, outline: 0.016 });
          c.rotation.set(Math.cos(i) * 0.6, 0, Math.sin(i * 2) * 0.6); head.add(c);
        }
        break;
      case 'bun': { // a top knot on the crown with a pin through it
        add(sp(0.15, mat, { y: 0.42, z: -0.08, outline: 0.016 }, 18), 1, 0.92, 1);
        add(sp(0.09, mat, { y: 0.34, z: -0.1, outline: 0.016 }, 14), 1.3, 0.7, 1.3); // where it gathers
        const pin = cy(0.02, 0.02, 0.38, acc, { y: 0.45, z: -0.08 }, 8); pin.rotation.set(0, 0.6, Math.PI / 2 - 0.3); head.add(pin);
        break;
      }
      case 'ponytail': { // high at the back, flicking out then hanging down: it shows past the head from the front
        add(sp(0.11, mat, { y: 0.31, z: -0.29, outline: 0.016 }, 14), 1, 0.9, 0.9); // the gather peeks over the crown head-on
        const tie = cy(0.07, 0.07, 0.05, acc, { y: 0.29, z: -0.38 }, 14); tie.rotation.x = 1.15; head.add(tie);
        const up = cap(0.1, 0.15, mat, { y: 0.22, z: -0.48, outline: 0.016 }); up.rotation.x = 0.85; head.add(up);
        const tail = add(sp(0.125, mat, { y: -0.03, z: -0.6, outline: 0.016 }, 16), 0.85, 1.55, 0.85); tail.rotation.x = 0.28;
        break;
      }
      case 'twin':
        for (const sd of [-1, 1]) { const p = cap(0.09, 0.26, mat, { x: sd * 0.36, y: -0.1, z: -0.08, outline: 0.016 }); p.rotation.z = sd * 0.25; head.add(p); head.add(sp(0.06, acc, { x: sd * 0.34, y: 0.1, z: -0.06 })); }
        break;
      case 'long': { // hair down the back, past the shoulders
        add(cap(0.2, 0.36, mat, { y: -0.2, z: -0.2, outline: 0.016 }), 1.35, 1, 0.6);
        for (const sd of [-1, 1]) head.add(cap(0.07, 0.3, mat, { x: sd * 0.33, y: -0.18, z: 0.08, outline: 0.016 }));
        break;
      }
      case 'curly': // a ring of curls round the head and a few on the crown
        for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; head.add(sp(0.115, mat, { x: Math.sin(a) * 0.3, y: 0.12 + Math.cos(a * 2) * 0.05, z: Math.cos(a) * 0.3 - 0.05, outline: 0.016 }, 14)); }
        for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2 + 0.3; head.add(sp(0.1, mat, { x: Math.sin(a) * 0.19, y: 0.33, z: Math.cos(a) * 0.19 - 0.05, outline: 0.016 }, 14)); }
        break;
      case 'afro': { // a round puff set back on the head (the face stays in front of it), curls breaking its edge; no
        // wider than 1.15x the head (0.414 either side), so it reads as hair, not a cloud
        add(sp(0.375, mat, { y: 0.13, z: -0.12, outline: 0.02 }, 28), 1, 0.92, 1);
        for (let i = 0; i < 11; i++) {
          const a = 0.95 + i / 10 * (Math.PI * 2 - 1.9);
          head.add(sp(0.105, mat, { x: Math.sin(a) * 0.305, y: 0.17 + (i % 2) * 0.08, z: -0.12 + Math.cos(a) * 0.3, outline: 0.016 }, 14));
        }
        for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + 0.4; head.add(sp(0.105, mat, { x: Math.sin(a) * 0.17, y: 0.42, z: -0.12 + Math.cos(a) * 0.17, outline: 0.016 }, 14)); }
        for (let i = -1; i <= 1; i++) head.add(sp(0.075, mat, { x: i * 0.15, y: 0.29 - Math.abs(i) * 0.03, z: 0.265 - Math.abs(i) * 0.03, outline: 0.016 }, 12)); // curly hairline
        break;
      }
      default: break;
    }
  }

  // At most one accessory. Head-worn pieces are parented to the head (they nod and turn with it and bake into its
  // batch); neck pieces sit on the shoulders, in the rig, so a nod does not swing a scarf.
  buildAccessory() {
    const L = this.look, kind = L.accessory, head = this.head, s = L.side;
    const col = toon(L.accColor), dark = toon(0x3a3340);
    switch (kind) {
      case 'glasses': { // round frames just in front of the eyes, wrapped with them, temples back to the ears
        const fm = toon(L.frame);
        for (const sd of [-1, 1]) {
          const r = mesh(gTorus(0.084, 0.015, 6, 22), fm, { x: sd * 0.161, y: -0.012, z: 0.378 }); r.rotation.y = sd * 0.35; head.add(r);
          const arm = bx(0.016, 0.016, 0.22, fm, { x: sd * 0.285, y: 0.0, z: 0.235 }); arm.rotation.y = -sd * 0.36; head.add(arm);
        }
        head.add(bx(0.17, 0.016, 0.016, fm, { y: 0.0, z: 0.405 }));
        break;
      }
      case 'headphones': { // band over the crown, cups over the ears
        head.add(mesh(gTorus(0.418, 0.027, 6, 28, Math.PI), L.accColor === 0x45404c ? toon(0xf2e8d5) : dark, { y: 0.03 }));
        for (const sd of [-1, 1]) {
          const c = cy(0.1, 0.1, 0.075, col, { x: sd * 0.41, outline: 0.016 }, 18); c.rotation.z = Math.PI / 2; head.add(c);
          const pad = cy(0.062, 0.062, 0.02, dark, { x: sd * 0.455 }, 14); pad.rotation.z = Math.PI / 2; head.add(pad);
        }
        break;
      }
      case 'beanie': { // knitted dome over the hair, a rolled cuff (bangs peek out under it), sometimes a pompom
        const g = pivot(0, 0.035, 0); g.rotation.x = -0.32;
        g.add(mesh(gDome(0.43, 0.47, 28, 10), col, { outline: 0.016 }));
        const cuff = mesh(gTorus(0.42, 0.056, 8, 32), toon(shade(L.accColor, 0.86)), { y: 0.045, outline: 0.016 }); cuff.rotation.x = Math.PI / 2; g.add(cuff);
        if (L.variant < 0.5) g.add(sp(0.085, toon(L.accColor === 0xf2e8d5 ? 0xd8909f : 0xf2e8d5), { y: 0.49, outline: 0.016 }, 14));
        head.add(g);
        break;
      }
      case 'cap': { // baseball cap set high (the brows stay visible), one in three worn backwards
        const g = pivot(0, 0.1, 0); g.rotation.set(-0.16, L.variant < 0.33 ? Math.PI : 0, 0);
        g.add(mesh(gDome(0.405, 0.45, 28, 10), col, { outline: 0.016 }));
        const brim = cy(0.16, 0.16, 0.026, col, { y: 0.06, z: 0.43, outline: 0.016 }, 22); brim.scale.set(1.05, 1, 0.62); brim.rotation.x = -0.22; g.add(brim);
        g.add(sp(0.03, col, { y: 0.405 }, 10));
        head.add(g);
        break;
      }
      case 'clip': { // a flower, a bow or a pair of clips on the side away from the parting
        const big = L.hairStyle === 'afro';
        const dir = new THREE.Vector3(-s * 0.62, 0.62, 0.42).normalize();
        const g = big ? pivot(dir.x * 0.42, 0.13 + dir.y * 0.36, -0.12 + dir.z * 0.4) : pivot(dir.x * 0.4, 0.02 + dir.y * 0.4, dir.z * 0.4);
        g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        g.rotateZ(-s * 0.5);
        if (L.variant < 0.45) { // flower
          for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; const p = sp(0.05, col, { x: Math.cos(a) * 0.055, y: Math.sin(a) * 0.055 }, 12); p.scale.set(1, 1, 0.55); g.add(p); }
          g.add(sp(0.034, toon(L.accColor === 0xd8a444 ? 0xf6efe2 : 0xf0c75e), { z: 0.02 }, 10));
        } else if (L.variant < 0.75) { // bow
          for (const sd of [-1, 1]) { const w = sp(0.068, col, { x: sd * 0.078 }, 14); w.scale.set(1.3, 0.8, 0.6); g.add(w); }
          g.add(sp(0.038, col, {}, 10));
        } else for (const sd of [-1, 1]) g.add(bx(0.14, 0.028, 0.03, col, { y: sd * 0.035, z: 0.01 })); // two clips
        head.add(g);
        break;
      }
      case 'scarf': { // wrapped round the neck, knot and tail in front
        const bw = this.bw;
        const ring = mesh(gTorus(0.2, 0.062, 8, 24), col, { y: 0.695, outline: 0.012 }); ring.rotation.x = Math.PI / 2; ring.scale.set(bw, 1, 1); this.rig.add(ring);
        this.rig.add(sp(0.058, col, { x: s * 0.085, y: 0.665, z: 0.2, outline: 0.012 }, 12));
        const tail = bx(0.09, 0.19, 0.034, toon(shade(L.accColor, 0.93)), { x: s * 0.095, y: 0.565, z: 0.208, outline: 0.012 }); tail.rotation.set(-0.14, 0, s * 0.12); this.rig.add(tail);
        break;
      }
      case 'neckphones': { // headphones resting round the neck: the band dips to the chest, cups below the chin where the
        // big head does not hide them
        const band = mesh(gTorus(0.2, 0.02, 6, 24), dark, { y: 0.71 }); band.rotation.x = Math.PI / 2 + 0.45; this.rig.add(band);
        for (const sd of [-1, 1]) { const c = cy(0.078, 0.078, 0.05, col, { x: sd * 0.15, y: 0.64, z: 0.17, outline: 0.012 }, 16); c.rotation.set(1.0, 0, -sd * 0.45); this.rig.add(c); }
        break;
      }
      default: break;
    }
  }

  /** 'stand' | 'sit': the rig eases between them over ~0.35 s (see seatedness) */
  setPose(pose, seatY = 0.42) { this.pose = pose; this.seatY = seatY; }
  setSilhouette(on) { if (this.silhouette) this.silhouette.visible = on; }
  /** turn the head toward a world-space point (null to release); the head eases there, it never snaps */
  lookAtPoint(p) { this.lookPoint = p; }
  smile(sec = 1.6) { this.happyT = sec; }
  setAnim(anim) {
    if (this.anim === anim) return;
    this.anim = anim; this.animT = 0;
    if (anim === 'type') { this.typing = true; this.typeT = 1.5 + Math.random() * 3.5; this.typeMouse = false; }
    if (anim === 'host') { this.hostT = 1.5 + Math.random() * 2.5; this.hostGlance = 0; }
  }
  /** world distance covered this frame while walking: strides follow the ground actually travelled */
  advanceWalk(distance) {
    this.walkPhase += distance / (0.42 * (this.look.scale || 1)) * Math.PI;
    this.walkFedT = 0;
  }

  // ---- props: built once per person, cached, re-attached on demand -------------
  setProp(name) {
    for (const k in this.props) { this.props[k].parent?.remove(this.props[k]); delete this.props[k]; }
    if (!name) return;
    let g = this.propCache[name];
    if (!g) { g = this.buildProp(name); if (!g) return; this.propCache[name] = g; }
    (name === 'cup' ? this.handR : this.rig).add(g);
    g.userData.mode = undefined; setMode(g, this.group.userData.mode || 'normal'); // match the floor's display mode
    this.props[name] = g;
    if (name === 'cup') { this.steamT = 0; for (const s of this.steam) { s.visible = false; s.userData.life = -1; } }
  }

  buildProp(name) {
    const g = new THREE.Group();
    if (name === 'cup') {
      const body = cyl(0.055, 0.045, 0.1, toon(0xfffaf3), { outline: 0.012 }, 16);
      const band = cyl(0.057, 0.057, 0.03, toon(this.look.accent), { y: 0.02 }, 16);
      const coffee = cyl(0.045, 0.045, 0.01, toon(0x5a3a28), { y: 0.05, cast: false }, 16);
      const handle = mesh(new THREE.TorusGeometry(0.035, 0.009, 8, 14, Math.PI), toon(0xfffaf3), { x: 0.06, cast: false });
      handle.rotation.z = -Math.PI / 2;
      g.add(body, band, coffee, handle);
      g.position.set(0.02, -0.02, 0.06); g.rotation.z = -0.3;
      for (let i = 0; i < 3; i++) { // a small pool of steam puffs, recycled forever
        const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }); this.ownMats.push(m);
        const s = new THREE.Mesh(steamGeo, m); s.castShadow = false; s.visible = false;
        s.userData.life = -1; s.userData.noMode = true; // ambient wisps: not dimmed / ghosted, not baked into impostors
        g.add(s); this.steam.push(s);
      }
    } else if (name === 'laptop') {
      const base = box(0.34, 0.02, 0.24, toon(0xe8e4ee), { outline: 0.012 });
      const screen = box(0.34, 0.22, 0.015, toon(0xe8e4ee), { y: 0.11, z: -0.12, outline: 0.012 }); screen.rotation.x = 0.25;
      const pm = new THREE.MeshBasicMaterial({ color: VENDOR[this.look.vendorKey].screen }); this.ownMats.push(pm);
      const panel = box(0.3, 0.18, 0.004, pm, { y: 0.11, z: -0.1, cast: false }); panel.rotation.x = 0.25;
      g.add(base, screen, panel);
      g.position.set(0, 0.47, 0.3); g.rotation.x = -0.1;
    } else if (name === 'book') { // an open paperback, held at the chest
      for (const s of [-1, 1]) { const pg = box(0.11, 0.15, 0.012, toon(0xfbf8f2), { x: s * 0.056, outline: 0.006 }); pg.rotation.y = -s * 0.25; g.add(pg); }
      const cov = box(0.24, 0.16, 0.008, toon(PAL_BOOK[Math.floor(this.look.seed * 3) % 3]), { z: -0.012 }); g.add(cov);
      g.position.set(0, 0.6, 0.27); g.rotation.x = -0.75;
    } else if (name === 'sheet') { // a freshly printed report, held in both hands in front of the chest
      g.add(box(0.21, 0.29, 0.006, toon(0xfbf8f2), { outline: 0.006 }));
      for (let i = 0; i < 5; i++) g.add(box(0.15 - (i % 2) * 0.04, 0.012, 0.004, toon(0x9b8fb0), { x: -0.01 - (i % 2) * 0.02, y: 0.09 - i * 0.04, z: 0.005, cast: false }));
      g.position.set(0, 0.55, 0.26); g.rotation.x = -0.5;
    } else if (name === 'clipboard') {
      g.add(box(0.24, 0.3, 0.015, toon(0xd9b48a), { outline: 0.012 }));
      g.add(box(0.2, 0.26, 0.006, toon(0xfffdf7), { z: 0.011, cast: false }));
      g.add(box(0.08, 0.04, 0.03, toon(0x3a3340), { y: 0.15 }));
      for (let i = 0; i < 4; i++) g.add(box(0.14 - i * 0.02, 0.012, 0.004, toon(0x9b8fb0), { x: -0.02 - i * 0.01, y: 0.08 - i * 0.05, z: 0.015, cast: false }));
      g.position.set(0, 0.52, 0.27); g.rotation.x = -0.6;
    } else return null;
    return g;
  }

  // ---- animation ------------------------------------------------------------
  // Each anim writes target rotations (tH, tTO, tAL, tAR, tLL, tLR) and fast cycles (aH … aLR); the joints then
  // ease toward the targets, so anim changes and in-anim toggles blend instead of snapping. update(0) places the
  // pose directly (impostor snapshots).
  update(dt) {
    const snap = this.snap || !(dt > 0); this.snap = false;
    this.t += dt; this.animT = (this.animT || 0) + dt;
    const t = this.t, tr = this.look.traits || {};
    // blinking
    this.blinkT -= dt;
    if (this.blinkT < 0) { this.blinking = 0.12; this.blinkT = 2.4 + Math.random() * 3.6; }
    if (this.blinking > 0) this.blinking -= dt;
    this.eyesClosed = false;
    if (this.happyT > 0) { this.happyT -= dt; this.eyesClosed = true; }
    // expression defaults (anims below may override)
    let browRaise = 0, browAngry = 0; this.talking = false; this.mouthBig = false;
    // idle gaze wandering
    this.lookT -= dt; if (this.lookT < 0) { this.lookTarget = (Math.random() - 0.5) * 0.9; this.lookT = 2 + Math.random() * 3; }
    this.lookCur += (this.lookTarget - this.lookCur) * Math.min(1, dt * 3);

    // sit / stand transition
    const seatGoal = this.pose === 'sit' ? 1 : 0;
    if (snap) this.seatLin = seatGoal;
    else this.seatLin = seatGoal > this.seatLin ? Math.min(seatGoal, this.seatLin + dt / 0.35) : Math.max(seatGoal, this.seatLin - dt / 0.35);
    const S = this.seatedness, sitting = S > 0.5, standW = 1 - S;
    // turning on the spot: watch the yaw the behaviour layer gives the group
    const yaw = this.group.rotation.y;
    const dYaw = this.lastYaw === null ? 0 : wrapAngle(yaw - this.lastYaw);
    if (dt > 0 && Math.abs(dYaw) < 0.5) { // a bigger jump in one frame is a placement (spawn, back from an impostor), not a turn
      const rate = clamp(dYaw / dt, -6, 6);
      this.yawRate += (rate - this.yawRate) * ease(dt, 10);
    }
    this.lastYaw = yaw;
    const walking = this.anim === 'walk';
    const turning = !walking && Math.abs(this.yawRate) > 0.5;
    this.turnAmt += ((turning ? 1 : 0) - this.turnAmt) * (snap ? 1 : ease(dt, 10));
    if (this.turnAmt > 0.01) this.turnPhase += dt * 11;
    // walk phase: driven by advanceWalk; without it, fall back to a time-based cadence
    this.walkFedT += dt;
    if (walking && this.walkFedT > 0.2) this.walkPhase += dt * 9.5;
    this.walkAmp += ((walking ? 1 : 0) - this.walkAmp) * (snap ? 1 : ease(dt, 9));

    // default targets
    const tH = this.tH, tTO = this.tTO, tAL = this.tAL, tAR = this.tAR, tLL = this.tLL, tLR = this.tLR;
    const aH = this.aH, aTO = this.aTO, aAL = this.aAL, aAR = this.aAR, aLL = this.aLL, aLR = this.aLR, tg = this.tg, add = this.add;
    tH.set(0, 0, 0); tTO.set(0, 0, 0); tAL.set(0, 0, 0.1); tAR.set(0, 0, -0.1);
    tLL.set(-1.45 * S, 0, 0.08 * S); tLR.set(-1.45 * S, 0, -0.08 * S);
    aH.set(0, 0, 0); aTO.set(0, 0, 0); aAL.set(0, 0, 0); aAR.set(0, 0, 0); aLL.set(0, 0, 0); aLR.set(0, 0, 0);
    tg.rigX = 0; tg.faceY = 0; tg.liftL = 0; tg.liftR = 0; add.rigY = 0; add.twist = 0;
    // mid-transition: a slight forward lean as the weight goes over the feet
    const lean = Math.sin(Math.PI * S); aTO.x += lean * 0.22; aH.x += lean * 0.1;
    const A = this.anim;

    switch (A) {
      case 'walk': {
        const w = this.walkPhase, amp = this.walkAmp;
        const swing = 0.45 + (tr.social ?? 0.5) * 0.2, bob = 0.04 + (tr.cheer ?? 0.5) * 0.03;
        aLL.x = Math.sin(w) * 0.7 * amp; aLR.x = -Math.sin(w) * 0.7 * amp;
        aAL.x = -Math.sin(w) * swing * amp; aAR.x = Math.sin(w) * swing * amp;
        add.rigY = Math.abs(Math.sin(w)) * bob * amp;
        add.twist = Math.sin(w) * 0.07 * amp; // shoulders counter the hips; head and feet stay on course
        aH.z = Math.sin(w * 0.5) * 0.05 * amp; tH.y = this.lookCur * 0.3;
        tTO.x = 0.05;
        break;
      }
      case 'type': {
        if (!snap) {
          this.typeT -= dt;
          if (this.typeT <= 0) {
            this.typing = !this.typing;
            this.typeT = this.typing ? 1.5 + Math.random() * 3.5 : 0.4 + Math.random() * 1.1;
            this.typeMouse = !this.typing && Math.random() < 0.4;
          }
          if (this.typing) this.typePhase += dt * this.typeRate;
        }
        tTO.x = 0.1;
        if (this.typing) {
          const w = this.typePhase;
          tAL.set(-1.25, 0, 0.3); tAR.set(-1.25, 0, -0.3);
          aAL.x = Math.sin(w) * 0.09 + Math.sin(w * 1.7 + 1) * 0.04; aAR.x = Math.sin(w + Math.PI) * 0.09 + Math.sin(w * 1.3 + 2) * 0.04;
          tH.x = 0.14 + Math.sin(t * 2) * 0.02; tH.y = Math.sin(t * 0.7) * 0.06;
        } else { // a pause: hands rest, head nudges toward the screen; now and then a hand on the mouse
          tAL.set(-1.1, 0, 0.28);
          if (this.typeMouse) { tAR.set(-1.15, 0, 0.12); aAR.z = Math.sin(t * 1.7) * 0.04; aAR.x = Math.sin(t * 2.3) * 0.03; }
          else tAR.set(-1.1, 0, -0.28);
          tH.x = 0.21; tH.y = Math.sin(t * 0.5) * 0.05; tTO.x = 0.13;
        }
        break;
      }
      case 'talk': {
        this.talking = true;
        tAL.set(-1.1, 0, 0.3); tAR.set(-1.1, 0, -0.3); aAR.x = Math.sin(t * 7) * 0.08;
        tH.x = 0.04; aH.x = Math.sin(t * 6) * 0.05; tH.z = Math.sin(t * 1.5) * 0.04;
        break;
      }
      case 'read': {
        tAL.set(-1.1, 0, 0.3); tAR.set(-1.1, 0, -0.3);
        tH.x = 0.12; tH.y = Math.sin(t * 0.9) * 0.1;
        break;
      }
      case 'think': { // hand at the chin, eyes up
        browRaise = 1;
        tAL.set(-1.1, 0, 0.3); tAR.set(-1.75, 0, -0.45);
        tH.z = -0.13; tH.x = -0.12 + Math.sin(t * 1.3) * 0.03; tH.y = 0.12;
        tg.faceY = 0.02;
        break;
      }
      case 'stretch': {
        const k = Math.min(1, this.animT * 2.5);
        tAL.set(-2.95, 0, -0.55); tAR.set(-2.95, 0, 0.55); aAL.x = Math.sin(t * 3) * 0.08; aAR.x = Math.sin(t * 3 + 1) * 0.08;
        tg.liftL = tg.liftR = 0.03;
        tH.x = -0.25 * k; tTO.x = -0.08 * k; this.eyesClosed = k > 0.6;
        break;
      }
      case 'sip': {
        const c = this.animT % 5.5, up = c < 1.8;
        if (up) tAR.set(-1.95, 0, -0.28); else tAR.set(-1.5, 0, -0.25);
        tAL.set(sitting ? -1.0 : -0.4, 0, 0.3);
        tH.x = up ? -0.12 : 0.03; tH.y = up ? 0 : this.lookCur * 0.4; if (up && c > 0.4) this.eyesClosed = true;
        break;
      }
      case 'wave': {
        tAR.set(-2.75, 0, 0.85); aAR.z = Math.sin(t * 11) * 0.3; tg.liftR = 0.035;
        tAL.set(sitting ? -1.0 : 0, 0, 0.15);
        tH.z = 0.12; tH.y = 0.1;
        break;
      }
      case 'inspect': {
        tAL.set(-1.35, 0, 0.45); tAR.set(-1.35, 0, -0.45);
        const glance = Math.sin(t * 0.55) > 0.6;
        tH.x = glance ? -0.05 : 0.28; tH.y = glance ? this.lookCur : 0; aH.z = Math.sin(t * 3) * 0.02;
        break;
      }
      case 'readbook': { // holding an open book at the chest, eyes down, a page turn now and then
        const flip = (t % 6) < 0.5;
        tAL.set(-1.25, 0, 0.42); if (flip) tAR.set(-1.6, 0, -0.15); else tAR.set(-1.25, 0, -0.42);
        tH.x = 0.28; tH.y = Math.sin(t * 0.5) * 0.06;
        break;
      }
      case 'slouch': { // sunk into a bean bag
        tTO.x = -0.32; tAL.set(0.1, 0, 0.55); tAR.set(0.1, 0, -0.55);
        tH.x = -0.15 + Math.sin(t * 0.5) * 0.04; tH.y = Math.sin(t * 0.25) * 0.25;
        break;
      }
      case 'foos': { // two hands on the rods, wrists flicking
        const k = Math.sin(t * 9), j = Math.sin(t * 7 + 1.3);
        tAL.set(-1.2, 0, 0.5); tAR.set(-1.2, 0, -0.5); aAL.x = k * 0.15; aAR.x = j * 0.15;
        tTO.x = 0.18; tH.x = 0.25; add.rigY = Math.abs(k) * 0.01;
        break;
      }
      case 'phone': {
        tAR.set(-1.7, 0, -0.3); tAL.set(sitting ? -1.0 : -0.1, 0, 0.3);
        tH.x = 0.35; tH.z = 0.05;
        break;
      }
      case 'leanback': { // long think: lean back and stare at the ceiling (chibi arms can't reach behind that big head)
        tAL.set(0.15, 0, 0.32 + Math.sin(t * 0.7) * 0.03); tAR.set(0.15, 0, -0.32 - Math.sin(t * 0.7) * 0.03);
        tTO.x = -0.3; tH.x = -0.5 + Math.sin(t * 0.6) * 0.04; tH.y = Math.sin(t * 0.3) * 0.3; browRaise = 0.8;
        break;
      }
      case 'chin': { // chin on hand, the other hand on the desk
        tAL.set(-1.15, 0, 0.35); tAR.set(-1.8, 0, -0.38);
        tTO.x = 0.12; tH.z = -0.1; tH.x = 0.06 + Math.sin(t * 0.9) * 0.02; browRaise = 0.7;
        break;
      }
      case 'shoulders': { // a quick shoulder roll
        const r = Math.sin(t * 7);
        tAL.set(sitting ? -1.0 : 0.05, 0, 0.18); tAR.set(sitting ? -1.0 : 0.05, 0, -0.18); aAL.z = r * 0.12; aAR.z = r * 0.12;
        aTO.z = r * 0.07; aH.z = -r * 0.09; this.eyesClosed = true;
        tg.liftL = Math.max(0, r) * 0.03; tg.liftR = Math.max(0, -r) * 0.03;
        break;
      }
      case 'wipe': { // wiping feet on the mat, one foot then the other
        (Math.floor(t * 1.4) % 2 ? aLL : aLR).x = Math.sin(t * 13) * 0.3;
        tAL.set(0.05, 0, 0.22); tAR.set(0.05, 0, -0.22); tH.x = 0.32;
        break;
      }
      case 'yawn': { // one arm up beside the head (arms this short can't reach the mouth), mouth wide, eyes shut
        tAR.set(-2.9, 0, 0.62); tg.liftR = 0.04; tAL.set(sitting ? -1.0 : 0.05, 0, 0.3);
        tH.x = -0.25; tH.z = 0.08; this.eyesClosed = true; tTO.x = -0.05; tTO.z = -0.04; this.mouthBig = true;
        break;
      }
      case 'raise': { // hand up beside the head, clear of it, eyes on the screen: waiting for the boss to answer
        const sw = Math.sin(t * 2.2);
        tAR.set(-2.88, 0, 0.72 + sw * 0.12); tg.liftR = 0.035;
        tAL.set(sitting ? -1.1 : 0.05, 0, 0.3);
        tTO.z = -0.08; // lean toward the raised hand
        tH.z = 0.1; tH.x = -0.1 + sw * 0.02; browRaise = 0.8;
        break;
      }
      case 'wave2': { // both hands up, waving at you (an asking agent who has stood up to catch your eye)
        const s = Math.sin(t * 10);
        tAL.set(-2.7, 0, -0.8); tAR.set(-2.7, 0, 0.8); aAL.z = -s * 0.3; aAR.z = s * 0.3; tg.liftL = tg.liftR = 0.035;
        add.rigY = Math.abs(Math.sin(t * 5)) * 0.02; tH.x = -0.12; tH.z = Math.sin(t * 2.5) * 0.06; browRaise = 1; this.talking = Math.sin(t * 3) > 0.3;
        break;
      }
      case 'reach': { // an arm out to the side, head with it: working the lid of the laptop beside the desk
        tTO.x = 0.08; tAR.set(-1.35, 0, 0.82); tAL.set(sitting ? -1.05 : 0.05, 0, 0.28); tH.x = 0.2; tH.y = -0.42;
        break;
      }
      case 'mouse': { // a pause between keystrokes: one hand on the mouse, eyes on the screen
        tTO.x = 0.12; tAL.set(-1.1, 0, 0.28); tAR.set(-1.15, 0, 0.12);
        aAR.z = Math.sin(t * 1.7) * 0.04 + Math.sin(t * 4.1) * 0.015; aAR.x = Math.sin(t * 2.3) * 0.03;
        tH.x = 0.18; tH.y = Math.sin(t * 0.6) * 0.08;
        break;
      }
      case 'slump': { // errors piling up: head down, shoulders sag, a long breath; then the page is crumpled and tossed at the bin
        const k = this.animT;
        tTO.x = sitting ? 0.3 : 0.2; tH.x = 0.55 + Math.sin(t * 0.9) * 0.03; tH.z = 0.06; browRaise = 0.7; browAngry = 0.1;
        tAL.set(sitting ? -0.95 : 0.12, 0, 0.12); tAR.set(sitting ? -0.95 : 0.12, 0, -0.12); tg.liftL = tg.liftR = -0.025;
        if (k < 1.5) this.eyesClosed = k > 0.3;
        else if (k > 1.6 && k < 2.4) { // the toss: right arm winds up and flicks out toward the bin (on the right)
          const p = (k - 1.6) / 0.8;
          tAR.set(p < 0.55 ? -2.1 : -1.3, 0, 0.6); aAR.x = p < 0.55 ? -0.25 : 0.35;
          tH.x = 0.05; tH.y = 0.55; tTO.x = 0.05; browAngry = 0.35;
        } else if (k >= 2.4) { tH.x = 0.2; tH.y = 0.35; } // watching it land
        break;
      }
      case 'call': { // beckoning someone over
        this.talking = Math.sin(t * 3) > 0; browRaise = 0.6;
        tAR.set(-2.45, 0, 0.75); aAR.x = Math.sin(t * 9) * 0.3; tg.liftR = 0.03;
        tAL.set(sitting ? -1.0 : 0.05, 0, 0.3);
        tH.z = 0.08; tTO.x = sitting ? 0.0 : -0.04; tTO.z = -0.04;
        break;
      }
      case 'listen': { // nodding along, hands holding the laptop / clipboard or clasped
        tAL.set(-1.2, 0, 0.45); tAR.set(-1.2, 0, -0.45);
        tH.x = 0.05; aH.x = Math.max(0, Math.sin(t * 4.5)) * 0.12; tH.z = 0.04;
        break;
      }
      case 'present': { // showing the work, a little bounce of pride
        this.talking = true; browRaise = 0.5;
        tAL.set(-1.5, 0, 0.5); tAR.set(-1.5, 0, -0.5);
        add.rigY = Math.abs(Math.sin(t * 5)) * 0.02; tH.x = -0.06; tH.z = Math.sin(t * 2.5) * 0.04;
        break;
      }
      case 'wait': { // arms crossed, glancing around at the team
        browAngry = 0.4;
        tAL.set(-1.25, 0, 1.05); tAR.set(-1.25, 0, -1.05);
        tH.y = Math.sin(t * 0.9) * 0.6; tH.z = 0.06; tTO.x = -0.06;
        if (sitting) aLL.x = Math.sin(t * 6) * 0.04; // a restless foot
        break;
      }
      case 'nod': {
        tAL.set(sitting ? -1.0 : 0.05, 0, 0.3); tAR.set(sitting ? -1.0 : 0.05, 0, -0.3);
        tH.x = 0.05; aH.x = Math.max(0, Math.sin(t * 5.5)) * 0.16;
        break;
      }
      case 'stamp': { // bang! approved
        browAngry = 0.5;
        const c = this.animT % 1.2;
        tAR.set(-1.3, 0, -0.3); aAR.x = c < 0.25 ? -0.65 : c < 0.4 ? 0.2 : 0; aAR.z = c < 0.25 ? 0.3 : 0; tAL.set(-1.3, 0, 0.45); // wind-up swings out, clear of the head; the left hand holds the page
        tH.x = 0.05; aH.x = c < 0.4 ? 0.15 : 0; tTO.x = 0.02; aTO.x = c < 0.4 ? 0.08 : 0;
        break;
      }
      case 'cheer': { // both arms up in a V, bouncing
        tAL.set(-2.85, 0, -0.6); tAR.set(-2.85, 0, 0.6); tg.liftL = tg.liftR = 0.035;
        add.rigY = Math.abs(Math.sin(t * 7)) * 0.06; this.eyesClosed = true; tH.x = -0.15;
        break;
      }
      case 'water': { // watering a plant
        tAR.set(-1.4 + Math.sin(t * 2) * 0.1, 0, -0.5); tAL.set(-0.3, 0, 0.3); tH.x = 0.3; tTO.x = 0.12;
        break;
      }
      case 'gaze': { // looking out of the window, hands behind the back
        tAL.set(0.5, 0, -0.35); tAR.set(0.5, 0, 0.35); tH.x = -0.12; tH.y = Math.sin(t * 0.5) * 0.25;
        break;
      }
      case 'chat': {
        this.talking = Math.sin(t * 2.2) > -0.2;
        tAR.set(-0.9, 0, -0.4); aAR.x = Math.sin(t * 3) * 0.25; tAL.set(sitting ? -1.0 : 0.1, 0, 0.3);
        aH.x = Math.sin(t * 4) * 0.05; tH.z = Math.sin(t * 1.3) * 0.05;
        break;
      }
      case 'sleepy': {
        tH.x = 0.3 + Math.sin(t * 1.2) * 0.08; tH.z = 0.08; this.eyesClosed = true;
        tAL.set(sitting ? -1.0 : 0, 0, 0.3); tAR.set(sitting ? -1.0 : 0, 0, -0.3);
        break;
      }
      case 'oops': { // hands to the head and a shake ("oh no"), then a slump
        const k = this.animT;
        if (k < 1.8) {
          tAL.set(-2.65, 0, -0.52); tAR.set(-2.65, 0, 0.52); tg.liftL = tg.liftR = 0.03;
          aH.y = Math.sin(t * 9) * 0.18 * clamp((k - 0.15) / 0.2, 0, 1) * clamp((1.8 - k) / 0.4, 0, 1);
          tH.x = -0.04; browAngry = 0.6; this.mouthBig = k > 0.2 && k < 1.5;
        } else { // shoulders drop, head hangs, a long breath out
          tAL.set(sitting ? -0.9 : 0.12, 0, 0.14); tAR.set(sitting ? -0.9 : 0.12, 0, -0.14);
          tTO.x = 0.16; tH.x = 0.34 + Math.sin(t * 0.8) * 0.02; tH.z = 0.05; browRaise = 0.6; browAngry = 0.15;
          tg.liftL = tg.liftR = -0.02;
        }
        break;
      }
      case 'host': { // a lead hosting a kickoff: hands clasped low, a glance toward the door, a beckon now and then
        if (!snap) {
          this.hostT -= dt;
          if (this.hostT <= 0) {
            if (this.hostGlance) { this.hostGlance = 0; this.hostT = 2.8 + Math.random() * 3.5; }
            else { this.hostGlance = 1; this.hostBeckon = Math.random() < 0.45; this.hostT = this.hostBeckon ? 1.8 : 1.0 + Math.random() * 0.8; }
          }
        }
        tAL.set(-0.85, 0, 0.45); tAR.set(-0.85, 0, -0.45);
        tH.x = 0.02; tH.y = this.lookCur * 0.5; tH.z = Math.sin(t * 0.7) * 0.03; browRaise = 0.3;
        if (this.hostGlance) {
          tH.y = this.hostSide * 0.75; tH.x = -0.03;
          if (this.hostBeckon) { tAR.set(-1.65, 0, 0.3); aAR.x = Math.sin(t * 9) * 0.28; tg.liftR = 0.02; browRaise = 0.6; }
        }
        break;
      }
      default: { // idle
        tAL.set(sitting ? -0.9 : 0.03, 0, 0.1 + Math.sin(t * 1.5) * 0.03); tAR.set(sitting ? -0.9 : 0.03, 0, -0.1 - Math.sin(t * 1.5) * 0.03);
        tH.y = this.lookCur; tH.z = Math.sin(t * 0.8) * 0.03;
      }
    }

    // standing at ease: weight drifts from foot to foot, the unloaded knee relaxes
    if (standW > 0.01 && WEIGHT_SHIFT.has(A)) {
      const w = Math.sin(t * 0.35 + this.look.seed * 6.3);
      tg.rigX = w * 0.015 * standW;
      tLL.x += Math.max(0, w) * 0.09 * standW; tLR.x += Math.max(0, -w) * 0.09 * standW;
      tTO.z -= w * 0.02 * standW;
    }
    // turning on the spot: little alternating steps, the head leading the body
    if (this.turnAmt > 0.01) {
      const st = Math.sin(this.turnPhase) * 0.25 * this.turnAmt * standW;
      aLL.x += st; aLR.x -= st; add.rigY += Math.abs(st) * 0.03;
    }
    aH.y += clamp(this.yawRate * 0.13, -0.35, 0.35) * Math.max(this.turnAmt, this.walkAmp * 0.6);
    aH.y -= add.twist; // keep the head on course while the shoulders swing
    // looking at someone: the head yaw eases toward them (the head joint is damped, so no snap on change)
    if (this.lookPoint) {
      const wp = this.lookPoint, g = this.group;
      tH.y = clamp(wrapAngle(Math.atan2(wp.x - g.position.x, wp.z - g.position.z) - yaw), -1.2, 1.2);
    }

    // ease every joint toward its target, then layer the fast cycles on top
    const ka = snap ? 1 : ease(dt, 30);
    for (let i = 0; i < 6; i++) {
      const j = this.joints[i], tgt = j[1], cur = j[2], ad = j[3], ac = j[4];
      const k = snap ? 1 : ease(dt, j[5]);
      cur.x += (tgt.x - cur.x) * k; cur.y += (tgt.y - cur.y) * k; cur.z += (tgt.z - cur.z) * k;
      ac.x += (ad.x - ac.x) * ka; ac.y += (ad.y - ac.y) * ka; ac.z += (ad.z - ac.z) * ka;
      j[0].rotation.set(cur.x + ac.x, cur.y + ac.y, cur.z + ac.z);
    }
    const ch = this.ch, kf = snap ? 1 : ease(dt, 12), ks = snap ? 1 : ease(dt, 6), kb = snap ? 1 : ease(dt, 10);
    ch.rigX += (tg.rigX - ch.rigX) * ks; ch.faceY += (tg.faceY - ch.faceY) * ks;
    ch.liftL += (tg.liftL - ch.liftL) * kf; ch.liftR += (tg.liftR - ch.liftR) * kf;
    ch.browRaise += (browRaise - ch.browRaise) * kb; ch.browAngry += (browAngry - ch.browAngry) * kb;
    ch.seatY += (this.seatY - ch.seatY) * (snap || S < 0.01 ? 1 : ease(dt, 8));
    const ac = this.addCur; ac.rigY += (add.rigY - ac.rigY) * ka; ac.twist += (add.twist - ac.twist) * ka;

    const rig = this.rig;
    rig.position.x = ch.rigX;
    // seated, the hips (the leg pivots, 0.32 up the rig) land where the role scale alone would put them: a taller or
    // shorter build neither hovers over the seat nor sinks into it (hk = 1 gives seatY - 0.3)
    rig.position.y = S * ((ch.seatY + 0.02) / this.hk - 0.32) + ac.rigY;
    rig.rotation.y = ac.twist;
    this.legL.rotation.y -= ac.twist; this.legR.rotation.y -= ac.twist; // feet keep pointing where they walk
    this.armL.position.y = 0.64 + ch.liftL; this.armR.position.y = 0.64 + ch.liftR;
    this.face.position.y = ch.faceY;
    this.torso.scale.set(this.bw, 1 + Math.sin(t * 2.1) * 0.012, 0.92); // breathing

    // face
    const closed = this.blinking > 0 || this.eyesClosed;
    for (const e of this.eyes) { const target = closed ? 0.12 : 1; e.scale.y = snap ? target : e.scale.y + (target - e.scale.y) * Math.min(1, dt * 30); e.userData.lid.visible = false; }
    for (const b of this.brows) { const sd = b.userData.side; b.position.y = 0.12 + ch.browRaise * 0.03 * (sd > 0 ? 1 : 0.4); b.rotation.z = -sd * (0.1 + ch.browAngry * 0.35 - ch.browRaise * 0.08); }
    const beam = this.happyT > 0 || A === 'cheer';
    if (beam !== this.beaming) { this.beaming = beam; setMouth(this.mouth, beam ? 'beam' : this.mouthRest); }
    const open = this.mouthBig || (this.talking && Math.sin(t * 14) > 0.1);
    this.mouthOpen.visible = open; this.mouth.visible = !open;
    if (this.mouthBig) this.mouthOpen.scale.set(1.25, 1.5, 0.4); else this.mouthOpen.scale.set(1, 0.8, 0.4);

    if (this.contact) { const k = 0.8 * S + (1 - Math.min(0.25, Math.max(0, ac.rigY) * 2.5)) * (1 - S); this.contact.scale.set(k, k, 1); }
    if (this.props.cup) this.updateSteam(dt);
  }

  updateSteam(dt) {
    this.steamT = (this.steamT || 0) + dt;
    for (let i = 0; i < this.steam.length; i++) {
      const s = this.steam[i];
      if (s.userData.life < 0) { // free puff: release one every 0.6 s
        if (this.steamT > 0.6) { this.steamT = 0; s.userData.life = 0; s.visible = true; } else continue;
      }
      const life = (s.userData.life += dt);
      s.position.set(Math.sin(life * 4) * 0.02, 0.08 + life * 0.12, 0);
      s.scale.setScalar(1 + life * 1.5);
      s.material.opacity = Math.max(0, 0.55 - life * 0.35);
      if (life > 1.6) { s.userData.life = -1; s.visible = false; }
    }
  }

  dispose() {
    const done = new Set();
    const free = o => { if (o.isMesh && o.geometry && !SHARED_GEOS.has(o.geometry) && !done.has(o.geometry)) { done.add(o.geometry); o.geometry.dispose(); } };
    this.group.traverse(free);
    for (const k in this.propCache) this.propCache[k].traverse(free); // cached props that are not held right now
    for (const m of this.ownMats) m.dispose();
    this.propCache = {}; this.props = {}; this.steam = []; this.ownMats = [];
    this.group.parent?.remove(this.group);
  }
}
