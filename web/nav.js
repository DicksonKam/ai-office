// 2D navigation grid: obstacle footprints inflated by the character radius, A* with 8-neighbours,
// and line-of-sight smoothing so paths look natural instead of stair-stepped.
export class NavGrid {
  constructor(minX, minZ, maxX, maxZ, cell = 0.2, radius = 0.3) {
    this.minX = minX; this.minZ = minZ; this.cell = cell; this.radius = radius;
    this.cols = Math.ceil((maxX - minX) / cell); this.rows = Math.ceil((maxZ - minZ) / cell);
    this.blocked = new Uint8Array(this.cols * this.rows);
    this.obstacles = [];
  }
  reset() { this.blocked.fill(0); this.obstacles.length = 0; }
  idx(c, r) { return r * this.cols + c; }
  cellOf(x, z) { return [Math.floor((x - this.minX) / this.cell), Math.floor((z - this.minZ) / this.cell)]; }
  center(c, r) { return { x: this.minX + (c + 0.5) * this.cell, z: this.minZ + (r + 0.5) * this.cell }; }
  inBounds(c, r) { return c >= 0 && r >= 0 && c < this.cols && r < this.rows; }
  isFreeCell(c, r) { return this.inBounds(c, r) && !this.blocked[this.idx(c, r)]; }
  isFree(x, z) { const [c, r] = this.cellOf(x, z); return this.isFreeCell(c, r); }

  /** Block a (possibly rotated) rectangle footprint: centre (x,z), size w×d, yaw rot. */
  block(x, z, w, d, rot = 0, inflate = this.radius) {
    this.obstacles.push({ x, z, w, d, rot });
    const hw = w / 2 + inflate, hd = d / 2 + inflate, cos = Math.cos(rot), sin = Math.sin(rot);
    const reach = Math.hypot(hw, hd);
    const [c0, r0] = this.cellOf(x - reach, z - reach), [c1, r1] = this.cellOf(x + reach, z + reach);
    for (let r = Math.max(0, r0); r <= Math.min(this.rows - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(this.cols - 1, c1); c++) {
        const p = this.center(c, r);
        const dx = p.x - x, dz = p.z - z;
        // into the rectangle's local frame (forward = +z after yaw)
        const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
        if (Math.abs(lx) <= hw && Math.abs(lz) <= hd) this.blocked[this.idx(c, r)] = 1;
      }
    }
  }

  nearestFree(x, z, maxR = 2.0) {
    const [c0, r0] = this.cellOf(x, z);
    if (this.isFreeCell(c0, r0)) return { x, z };
    const maxCells = Math.ceil(maxR / this.cell);
    let best = null, bestD = Infinity;
    for (let dr = -maxCells; dr <= maxCells; dr++) for (let dc = -maxCells; dc <= maxCells; dc++) {
      const c = c0 + dc, r = r0 + dr;
      if (!this.isFreeCell(c, r)) continue;
      const d = dc * dc + dr * dr;
      if (d < bestD) { bestD = d; best = this.center(c, r); }
    }
    return best;
  }

  lineFree(a, b) {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(dist / (this.cell * 0.5)));
    for (let i = 0; i <= n; i++) { const t = i / n; if (!this.isFree(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false; }
    return true;
  }

  /** A* from world point a to b. Returns a smoothed list of points (excluding a, including b), or null. */
  find(a, b) {
    const start = this.nearestFree(a.x, a.z, 1.5), goal = this.nearestFree(b.x, b.z, 1.5);
    if (!start || !goal) return null;
    const [sc, sr] = this.cellOf(start.x, start.z), [gc, gr] = this.cellOf(goal.x, goal.z);
    const sI = this.idx(sc, sr), gI = this.idx(gc, gr);
    if (sI === gI) return [b];
    const N = this.cols * this.rows;
    const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const h = i => { const c = i % this.cols, r = (i / this.cols) | 0; const dx = Math.abs(c - gc), dz = Math.abs(r - gr); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
    // binary heap on f
    const heap = []; const push = (i, f) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    g[sI] = 0; push(sI, h(sI));
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    let found = false, steps = 0;
    while (heap.length && steps++ < 60000) {
      const [, i] = pop();
      if (closed[i]) continue;
      if (i === gI) { found = true; break; }
      closed[i] = 1;
      const c = i % this.cols, r = (i / this.cols) | 0;
      for (const [dc, dr, cost] of dirs) {
        const nc = c + dc, nr = r + dr;
        if (!this.isFreeCell(nc, nr)) continue;
        if (dc && dr && (!this.isFreeCell(c + dc, r) || !this.isFreeCell(c, r + dr))) continue; // no corner cutting
        const ni = this.idx(nc, nr);
        if (closed[ni]) continue;
        const ng = g[i] + cost;
        if (ng < g[ni]) { g[ni] = ng; came[ni] = i; push(ni, ng + h(ni)); }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let i = gI; i !== -1; i = came[i]) cells.push(this.center(i % this.cols, (i / this.cols) | 0));
    cells.reverse();
    cells[0] = { x: a.x, z: a.z };
    // string-pull: skip ahead to the farthest visible waypoint
    const out = [];
    let i = 0;
    while (i < cells.length - 1) {
      let j = cells.length - 1;
      while (j > i + 1 && !this.lineFree(cells[i], cells[j])) j--;
      out.push(cells[j]); i = j;
    }
    out[out.length - 1] = { x: goal.x, z: goal.z };
    if (Math.hypot(goal.x - b.x, goal.z - b.z) > 0.05) out.push({ x: b.x, z: b.z }); // last step into a seat may enter a footprint
    return out;
  }
}
