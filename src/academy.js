// Golf Academy: short lessons on what actually matters, plus a Ball Flight Lab
// that runs the game's own physics so players can see cause and effect.
import { computeLaunch, simulateCarry, BallSim, LIES } from './physics.js';
import { buildBag, PROFILES } from './clubs.js';
import { YD, mulberry32 } from './hole.js';

const $ = (id) => document.getElementById(id);
const MPH = 0.44704;

const LESSONS = [
  { id: 'dplane', title: 'Ball flight laws (D-plane)',
    text: `<p>Where the ball <b>starts</b> is mostly decided by the <b>clubface</b> (~75% for an iron, ~85% for a driver). How it <b>curves</b> is decided by the face <b>relative to the swing path</b>.</p>
      <ul><li>Face open to path → curves right (fade / slice)</li><li>Face closed to path → curves left (draw / hook)</li><li>Face = path → straight, even if that line is off target (a push or pull)</li></ul>
      <p>That is why a slicer who aims further left makes it <i>worse</i>: the path gets more out-to-in and the face even more open to it.</p>`,
    presets: [['Push-fade', { face: 3, path: 0 }], ['Classic slice', { face: 2, path: -6 }], ['Tour draw', { face: -1, path: 3 }], ['Pull-hook', { face: -5, path: 1 }]] },
  { id: 'smash', title: 'Centred strikes = distance',
    text: `<p><b>Smash factor</b> = ball speed ÷ club speed. A perfectly centred driver hit reaches ~1.48–1.50. A strike a centimetre off the sweet spot can cost 5–10 yards – as much as losing 5 mph of swing speed.</p>
      <p>Lower the <b>Strike</b> slider and watch ball speed and carry fall while club speed stays the same.</p>`,
    presets: [['Pure', { club: 'DR', strike: 1 }], ['Slight miss', { club: 'DR', strike: 0.7 }], ['Poor strike', { club: 'DR', strike: 0.35 }]] },
  { id: 'driver', title: 'Launch + spin: optimising the driver',
    text: `<p>For maximum carry a driver wants <b>high launch and low spin</b>: about 12–15° launch and 2,000–2,700 rpm at tour speeds. Too much spin and the ball balloons and stops; too little and it falls out of the sky.</p>
      <p>Use the Trajectory buttons: a higher tee/ball position adds launch without adding much spin.</p>`,
    presets: [['Standard', { club: 'DR', traj: 0 }], ['High launch', { club: 'DR', traj: 1 }], ['Low / knock-down', { club: 'DR', traj: -1 }]] },
  { id: 'wind', title: 'Wind: why a headwind hurts more',
    text: `<p>A 10 mph headwind costs more distance than a 10 mph tailwind adds. Into the wind the relative airspeed rises, drag and lift both increase with its <i>square</i>, so the ball climbs and falls short. Downwind, lift is reduced and the ball falls earlier.</p>
      <p>Tip: into the wind, "swing easy" – less speed = less spin = a lower, more penetrating flight. "When it's breezy, swing easy."</p>`,
    presets: [['Calm', { club: '7I', wind: 0 }], ['10 mph into', { club: '7I', wind: 10, windDir: 0 }], ['10 mph helping', { club: '7I', wind: 10, windDir: 180 }], ['15 mph L→R', { club: '7I', wind: 15, windDir: 270 }]] },
  { id: 'air', title: 'Altitude, temperature and elevation',
    text: `<p>Thin air means less drag and less lift. At Denver altitude (1,600 m) the ball carries ~7–9% further. Cold, dense air costs about 1 yard per 10 °F for a mid-iron.</p>
      <p>Elevation is separate: a green 30 ft above you plays ~10 yards longer, because the ball meets it earlier on the way down. The in-game "plays like" number includes both elevation and wind.</p>`,
    presets: [['Sea level, cool', { club: '6I', rho: 1.24 }], ['Standard', { club: '6I', rho: 1.2 }], ['Mile high', { club: '6I', rho: 1.0 }]] },
  { id: 'lies', title: 'Lies: rough, flyers and sand',
    text: `<p>From the rough, grass gets trapped between the face and the ball. Spin drops sharply, so the ball launches a bit higher, curves less, and runs out: a <b>flyer</b>. From deep rough the club is slowed and twisted as well.</p>
      <p>A greenside bunker shot never touches the ball: the club enters the sand ~2" behind it and the sand throws the ball out. You swing about twice as hard as for a pitch of the same length.</p>`,
    presets: [['Fairway 8I', { club: '8I', lie: 'fairway' }], ['Rough 8I', { club: '8I', lie: 'rough' }], ['Deep rough 8I', { club: '8I', lie: 'deep' }], ['Bunker SW', { club: 'SW', lie: 'splash' }]] },
  { id: 'descent', title: 'Stopping power: descent angle and spin',
    text: `<p>Whether a ball stops on a green depends on its <b>landing angle</b> and spin. Tour players land irons at ~45–50°. Below ~40° the ball releases on firm greens.</p>
      <p>Compare a 5-iron hit low and high: same club, very different stopping power. This is why long-iron approaches to firm greens are so hard, and why hybrids (higher launch) help most players.</p>`,
    presets: [['5 iron low', { club: '5I', traj: -1 }], ['5 iron high', { club: '5I', traj: 1 }], ['Hybrid', { club: '3H', traj: 0 }], ['Wedge', { club: 'PW', traj: 0 }]] },
  { id: 'putting', title: 'Putting: speed first',
    text: `<p>Dave Pelz measured the ideal putting speed as the one that would roll the ball <b>~17 inches (43 cm) past the hole</b>. It holds its line through the footprinted, bumpy ring near the cup and still drops when it catches the edge.</p>
      <ul><li>A ball dying at the hole breaks the most – most golfers under-read break and miss on the low side.</li><li>From 30+ ft, pros two-putt ~90% of the time: the goal is leaving it inside 3 ft, not making it.</li><li>Uphill putts break less and need more pace; downhill putts break more.</li></ul>
      <p>The Stimpmeter number is how many feet a ball released at 1.83 m/s rolls: Augusta ~13, a typical club course ~9.</p>` },
  { id: 'sg', title: 'Strokes gained: what matters',
    text: `<p>Mark Broadie's <b>strokes gained</b> compares every shot to the tour average from the same spot. A 7 ft putt is holed about half the time (~1.5 strokes expected), so making it gains +0.5 and missing loses −0.5.</p>
      <p>His findings changed how golf is taught:</p>
      <ul><li>The long game (tee and approach shots) explains about two-thirds of the scoring gap between golfers. Putting explains ~15%.</li><li>Distance off the tee matters more than accuracy, <i>unless</i> the miss brings penalties into play.</li><li>Approach shots from 150–200 yards separate great players from good ones.</li></ul>
      <p>The game tracks SG for every shot and shows your weakest area at the end of the round.</p>` },
  { id: 'strategy', title: 'Course management and dispersion',
    text: `<p>Every golfer has a shot <b>pattern</b>, not a single shot. A 15-handicap's 7-iron lands in an ellipse roughly 30 yards long and 25 wide. Aim so that the whole pattern avoids the worst trouble, even if that means aiming away from the flag.</p>
      <ul><li>Water or out of bounds costs about a stroke – more than a bunker or rough.</li><li>Lay up to a <b>full</b> wedge distance rather than an awkward half-shot.</li><li>On short-sided pins, the centre of the green is usually worth more than the flag.</li></ul>
      <p>The in-game caddie runs this maths when you are out of range: it simulates each club with realistic misses and shows the expected score.</p>` },
];

