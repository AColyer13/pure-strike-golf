// DOM user interface: menus, HUD, shot panel, scorecard, summaries, stats and settings.
import { COURSES, courseById } from './courses/index.js';
import { CADDIES, CADDIE_IDS } from './caddies.js';
import { TEMPOS, TEMPO_IDS } from './swing.js';
import { PROFILES, TEE_FOR_PROFILE } from './clubs.js';
import { YD, TEE_SETS, teeYds } from './hole.js';
import { SURFACES } from './physics.js';
import { DEFAULT_KEYS, ACTION_LABELS, DIFFICULTY } from './config.js';
import { MODES, dailySpec, holesFor, challengeHash, challengeScore, RESUME_KEY, resumable, restoreRound } from './round.js';
import { loadHistory, bestFor, handicapIndex, sgTrend, clearHistory, localDay, RATINGS } from './history.js';
import { QUALITY } from './post.js';
import { fmtYd, fmtFt, fmtElev, windUnit, windValue, localizeText } from './units.js';
import { clamp } from './util.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
// signed number; a value that rounds to zero is "+0.0", never "-0.0"
const sgn = (x, d = 2) => { const v = +x.toFixed(d); return (v >= 0 ? '+' : '') + (v === 0 ? (0).toFixed(d) : v.toFixed(d)); };
// On a phone the caddie's note has two or three lines of room: end it at a sentence rather than
// let the line clamp cut it mid-thought. The full text stays in the tooltip / on desktop.
const caddieBrief = (text) => {
  const max = innerHeight <= 600 ? 90 : 140;
  const parts = text.match(/.+?[.!?]+(?=\s|$)\s*|.+$/g) || [text]; // a full stop inside a number (4.15) doesn't end a sentence
  let out = parts[0].trim();
  for (let i = 1; i < parts.length && (out + ' ' + parts[i].trim()).length <= max; i++) out += ' ' + parts[i].trim();
  return out;
};
// "2026-10-18" (a local calendar day) as "Sun 18 Oct"
const dayLabel = (key) => {
  const [y, m, d] = String(key).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? String(key) : dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};
