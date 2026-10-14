// ?perf: a small readout for testing on a real device. Frame rate and slow frames,
// the graphics tier and resolution, draw calls, the audio state and how long the
// caddie's last putt read took. Tapping it copies a summary of the whole session,
// so a phone test comes back as numbers rather than "it felt laggy".
export const perfWanted = (search) => /[?&]perf\b/.test(search);

export class PerfHud {
  constructor(game) {
    this.g = game;
    this.recent = []; // the last 60 frame times (ms)
    this.all = { n: 0, sum: 0, slow: 0, hitch: 0, worst: 0 }; // whole session
    this.reads = [];
    this.lastReadSeen = null;
    this.t = 0;
    this.started = performance.now();
    game.renderer.info.autoReset = false; // count every pass of the composer, reset once a frame
    const el = document.createElement('button');
    el.id = 'perfHud';
    el.type = 'button';
    el.title = 'Tap to copy a summary';
    el.onclick = () => this.copy();
    document.body.appendChild(el);
    this.el = el;
  }

  // called once per animation frame with the time since the previous one
  frame(ms) {
    const info = this.g.renderer.info;
    this.calls = info.render.calls; this.tris = info.render.triangles;
    info.reset();
    if (!(ms > 0 && ms < 1000)) return; // first frame, or a hidden tab
    this.recent.push(ms);
    if (this.recent.length > 60) this.recent.shift();
    const a = this.all;
    a.n++; a.sum += ms; a.worst = Math.max(a.worst, ms);
    if (ms > 1000 / 30 + 1) a.slow++;
    if (ms > 100) a.hitch++;
    const read = this.g.caddie?.lastRead;
    if (read && read !== this.lastReadSeen) { this.lastReadSeen = read; this.reads.push(read); }
    this.t += ms;
    if (this.t >= 500) { this.t = 0; this.draw(); }
  }

  stats() {
    const g = this.g, r = g.renderer, cv = r.domElement;
    const fps = this.recent.length ? 1000 / (this.recent.reduce((s, x) => s + x, 0) / this.recent.length) : 0;
    const read = this.reads[this.reads.length - 1];
    return {
      fps,
      tier: `${g.post.tier}${g.post.quality === 'auto' ? ' (auto)' : ''}`,
      res: `${cv.width}×${cv.height} @${r.getPixelRatio()}x`,
      calls: this.calls, tris: this.tris,
      audio: g.audio.ctx ? g.audio.ctx.state : 'off',
      read,
    };
  }

  draw() {
    const s = this.stats();
    const read = s.read ? `${(s.read.ms / 1000).toFixed(1)} s (${Math.round(s.read.cpu)} ms CPU)` : '–';
    // one short line on a phone so it stays clear of the HUD; the copied summary has the rest
    this.el.textContent = innerWidth < 600
      ? `${s.fps.toFixed(0)} fps · ${s.tier.split(' ')[0]} ${this.g.renderer.getPixelRatio()}x · read ${s.read ? `${(s.read.ms / 1000).toFixed(1)} s` : '–'}${s.audio === 'running' ? '' : ` · audio ${s.audio}`}`
      : `${s.fps.toFixed(0)} fps · ${s.tier} · ${s.res} · ${s.calls} calls · audio ${s.audio} · putt read ${read}`;
    this.el.classList.toggle('slow', s.fps > 0 && s.fps < 40);
  }

  summary() {
    const s = this.stats(), a = this.all, g = this.g;
    const mins = (performance.now() - this.started) / 60000;
    const reads = this.reads.map((r) => r.ms / 1000);
    return [
      `Pure Strike Golf perf, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      navigator.userAgent,
      `screen ${screen.width}×${screen.height}, devicePixelRatio ${devicePixelRatio}, canvas ${s.res}`,
      `graphics ${s.tier}, ${s.calls} draw calls, ${s.tris} triangles`,
      `${mins.toFixed(1)} min, ${a.n} frames, average ${a.n ? (1000 / (a.sum / a.n)).toFixed(0) : 0} fps, now ${s.fps.toFixed(0)} fps`,
      `slow frames (under 30 fps) ${a.n ? ((100 * a.slow) / a.n).toFixed(1) : 0}%, hitches over 100 ms ${a.hitch}, worst ${a.worst.toFixed(0)} ms`,
      `putt reads ${reads.length}${reads.length ? `, longest ${Math.max(...reads).toFixed(1)} s, average ${(reads.reduce((x, y) => x + y, 0) / reads.length).toFixed(1)} s` : ''}`,
      `audio ${s.audio}, ${g.audio.bank ? `${g.audio.bank.status().loaded} samples` : 'no samples'}`,
    ].join('\n');
  }

  copy() {
    const text = this.summary();
    const done = () => this.g.ui?.toast('Perf summary copied');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => this.show(text));
    else this.show(text);
  }

  // no clipboard (plain http on a phone): show the text so it can be selected by hand
  show(text) {
    const pre = document.createElement('textarea');
    pre.id = 'perfDump';
    pre.readOnly = true;
    pre.value = text;
    pre.onblur = () => pre.remove();
    document.body.appendChild(pre);
    pre.focus(); pre.select();
  }
}
