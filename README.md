# Pure Strike Golf

A 3D golf game built to be fun and physically honest. Every shot follows real ball-flight physics, and the game explains why it did what it did.

Four tribute courses:

| Course | Signature hole | What it teaches |
|---|---|---|
| **Augusta National** | 12 – Golden Bell | Elevation (plays-like yardage), fast sloping greens, missing on the correct side |
| **St Andrews Old Course** | 17 – Road Hole | Firm links bounce-and-run, wind, pot bunkers, huge double greens |
| **Pebble Beach** | 7 – Postage Stamp | Small targets, crosswinds over the ocean, carry vs total distance |
| **TPC Sawgrass** | 17 – Island Green | Penalty-area strategy, wedge distance and spin, relief options |

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

Double-click `start.bat`, or run:

```bash
node tools/serve.mjs
```

Then open http://localhost:8321. Three.js loads from the jsDelivr CDN, so the first load needs internet.

## Controls

| Key | Action |
|---|---|
| Space / click | Swing. Click 1 starts it, click 2 sets power, click 3 sets accuracy (Mario Golf style) |
| ← → (Shift = fine) | Aim |
| ↑ ↓ | Change club |
| Q / E | Draw / fade |
| R / F | High / low trajectory |
| V | Target view (click the ground to aim there) |
| G | Green-reading grid with flowing slope dots |
| P | Aim at the pin |
| Tab | Scorecard |
| Esc | Pause menu |
| C | Caddie advice |
| M | Sound on / off |
| Hold Space / F in flight | Fast-forward |
| Right-drag, mouse wheel | Orbit, zoom |

**Analog swing** (menu → Swing → Analog) is Tiger Woods PSP style. Drag down for the backswing, then push up for the downswing.
- Length of the backswing sets power.
- Tempo sets strike quality.
- Sideways drift opens or closes the face.

## What makes it realistic

- **Ball flight.** A 3D aerodynamic model covers drag, Magnus lift, spin decay, air density and a wind profile. It is calibrated against TrackMan tour averages for carry, apex and landing angle (`tools/calibrate.mjs`).
- **D-plane launch.** Start direction comes mostly from the face (~75% for irons, ~85% for driver). Curve comes from face-to-path. Strike quality changes smash factor.
- **Turf interaction.** Restitution, friction and a Penner-style "crater" model decide bounce, check and release. Shallow long irons run out; steep wedges stop or spin back. Links turf is firmer than Augusta's.
- **Lies.** Tee, fairway, cuts of rough, deep rough, pine straw, bunkers, waste areas and cart paths each change speed, spin and launch. Mario Golf's "lie %" is shown in the HUD. Sloping lies aim the face left or right.
- **Putting.** Green speed is set as a real Stimpmeter reading. Break comes from the actual terrain slope. The meter marker teaches Dave Pelz's "17 inches past" speed.
- **Caddie.** Plays-like distance accounts for elevation and wind. The power marker aims for where the ball *finishes*, not where it lands. The expected-strokes analysis compares clubs from the tee.
- **Stats.** After every shot you see Strokes Gained against the PGA Tour baseline (Mark Broadie's method), plus a launch-monitor readout and coaching tips. The round summary shows where you lost strokes.
- **Rules.** Penalty areas offer stroke-and-distance, back-on-the-line and lateral relief. Each option shows its expected score. Out of bounds is stroke and distance.
- **Golf Academy.** A Ball Flight Lab with sliders for face, path, strike, wind and air density, plus ten short lessons: D-plane, smash factor, wind, altitude, lies, landing angle, putting, strokes gained and strategy.

Difficulty levels (Beginner, Standard, Pro) change meter speed, the size of the sweet spot and how much the caddie previews.

## Research that shaped the design

- **Mario Golf: Toadstool Tour (GameCube).** Three-click power meter, lie percentage, green grid, approachable arcade feel. Sources: GameFAQs guide, StrategyWiki controls.
- **Mario Golf: Super Rush (Switch).** Readable HUD, shot shaping with spin, fast pace of play. Sources: Nintendo site, Game8 controls guide, Wikipedia.
- **Tiger Woods PGA Tour (PSP).** Analog swing, broadcast-style cameras and presentation. Source: [GameSpot review](https://www.gamespot.com/reviews/tiger-woods-pga-tour-review/1900-6121049/).
- **Real golf data.** TrackMan PGA Tour averages; Golf Monthly club-distance tables; Broadie's *Every Shot Counts* for strokes gained; Pelz's putting research. Augusta hole yardages come from the Masters scorecard, and hole character from public hole-by-hole guides.

## Project layout

```
index.html, styles.css    UI shell and broadcast-style HUD
src/physics.js            ball flight, turf bounce/roll, putting, lie effects
src/clubs.js              golfer profiles and bags (tour, scratch, 15 hcp, smooth swinger)
src/hole.js, world.js     procedural terrain, hazards, trees and rendering for each hole
src/courses/*.js          the four course definitions
src/game.js               game loop, cameras, caddie, rules, round flow
src/golfer.js             animated golfer
src/meter.js              3-click meter and analog mouse swing
src/coach.js, stats.js    coaching tips, strokes gained, expected strokes
src/academy.js            Golf Academy lessons and Ball Flight Lab
src/ui.js, audio.js       menus, HUD, scorecard, synthesized audio
tools/                    dev server and physics test scripts
legacy/                   the earlier arcade mini-golf prototype
```

Physics checks: `node tools/calibrate.mjs`, `node tools/bounce-test.mjs`, `node tools/holes-test.mjs`.

---

The courses are tribute recreations based on public scorecards and hole guides. They are not affiliated with or endorsed by any club, tour or game publisher.
