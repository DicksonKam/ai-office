// When the office was running. A film hatches the stretches it was not (the Mac asleep, the server stopped), so a quiet
// bar is never mistaken for nobody working. Spans of time only, in data/uptime.json, the last 60 days.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class Uptime {
  constructor(file, { gapMs = 180000, keepDays = 60, saveEveryMs = 60000 } = {}) {
    Object.assign(this, { file, gapMs, keepMs: keepDays * 86400000, saveEveryMs });
    this.spans = []; this.savedAt = 0; this.writing = null;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j.spans)) this.spans = j.spans.filter(s => Array.isArray(s) && s[1] >= s[0]); } catch { /* none yet */ }
  }
  /** the office is running at `now` */
  beat(now = Date.now()) {
    const last = this.spans[this.spans.length - 1];
    if (last && now >= last[1] && now - last[1] <= this.gapMs) last[1] = now;
    else if (!last || now > last[1]) this.spans.push([now, now]);
    while (this.spans.length && this.spans[0][1] < now - this.keepMs) this.spans.shift();
    if (now - this.savedAt >= this.saveEveryMs) this.save(now);
  }
  /** one write at a time, the latest spans each time */
  save(now = Date.now()) {
    this.savedAt = now;
    this.writing = (this.writing || Promise.resolve()).then(async () => {
      try {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.writeFile(`${this.file}.tmp`, JSON.stringify({ spans: this.spans }));
        await fsp.rename(`${this.file}.tmp`, this.file);
      } catch { /* the next beat tries again */ }
    });
    return this.writing;
  }
  /** stretches inside [from, to] between two known spans: before the first record nothing is known, so nothing is said */
  gaps(from, to) {
    const out = [];
    for (let i = 1; i < this.spans.length; i++) {
      const a = this.spans[i - 1][1], b = this.spans[i][0];
      if (b - a <= this.gapMs || b <= from || a >= to) continue;
      out.push({ from: Math.max(a, from), to: Math.min(b, to) });
    }
    return out;
  }
}
