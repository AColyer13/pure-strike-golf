// Course editor: edit any hole's definition as JSON with a live plan-view preview,
// then play-test it. Edits are kept in a "custom" copy of the base course
// (localStorage), so the tribute courses themselves are never changed.
import { COURSES, courseById, loadCustom, saveCustom } from './courses/index.js';
import { Hole, YD } from './hole.js';

const $ = (id) => document.getElementById(id);
const COLORS = {
  tee: '#58b548', fairway: '#4fae3e', cut: '#46a037', second: '#3f9033', rough: '#3a812c', deep: '#2f6a24', fringe: '#55b545',
  green: '#6fd255', bunker: '#efe6c8', waste: '#dcd0b0', straw: '#8a5a2e', path: '#b1aba0', water: '#2c6f8e', ob: '#1d3a22',
};

// JSON with arrays of plain values kept on one line ([0, 4] rather than five lines)
function pretty(v) {
  return JSON.stringify(v, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (m, inner) => `[${inner.replace(/\s*\n\s*/g, ' ')}]`);
}

export class Editor {
  constructor(game) {
    this.g = game;
    this.root = $('editor');
    const c = loadCustom();
    this.baseId = c?.base || 'augusta';
    this.idx = 0;
  }

  open() {
    this.root.classList.remove('hidden');
    this.load();
  }
  close() { this.root.classList.add('hidden'); clearTimeout(this.t); }

  // the working definition: a saved custom override if there is one, else the original
  original() { return courseById(this.baseId).holes[this.idx]; }
  current() {
    const c = loadCustom();
    return c && c.base === this.baseId && c.holes[this.idx] ? c.holes[this.idx] : this.original();
  }