export class Academy {
  constructor() {
    this.root = $('academy');
    this.s = { club: '7I', profile: 'scratch', power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway', wind: 0, windDir: 0, rho: 1.2, firm: 1 };
    this.lesson = LESSONS[0];
  }
  open() {
    this.root.classList.remove('hidden');
    this.render();
  }
  close() { this.root.classList.add('hidden'); }

  render() {
    const r = this.root;
    r.innerHTML = `
      <div class="ac-head"><h1>Golf Academy</h1><button class="btn" id="acClose">Back to menu ✕</button></div>
      <div class="ac-body">
        <nav class="ac-list">${LESSONS.map((l, i) => `<button class="ac-item ${l === this.lesson ? 'on' : ''}" data-i="${i}"><span>${i + 1}</span>${l.title}</button>`).join('')}</nav>
        <section class="ac-main">
          <div class="ac-lesson"><h2>${this.lesson.title}</h2>${this.lesson.text}
            ${this.lesson.presets ? `<div class="ac-presets">${this.lesson.presets.map(([n], i) => `<button class="seg" data-p="${i}">${n}</button>`).join('')}</div>` : ''}</div>
          <div class="lab">
            <div class="lab-views"><canvas id="labSide"></canvas><canvas id="labTop"></canvas></div>
            <div class="lab-ctl" id="labCtl"></div>
            <div class="lab-out" id="labOut"></div>
          </div>
        </section>
      </div>`;
    $('acClose').onclick = () => this.close();
    r.querySelectorAll('.ac-item').forEach((b) => (b.onclick = () => { this.lesson = LESSONS[+b.dataset.i]; this.shots = []; this.render(); }));
    r.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => {
      const [name, p] = this.lesson.presets[+b.dataset.p];
      Object.assign(this.s, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway', wind: 0, windDir: 0, rho: 1.2 }, p);
      this.addShot(name);
      this.renderControls();
    }));
    this.shots = this.shots || [];
    this.renderControls();
    this.run();
  }

