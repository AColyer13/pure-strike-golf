// Guided first hole: a short par 3 (Magnolia 12, calm wind, beginner assists)
// with coach marks that point at the HUD, the swing and the shot panel as
// each becomes relevant. Steps are polled from the game loop, so they follow
// whatever the player actually does: a ball in the water gets the relief step,
// a missed green gets the "not on yet" step, a holed putt ends the lesson.
import { loadHistory } from './history.js';

const $ = (id) => document.getElementById(id);
const DONE_KEY = 'psg-tutorial-done';
export const TUTORIAL_ROUND = { courseId: 'augusta', holes: [11], mode: 'single', seed: 27, solo: true, tees: 'back' };

// asked once, on the lesson's last card: what the player's own rounds start with
export const LEVELS = [
  { id: 'new', label: 'New to golf', hint: 'Big assists, wind helps', settings: { profile: 'mid', difficulty: 'beginner', tees: 'forward' } },
  { id: 'casual', label: 'Play casually', hint: 'Typical club golfer', settings: { profile: 'mid', difficulty: 'standard', tees: 'middle' } },
  { id: 'regular', label: 'I play regularly', hint: 'Scratch golfer, standard assists', settings: { profile: 'scratch', difficulty: 'standard', tees: 'back' } },
];

export function tutorialDone() { try { return !!localStorage.getItem(DONE_KEY); } catch (e) { return true; } }
export function markTutorialDone() { try { localStorage.setItem(DONE_KEY, '1'); } catch (e) { /* ignore */ } }
// a player who has never finished a round and never seen the lesson
export function firstRun() { return !tutorialDone() && loadHistory().length === 0; }

