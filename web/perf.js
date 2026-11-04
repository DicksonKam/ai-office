// ?perf: a small frame-time readout (bottom left) for real numbers from a real browser. Median frame time, the 1%-low
// frame rate (the slowest 1% of frames), draw calls, triangles, floors and people, refreshed every second; once a
// minute (and 15 s after load) the same numbers go to the local server (POST /api/perf, kept in memory only), so a visit
// in your own browser leaves numbers that can be read back with GET /api/perf. Nothing of this runs without ?perf.
export function startPerf({ renderer, mgr, demo = false }) {
  const el = document.createElement('div');
  el.id = 'perfReadout';
  el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:50;padding:6px 10px;border-radius:10px;font:12px/1.4 ui-monospace,Menlo,monospace;' +
    'background:rgba(251,248,242,.92);color:#3f3a4a;box-shadow:0 2px 8px rgba(0,0,0,.12);pointer-events:none;white-space:pre';
  document.body.appendChild(el);
  const N = 600, times = new Float32Array(N); let n = 0, head = 0, last = 0, shownAt = 0, sentAt = performance.now() - 45000;
  const stats = () => {
    const k = Math.min(n, N); if (k < 10) return null;
    const a = Array.from(times.subarray(0, k)).sort((x, y) => x - y);
    const med = a[Math.floor(k / 2)], p99 = a[Math.min(k - 1, Math.floor(k * 0.99))];
    const r = renderer.info.render;
    return { medianMs: +med.toFixed(1), fps: Math.round(1000 / med), low1Fps: Math.round(1000 / p99), calls: r.calls, triangles: r.triangles,
      floors: mgr.floors.length, people: mgr.list.length, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, demo, frames: k };
  };
  const tick = now => {
    if (last && !document.hidden) { const dt = now - last; if (dt > 0 && dt < 10000) { times[head] = dt; head = (head + 1) % N; n++; } }
    last = now;
    if (now - shownAt > 1000) {
      shownAt = now; const s = stats();
      el.textContent = s ? `${s.fps} fps · ${s.medianMs} ms median · 1% low ${s.low1Fps} fps\n${s.calls} draws · ${(s.triangles / 1000).toFixed(0)}k tris · ${s.floors} floor${s.floors > 1 ? 's' : ''} · ${s.people} people` : 'measuring…';
      if (s && !document.hidden && now - sentAt > 60000) {
        sentAt = now;
        fetch('/api/perf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...s, ua: navigator.userAgent.slice(0, 160) }) }).catch(() => {});
      }
    }
    requestAnimationFrame(tick);
  };
  document.addEventListener('visibilitychange', () => { last = 0; }); // a hidden tab's gap is not a frame
  requestAnimationFrame(tick);
}
