// DOM user interface: menus, HUD, shot panel, scorecard, summaries.
import { COURSES, courseById } from './courses/index.js';
import { PROFILES } from './clubs.js';
import { YD } from './hole.js';
import { SURFACES } from './physics.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const sgn = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
const toParStr = (d) => (d === 0 ? 'E' : d > 0 ? `+${d}` : `${d}`);

export class UI {
  constructor() {
    this.paused = false;
    this.sel = { courseId: 'augusta', mode: '18', hole: 1 };
    try { Object.assign(this.sel, JSON.parse(localStorage.getItem('psg-sel') || '{}')); } catch (e) { /* ignore */ }
    this.toasts = $('toasts');
    $('minimap').addEventListener('pointerdown', (e) => this.minimapClick(e));
  }
  attach(game, academy) { this.game = game; this.academy = academy; }

  // ------------------------------------------------------------ main menu
  mainMenu() {
    const g = this.game;
    this.hideAll();
    const m = $('menu');
    m.classList.remove('hidden');
    const cards = $('courseCards');
    cards.innerHTML = '';
    for (const c of COURSES) {
      const par = c.holes.reduce((s, h) => s + h.par, 0);
      const yds = c.holes.reduce((s, h) => s + h.yds, 0);
      let best = null;
      try { best = JSON.parse(localStorage.getItem(`psg-best-${c.id}-18`) || 'null'); } catch (e) { /* ignore */ }
      const card = el('button', 'course-card' + (c.id === this.sel.courseId ? ' sel' : ''));
      card.style.setProperty('--accent', c.flag);
      card.innerHTML = `
        <div class="cc-top"><span class="cc-flag"></span><div><div class="cc-name">${c.name}</div><div class="cc-loc">${c.location}</div></div></div>
        <div class="cc-meta">Par ${par} · ${yds.toLocaleString()} yds · Stimp ${c.stimp} · Wind ${c.wind[0]}–${c.wind[1]} mph</div>
        <p class="cc-blurb">${c.blurb}</p>
        <div class="cc-teach"><b>Teaches</b><ul>${c.teaches.map((t) => `<li>${t}</li>`).join('')}</ul></div>
        ${best ? `<div class="cc-best">Best 18: ${toParStr(best.toPar)} (${best.strokes})</div>` : ''}`;
      card.onclick = () => {
        this.sel.courseId = c.id;
        g.showcase(c.id);
        g.menuInit = false;
        this.mainMenu();
      };
      cards.appendChild(card);
    }
    // round options
    const s = g.settings;
    const opt = (id, val, list) => {
      const box = $(id);
      box.innerHTML = '';
      for (const [k, label, title] of list) {
        const b = el('button', 'seg' + (k === val ? ' on' : ''), label);
        if (title) b.title = title;
        b.onclick = () => { this.setOpt(id, k); this.mainMenu(); };
        box.appendChild(b);
      }
    };
    opt('optMode', this.sel.mode, [['18', '18 holes'], ['front', 'Front 9'], ['back', 'Back 9'], ['single', 'Single hole']]);
    opt('optProfile', s.profile, Object.entries(PROFILES).map(([k, p]) => [k, p.name, p.desc]));
    opt('optDiff', s.difficulty, [['beginner', 'Beginner', 'Big impact zone, full aim preview with wind and roll, full putt line'], ['standard', 'Standard', 'Normal zone, carry preview without wind, partial putt line'], ['pro', 'Pro', 'Small zone, no wind/putt assistance – read it yourself']]);
    opt('optControl', s.control, [['meter', '3-Click Meter', 'Mario Golf style: click to start, set power, hit the impact zone'], ['mouse', 'Analog Swing', 'Tiger Woods PSP style: pull the mouse back, push it through straight']]);
    opt('optUnits', s.units, [['yd', 'Yards'], ['m', 'Metres']]);
    const hs = $('optHole');
    hs.classList.toggle('hidden', this.sel.mode !== 'single');
    const course = courseById(this.sel.courseId);
    hs.innerHTML = course.holes.map((h, i) => `<option value="${i + 1}" ${i + 1 === +this.sel.hole ? 'selected' : ''}>${i + 1}. ${h.name} – par ${h.par}, ${h.yds} yds</option>`).join('');
    hs.onchange = () => { this.sel.hole = +hs.value; this.saveSel(); };
    $('profileDesc').textContent = PROFILES[s.profile].desc;
    $('btnPlay').onclick = () => this.play();
    $('btnAcademy').onclick = () => { this.academy.open(); };
    $('btnHow').onclick = () => this.showHelp(true);
  }
  setOpt(id, k) {
    const s = this.game.settings;
    if (id === 'optMode') this.sel.mode = k;
    if (id === 'optProfile') s.profile = k;
    if (id === 'optDiff') s.difficulty = k;
    if (id === 'optControl') s.control = k;
    if (id === 'optUnits') s.units = k;
    this.game.saveSettings();
    this.saveSel();
  }
  saveSel() { try { localStorage.setItem('psg-sel', JSON.stringify(this.sel)); } catch (e) { /* ignore */ } }