  renderControls() {
    const s = this.s;
    const bag = buildBag(s.profile).filter((c) => !c.putter);
    this.fmts = {};
    const slider = (k, label, min, max, step, fmt) => (this.fmts[k] = fmt, `<label><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}"><b>${fmt(s[k])}</b></label>`);
    $('labCtl').innerHTML = `
      <label><span>Golfer</span><select data-k="profile">${Object.entries(PROFILES).map(([k, p]) => `<option value="${k}" ${k === s.profile ? 'selected' : ''}>${p.name}</option>`).join('')}</select></label>
      <label><span>Club</span><select data-k="club">${bag.map((c) => `<option value="${c.key}" ${c.key === s.club ? 'selected' : ''}>${c.name}</option>`).join('')}</select></label>
      <label><span>Lie</span><select data-k="lie">${Object.keys(LIES).filter((k) => k !== 'green').map((k) => `<option value="${k}" ${k === s.lie ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      ${slider('power', 'Swing', 0.4, 1.1, 0.01, (v) => `${Math.round(v * 100)}%`)}
      ${slider('face', 'Face', -8, 8, 0.5, (v) => `${v > 0 ? '+' : ''}${v}° ${v > 0 ? 'open' : v < 0 ? 'closed' : ''}`)}
      ${slider('path', 'Path', -8, 8, 0.5, (v) => `${v > 0 ? '+' : ''}${v}° ${v > 0 ? 'in-out' : v < 0 ? 'out-in' : ''}`)}
      ${slider('strike', 'Strike', 0.2, 1, 0.05, (v) => (v >= 0.95 ? 'centre' : `${Math.round((1 - v) * 100)}% off`))}
      ${slider('traj', 'Trajectory', -1, 1, 1, (v) => ['Low', 'Standard', 'High'][v + 1])}
      ${slider('wind', 'Wind', 0, 25, 1, (v) => `${v} mph`)}
      ${slider('windDir', 'Wind from', 0, 345, 15, (v) => ({ 0: 'ahead (into)', 90: 'the right', 180: 'behind (helping)', 270: 'the left' }[v] || `${v}°`))}
      ${slider('rho', 'Air density', 0.95, 1.3, 0.01, (v) => `${v.toFixed(2)} kg/m³`)}
      <div class="lab-btns"><button class="btn primary" id="labHit">Hit & compare</button><button class="btn" id="labClear">Clear</button></div>`;
    $('labCtl').querySelectorAll('[data-k]').forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.k;
        this.s[k] = inp.tagName === 'SELECT' ? inp.value : +inp.value;
        if (inp.tagName === 'SELECT') { this.renderControls(); return; }
        inp.nextElementSibling.textContent = this.fmts[k](this.s[k]);
        this.run();
      };
    });
    $('labHit').onclick = () => this.addShot();
    $('labClear').onclick = () => { this.shots = []; this.run(); };
    this.run();
  }

  compute() {
    const s = this.s;
    const bag = buildBag(s.profile);
    const club = bag.find((c) => c.key === s.club) || bag[7];
    const ld = computeLaunch(club, { power: s.power, face: s.face, path: s.path, strike: s.strike, traj: s.traj, lie: s.lie });
    const a = (s.windDir * Math.PI) / 180; // direction the wind comes FROM, relative to target (0 = ahead)
    const wind = [-Math.sin(a) * s.wind * MPH, 0, Math.cos(a) * s.wind * MPH]; // target is -z
    const fl = simulateCarry(ld, { rho: s.rho, wind }, { fwd: [0, 0, -1], path: true, dt: 1 / 240 });
    // total with roll on a flat fairway
    const flat = { height: () => 0, normal: () => [0, 1, 0], surface: () => 'fairway', inBounds: () => true, cup: { x: 1e5, z: 1e5 }, pinIn: false };
    const sim = new BallSim(flat, { rho: s.rho, wind, firmness: s.firm, stimp: 11 }, mulberry32(1));
    sim.launch([0, 0.02, 0], ld, [0, 0, -1]);
    let n = 0;
    const pts = [];
    while (sim.state !== 'rest' && n++ < 20000) { sim.step(1 / 240); if (n % 4 === 0) pts.push(sim.p.slice()); }
    return { club, ld, fl, total: -sim.p[2], totalLat: sim.p[0], pts };
  }

  addShot(name) {
    const r = this.compute();
    r.name = name || `${r.club.name} ${Math.round(this.s.power * 100)}%`;
    this.shots.push(r);
    if (this.shots.length > 5) this.shots.shift();
    this.run();
  }

  run() {
    const cur = this.compute();
    this.cur = cur;
    const ld = cur.ld, fl = cur.fl;
    const yd = (m) => `${(m / YD).toFixed(0)} yd`;
    const f2p = ld.f2p;
    const shape = Math.abs(f2p) < 1 ? 'straight' : f2p > 0 ? (f2p > 6 ? 'slice' : 'fade') : (f2p < -6 ? 'hook' : 'draw');
    const start = Math.abs(ld.hLaunch) < 1 ? 'on line' : `${Math.abs(ld.hLaunch).toFixed(1)}° ${ld.hLaunch > 0 ? 'right' : 'left'}`;
    $('labOut').innerHTML = [
      ['Club speed', `${ld.clubMph.toFixed(1)} mph`], ['Ball speed', `${ld.ballMph.toFixed(1)} mph`], ['Smash', ld.smash.toFixed(2)],
      ['Launch', `${ld.launch.toFixed(1)}°`], ['Spin', `${Math.round(ld.spinRpm).toLocaleString()} rpm`], ['Spin axis', `${ld.axisTilt.toFixed(1)}°`],
      ['Start line', start], ['Shape', shape], ['Apex', `${(fl.apex / 0.3048).toFixed(0)} ft`],
      ['Land angle', `${fl.landAngle.toFixed(0)}°`], ['Carry', yd(fl.carry)], ['Total', yd(cur.total)],
      ['Offline', `${(Math.abs(cur.totalLat) / YD).toFixed(0)} yd ${cur.totalLat >= 0 ? 'R' : 'L'}`],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    this.draw();
  }

  draw() {
    const side = $('labSide'), top = $('labTop');
    if (!side) return;
    const all = this.shots.concat([Object.assign(this.cur, { name: 'Current', current: true })]);
    const maxD = Math.max(120, ...all.map((s) => Math.max(s.total, s.fl.carry))) * 1.08;
    const maxH = Math.max(20, ...all.map((s) => s.fl.apex)) * 1.25;
    const colors = ['#6fb3ff', '#ffb35c', '#b48cff', '#6fe0b0', '#ff7ca8'];
    const prep = (cv) => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = cv.clientWidth, h = cv.clientHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#12261b'; g.fillRect(0, 0, w, h);
      return [g, w, h];
    };
    // side view
    {
      const [g, w, h] = prep(side);
      const L = 36, B = h - 22;
      const sx = (w - L - 12) / maxD, sy = Math.min((B - 12) / maxH, sx * 3);
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = '11px Barlow, sans-serif';
      for (let d = 0; d <= maxD / YD; d += 50) { const x = L + d * YD * sx; g.beginPath(); g.moveTo(x, 8); g.lineTo(x, B); g.stroke(); g.fillText(`${d}`, x - 8, h - 6); }
      for (let hh = 0; hh <= maxH / 0.3048; hh += 25) { const y = B - hh * 0.3048 * sy; if (y < 6) break; g.fillText(`${hh}ft`, 2, y + 3); }
      g.fillStyle = '#2f6b37'; g.fillRect(0, B, w, h - B);
      all.forEach((s, i) => {
        g.strokeStyle = s.current ? '#fff' : colors[i % colors.length]; g.lineWidth = s.current ? 2.5 : 1.5;
        g.beginPath();
        s.pts.forEach((p, k) => { const x = L + -p[2] * sx, y = B - p[1] * sy; k ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.stroke();
      });
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillText('Side view (yards / feet)', L, 16);
    }
    // top view
    {
      const [g, w, h] = prep(top);
      const L = 20, cy = h / 2;
      const sx = (w - L - 12) / maxD;
      const maxLat = Math.max(20, ...all.map((s) => Math.max(...s.pts.map((p) => Math.abs(p[0])))));
      const sy = Math.min((h / 2 - 10) / maxLat, sx * 2.5);
      g.fillStyle = '#2f6b37';
      g.fillRect(L, cy - 17 * sy, w, 34 * sy); // a 34 m wide fairway
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(L, cy); g.lineTo(w, cy); g.stroke(); g.setLineDash([]);
      all.forEach((s, i) => {
        g.strokeStyle = s.current ? '#fff' : colors[i % colors.length]; g.lineWidth = s.current ? 2.5 : 1.5;
        g.beginPath();
        s.pts.forEach((p, k) => { const x = L + -p[2] * sx, y = cy + p[0] * sy; k ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.stroke();
        const e = s.pts[s.pts.length - 1];
        g.fillStyle = g.strokeStyle; g.beginPath(); g.arc(L + -e[2] * sx, cy + e[0] * sy, 3, 0, 7); g.fill();
      });
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.font = '11px Barlow, sans-serif'; g.fillText('Top view (right is down)', L + 4, 14);
      // legend
      let lx = w - 10; g.textAlign = 'right';
      [...all].reverse().forEach((s, i) => { g.fillStyle = s.current ? '#fff' : colors[(all.length - 1 - i) % colors.length]; g.fillText(s.name, lx, h - 8 - i * 13); });
      g.textAlign = 'left';
    }
  }
}
