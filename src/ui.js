// DOM user interface: menus, HUD, shot panel, scorecard, summaries, stats and settings.
import { COURSES, courseById } from './courses/index.js';
import { PROFILES } from './clubs.js';
import { YD } from './hole.js';
import { SURFACES } from './physics.js';
import { DEFAULT_KEYS, ACTION_LABELS } from './config.js';
import { MODES, SIGNATURE, dailySpec, holesFor, challengeHash } from './round.js';
import { loadHistory, bestFor, handicapIndex, sgTrend, clearHistory, RATINGS } from './history.js';
import { firstRun } from './tutorial.js';
import { QUALITY } from './post.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const sgn = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
const toParStr = (d) => (d === 0 ? 'E' : d > 0 ? `+${d}` : `${d}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyName = (k) => ({ ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' }[k] || (k.length === 1 ? k.toUpperCase() : k));
const MODALS = ['relief', 'pause', 'help', 'summary', 'settings', 'stats', 'editor'];

export class UI {
  constructor() {
    this.paused = false;
    this.scModal = false;
    this.sel = { courseId: 'augusta', mode: '18', hole: 1, players: 1, names: ['Player 1', 'Player 2', 'Player 3', 'Player 4'] };
    try { Object.assign(this.sel, JSON.parse(localStorage.getItem('psg-sel') || '{}')); } catch (e) { /* ignore */ }
    if (!MODES[this.sel.mode] || this.sel.mode === 'daily') this.sel.mode = '18';
    this.toasts = $('toasts');
    $('minimap').addEventListener('pointerdown', (e) => this.minimapClick(e));
  }
  attach(game, academy, editor, tutorial) { this.game = game; this.academy = academy; this.editor = editor; this.tutorial = tutorial; }

  // is a dialog open that should swallow game input?
  modalOpen() {
    if (this.scModal) return true;
    if (!$('academy').classList.contains('hidden')) return true;
    return MODALS.some((id) => !$(id).classList.contains('hidden'));
  }
  key(action) { const ks = this.game.input.bindings[action] || []; return ks.length ? keyName(ks[0]) : '—'; }

  // ------------------------------------------------------------ main menu
  mainMenu() {
    const g = this.game;
    this.hideAll();
    document.body.classList.remove('in-round');
    $('menu').classList.remove('hidden');
    const history = loadHistory();
    const course = courseById(this.sel.courseId) || COURSES[0];

    // course tabs (the 3D signature hole behind the menu is the hero visual)
    const tabs = $('courseTabs');
    tabs.innerHTML = '';
    for (const c of COURSES) {
      const b = el('button', 'course-tab' + (c.id === course.id ? ' sel' : ''), `<span class="cc-flag"></span>${c.name}`);
      b.style.setProperty('--accent', c.flag);
      b.onclick = () => { this.sel.courseId = c.id; this.saveSel(); g.showcase(c.id); this.mainMenu(); };
      tabs.appendChild(b);
    }
    const par = course.holes.reduce((s, h) => s + h.par, 0);
    const yds = course.holes.reduce((s, h) => s + h.yds, 0);
    const bests = ['18', 'front', 'back'].map((m) => [m, bestFor(history, course.id, m)]).filter(([, b]) => b);
    const hero = $('courseHero');
    hero.style.setProperty('--accent', course.flag);
    hero.innerHTML = `
      <div class="cc-top"><span class="cc-flag"></span><div><div class="cc-name">${course.name}</div><div class="cc-loc">${course.location}</div></div></div>
      <div class="cc-meta">Par ${par} · ${yds.toLocaleString()} yds · Stimp ${course.stimp} · Wind ${course.wind[0]}–${course.wind[1]} mph${RATINGS[course.id] ? ` · Rating ${RATINGS[course.id][0]} / ${RATINGS[course.id][1]}` : ''}</div>
      <p class="cc-blurb">${course.blurb}</p>
      <div class="cc-teach"><b>Teaches</b><ul>${course.teaches.map((t) => `<li>${t}</li>`).join('')}</ul></div>
      ${bests.length ? `<div class="cc-best">${bests.map(([m, b]) => `Best ${MODES[m].name}: ${toParStr(b.toPar)} (${b.strokes})`).join(' · ')}</div>` : ''}`;

    // quick play: the signature hole, no setup
    const sig = SIGNATURE[course.id] ?? 0;
    const sh = course.holes[sig];
    if (this.tutorial && firstRun()) {
      // never played: the primary button is the guided hole
      $('btnQuick').innerHTML = 'Start here: guided first hole ▶<small>Augusta 12 · par 3 · about 5 minutes</small>';
      $('btnQuick').onclick = () => this.tutorial.start();
    } else {
      $('btnQuick').innerHTML = `Play a hole now ▶<small>${sig + 1}. ${sh.name} · par ${sh.par}</small>`;
      $('btnQuick').onclick = () => this.start({ courseId: course.id, holes: [sig], mode: 'single' });
    }
    $('btnPlay').innerHTML = `Tee off ▶<small>${MODES[this.sel.mode].name}${this.sel.players > 1 ? ` · ${this.sel.players} players` : ''}</small>`;
    $('btnPlay').onclick = () => this.play();

    // daily challenge
    const d = dailySpec();
    const dc = courseById(d.courseId);
    let dBest = null;
    try { dBest = JSON.parse(localStorage.getItem(`psg-daily-${d.key}`) || 'null'); } catch (e) { /* ignore */ }
    $('dailyCard').innerHTML = `<div class="lbl">Daily challenge · ${d.key}</div>
      <div><b>${dc.name}</b>, holes ${d.holes[0] + 1}–${d.holes[2] + 1}. Same pins and wind for everyone today.</div>
      <div class="muted small">${dBest ? `Your best today: <b>${toParStr(dBest.toPar)}</b> (${dBest.strokes})` : 'Not played yet today'}</div>`;
    $('dailyCard').onclick = () => { g.showcase(dc.id); this.start({ courseId: dc.id, holes: d.holes, mode: 'daily', seed: d.seed, daily: d.key }); };

    // shared challenge link
    const cb = $('challengeBanner');
    if (this.challenge) {
      const c = this.challenge, cc = courseById(c.courseId, c.seed);
      cb.innerHTML = `<div><b>Challenge received:</b> ${cc.name} · ${MODES[c.mode].name} · ${c.holes.length === 1 ? `hole ${c.holes[0] + 1}` : `${c.holes.length} holes`} – same pins and wind as your friend.</div>
        <div class="row"><button class="btn primary" id="chAccept">Accept</button><button class="btn" id="chDismiss">Dismiss</button></div>`;
      cb.classList.remove('hidden');
      $('chAccept').onclick = () => { const x = this.challenge; this.challenge = null; window.history.replaceState?.(null, '', location.pathname + location.search); g.showcase(x.courseId); this.start({ courseId: x.courseId, holes: x.holes, mode: x.mode, seed: x.seed }); };
      $('chDismiss').onclick = () => { this.challenge = null; window.history.replaceState?.(null, '', location.pathname + location.search); this.mainMenu(); };
    } else cb.classList.add('hidden');

    // options drawer
    const s = g.settings;
    const opt = (id, val, list) => {
      const box = $(id);
      box.innerHTML = '';
      for (const [k, label, title] of list) {
        const b = el('button', 'seg' + (String(k) === String(val) ? ' on' : ''), label);
        if (title) b.title = title;
        b.onclick = () => { this.setOpt(id, k); this.mainMenu(); };
        box.appendChild(b);
      }
    };
    opt('optMode', this.sel.mode, ['18', 'front', 'back', 'single', 'ctp', 'drive', 'random'].map((k) => [k, MODES[k].name, MODES[k].desc]));
    opt('optPlayers', this.sel.players, [[1, '1'], [2, '2'], [3, '3'], [4, '4']]);
    opt('optProfile', s.profile, Object.entries(PROFILES).map(([k, p]) => [k, p.name, p.desc]));
    opt('optDiff', s.difficulty, [['beginner', 'Beginner', 'Big impact zone, full aim preview with wind and roll, full putt line'], ['standard', 'Standard', 'Normal zone, carry preview without wind, partial putt line'], ['pro', 'Pro', 'Small zone, no wind/putt assistance – read it yourself']]);
    opt('optControl', s.control, [['meter', '3-Click Meter', 'Click to start, set power, hit the impact zone'], ['mouse', 'Analog Swing', 'Pull the mouse back, push it through straight']]);
    opt('optUnits', s.units, [['yd', 'Yards'], ['m', 'Metres']]);
    const hs = $('optHole');
    const pickHole = ['single', 'ctp', 'drive'].includes(this.sel.mode);
    hs.classList.toggle('hidden', !pickHole);
    hs.innerHTML = course.holes.map((h, i) => {
      const ok = this.sel.mode === 'ctp' ? h.par === 3 : this.sel.mode === 'drive' ? h.par >= 4 : true;
      return ok ? `<option value="${i + 1}" ${i + 1 === +this.sel.hole ? 'selected' : ''}>${i + 1}. ${h.name} – par ${h.par}, ${h.yds} yds</option>` : '';
    }).join('');
    hs.onchange = () => { this.sel.hole = +hs.value; this.saveSel(); };
    const names = $('optNames');
    names.innerHTML = '';
    for (let i = 0; i < this.sel.players && this.sel.players > 1; i++) {
      const inp = el('input', 'name-input');
      inp.value = this.sel.names[i] || `Player ${i + 1}`;
      inp.maxLength = 16;
      inp.oninput = () => { this.sel.names[i] = inp.value; this.saveSel(); };
      names.appendChild(inp);
    }
    $('profileDesc').textContent = PROFILES[s.profile].desc;
    const drawer = $('menuDrawer');
    drawer.open = !!this.sel.drawer;
    drawer.ontoggle = () => { this.sel.drawer = drawer.open; this.saveSel(); };
    $('btnAcademy').onclick = () => { this.academy.open(); };
    $('btnHow').onclick = () => this.showHelp(true);
    $('btnStats').onclick = () => this.showStats(true);
    $('btnEditor').onclick = () => this.editor.open();
    $('btnSettings').onclick = () => this.showSettings(true);
  }
  setOpt(id, k) {
    const s = this.game.settings;
    if (id === 'optMode') this.sel.mode = k;
    if (id === 'optPlayers') this.sel.players = +k;
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
    if (m === 'random') { this.start({ courseId: 'gen', holes: holesFor(m), mode: m }); return; }
    const holes = holesFor(m, this.sel.courseId, +this.sel.hole || 1);
    this.start({ courseId: this.sel.courseId, holes, mode: m });
  }
  start(opts) {
    $('menu').classList.add('hidden');
    document.body.classList.add('in-round');
    const players = opts.mode !== 'daily' && !opts.solo && this.sel.players > 1 ? this.sel.names.slice(0, this.sel.players).map((n, i) => (n || '').trim() || `Player ${i + 1}`) : null;
    this.game.startRound({ ...opts, players });
  }

  hideAll() {
    for (const id of ['menu', 'intro', 'scorecard', 'relief', 'pause', 'summary', 'shotPanel', 'help', 'settings', 'stats', 'editor']) $(id).classList.add('hidden');
    document.body.classList.remove('sc-open');
    this.scModal = false;
    this.paused = false;
    this.ffHint(false);
  }
  showHUD(on) {
    $('hud').classList.toggle('hidden', !on);
    $('helpBar').classList.toggle('hidden', !on);
    document.body.classList.toggle('in-round', on);
    if (on) this.helpBar();
  }
  helpBar() {
    const mouse = this.game.settings.control === 'mouse';
    const k = (a) => this.key(a);
    // key hints inside the club box follow the player's bindings
    $('kShapeL').textContent = k('shapeLeft'); $('kShapeR').textContent = k('shapeRight');
    $('kTrajU').textContent = k('trajUp'); $('kTrajD').textContent = k('trajDown');
    const swing = mouse ? '<b>Hold LMB</b> pull back, push up to swing' : `<b>${k('swing')}</b> swing`;
    const basics = [swing, `<b>${k('aimLeft')}${k('aimRight')}</b> aim (${k('aimFine')} fine)`, `<b>${k('clubUp')}${k('clubDown')}</b> club`];
    const items = this.game.settings.hudDetail === 'full' ? [
      ...basics,
      `<b>${k('shapeLeft')}/${k('shapeRight')}</b> draw/fade`, `<b>${k('trajUp')}/${k('trajDown')}</b> high/low`,
      `<b>${k('targetView')}</b> target view`, `<b>${k('grid')}</b> green grid`, `<b>${k('aimPin')}</b> aim at pin`,
      `<b>${k('scorecard')}</b> card`, `<b>${k('hudDetail')}</b> essential HUD`, `<b>${k('pause')}</b> menu`,
    ] : [...basics, `<b>${k('hudDetail')}</b> full HUD`, `<b>${k('pause')}</b> menu · all keys`];
    $('helpBar').innerHTML = items.map((x) => `<span>${x}</span>`).join('');
  }

  // ------------------------------------------------------------ loading / intro
  loading(on, text = '') {
    $('loading').classList.toggle('hidden', !on);
    $('loadingText').textContent = text;
  }
  holeIntro(hole, course, dist, wind, extra = '') {
    const i = $('intro');
    const def = course.holes[hole.index];
    i.innerHTML = `
      <div class="intro-num">${hole.number}</div>
      <div class="intro-body">
        <div class="intro-name">${hole.name}</div>
        <div class="intro-meta">Par ${hole.par} · ${dist} · Wind ${wind} · Stimp ${hole.stimp.toFixed(1)}</div>
        ${extra ? `<div class="intro-extra">${esc(extra)}</div>` : ''}
        ${def.tip ? `<p class="intro-tip">${def.tip}</p>` : ''}
        <div class="intro-skip">${this.key('swing')} / click to skip the flyover</div>
      </div>`;
    i.classList.remove('hidden');
  }
  hideIntro() { $('intro').classList.add('hidden'); }

  // ------------------------------------------------------------ HUD
  hud(d) {
    $('hcNum').textContent = d.hole;
    $('hcName').textContent = d.name;
    $('hcPar').textContent = `Par ${d.par} · ${this.game.fmtDist(d.yards * YD)}`;
    $('hcShot').textContent = (d.player ? `${d.player} · ` : '') + d.shot;
    $('hcScore').textContent = d.challenge ? '' : toParStr(d.toPar);
    $('hcScore').className = 'hc-score ' + (d.toPar < 0 ? 'under' : d.toPar > 0 ? 'over' : '');
    $('dPin').textContent = d.dist;
    let sub = '';
    if (d.plays) sub = `Plays like <b>${d.plays}</b>`;
    else if (d.puttEq != null) sub = `Stroke it <b>${d.puttEq.toFixed(0)} ft</b><br><small>to finish 17 in past</small>`;
    const e = Math.round(d.elev);
    if (Math.abs(e) >= 1) sub += `<span class="elev">${e > 0 ? '▲' : '▼'} ${Math.abs(e)} ft ${e > 0 ? 'uphill' : 'downhill'}</span>`;
    const sl = d.slope, parts = [];
    if (Math.abs(sl.up) >= 1.5) parts.push(`${sl.up > 0 ? 'Uphill' : 'Downhill'} ${Math.abs(sl.up).toFixed(0)}°`);
    if (Math.abs(sl.side) >= 1.5) parts.push(`Ball ${sl.side > 0 ? 'above' : 'below'} feet ${Math.abs(sl.side).toFixed(0)}°`);
    if (this.game.settings.hudDetail !== 'full') {
      // essential HUD: the lie box is hidden, so its one useful line lives here
      const lie = d.putter ? `Stimp ${d.stimp.toFixed(1)}` : [d.lieRange === '100–100%' ? '' : d.lieRange, ...parts].filter(Boolean).join(' · ');
      sub += `<span class="lie-line" data-lie="${d.lieKey}"><b>${esc(d.lie)}</b> <span class="lie-range">${lie}</span></span>`;
    }
    $('dSub').innerHTML = sub;
    $('hud').dataset.state = d.state;
    const w = d.wind;
    $('windArrow').style.transform = `rotate(${w.ang}rad)`;
    $('windMph').textContent = `${Math.round(d.windMph)}`;
    const wt = [];
    if (Math.abs(w.along) >= 1.5) wt.push(w.along > 0 ? 'Helping' : 'Into');
    if (Math.abs(w.side) >= 1.5) wt.push(w.side > 0 ? 'L → R' : 'R → L');
    $('windTxt').textContent = wt.join(' · ') || 'Calm';
    $('clubName').textContent = d.club.name;
    $('clubKey').textContent = d.club.key;
    $('clubDist').textContent = d.clubCarry;
    $('shapeVal').textContent = d.putter ? '—' : d.shape;
    $('trajVal').textContent = d.putter ? '—' : d.traj;
    $('shapeRow').classList.toggle('dim', d.putter);
    $('lieName').textContent = d.lie;
    $('lieRange').textContent = d.putter ? `Stimp ${d.stimp.toFixed(1)}` : d.lieRange;
    $('lieSlope').textContent = d.putter ? '' : parts.join(' · ') || 'Flat lie';
    $('lieBox').dataset.lie = d.lieKey;
  }

  minimap(game) {
    const cv = $('minimap');
    const W = game.world, h = game.hole;
    if (!W.textureCanvas || !h) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !ch) return;
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
    g.beginPath(); if (g.roundRect) g.roundRect(0, 0, cw, ch, 10); else g.rect(0, 0, cw, ch); g.clip();
    g.fillStyle = '#23402a'; g.fillRect(0, 0, cw, ch);
    g.drawImage(W.textureCanvas, ox, oy, bw * s, bd * s);
    if (W.hazardCanvas) g.drawImage(W.hazardCanvas, ox, oy, bw * s, bd * s); // hatched penalty areas
    const P = (x, z) => [ox + (x - B.minX) * s, oy + (z - B.minZ) * s];
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
    if (game.sim && (game.state === 'flight' || game.state === 'result')) {
      const tr = game.sim.trail;
      g.strokeStyle = '#ff5a40'; g.lineWidth = 1.5;
      g.beginPath();
      tr.forEach((p, i) => { const [x, y] = P(p[0], p[2]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      const [x2, y2] = P(game.sim.p[0], game.sim.p[2]); g.lineTo(x2, y2);
      g.stroke();
    }
    const [px, py] = P(h.cup.x, h.cup.z);
    g.fillStyle = game.course.flag; g.strokeStyle = '#000'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px, py); g.lineTo(px, py - 10); g.lineTo(px + 7, py - 7); g.lineTo(px, py - 4); g.fill(); g.stroke();
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
    g.aimAtWorld(B.minX + (e.clientX - r.left - ox) / s, B.minZ + (e.clientY - r.top - oy) / s);
    e.stopPropagation();
  }

  caddie(text) {
    const c = $('caddie');
    if (!text) { c.classList.add('hidden'); return; }
    if (c.dataset.text !== text) { c.dataset.text = text; $('caddieText').textContent = text; }
    c.classList.remove('hidden');
  }

  toast(text, kind = '') {
    const t = el('div', 'toast ' + kind);
    t.textContent = text;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 1900);
    setTimeout(() => t.remove(), 2400);
  }
  banner(text, kind = '', ms = 2600) {
    const b = $('banner');
    b.className = 'banner ' + kind;
    b.textContent = text;
    void b.offsetWidth; // restart the CSS transition
    b.classList.add('show');
    clearTimeout(this.bannerT);
    this.bannerT = setTimeout(() => b.classList.remove('show'), ms);
  }
  // text captions for sound cues (accessibility)
  caption(text) {
    const c = $('captions');
    c.textContent = text;
    c.classList.add('show');
    clearTimeout(this.capT);
    this.capT = setTimeout(() => c.classList.remove('show'), 2200);
  }
  ffHint(on) {
    const h = $('ffHint');
    if (!h) return;
    if (on) h.innerHTML = `Hold <b>${this.key('fastForward')}</b> to fast-forward · <b>${this.key('skip')}</b> to skip`;
    h.classList.toggle('hidden', !on);
  }

  // ------------------------------------------------------------ shot panel
  showShotPanel(o) {
    const p = $('shotPanel');
    if (!o) { p.classList.add('hidden'); return; }
    const { info, sg, tips, extra, canReplay } = o;
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
    const exHtml = extra ? `<div class="sp-extra ${extra.isBest ? 'best' : ''}"><span>${extra.title}</span><b>${extra.label}</b><small>Best so far: ${extra.best}</small></div>` : '';
    const tipsHtml = tips.map((t) => `<div class="tip"><b>${t.title}</b><p>${t.text}</p></div>`).join('');
    p.innerHTML = `
      <div class="sp-head">${info.putt ? 'Putt' : 'Launch monitor'}</div>
      ${exHtml}
      <div class="sp-grid">${rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      ${sgHtml}
      ${tipsHtml ? `<div class="sp-tips"><div class="sp-sub">Coach</div>${tipsHtml}</div>` : ''}
      <div class="sp-cont">${this.key('swing')} / click to continue${canReplay ? ` · <b>${this.key('replay')}</b> replay` : ''}</div>`;
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
      b.innerHTML = `<b>${o.title}${o.es === best ? ' <span class="tag">best</span>' : ''}</b><p>${o.desc}</p><div><span>${fmt(o.dist)} to pin</span><span>${o.isTee ? 'Tee' : SURFACES[o.surface]?.name || o.surface}</span><span>Expected ${o.es.toFixed(2)}</span></div>`;
      b.onclick = () => cb(o);
      box.appendChild(b);
    }
    r.classList.remove('hidden');
  }

  // ------------------------------------------------------------ scorecard
  scorecard(course, round, modal, cb, label) {
    const s = $('scorecard');
    document.body.classList.toggle('sc-open', !!course);
    if (!course) { s.classList.add('hidden'); this.scModal = false; return; }
    const players = round.players;
    const multi = players.length > 1;
    const cls = (d) => (d == null ? '' : d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'dbl');
    const half = (from) => {
      const holes = course.holes.slice(from, from + 9);
      const nums = holes.map((h, i) => from + i + 1);
      const scoreRow = (pl) => {
        const byNum = {};
        for (const x of pl.scores) byNum[x.number] = x;
        let tot = 0, any = false;
        const cells = holes.map((h, i) => {
          const rec = byNum[nums[i]], sc = rec?.strokes;
          if (sc != null) { tot += sc; any = true; }
          const pick = rec?.pickedUp ? ' pickup" title="Picked up: maximum strokes reached' : '';
          return `<td><span class="${cls(sc != null ? sc - h.par : null)}${pick}">${sc ?? ''}${rec?.pickedUp ? '<i>*</i>' : ''}</span></td>`;
        }).join('');
        return `<tr class="sc"><th>${multi ? esc(pl.name) : 'Score'}</th>${cells}<th>${any ? tot : ''}</th></tr>`;
      };
      return `<table><tr class="num"><th>Hole</th>${nums.map((n) => `<td>${n}</td>`).join('')}<th>${from ? 'In' : 'Out'}</th></tr>
        <tr class="yd"><th>Yards</th>${holes.map((h) => `<td>${h.yds}</td>`).join('')}<th>${holes.reduce((a, h) => a + h.yds, 0)}</th></tr>
        <tr class="par"><th>Par</th>${holes.map((h) => `<td>${h.par}</td>`).join('')}<th>${holes.reduce((a, h) => a + h.par, 0)}</th></tr>
        ${players.map(scoreRow).join('')}</table>`;
    };
    const lead = players.map((pl) => ({ pl, t: pl.stats.totals() }));
    const t = lead[0].t;
    const toPar = t.strokes - t.par;
    const n = round.players[0].scores.length;
    const totals = multi
      ? `<div class="sc-board">${lead.slice().sort((a, b) => (a.t.strokes - a.t.par) - (b.t.strokes - b.t.par)).map(({ pl, t: x }) => `<div><span>${esc(pl.name)}</span><b>${pl.scores.length ? toParStr(x.strokes - x.par) : '–'}</b></div>`).join('')}</div>`
      : `<div class="sc-total ${toPar < 0 ? 'under' : toPar > 0 ? 'over' : ''}">${n ? toParStr(toPar) : '–'}<small>${t.strokes || ''}</small></div>`;
    s.innerHTML = `<div class="sc-head"><div><h2>${course.name}</h2><div class="muted">${course.location}</div></div>${totals}</div>
      ${half(0)}${half(9)}
      ${multi ? '' : `<div class="sc-stats">
        <div><span>Fairways</span><b>${t.fir}/${t.firN}</b></div><div><span>Greens in reg.</span><b>${t.gir}/${n}</b></div>
        <div><span>Putts</span><b>${t.putts}</b></div><div><span>Penalties</span><b>${t.penalties}</b></div>
        <div><span>SG total</span><b class="${t.sgTotal >= 0 ? 'good' : 'bad'}">${n ? sgn(t.sgTotal) : '–'}</b></div>
      </div>`}
      ${modal ? `<button class="btn primary" id="scNext">${label}</button>` : `<div class="muted small">Release ${this.key('scorecard')} to close</div>`}`;
    s.classList.remove('hidden');
    this.scModal = !!modal;
    if (modal) {
      const go = () => { s.classList.add('hidden'); document.body.classList.remove('sc-open'); this.scModal = false; removeEventListener('keydown', onKey, true); cb(); };
      const onKey = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } };
      $('scNext').onclick = go;
      setTimeout(() => addEventListener('keydown', onKey, true), 400);
    }
  }

  // ------------------------------------------------------------ summaries
  summary(course, round, t, best, settings) {
    this.showHUD(false);
    this.game.meter.hide();
    const s = $('summary');
    const multi = round.players.length > 1;
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
    const hcp = multi ? null : handicapIndex(loadHistory());
    const board = multi ? `<h3>Leaderboard</h3><div class="sc-board big">${round.players.map((pl) => ({ pl, t: pl.stats.totals() })).sort((a, b) => a.t.strokes - b.t.strokes).map(({ pl, t: x }, i) => `<div><span>${i === 0 ? '🏆 ' : ''}${esc(pl.name)}</span><b>${toParStr(x.strokes - x.par)} <small>${x.strokes}</small></b></div>`).join('')}</div>` : '';
    const n = round.players[0].scores.length;
    s.innerHTML = `<h1>${round.daily ? 'Daily challenge complete' : 'Round complete'}</h1>
      <div class="muted">${course.name} · ${MODES[round.mode]?.name || ''} · ${PROFILES[settings.profile]?.name || settings.profile} · ${settings.difficulty}</div>
      ${board}
      <div class="sum-score ${toPar < 0 ? 'under' : toPar > 0 ? 'over' : ''}">${toParStr(toPar)}<small>${multi ? `${esc(round.players[0].name)} · ` : ''}${t.strokes} strokes · par ${t.par}</small></div>
      ${best ? `<div class="muted">Previous best: ${toParStr(best.toPar)} (${best.date})</div>` : ''}
      ${hcp != null ? `<div class="muted">Handicap index estimate: <b>${hcp.toFixed(1)}</b></div>` : ''}
      <div class="sum-grid">
        <div><span>Fairways hit</span><b>${t.fir}/${t.firN}</b></div>
        <div><span>Greens in regulation</span><b>${t.gir}/${n}</b></div>
        <div><span>Putts</span><b>${t.putts}</b></div>
        <div><span>Penalty strokes</span><b>${t.penalties}</b></div>
      </div>
      <h3>Strokes gained vs. PGA Tour average</h3>
      <div class="sg-bars">${cats.map(([k, nm]) => {
        const v = t.sg[k], w = (Math.abs(v) / max) * 50;
        return `<div class="sg-row"><span>${nm}</span><div class="bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="width:${w}%;${v >= 0 ? 'left:50%' : `left:${50 - w}%`}"></i></div><b>${sgn(v)}</b></div>`;
      }).join('')}</div>
      <p class="sum-total">Total: <b>${sgn(t.sgTotal)}</b> strokes vs. a tour player over ${n} holes.</p>
      <div class="tip"><b>Where to improve: ${worst[1]}</b><p>${advice}</p></div>
      <div class="row wrap"><button class="btn primary" id="sumAgain">Play again</button><button class="btn" id="sumShare">Copy challenge link</button><button class="btn" id="sumMenu">Main menu</button></div>`;
    s.classList.remove('hidden');
    this.summaryButtons(course, round);
  }

  challengeSummary(course, round, fmt) {
    this.showHUD(false);
    const s = $('summary');
    const ctp = round.mode === 'ctp';
    const rows = round.players.map((pl) => {
      const vals = pl.attempts.filter((v) => v != null);
      const best = vals.length ? (ctp ? Math.min(...vals) : Math.max(...vals)) : null;
      return { pl, best };
    }).sort((a, b) => (a.best == null) - (b.best == null) || (ctp ? a.best - b.best : b.best - a.best));
    const solo = rows.length > 1 && rows[0].best != null && rows[0].best !== rows[1].best;
    const show = (v) => (v == null ? 'No score' : ctp ? (v === 0 ? 'Hole in one!' : `${v.toFixed(1)} ft`) : fmt(v * YD));
    s.innerHTML = `<h1>${MODES[round.mode].name}</h1>
      <div class="muted">${course.name} · hole ${round.holes[0] + 1}</div>
      <div class="sc-board big">${rows.map(({ pl, best }, i) => `<div><span>${i === 0 && solo ? '🏆 ' : ''}${esc(pl.name || 'Best')}</span><b>${show(best)}</b></div>`).join('')}</div>
      ${round.players.map((pl) => `<div class="attempts"><span>${esc(pl.name || 'Your balls')}</span>${pl.attempts.map((v) => `<i class="${v == null ? 'miss' : ''}">${v == null ? '✕' : ctp ? `${v.toFixed(0)} ft` : fmt(v * YD)}</i>`).join('')}</div>`).join('')}
      <div class="row wrap"><button class="btn primary" id="sumAgain">Play again</button><button class="btn" id="sumShare">Copy challenge link</button><button class="btn" id="sumMenu">Main menu</button></div>`;
    s.classList.remove('hidden');
    this.summaryButtons(course, round);
  }

  summaryButtons(course, round) {
    const s = $('summary');
    const players = round.players.length > 1 ? round.players.map((p) => p.name) : null;
    $('sumAgain').onclick = () => { s.classList.add('hidden'); this.game.startRound({ courseId: course.id, holes: round.holes, mode: round.mode, players, seed: course.generated ? round.seed : undefined }); };
    $('sumMenu').onclick = () => { s.classList.add('hidden'); this.game.quitToMenu(); };
    $('sumShare').onclick = async () => {
      const url = location.origin + location.pathname + challengeHash(round);
      try { await navigator.clipboard.writeText(url); this.toast('Challenge link copied – same pins and wind for whoever opens it', 'good'); }
      catch (e) { prompt('Copy this challenge link:', url); }
    };
  }

  // ------------------------------------------------------------ pause
  togglePause() {
    const p = $('pause');
    this.paused = !this.paused;
    p.classList.toggle('hidden', !this.paused);
    if (!this.paused) return;
    p.innerHTML = `<h2>Paused</h2>
      <button class="btn primary" id="pResume">Resume</button>
      <button class="btn" id="pCard">Scorecard</button>
      <button class="btn" id="pSettings">Settings & controls</button>
      <button class="btn" id="pHelp">How to play</button>
      <button class="btn danger" id="pQuit">Quit to menu</button>`;
    $('pResume').onclick = () => this.togglePause();
    $('pCard').onclick = () => { this.togglePause(); this.scorecard(this.game.course, this.game.round, true, () => {}, 'Close'); };
    $('pSettings').onclick = () => { this.togglePause(); this.showSettings(true); };
    $('pHelp').onclick = () => { this.togglePause(); this.showHelp(true); };
    $('pQuit').onclick = () => { this.togglePause(); this.game.quitToMenu(); };
  }

  // ------------------------------------------------------------ settings (incl. accessibility + key remap)
  qualityDesc() {
    const q = this.game.settings.quality || 'auto', p = this.game.post;
    return q === 'auto' ? `${QUALITY.auto.desc} Currently ${p.tier}.` : QUALITY[q].desc;
  }
  showSettings(on) {
    const box = $('settings');
    box.classList.toggle('hidden', !on);
    if (!on) { this.game.input.capture = null; return; }
    const g = this.game, s = g.settings;
    const chk = (id, label, val, desc) => `<label class="set"><span>${label}${desc ? `<small>${desc}</small>` : ''}</span><input type="checkbox" id="${id}" ${val ? 'checked' : ''}></label>`;
    const binds = g.input.bindings;
    box.innerHTML = `<h2>Settings</h2>
      <div class="set-cols"><div>
      <h3>Game</h3>
      <label class="set"><span>Volume</span><input type="range" id="sVol" min="0" max="1" step="0.05" value="${s.volume}"></label>
      ${chk('sTracer', 'Shot tracer', s.tracer)}
      <label class="set"><span>Swing control</span><select id="sCtl"><option value="meter" ${s.control === 'meter' ? 'selected' : ''}>3-click meter</option><option value="mouse" ${s.control === 'mouse' ? 'selected' : ''}>Analog mouse swing</option></select></label>
      <label class="set"><span>Assists</span><select id="sDiff">${['beginner', 'standard', 'pro'].map((d) => `<option value="${d}" ${s.difficulty === d ? 'selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}</select></label>
      <label class="set"><span>Graphics<small id="sQualDesc">${this.qualityDesc()}</small></span><select id="sQual">${Object.keys(QUALITY).map((q) => `<option value="${q}" ${(s.quality || 'auto') === q ? 'selected' : ''}>${QUALITY[q].name}</option>`).join('')}</select></label>
      <label class="set"><span>HUD detail<small>Essential folds the lie into the distance panel and hides the minimap and shape row until you use them. ${this.key('hudDetail')} toggles in play.</small></span><select id="sHud"><option value="essential" ${s.hudDetail !== 'full' ? 'selected' : ''}>Essential</option><option value="full" ${s.hudDetail === 'full' ? 'selected' : ''}>Full</option></select></label>
      <h3>Accessibility</h3>
      ${chk('sOne', 'One-button swing', s.oneButton, 'Power is set to the caddie’s number – you only time the impact.')}
      ${chk('sReduce', 'Reduced motion', s.reducedMotion, 'No flyovers, slow-motion or camera punches.')}
      ${chk('sCap', 'Sound captions', s.captions, 'On-screen text for crowd, cup and splash sounds.')}
      <label class="set"><span>Interface size</span><input type="range" id="sScale" min="0.8" max="1.5" step="0.05" value="${s.uiScale}"></label>
      </div><div>
      <h3>Keyboard</h3>
      <div class="remap">${Object.keys(DEFAULT_KEYS).map((a) => `<div class="remap-row"><span>${ACTION_LABELS[a]}</span><button class="seg" data-act="${a}">${binds[a].map(keyName).join(' / ')}</button></div>`).join('')}</div>
      <button class="btn small-btn" id="sKeysReset">Reset keys</button>
      <p class="muted small">Gamepad: A swing · B skip · X fade · Y view/replay · LB/RB club · D-pad aim &amp; flight · right stick: pull back then push up for a tempo swing.</p>
      </div></div>
      <button class="btn primary" id="sClose">Done</button>`;
    const save = () => { g.saveSettings(); this.helpBar(); if (g.state === 'address') g.enterAddress(); };
    $('sVol').oninput = (e) => { s.volume = +e.target.value; g.audio.setVolume(s.volume); g.saveSettings(); };
    $('sTracer').onchange = (e) => { s.tracer = e.target.checked; save(); };
    $('sCtl').onchange = (e) => { s.control = e.target.value; save(); };
    $('sDiff').onchange = (e) => { s.difficulty = e.target.value; save(); };
    $('sHud').onchange = (e) => { s.hudDetail = e.target.value; save(); g.updateHUD(true); };
    $('sQual').onchange = (e) => { s.quality = e.target.value; g.saveSettings(); g.post.setQuality(s.quality); $('sQualDesc').textContent = this.qualityDesc(); };
    $('sOne').onchange = (e) => { s.oneButton = e.target.checked; save(); };
    $('sReduce').onchange = (e) => { s.reducedMotion = e.target.checked; save(); };
    $('sCap').onchange = (e) => { s.captions = e.target.checked; save(); };
    $('sScale').oninput = (e) => { s.uiScale = +e.target.value; g.saveSettings(); };
    $('sKeysReset').onclick = () => { s.keys = {}; save(); this.showSettings(true); };
    $('sClose').onclick = () => this.showSettings(false);
    for (const b of box.querySelectorAll('.remap [data-act]')) {
      b.onclick = () => {
        const a = b.dataset.act;
        b.textContent = 'Press a key…';
        b.classList.add('on');
        g.input.capture = (e) => {
          g.input.capture = null;
          if (e.key !== 'Escape') {
            const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            s.keys = { ...s.keys, [a]: [k] };
            save();
          }
          this.showSettings(true);
        };
      };
    }
  }

  // ------------------------------------------------------------ stats
  showStats(on) {
    const box = $('stats');
    box.classList.toggle('hidden', !on);
    if (!on) return;
    const hist = loadHistory();
    const mine = hist.filter((r) => !r.player);
    const hcp = handicapIndex(hist);
    const trend = sgTrend(hist, 20);
    const cats = [['OTT', 'Off the tee', '#5fd4ff'], ['APP', 'Approach', '#f4d31f'], ['ARG', 'Around the green', '#4fd07a'], ['PUTT', 'Putting', '#ff8d83']];
    const spark = (key, color) => {
      if (trend.length < 2) return '';
      const vals = trend.map((t) => t[key]);
      const m = Math.max(2, ...vals.map(Math.abs));
      const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 200},${30 - (v / m) * 26}`).join(' ');
      return `<svg viewBox="0 0 200 60" class="spark" role="img" aria-label="trend"><line x1="0" y1="30" x2="200" y2="30" stroke="rgba(255,255,255,.25)"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
    };
    const avg = (k) => (trend.length ? trend.reduce((s, t) => s + t[k], 0) / trend.length : 0);
    const bests = COURSES.flatMap((c) => ['18', 'front', 'back', 'single', 'daily'].map((m) => [c, m, bestFor(hist, c.id, m)])).filter((x) => x[2]);
    box.innerHTML = `<h2>My stats</h2>
      ${mine.length ? `
      <div class="sum-grid">
        <div><span>Handicap index (est.)</span><b>${hcp != null ? hcp.toFixed(1) : '—'}</b></div>
        <div><span>Rounds played</span><b>${mine.length}</b></div>
        <div><span>Holes played</span><b>${mine.reduce((s, r) => s + r.holes, 0)}</b></div>
        <div><span>SG / 18 (last ${trend.length})</span><b class="${avg('total') >= 0 ? 'good' : 'bad'}">${trend.length ? sgn(avg('total'), 1) : '—'}</b></div>
      </div>
      ${hcp == null ? '<p class="muted small">Play three 18-hole rounds (or six 9s) for a handicap estimate.</p>' : '<p class="muted small">World Handicap System method with approximate course ratings – an estimate, not an official index.</p>'}
      <h3>Strokes gained per 18 – trend</h3>
      ${trend.length ? '' : '<p class="muted small">Trends appear once you finish a 9- or 18-hole round.</p>'}
      <div class="trend ${trend.length ? '' : 'hidden'}">${cats.map(([k, n, c]) => `<div><span>${n}</span><b class="${avg(k) >= 0 ? 'good' : 'bad'}">${sgn(avg(k), 1)}</b>${spark(k, c)}</div>`).join('')}</div>
      <h3>Personal bests</h3>
      <div class="bests">${bests.map(([c, m, b]) => `<div><span>${c.name} · ${MODES[m]?.name || m}</span><b>${toParStr(b.toPar)} (${b.strokes})</b><small>${b.date}</small></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
      <h3>Recent rounds</h3>
      <table class="hist"><tr><th>Date</th><th>Course</th><th>Mode</th><th>Score</th><th>Putts</th><th>SG</th></tr>
      ${mine.slice(-12).reverse().map((r) => `<tr><td>${r.date.slice(0, 10)}</td><td>${r.course === 'gen' ? 'Random course' : r.course === 'custom' ? 'Custom course' : courseById(r.course)?.name || r.course}</td><td>${MODES[r.mode]?.name || r.mode}</td><td>${toParStr(r.strokes - r.par)} (${r.strokes})</td><td>${r.putts}</td><td class="${r.sgTotal >= 0 ? 'good' : 'bad'}">${sgn(r.sgTotal, 1)}</td></tr>`).join('')}</table>
      ` : '<p class="muted">No rounds yet. Finish a round and your scores, strokes-gained trends and a handicap estimate appear here.</p>'}
      <div class="row wrap"><button class="btn primary" id="stClose">Close</button>${mine.length ? '<button class="btn danger" id="stClear">Clear history</button>' : ''}</div>`;
    $('stClose').onclick = () => this.showStats(false);
    const clr = $('stClear');
    if (clr) clr.onclick = () => { if (confirm('Delete all saved rounds? This cannot be undone.')) { clearHistory(); this.showStats(true); } };
  }

  // ------------------------------------------------------------ help
  showHelp(on) {
    const h = $('help');
    h.classList.toggle('hidden', !on);
    if (!on) return;
    const k = (a) => this.key(a);
    h.innerHTML = `<h2>How to play</h2>
      <div class="help-cols">
      <div><h3>3-Click swing meter</h3>
        <ol><li>Press <b>${k('swing')}</b> (or click) to start the swing.</li><li>Press again to set <b>power</b>. The blue marker is the caddie's suggestion for the pin. Past 100% (red) you gain distance but lose control.</li><li>Press a third time as the cursor returns to the green <b>impact zone</b>. Early = closed face (pull/hook). Late = open face (push/slice).</li></ol>
        <p class="muted small">One-button swing (Settings → Accessibility) sets the power for you.</p>
      <h3>Analog swing</h3>
        <ol><li>Hold the left mouse button and pull <b>down</b> – that's the backswing length.</li><li>Push <b>up</b> past the start point to swing. A smooth, quick push gives full power.</li><li>Drifting left or right opens/closes the face; the stroke direction sets the club path.</li></ol>
        <p class="muted small">Gamepad: the right stick does the same – pull back, then push up.</p></div>
      <div><h3>Shot setup</h3>
        <ul><li><b>${k('aimLeft')} ${k('aimRight')}</b> aim, <b>${k('aimFine')}</b> for fine aim. <b>${k('aimPin')}</b> re-aims at the pin. Click the mini-map, or press <b>${k('targetView')}</b> and click the ground.</li>
        <li><b>${k('clubUp')} ${k('clubDown')}</b> change club. Carry / total distances are shown for a full swing.</li>
        <li><b>${k('shapeLeft')} / ${k('shapeRight')}</b> draw or fade: the club path is set in-to-out or out-to-in with the face between them (the D-plane).</li>
        <li><b>${k('trajUp')} / ${k('trajDown')}</b> high or low trajectory.</li>
        <li><b>Plays like</b> includes elevation and wind. The lie box shows how the lie affects distance.</li>
        <li><b>${k('grid')}</b> shows the green grid: colour = slope, and the dots flow downhill.</li>
        <li>In flight: hold <b>${k('fastForward')}</b> to fast-forward, <b>${k('skip')}</b> skips to where it finishes. <b>${k('replay')}</b> replays the shot from a new angle.</li>
        <li>Right-drag (or one-finger drag) orbits the camera; the wheel zooms.</li></ul>
      <h3>Learn while you play</h3>
        <p>After every shot you'll see launch-monitor numbers, <b>strokes gained</b> against a tour average, and coaching on why the ball did what it did. Open the <b>Golf Academy</b> from the menu to experiment in the ball-flight lab.</p></div>
      </div>
      <div class="help-btns">${this.tutorial && !this.game.round ? '<button class="btn" id="helpTut">Guided first hole</button>' : ''}<button class="btn primary" id="helpClose">Got it</button></div>`;
    $('helpClose').onclick = () => this.showHelp(false);
    const t = $('helpTut');
    if (t) t.onclick = () => { this.showHelp(false); this.tutorial.start(); };
  }
}