  play() {
    const m = this.sel.mode;
    let holes;
    if (m === '18') holes = [...Array(18).keys()];
    else if (m === 'front') holes = [...Array(9).keys()];
    else if (m === 'back') holes = [...Array(9).keys()].map((i) => i + 9);
    else holes = [(+this.sel.hole || 1) - 1];
    $('menu').classList.add('hidden');
    this.game.startRound({ courseId: this.sel.courseId, holes, mode: m });
  }

  hideAll() {
    for (const id of ['menu', 'intro', 'scorecard', 'relief', 'pause', 'summary', 'shotPanel', 'help']) $(id).classList.add('hidden'); document.body.classList.remove('sc-open');
    this.paused = false;
  }
  showHUD(on) {
    $('hud').classList.toggle('hidden', !on);
    $('helpBar').classList.toggle('hidden', !on);
    if (on) this.helpBar();
  }
  helpBar() {
    const mouse = this.game.settings.control === 'mouse';
    $('helpBar').innerHTML = [
      mouse ? '<b>Hold LMB</b> pull back, push up to swing' : '<b>Space</b> swing',
      '<b>←→</b> aim (Shift fine)', '<b>↑↓</b> club', '<b>Q/E</b> draw/fade', '<b>R/F</b> high/low',
      '<b>V</b> target view', '<b>G</b> green grid', '<b>P</b> aim at pin', '<b>Tab</b> card', '<b>Esc</b> menu',
    ].map((x) => `<span>${x}</span>`).join('');
  }

  // ------------------------------------------------------------ loading / intro
  loading(on, text = '') {
    $('loading').classList.toggle('hidden', !on);
    $('loadingText').textContent = text;
  }
  holeIntro(hole, course, dist, wind) {
    const i = $('intro');
    const def = course.holes[hole.index];
    i.innerHTML = `
      <div class="intro-num">${hole.number}</div>
      <div class="intro-body">
        <div class="intro-name">${hole.name}</div>
        <div class="intro-meta">Par ${hole.par} · ${dist} · Wind ${wind} · Stimp ${hole.stimp.toFixed(1)}</div>
        ${def.tip ? `<p class="intro-tip">${def.tip}</p>` : ''}
        <div class="intro-skip">Space / click to skip the flyover</div>
      </div>`;
    i.classList.remove('hidden');
  }
  hideIntro() { $('intro').classList.add('hidden'); }