const toParStr = (d) => (d === 0 ? 'E' : d > 0 ? `+${d}` : `${d}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyName = (k) => ({ ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' }[k] || (k.length === 1 ? k.toUpperCase() : k));
// the touch buttons that stand in for each keyboard action (input.js dispatches the same names)
const TOUCH_LABELS = {
  swing: 'SWING', aimLeft: '◀', aimRight: '▶', clubUp: '▲', clubDown: '▼', aimPin: '⚑', targetView: 'view',
  shapeLeft: 'shape', shapeRight: 'shape', trajUp: 'flight', trajDown: 'flight', skip: 'skip', replay: 'view',
  fastForward: '▶▶', pause: '☰',
};
// actions that share a key without clashing: they only act in different states (a held Space is
// swing on the tee and fast-forward in flight), so only keys that collide inside a group are a conflict
const KEY_GROUPS = {
  address: ['swing', 'clubUp', 'clubDown', 'aimLeft', 'aimRight', 'aimFine', 'shapeLeft', 'shapeRight', 'trajUp', 'trajDown', 'targetView', 'grid', 'caddie', 'aimPin'],
  flight: ['fastForward', 'skip', 'replay'],
  always: ['mute', 'scorecard', 'pause'],
};
const groupsOf = (a) => Object.entries(KEY_GROUPS).filter(([, l]) => l.includes(a)).map(([g]) => g);
// the action that already uses key `k` in a state where `a` is also live, if any
export function keyConflict(bindings, a, k) {
  const mine = groupsOf(a);
  for (const [other, ks] of Object.entries(bindings)) {
    if (other === a || !ks.includes(k)) continue;
    const theirs = groupsOf(other);
    if (mine.includes('always') || theirs.includes('always') || mine.some((g) => theirs.includes(g))) return other;
  }
  return null;
}
const MODALS = ['confirmBox', 'relief', 'pause', 'help', 'summary', 'settings', 'stats'];

export class UI {
  constructor() {
    this.paused = false;
    this.scModal = false;
    this.sel = { courseId: 'augusta', mode: '18', hole: 1 };
    try { Object.assign(this.sel, JSON.parse(localStorage.getItem('psg-sel') || '{}')); } catch (e) { /* ignore */ }
    if (!MODES[this.sel.mode] || this.sel.mode === 'daily') this.sel.mode = '18';
    // a saved choice of a course that isn't a menu tab (e.g. the random course) would break Tee off
    if (!COURSES.some((c) => c.id === this.sel.courseId)) this.sel.courseId = 'augusta';
    this.toasts = $('toasts');
    $('minimap').addEventListener('pointerdown', (e) => this.minimapClick(e));
    this.initDialogs();
    addEventListener('resize', () => this.placeMinimap());
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { this.mmDirty = true; }).observe($('minimap'));
  }

  // Every dialog is announced and focus-managed in one place: when it opens it gets a dialog role and a name,
  // takes focus, and the page behind it goes inert (so Tab and screen readers stay inside); when it closes,
  // focus goes back to what opened it. Dialogs stack, so the newest one is the one that stays live.
  initDialogs() {
    const NAMES = { pause: 'Paused', scorecard: 'Scorecard', summary: 'Round summary', relief: 'Penalty relief', academy: 'Practice academy', confirmBox: 'Confirm' };
    const dialogs = [...MODALS, 'scorecard', 'academy'].map($);
    const stack = [];
    const apply = () => {
      const top = stack.length ? stack[stack.length - 1].el : null;
      for (const c of document.body.children) {
        if (c.tagName === 'SCRIPT' || c.id === 'coachMark' || c.id === 'toasts') continue;
        c.inert = !!top && c !== top && !c.contains(top);
      }
      for (const d of dialogs) if (d !== top && stack.some((e) => e.el === d)) d.inert = true;
      if (top) top.inert = false;
    };
    const sync = (el) => {
      const open = !el.classList.contains('hidden');
      const at = stack.findIndex((e) => e.el === el);
      if (open && at < 0) {
        const from = document.activeElement;
        el.setAttribute('role', el.id === 'confirmBox' ? 'alertdialog' : 'dialog');
        el.setAttribute('aria-modal', 'true');
        const h = el.querySelector('h1, h2, h3');
        if (h) { h.id = h.id || el.id + 'Title'; el.setAttribute('aria-labelledby', h.id); el.removeAttribute('aria-label'); }
        else el.setAttribute('aria-label', NAMES[el.id] || 'Dialog');
        el.tabIndex = -1;
        stack.push({ el, from });
        apply();
        el.focus({ preventScroll: true });
      } else if (!open && at >= 0) {
        const [{ from }] = stack.splice(at, 1);
        el.inert = false;
        apply();
        const top = stack.length ? stack[stack.length - 1].el : null;
        const back = from && document.contains(from) && !from.closest('[inert], .hidden') ? from : null;
        if (back) back.focus({ preventScroll: true });
        else if (top) top.focus({ preventScroll: true });
      }
    };
    const mo = new MutationObserver((list) => { for (const m of list) sync(m.target); });
    for (const d of dialogs) { if (d) mo.observe(d, { attributes: true, attributeFilter: ['class'] }); }
  }
  attach(game, academy, tutorial) { this.game = game; this.academy = academy; this.tutorial = tutorial; }

  // is a dialog open that should swallow game input?
  modalOpen() {
    if (this.scModal) return true;
    if (!$('academy').classList.contains('hidden')) return true;
    return MODALS.some((id) => !$(id).classList.contains('hidden'));
  }
  // Esc: close the topmost open dialog (the confirm box handles its own Esc). True if one closed.
  closeTopModal() {
    const open = (id) => !$(id).classList.contains('hidden');
    if (open('academy')) { this.academy.close(); return true; }
    if (open('settings')) { this.showSettings(false); return true; }
    if (open('help')) { this.showHelp(false); return true; }
    if (open('stats')) { this.showStats(false); return true; }
    // only the card opened from the pause menu: the end-of-hole card is closed by its own button
    if (this.fromPause && open('scorecard')) { $('scNext').click(); return true; }
    return false;
  }
  // settings / how-to-play opened from the pause menu hand back to it when closed, so the game
  // stays paused underneath and Esc never leaves two overlays stacked
  returnToPause() {
    if (!this.fromPause) return;
    this.fromPause = false;
    this.paused = false;
    this.togglePause();
  }
  // what to call a control in a prompt: the on-screen button on touch, the bound key otherwise
  key(action) {
    if (this.touch && TOUCH_LABELS[action]) return TOUCH_LABELS[action];
    const ks = this.game.input.bindings[action] || [];
    return ks.length ? keyName(ks[0]) : '—';
  }
  // "Tap SWING" / "Press Space"
  press(action) { return `${this.touch ? 'Tap' : 'Press'} ${this.key(action)}`; }
  // on-screen buttons rather than a keyboard: prompts name those instead
  get touch() { return document.body.classList.contains('touch'); }

  // ------------------------------------------------------------ main menu
  mainMenu() {
    const g = this.game;
    this.hideAll();
    document.body.classList.remove('in-round');
    $('menu').classList.remove('hidden');
    const history = loadHistory();
    const course = COURSES.find((c) => c.id === this.sel.courseId) || COURSES[0];

    // course tabs (the 3D signature hole behind the menu is the hero visual)
    const tabs = $('courseTabs');
    tabs.innerHTML = '';
    for (const c of COURSES) {
      const b = el('button', 'course-tab' + (c.id === course.id ? ' sel' : ''), `<span class="cc-flag"></span>${c.name}`);
      b.setAttribute('aria-pressed', c.id === course.id);
      b.style.setProperty('--accent', c.flag);
      b.onclick = () => { this.sel.courseId = c.id; this.saveSel(); g.showcase(c.id); this.mainMenu(); };
      tabs.appendChild(b);
    }
    // fade the clipped edge while more tabs are off-screen, and bring the chosen one into view
    const fadeTabs = () => tabs.classList.toggle('more', tabs.scrollWidth - tabs.scrollLeft - tabs.clientWidth > 4);
    tabs.onscroll = fadeTabs;
    requestAnimationFrame(() => { tabs.querySelector('.sel')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' }); fadeTabs(); });
    const par = course.holes.reduce((s, h) => s + h.par, 0);
    const tees = g.settings.tees || 'back';
    const yds = course.holes.reduce((s, h) => s + teeYds(h, tees), 0);
    const units = g.settings.units;
    const bests = ['18', 'front', 'back'].map((m) => [m, bestFor(history, course.id, m, tees)]).filter(([, b]) => b);
    const hero = $('courseHero');
    hero.style.setProperty('--accent', course.flag);
    hero.innerHTML = `
      <div class="cc-top"><span class="cc-flag"></span><div><div class="cc-name">${course.name}</div><div class="cc-loc">${course.location}</div></div></div>
      <div class="cc-meta">Par ${par} · ${fmtYd(yds, units).replace(/\d+/, (n) => (+n).toLocaleString())} · Stimp ${course.stimp} · Wind ${windValue(course.wind[0], units)}–${windValue(course.wind[1], units)} ${windUnit(units)}${tees !== 'back' ? ` · ${TEE_SETS[tees].name} tees` : RATINGS[course.id] ? ` · Rating ${RATINGS[course.id][0]} / ${RATINGS[course.id][1]}` : ''}</div>
      <details class="cc-more"${this.sel.about ? ' open' : ''}><summary>About this course</summary>
        <p class="cc-blurb">${course.blurb}</p>
        <div class="cc-teach"><b>Teaches</b><ul>${course.teaches.map((t) => `<li>${t}</li>`).join('')}</ul></div>
        ${bests.length ? `<div class="cc-best">${bests.map(([m, b]) => `Best ${MODES[m].name}: ${toParStr(b.toPar)} (${b.strokes})`).join(' · ')}</div>` : ''}
      </details>`;
    const more = hero.querySelector('.cc-more');
    more.ontoggle = () => { this.sel.about = more.open; this.saveSel(); };

    // Tee off is always the yellow primary button on the left; the guided tour sits to its right, plain, on every visit
    $('btnQuick').innerHTML = 'Guided tour ▶<small>Magnolia 12 · par 3 · about 5 minutes · explains every control</small>';
    $('btnQuick').onclick = () => this.tutorial?.start();
    $('btnPlay').innerHTML = `Tee off ▶<small>${MODES[this.sel.mode].name}</small>`;
    $('btnPlay').onclick = () => this.play();

    // an unfinished round (closed tab, phone dropped the page, quit mid-round)
    const saved = this.savedRound(), rc = $('resumeCard');
    rc.classList.toggle('hidden', !saved);
        rc.classList.toggle('primary-cta', !!saved);
    $('btnPlay').parentElement.classList.toggle('has-resume', !!saved);
    $('btnPlay').classList.add('primary');
    if (saved) {
      const { snap, round: r } = saved;
      const thru = r.scores.length, toPar = r.scores.reduce((t, x) => t + x.strokes - x.par, 0);
      const hn = r.holes[r.i], hname = r.course.holes[hn]?.name;
      const where = snap.done ? `All ${r.holes.length} holes played – see the summary` : `Hole ${hn + 1}${hname ? `, ${hname}` : ''} · ${[thru ? `${toParStr(toPar)} through ${thru}` : '', snap.mid?.strokes > 0 ? `shot ${snap.mid.strokes + 1} in play` : thru ? '' : 'ready to tee off'].filter(Boolean).join(' · ')}`;
      rc.innerHTML = `<div class="lbl">Resume round</div>
        <div><b>${r.course.name}</b> · ${MODES[r.mode]?.name || ''}</div>
        <div class="muted small">${where}</div><span class="rc-go" aria-hidden="true">Resume ▸</span>`;
      rc.setAttribute('aria-label', `Resume round: ${r.course.name}. ${where}`);
      rc.onclick = () => this.resume(snap);
    }

    // daily challenge
    const d = dailySpec();
    const dc = courseById(d.courseId);
    let dBest = null;
    try { dBest = JSON.parse(localStorage.getItem(`psg-daily-${d.key}`) || 'null'); } catch (e) { /* ignore */ }
    $('dailyCard').innerHTML = `<div class="lbl">Daily challenge · ${dayLabel(d.key)}</div>
      <div><b>${dc.name}</b>, holes ${d.holes[0] + 1}–${d.holes[2] + 1}. Same pins and wind for everyone today.</div>
      <div class="muted small">${dBest ? `Your best today: <b>${toParStr(dBest.toPar)}</b> (${dBest.strokes})` : 'Not played yet today'}</div>`;
    $('dailyCard').setAttribute('aria-label', `Daily challenge, ${dayLabel(d.key)}: ${dc.name}, holes ${d.holes[0] + 1} to ${d.holes[2] + 1}. ${dBest ? `Your best today: ${toParStr(dBest.toPar)}` : 'Not played yet today'}`);
    $('dailyCard').onclick = () => { g.showcase(dc.id); this.start({ courseId: dc.id, holes: d.holes, mode: 'daily', seed: d.seed, daily: d.key }); };

    // shared challenge link
    const cb = $('challengeBanner');
    if (this.challenge) {
      const c = this.challenge, cc = courseById(c.courseId, c.seed);
      const beat = c.score != null ? this.scoreToBeat(c.mode, c.score, cc, c.holes) : null;
      cb.innerHTML = `<div><b>Challenge received:</b> ${cc.name}${c.tees ? ` (${TEE_SETS[c.tees].name} tees)` : ''} · ${MODES[c.mode].name} · ${c.holes.length === 1 ? `hole ${c.holes[0] + 1}` : `${c.holes.length} holes`} – same pins and wind as your friend.${beat ? ` <b>Score to beat: ${beat}</b>` : ''}</div>
        <div class="row"><button class="btn primary" id="chAccept">Accept</button><button class="btn" id="chDismiss">Dismiss</button></div>`;
      cb.classList.remove('hidden');
      $('chAccept').onclick = () => { const x = this.challenge; this.challenge = null; window.history.replaceState?.(null, '', location.pathname + location.search); g.showcase(x.courseId); this.start({ courseId: x.courseId, holes: x.holes, mode: x.mode, seed: x.seed, target: x.score, tees: x.tees }); };
      $('chDismiss').onclick = () => { this.challenge = null; window.history.replaceState?.(null, '', location.pathname + location.search); this.mainMenu(); };
    } else cb.classList.add('hidden');

    // options drawer
    const s = g.settings;
    const opt = (id, val, list) => {
      const box = $(id);
      box.innerHTML = '';
      const desc = $(id + 'Desc');
      if (desc) desc.textContent = '';
      // a sentence under every row is a wall of text: only the row just changed explains itself
      const talk = this.lastOpt === id;
      for (const [k, label, title] of list) {
        const b = el('button', 'seg' + (String(k) === String(val) ? ' on' : ''), label);
        b.setAttribute('aria-pressed', String(k) === String(val));
        if (title) b.title = title;
        if (title && desc && talk && String(k) === String(val)) desc.textContent = title;
        b.onclick = () => { this.setOpt(id, k); this.mainMenu(); };
        box.appendChild(b);
      }
    };
    opt('optMode', this.sel.mode, ['18', 'front', 'back', 'single', 'random'].map((k) => [k, MODES[k].name, MODES[k].desc]));
    opt('optProfile', s.profile, Object.entries(PROFILES).map(([k, p]) => [k, p.name, p.desc]));
    opt('optTees', tees, Object.entries(TEE_SETS).map(([k, t]) => [k, t.name, `${fmtYd(course.holes.reduce((a, h) => a + teeYds(h, k), 0), units).replace(/\d+/, (n) => (+n).toLocaleString())} at ${course.name}${k === 'back' ? ': the full championship length' : k === 'middle' ? ': a shorter course for most club golfers' : ': the shortest, for newer players and slower swings'}`]));
    opt('optDiff', s.difficulty, [['beginner', 'Beginner', 'Big impact zone, full aim preview with wind and roll, full putt line'], ['standard', 'Standard', 'Normal zone, carry preview without wind, partial putt line'], ['pro', 'Pro', 'Small zone, no wind/putt assistance – read it yourself']]);
    opt('optTempo', s.tempo, TEMPO_IDS.map((k) => [k, TEMPOS[k].name, TEMPOS[k].blurb + ' – three counts back, one through (analog swing)']));
    opt('optGuide', s.guide, [['off', 'Off', 'No guide: feel the tempo yourself'], ['ticks', 'Ticks', 'A tick on each of the three counts'], ['bar', 'Ticks + bar', 'Ticks, and a bar that fills to the mark']]);
    opt('optCaddie', s.caddie, [...CADDIE_IDS.map((k) => [k, CADDIES[k].name, CADDIES[k].blurb]), ['none', 'None', 'A plain, quiet caddie']]);
    opt('optUnits', s.units === 'm' ? 'm' : 'yd', [['yd', 'Yards'], ['m', 'Metres']]);
    const hs = $('optHole');
    const pickHole = this.sel.mode === 'single';
    hs.classList.toggle('hidden', !pickHole);
    hs.innerHTML = course.holes.map((h, i) => `<option value="${i + 1}" ${i + 1 === +this.sel.hole ? 'selected' : ''}>${i + 1}. ${h.name} – par ${h.par}, ${fmtYd(teeYds(h, tees), units)}</option>`).join('');
    hs.onchange = () => { this.sel.hole = +hs.value; this.saveSel(); };
    $('profileDesc').textContent = this.lastOpt === 'optProfile' ? PROFILES[s.profile].desc : '';
    const drawer = $('menuDrawer');
    drawer.open = !!this.sel.drawer;
    drawer.ontoggle = () => { this.sel.drawer = drawer.open; this.saveSel(); };
    $('btnAcademy').onclick = () => { this.academy.open(); };
    $('btnHow').onclick = () => this.showHelp(true);
    $('btnStats').onclick = () => this.showStats(true);
    $('btnSettings').onclick = () => this.showSettings(true);
  }
  setOpt(id, k) {
    const s = this.game.settings;
    this.lastOpt = id;
    if (id === 'optMode') this.sel.mode = k;
    if (id === 'optProfile') {
      s.profile = k;
      // a golfer who hits it shorter gets the matching tees, unless tees were picked by hand
      if (!s.teesChosen && TEE_FOR_PROFILE[k]) s.tees = TEE_FOR_PROFILE[k];
    }
    if (id === 'optTees') { s.tees = k; s.teesChosen = true; }
    if (id === 'optDiff') s.difficulty = k;
    if (id === 'optTempo') s.tempo = k;
    if (id === 'optGuide') s.guide = k;
    if (id === 'optCaddie') { s.caddie = k; this.game.greeted = false; if (CADDIES[k]) this.game.auditionCaddie(k); }
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
    const saved = resumable(opts) && this.savedRound();
    if (saved) {
      this.confirm({ title: 'Start a new round?', text: `Your unfinished round at ${saved.round.course.name} will be replaced.`, ok: 'Start new round', danger: true }, () => this.begin(opts));
      return;
    }
    this.begin(opts);
  }
  begin(opts) {
    $('menu').classList.add('hidden');
    document.body.classList.add('in-round');
    this.game.startRound({ ...opts, tees: opts.tees ?? (opts.mode === 'daily' ? 'back' : this.game.settings.tees) });
  }

  resume(snap) {
    $('menu').classList.add('hidden');
    document.body.classList.add('in-round');
    this.game.startRound(null, snap);
  }
  savedRound() {
    try {
      const snap = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
      const round = restoreRound(snap);
      return round ? { snap, round } : null;
    } catch (e) { return null; }
  }

  hideAll() {
    for (const id of ['menu', 'intro', 'scorecard', 'relief', 'pause', 'confirmBox', 'summary', 'shotPanel', 'help', 'settings', 'stats']) $(id).classList.add('hidden');
    document.body.classList.remove('sc-open', 'shot-open');
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
    const k = (a) => this.key(a);
    // key hints inside the club box follow the player's bindings
    $('kShapeL').textContent = k('shapeLeft'); $('kShapeR').textContent = k('shapeRight');
    $('kTrajU').textContent = k('trajUp'); $('kTrajD').textContent = k('trajDown');
    const basics = ['<b>Hold LMB</b> 3-count back, push up to swing', '<b>Shift</b> practice', `<b>${k('aimLeft')}${k('aimRight')}</b> aim (${k('aimFine')} fine)`, `<b>${k('clubUp')}${k('clubDown')}</b> club`];
    const st = document.body.dataset.state;
    // once the ball is away the swing hint flips to fast-forward (hold) and a skip button, and flips back at the next address
    const ico = (d, w = 2) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="currentColor" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/></svg>`;
    const items = st === 'flight'
      ? [`<button type="button" class="hb-btn" data-hold="fastForward" aria-label="Hold to fast-forward">${ico('M2.5 5.5l9 6.5-9 6.5zM12.5 5.5l9 6.5-9 6.5z')}<span><b>${k('fastForward')}</b> hold to fast-forward</span></button>`,
        `<button type="button" class="hb-btn" data-act="skip" aria-label="Skip to the result">${ico('M4 5l11 7-11 7zM18 5v14', 2.4)}<span><b>${k('skip')}</b> skip</span></button>`]
      : st === 'result' ? [`<b>${k('swing')}</b> continue`, `<b>${k('pause')}</b> menu · all keys`]
      : [...basics, `<b>${k('targetView')}</b> target view`, ...(this.game.nearGreen?.() ? [`<b>${k('grid')}</b> green grid`] : []), `<b>${k('pause')}</b> menu · all keys`];
    const bar = $('helpBar');
    bar.innerHTML = items.map((x) => (x.startsWith('<button') ? x : `<span>${x}</span>`)).join('');
    this.fitHelpBar();
    if (this.hbState !== st) { bar.classList.remove('hb-flip'); void bar.offsetWidth; bar.classList.add('hb-flip'); this.hbState = st; }
  }

  // the hints wrap onto a second line in a narrow window: tell the CSS how tall they are so the
  // club box rides above them, and keep telling it when the window changes
  fitHelpBar() {
    const bar = $('helpBar');
    const set = () => document.documentElement.style.setProperty('--hb-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    set();
    if (!this.hbWatch && typeof ResizeObserver === 'function') { this.hbWatch = new ResizeObserver(set); this.hbWatch.observe(bar); }
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
        ${def.tip ? `<p class="intro-tip">${localizeText(def.tip, this.game.settings.units)}</p>` : ''}
        <div class="intro-skip">${this.touch ? 'Tap' : `${this.key('swing')} / click`} to skip the flyover</div>
      </div>`;
    i.classList.remove('hidden');
  }
  hideIntro() { $('intro').classList.add('hidden'); }

  // ------------------------------------------------------------ HUD
  hud(d) {
    const units = this.game.settings.units;
    $('hcNum').textContent = d.hole;
    $('hcName').textContent = d.name;
    $('hcPar').textContent = `Par ${d.par} · ${this.game.fmtDist(d.yards * YD)}`;
    $('hcShot').textContent = d.shot;
    $('hcScore').textContent = toParStr(d.toPar);
    $('hcScore').className = 'hc-score ' + (d.toPar < 0 ? 'under' : d.toPar > 0 ? 'over' : '');
    $('dPin').textContent = d.dist;
    if (d.state !== 'address') this.tipNow = '';
    if (d.plays) this.firstTip('plays', '“Plays like” is the distance adjusted for wind and elevation. Pick a club for that number, not the yardage.');
    let sub = '';
    if (d.plays) sub = `<span class="plays">Plays like <b>${d.plays}</b></span>`;
    else if (d.puttEq != null) sub = `<span class="putteq">Stroke it <b>${fmtFt(d.puttEq, units)}</b><br><small>to finish about 17 in past the hole</small></span>`;
    const e = Math.round(d.elev);
    if (Math.abs(e) >= 1) sub += `<span class="elev">${e > 0 ? '▲' : '▼'} ${fmtElev(e, units)} ${e > 0 ? 'uphill' : 'downhill'}</span>`;
    const sl = d.slope, parts = [];
    if (Math.abs(sl.up) >= 1.5) parts.push(`${sl.up > 0 ? 'Uphill' : 'Downhill'} ${Math.abs(sl.up).toFixed(0)}°`);
    if (Math.abs(sl.side) >= 1.5) parts.push(`Ball ${sl.side > 0 ? 'above' : 'below'} feet ${Math.abs(sl.side).toFixed(0)}°`);
    // the lie box is folded away: its one useful line lives here
    const facts = d.putter ? [`Stimp ${d.stimp.toFixed(1)}`] : [d.lieRange === '100–100%' ? '' : d.lieRange, ...parts].filter(Boolean);
    sub += `<span class="lie-line" data-lie="${d.lieKey}"><b>${esc(d.lie)}</b> <span class="lie-facts">${facts.map((f) => `<span class="lie-range">${f}</span>`).join('')}</span></span>`;
    $('dSub').innerHTML = d.state === 'flight' ? '' : sub; // (in flight the box is only the closing distance)
    this.setState(d.state);
    this.placeMinimap();
    if (this.hbNear !== d.nearGreen && !this.touch) { this.hbNear = d.nearGreen; this.helpBar(); } // the grid hint comes and goes with the green
    document.body.dataset.putt = d.putter ? '1' : '';
    this.touchChips(d);
    $('hud').dataset.putt = d.putter ? '1' : '';
    const w = d.wind;
    $('windArrow').style.transform = `rotate(${w.ang}rad)`;
    $('windMph').textContent = `${windValue(d.windMph, units)}`;
    $('windUnit').textContent = ` ${windUnit(units)}`;
    const wt = [];
    if (Math.abs(w.along) >= 1.5) wt.push(w.along > 0 ? 'Helping' : 'Into');
    if (Math.abs(w.side) >= 1.5) wt.push(w.side > 0 ? 'L → R' : 'R → L');
    $('windTxt').textContent = wt.join(' · ') || 'Calm';
    $('clubName').textContent = d.club.name;
    $('clubKey').textContent = d.club.key;
    $('clubDist').textContent = d.clubCarry;
    $('clubTempo').textContent = d.tempoNote;
    $('clubTempo').classList.toggle('alt', d.tempoAlt);
    $('shapeVal').textContent = d.putter ? '—' : d.shape;
    $('trajVal').textContent = d.putter ? '—' : d.traj;
    $('shapeRow').classList.toggle('dim', d.putter);
    $('lieName').textContent = d.lie;
    $('lieRange').textContent = d.putter ? `Stimp ${d.stimp.toFixed(1)}` : d.lieRange;
    $('lieSlope').textContent = d.putter ? '' : parts.join(' · ') || 'Flat lie';
    $('lieBox').dataset.lie = d.lieKey;
  }

  setState(state) {
    $('hud').dataset.state = state;
    document.body.dataset.state = state; // the touch buttons that make sense change with it
    if (this.hbState !== state && !this.touch) this.helpBar();
    if (state !== 'address') this.game.input?.toggleShotOpts(false);
    // with the ball away the big button holds to fast-forward, and its label says so
    const sw = document.querySelector('.tc-swing');
    if (sw) sw.setAttribute('aria-label', state === 'flight' ? 'Hold to fast-forward' : 'Swing');
  }
  // the shot tray's buttons say what is set, and the tray's own button shows a dot when the shot is shaped
  touchChips(d) {
    const c = this.chips || (this.chips = {
      shape: document.querySelector('[data-act="shapeCycle"] small'),
      flight: document.querySelector('[data-act="trajCycle"] small'),
      shot: document.querySelector('.tc-shot'),
    });
    const sh = d.shape.toLowerCase(), fl = { Low: 'low', Standard: 'flight', High: 'high' }[d.traj] || 'flight';
    if (c.shape && c.shape.textContent !== sh) c.shape.textContent = sh;
    if (c.flight && c.flight.textContent !== fl) c.flight.textContent = fl;
    c.shot?.classList.toggle('set', d.shape !== 'Straight' || d.traj !== 'Standard');
  }

  // portrait phone: the map hangs under the distance panel, the same gap below it as the panel has
  // below the wind box, and shrinks (or steps aside) rather than ride over the swing controls
  placeMinimap() {
    const mm = $('minimap'), dist = $('distBox'), wind = $('windBox');
    if (!this.touch || !matchMedia('(orientation: portrait)').matches || !dist.offsetHeight) { mm.style.top = mm.style.height = ''; mm.classList.remove('mm-nofit'); return; }
    const k = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const d = dist.getBoundingClientRect(), w = wind.getBoundingClientRect();
    const gap = Math.max(6, d.top - w.bottom), top = d.bottom + gap;
    let limit = innerHeight - 8;
    for (const el of [document.querySelector('.tc-right'), $('caddie')]) {
      const r = el?.offsetHeight ? el.getBoundingClientRect() : null;
      if (r && r.right > innerWidth - 170 && r.top > top) limit = Math.min(limit, r.top - gap);
    }
    const h = Math.min(170, limit - top);
    mm.classList.toggle('mm-nofit', h < 80);
    mm.style.top = `${top / k}px`; mm.style.height = `${Math.max(h, 80) / k}px`;
    this.mmDirty = true;
  }

  // the caddie's own notes lead the Caddie section of the result card
  caddieNotes(notes) {
    const p = $('shotPanel');
    if (!p || !notes.length) return;
    let tips = p.querySelector('.sp-tips');
    if (!tips) {
      tips = document.createElement('div'); tips.className = 'sp-tips'; tips.innerHTML = '<div class="sp-sub">Caddie</div>';
      p.querySelector('.sp-btns')?.before(tips);
    }
    tips.querySelector('.sp-sub').insertAdjacentHTML('afterend', notes.map((n) => `<div class="tip pcad"><b>${esc(n.title)}</b><p>${esc(n.text)}</p></div>`).join(''));
  }

  minimap(game) {
    const cv = $('minimap');
    const W = game.world, h = game.hole;
    this.mmDirty = true; // stays set until a draw lands (hidden, zero-sized or still loading)
    if (!W.textureCanvas || !h) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !ch) return;
    this.mmDirty = false; this.mmSize = cw + 'x' + ch;
    if (cv.width !== cw * dpr) { cv.width = cw * dpr; cv.height = ch * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const B = h.bounds;
    const bw = B.maxX - B.minX, bd = B.maxZ - B.minZ;
    // A phone-sized map of the whole hole shows a par-3 green as a few pixels, and on a
    // portrait screen the 3-D view can't show it either: when the shot can reach the
    // green, frame just the landing area and the green.
    const V = cw < 120 ? this.minimapFocus(game) : null;
    // The view fills the card: a long hole is cropped into the outer rough at the sides
    // (centred on the hole's route) rather than letterboxed between bare bars.
    let vx = V ? V.minX : B.minX, vz = V ? V.minZ : B.minZ;
    let vw = V ? V.maxX - V.minX : bw, vd = V ? V.maxZ - V.minZ : bd;
    const ar = cw / ch;
    if (vw / vd < ar) {
      let cx = vx + vw / 2;
      if (!V && h.path?.length) { const xs = h.path.map((p) => p.x); cx = (Math.min(...xs) + Math.max(...xs)) / 2; }
      vw = vd * ar; vx = cx - vw / 2;
      if (vw <= bw) vx = clamp(vx, B.minX, B.maxX - vw); // keep the crop on painted ground where it fits
    } else if (vw / vd > ar) {
      const cz = vz + vd / 2;
      vd = vw / ar; vz = cz - vd / 2;
      if (vd <= bd) vz = clamp(vz, B.minZ, B.maxZ - vd);
    }
    const s = cw / vw;
    const ox = (B.minX - vx) * s, oy = (B.minZ - vz) * s;
    this.mm = { s, ox, oy, B };
    g.save();
    g.beginPath(); if (g.roundRect) g.roundRect(0, 0, cw, ch, 10); else g.rect(0, 0, cw, ch); g.clip();
    g.fillStyle = h.style?.palette?.deep || '#23402a'; g.fillRect(0, 0, cw, ch);
    g.drawImage(W.textureCanvas, ox, oy, bw * s, bd * s);
    if (W.hazardCanvas) g.drawImage(W.hazardCanvas, ox, oy, bw * s, bd * s); // hatched penalty areas
    const P = (x, z) => [ox + (x - B.minX) * s, oy + (z - B.minZ) * s];
    // tree canopies: the ground texture only shows the straw under them, which reads as bare dirt
    if (h.trees?.length) {
      const dots = [];
      for (const t of h.trees) {
        const [tx, ty] = P(t.x, t.z);
        const r = Math.max(1.2, t.crownR * (t.scale || 1) * s * 0.9);
        if (tx >= -r && ty >= -r && tx <= cw + r && ty <= ch + r) dots.push([tx, ty, r]);
      }
      g.fillStyle = 'rgba(20,58,26,0.9)'; g.beginPath();
      for (const [tx, ty, r] of dots) { g.moveTo(tx + r, ty); g.arc(tx, ty, r, 0, Math.PI * 2); }
      g.fill();
      g.fillStyle = 'rgba(110,175,90,0.4)'; g.beginPath();
      for (const [tx, ty, r] of dots) { if (r < 2) continue; const hx = tx - r * 0.25, hy = ty - r * 0.3, hr = r * 0.5; g.moveTo(hx + hr, hy); g.arc(hx, hy, hr, 0, Math.PI * 2); }
      g.fill();
    }
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
  // world rect around the landing spot and the green, or null for the whole hole
  minimapFocus(game) {
    const h = game.hole, land = game.previewLand;
    if (game.state !== 'address' || game.club?.putter || !land) return null;
    const c = h.cup, near = Math.hypot(land[0] - c.x, land[2] - c.z) < 45;
    if (!near && !(game.suggestedPower < 1)) return null; // not a shot at the green
    const xs = [c.x, h.gf.x], zs = [c.z, h.gf.z];
    if (near) { xs.push(land[0]); zs.push(land[2]); } // (a full swing that flies the green is off the map)
    const m = 24;
    const box = { minX: Math.min(...xs) - m, maxX: Math.max(...xs) + m, minZ: Math.min(...zs) - m, maxZ: Math.max(...zs) + m };
    // never tighter than 70 m across: the green should read as a green, not fill the map
    for (const [lo, hi] of [['minX', 'maxX'], ['minZ', 'maxZ']]) {
      const span = box[hi] - box[lo];
      if (span < 70) { box[lo] -= (70 - span) / 2; box[hi] += (70 - span) / 2; }
    }
    return box;
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
    if (c.dataset.text !== text) {
      c.dataset.text = text; $('caddieText').textContent = this.touch ? caddieBrief(text) : text; $('caddieText').title = text;
      // on a phone the note is read once and then fades; a new note (new club, new aim) brings it back
      c.classList.remove('quiet');
      clearTimeout(this.caddieT);
      if (this.touch) this.caddieT = setTimeout(() => c.classList.add('quiet'), 7000);
    }
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
  // a one-time plain-English explainer the first time a piece of golf jargon appears
  // (the guided hole covers them already, so it stays quiet during the lesson)
  firstTip(id, text) {
    if (this.game.tutorial || this.game.state !== 'address') return;
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem('psg-tips') || '{}'); } catch (e) { /* ignore */ }
    if (seen[id]) return;
    seen[id] = 1;
    try { localStorage.setItem('psg-tips', JSON.stringify(seen)); } catch (e) { /* ignore */ }
    this.tipNow = text; // rides in the caddie bubble until the swing, then is gone
    this.game.caddieNote();
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
    if (on) h.innerHTML = this.touch ? 'Hold <b>▶▶</b> to fast-forward · <b>skip</b> button to skip'
      : `Hold <b>${this.key('fastForward')}</b> to fast-forward · <b>${this.key('skip')}</b> to skip`;
    h.classList.toggle('hidden', !on);
  }

  // ------------------------------------------------------------ shot panel
  shotPanelShown() { return !$('shotPanel').classList.contains('hidden'); }
  // where the top of the result card sits, as a fraction of the window height (the camera lifts the picture clear of it)
  shotPanelTop() { return $('shotPanel').getBoundingClientRect().top / (window.innerHeight || 1); }
  showShotPanel(o) {
    const p = $('shotPanel');
    if (!o) { p.classList.add('hidden'); document.body.classList.remove('shot-open'); return; }
    document.body.classList.add('shot-open'); // the panel sits over the key hints, so they step aside
    const { info, sg, tips, canReplay } = o;
    const rows = [];
    const ld = info.ld;
    if (info.putt) {
      rows.push(['Putt length', fmtFt(info.startFt, this.game.settings.units)]);
      rows.push(['Result', info.holed ? '<b class="good">Holed</b>' : `${fmtFt(Math.abs(info.shortFt), this.game.settings.units, 1)} ${info.shortFt > 0 ? 'short' : 'past'}${Math.abs(info.lateralFt) >= 0.4 ? ` · ${fmtFt(Math.abs(info.lateralFt), this.game.settings.units, 1)} ${info.lateralFt > 0 ? 'right' : 'left'}` : ''}`]);
      rows.push(['Start speed', `${(ld.speed * 2.237).toFixed(1)} mph`, 1]);
      rows.push(['Face at impact', `${Math.abs(ld.face).toFixed(1)}° ${ld.face > 0.05 ? 'open' : ld.face < -0.05 ? 'closed' : 'square'}`, 1]);
    } else {
      const u = this.game.settings.units;
      const d = (yd) => (u === 'm' ? `${(yd * YD).toFixed(0)} m` : `${yd.toFixed(0)} yds`);
      rows.push(['Carry', d(info.carryYd)]);
      rows.push(['Total', d(info.totalYd)]);
      rows.push(['Offline', `${d(Math.abs(info.offlineYd))} ${info.offlineYd >= 0 ? 'R' : 'L'}`]);
      rows.push(['Club', info.club.name, 1]);
      rows.push(['Club speed', `${ld.clubMph.toFixed(1)} mph`, 1]);
      rows.push(['Ball speed', `${ld.ballMph.toFixed(1)} mph`, 1]);
      rows.push(['Smash factor', ld.smash.toFixed(2), 1, 'Ball speed divided by club speed: how cleanly the club hit the ball']);
      rows.push(['Launch', `${ld.launch.toFixed(1)}° · ${Math.abs(ld.hLaunch).toFixed(1)}° ${ld.hLaunch >= 0 ? 'R' : 'L'}`, 1, 'Launch angle up, and the start direction left or right']);
      rows.push(['Spin', `${Math.round(ld.spinRpm).toLocaleString()} rpm · axis ${ld.axisTilt.toFixed(1)}°`, 1, 'Backspin, and the tilt of the spin axis that curves the ball']);
      rows.push(['Face / Path', `${sgn(ld.face, 1)}° / ${sgn(ld.path, 1)}°`, 1, 'Where the clubface pointed and where the club was travelling at impact']);
      rows.push(['Apex', u === 'm' ? `${Math.max(0, info.apexFt * 0.3048).toFixed(0)} m` : `${Math.max(0, info.apexFt).toFixed(0)} ft`, 1]);
      if (info.descent != null) rows.push(['Land angle', `${info.descent.toFixed(0)}°`, 1]);
    }
    const sgHtml = sg ? `<div class="sg ${sg.sg >= 0 ? 'pos' : 'neg'}"><span>Strokes gained</span><b>${sgn(sg.sg)}</b><em>${{ OTT: 'Off the tee', APP: 'Approach', ARG: 'Around the green', PUTT: 'Putting' }[sg.cat]}</em><small>Tour avg from there: ${sg.eb.toFixed(2)} → ${sg.ea.toFixed(2)}</small></div>` : '';
    const tipsHtml = tips.map((t) => `<div class="tip"><b>${t.title}</b><p>${t.text}</p>${t.why ? `<details class="why"><summary>Why?</summary><p>${t.why}</p></details>` : ''}</div>`).join('');
    p.innerHTML = `
      <div class="sp-head">${info.putt ? 'Putt' : 'Launch monitor'}</div>
      <div class="sp-grid">${rows.filter((r) => !r[2]).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      <div class="sp-grid sp-adv">${rows.filter((r) => r[2]).map(([k, v, , tip]) => `<div${tip ? ` title="${tip}"` : ''}><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      ${sgHtml}
      ${tipsHtml ? `<div class="sp-tips"><div class="sp-sub">Caddie</div>${tipsHtml}</div>` : ''}
      <div class="sp-btns"><button class="btn primary sp-go">Continue</button><button class="btn sp-more">Details</button></div>
      <div class="sp-cont">${this.touch ? 'Tap anywhere to continue' : `${this.key('swing')} / click to continue`}${canReplay ? ` · <b>${this.touch ? 'view' : this.key('replay')}</b> replay` : ''}</div>`;
    p.classList.remove('hidden', 'open');
    p.onclick = () => this.game.continueAfterResult();
    for (const d of p.querySelectorAll('details.why')) d.onclick = (e) => e.stopPropagation(); // opening it must not skip the panel
    const more = p.querySelector('.sp-more');
    more.onclick = (e) => { e.stopPropagation(); const open = p.classList.toggle('open'); more.textContent = open ? 'Less' : 'Details'; };
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
      b.innerHTML = `<b>${o.title}</b>${o.es === best ? '<span class="tag">Best</span>' : ''}<p>${o.desc}</p><div><span>${fmt(o.dist)} to pin</span><span>${o.isTee ? 'Tee' : SURFACES[o.surface]?.name || o.surface}</span><span>Expected ${o.es.toFixed(2)}</span></div>`;
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
    const metric = this.game.settings.units === 'm';
    const yd = (y) => (metric ? Math.round(y * 0.9144) : y);
    const cls = (d) => (d == null ? '' : d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'dbl');
    // only the holes in this round get a column; a half with none of them is left out
    const inRound = new Set(round.holes);
    const half = (from) => {
      const idx = course.holes.map((h, i) => i).slice(from, from + 9).filter((i) => inRound.has(i));
      if (!idx.length) return '';
      const holes = idx.map((i) => course.holes[i]);
      const nums = idx.map((i) => i + 1);
      const scoreRow = (r) => {
        const byNum = {};
        for (const x of r.scores) byNum[x.number] = x;
        let tot = 0, any = false;
        const cells = holes.map((h, i) => {
          const rec = byNum[nums[i]], sc = rec?.strokes;
          if (sc != null) { tot += sc; any = true; }
          const pick = rec?.pickedUp ? ' pickup" title="Picked up: maximum strokes reached' : '';
          return `<td><span class="${cls(sc != null ? sc - h.par : null)}${pick}">${sc ?? ''}${rec?.pickedUp ? '<i>*</i>' : ''}</span></td>`;
        }).join('');
        return `<tr class="sc"><th>Score</th>${cells}<th>${any ? tot : ''}</th></tr>`;
      };
      return `<table class="${holes.length <= 3 ? 'few' : ''}"><tr class="num"><th>Hole</th>${nums.map((n) => `<td>${n}</td>`).join('')}<th>${holes.length < 9 ? 'Tot' : from ? 'In' : 'Out'}</th></tr>
        <tr class="yd"><th>${metric ? 'Metres' : 'Yards'}</th>${holes.map((h) => `<td>${yd(teeYds(h, round.tees))}</td>`).join('')}<th>${yd(holes.reduce((a, h) => a + teeYds(h, round.tees), 0))}</th></tr>
        <tr class="par"><th>Par</th>${holes.map((h) => `<td>${h.par}</td>`).join('')}<th>${holes.reduce((a, h) => a + h.par, 0)}</th></tr>
        ${scoreRow(round)}</table>`;
    };
    const t = round.stats.totals();
    const toPar = t.strokes - t.par;
    const n = round.scores.length;
    const totals = `<div class="sc-total ${toPar < 0 ? 'under' : toPar > 0 ? 'over' : ''}">${n ? toParStr(toPar) : '–'}<small>${t.strokes || ''}</small></div>`;
    s.innerHTML = `<div class="sc-head"><div><h2>${course.name}</h2><div class="muted">${course.location}</div></div>${totals}</div>
      ${half(0)}${half(9)}
      <div class="sc-stats">
        <div><span>Fairways</span><b>${t.firN ? `${t.fir}/${t.firN}` : '–'}</b></div><div><span>Greens in reg.</span><b>${t.gir}/${n}</b></div>
        <div><span>Putts</span><b>${t.putts}</b></div><div><span>Penalties</span><b>${t.penalties}</b></div>
        <div><span>SG total</span><b class="${t.sgTotal >= 0 ? 'good' : 'bad'}">${n ? sgn(t.sgTotal) : '–'}</b></div>
      </div>
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

  // a challenge link's score as the player reads it: "+2 (74)"
  scoreToBeat(score, course, holes) {
    const par = holes.reduce((a, i) => a + (course.holes[i]?.par || 0), 0);
    return `${toParStr(score - par)} (${score})`;
  }
  // under the summary title when the round was played from a challenge link
  targetNote(round) {
    const mine = challengeScore(round);
    if (round.target == null || mine == null) return '';
    const beat = this.scoreToBeat(round.target, round.course, round.holes);
    const better = mine < round.target;
    const tied = mine === round.target;
    return `<div class="challenge-note ${better ? 'won' : ''}">Score to beat: <b>${beat}</b> – ${better ? 'you beat it!' : tied ? 'you matched it.' : 'not this time.'}</div>`;
  }

  // ------------------------------------------------------------ summaries
  summary(course, round, t, best, settings) {
    this.showHUD(false);
    const s = $('summary');
    const cats = [['OTT', 'Off the tee'], ['APP', 'Approach'], ['ARG', 'Around the green'], ['PUTT', 'Putting']];
    const advice = {
      OTT: 'Your tee shots cost the most. Accuracy matters, but so does distance: Broadie found driving explains ~28% of the scoring gap between tour pros and amateurs. Try a club that keeps you out of penalty areas on tight holes.',
      APP: 'Approach shots are where scores are made – about 40% of the scoring difference between golfers. Pick the club whose average carry covers the plays-like number and aim at the fat part of the green.',
      ARG: 'Around the green, get the ball on the putting surface first. From just off the fringe a putt or low chip is usually the percentage play.',
      PUTT: 'Putting cost you strokes. Focus on lag speed from long range (leave it inside 3 ft) and on reading the low side – most misses are under-read.',
    };
    // off the tee costing strokes with no penalties and most fairways found is about length, not accuracy
    const adviceDistance = 'You found the fairway, so accuracy is not what cost the most off the tee. Distance is: Broadie found driving explains ~28% of the scoring gap between tour pros and amateurs. A smooth, balanced swing with a centred strike gains more yards than swinging harder.';
    const hcp = handicapIndex(loadHistory());
    const n = round.scores.length;
    // the closing tip under the strokes-gained bars: only claims what the numbers show (a category
    // with nothing recorded, like no chips on a round that never missed a green, is not a "gain")
    const sgTip = (t) => {
      const played = cats.filter(([k]) => Math.abs(t.sg[k]) >= 0.005);
      if (!played.length) return `<div class="tip"><b>Not enough to compare</b><p>No strokes-gained data was recorded this time, so there is nothing to measure against the tour average. Play a full hole to see where you gain and lose strokes.</p></div>`;
      const worst = played.slice().sort((a, b) => t.sg[a[0]] - t.sg[b[0]])[0];
      if (t.sg[worst[0]] < -0.3) return `<div class="tip"><b>Where to improve: ${worst[1]}</b><p>${worst[0] === 'OTT' && !t.penalties && (!t.firN || t.fir / t.firN >= 0.7) ? adviceDistance : advice[worst[0]]}</p></div>`;
      // a small dip in one category (here -0.03) is noise, not a lesson: say so instead of nagging
      if (t.sg[worst[0]] < 0) return `<div class="tip"><b>${t.sgTotal >= 0 ? 'Nothing to fix here' : 'Close to tour level'}</b><p>${t.sgTotal >= 0 ? 'You beat the tour average overall.' : 'Every part of your game was within a third of a stroke of tour level.'} The only dip was ${worst[1].toLowerCase()} (${sgn(t.sg[worst[0]])}), which is normal over ${n === 1 ? 'one hole' : `${n} holes`}.</p></div>`;
      const names = played.map(([, n]) => n.toLowerCase());
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      const skipped = cats.length - played.length;
      return `<div class="tip"><b>${skipped ? 'Strokes gained where it counted' : 'Strokes gained everywhere'}</b><p>You beat the tour average ${skipped ? `in these areas: ${list}` : 'in every part of the game'}. The smallest gain was ${worst[1].toLowerCase()} (${sgn(t.sg[worst[0]])}).${skipped ? ` Nothing was recorded for the other ${skipped === 1 ? 'category' : 'categories'}.` : ''}${settings.difficulty !== 'pro' ? ' Try a harder difficulty in Settings for a tougher test.' : ''}</p></div>`;
    };
    // score, key stats and strokes gained
    const card = (t) => {
      const toPar = t.strokes - t.par;
      const max = Math.max(1, ...cats.map(([k]) => Math.abs(t.sg[k])));
      return `<div class="sum-score ${toPar < 0 ? 'under' : toPar > 0 ? 'over' : ''}">${toParStr(toPar)}<small>${t.strokes} strokes · par ${t.par}</small></div>
      ${best ? `<div class="muted">Previous best: ${toParStr(best.toPar)} (${best.date})</div>` : ''}
      ${hcp != null ? `<div class="muted">Handicap index estimate: <b>${hcp.toFixed(1)}</b></div>` : ''}
      <div class="sum-grid">
        <div><span>Fairways hit</span><b>${t.firN ? `${t.fir}/${t.firN}` : '–'}</b></div>
        <div><span>Greens in regulation</span><b>${t.gir}/${n}</b></div>
        <div><span>Putts</span><b>${t.putts}</b></div>
        <div><span>Penalty strokes</span><b>${t.penalties}</b></div>
      </div>
      <h3>Strokes gained vs. Tour average</h3>
      <div class="sg-bars">${cats.map(([k, nm]) => {
        const v = t.sg[k], w = (Math.abs(v) / max) * 50;
        return `<div class="sg-row"><span>${nm}</span><div class="bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="width:${w}%;${v >= 0 ? 'left:50%' : `left:${50 - w}%`}"></i></div><b>${sgn(v)}</b></div>`;
      }).join('')}</div>
      <p class="sum-total">Total: <b>${sgn(t.sgTotal)}</b> strokes vs. a tour player over ${n} hole${n === 1 ? '' : 's'}.</p>
      ${sgTip(t)}`;
    };
    const lesson = !!round.opts?.solo;
    const info = lesson ? `${course.name} · Guided lesson` : [course.name, round.holes.length === 1 ? null : MODES[round.mode]?.name, PROFILES[settings.profile]?.name || settings.profile, DIFFICULTY[settings.difficulty]?.name].filter(Boolean).join(' · ');
    s.innerHTML = `<h1>${round.daily ? 'Daily challenge complete' : round.holes.length === 1 ? 'Hole complete' : 'Round complete'}</h1>
      <div class="muted">${info}</div>
      ${this.targetNote(round)}
      <div id="sumCard">${card(t)}</div>
      ${lesson
        ? '<div class="row wrap sum-actions"><button class="btn primary" id="sumFront">Play the front 9</button><button class="btn" id="sumAgain">Replay this hole</button><button class="btn" id="sumMenu">Main menu</button></div>'
        : '<div class="row wrap sum-actions"><button class="btn primary" id="sumAgain">Play again</button><button class="btn" id="sumCardBtn">Scorecard</button><button class="btn" id="sumShare">Copy challenge link</button><button class="btn" id="sumMenu">Main menu</button></div>'}`;
    s.classList.remove('hidden');
    this.summaryButtons(course, round);
  }

  summaryButtons(course, round) {
    const s = $('summary');
    $('sumAgain').onclick = () => { s.classList.add('hidden'); this.game.startRound({ courseId: course.id, holes: round.holes, mode: round.mode, tees: round.tees, seed: course.generated || round.daily || round.target != null ? round.seed : undefined, daily: round.daily || undefined, solo: round.opts?.solo, target: round.target }); };
    $('sumMenu').onclick = () => { s.classList.add('hidden'); this.game.quitToMenu(); };
    // after the guided hole the obvious next step is a real round on the same course
    if ($('sumCardBtn')) $('sumCardBtn').onclick = () => { s.classList.add('hidden'); this.scorecard(course, round, true, () => s.classList.remove('hidden'), 'Back to summary'); };
    if ($('sumFront')) $('sumFront').onclick = () => { s.classList.add('hidden'); this.game.startRound({ courseId: course.id, holes: [...Array(9).keys()], mode: 'front', tees: round.tees }); };
    if (!$('sumShare')) return;
    $('sumShare').onclick = async () => {
      const url = location.origin + location.pathname + challengeHash(round);
      try {
        await navigator.clipboard.writeText(url);
        this.toast('Challenge link copied – same pins and wind, and your score to beat', 'good');
      } catch (e) {
        // no clipboard access (insecure context, permissions, embedded browser): show the link, selected, to copy by hand
        let box = $('shareBox');
        if (!box) {
          box = el('div', 'share-box', '<span>Copy this challenge link</span><input id="shareUrl" readonly aria-label="Challenge link">');
          box.id = 'shareBox';
          $('sumShare').closest('.row').before(box);
        }
        const inp = $('shareUrl');
        inp.value = url;
        inp.focus(); inp.select();
        this.toast('Press Ctrl+C to copy the selected link');
      }
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
      <button class="btn danger" id="pQuit">Main menu</button>`;
    $('pResume').onclick = () => this.togglePause();
    // the game stays paused under the card, and closing it returns to this menu
    $('pCard').onclick = () => { this.fromPause = true; p.classList.add('hidden'); this.scorecard(this.game.course, this.game.round, true, () => this.returnToPause(), 'Close'); };
    $('pSettings').onclick = () => { this.fromPause = true; p.classList.add('hidden'); this.showSettings(true); };
    $('pHelp').onclick = () => { this.fromPause = true; p.classList.add('hidden'); this.showHelp(true); };
    $('pQuit').onclick = () => {
      this.togglePause();
      const g = this.game, r = g.round;
      // multi-hole rounds are saved as they go, so leaving costs nothing; a single hole or the lesson is lost
      if (r && resumable(r.opts) && !g.tutorial) { g.quitToMenu(); return; }
      this.confirm({ title: 'Quit this hole?', text: g.tutorial ? 'You can restart the guided hole from the menu.' : 'Single holes are not saved, so your progress on this hole will be lost.', ok: 'Leave hole', cancel: 'Keep playing', danger: true },
        () => g.quitToMenu(), () => this.togglePause());
    };
  }

  // in-app replacement for window.confirm: Esc or the cancel button backs out
  confirm({ title, text, ok = 'OK', cancel = 'Cancel', danger = false }, onOk, onCancel) {
    const c = $('confirmBox');
    c.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row"><button class="btn ${danger ? 'danger' : 'primary'}" id="cfOk">${esc(ok)}</button><button class="btn" id="cfNo">${esc(cancel)}</button></div>`;
    const close = () => { c.classList.add('hidden'); removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); onCancel?.(); } };
    addEventListener('keydown', onKey, true);
    $('cfOk').onclick = () => { close(); onOk(); };
    $('cfNo').onclick = () => { close(); onCancel?.(); };
    c.classList.remove('hidden');
    $('cfNo').focus();
  }

  // ------------------------------------------------------------ settings (incl. accessibility + key remap)
  qualityDesc() {
    const q = this.game.settings.quality || 'auto', p = this.game.post;
    return q === 'auto' ? `${QUALITY.auto.desc} Currently ${p.tier}.` : QUALITY[q].desc;
  }
  showSettings(on) {
    const box = $('settings');
    box.classList.toggle('hidden', !on);
    if (!on) {
      this.game.input.capture = null;
      this.returnToPause();
      // the menu behind shows distances: refresh it if units or tees changed
      if (!$('menu').classList.contains('hidden')) this.mainMenu();
      return;
    }
    const g = this.game, s = g.settings;
    const chk = (id, label, val, desc) => `<label class="set"><span>${label}${desc ? `<small>${desc}</small>` : ''}</span><input type="checkbox" id="${id}" ${val ? 'checked' : ''}></label>`;
    const binds = g.input.bindings;
    box.innerHTML = `<h2>Settings</h2>
      <div class="set-cols"><div>
      <h3>Game</h3>
      <label class="set"><span>Volume</span><input type="range" id="sVol" min="0" max="1" step="0.05" value="${s.volume}"></label>
      ${chk('sTracer', 'Shot tracer', s.tracer)}
      <label class="set"><span>Caddie<small>${CADDIES[s.caddie]?.blurb || 'A plain, quiet caddie'}</small></span><select id="sCaddie">${CADDIE_IDS.map((k) => `<option value="${k}" ${s.caddie === k ? 'selected' : ''}>${CADDIES[k].name}</option>`).join('')}<option value="none" ${CADDIES[s.caddie] ? '' : 'selected'}>None</option></select></label>
      <label class="set"><span>Swing tempo<small>${TEMPOS[s.tempo]?.blurb || ''} (analog swing)</small></span><select id="sTempo">${TEMPO_IDS.map((k) => `<option value="${k}" ${s.tempo === k ? 'selected' : ''}>${TEMPOS[k].name}</option>`).join('')}</select></label>
      <label class="set"><span>Tempo guide<small>Ticks on each count and a timing bar while you swing (always on in practice and the tutorial)</small></span><select id="sGuide"><option value="off" ${s.guide === 'off' ? 'selected' : ''}>Off</option><option value="ticks" ${s.guide === 'ticks' ? 'selected' : ''}>Ticks</option><option value="bar" ${s.guide === 'bar' ? 'selected' : ''}>Ticks + bar</option></select></label>
      ${chk('sVoice', 'Caddie voice', s.caddyVoice, 'Your caddie speaks: the club and how hard to hit it (analog swing), and what he thinks of your shots.')}
      <label class="set"><span>Distances</span><select id="sUnits"><option value="yd" ${s.units !== 'm' ? 'selected' : ''}>Yards</option><option value="m" ${s.units === 'm' ? 'selected' : ''}>Metres</option></select></label>
      <label class="set"><span>Assists</span><select id="sDiff">${['beginner', 'standard', 'pro'].map((d) => `<option value="${d}" ${s.difficulty === d ? 'selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}</select></label>
      <label class="set"><span>Graphics<small id="sQualDesc">${this.qualityDesc()}</small></span><select id="sQual">${Object.keys(QUALITY).map((q) => `<option value="${q}" ${(s.quality || 'auto') === q ? 'selected' : ''}>${QUALITY[q].name}</option>`).join('')}</select></label>
      <h3>Accessibility</h3>
      ${chk('sReduce', 'Reduced motion', s.reducedMotion, 'No flyovers, slow-motion or camera punches.')}
      ${chk('sCap', 'Sound captions', s.captions, 'On-screen text for crowd, cup and splash sounds.')}
      <label class="set"><span>Interface size</span><input type="range" id="sScale" min="0.8" max="1.5" step="0.05" value="${s.uiScale}"></label>
      </div>${this.touch ? '' : `<div>
      <h3>Keyboard</h3>
      <div class="remap">${Object.keys(DEFAULT_KEYS).map((a) => `<div class="remap-row"><span>${ACTION_LABELS[a]}</span><button class="seg" data-act="${a}">${binds[a].map(keyName).join(' / ')}</button></div>`).join('')}</div>
      <button class="btn small-btn" id="sKeysReset">Reset keys</button>
      <p class="muted small">Gamepad: A swing · B skip · X fade · Y view/replay · LB/RB club · D-pad aim &amp; flight · right stick: pull back then push up for a tempo swing.</p>
      </div>`}</div>
      <div class="set-foot"><button class="btn primary" id="sClose">Done</button></div>`;
    const save = () => { g.saveSettings(); this.helpBar(); if (g.state === 'address') g.enterAddress(); };
    $('sVol').oninput = (e) => { s.volume = +e.target.value; g.audio.setVolume(s.volume); g.saveSettings(); };
    $('sTracer').onchange = (e) => { s.tracer = e.target.checked; save(); };
    $('sCaddie').onchange = (e) => { s.caddie = e.target.value; g.greeted = false; g.saveSettings(); this.showSettings(true); };
    $('sGuide').onchange = (e) => { s.guide = e.target.value; g.saveSettings(); };
    $('sTempo').onchange = (e) => { s.tempo = e.target.value; g.saveSettings(); this.showSettings(true); };
    $('sVoice').onchange = (e) => { s.caddyVoice = e.target.checked; g.saveSettings(); };
    $('sUnits').onchange = (e) => { s.units = e.target.value; save(); g.updateHUD?.(true); };
    $('sDiff').onchange = (e) => { s.difficulty = e.target.value; save(); };
    $('sQual').onchange = (e) => { s.quality = e.target.value; g.saveSettings(); g.post.setQuality(s.quality); $('sQualDesc').textContent = this.qualityDesc(); };
    $('sReduce').onchange = (e) => { s.reducedMotion = e.target.checked; save(); };
    $('sCap').onchange = (e) => { s.captions = e.target.checked; save(); };
    $('sScale').oninput = (e) => { s.uiScale = +e.target.value; g.saveSettings(); };
    if ($('sKeysReset')) $('sKeysReset').onclick = () => { s.keys = {}; save(); this.showSettings(true); };
    $('sClose').onclick = () => this.showSettings(false);
    for (const b of box.querySelectorAll('.remap [data-act]')) {
      b.onclick = () => {
        const a = b.dataset.act;
        b.textContent = 'Press a key… (Esc cancels)';
        b.classList.add('on');
        b.classList.remove('clash');
        const capture = (e) => {
          if (e.key === 'Escape') { g.input.capture = null; this.showSettings(true); return; }
          const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
          const clash = keyConflict({ ...g.input.bindings, [a]: [k] }, a, k);
          if (clash) {
            // keep listening: say who has the key and let the player pick another
            b.textContent = `${keyName(k)} is ${ACTION_LABELS[clash]} – press another key`;
            b.classList.add('on', 'clash');
            return;
          }
          g.input.capture = null;
          s.keys = { ...s.keys, [a]: [k] };
          save();
          this.showSettings(true);
        };
        g.input.capture = capture;
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
        <div><span>Rounds played</span><b>${mine.filter((r) => r.holes > 1).length}</b></div>
        <div><span>Holes played</span><b>${mine.reduce((s, r) => s + r.holes, 0)}</b></div>
        <div><span>SG / 18${trend.length ? ` (last ${trend.length})` : ''}</span><b class="${avg('total') >= 0 ? 'good' : 'bad'}">${trend.length ? sgn(avg('total'), 1) : '—'}</b></div>
      </div>
      ${hcp == null ? '<p class="muted small">Play three 18-hole rounds (or six 9s) for a handicap estimate.</p>' : '<p class="muted small">World Handicap System method with approximate course ratings – an estimate, not an official index.</p>'}
      <h3>Strokes gained per 18 – trend</h3>
      ${trend.length ? '' : '<p class="muted small">Trends appear once you finish a 9- or 18-hole round.</p>'}
      <div class="trend ${trend.length ? '' : 'hidden'}">${cats.map(([k, n, c]) => `<div><span>${n}</span><b class="${avg(k) >= 0 ? 'good' : 'bad'}">${sgn(avg(k), 1)}</b>${spark(k, c)}</div>`).join('')}</div>
      <h3>Personal bests</h3>
      <div class="bests">${bests.map(([c, m, b]) => `<div><span>${c.name} · ${MODES[m]?.name || m}</span><b>${toParStr(b.toPar)} (${b.strokes})</b><small>${dayLabel(b.date)}</small></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
      <h3>Recent rounds</h3>
      <table class="hist"><tr><th>Date</th><th>Course</th><th>Mode</th><th>Score</th><th>Putts</th><th>SG</th></tr>
      ${mine.slice(-12).reverse().map((r) => `<tr><td class="nowrap">${dayLabel(localDay(r.date))}</td><td>${r.course === 'gen' ? 'Random course' : courseById(r.course)?.name || r.course}</td><td>${MODES[r.mode]?.name || r.mode}</td><td>${toParStr(r.strokes - r.par)} (${r.strokes})</td><td>${r.putts}</td><td class="${r.sgTotal >= 0 ? 'good' : 'bad'}">${sgn(r.sgTotal, 1)}</td></tr>`).join('')}</table>
      ` : `<div class="empty-state"><b>No rounds yet</b><p class="muted">Finish a hole or a round and your scores, strokes-gained trends, personal bests and a handicap estimate appear here.</p>${$('menu').classList.contains('hidden') ? '' : '<button class="btn primary" id="stPlay">Play a hole now ▶</button>'}</div>`}
      <div class="row wrap"><button class="btn" id="stClose">Close</button>${mine.length ? '<button class="btn danger" id="stClear">Clear history</button>' : ''}</div>`;
    $('stClose').onclick = () => this.showStats(false);
    const stPlay = $('stPlay');
    if (stPlay) stPlay.onclick = () => { this.showStats(false); $('btnQuick').click(); };
    const clr = $('stClear');
    if (clr) clr.onclick = () => this.confirm({ title: 'Delete all saved rounds?', text: 'This cannot be undone.', ok: 'Delete', danger: true }, () => { clearHistory(); this.showStats(true); });
  }

  // ------------------------------------------------------------ help
  showHelp(on) {
    const h = $('help');
    h.classList.toggle('hidden', !on);
    if (!on) { this.returnToPause(); return; }
    const k = (a) => this.key(a);
    const touch = this.touch;
    const setup = touch
      ? `<li>Hold <b>${k('aimLeft')}</b> or <b>${k('aimRight')}</b> to turn your aim; <b>${k('aimPin')}</b> re-aims at the pin (on the green it flips between the caddie's read and the cup). Tap the mini-map, or tap <b>${k('targetView')}</b> and then the ground.</li>
        <li><b>${k('clubUp')} ${k('clubDown')}</b> change club. Carry / total distances are shown for a full swing.</li>
        <li><b>${k('shapeLeft')}</b> cycles draw (curves left), straight and fade (curves right) for a right-hander.</li>
        <li><b>${k('trajUp')}</b> cycles low, standard and high flight.</li>
        <li><b>Plays like</b> includes elevation and wind. The lie box shows how the lie affects distance.</li>
        <li>In flight: hold <b>${k('fastForward')}</b> to fast-forward, <b>${k('skip')}</b> skips to where it finishes. <b>${k('replay')}</b> replays the shot from a new angle.</li>
        <li>Drag a finger sideways on the view to turn your aim, or up and down to look around. Swipe up or down on the club to change it.</li>`
      : `<li><b>${k('aimLeft')} ${k('aimRight')}</b> aim, <b>${k('aimFine')}</b> for fine aim. <b>${k('aimPin')}</b> re-aims at the pin (on the green it flips between the caddie's read and the cup). Click the mini-map, or press <b>${k('targetView')}</b> and click the ground.</li>
        <li><b>${k('clubUp')} ${k('clubDown')}</b> change club. Carry / total distances are shown for a full swing.</li>
        <li><b>${k('shapeLeft')} / ${k('shapeRight')}</b> draw (curves left) or fade (curves right) for a right-hander.</li>
        <li><b>${k('trajUp')} / ${k('trajDown')}</b> high or low trajectory.</li>
        <li><b>Plays like</b> includes elevation and wind. The lie box shows how the lie affects distance.</li>
        <li><b>${k('grid')}</b> shows the green grid: colour = slope, and the dots flow downhill.</li>
        <li>In flight: hold <b>${k('fastForward')}</b> to fast-forward, <b>${k('skip')}</b> skips to where it finishes. <b>${k('replay')}</b> replays the shot from a new angle.</li>
        <li>Right-drag orbits the camera; the wheel zooms.</li>`;
    const analog = touch
      ? `<ol><li>Your caddie tells you how hard to hit it ("about 75%", or "go all out"). Put one finger on the view and drag <b>down</b> that far – the blue mark on the scale is his number.</li><li>Take it back on a <b>three-count</b> (1… 2… 3) at your chosen tempo (24/8 by default: a 0.8 s backswing), whatever the distance. Reaching the top right on 3 is a pure strike. Putts and short wedge shots take <b>two</b> counts back instead; the club box tells you.</li><li>Then drag <b>up</b> past the start point, straight – drifting left or right opens/closes the clubface.</li></ol>
        <p class="muted small">Tap the shot-options button, then <b>practice</b>, and your next drag is a practice swing: same timing feedback, no shot.</p>`
      : `<ol><li>Your caddie tells you how hard to hit it ("about 75%", or "go all out"). Hold the left mouse button and pull <b>down</b> that far – the blue mark on the scale is his number.</li><li>Take it back on a <b>three-count</b> (1… 2… 3) at your chosen tempo (24/8 by default: a 0.8 s backswing), whatever the distance. Reaching the top right on 3 and pushing through in one count is a pure strike; rushed or slow costs contact and turns the face. Putts and short wedge shots (under about 50%) take <b>two</b> counts back and one through – the club box and your caddie tell you which.</li><li>Then push <b>up</b> past the start point, straight – drifting left or right opens/closes the clubface.</li></ol>
        <p class="muted small">Hold <b>Shift</b> while you swing for a practice swing: same timing feedback, no shot.</p>
        <p class="muted small">Gamepad: the right stick does the same – pull back, then push up.</p>`;
    h.innerHTML = `<h2>How to play</h2>
      <div class="help-cols">
      <div><h3>Swing</h3>
      <h3>Analog swing</h3>
        ${analog}</div>
      <div><h3>Shot setup</h3>
        <ul>${setup}</ul>
      <h3>Learn while you play</h3>
        <p>After every shot you'll see launch-monitor numbers, <b>strokes gained</b> against a tour average, and your caddie explaining why the ball did what it did. Open the <b>Golf Academy</b> from the menu to experiment in the ball-flight lab.</p></div>
      </div>
      <div class="help-btns">${this.tutorial && !this.game.round ? '<button class="btn" id="helpTut">Guided first hole</button>' : ''}<button class="btn primary" id="helpClose">Got it</button></div>`;
    $('helpClose').onclick = () => this.showHelp(false);
    const t = $('helpTut');
    if (t) t.onclick = () => { this.showHelp(false); this.tutorial.start(); };
  }
}
