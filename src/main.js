import { UI } from './ui.js';
import { Game } from './game.js';
import { Academy } from './academy.js';
import { parseChallenge } from './round.js';
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
const academy = new Academy();
ui.attach(game, academy, new Editor(game), new Tutorial(game, ui));
// a shared challenge link (#c=course.mode.holes.seed) replays the same pins and wind
ui.challenge = parseChallenge(location.hash);
if (ui.challenge) ui.sel.courseId = ui.challenge.courseId;
game.showcase(ui.sel.courseId);
ui.mainMenu();
document.getElementById('boot').remove();
window.game = game; // handy for debugging from the console

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !/[?&]nosw\b/.test(location.search)) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