  // ------------------------------------------------------------ HUD
  hud(d) {
    $('hcNum').textContent = d.hole;
    $('hcName').textContent = d.name;
    $('hcPar').textContent = `Par ${d.par} · ${this.game.fmtDist(d.yards * YD)}`;
    $('hcShot').textContent = `Shot ${d.shot}`;
    $('hcScore').textContent = toParStr(d.toPar);
    $('hcScore').className = 'hc-score ' + (d.toPar < 0 ? 'under' : d.toPar > 0 ? 'over' : '');
    // distance
    $('dPin').textContent = d.dist;
    let sub = '';
    if (d.plays) sub = `Plays like <b>${d.plays}</b>`;
    else if (d.puttEq != null) sub = `Stroke it <b>${d.puttEq.toFixed(0)} ft</b><br><small>to finish 17 in past</small>`;
    const e = Math.round(d.elev);
    if (Math.abs(e) >= 1) sub += `<span class="elev">${e > 0 ? '▲' : '▼'} ${Math.abs(e)} ft ${e > 0 ? 'uphill' : 'downhill'}</span>`;
    $('dSub').innerHTML = sub;
    // wind
    const w = d.wind;
    $('windArrow').style.transform = `rotate(${w.ang}rad)`;
    $('windMph').textContent = `${Math.round(d.windMph)}`;
    let wt = [];
    if (Math.abs(w.along) >= 1.5) wt.push(w.along > 0 ? 'Helping' : 'Into');
    if (Math.abs(w.side) >= 1.5) wt.push(w.side > 0 ? 'L → R' : 'R → L');
    $('windTxt').textContent = wt.join(' · ') || 'Calm';
    // club
    $('clubName').textContent = d.club.name;
    $('clubKey').textContent = d.club.key;
    $('clubDist').textContent = d.clubCarry;
    $('shapeVal').textContent = d.putter ? '—' : d.shape;
    $('trajVal').textContent = d.putter ? '—' : d.traj;
    $('shapeRow').classList.toggle('dim', d.putter);
    // lie
    $('lieName').textContent = d.lie;
    $('lieRange').textContent = d.putter ? `Stimp ${d.stimp.toFixed(1)}` : d.lieRange;
    const sl = d.slope, parts = [];
    if (Math.abs(sl.up) >= 1.5) parts.push(`${sl.up > 0 ? 'Uphill' : 'Downhill'} ${Math.abs(sl.up).toFixed(0)}°`);
    if (Math.abs(sl.side) >= 1.5) parts.push(`Ball ${sl.side > 0 ? 'above' : 'below'} feet ${Math.abs(sl.side).toFixed(0)}°`);
    $('lieSlope').textContent = d.putter ? '' : parts.join(' · ') || 'Flat lie';
    $('lieBox').dataset.lie = d.lieKey;
  }

