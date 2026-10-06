// Guided first hole: a short par 3 (Augusta 12, calm wind, beginner assists)
// with coach marks that point at the HUD, the swing meter and the shot panel as
// each becomes relevant. Steps are polled from the game loop, so they follow
// whatever the player actually does: a ball in the water gets the relief step,
// a missed green gets the "not on yet" step, a holed putt ends the lesson.
import { loadHistory } from './history.js';

const $ = (id) => document.getElementById(id);
const DONE_KEY = 'psg-tutorial-done';
export const TUTORIAL_ROUND = { courseId: 'augusta', holes: [11], mode: 'single', seed: 27, solo: true };

export function tutorialDone() { try { return !!localStorage.getItem(DONE_KEY); } catch (e) { return true; } }
export function markTutorialDone() { try { localStorage.setItem(DONE_KEY, '1'); } catch (e) { /* ignore */ } }
// a player who has never finished a round and never seen the lesson
export function firstRun() { return !tutorialDone() && loadHistory().length === 0; }

// Each step shows once, the first time its `when` holds. `done` auto-advances;
// otherwise the player presses Next. `skip` leaves a step out for this player.
// text(g, k) gets the game and a key-name lookup so bindings are always current.
export const STEPS = [
  { id: 'flyover', when: (g) => g.state === 'flyover', skip: (g) => g.settings.reducedMotion, anchor: 'intro', title: 'The flyover',
    text: (g, k) => `Every hole opens with a flight from tee to green. The card gives par, length, wind and green speed (Stimp). Press ${k('swing')} or click to skip it.`,
    done: (g) => g.state !== 'flyover' },
  { id: 'distance', when: (g) => g.state === 'address', anchor: 'distBox', title: 'How far?',
    text: () => 'Distance to the pin. “Plays like” adds elevation and wind: that is the number to pick a club for.' },
  { id: 'wind', when: (g) => g.state === 'address', anchor: 'windBox', title: 'Wind',
    text: () => 'The arrow is the wind relative to your aim: into, helping or across. The plays-like distance already allows for it.' },
  { id: 'club', when: (g) => g.state === 'address', anchor: 'clubBox', title: 'Your club',
    text: (g, k) => `Your caddie picked a club whose full-swing carry covers the plays-like distance. ${k('clubUp')} / ${k('clubDown')} change it; the caddie bubble explains the choice.` },
  { id: 'aim', when: (g) => g.state === 'address', anchor: 'clubBox', title: 'Aim',
    text: (g, k) => `${k('aimLeft')} / ${k('aimRight')} move your aim (hold ${k('aimFine')} for fine steps); ${k('aimPin')} aims back at the pin. The ring on the ground is where this club lands with a full swing.` },
  { id: 'meter', when: (g) => g.state === 'address', anchor: 'meter', title: 'The three-click swing',
    text: (g, k) => (g.settings.oneButton
      ? `One-button swing: press ${k('swing')} to start. Power is set for you at the caddie’s marker; press ${k('swing')} again as the cursor comes back into the green impact zone. Go on, hit it.`
      : `Press ${k('swing')} to start the meter. Press again to set power: the blue marker is the caddie’s suggestion. Then press a third time as the cursor comes back into the green impact zone. Early closes the face (pull), late opens it (push). Go on, hit it.`),
    done: (g) => g.state !== 'address' },
  { id: 'relief', when: (g) => g.state === 'relief', anchor: 'relief', title: 'Penalty area',
    text: () => 'In the water: one penalty stroke. Each option shows the tour-average strokes to hole out from that drop, so the lowest number is the smart choice.',
    done: (g) => g.state !== 'relief' },
  { id: 'result', when: (g) => g.state === 'result', anchor: 'shotPanel', title: 'What happened',
    text: (g, k) => `Launch-monitor numbers for the shot. Strokes Gained compares it with a tour pro from the same spot: negative means it cost you. The coach’s tip explains why the ball did what it did. ${k('swing')} continues.`,
    done: (g) => g.state !== 'result' },
  { id: 'green', when: (g) => g.state === 'address' && !!g.club?.putter, anchor: 'distBox', title: 'On the green',
    text: (g, k) => `“Stroke it N ft” is the pace that finishes about 17 inches past the hole, the best chance of dropping. The line on the green shows the break; ${k('grid')} toggles the grid, whose dots flow downhill.` },
  { id: 'putt', when: (g) => g.state === 'address' && !!g.club?.putter, anchor: 'meter', title: 'Putting',
    text: () => 'Same three clicks. The labels are the distance each power rolls: hit the marker, and aim a touch up the slope.',
    done: (g) => g.state !== 'address' },
  { id: 'again', when: (g) => g.state === 'address' && !g.club?.putter && g.strokes > 0, anchor: 'clubBox', title: 'Not on yet',
    text: () => 'Same routine: the caddie re-reads the distance and lie every shot. The lie percentage is how much distance the grass costs you.' },
  { id: 'holed', when: (g) => g.state === 'result' && g.resultNext === 'holed', anchor: 'shotPanel', title: 'Hole complete', finish: true,
    text: () => 'That’s golf. Your coach explains every shot, the scorecard tracks Strokes Gained by category, and the Golf Academy in the menu explains the physics. You are ready for a full round.',
    done: (g) => g.state !== 'result' },
];

