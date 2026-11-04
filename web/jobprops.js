// On every desk, doing nothing until there is work going on outside the agent's turn (jobs.js): a closed laptop beside the
// desk, whose lid lifts for a real job and whose screen then shows one bar per job, and a wind-up kitchen timer, whose dial
// is set when an agent sets a timer. Nothing appears from nowhere, and only a screen glows.
import * as THREE from 'three';
import { box, cyl, roundedBox } from './toon.js';
import { freezeStatic } from './merge.js';

const BARS = 3, LID_OPEN = -1.85, LID_SPEED = 3.2, REACH_S = 0.45, TIMER_FULL_MS = 60 * 60 * 1000;
const COLOR = { running: 0x58d0e6, done: 0x7fcf8f, failed: 0xe0654f, stopped: 0xa9a6b4, unknown: 0xa9a6b4 };

// one material per state, shared by every desk: running bars breathe together
const lit = {};
const litFor = (state, toon) => {
  if (!lit[state]) { lit[state] = toon(COLOR[state], { emissive: COLOR[state], emissiveIntensity: 0.9 }).clone(); lit[state].userData.shared = true; } // outlives any one floor
  return lit[state];
};
export function pulseJobLights(t) { if (lit.running) lit.running.emissiveIntensity = 0.75 + 0.5 * Math.sin(t * 3.2); }

/** `toon` and `PAL` are the office's own; `applyMode(node)` gives runtime changes the look of a dimmed or ghosted floor. */
export function buildJobKit(deskGroup, { toon, PAL, applyMode }) {
  const at = new THREE.Group(); at.position.set(-0.54, 0.755, -0.17); at.rotation.y = 1.8; deskGroup.add(at); // off to the sitter's side, turned in toward them
  at.add(roundedBox(0.4, 0.022, 0.28, 0.008, toon(PAL.slate), { y: 0.011, outline: 0.007 }));
  at.add(box(0.34, 0.003, 0.15, toon(PAL.slateDark), { y: 0.023, z: -0.04, cast: false }));

  const lid = new THREE.Group(); lid.position.set(0, 0.024, -0.14); lid.userData.dynamic = true; at.add(lid);
  const back = new THREE.Group(); back.userData.dynamic = true; lid.add(back);
  back.add(box(0.4, 0.012, 0.28, toon(PAL.slate), { y: 0.006, z: 0.14, outline: 0.007 }));
  freezeStatic(back);
  const screen = new THREE.Group(); screen.visible = false; screen.userData.dynamic = true; lid.add(screen);
  const panel = box(0.37, 0.003, 0.25, toon(0x1d2230), { y: -0.0015, z: 0.14, cast: false }); panel.userData.noMerge = true; screen.add(panel);
  const bars = Array.from({ length: BARS }, (_, i) => { const b = box(0.3, 0.003, 0.05, litFor('running', toon), { y: -0.0045, z: 0.215 - i * 0.075, cast: false }); b.userData.noMerge = true; b.visible = false; screen.add(b); return b; });

  // the timer: a dome with a dial on top, and its red pointer showing the time left (a dial at rest has no pointer set)
  const timer = new THREE.Group(); timer.position.set(0.86, 0.755, -0.27); deskGroup.add(timer);
  timer.add(cyl(0.05, 0.065, 0.055, toon(PAL.paper), { y: 0.0275, outline: 0.006 }, 18));
  timer.add(cyl(0.05, 0.05, 0.006, toon(PAL.terracotta), { y: 0.058, cast: false }, 18));
  const pointer = new THREE.Group(); pointer.position.y = 0.063; pointer.visible = false; pointer.userData.dynamic = true; timer.add(pointer);
  pointer.add(box(0.012, 0.004, 0.045, toon(PAL.paper), { z: 0.02, cast: false }));

  let open = false, angle = 0, key = '', first = true, pending = null, wait = 0;
  return {
    get lidAngle() { return angle; },
    /** `jobs`: everything on this desk. `canMove`: someone in the chair is free to lift or close the lid. True when they
     *  should reach for it now: the lid moves once the hand has got there. */
    setJobs(jobs, now, canMove) {
      const runs = jobs.filter(j => j.kind === 'run').slice(-BARS), timerAt = jobs.find(j => j.kind === 'timer' && j.state === 'waiting')?.nextAt;
      pointer.visible = !!timerAt;
      if (timerAt) pointer.rotation.y = -Math.min(1, Math.max(0, (timerAt - now) / TIMER_FULL_MS)) * Math.PI * 2;
      const want = runs.length > 0;
      if (first && want) { open = true; angle = LID_OPEN; lid.rotation.x = angle; screen.visible = true; } // a tab opened mid-job: already open
      let reach = false;
      if (!first && want !== open && canMove && pending === null) { pending = want; wait = REACH_S; reach = true; }
      const k = runs.map(j => j.state).join();
      if (k !== key) {
        key = k;
        bars.forEach((b, i) => { const j = runs[i]; b.visible = !!j; if (j) { const m = litFor(j.state, toon); b.material = m; if (b.userData.origMat) b.userData.origMat = m; } });
        applyMode(screen);
      }
      first = false;
      return reach;
    },
    update(dt) {
      if (pending !== null && (wait -= dt) <= 0) { open = pending; pending = null; }
      const to = open ? LID_OPEN : 0;
      if (angle === to) return;
      angle = open ? Math.max(to, angle - dt * LID_SPEED) : Math.min(to, angle + dt * LID_SPEED);
      lid.rotation.x = angle; screen.visible = angle < -0.3; // the screen wakes as the lid comes up
    },
  };
}
