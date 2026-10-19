import { UI } from './ui.js';
import { Game } from './game.js';
import { Academy } from './academy.js';
import { parseChallenge } from './round.js';
import { COURSES } from './courses/index.js';
import { Editor } from './editor.js';
import { Tutorial } from './tutorial.js';

const ui = new UI();
let game;
try {
  game = new Game(ui);
} catch (e) {
  // no WebGL (switched off, blocked after a GPU crash, very old device): say so
  // instead of leaving the loading screen up forever
  const gl = /webgl/i.test(String(e?.message));
  document.getElementById('boot').innerHTML = `<div class="logo">PURE <span>STRIKE</span> GOLF</div>
    <div class="boot-msg"><b>${gl ? '3D graphics aren’t available' : 'The game couldn’t start'}</b>
    <p>${gl ? 'The game needs WebGL. Turn on hardware acceleration in your browser’s settings, close other tabs or apps that use the graphics card, or update the browser – then reload.' : 'Something went wrong while loading. Reloading usually fixes it.'}</p>
    <button class="btn primary" id="bootReload">Reload</button></div>`;
  document.getElementById('bootReload').onclick = () => location.reload();
  throw e;
}
try {
  const academy = new Academy();
  ui.attach(game, academy, new Editor(game), new Tutorial(game, ui));
  // a shared challenge link (#c=course.mode.holes.seed) replays the same pins and wind
  // The random course ('gen') is not a menu choice, so a link to it must not become the selected course.
  const applyHash = () => {
    ui.challenge = parseChallenge(location.hash);
    if (ui.challenge && COURSES.some((c) => c.id === ui.challenge.courseId)) ui.sel.courseId = ui.challenge.courseId;
    game.showcase(ui.sel.courseId);
    ui.mainMenu();
    if (!ui.challenge && /^#c=/.test(location.hash)) {
      // a link that is damaged, or for a hole that can't be played that way: say so instead of ignoring it
      ui.toast('That challenge link isn’t valid, so it was ignored', 'bad');
      window.history.replaceState?.(null, '', location.pathname + location.search);
    }
  };
  applyHash();
  // a link pasted into an already-open tab only changes the hash: pick it up from the menu
  window.addEventListener('hashchange', () => { if (game.state === 'menu' && /^#c=/.test(location.hash)) applyHash(); });
  document.getElementById('boot').remove();
  window.game = game; // handy for debugging from the console
} catch (e) {
  // damaged saved data (or any start-up error) must not leave "Loading…" up for ever:
  // offer a reload, and a reset of the saved settings, history and unfinished round
  const boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = `<div class="logo">PURE <span>STRIKE</span> GOLF</div>
      <div class="boot-msg"><b>The game couldn’t start</b>
      <p>Your saved settings or history may be damaged. Reloading usually fixes it; if it doesn’t, reset the saved data (this clears your rounds, stats and settings on this device).</p>
      <button class="btn primary" id="bootReload">Reload</button> <button class="btn" id="bootReset">Reset saved data</button></div>`;
    document.getElementById('bootReload').onclick = () => location.reload();
    document.getElementById('bootReset').onclick = () => {
      try {
        Object.keys(localStorage).filter((k) => k.startsWith('psg-')).forEach((k) => localStorage.removeItem(k));
      } catch (err) { /* storage blocked: nothing to clear */ }
      location.reload();
    };
  }
  throw e;
}

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !/[?&]nosw\b/.test(location.search)) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