export class Tutorial {
  constructor(game, ui) {
    this.g = game; this.ui = ui;
    this.cur = null; this.seen = new Set();
    this.onKey = (e) => { if (e.key === 'Enter' && this.cur && this.g.state === 'address') { e.preventDefault(); this.advance(); } };
  }
  get active() { return this.g.tutorial === this; }

  start() {
    const g = this.g, s = g.settings;
    // beginner assists and the meter for the lesson; the player's own settings come back at the end
    this.saved = { difficulty: s.difficulty, control: s.control };
    s.difficulty = 'beginner'; s.control = 'meter';
    this.seen = new Set(); this.cur = null;
    g.tutorial = this;
    this.ensureEl();
    document.addEventListener('keydown', this.onKey, true);
    this.ui.start(TUTORIAL_ROUND);
  }

  end() {
    if (!this.active) return;
    const g = this.g;
    g.tutorial = null;
    Object.assign(g.settings, this.saved);
    this.saved = null;
    g.saveSettings();
    this.hide();
    this.el?.remove(); this.el = null;
    document.removeEventListener('keydown', this.onKey, true);
    markTutorialDone();
    if (g.state === 'address') { this.ui.helpBar(); g.enterAddress(); }
  }

  // called every frame by the game
  update() {
    if (!this.active) return;
    const g = this.g;
    if (this.cur) {
      if (this.cur.done && this.cur.done(g)) { this.advance(); return; }
      this.place();
      return;
    }
    for (const s of STEPS) {
      if (this.seen.has(s.id) || (s.skip && s.skip(g)) || !s.when(g)) continue;
      this.show(s);
      break;
    }
  }

  advance() {
    const s = this.cur;
    if (!s) return;
    this.hide();
    if (s.finish) this.end();
  }

  // ------------------------------------------------------------ rendering
  ensureEl() {
    if (this.el) return;
    const el = document.createElement('div');
    el.id = 'coachMark';
    el.className = 'hidden';
    el.innerHTML = '<div class="cm-step">Guided first hole</div><h4></h4><p></p><div class="cm-btns"><button class="cm-skip" type="button">Skip the lesson</button><button class="btn primary cm-next" type="button">Next</button></div>';
    el.querySelector('.cm-skip').onclick = () => this.end();
    el.querySelector('.cm-next').onclick = () => this.advance();
    document.body.appendChild(el);
    this.el = el;
  }
  show(step) {
    this.ensureEl();
    this.seen.add(step.id);
    this.cur = step;
    const k = (a) => this.ui.key(a);
    this.el.querySelector('h4').textContent = step.title;
    this.el.querySelector('p').textContent = step.text(this.g, k);
    this.el.querySelector('.cm-next').textContent = step.finish ? 'Finish' : step.done ? 'Got it' : 'Next';
    this.el.classList.remove('hidden');
    this.focus(step.anchor);
    this.place();
  }
  hide() {
    this.cur = null;
    this.focus(null);
    this.el?.classList.add('hidden');
  }
  focus(id) {
    if (this.focused) { this.focused.classList.remove('tut-focus'); this.focused = null; }
    const a = id ? $(id) : null;
    if (a) { a.classList.add('tut-focus'); this.focused = a; }
  }
  anchorRect() {
    const a = this.cur?.anchor ? $(this.cur.anchor) : null;
    if (!a) return null;
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    if (!r.width || !r.height || cs.display === 'none' || cs.visibility === 'hidden') return null;
    return r;
  }
  // next to its anchor on the side with room; otherwise top centre
  place() {
    const el = this.el;
    if (!el || !this.cur) return;
    const vw = innerWidth, vh = innerHeight, m = 8, gap = 14;
    const W = el.offsetWidth, H = el.offsetHeight;
    const r = this.anchorRect();
    let left, top, side = 'none';
    if (r) {
      const cands = [
        ['right', r.right + gap, r.top],
        ['left', r.left - W - gap, r.top],
        ['below', r.left, r.bottom + gap],
        ['above', r.left, r.top - H - gap],
      ];
      const fits = cands.find(([, x, y]) => x >= m && y >= m && x + W <= vw - m && y + H <= vh - m);
      if (fits) [side, left, top] = fits;
      else { side = r.top > vh / 2 ? 'above' : 'below'; left = r.left; top = side === 'above' ? r.top - H - gap : r.bottom + gap; }
    } else { left = (vw - W) / 2; top = 14; }
    left = Math.max(m, Math.min(left, vw - W - m));
    top = Math.max(m, Math.min(top, vh - H - m));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.side = side;
  }
}