// Each step shows once, the first time its `when` holds. `done` auto-advances;
// otherwise the player presses Next. `skip` leaves a step out for this player.
// text(g, k, touch) gets the game, a control-name lookup (bound key, or the on-screen button on
// touch) and whether the player is on touch, so no prompt names a key they cannot press.
export const STEPS = [
  { id: 'flyover', when: (g) => g.state === 'flyover', skip: (g) => g.settings.reducedMotion, anchor: 'intro', title: 'The flyover',
    text: (g, k, touch) => `Every hole opens with a flight from tee to green. The card gives par, length, wind and green speed (Stimp). ${touch ? 'Tap anywhere' : `Press ${k('swing')} or click`} to skip it.`,
    done: (g) => g.state !== 'flyover' },
  { id: 'distance', when: (g) => g.state === 'address', anchor: 'distBox', title: 'How far?',
    text: () => 'Distance to the pin. “Plays like” adds elevation and wind: that is the number to pick a club for.' },
  { id: 'wind', when: (g) => g.state === 'address', anchor: 'windBox', title: 'Wind',
    text: () => 'The arrow is the wind relative to your aim: into, helping or across. The plays-like distance already allows for it.' },
  { id: 'club', when: (g) => g.state === 'address', anchor: 'clubBox', title: 'Your club',
    text: (g, k, touch) => `Your caddie picked a club whose full-swing carry covers the plays-like distance. ${touch ? `The ${k('clubUp')} and ${k('clubDown')} buttons` : `${k('clubUp')} / ${k('clubDown')}`} change it; the caddie bubble explains the choice.` },
  { id: 'aim', when: (g) => g.state === 'address', anchor: 'clubBox', title: 'Aim',
    text: (g, k, touch) => (touch
      ? `Hold ${k('aimLeft')} or ${k('aimRight')} to turn your aim; ${k('aimPin')} aims back at the pin. You can also drag sideways on the view to aim, or up and down to look around. The ring at the end of the arc is where this club lands with a full swing.`
      : `${k('aimLeft')} / ${k('aimRight')} move your aim (hold ${k('aimFine')} for fine steps); ${k('aimPin')} aims back at the pin. The ring at the end of the arc is where this club lands with a full swing.`) },
  { id: 'swing', when: (g) => g.state === 'address', anchor: 'clubBox', title: 'The swing',
    text: (g, k, touch) => (touch
      ? 'Your caddie says how hard to hit it (“about 75%”). Put one finger on the view, take it back on a three-count (1… 2… 3) by dragging down that far, then flick up. Go on, hit it.'
      : 'Your caddie says how hard to hit it (“about 75%”). Hold the left mouse button, take it back on a three-count (1… 2… 3) by pulling down that far, then push up. Go on, hit it.'),
    done: (g) => g.state !== 'address' },
  { id: 'relief', when: (g) => g.state === 'relief', anchor: 'relief', title: 'Penalty area',
    text: () => 'In the water: one penalty stroke. Each option shows the tour-average strokes to hole out from that drop, so the lowest number is the smart choice.',
    done: (g) => g.state !== 'relief' },
  { id: 'result', when: (g) => g.state === 'result', anchor: 'shotPanel', title: 'What happened',
    text: (g, k, touch) => `Launch-monitor numbers for the shot. Strokes Gained compares it with a tour pro from the same spot: negative means it cost you. The caddie’s tip explains why the ball did what it did. ${touch ? 'Tap Continue' : `${k('swing')} continues`}.`,
    done: (g) => g.state !== 'result' },
  { id: 'green', when: (g) => g.state === 'address' && !!g.club?.putter, anchor: 'distBox', title: 'On the green',
    text: (g, k, touch) => `“Stroke it N ft” is the pace that finishes about 17 inches past the hole, the best chance of dropping. The line on the green shows the break${touch ? '.' : `; ${k('grid')} toggles the grid, whose dots flow downhill.`}` },
  { id: 'putt', when: (g) => g.state === 'address' && !!g.club?.putter, anchor: 'clubBox', title: 'Putting',
    text: () => 'Same swing, shorter: the caddie gives the length in feet. Your caddie has already aimed for the break, so just match the pace and push straight.',
    done: (g) => g.state !== 'address' },
  { id: 'again', when: (g) => g.state === 'address' && !g.club?.putter && g.strokes > 0, anchor: 'clubBox', title: 'Not on yet',
    text: () => 'Same routine: the caddie re-reads the distance and lie every shot. The lie percentage is how much distance the grass costs you.' },
  { id: 'holed', when: (g) => g.state === 'result' && g.resultNext === 'holed', anchor: 'shotPanel', title: 'Hole complete', finish: true,
    text: () => `That’s golf. Your caddie explains every shot, the scorecard tracks Strokes Gained by category, and the Golf Academy in the menu explains the physics. ${tutorialDone() ? 'You are ready for a full round.' : 'Pick the closest match and your first round starts at the right difficulty (change it any time in Settings).'}`,
    done: (g) => g.state !== 'result' },
];

export class Tutorial {
  constructor(game, ui) {
    this.g = game; this.ui = ui;
    this.cur = null; this.seen = new Set();
    this.suspended = false; this.stamp = 0;
    this.onKey = (e) => { if (e.key === 'Enter' && this.cur && this.g.state === 'address') { e.preventDefault(); this.advance(); } };
  }
  get active() { return this.g.tutorial === this; }

  start() {
    const g = this.g, s = g.settings;
    // beginner assists for the lesson; the player's own settings come back at the end
    this.saved = { difficulty: s.difficulty };
    s.difficulty = 'beginner';
    this.seen = new Set(); this.cur = null;
    g.tutorial = this;
    this.ensureEl();
    document.addEventListener('keydown', this.onKey, true);
    this.ui.start(TUTORIAL_ROUND);
  }

