// What the agent at a desk has really made (server/output.js), as things on the desk:
//  - a wire out-tray at the front right: one sheet per file written (past twelve the pile grows in steps, so a big day
//    reads as a big pile without hundreds of sheets), every fourth a folder;
//  - a three-lamp test light on a post at the back-right corner: dark until a test has run, then green or red for the
//    last run's real result; the amber lamp pulses while a test is running;
//  - binders stood along the desk's right end, one per commit; past five, a box file on the floor beside the desk for
//    every further five (the desk is full).
// The tray and the light belong to the desk; the sheets and binders to whoever sits there: they are put down one at a
// time by the worker's hand (agents.js paces them) and picked up when they leave.
import * as THREE from 'three';
import { box, cyl, roundedBox } from './toon.js';
import { freezeStatic } from './merge.js';

export const MAX_SHEETS = 20, MAX_BINDERS = 9;
/** sheets on the tray for `files` written */
export const sheetsFor = files => (files <= 12 ? Math.max(0, files | 0) : Math.min(MAX_SHEETS, 12 + Math.round(Math.log2(files / 12) * 4)));
/** binders (and box files) in the corner for `commits` */
export const bindersFor = commits => (commits <= 5 ? Math.max(0, commits | 0) : Math.min(MAX_BINDERS, 5 + Math.floor((commits - 5) / 5) + 1));
/** the light's state from the output's tests: 'off' | 'pass' | 'fail', and whether a run is going on now */
export const lightFor = o => ({ last: o?.tests?.last || 'off', running: !!o?.tests?.running });

const LAMP = { red: 0xe0654f, amber: 0xf0b23a, green: 0x6fcf86 };
// one material per lamp state, shared by every desk; the amber one pulses for all running tests together
const mats = {};
const matFor = (name, toon) => {
  if (!mats[name]) {
    const [hue, on] = name.split(':');
    // off: the lamp's own colour, deep and unlit (tinted glass); on: bright and glowing
    const m = on === 'on' ? toon(LAMP[hue], { emissive: LAMP[hue], emissiveIntensity: 1.0 }).clone() : toon(new THREE.Color(LAMP[hue]).multiplyScalar(0.42).getHex()).clone();
    m.userData.shared = true; mats[name] = m;
  }
  return mats[name];
};
// a lamp is a round lens standing proud of each face of the head: the unlit ones are part of the desk; a lit one is
// shown over the room-facing lens only while that lamp is on (a quiet desk costs no extra draw)
const lensGeo = new THREE.SphereGeometry(0.025, 14, 10);
const litGeo = new THREE.SphereGeometry(0.0275, 14, 10);
const dispose = node => { node.traverse(o => { if (o !== node && o.isMesh && o.geometry && o.geometry !== lensGeo && o.geometry !== litGeo) o.geometry.dispose(); }); node.clear(); };
export function pulseTestLights(t) { if (mats['amber:on']) mats['amber:on'].emissiveIntensity = Math.sin(t * 7) > 0 ? 1.1 : 0.15; }