  minimap(game) {
    const cv = $('minimap');
    const W = game.world, h = game.hole;
    if (!W.textureCanvas || !h) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (cv.width !== cw * dpr) { cv.width = cw * dpr; cv.height = ch * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const B = h.bounds;
    const bw = B.maxX - B.minX, bd = B.maxZ - B.minZ;
    const s = Math.min((cw - 8) / bw, (ch - 8) / bd);
    const ox = (cw - bw * s) / 2, oy = (ch - bd * s) / 2;
    this.mm = { s, ox, oy, B };
    g.save();
    g.beginPath(); g.roundRect ? g.roundRect(0, 0, cw, ch, 10) : g.rect(0, 0, cw, ch); g.clip();
    g.fillStyle = '#23402a'; g.fillRect(0, 0, cw, ch);
    g.drawImage(W.textureCanvas, ox, oy, bw * s, bd * s);
    const P = (x, z) => [ox + (x - B.minX) * s, oy + (z - B.minZ) * s];
    // aim line
    const b = game.ball;
    const [bx, by] = P(b.p[0], b.p[2]);
    if (game.state === 'address' && game.previewLand && !game.club.putter) {
      const [lx, ly] = P(game.previewLand[0], game.previewLand[2]);
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(bx, by); g.lineTo(lx, ly); g.stroke(); g.setLineDash([]);
      g.strokeStyle = '#ffe14d'; g.lineWidth = 2;
      g.beginPath(); g.arc(lx, ly, 4, 0, Math.PI * 2); g.stroke();
      if (game.previewRest && game.diff.roll) {
        const [rx, ry] = P(game.previewRest[0], game.previewRest[2]);
        g.fillStyle = 'rgba(255,225,77,0.7)'; g.beginPath(); g.arc(rx, ry, 2, 0, Math.PI * 2); g.fill();
      }
    }
    // tracer during flight
    if (game.sim && (game.state === 'flight' || game.state === 'result')) {
      const tr = game.sim.trail;
      g.strokeStyle = '#ff5a40'; g.lineWidth = 1.5;
      g.beginPath();
      tr.forEach((p, i) => { const [x, y] = P(p[0], p[2]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      const [x2, y2] = P(game.sim.p[0], game.sim.p[2]); g.lineTo(x2, y2);
      g.stroke();
    }
    // pin
    const [px, py] = P(h.cup.x, h.cup.z);
    g.fillStyle = game.course.flag; g.strokeStyle = '#000'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px, py); g.lineTo(px, py - 10); g.lineTo(px + 7, py - 7); g.lineTo(px, py - 4); g.fill(); g.stroke();
    // ball
    const bp = game.state === 'flight' && game.sim ? game.sim.p : b.p;
    const [qx, qy] = P(bp[0], bp[2]);
    g.fillStyle = '#fff'; g.strokeStyle = '#000';
    g.beginPath(); g.arc(qx, qy, 3.5, 0, Math.PI * 2); g.fill(); g.stroke();
    g.restore();
  }
  minimapClick(e) {
    const g = this.game;
    if (!this.mm || !g || g.state !== 'address') return;
    const r = e.currentTarget.getBoundingClientRect();
    const { s, ox, oy, B } = this.mm;
    const x = B.minX + (e.clientX - r.left - ox) / s, z = B.minZ + (e.clientY - r.top - oy) / s;
    g.aimAtWorld(x, z);
    e.stopPropagation();
  }

  caddie(text) {
    const c = $('caddie');
    if (!text) { c.classList.add('hidden'); return; }
    if (c.dataset.text !== text) { c.dataset.text = text; $('caddieText').textContent = text; }
    c.classList.remove('hidden');
  }

  toast(text, kind = '') {
    const t = el('div', 'toast ' + kind, text);
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 1900);
    setTimeout(() => t.remove(), 2400);
  }
  banner(text, kind = '') {
    const b = $('banner');
    b.className = 'banner ' + kind;
    b.textContent = text;
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(this.bannerT);
    this.bannerT = setTimeout(() => b.classList.remove('show'), 2600);
  }

  // ------------------------------------------------------------ shot panel
  showShotPanel(o) {
    const p = $('shotPanel');
    if (!o) { p.classList.add('hidden'); return; }
    const { info, sg, fmt, tips } = o;
    const rows = [];
    const ld = info.ld;
    if (info.putt) {
      rows.push(['Putt length', `${info.startFt.toFixed(0)} ft`]);
      rows.push(['Result', info.holed ? '<b class="good">Holed</b>' : `${info.afterFt.toFixed(1)} ft ${info.shortFt > 0 ? 'short' : 'past'}`]);
      rows.push(['Start speed', `${(ld.speed * 2.237).toFixed(1)} mph`]);
      rows.push(['Face at impact', `${Math.abs(ld.face).toFixed(1)}° ${ld.face > 0.05 ? 'open' : ld.face < -0.05 ? 'closed' : 'square'}`]);
    } else {
      const u = this.game.settings.units;
      const d = (yd) => (u === 'm' ? `${(yd * YD).toFixed(0)} m` : `${yd.toFixed(0)} yds`);
      rows.push(['Club', info.club.name]);
      rows.push(['Club speed', `${ld.clubMph.toFixed(1)} mph`]);
      rows.push(['Ball speed', `${ld.ballMph.toFixed(1)} mph`]);
      rows.push(['Smash factor', ld.smash.toFixed(2)]);
      rows.push(['Launch', `${ld.launch.toFixed(1)}° · ${Math.abs(ld.hLaunch).toFixed(1)}° ${ld.hLaunch >= 0 ? 'R' : 'L'}`]);
      rows.push(['Spin', `${Math.round(ld.spinRpm).toLocaleString()} rpm · axis ${ld.axisTilt.toFixed(1)}°`]);
      rows.push(['Face / Path', `${sgn(ld.face, 1)}° / ${sgn(ld.path, 1)}°`]);
      rows.push(['Carry', d(info.carryYd)]);
      rows.push(['Total', d(info.totalYd)]);
      rows.push(['Offline', `${d(Math.abs(info.offlineYd))} ${info.offlineYd >= 0 ? 'R' : 'L'}`]);
      rows.push(['Apex', `${Math.max(0, info.apexFt).toFixed(0)} ft`]);
      if (info.descent != null) rows.push(['Land angle', `${info.descent.toFixed(0)}°`]);
    }
    const sgHtml = sg ? `<div class="sg ${sg.sg >= 0 ? 'pos' : 'neg'}"><span>Strokes gained</span><b>${sgn(sg.sg)}</b><em>${{ OTT: 'Off the tee', APP: 'Approach', ARG: 'Around the green', PUTT: 'Putting' }[sg.cat]}</em><small>Tour avg from there: ${sg.eb.toFixed(2)} → ${sg.ea.toFixed(2)}</small></div>` : '';
    const tipsHtml = tips.map((t) => `<div class="tip"><b>${t.title}</b><p>${t.text}</p></div>`).join('');
    p.innerHTML = `
      <div class="sp-head">${info.putt ? 'Putt' : 'Launch monitor'}</div>
      <div class="sp-grid">${rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      ${sgHtml}
      ${tipsHtml ? `<div class="sp-tips"><div class="sp-sub">Coach</div>${tipsHtml}</div>` : ''}
      <div class="sp-cont">Space / click to continue</div>`;
    p.classList.remove('hidden');
    p.onclick = () => this.game.continueAfterResult();
  }

  // ------------------------------------------------------------ relief
  relief(opts, cb, fmt) {
    const r = $('relief');
    if (!opts) { r.classList.add('hidden'); return; }
    r.innerHTML = `<h2>Penalty area – take relief (+1 stroke)</h2>
      <p class="muted">Each option shows the tour-average strokes to hole out from the drop. Lower is better.</p>
      <div class="relief-opts"></div>`;
    const box = r.querySelector('.relief-opts');
    const best = Math.min(...opts.map((o) => o.es));
    for (const o of opts) {
      const b = el('button', 'relief-opt' + (o.es === best ? ' best' : ''));
      b.innerHTML = `<b>${o.title}</b><p>${o.desc}</p><div><span>${fmt(o.dist)} to pin</span><span>${o.isTee ? 'Tee' : SURFACES[o.surface]?.name || o.surface}</span><span>Expected ${o.es.toFixed(2)}</span></div>`;
      b.onclick = () => cb(o);
      box.appendChild(b);
    }
    r.classList.remove('hidden');
  }

  // ------------------------------------------------------------ scorecard
  scorecard(course, round, modal, cb, label) {
    const s = $('scorecard');
    document.body.classList.toggle('sc-open', !!course);
    if (!course) { s.classList.add('hidden'); return; }
    const byNum = {};
    for (const x of round.scores) byNum[x.number] = x.strokes;
    const half = (from) => {
      const holes = course.holes.slice(from, from + 9);
      let par = 0, tot = 0, any = false;
      const cells = holes.map((h, i) => {
        const n = from + i + 1;
        par += h.par;
        const sc = byNum[n];
        if (sc != null) { tot += sc; any = true; }
        const d = sc != null ? sc - h.par : null;
        const cls = d == null ? '' : d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'dbl';
        return { n, h, sc, cls };
      });
      return `<table><tr class="num"><th>Hole</th>${cells.map((c) => `<td>${c.n}</td>`).join('')}<th>${from ? 'In' : 'Out'}</th></tr>
        <tr class="yd"><th>Yards</th>${cells.map((c) => `<td>${c.h.yds}</td>`).join('')}<th>${holes.reduce((a, h) => a + h.yds, 0)}</th></tr>
        <tr class="par"><th>Par</th>${cells.map((c) => `<td>${c.h.par}</td>`).join('')}<th>${par}</th></tr>
        <tr class="sc"><th>Score</th>${cells.map((c) => `<td><span class="${c.cls}">${c.sc ?? ''}</span></td>`).join('')}<th>${any ? tot : ''}</th></tr></table>`;
    };
    const t = round.stats.totals();
    const toPar = t.strokes - t.par;
    s.innerHTML = `<div class="sc-head"><div><h2>${course.name}</h2><div class="muted">${course.location}</div></div>
      <div class="sc-total ${toPar < 0 ? 'under' : toPar > 0 ? 'over' : ''}">${round.scores.length ? toParStr(toPar) : '–'}<small>${t.strokes || ''}</small></div></div>
      ${half(0)}${half(9)}
      <div class="sc-stats">
        <div><span>Fairways</span><b>${t.fir}/${t.firN}</b></div><div><span>Greens in reg.</span><b>${t.gir}/${round.scores.length}</b></div>
        <div><span>Putts</span><b>${t.putts}</b></div><div><span>Penalties</span><b>${t.penalties}</b></div>
        <div><span>SG total</span><b class="${t.sgTotal >= 0 ? 'good' : 'bad'}">${round.scores.length ? sgn(t.sgTotal) : '–'}</b></div>
      </div>
      ${modal ? `<button class="btn primary" id="scNext">${label}</button>` : '<div class="muted small">Release Tab to close</div>'}`;
    s.classList.remove('hidden');
    if (modal) {
      const go = () => { s.classList.add('hidden'); document.body.classList.remove('sc-open'); removeEventListener('keydown', onKey, true); cb(); };
      const onKey = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } };
      $('scNext').onclick = go;
      setTimeout(() => addEventListener('keydown', onKey, true), 400);
    }
  }