  end(level = null) {
    if (!this.active) return;
    const g = this.g;
    g.tutorial = null;
    // finished the hole but left without answering (Space/Continue past the card): start gently
    const lv = level ?? (this.seen.has('holed') && !tutorialDone() ? LEVELS[0] : null);
    Object.assign(g.settings, this.saved, lv?.settings);
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
      // a pause menu or dialog is up: tuck the tip away rather than stack it on top
      if (this.blocked(this.cur)) { this.suspend(true); return; }
      this.suspend(false);
      this.place();
      return;
    }
    for (const s of STEPS) {
      if (this.seen.has(s.id) || (s.skip && s.skip(g)) || !s.when(g)) continue;
      if (this.blocked(s)) break;
      this.show(s);
      break;
    }
  }

  // a dialog that is not the step's own anchor (the relief card is its own lesson)
  blocked(step) {
    const ui = this.ui;
    if (ui.paused) return true;
    if (!ui.modalOpen()) return false;
    const a = step.anchor ? $(step.anchor) : null;
    return !(a && a.classList.contains('modal') && !a.classList.contains('hidden'));
  }
  suspend(on) {
    if (on === !!this.suspended || !this.el) return;
    this.suspended = on;
    this.el.classList.toggle('hidden', on);
    document.body.classList.toggle('coaching', !on);
    this.focus(on ? null : this.cur?.anchor);
    this.stamp = performance.now();
  }
  // true for a moment after a tip appears, changes or disappears, so a second click aimed at
  // "Next" cannot fall through to the 3D view and start the swing
  settling() { return performance.now() - this.stamp < 350; }

  advance(level = null) {
    const s = this.cur;
    if (!s) return;
    this.hide();
    if (s.finish) this.end(level);
  }

  // ------------------------------------------------------------ rendering
  ensureEl() {
    if (this.el) return;
    const el = document.createElement('div');
    el.id = 'coachMark';
    el.className = 'hidden';
    el.innerHTML = '<div class="cm-step">Your caddie · guided first hole</div><h4></h4><p></p><div class="cm-btns"><button class="cm-skip" type="button">Skip the lesson</button><button class="btn primary cm-next" type="button">Next</button></div>'
      + `<div class="cm-level hidden"><div class="cm-ask">How much golf do you play?</div>${LEVELS.map((l) => `<button class="btn cm-lv" type="button" data-lv="${l.id}">${l.label}<small>${l.hint}</small></button>`).join('')}</div>`;
    el.querySelector('.cm-skip').onclick = () => this.end();
    el.querySelector('.cm-next').onclick = () => this.advance();
    for (const b of el.querySelectorAll('.cm-lv')) b.onclick = () => this.advance(LEVELS.find((l) => l.id === b.dataset.lv));
    document.body.appendChild(el);
    this.el = el;
  }
  show(step) {
    this.ensureEl();
    this.seen.add(step.id);
    this.cur = step;
    const k = (a) => this.ui.key(a);
    this.el.querySelector('h4').textContent = step.title;
    this.el.querySelector('p').textContent = step.text(this.g, k, this.ui.touch);
    // the first time through, the last card asks the player's level instead of offering a bare Finish
    const asks = !!step.finish && !tutorialDone();
    this.el.querySelector('.cm-skip').classList.toggle('hidden', !!step.finish);
    this.el.querySelector('.cm-btns').classList.toggle('hidden', asks);
    this.el.querySelector('.cm-level').classList.toggle('hidden', !asks);
    this.el.querySelector('.cm-next').textContent = step.finish ? 'Finish' : step.done ? 'Got it' : 'Next';
    this.el.classList.remove('hidden');
    document.body.classList.add('coaching');
    this.suspended = false;
    this.stamp = performance.now();
    this.focus(step.anchor);
    this.place();
  }
  hide() {
    this.cur = null;
    this.suspended = false;
    this.stamp = performance.now();
    document.body.classList.remove('coaching');
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
  // The spot nearest the anchor (or screen centre) where a W x H tip covers none of the panels the
  // player is using, or null if the screen has no such gap. The tip's own anchor may stay under it.
  freeSpot(anchor, W, H, m) {
    const vw = innerWidth, vh = innerHeight;
    const shown = (e) => { const b = e?.getBoundingClientRect(); return b && b.width && b.height && getComputedStyle(e).display !== 'none' ? b : null; };
    const hitsAnchor = (b) => anchor && b.left < anchor.right && b.right > anchor.left && b.top < anchor.bottom && b.bottom > anchor.top;
    const tc = $('touchControls');
    const thumbs = tc && getComputedStyle(tc).opacity > 0.5 ? [...tc.querySelectorAll('button')].map(shown).filter(Boolean) : [];
    const panels = ['holeCard', 'distBox', 'windBox'].map((id) => shown($(id))).filter((b) => b && !hitsAnchor(b));
    const others = ['clubBox', 'lieBox', 'shotPanel', 'minimap']
      .map((id) => shown($(id))).filter((b) => b && !hitsAnchor(b));
    const cx = anchor ? (anchor.left + anchor.right) / 2 : vw / 2, cy = anchor ? (anchor.top + anchor.bottom) / 2 : vh / 2;
    // the tip never covers the thumb buttons; it keeps off its own anchor and then the other panels as far as the screen allows
    const pin = anchor ? [anchor] : [];
    for (const clear of [[...thumbs, ...panels, ...others, ...pin], [...thumbs, ...panels, ...pin], [...thumbs, ...pin], thumbs]) {
      let best = null, bd = Infinity;
      for (let y = m; y + H <= vh - m; y += 10) {
        for (let x = m; x + W <= vw - m; x += 10) {
          if (clear.some((b) => x < b.right && x + W > b.left && y < b.bottom && y + H > b.top)) continue;
          const d = (x + W / 2 - cx) ** 2 + (y + H / 2 - cy) ** 2;
          if (d < bd) { bd = d; best = [x, y]; }
        }
      }
      if (best) return best;
    }
    return null;
  }
  // next to its anchor on the side with room; otherwise top centre
  place() {
    const el = this.el;
    if (!el || !this.cur) return;
    const vw = innerWidth, vh = innerHeight, m = 8, gap = 14;
    const W = el.offsetWidth, H = el.offsetHeight;
    const r = this.anchorRect();
    let left, top, side = 'none';
    // portrait phone: the golfer fills the middle of the screen, so the tip sits just above the club box
    const dock = this.ui.touch && vh > vw && this.g.state === 'address' ? $('clubBox').getBoundingClientRect() : null;
    if (dock && dock.height) {
      left = m;
      top = dock.top - H - gap;
      side = r && r.top >= dock.top ? 'above' : 'none';
    } else if (this.ui.touch && vh > vw && this.cur.finish) {
      // the level question is tall: sit it under the HUD panels so it neither covers the shot panel's
      // Continue button nor the swing controls
      left = m;
      top = Math.max(0, ...['holeCard', 'distBox', 'windBox'].map((id) => $(id)?.getBoundingClientRect().bottom || 0)) + gap;
      side = 'none';
    } else if (this.ui.touch && vw > vh && vh < 500 && !this.cur.finish && (left = this.freeSpot(r, W, H, m)) !== null) {
      // landscape phone: the HUD and thumb buttons leave only a gap or two, so look for one
      [left, top] = left;
      side = 'none';
    } else if (r) {
      const cands = [
        ['right', r.right + gap, r.top],
        ['left', r.left - W - gap, r.top],
        ['below', r.left, r.bottom + gap],
        ['above', r.left, r.top - H - gap],
      ];
      // ...and of the distance, wind and hole panels the player reads while the tip is up (unless the tip points at one)
      const hud = ['distBox', 'windBox', 'holeCard'].map((id) => $(id)?.getBoundingClientRect())
        .filter((b) => b && b.height && !(b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top));
      const hitsHud = (x, y) => hud.some((b) => x < b.right && x + W > b.left && y < b.bottom && y + H > b.top);
      const fits = cands.find(([, x, y]) => x >= m && y >= m && x + W <= vw - m && y + H <= vh - m && !hitsHud(x, y));
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