/** `deskGroup`: the desk; `own`: the group of the owner's things (cleared when the desk changes hands) */
export function buildOutputKit(deskGroup, own, { toon, PAL, applyMode, seed = 0 }) {
  // the out-tray: a shallow wire tray, empty on a free desk
  const trayAt = new THREE.Group(); trayAt.position.set(0.58, 0.757, -0.26); trayAt.rotation.y = -0.08; deskGroup.add(trayAt);
  const wire = toon(PAL.slateDark);
  trayAt.add(box(0.25, 0.006, 0.19, wire, { y: 0.003, cast: false }));
  for (const [w, d, x, z] of [[0.25, 0.008, 0, -0.095], [0.25, 0.008, 0, 0.095], [0.008, 0.19, -0.125, 0], [0.008, 0.19, 0.125, 0]]) trayAt.add(box(w, 0.035, d, wire, { x, y: 0.0175, z, cast: false }));
  trayAt.add(box(0.06, 0.012, 0.012, wire, { y: 0.036, z: -0.095, cast: false })); // a lip to take the pile out by

  // the test light: a slim housing with three lamps, red over amber over green, facing the room and the sitter
  // (on a slim post at the desk's back-right corner, its faces turned to the room and to the sitter)
  const light = new THREE.Group(); light.position.set(0.9, 0.757, 0.32); light.rotation.y = Math.PI / 4; deskGroup.add(light);
  light.add(cyl(0.05, 0.055, 0.014, toon(PAL.slateDark), { y: 0.007 }, 16));
  light.add(cyl(0.009, 0.009, 0.17, toon(PAL.metal ?? PAL.slate), { y: 0.095 }, 8));
  light.add(roundedBox(0.08, 0.235, 0.066, 0.018, toon(PAL.slateDark), { y: 0.29, outline: 0.007 }));
  const lamps = {};
  [['red', 0.365], ['amber', 0.29], ['green', 0.215]].forEach(([hue, y]) => {
    for (const z of [-0.03, 0.03]) { const dark = new THREE.Mesh(lensGeo, matFor(`${hue}:off`, toon)); dark.position.set(0, y, z); light.add(dark); }
    const lit = new THREE.Mesh(litGeo, matFor(`${hue}:on`, toon)); lit.position.set(0, y, 0.03); lit.visible = false; lit.userData.noMerge = true; lit.userData.dynamic = true;
    light.add(lit); lamps[hue] = lit;
  });
  freezeStatic(trayAt);

  const sheets = new THREE.Group(); sheets.position.copy(trayAt.position); sheets.rotation.y = trayAt.rotation.y; own.add(sheets);
  const binders = new THREE.Group(); binders.position.set(0.9, 0.757, 0.2); own.add(binders); // along the right end, in front of the light
  // each desk keeps to one folder colour and two binder colours (a draw per colour, so few of them)
  const tones = [PAL.sage, PAL.mustard, PAL.slate, PAL.terracotta], k = Math.abs(seed | 0);
  const paper = toon(PAL.paper), folder = toon(tones[k % 4]);
  const spines = [toon(tones[(k + 1) % 4]), toon(tones[(k + 3) % 4])];
  const ink = toon(PAL.ink);
  let nSheets = 0, nBinders = 0, lightKey = '';

  const drawSheets = n => {
    dispose(sheets);
    for (let i = 0; i < n; i++) {
      const s = box(0.2, 0.01, 0.145, i % 4 === 3 ? folder : paper, { y: 0.011 + i * 0.011, cast: i === n - 1 });
      s.rotation.y = Math.sin(i * 2.7) * 0.07; sheets.add(s);
    }
    freezeStatic(sheets); applyMode(sheets);
  };
  const drawBinders = n => {
    dispose(binders);
    for (let i = 0; i < n; i++) {
      if (i < 5) { // a lever-arch binder standing in a row along the desk's end, its spine (label, finger hole) to the room
        const b = new THREE.Group(); b.position.set(0, 0, -i * 0.044); binders.add(b);
        b.add(box(0.17, 0.24, 0.036, spines[i % 2], { y: 0.12, outline: 0.006 }));
        b.add(box(0.004, 0.06, 0.024, paper, { x: 0.087, y: 0.17, cast: false }));                 // its label
        b.add(box(0.004, 0.024, 0.024, ink, { x: 0.087, y: 0.06, cast: false }));                  // the finger hole
      } else { // every further five: a box file on the floor by the desk's right end, stacked
        binders.add(box(0.2, 0.09, 0.28, toon(PAL.slateDark), { x: 0.16, y: -0.757 + 0.045 + (i - 5) * 0.091, z: -0.42, outline: 0.006 }));
        binders.add(box(0.1, 0.04, 0.004, paper, { x: 0.16, y: -0.757 + 0.05 + (i - 5) * 0.091, z: -0.282, cast: false }));
      }
    }
    freezeStatic(binders); applyMode(binders);
  };
  const setLamp = (hue, on) => { lamps[hue].visible = !!on; };

  return {
    get sheets() { return nSheets; },
    get binders() { return nBinders; },
    /** what is on the desk now: counts already paced by the caller */
    set({ sheets: s = 0, binders: b = 0, last = 'off', running = false } = {}) {
      if (s !== nSheets) { nSheets = s; drawSheets(s); }
      if (b !== nBinders) { nBinders = b; drawBinders(b); }
      const k = `${last}|${running}`;
      if (k !== lightKey) {
        lightKey = k;
        setLamp('red', last === 'fail'); setLamp('green', last === 'pass'); setLamp('amber', running);
        applyMode(light);
      }
    },
    /** the owner gathered their things (or the desk changed hands) */
    clear() { this.set({ sheets: 0, binders: 0 }); },
  };
}
