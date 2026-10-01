# Pure Strike Golf

A 3D golf game built to be fun and physically honest. Every shot follows real ball-flight physics, and the game explains why it did what it did.

**Play it in your browser: https://acolyer13.github.io/pure-strike-golf/**

Four tribute courses, plus random courses and your own edits:

| Course | Signature hole | What it teaches |
|---|---|---|
| **Augusta National** | 12 – Golden Bell | Elevation (plays-like yardage), fast sloping greens, missing on the correct side |
| **St Andrews Old Course** | 17 – Road Hole | Firm links bounce-and-run, wind, pot bunkers, huge double greens |
| **Pebble Beach** | 7 – Postage Stamp | Small targets, crosswinds over the ocean, carry vs total distance |
| **TPC Sawgrass** | 17 – Island Green | Penalty-area strategy, wedge distance and spin, relief options |
| **Random course** | – | A new 9 holes built from a seed, in the style of one of the courses above |

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. Running the game needs no install, because three.js is vendored in `vendor/`.

Double-click `start.bat`, or run:

```bash
node tools/serve.mjs
```

Then open http://localhost:8321.

The game is an installable PWA. After the first load it works offline. The service worker is network-first, so a reload always picks up new code when you're online. Add `?nosw` to the URL to skip the service worker while developing.

## Ways to play

- **Play a hole now.** Jumps straight onto the course's signature hole.
- **Full 18, front 9, back 9 or a single hole.**
- **Daily challenge.** Three holes, with the same pins and wind for everyone that day. Your best score for the day is kept.
- **Closest to the pin.** Five balls on a par 3. Earlier balls stay on screen as ghost traces.
- **Long drive.** Five drives; only drives that finish in the fairway or first cut count.
- **Random holes.** A procedurally generated 9-hole, par-36 course. The same seed always makes the same holes.
- **Hot-seat.** Up to 4 players share one device. Each player gets their own outfit and scorecard row, plus a leaderboard at the end.
- **Challenge links.** After a round, *Copy challenge link* gives a URL with the course, holes, pins and wind. A friend who opens it plays the same conditions and sees your score to beat.
- **Course editor.** Edit any hole's definition as JSON with a live plan-view preview, then play-test it. Your edits are saved to a separate "custom" course, so the tribute courses never change.

**Stats** (menu) shows:
- A World Handicap System index, worked out from your rounds.
- Strokes Gained trends per category (off the tee, approach, around the green, putting).
- Personal bests per course and mode, and a recent-rounds table.

## Controls

All keys can be changed in **Settings → Controls**.

| Key | Action |
|---|---|
| Space / click | Swing. Click 1 starts it, click 2 sets power, click 3 sets accuracy (Mario Golf style) |
| ← → or A / D (Shift = fine) | Aim |
| ↑ ↓ or W / S | Change club |
| Q / E | Draw / fade |
| R / F | High / low trajectory |
| V | Target view (click the ground to aim there) |
| G | Green-reading grid with flowing slope dots |
| P | Aim at the pin |
| C | Caddie advice |
| Hold Space / F in flight | Fast-forward |
| Enter | Skip to where the ball stops |
| X | Replay the last shot |
| Tab (hold) | Scorecard |
| M | Sound on / off |
| Esc | Pause menu |
| Right-drag, mouse wheel | Orbit, zoom |

**Analog swing** (setup → Swing → Analog) is Tiger Woods PSP style. Drag down for the backswing, then push up for the downswing.
- Length of the backswing sets power.
- Tempo sets strike quality.
- Sideways drift opens or closes the face.

**Gamepad** (standard mapping):
- A: swing / continue. B: skip. X: fade. Y: target view (replay on the result screen).
- LB / RB: change club. D-pad or left stick: aim. LT / RT: fine aim. D-pad ↑ ↓: trajectory.
- Right stick: analog swing (pull back, then push forward smoothly).

**Touch.** On phones and tablets, on-screen buttons appear and the HUD switches to a compact layout.

## Accessibility

Settings → Accessibility has these options:
- **One-button swing.** Power is set for you at the caddie's suggested level, so you only start the swing and time the accuracy click.
- **Reduced motion.** No flyovers, slow-motion or camera punches. Also turns on automatically if your OS asks for reduced motion.
- **Captions** for crowd reactions and other sound cues.
- **Interface size** from 80% to 150%.
- **Penalty areas** are marked with red stakes on the course and red hatching on the minimap, so you can find them without telling colours apart.

## What makes it realistic