  load() {
    const r = this.root;
    const base = courseById(this.baseId);
    const custom = loadCustom();
    const edited = custom && custom.base === this.baseId ? Object.keys(custom.holes).map(Number) : [];
    r.innerHTML = `
      <div class="ed-head"><h2>Course editor</h2><button class="btn" id="edClose">Close ✕</button></div>
      <div class="ed-body">
        <div class="ed-left">
          <div class="row">
            <select id="edCourse">${COURSES.map((c) => `<option value="${c.id}" ${c.id === this.baseId ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
            <select id="edHole">${base.holes.map((h, i) => `<option value="${i}" ${i === this.idx ? 'selected' : ''}>${i + 1}. ${h.name}${edited.includes(i) ? ' ✎' : ''}</option>`).join('')}</select>
          </div>
          <div class="ed-basics">
            <label>Par <select id="edPar"><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></label>
            <label>Yards <input id="edYds" type="number" min="60" max="700" step="1"></label>
            <label class="grow">Strategy note <input id="edTip" type="text" maxlength="400" placeholder="Shown on the hole intro card"></label>
          </div>
          <label class="ed-adv" for="edJson">Hole data (JSON): bunkers, water, trees, elevation and pins live here. See the field reference below.</label>
          <textarea id="edJson" spellcheck="false"></textarea>
          <div id="edErr" class="ed-err"></div>
          <div class="row wrap">
            <button class="btn primary" id="edPlay">Play-test this hole</button>
            <button class="btn" id="edSave">Save</button>
            <button class="btn" id="edRevert">Revert to original</button>
            <button class="btn" id="edCopy">Copy JSON</button>
          </div>
          <details class="ed-ref"><summary>Field reference</summary>
            <ul>
              <li><b>par</b>, <b>yds</b> – the centre line is scaled to the card yardage.</li>
              <li><b>path</b> – centre line [[x, y], …] in yards; x = right of the tee line, y = forward.</li>
              <li><b>fw</b> – fairway [[s, width], …] (yards along the line); omitted = a default fairway for the par.</li>
              <li><b>fb</b> – fairway bunkers [s, offset, rx, ry, rot°, kind]; kind = bunker | pot | waste.</li>
              <li><b>green</b> – { w, d, tilt: [side, front-to-back] %, raise ft, pins: [[x, y], …] } in yards.</li>
              <li><b>gb</b> – greenside bunkers [x, y, rx, ry, rot°, kind] relative to the green centre (y &lt; 0 = short).</li>
              <li><b>water</b> – { k: 'pond', s, o, r: [rx, ry] } along the hole, or { k: 'pond', g: [x, y], r, island } by the green; { k: 'creek', pts: [[s, o], …], w }.</li>
              <li><b>elev</b> – [[s, feet], …] height profile; <b>tilt</b> – cross slope %; <b>trees</b> – [[s, o, type, scale]].</li>
              <li><b>tip</b> – the caddie's strategy note shown in the hole intro.</li>
            </ul>
          </details>
        </div>
        <div class="ed-right">
          <canvas id="edCanvas"></canvas>
          <div id="edInfo" class="muted small"></div>
        </div>
      </div>`;
    const ta = $('edJson');
    ta.value = pretty(this.current());
    // the basics form and the JSON describe the same hole: edit either one
    const par = $('edPar'), yds = $('edYds'), tip = $('edTip');
    const syncForm = () => {
      let d; try { d = JSON.parse(ta.value); } catch (e) { return; }
      par.value = String(d.par); yds.value = d.yds ?? ''; tip.value = d.tip || '';
    };
    const syncJson = () => {
      let d; try { d = JSON.parse(ta.value); } catch (e) { $('edErr').textContent = 'Fix the JSON error before using these fields'; return; }
      d.par = +par.value;
      if (yds.value !== '') d.yds = +yds.value;
      if (tip.value.trim()) d.tip = tip.value; else delete d.tip;
      ta.value = pretty(d);
      this.preview();
    };
    syncForm();
    par.onchange = yds.oninput = tip.oninput = syncJson;
    ta.oninput = () => { clearTimeout(this.t); this.t = setTimeout(() => { syncForm(); this.preview(); }, 250); };
    $('edCourse').onchange = (e) => { this.baseId = e.target.value; this.idx = 0; this.load(); };
    $('edHole').onchange = (e) => { this.idx = +e.target.value; this.load(); };
    $('edClose').onclick = () => this.close();
    $('edSave').onclick = () => { if (this.save()) this.g.ui.toast('Saved to your custom course', 'good'); };
    $('edRevert').onclick = () => this.revert();
    $('edCopy').onclick = async () => { try { await navigator.clipboard.writeText(ta.value); this.g.ui.toast('Hole JSON copied'); } catch (e) { ta.select(); } };
    $('edPlay').onclick = () => {
      if (!this.save()) return;
      this.close();
      this.g.ui.start({ courseId: 'custom', holes: [this.idx], mode: 'single' });
    };
    this.preview();
  }

  parse() {
    const err = $('edErr');
    let def;
    try { def = JSON.parse($('edJson').value); } catch (e) { err.textContent = `JSON error: ${e.message}`; return null; }
    if (![3, 4, 5].includes(def.par)) { err.textContent = 'par must be 3, 4 or 5'; return null; }
    if (!(def.yds >= 60 && def.yds <= 700)) { err.textContent = 'yds must be between 60 and 700'; return null; }
    let hole;
    try { hole = new Hole(def, courseById(this.baseId), this.idx, { pinIndex: 0 }); } catch (e) { err.textContent = `Could not build the hole: ${e.message}`; return null; }
    err.textContent = '';
    return { def, hole };
  }

  save() {
    const p = this.parse();
    if (!p) return false;
    const c = loadCustom();
    const custom = c && c.base === this.baseId ? c : { base: this.baseId, holes: {} };
    custom.holes[this.idx] = p.def;
    saveCustom(custom);
    return true;
  }
  revert() {
    const c = loadCustom();
    if (c && c.base === this.baseId) { delete c.holes[this.idx]; saveCustom(c); }
    this.load();
  }

  // top-down plan: sample the hole's surface function on a grid
  preview() {
    const p = this.parse();
    const cv = $('edCanvas');
    const g = cv.getContext('2d');
    if (!p) { g.clearRect(0, 0, cv.width, cv.height); return; }
    const { hole: h, def } = p;
    const B = h.bounds;
    const bw = B.maxX - B.minX, bd = B.maxZ - B.minZ;
    const maxH = Math.min(560, innerHeight * 0.7), maxW = 340;
    const s = Math.min(maxW / bw, maxH / bd) || 1;
    cv.width = Math.round(bw * s); cv.height = Math.round(bd * s);
    const step = 2;
    for (let py = 0; py < cv.height; py += step) {
      for (let px = 0; px < cv.width; px += step) {
        const x = B.minX + (px + 1) / s, z = B.minZ + (py + 1) / s;
        g.fillStyle = COLORS[h.surface(x, z)] || '#333';
        g.fillRect(px, py, step, step);
      }
    }
    const P = (x, z) => [(x - B.minX) * s, (z - B.minZ) * s];
    g.strokeStyle = 'rgba(255,255,255,.6)'; g.setLineDash([4, 4]); g.lineWidth = 1;
    g.beginPath();
    h.path.forEach((q, i) => { const [x, y] = P(q.x, q.z); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke(); g.setLineDash([]);
    // pins
    const pins = def.green?.pins || [[0, 0]];
    pins.forEach((pin, i) => {
      const w = h.gToW(pin[0], pin[1]);
      const [x, y] = P(w.x, w.z);
      g.fillStyle = i === 0 ? '#ff4a3d' : '#fff';
      g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
    });
    const [tx, ty] = P(h.tee.x, h.tee.z);
    g.fillStyle = '#fff'; g.fillRect(tx - 3, ty - 3, 6, 6);
    const elev = (def.elev || [[0, 0]]).at(-1)[1];
    $('edInfo').innerHTML = `Par ${def.par} · ${def.yds} yds card · ${(h.length / YD).toFixed(0)} yds centre line · ${elev >= 0 ? '+' : ''}${elev} ft tee to green · ${pins.length} pin${pins.length > 1 ? 's' : ''} (red = first)`;
  }
}
