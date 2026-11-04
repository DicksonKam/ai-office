// Floor display modes for stacked floors:
//   normal – the floor you are looking at
//   ghost  – the floor directly above: only its architecture (walls, stairs, the core, doors), very faint, no shadows,
//            no ink lines; furniture is not drawn at all, so the floor above never smudges the one you look at. The
//            slab itself is almost invisible (an outline drawn by office.js shows its edge instead). People on a ghost
//            floor (any root that is not a floor) stay a little more visible: they are real agents.
//   dim    – floors below: same shapes, darker, so the active floor reads first
// keyed weakly by the original material: a variant never outlives it (floors and impostors come and go all day)
const MODES = ['ghost', 'ghostPerson', 'slab', 'dim', 'hide'];
const cache = Object.fromEntries(MODES.map(m => [m, new WeakMap()]));
const GHOST_OPACITY = 0.05, PERSON_GHOST_OPACITY = 0.13, SLAB_OPACITY = 0.035, DIM = 0.58;

function variant(m, mode) {
  if (Array.isArray(m)) return m.map(x => variant(x, mode));
  const c = cache[mode];
  let v = c.get(m);
  if (!v) {
    v = m.clone();
    if (mode === 'dim') {
      if (v.color) v.color.multiplyScalar(DIM);
      if (v.emissiveIntensity !== undefined) v.emissiveIntensity *= 0.3;
    } else if (mode === 'hide') {
      v.visible = false; // the object keeps its own visibility (runtime code toggles it); only its look is swapped
    } else {
      const base = mode === 'slab' ? SLAB_OPACITY : mode === 'ghostPerson' ? PERSON_GHOST_OPACITY : GHOST_OPACITY;
      v.transparent = true; v.opacity = Math.min(base, m.transparent ? m.opacity : 1); v.depthWrite = false;
      if (v.emissiveIntensity !== undefined) v.emissiveIntensity = 0;
    }
    c.set(m, v);
  }
  return v;
}

/** Apply a display mode to a subtree. `force` re-applies even when the root already has that mode (props rebuilt at
 *  runtime need it); `floor` (default: root.userData.isFloor) hides furniture in ghost mode, keeping architecture
 *  (meshes flagged userData.arch) and the slab. */
export function setMode(root, mode, { force = false, floor = !!root?.userData.isFloor } = {}) {
  if (!root || (!force && root.userData.mode === mode)) return;
  root.userData.mode = mode;
  root.traverse(o => {
    if (!o.isMesh || o.userData.noMode) return;
    if (o.material?.isShaderMaterial) { // ink outlines: hidden on ghosts only
      if (o.userData.inkVisible === undefined) o.userData.inkVisible = o.visible;
      o.visible = mode === 'ghost' || (mode === 'dim' && o.userData.sealed) ? false : o.userData.inkVisible;
      return;
    }
    if (!o.userData.origMat) { o.userData.origMat = o.material; o.userData.origCast = o.castShadow; o.userData.origReceive = o.receiveShadow; }
    if (mode === 'normal') { o.material = o.userData.origMat; o.castShadow = o.userData.origCast; o.receiveShadow = o.userData.origReceive; return; }
    if (mode === 'dim') { o.material = variant(o.userData.origMat, o.userData.sealed ? 'hide' : 'dim'); o.castShadow = false; o.receiveShadow = o.userData.origReceive; return; } // floors below: no shadow pass
    const kind = o.userData.slab ? 'slab' : !floor ? 'ghostPerson' : o.userData.arch ? 'ghost' : 'hide';
    o.material = variant(o.userData.origMat, kind); o.castShadow = false; o.receiveShadow = false;
  });
}

/** free the display variants made from a material that is being disposed (a pruned floor's own materials) */
/** the dim look of a material, if a dimmed floor is using one (runtime code that lights a lamp must light this too) */
export function dimVariantOf(m) { return cache.dim.get(m) || null; }

export function disposeVariants(m) {
  if (!m) return;
  for (const mode of MODES) { const v = cache[mode].get(m); if (v) { v.dispose(); cache[mode].delete(m); } }
}

/** kept for callers that only know on/off */
export function setGhost(root, on) { setMode(root, on ? 'ghost' : 'normal'); }