- **Ball flight.** A 3D aerodynamic model covers drag, Magnus lift, spin decay, air density and a wind profile. It is calibrated against TrackMan tour averages for carry, apex and landing angle (`npm run calibrate`).
- **D-plane launch.** Start direction comes mostly from the face (~75% for irons, ~85% for driver). Curve comes from face-to-path. Strike quality changes smash factor.
- **Turf interaction.** Restitution, friction and a Penner-style "crater" model decide bounce, check and release. Shallow long irons run out; steep wedges stop or spin back. Links turf is firmer than Augusta's.
- **Lies.** Tee, fairway, cuts of rough, deep rough, pine straw, bunkers, waste areas and cart paths each change speed, spin and launch. Mario Golf's "lie %" is shown in the HUD. Sloping lies aim the face left or right.
- **Putting.** Green speed is set as a real Stimpmeter reading. Break comes from the actual terrain slope. The meter marker teaches Dave Pelz's "17 inches past" speed.
- **Caddie.** Plays-like distance accounts for elevation and wind. The power marker aims for where the ball *finishes*, not where it lands. The expected-strokes analysis compares clubs from the tee.
- **Stats.** After every shot you see Strokes Gained against the PGA Tour baseline (Mark Broadie's method), plus a launch-monitor readout and coaching tips. The round summary shows where you lost strokes.
- **Rules.** Penalty areas offer stroke-and-distance, back-on-the-line and lateral relief. Each option shows its expected score. Out of bounds is stroke and distance.
- **Determinism.** Each round has a seed that fixes every hole's pin and wind. That seed is what makes daily challenges and challenge links fair.
- **Golf Academy.** A Ball Flight Lab with sliders for face, path, strike, wind and air density, plus ten short lessons: D-plane, smash factor, wind, altitude, lies, landing angle, putting, strokes gained and strategy.

Difficulty levels (Beginner, Standard, Pro) change meter speed, the size of the sweet spot and how much the caddie previews.

## Research that shaped the design

- **Mario Golf: Toadstool Tour (GameCube).** Three-click power meter, lie percentage, green grid, approachable arcade feel. Sources: GameFAQs guide, StrategyWiki controls.
- **Mario Golf: Super Rush (Switch).** Readable HUD, shot shaping with spin, fast pace of play. Sources: Nintendo site, Game8 controls guide, Wikipedia.
- **Tiger Woods PGA Tour (PSP).** Analog swing, broadcast-style cameras and presentation. Source: [GameSpot review](https://www.gamespot.com/reviews/tiger-woods-pga-tour-review/1900-6121049/).
- **Real golf data.** TrackMan PGA Tour averages; Golf Monthly club-distance tables; Broadie's *Every Shot Counts* for strokes gained; Pelz's putting research; the World Handicap System rules. Augusta hole yardages come from the Masters scorecard, and hole character from public hole-by-hole guides.

## Project layout

```
index.html, styles.css    UI shell, menu and broadcast-style HUD
sw.js, manifest.json      offline / installable PWA
vendor/three/             three.js 0.169 (MIT), loaded through the import map
src/main.js               boot: wires UI, game, academy and editor together
src/game.js               game loop and round flow (state machine)
src/camera.js             flyover, address, flight, landing and reverse-angle cameras
src/input.js              keyboard (rebindable), mouse, touch and gamepad -> named actions
src/caddie.js, rules.js   club advice and expected strokes; penalty relief
src/round.js              modes, seeds, daily challenge, challenge links
src/history.js            saved rounds, personal bests, handicap index, SG trends
src/physics.js            ball flight, turf bounce/roll, putting, lie effects
src/clubs.js              golfer profiles and bags (tour, scratch, 15 hcp, smooth swinger)
src/hole.js, world.js     procedural terrain, hazards, trees and rendering for each hole
src/courses/*.js          the four course definitions + the procedural course generator
src/golfer.js             animated golfer
src/meter.js              3-click meter, one-button and analog mouse swing
src/coach.js, stats.js    coaching tips, strokes gained, expected strokes
src/academy.js            Golf Academy lessons and Ball Flight Lab
src/editor.js             course editor
src/ui.js, audio.js       menus, HUD, scorecard, stats, settings; synthesized SoundEngine
tests/                    node:test suites (physics, hole geometry, rounds/history)
tools/                    dev server and physics calibration scripts
legacy/                   the earlier arcade mini-golf prototype
```

## Development

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs ESLint and the test suite. You can also run `npm test` or `npm run lint` on their own. `jsconfig.json` turns on type-checking from JSDoc comments in editors that support it (such as VS Code).

Physics scripts: `node tools/calibrate.mjs`, `node tools/bounce-test.mjs`, `node tools/holes-test.mjs`.

---

The courses are tribute recreations based on public scorecards and hole guides. They are not affiliated with or endorsed by any club, tour or game publisher.