  // ------------------------------------------------------------ summary
  summary(course, round, t, best, settings) {
    this.showHUD(false);
    this.game.meter.hide();
    const s = $('summary');
    const toPar = t.strokes - t.par;
    const cats = [['OTT', 'Off the tee'], ['APP', 'Approach'], ['ARG', 'Around the green'], ['PUTT', 'Putting']];
    const max = Math.max(1, ...cats.map(([k]) => Math.abs(t.sg[k])));
    const worst = cats.slice().sort((a, b) => t.sg[a[0]] - t.sg[b[0]])[0];
    const advice = {
      OTT: 'Your tee shots cost the most. Accuracy matters, but so does distance: Broadie found driving explains ~28% of the scoring gap between tour pros and amateurs. Try a club that keeps you out of penalty areas on tight holes.',
      APP: 'Approach shots are where scores are made – about 40% of the scoring difference between golfers. Pick the club whose average carry covers the plays-like number and aim at the fat part of the green.',
      ARG: 'Around the green, get the ball on the putting surface first. From just off the fringe a putt or low chip is usually the percentage play.',
      PUTT: 'Putting cost you strokes. Focus on lag speed from long range (leave it inside 3 ft) and on reading the low side – most misses are under-read.',
    }[worst[0]];
    s.innerHTML = `<h1>Round complete</h1>
      <div class="muted">${course.name} · ${PROFILESName(settings.profile)} · ${settings.difficulty}</div>
      <div class="sum-score ${toPar < 0 ? 'under' : toPar > 0 ? 'over' : ''}">${toParStr(toPar)}<small>${t.strokes} strokes · par ${t.par}</small></div>
      ${best ? `<div class="muted">Previous best: ${toParStr(best.toPar)} (${best.date})</div>` : ''}
      <div class="sum-grid">
        <div><span>Fairways hit</span><b>${t.fir}/${t.firN}</b></div>
        <div><span>Greens in regulation</span><b>${t.gir}/${round.scores.length}</b></div>
        <div><span>Putts</span><b>${t.putts}</b></div>
        <div><span>Penalty strokes</span><b>${t.penalties}</b></div>
      </div>
      <h3>Strokes gained vs. PGA Tour average</h3>
      <div class="sg-bars">${cats.map(([k, n]) => {
        const v = t.sg[k], w = (Math.abs(v) / max) * 50;
        return `<div class="sg-row"><span>${n}</span><div class="bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="width:${w}%;${v >= 0 ? 'left:50%' : `left:${50 - w}%`}"></i></div><b>${sgn(v)}</b></div>`;
      }).join('')}</div>
      <p class="sum-total">Total: <b>${sgn(t.sgTotal)}</b> strokes vs. a tour player over ${round.scores.length} holes.</p>
      <div class="tip"><b>Where to improve: ${worst[1]}</b><p>${advice}</p></div>
      <div class="row"><button class="btn primary" id="sumAgain">Play again</button><button class="btn" id="sumMenu">Main menu</button></div>`;
    s.classList.remove('hidden');
    $('sumAgain').onclick = () => { s.classList.add('hidden'); this.game.startRound({ courseId: course.id, holes: round.holes, mode: round.mode }); };
    $('sumMenu').onclick = () => { s.classList.add('hidden'); this.game.quitToMenu(); };
  }

  // ------------------------------------------------------------ pause / help
  togglePause() {
    const p = $('pause');
    this.paused = !this.paused;
    p.classList.toggle('hidden', !this.paused);
    if (!this.paused) return;
    const s = this.game.settings;
    p.innerHTML = `<h2>Paused</h2>
      <button class="btn primary" id="pResume">Resume</button>
      <button class="btn" id="pCard">Scorecard</button>
      <button class="btn" id="pHelp">How to play</button>
      <label class="set">Volume <input type="range" id="pVol" min="0" max="1" step="0.05" value="${s.volume}"></label>
      <label class="set"><input type="checkbox" id="pTracer" ${s.tracer ? 'checked' : ''}> Shot tracer</label>
      <label class="set">Swing control <select id="pCtl"><option value="meter" ${s.control === 'meter' ? 'selected' : ''}>3-click meter</option><option value="mouse" ${s.control === 'mouse' ? 'selected' : ''}>Analog mouse swing</option></select></label>
      <label class="set">Assists <select id="pDiff">${['beginner', 'standard', 'pro'].map((d) => `<option value="${d}" ${s.difficulty === d ? 'selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}</select></label>
      <button class="btn danger" id="pQuit">Quit to menu</button>`;
    $('pResume').onclick = () => this.togglePause();
    $('pCard').onclick = () => { this.togglePause(); this.scorecard(this.game.course, this.game.round, true, () => {}, 'Close'); };
    $('pHelp').onclick = () => { this.togglePause(); this.showHelp(true); };
    $('pVol').oninput = (e) => { s.volume = +e.target.value; this.game.audio.setVolume(s.volume); this.game.saveSettings(); };
    $('pTracer').onchange = (e) => { s.tracer = e.target.checked; this.game.saveSettings(); };
    $('pCtl').onchange = (e) => { s.control = e.target.value; this.game.saveSettings(); this.helpBar(); if (this.game.state === 'address') this.game.enterAddress(); };
    $('pDiff').onchange = (e) => { s.difficulty = e.target.value; this.game.saveSettings(); if (this.game.state === 'address') this.game.enterAddress(); };
    $('pQuit').onclick = () => { this.togglePause(); this.game.quitToMenu(); };
  }

  showHelp(on) {
    const h = $('help');
    h.classList.toggle('hidden', !on);
    if (!on) return;
    h.innerHTML = `<h2>How to play</h2>
      <div class="help-cols">
      <div><h3>3-Click swing meter <small>(Mario Golf)</small></h3>
        <ol><li>Press <b>Space</b> (or click) to start the swing.</li><li>Press again to set <b>power</b>. The blue marker is the caddie's suggestion for the pin. Past 100% (red) you gain distance but lose control.</li><li>Press a third time as the cursor returns to the green <b>impact zone</b>. Early = closed face (pull/hook). Late = open face (push/slice).</li></ol>
      <h3>Analog swing <small>(Tiger Woods PSP)</small></h3>
        <ol><li>Hold the left mouse button and pull <b>down</b> – that's the backswing length.</li><li>Push <b>up</b> past the start point to swing. A smooth, quick push gives full power.</li><li>Drifting left or right opens/closes the face; the stroke direction sets the club path.</li></ol></div>
      <div><h3>Shot setup</h3>
        <ul><li><b>← →</b> aim, <b>Shift</b> for fine aim. <b>P</b> re-aims at the pin. Click the mini-map, or press <b>V</b> and click the ground.</li>
        <li><b>↑ ↓</b> change club. Carry / total distances are shown for a full swing.</li>
        <li><b>Q / E</b> draw or fade: the club path is set in-to-out or out-to-in with the face between them (the D-plane).</li>
        <li><b>R / F</b> high or low trajectory (ball position/loft).</li>
        <li><b>Plays like</b> includes elevation and wind. The lie box shows how the lie affects distance (like Mario Golf's lie %).</li>
        <li><b>G</b> shows the green grid: colour = slope, and the dots flow downhill.</li>
        <li>Hold <b>Space</b> in flight to fast-forward. Right-drag orbits the camera and the wheel zooms.</li></ul>
      <h3>Learn while you play</h3>
        <p>After every shot you'll see launch-monitor numbers, <b>strokes gained</b> against a tour average, and coaching on why the ball did what it did. Open the <b>Golf Academy</b> from the menu to experiment in the ball-flight lab.</p></div>
      </div>
      <button class="btn primary" id="helpClose">Got it</button>`;
    $('helpClose').onclick = () => this.showHelp(false);
  }
}

function PROFILESName(k) { return PROFILES[k]?.name || k; }
