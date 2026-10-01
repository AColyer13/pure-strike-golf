import { UI } from './ui.js';
import { Game } from './game.js';
import { Academy } from './academy.js';
import { parseChallenge } from './round.js';
import { Editor } from './editor.js';

const ui = new UI();
const game = new Game(ui);
const academy = new Academy();
ui.attach(game, academy, new Editor(game));
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
