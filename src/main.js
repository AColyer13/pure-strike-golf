import { UI } from './ui.js';
import { Game } from './game.js';
import { Academy } from './academy.js';

const ui = new UI();
const game = new Game(ui);
const academy = new Academy();
ui.attach(game, academy);
game.showcase(ui.sel.courseId);
ui.mainMenu();
document.getElementById('boot').remove();
window.game = game; // handy for debugging from the console
