#!/usr/bin/env node
/* global document, window, getComputedStyle, innerWidth, innerHeight, HTMLCanvasElement, CanvasRenderingContext2D, matchMedia */
// shots.mjs - screenshot + layout-metrics harness for Pure Strike Golf.
//
// Drives a private headless Chrome over the raw DevTools protocol (zero dependencies: Node's global
// WebSocket and fetch), walks the REAL game through a viewport x colour-scheme x UI-state matrix and
// writes, for every capture, a PNG, a "flat" PNG (3D scene replaced by a flat grey so the pixels are
// only DOM/CSS UI) and a JSON of objective layout metrics. Companion: tools/shots-diff.mjs.
//
// USAGE
//   node tools/shots.mjs [options]
//
// OPTIONS
//   --out <dir>            output directory (default: <os tmp>/psg-shots)
//   --viewport <list>      comma list of viewport names, tokens or custom specs (default: the six gate viewports)
//                            phone-xs 320x568@2 touch | phone 375x812@2 touch | phone-l 430x932@2 touch
//                            phone-land 812x375@2 touch | tablet 820x1180@2 touch | desktop 1440x900@1 mouse
//                            notch-land 812x375 and notch-port 375x812: phone-land / phone with the safe-area insets a
//                              notched phone reports (CDP Emulation.setSafeAreaInsetsOverride; land L/R 44 B 21, port T 47 B 34)
//                            edge viewports, named by size, always touch @2: w760 / w761 (width, with a portrait companion
//                              height: 812 up to 760 px wide, 1180 up to 1100, else 900), h500 / h501 (height, 740 wide),
//                              w599h375 / h600w375 (both given)
//                            tokens: gate (the six) | edge (see --list-viewports --edge) | notch (both notch viewports)
//                            custom: WxH[:dpr[:touch|mouse]]  e.g. 390x844:3:touch (touch is the default
//                            for a custom spec only if you say so; omitted means mouse, dpr 1)
//   --scheme <s>           dark (default) | light | both   (Emulation.setEmulatedMedia prefers-color-scheme)
//   --states <list>        comma list of state names; * wildcards allowed (menu*, tutorial-step-*); a preset expands in place:
//                            core   = 13 states that between them reach every region of the UI at every size (menu,
//                                     menu-drawer, settings, stats-filled, hole-intro, address-essential,
//                                     address-target-view, flight, result-open, pause, scorecard-final, specimen): the
//                                     preset for the many-viewport edge set
//                            layout = every state whose layout matters: core + help, academy-list, editor, swing-active, result,
//                                     address-putt, relief, confirm, summary, tutorial-step-*, and the stress / variant states
//                            default: every state.  --list-states prints them with their scenario.
//   --list-states          print state names (after preset expansion) and exit
//   --list-viewports       print viewport names, one per line, and exit: the six gate viewports; --edge: the edge set;
//                            --notch: the notch viewports
//   --edge                 with --list-viewports: the EDGE SET = every width / height threshold of every @media prelude in the
//                            LIVE styles.css, straddled one px either side (max-width:760 -> w760 and w761; min-width:600 ->
//                            w599 and w600) at a companion size that keeps the rest of that query true (an orientation, a
//                            max-height ...); plus w339 w340 w369 w370 (phone tiers the plan adds); plus fixed real sizes
//                            (360x740 360x640 375x667 667x375 568x320 600x900 767x1024 1180x820) and the notch viewports.
//                            The set follows the stylesheet, so to re-capture a reference use exactly its own viewport list
//                            (capture-par.mjs --like <refDir>), never a freshly generated --edge.
//   --notch                with --list-viewports: only the notch viewports
//   --no-flat              skip the .flat.png variants
//   --no-shots             write metrics only (no PNGs)
//   --fingerprint          also write <state>.fp.json, the computed style of every element (see FINGERPRINT);
//                            tools/shots-diff.mjs --fingerprint compares two such directories
//   --no-instrument        do not wrap CanvasRenderingContext2D text calls and addEventListener at start-up (the canvasText
//                            metric and the listener part of tapAll then see nothing). --perf turns it off by itself.
//   --perf                 also run the perf probe (see below) and write <out>/perf.json. Unless --states is
//                            given, --perf captures only address-essential and flight.
//   --perf-frames <n>      frames per perf probe (default 180)
//   --init-js <file>       JS run before the game boots (after the harness seeds storage)
//   --inject-css <file>    CSS appended as a <style> after load (re-applied for every page load)
//   --inject-js <file>     JS run after the game has booted (every page load)
//   --url <base>           use an already-running server (e.g. http://localhost:8321/) instead of starting one
//   --chrome <path>        Chrome/Edge executable (env CHROME_PATH also works)
//   --software             force SwiftShader WebGL (also the automatic fallback if the real GPU has no WebGL)
//   --live-clock           do NOT virtualise time: real rAF loop, timers, Date and Math.random (non-deterministic)
//   --timeout <ms>         per-step timeout (default 120000)
//   --keep-profile         keep the temporary Chrome profile
//   --verbose              log every CDP-level step
//   --help
//
// DETERMINISM
//   Unless --live-clock, the page boots with: requestAnimationFrame stubbed (the game only advances through
//   game.debugStep), a virtual performance.now/setTimeout/setInterval clock that moves only when a frame is
//   stepped, Date fixed at 2026-10-20T12:00Z (timezone UTC, locale en-US), Math.random seeded, localStorage
//   wiped of psg-* keys and re-seeded per scenario, ?nosw, CSS animations/transitions forced to their end
//   state, caret hidden, document.fonts.ready awaited. Two runs on the same build give identical .flat.png.
//
// STATES (name: how it is reached; scenario in brackets)
//   menu                 main menu, tutorial done, no history                                   [menu]
//   menu-drawer          "Round setup & options" <details> open                                  [menu]
//   settings             ui.showSettings(true), scrolled to the top                              [menu]
//   settings-bottom      same dialog scrolled to the end                                         [menu]
//   help                 ui.showHelp(true)                                                       [menu]
//   stats-empty          ui.showStats(true) with no rounds                                       [menu]
//   academy-list         Golf Academy open on its first lesson                                   [menu]
//   academy-lab          first lesson that has presets, a preset applied and "Hit & compare"     [menu]
//   editor               course editor on Magnolia hole 12                                       [menu]
//   menu-resume          psg-resume holds a 4-holes-played 18-hole round                         [resume]
//   menu-challenge       opened from #c=augusta.single.11.27.m.74                                [challenge]
//   stats-filled         ui.showStats(true) with 8 seeded rounds                                 [history]
//   boot-error           WebGL forced off: the "3D graphics aren't available" boot screen        [boot]
//   loading              ui.loading overlay while the hole builds (virtual 30 ms timer pending)  [round]
//   hole-intro           flyover with the intro card                                             [round]
//   address-essential    tee shot at address, the one HUD                                         [round]
//   toast-banner         ui.toast x2 + ui.banner sample text over address (synthetic text)       [round]
//   address-target-view  game.toggleTargetView()                                                 [round]
//   scorecard-peek       game.peekScorecard()                                                    [round]
//   pause                ui.togglePause()                                                        [round]
//   confirm              pause menu -> "Main menu" -> "Quit this hole?" confirm box              [round]
//   swing-active         meter running (game.meterClick(), needle mid power)                     [round]
//   flight               ball in the air a few frames after impact                               [round]
//   result               shot panel collapsed after game.skipFlight()                            [round]
//   result-open          shot panel with "Details" expanded                                      [round]
//   address-putt-target[-long|-short]  the putting target view (look-down framing of the whole putt)   [round]
//   address-putt-target[-long|-short]  the putting target view: a look-down frame of the whole putt   [round]
//   address-putt         putting address (ball on the green; teleported next to the cup if the shot missed) [round]
//   relief               relief dialog (real if the shot went in the water, else built from rules.reliefOptions
//                        with a real water edge point - synthetic entry, real dialog)             [round]
//   scorecard-final      end-of-hole scorecard from game.finishHole()                            [round]
//   summary              round summary from the scorecard's "Finish round"                       [round]
//   menu-firstrun        first-ever visit: primary button is the guided hole                     [tutorial]
//   tutorial-step-<id>   coach mark for each step that becomes active while the guided hole is
//                        played by the harness: flyover distance wind club aim meter result
//                        green putt [tutorial]; relief again holed [tutorial-extra] come from the real
//                        tutorial, stepping the game until each card is up (never a fixed frame count)
//   -- added with the wider oracle (everything above is unchanged and stays bit-identical) --
//   toast-over-dialog    Settings open with three toasts and a banner stacked over it             [menu-extra]
//   big-root-font-20|32  the menu with the root font size forced to 20 / 32 px (a browser set to 125% / 200%) [menu-extra]
//   menu-setup-stress    menu: St Andrews hole 17, four players with 72-character names, setup drawer and "About" open [menu-setup]
//   ui-scale-1.5|0.8     the menu with the UI-scale setting at 1.5 / 0.8; -settings: Settings open; -address: tee shot at address [ui-scale-*]
//   stats-many           ui.showStats(true) with 45 seeded rounds; stats-many-bottom: scrolled to the end [history-many]
//   address-target-view-input  target view entered through the input path (input.dispatch('targetView') -> updateHUD(true)) [round-extra]
//   hole-name-stress     two players with 72-character names on the course hole with the longest name; -address;
//                        -turn (hole-out toast + next-player banner); -scorecard; -summary           [hole-name-stress]
//   summary-hotseat      finished 4-player 9-hole round (from a saved snapshot): its summary; scorecard-hotseat: its scorecard [summary-extra]
//   summary-challenge    finished closest-to-the-pin challenge, two players, against a score to beat [summary-extra]
//   summary-share        the share box that shows the link when the clipboard write is refused     [summary-extra]
//   boot                 the #boot screen while the game module is held back (the boot spinner)     [boot-held]
//   boot-load-failed     the same screen when the game module fails to load                          [boot-failed]
//   specimen             every dynamic body class on and every panel unhidden at once, with sample content wherever the
//                        game only fills a panel at run time, so stylesheet rules no ordinary state reaches still render [specimen]
//
// OUTPUT
//   <out>/<viewport>/<scheme>/<state>.png         viewport at its dpr
//   <out>/<viewport>/<scheme>/<state>.flat.png    #c and #swingOverlay replaced by flat rgb(128,128,128)
//   <out>/<viewport>/<scheme>/<state>.json        metrics (fields documented below)
//   <out>/<viewport>/<scheme>/<state>.fp.json     computed-style fingerprint, with --fingerprint
//   <out>/manifest.json   { captures:[{file,flatFile,metricsFile,fingerprintFile?,viewport:{name,w,h,dpr,touch,insets?},scheme,state}],
//                           missing:[{viewport,scheme,state,reason}], ... }
//   <out>/perf.json       with --perf
//
// METRICS JSON (all lengths CSS px unless noted; "visible" = display/visibility/opacity>0.02, non-empty box
// after clipping by scrolling ancestors and the viewport)
//   viewport, scheme, state, gameState, bodyClasses, dataState, domNodes, pageErrors
//   chromeCoverage        share of viewport area covered by the union of painted UI boxes, 4 px grid (cell centre
//                         inside the box). Painted = a visible element with a non-transparent background colour or
//                         image, a visible border, an img/svg/video/input/select/textarea, a non-scene canvas, or
//                         the line boxes of its own text. Excludes canvas#c, canvas#swingOverlay and the body::after
//                         scrim (reported separately in scrim). chromeCoverageSolid counts only boxes that hide the
//                         scene (background alpha>=0.6, or img/canvas/video). *Bottom45 = lowest 45% of the viewport.
//   overlaps              pairs of visible, non-inert "components" (painted boxes, interactive elements and text
//                         blocks not inside a painted box) whose rects intersect (w,h>1), ancestor pairs ignored:
//                         {count, areaPx, pairs:[{a,b,area}]}
//   offscreen             components with ink outside the viewport: partial (some part outside, some in) and fully
//   hScroll               document or an overflow container wider than its box (scrollWidth > clientWidth+1)
//   tapTargets            every rendered interactive element (button, a[href], input, select, textarea, summary,
//                         [role=button], .seg, [tabindex>=0], plus a label whose control is invisible): selector,
//                         rect, under44 (w<43.5 or h<43.5), inView, inert, disabled, gap = nearest edge-to-edge
//                         distance to another in-view interactive element. under44InView is the headline count
//                         (in view, not inert, not disabled).
//   fontCensus            histogram of computed font-size/weight/family over visible text nodes (+ input values),
//                         minSize, under12 (elements with font-size < 12px), smallest[] elements. Canvas text
//                         (minimap, meter) is not DOM and is not measured.
//   contrast              WCAG ratio per visible text element: text colour (alpha and element opacity applied) over
//                         the background composited through the DOM ancestors. If the ancestors do not reach an
//                         opaque layer the remainder is the 3D scene: sceneDependent, evaluated against flat grey,
//                         white and black. pass = ratio >= 4.5 (3 for large text: >=24px or >=18.66px bold); for
//                         sceneDependent the flat-grey ratio decides. failures = count not passing (disabled
//                         excluded); sceneRisk = sceneDependent texts that fail against white or black.
//   focusable             in-view enabled interactive elements: count, withVisibleFocus (:focus-visible changes
//                         outline/box-shadow/colours), without[] selectors
//   heavy                 visible elements with backdrop-filter, box-shadow blur > 12px, will-change != auto;
//                         animations: elements declaring animation / infinite animation / transition, and
//                         document.getAnimations() running/infinite at capture
//   -- added with the wider oracle (additive, appended after pageErrors; every field above is unchanged) --
//   schemeCheck           did the requested colour scheme really apply: prefersDark / prefersLight, applied, the root
//                         color-scheme, data-theme, body colours and luminance (a stylesheet with no light theme renders
//                         dark under both schemes, and this is how you can tell)
//   contrastUnparsed      colours the contrast pass could not read: {count, samples}
//   tapAll                every rendered tappable thing, in view or not: native controls, role=tab|switch|menuitem|...,
//                         elements with a click listener or onclick, labels of hidden controls. {total, inView, byKind,
//                         under44InView, under32InView, listenerOnlyUnder44, obscured (the centre of the visible part is
//                         covered by something else), worst[], obscuredItems[], items[]}
//   focusableAll          the keyboard pass: every enabled, visible, tabbable element in tab order, skipping the contents
//                         of closed <details>; each is really focused and checked for a :focus-visible ring.
//                         {reachable, tested, focused, withVisibleFocus, without[], notFocusable[], skipped{}, order[]}
//   under12               text under 12 px, DOM and canvas: {dom, canvas, total, smallestDom[]}
//   distinct              how many distinct values the design uses: fontSize, fontWeight, lineHeight, lineHeightRatio,
//                         letterSpacing (visible text), borderRadius, zIndex, boxShadow (visible painted boxes):
//                         {count, values:[[value, n]...]}
//   dialogFits            every open dialog / screen (.modal, #menu, #academy, #coachMark, #loading, #boot): inside the
//                         viewport, no sideways scroll, scrolls vertically, inside the safe area:
//                         {count, failures, allFit, items[]}
//   accentUse             where the accent (--accent) is used: elements whose text / background / border / outline / shadow /
//                         fill equals it (elementsExact) or sits in its hue family (elementsFamilyOnly), by property, and
//                         primaryButtons (.btn.primary): makes "one primary per screen" measurable
//   canvasText            text drawn on canvases (minimap, meter, academy plots) with fillText / strokeText, recorded by a
//                         wrapper installed before the game boots: items with font px, rect, clipped, outsideViewport,
//                         under12; minPx; overlapping labels
//   insideSafeArea        with insets emulated (notch viewports): every tap target, text and canvas label that reaches
//                         outside the safe rectangle: {insets, active, safeRect, checked, outside, outsideTargets,
//                         outsideTexts, items[]}
//
// FINGERPRINT (--fingerprint)  <state>.fp.json = {v, viewport, scheme, state, props, dict, cls, nodes}: the computed value of
//   136 layout, paint, typography and animation-timing properties for every element and for ::before / ::after that have
//   content, stored as one row of dictionary indexes per node. Node keys never use class names: the nearest ancestor id (or
//   "body") plus tag[n-th of that tag], e.g. #menu/div[1]/button[0]. tools/shots-diff.mjs --fingerprint compares two
//   directories: a changed property on an element present in both is a failure under --expect-identical; elements only
//   in one side are counted and listed but do not fail it (a refactor may add a node such as #sr).
//
// PERF (--perf)  For address-essential and flight: Performance.getMetrics before/after <perf-frames> synchronous
//   game.debugStep(1) frames; reports deltas of LayoutCount, RecalcStyleCount, LayoutDuration,
//   RecalcStyleDuration, ScriptDuration, TaskDuration, Nodes, JSEventListeners, JS heap, layer count and
//   per-frame averages. debugStep is CPU/JS only - it is not paced by the compositor, so paint/GPU time is
//   not included, but DOM churn is. Chrome attributes no ScriptDuration to Runtime.evaluate-driven frames (it reads 0),
//   so TaskDuration (all main-thread work incl. JS, style, layout) is the CPU figure to compare. Frames run in chunks of 10.
//
// Process hygiene: spawns a private static server and a private Chrome (fresh --user-data-dir, free ports) and
// kills both (taskkill /T /F on Windows) on exit, error and Ctrl-C. It never touches your own Chrome.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const FLAT = [128, 128, 128];

// ---------------------------------------------------------------------------------------------- viewports
const VIEWPORTS = {
  'phone-xs': { w: 320, h: 568, dpr: 2, touch: true },
  phone: { w: 375, h: 812, dpr: 2, touch: true },
  'phone-l': { w: 430, h: 932, dpr: 2, touch: true },
  'phone-land': { w: 812, h: 375, dpr: 2, touch: true },
  tablet: { w: 820, h: 1180, dpr: 2, touch: true },
  desktop: { w: 1440, h: 900, dpr: 1, touch: false },
};
// Notch viewports: the same phone sizes with the safe-area insets a notched phone reports (CDP
// Emulation.setSafeAreaInsetsOverride, so env(safe-area-inset-*) in the CSS is non-zero).
const NOTCH = {
  'notch-land': { w: 812, h: 375, dpr: 2, touch: true, insets: { top: 0, right: 44, bottom: 21, left: 44 } },
  'notch-port': { w: 375, h: 812, dpr: 2, touch: true, insets: { top: 47, right: 0, bottom: 34, left: 0 } },
};
// Edge viewports are named by their size: w760 / w761 (width, with the default companion height below),
// h500 / h501 (height, default companion width), w599h375 / h600w375 (both given). A pure function of the
// name, so a reference captured today can be re-captured after the stylesheet's breakpoints have moved.
// Every edge viewport is a touch device at dpr 2 (they are all phone / tablet sized).
const companionH = (w) => (w <= 760 ? 812 : w <= 1100 ? 1180 : 900); // portrait phone (740-900), portrait tablet above 760
const companionW = () => 740; // a landscape phone (667-740) when only a height is named
function parseViewport(spec) {
  if (VIEWPORTS[spec]) return { name: spec, ...VIEWPORTS[spec] };
  if (NOTCH[spec]) return { name: spec, ...NOTCH[spec] };
  let m = /^w(\d+)(?:h(\d+))?$/.exec(spec);
  if (m) return edgeViewport(spec, +m[1], m[2] ? +m[2] : companionH(+m[1]));
  m = /^h(\d+)(?:w(\d+))?$/.exec(spec);
  if (m) return edgeViewport(spec, m[2] ? +m[2] : companionW(), +m[1]);
  m = /^(\d+)x(\d+)(?::(\d+(?:\.\d+)?))?(?::(touch|mouse))?$/.exec(spec);
  if (!m) throw new Error(`bad viewport "${spec}" (names: ${Object.keys(VIEWPORTS).join(', ')}, ${Object.keys(NOTCH).join(', ')}, w<N>[h<M>], h<N>[w<M>]; or WxH[:dpr[:touch|mouse]])`);
  return { name: `custom-${m[1]}x${m[2]}${m[3] ? '@' + m[3] : ''}${m[4] === 'touch' ? '-touch' : ''}`, w: +m[1], h: +m[2], dpr: m[3] ? +m[3] : 1, touch: m[4] === 'touch' };
}
function edgeViewport(name, w, h) {
  if (!(w >= 200 && w <= 4000 && h >= 200 && h <= 4000)) throw new Error(`viewport "${name}" is ${w}x${h}: out of range`);
  return { name, w, h, dpr: 2, touch: true };
}

// ---- the stylesheet's own breakpoints -> edge viewports
// Every width / height threshold in an @media prelude of styles.css, straddled by one px either side
// (max-width:760 -> 760 and 761; min-width:600 -> 599 and 600), each at a companion size that keeps the
// REST of that query true (an orientation, a max-height, a min-width ...). A threshold whose queries are
// not all satisfied by the default companion also gets an explicit w<N>h<M> / h<N>w<M> variant per query.
function mediaAlternatives(cssText) {
  const alts = [];
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const toPx = (n, unit) => (unit === 'em' || unit === 'rem' ? n * 16 : n);
  for (const m of css.matchAll(/@media\s+([^{;]+)\{/g)) {
    for (const part of m[1].split(',')) {
      if (/^\s*not\b/i.test(part)) continue;
      const feats = [];
      for (const f of part.matchAll(/\(([^()]+)\)/g)) {
        const s = f[1].trim();
        let q;
        if ((q = /^(min|max)-(width|height)\s*:\s*([\d.]+)\s*(px|em|rem)?$/i.exec(s))) feats.push({ k: q[1].toLowerCase() + (q[2].toLowerCase() === 'width' ? 'W' : 'H'), v: toPx(parseFloat(q[3]), q[4]) });
        else if ((q = /^orientation\s*:\s*(landscape|portrait)$/i.exec(s))) feats.push({ k: 'orient', v: q[1].toLowerCase() });
        else if ((q = /^(width|height)\s*(<=|>=|<|>)\s*([\d.]+)\s*(px|em|rem)?$/i.exec(s))) { // media range syntax: (width <= 600px)
          const ax = q[1].toLowerCase() === 'width' ? 'W' : 'H', v = toPx(parseFloat(q[3]), q[4]);
          if (q[2] === '<=') feats.push({ k: 'max' + ax, v }); else if (q[2] === '<') feats.push({ k: 'max' + ax, v: v - 0.01 });
          else if (q[2] === '>=') feats.push({ k: 'min' + ax, v }); else feats.push({ k: 'min' + ax, v: v + 0.01 });
        } else if ((q = /^([\d.]+)\s*(px|em|rem)?\s*(<=|<)\s*(width|height)\s*(<=|<)\s*([\d.]+)\s*(px|em|rem)?$/i.exec(s))) {
          const ax = q[4].toLowerCase() === 'width' ? 'W' : 'H';
          feats.push({ k: 'min' + ax, v: toPx(parseFloat(q[1]), q[2]) + (q[3] === '<' ? 0.01 : 0) }, { k: 'max' + ax, v: toPx(parseFloat(q[6]), q[7]) - (q[5] === '<' ? 0.01 : 0) });
        }
      }
      if (feats.length) alts.push(feats);
    }
  }
  return alts;
}
const featOk = (f, w, h) => (f.k === 'minW' ? w >= f.v : f.k === 'maxW' ? w <= f.v : f.k === 'minH' ? h >= f.v : f.k === 'maxH' ? h <= f.v : f.v === 'portrait' ? h >= w : w > h);
function edgeViewportNames(cssText) {
  const th = new Map(); // 'w760' -> { axis, a, need: [alt, ...] }
  const add = (axis, a, alt, f) => {
    const key = axis + a;
    if (!th.has(key)) th.set(key, { axis, a, alts: [] });
    if (alt) th.get(key).alts.push({ alt, f });
  };
  for (const alt of mediaAlternatives(cssText)) {
    for (const f of alt) {
      if (f.k === 'orient') continue;
      const axis = f.k.endsWith('W') ? 'w' : 'h';
      add(axis, f.k.startsWith('max') ? Math.floor(f.v) : Math.ceil(f.v) - 1, alt, f);
    }
  }
  // thresholds the plan adds later (a 370 / 340 phone tier): captured now so the reference already has them
  for (const a of [339, 369]) add('w', a, null, null);
  const prefH = [812, 740, 900, 667, 600, 500, 480, 375, 360, 320, 1000, 1180], prefW = [740, 667, 720, 700, 600, 375, 360, 320, 390, 412, 800, 900, 1024];
  const names = [];
  const sorted = [...th.values()].sort((p, q) => (p.axis === q.axis ? p.a - q.a : p.axis === 'w' ? -1 : 1));
  for (const t of sorted) {
    const pair = [t.a, t.a + 1];
    const dflt = (v) => (t.axis === 'w' ? [v, companionH(v)] : [companionW(v), v]);
    for (const v of pair) names.push(t.axis + v);
    for (const { alt, f } of t.alts) {
      const others = alt.filter((x) => x !== f);
      const ok = (cw, ch) => pair.every((v) => { const [w, h] = t.axis === 'w' ? [v, ch] : [cw, v]; return others.every((x) => featOk(x, w, h)); });
      const [dw, dh] = dflt(t.a);
      if (ok(dw, dh)) continue; // the default companion already exercises this query
      const bounds = others.flatMap((x) => [x.v, x.v - 1, x.v + 1]).filter((x) => typeof x === 'number' && x >= 200);
      const cand = [...(t.axis === 'w' ? prefH : prefW), ...bounds];
      const c = cand.find((cv) => ok(cv, cv));
      if (c) names.push(t.axis === 'w' ? `w${pair[0]}h${c}` : `h${pair[0]}w${c}`, t.axis === 'w' ? `w${pair[1]}h${c}` : `h${pair[1]}w${c}`);
    }
  }
  return [...new Set(names)];
}
// phone and tablet sizes people actually own that sit between or beside the breakpoints
const FIXED_EDGE = ['w360h740', 'w360h640', 'w375h667', 'w667h375', 'w568h320', 'w600h900', 'w767h1024', 'w1180h820'];
function listViewports(o) {
  if (o.listEdge) {
    let css = '';
    try { css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8'); } catch (e) { /* no stylesheet: only the fixed ones */ }
    return [...new Set([...edgeViewportNames(css), ...FIXED_EDGE, ...Object.keys(NOTCH)])];
  }
  return o.listNotch ? Object.keys(NOTCH) : Object.keys(VIEWPORTS);
}
// --viewport tokens: gate (the six) | edge (the stylesheet's breakpoints + fixed + notch) | notch | a name | WxH[:dpr[:touch|mouse]]
function resolveViewports(o) {
  const toks = o.viewport || (o.listEdge ? ['edge'] : o.listNotch ? ['notch'] : ['gate']);
  const out = [];
  for (const t of toks) {
    if (t === 'gate') out.push(...Object.keys(VIEWPORTS));
    else if (t === 'edge') out.push(...listViewports({ listEdge: true }));
    else if (t === 'notch') out.push(...Object.keys(NOTCH));
    else out.push(t);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------- CLI
function parseArgs(argv) {
  const o = { out: path.join(os.tmpdir(), 'psg-shots'), viewport: null, scheme: ['dark'], states: null, flat: true, shots: true, perfFrames: 180, timeout: 120000, instrument: true };
  const need = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h': o.help = true; break;
      case '--out': o.out = path.resolve(need(i++)); break;
      case '--viewport': o.viewport = need(i++).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--scheme': { const s = need(i++); o.scheme = s === 'both' ? ['dark', 'light'] : [s]; if (!o.scheme.every((x) => x === 'dark' || x === 'light')) throw new Error('--scheme dark|light|both'); break; }
      case '--states': o.states = need(i++).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--list-states': o.listStates = true; break;
      case '--list-viewports': o.listViewports = true; break;
      case '--edge': o.listEdge = true; break;
      case '--notch': o.listNotch = true; break;
      case '--fingerprint': o.fingerprint = true; break;
      case '--no-instrument': o.instrument = false; break;
      case '--no-flat': o.flat = false; break;
      case '--no-shots': o.shots = false; o.flat = false; break;
      case '--perf': o.perf = true; break;
      case '--perf-frames': o.perfFrames = +need(i++); break;
      case '--init-js': o.initJs = path.resolve(need(i++)); break;
      case '--inject-css': o.injectCss = path.resolve(need(i++)); break;
      case '--inject-js': o.injectJs = path.resolve(need(i++)); break;
      case '--url': o.url = need(i++); break;
      case '--chrome': o.chrome = need(i++); break;
      case '--software': o.software = true; break;
      case '--live-clock': o.live = true; break;
      case '--timeout': o.timeout = +need(i++); break;
      case '--keep-profile': o.keepProfile = true; break;
      case '--verbose': o.verbose = true; break;
      default: throw new Error(`unknown option ${a} (try --help)`);
    }
  }
  return o;
}
const HELP = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0].split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');

// ---------------------------------------------------------------------------------------------- process hygiene
const procs = new Set(); // { pid, name }
let profileDir = null;
let keepProfile = false;
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch (e) { /* already gone */ }
}
// belt and braces on Windows: any chrome.exe still started with OUR profile directory
function sweepProfile() {
  if (process.platform !== 'win32' || !profileDir) return;
  try {
    const needle = path.basename(profileDir);
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  } catch (e) { /* ignore */ }
}
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const p of procs) killTree(p.pid);
  procs.clear();
  sweepProfile();
  if (profileDir && !keepProfile) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch (e) { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']); }
    }
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitFor(fn, ms, what, every = 100) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

// ---------------------------------------------------------------------------------------------- CDP client
class Cdp {
  constructor(url, verbose) { this.url = url; this.verbose = verbose; this.id = 0; this.pending = new Map(); this.on = new Map(); this.closed = false; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('DevTools websocket error')); });
    this.ws.onmessage = (m) => {
      const d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      if (d.id && this.pending.has(d.id)) {
        const p = this.pending.get(d.id); this.pending.delete(d.id); clearTimeout(p.t);
        if (d.error) p.rej(new Error(`${p.method}: ${d.error.message}`)); else p.res(d.result);
      } else if (d.method) {
        for (const f of this.on.get(d.method) || []) f(d.params);
      }
    };
    this.ws.onclose = () => { this.closed = true; for (const p of this.pending.values()) p.rej(new Error('DevTools connection closed (page crashed?)')); this.pending.clear(); };
  }
  send(method, params = {}, timeout = 120000) {
    if (this.closed) return Promise.reject(new Error('DevTools connection closed'));
    const id = ++this.id;
    if (this.verbose) console.log('  cdp>', method);
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out after ${timeout} ms`)); }, timeout);
      this.pending.set(id, { res, rej, t, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  listen(ev, fn) { if (!this.on.has(ev)) this.on.set(ev, []); this.on.get(ev).push(fn); }
  once(ev, timeout = 60000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timed out waiting for ${ev}`)), timeout);
      const f = (p) => { clearTimeout(t); const a = this.on.get(ev); a.splice(a.indexOf(f), 1); res(p); };
      this.listen(ev, f);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

// ---------------------------------------------------------------------------------------------- Chrome + server
function findChrome(opt) {
  const cands = [opt, process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no Chrome found; set CHROME_PATH or pass --chrome');
}

async function startServer(o) {
  if (o.url) return o.url.replace(/\/?$/, '/');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  procs.add({ pid: child.pid, name: 'server' });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (c) => { if (!cleaned) console.error(`server exited early (${c}): ${out}`); });
  await waitFor(() => /running at/.test(out), 20000, 'the server to start');
  return `http://localhost:${port}/`;
}

async function startChrome(o, software) {
  const exe = findChrome(o.chrome);
  if (!profileDir) profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psg-shots-chrome-'));
  keepProfile = !!o.keepProfile;
  const port = await freePort();
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--remote-allow-origins=*', `--user-data-dir=${profileDir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--mute-audio', '--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none', '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1500,1000'];
  if (software) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle');
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  const rec = { pid: child.pid, name: 'chrome' };
  procs.add(rec);
  let died = null;
  child.on('exit', (c) => { died = c; });
  const base = `http://127.0.0.1:${port}`;
  const ver = await waitFor(async () => { if (died !== null) throw new Error('Chrome exited'); const r = await fetch(base + '/json/version'); return r.ok ? r.json() : null; }, 30000, 'Chrome DevTools');
  const list = await waitFor(async () => { const r = await (await fetch(base + '/json/list')).json(); return r.find((t) => t.type === 'page'); }, 15000, 'a page target');
  const cdp = new Cdp(list.webSocketDebuggerUrl, o.verbose);
  await cdp.open();
  return { cdp, rec, version: ver.Browser, exe };
}

// ---------------------------------------------------------------------------------------------- in-page code
// These functions are serialised with toString() and run inside the page: they must not close over anything.

function preBoot(cfg) {
  try {
    const ls = localStorage;
    for (const k of Object.keys(ls)) if (k.indexOf('psg-') === 0) ls.removeItem(k);
    for (const k of Object.keys(cfg.seed)) { const v = cfg.seed[k]; ls.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); }
  } catch (e) { /* about:blank */ }
  if (cfg.noWebgl) {
    const gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/i.test(String(t)) ? null : gc.call(this, t, ...a); };
  }
  if (cfg.instrument) {
    // Passive instrumentation for the canvasText and tapAll metrics. Everything delegates to the original.
    // canvas text: remember each fillText / strokeText with the state needed to place it later; forget a
    // canvas's text when it is cleared (clearRect over the whole canvas, ctx.reset, a width/height write)
    const recs = new WeakMap(); // canvas element -> [{ text, x, y, font, align, base, m, op }]
    window.__psgCanvasText = recs;
    const cproto = CanvasRenderingContext2D.prototype;
    for (const k of ['fillText', 'strokeText']) {
      const orig = cproto[k];
      cproto[k] = function (text, x, y) {
        try {
          const cv = this.canvas;
          if (cv && cv.nodeType === 1) {
            let a = recs.get(cv);
            if (!a) { a = []; recs.set(cv, a); }
            const t = this.getTransform();
            a.push({ text: String(text), x, y, font: this.font, align: this.textAlign, base: this.textBaseline, m: [t.a, t.b, t.c, t.d, t.e, t.f], op: k === 'fillText' ? 'fill' : 'stroke' });
            if (a.length > 600) a.splice(0, a.length - 600);
          }
        } catch (e) { /* never break the page */ }
        return orig.apply(this, arguments);
      };
    }
    const clr = cproto.clearRect;
    cproto.clearRect = function (x, y, w, h) {
      try {
        const cv = this.canvas;
        if (cv && recs.has(cv)) {
          const t = this.getTransform();
          const xs = [x, x + w].map((v) => t.a * v + t.c * y + t.e), ys = [y, y + h].map((v) => t.b * x + t.d * v + t.f);
          if (Math.min(...xs) <= 0.5 && Math.min(...ys) <= 0.5 && Math.max(...xs) >= cv.width - 0.5 && Math.max(...ys) >= cv.height - 0.5) recs.delete(cv);
        }
      } catch (e) { /* ignore */ }
      return clr.apply(this, arguments);
    };
    if (typeof cproto.reset === 'function') {
      const rst = cproto.reset;
      cproto.reset = function () { try { recs.delete(this.canvas); } catch (e) { /* ignore */ } return rst.apply(this, arguments); };
    }
    for (const k of ['width', 'height']) {
      const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, k);
      if (d && d.set) Object.defineProperty(HTMLCanvasElement.prototype, k, { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { recs.delete(this); d.set.call(this, v); } });
    }
    // elements that took a pointer / click listener: clickable things that are not buttons
    const clickable = new WeakSet();
    window.__psgClickable = clickable;
    const addL = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type) {
      try { if (this && this.nodeType === 1 && /^(click|pointerdown|pointerup|mousedown|mouseup|touchstart|touchend)$/.test(type)) clickable.add(this); } catch (e) { /* ignore */ }
      return addL.apply(this, arguments);
    };
  }
  if (!cfg.det) return;
  // seeded Math.random (mulberry32)
  let s = 0x9e3779b9;
  Math.random = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // fixed Date
  const RD = Date;
  class FDate extends RD {
    constructor(...a) { if (a.length === 0) super(cfg.now); else super(...a); }
    static now() { return cfg.now; }
  }
  window.Date = FDate;
  // virtual clock: performance.now creeps 0.01 ms per call (so busy-wait slices end) and jumps with each stepped frame
  const clock = { t: 1000 };
  performance.now = () => { clock.t += 0.01; return clock.t; };
  const timers = new Map();
  let tid = 1;
  window.__realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (f, ms, ...a) => { const id = tid++; timers.set(id, { t: clock.t + Math.max(0, +ms || 0), f, a, iv: 0 }); return id; };
  window.setInterval = (f, ms, ...a) => { const id = tid++; const iv = Math.max(1, +ms || 1); timers.set(id, { t: clock.t + iv, f, a, iv }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.__advance = (ms) => {
    clock.t += ms;
    for (let guard = 0; guard < 10000; guard++) {
      let best = null, bid = 0;
      for (const [id, tm] of timers) if (tm.t <= clock.t && (!best || tm.t < best.t)) { best = tm; bid = id; }
      if (!best) break;
      if (best.iv) best.t += best.iv; else timers.delete(bid);
      try { typeof best.f === 'function' ? best.f(...best.a) : 0; } catch (e) { window.__psgErrors = (window.__psgErrors || []).concat(String(e && e.message || e)); }
    }
  };
  // no free-running render loop
  const q = new Map();
  let rid = 1;
  window.requestAnimationFrame = (cb) => { const id = rid++; q.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { q.delete(id); };
}

// after boot: make frame() drive the virtual clock
function afterBoot(det) {
  const g = window.game;
  if (!g) return false;
  if (det && !g.__psgWrapped) {
    const f = g.frame;
    g.frame = function (dt) { window.__advance(dt * 1000); return f.call(this, dt); };
    g.__psgWrapped = true;
  }
  return true;
}

function installFreeze(css) {
  let st = document.getElementById('__psgFreeze');
  if (!st) { st = document.createElement('style'); st.id = '__psgFreeze'; document.head.appendChild(st); }
  st.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' + (css || '');
  st.disabled = false;
}

function scrollToEnd(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return null;
  const out = [];
  for (const e of [root, ...root.querySelectorAll('*')]) {
    const c = getComputedStyle(e);
    if (e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(c.overflowY)) { e.scrollTop = e.scrollHeight; out.push({ id: e.id || e.className, scrollTop: e.scrollTop, scrollHeight: e.scrollHeight }); }
  }
  return out;
}

// ---- the metrics -------------------------------------------------------------------------------------
function measurePage(cfg) {
  const W = innerWidth, H = innerHeight, body = document.body, doc = document.documentElement;
  const SCENE_SEL = 'canvas#c, canvas#swingOverlay';
  const R1 = (n) => Math.round(n * 10) / 10;
  const R2 = (n) => Math.round(n * 100) / 100;
  const box = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const isect = (a, b) => { const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bt = Math.min(a.b, b.b); return r > l && bt > t ? { l, t, r, b: bt } : null; };
  const area = (b) => (b ? (b.r - b.l) * (b.b - b.t) : 0);
  const rectJ = (b) => ({ x: R1(b.l), y: R1(b.t), w: R1(b.r - b.l), h: R1(b.b - b.t) });
  const VP = { l: 0, t: 0, r: W, b: H };
  const CS = new Map();
  const cs = (e) => { let c = CS.get(e); if (!c) { c = getComputedStyle(e); CS.set(e, c); } return c; };
  const sel = (e) => {
    let s = e.tagName.toLowerCase();
    if (e.id) return s + '#' + e.id;
    const cl = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cl.length) s += '.' + cl.join('.');
    for (const a of ['data-act', 'data-k', 'data-p', 'data-lv', 'data-i', 'data-v', 'aria-label']) { const v = e.getAttribute(a); if (v) { s += '[' + a + '=' + String(v).slice(0, 18) + ']'; break; } }
    let p = e.parentElement, hops = 0;
    while (p && !p.id && hops < 4) { p = p.parentElement; hops++; }
    if (p && p.id && p !== body) s = '#' + p.id + ' ' + s;
    return s;
  };
  // Any other CSS colour (hsl, hwb, lab, oklch, color(display-p3 ...), a hex custom-property value ...) is rendered
  // on a 1x1 canvas over white and over black and read back, so a stylesheet that moves to color-mix / oklch /
  // light-dark() keeps being measured instead of silently dropping out of the contrast pass.
  const unparsedCols = new Set();
  const cvCache = new Map();
  let cvCtx = null;
  const cvCol = (s) => {
    if (cvCache.has(s)) return cvCache.get(s);
    let out = null;
    try {
      if (!cvCtx) { const c = document.createElement('canvas'); c.width = c.height = 1; cvCtx = c.getContext('2d', { willReadFrequently: true }); }
      const x = cvCtx;
      x.fillStyle = '#010203'; x.fillStyle = s; const a1 = x.fillStyle;
      x.fillStyle = '#040506'; x.fillStyle = s; const a2 = x.fillStyle;
      if (a1 === a2) { // an invalid value is ignored and leaves the sentinel, so the two read-backs differ
        const px = (bg) => { x.globalCompositeOperation = 'copy'; x.fillStyle = bg; x.fillRect(0, 0, 1, 1); x.globalCompositeOperation = 'source-over'; x.fillStyle = '#010203'; x.fillStyle = s; x.fillRect(0, 0, 1, 1); return x.getImageData(0, 0, 1, 1).data; };
        const w = px('#ffffff'), k = px('#000000');
        const al = Math.min(1, Math.max(0, 1 - ((w[0] - k[0]) + (w[1] - k[1]) + (w[2] - k[2])) / 765));
        out = al > 0.003 ? [k[0] / al, k[1] / al, k[2] / al, al] : [0, 0, 0, 0];
      }
    } catch (err) { out = null; }
    if (!out) unparsedCols.add(String(s).slice(0, 60));
    cvCache.set(s, out);
    return out;
  };
  const parseCol = (s) => {
    if (!s || s === 'transparent') return [0, 0, 0, 0];
    let m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) { const v = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x))); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(s);
    if (m) { const v = m[1].split(/[\s/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x))); return [v[0] * 255, v[1] * 255, v[2] * 255, v.length > 3 ? v[3] : 1]; }
    return cvCol(s);
  };
  const bgLayer = (c) => {
    // colour + gradient average (approximation), url() images count as opaque
    let col = parseCol(c.backgroundColor) || [0, 0, 0, 0];
    const img = c.backgroundImage;
    let approx = false;
    if (img && img !== 'none') {
      approx = true;
      const toks = img.match(/(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]+\)/g);
      if (/url\(/.test(img)) col = col[3] >= 1 ? col : [128, 128, 128, 1];
      else if (toks && toks.length) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const t of toks) { const p = parseCol(t); if (p) { r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3]; } }
        const n = toks.length;
        const ga = a / n;
        const gc = a > 0 ? [r / a, g / a, b / a, ga] : [0, 0, 0, 0];
        // gradient over the colour
        const oa = ga + col[3] * (1 - ga);
        col = oa > 0 ? [(gc[0] * ga + col[0] * col[3] * (1 - ga)) / oa, (gc[1] * ga + col[1] * col[3] * (1 - ga)) / oa, (gc[2] * ga + col[2] * col[3] * (1 - ga)) / oa, oa] : [0, 0, 0, 0];
      }
    }
    return { col, approx };
  };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => '#' + [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(c[i]))).toString(16).padStart(2, '0')).join('');

  // ---- per-element info (document order: parents first)
  const freeze = document.getElementById('__psgFreeze');
  const els = [...body.querySelectorAll('*')].filter((e) => !(e.closest('svg') && e.tagName.toLowerCase() !== 'svg') && !/^(SCRIPT|STYLE|NOSCRIPT|LINK|META|TITLE|OPTION|OPTGROUP|DATALIST)$/.test(e.tagName));
  const info = new Map();
  const bodyOp = parseFloat(cs(body).opacity);
  info.set(body, { eff: isNaN(bodyOp) ? 1 : bodyOp });
  const clipOf = (e) => {
    let clip = null;
    let pos = cs(e).position;
    for (let p = e.parentElement; p && p !== body && p !== doc; p = p.parentElement) {
      const pc = cs(p);
      if (pos === 'fixed') break;
      if (pos === 'absolute' && pc.position === 'static') continue;
      if (pc.display !== 'inline' && /(hidden|clip|auto|scroll)/.test(pc.overflowX + ' ' + pc.overflowY)) {
        const r = p.getBoundingClientRect();
        const b = { l: r.left + p.clientLeft, t: r.top + p.clientTop, r: r.left + p.clientLeft + p.clientWidth, b: r.top + p.clientTop + p.clientHeight };
        clip = clip ? (isect(clip, b) || { l: 0, t: 0, r: 0, b: 0 }) : b;
      }
      pos = pc.position;
    }
    return clip;
  };
  for (const e of els) {
    const c = cs(e);
    const pe = info.get(e.parentElement) || { eff: 1 };
    const op = parseFloat(c.opacity);
    const eff = pe.eff * (isNaN(op) ? 1 : op);
    const rec = { e, c, eff, rendered: c.display !== 'none', vis: false, raw: null, clip: null, v: null, inert: false };
    info.set(e, rec);
    if (!rec.rendered || c.visibility !== 'visible' || eff < 0.02) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    rec.raw = box(r);
    rec.clip = clipOf(e);
    const cl = rec.clip ? isect(rec.raw, rec.clip) : rec.raw;
    rec.v = cl ? isect(cl, VP) : null;
    rec.vis = !!rec.v;
    rec.inert = !!e.closest('[inert]');
  }
  const isScene = (e) => e.matches(SCENE_SEL);

  // ---- text sources
  const textBoxOf = (e, rec) => {
    let u = null, chars = 0;
    for (const n of e.childNodes) {
      if (n.nodeType !== 3 || !n.data.trim()) continue;
      chars += n.data.trim().length;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        u = u ? { l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom) } : box(r);
      }
    }
    if (!u) return null;
    if (rec.clip) u = isect(u, rec.clip);
    return u ? { v: isect(u, VP), raw: u, chars } : null;
  };
  const texts = [];
  for (const e of els) {
    const rec = info.get(e);
    if (!rec.rendered || rec.c.visibility !== 'visible' || rec.eff < 0.02 || isScene(e)) continue;
    const fs = parseFloat(rec.c.fontSize);
    if (!(fs > 0) || rec.c.webkitTextFillColor === 'rgba(0, 0, 0, 0)') continue;
    let tb, label = '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName)) {
      if (e.type === 'range' || e.type === 'checkbox' || e.type === 'radio' || e.type === 'hidden') continue;
      label = e.tagName === 'SELECT' ? (e.selectedOptions[0] ? e.selectedOptions[0].text : '') : (e.value || e.placeholder || '');
      if (!label || !rec.v) continue;
      tb = { v: rec.v, raw: rec.raw, chars: label.length };
    } else {
      tb = textBoxOf(e, rec);
      if (!tb || !tb.v) continue;
      for (const n of e.childNodes) if (n.nodeType === 3 && n.data.trim()) label += (label ? ' ' : '') + n.data.trim();
    }
    texts.push({ e, rec, tb, label, fs });
  }

  // ---- painted / interactive / media -> components
  const MEDIA = /^(IMG|SVG|VIDEO|INPUT|SELECT|TEXTAREA)$/;
  const painted = (rec) => {
    const c = rec.c, e = rec.e;
    if (isScene(e)) return false;
    if (e.tagName === 'CANVAS' || MEDIA.test(e.tagName.toUpperCase())) return true;
    const bg = parseCol(c.backgroundColor);
    if (bg && bg[3] > 0.004) return true;
    if (c.backgroundImage && c.backgroundImage !== 'none') return true;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(c['border' + side + 'Width']) > 0 && c['border' + side + 'Style'] !== 'none' && c['border' + side + 'Style'] !== 'hidden') { const bc = parseCol(c['border' + side + 'Color']); if (bc && bc[3] > 0.004) return true; }
    }
    return false;
  };
  const solid = (rec) => {
    const e = rec.e;
    if (/^(IMG|VIDEO|CANVAS)$/.test(e.tagName)) return true;
    const l = bgLayer(rec.c);
    return l.col[3] * rec.eff >= 0.6;
  };
  const NATIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], .seg';
  const isInter = (e) => e.matches(NATIVE) || (e.hasAttribute('tabindex') && e.tabIndex >= 0);
  const isComp = new Map();
  const comp = (e) => { let v = isComp.get(e); if (v === undefined) { const r = info.get(e); v = !!r && (painted(r) || isInter(e)); isComp.set(e, v); } return v; };

  // ---- coverage grid
  const CELL = 4, cols = Math.ceil(W / CELL), rows = Math.ceil(H / CELL);
  const gAny = new Uint8Array(cols * rows), gSolid = new Uint8Array(cols * rows);
  const fill = (g, b) => {
    const x0 = Math.max(0, Math.ceil(b.l / CELL - 0.5)), x1 = Math.min(cols - 1, Math.ceil(b.r / CELL - 0.5) - 1);
    const y0 = Math.max(0, Math.ceil(b.t / CELL - 0.5)), y1 = Math.min(rows - 1, Math.ceil(b.b / CELL - 0.5) - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y * cols + x] = 1;
  };
  const components = [];
  for (const e of els) {
    const rec = info.get(e);
    if (!rec.vis || isScene(e)) continue;
    if (painted(rec)) { fill(gAny, rec.v); if (solid(rec)) fill(gSolid, rec.v); }
    if (comp(e)) components.push({ e, rec, box: rec.v, rawBox: rec.clip ? isect(rec.raw, rec.clip) : rec.raw, kind: painted(rec) ? 'painted' : 'interactive' });
  }
  for (const t of texts) {
    fill(gAny, t.tb.v);
    if (!comp(t.e)) {
      let hasAnc = false;
      for (let a = t.e.parentElement; a && a !== body; a = a.parentElement) if (comp(a)) { hasAnc = true; break; }
      if (!hasAnc && !t.rec.inert === !t.rec.inert) components.push({ e: t.e, rec: t.rec, box: t.tb.v, rawBox: t.tb.raw, kind: 'text' });
    }
  }
  const covFrac = (g, y0) => { let n = 0, tot = 0; for (let y = y0; y < rows; y++) for (let x = 0; x < cols; x++) { tot++; n += g[y * cols + x]; } return tot ? Math.round((n / tot) * 10000) / 10000 : 0; };
  const y45 = Math.floor(rows * 0.55);

  // scrim: body::after (or ::before) fixed dim layer
  let scrim = { present: false };
  for (const ps of ['::after', '::before']) {
    const pc = getComputedStyle(body, ps);
    if (pc.content && pc.content !== 'none' && pc.content !== 'normal' && pc.position === 'fixed') {
      const col = parseCol(pc.backgroundColor);
      const g = pc.backgroundImage !== 'none';
      if ((col && col[3] > 0) || g) scrim = { present: true, pseudo: ps, alpha: col ? R2(col[3]) : null, gradient: g };
    }
  }

  // ---- overlaps (non-inert components, no ancestor relation)
  const live = components.filter((c) => !c.rec.inert);
  const pairs = [];
  let overlapArea = 0;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const x = isect(a.box, b.box);
      if (!x || x.r - x.l <= 1 || x.b - x.t <= 1) continue;
      if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const ar = Math.round(area(x));
      overlapArea += ar;
      pairs.push({ a: sel(a.e), b: sel(b.e), area: ar, at: rectJ(x) });
    }
  }
  pairs.sort((p, q) => q.area - p.area);

  // ---- offscreen
  const off = { partial: [], fully: [] };
  for (const c of live) {
    const b = c.rawBox;
    if (!b) continue;
    const over = { left: Math.max(0, -b.l), top: Math.max(0, -b.t), right: Math.max(0, b.r - W), bottom: Math.max(0, b.b - H) };
    const any = over.left > 0.5 || over.top > 0.5 || over.right > 0.5 || over.bottom > 0.5;
    if (!any) continue;
    const fullyOut = b.r <= 0 || b.l >= W || b.b <= 0 || b.t >= H;
    (fullyOut ? off.fully : off.partial).push({ sel: sel(c.e), rect: rectJ(b), over: { left: R1(over.left), top: R1(over.top), right: R1(over.right), bottom: R1(over.bottom) } });
  }

  // ---- horizontal scroll
  const hs = { document: doc.scrollWidth > doc.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1, items: [] };
  const scrollers = [];
  for (const e of els) {
    const rec = info.get(e);
    if (!rec.vis) continue;
    const c = rec.c;
    const modalish = e.classList.contains('modal') || /^(menu|academy|editor|help|settings|stats|summary|scorecard|pause|relief|confirmBox)$/.test(e.id);
    if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && (modalish || /(auto|scroll)/.test(c.overflowX))) hs.items.push({ sel: sel(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, overflowX: c.overflowX });
    if (e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(c.overflowY)) scrollers.push({ sel: sel(e), scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, scrollTop: Math.round(e.scrollTop) });
  }
  hs.any = hs.document || hs.items.length > 0;

  // ---- tap targets
  const gapBetween = (a, b) => { const dx = Math.max(0, a.l - b.r, b.l - a.r), dy = Math.max(0, a.t - b.b, b.t - a.b); return dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy); };
  const targets = [];
  const seenT = new Set();
  for (const e of els) {
    const rec = info.get(e);
    if (!rec.rendered || !rec.raw || isScene(e)) continue;
    let ok = isInter(e);
    if (!ok && e.tagName === 'LABEL') {
      const ctl = e.control;
      if (ctl && !(info.get(ctl) && info.get(ctl).raw)) ok = true; // visually hidden control: the label is the target
    }
    if (!ok || seenT.has(e)) continue;
    seenT.add(e);
    const raw = rec.raw;
    const w = raw.r - raw.l, h = raw.b - raw.t;
    targets.push({ e, rec, w, h, inView: !!rec.v, inert: rec.inert, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' });
  }
  const tvis = targets.filter((t) => t.inView && !t.inert);
  const tapItems = targets.map((t) => {
    let gap = null, nb = null;
    if (t.inView && !t.inert) {
      for (const o of tvis) {
        if (o === t || o.e.contains(t.e) || t.e.contains(o.e)) continue;
        const g = gapBetween(t.rec.v, o.rec.v);
        if (gap === null || g < gap) { gap = g; nb = o.e; }
      }
    }
    const lab = (t.e.getAttribute('aria-label') || t.e.textContent || t.e.value || t.e.title || '').replace(/\s+/g, ' ').trim().slice(0, 28);
    return { sel: sel(t.e), text: lab, rect: rectJ(t.rec.raw), under44: t.w < 43.5 || t.h < 43.5, inView: t.inView, inert: t.inert, disabled: t.disabled, gap: gap === null ? null : R1(gap), neighbour: nb ? sel(nb) : null };
  });
  const counted = (x) => x.inView && !x.inert && !x.disabled;
  const tap = {
    total: tapItems.length,
    inView: tapItems.filter((x) => x.inView && !x.inert).length,
    under44InView: tapItems.filter((x) => counted(x) && x.under44).length,
    under44Total: tapItems.filter((x) => !x.inert && !x.disabled && x.under44).length,
    tightGapInView: tapItems.filter((x) => counted(x) && x.gap !== null && x.gap < 8).length,
    items: tapItems,
  };

  // ---- fonts
  const hist = new Map();
  const small = [];
  let under12 = 0, minSize = Infinity, nodes = 0;
  for (const t of texts) {
    const fam = String(t.rec.c.fontFamily).split(',')[0].replace(/["']/g, '').trim();
    const key = R1(t.fs) + '|' + t.rec.c.fontWeight + '|' + fam;
    const h = hist.get(key) || { size: R1(t.fs), weight: t.rec.c.fontWeight, family: fam, elements: 0, chars: 0 };
    h.elements++; h.chars += t.tb.chars; hist.set(key, h);
    nodes++;
    if (t.fs < minSize) minSize = t.fs;
    if (t.fs < 11.99) under12++;
    small.push({ sel: sel(t.e), size: R1(t.fs), weight: t.rec.c.fontWeight, text: t.label.slice(0, 28), inert: t.rec.inert });
  }
  small.sort((a, b) => a.size - b.size);
  const fontCensus = { textElements: nodes, minSize: minSize === Infinity ? null : R1(minSize), under12, histogram: [...hist.values()].sort((a, b) => a.size - b.size || a.elements - b.elements), smallest: small.slice(0, 12) };

  // ---- contrast
  const items = [];
  const sceneCols = { flat: cfg.flat, white: [255, 255, 255], black: [0, 0, 0] };
  for (const t of texts) {
    const fgc = parseCol(t.rec.c.color);
    if (!fgc) continue;
    const fg = [fgc[0], fgc[1], fgc[2], fgc[3] * t.rec.eff];
    // layers from the element up to (not including) body/html: the canvas sits in front of their background
    let ar = 0, ag = 0, ab = 0, aa = 0, approx = false;
    for (let a = t.e; a && a !== body && a !== doc && aa < 0.995; a = a.parentElement) {
      const ac = cs(a);
      if (ac.display === 'none') continue;
      const l = bgLayer(ac);
      approx = approx || l.approx;
      const la = l.col[3];
      if (la <= 0) continue;
      ar += (1 - aa) * la * l.col[0]; ag += (1 - aa) * la * l.col[1]; ab += (1 - aa) * la * l.col[2];
      aa += (1 - aa) * la;
    }
    const over = (b) => {
      const o = [ar + (1 - aa) * b[0], ag + (1 - aa) * b[1], ab + (1 - aa) * b[2]];
      return [fg[3] * fg[0] + (1 - fg[3]) * o[0], fg[3] * fg[1] + (1 - fg[3]) * o[1], fg[3] * fg[2] + (1 - fg[3]) * o[2]];
    };
    const bgOf = (b) => [ar + (1 - aa) * b[0], ag + (1 - aa) * b[1], ab + (1 - aa) * b[2]];
    const scene = aa < 0.995;
    const large = t.fs >= 24 || (t.fs >= 18.66 && parseInt(t.rec.c.fontWeight, 10) >= 700);
    const req = large ? 3 : 4.5;
    const rFlat = ratio(over(sceneCols.flat), bgOf(sceneCols.flat));
    const item = { sel: sel(t.e), text: t.label.slice(0, 28), size: R1(t.fs), large, fg: hex(fg) + (fg[3] < 0.995 ? '@' + R2(fg[3]) : ''), disabled: !!t.e.disabled, inert: t.rec.inert, scene, approx, req, ratio: R2(rFlat) };
    if (scene) {
      item.bg = hex(bgOf(sceneCols.flat)) + '(flat)';
      item.bgAlpha = R2(aa);
      item.ratioWhite = R2(ratio(over(sceneCols.white), bgOf(sceneCols.white)));
      item.ratioBlack = R2(ratio(over(sceneCols.black), bgOf(sceneCols.black)));
      item.risk = Math.min(item.ratioWhite, item.ratioBlack) < req;
    } else item.bg = hex(bgOf([0, 0, 0]));
    item.pass = item.ratio >= req;
    items.push(item);
  }
  const contrast = {
    standard: 'WCAG AA (4.5, large text 3)',
    total: items.length,
    failures: items.filter((i) => !i.pass && !i.disabled).length,
    sceneDependent: items.filter((i) => i.scene).length,
    sceneRisk: items.filter((i) => i.scene && i.risk && !i.disabled).length,
    lowest: items.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 12),
    items,
  };

  // ---- heavy paint features + animations (freeze style off so the declared values are the page's own)
  if (freeze) freeze.disabled = true;
  const blurOf = (bs) => {
    if (!bs || bs === 'none') return 0;
    let mx = 0;
    for (const part of bs.replace(/rgba?\([^)]*\)/g, '').split(/,(?![^(]*\))/)) {
      const nums = (part.match(/-?\d*\.?\d+px/g) || []).map(parseFloat);
      if (nums.length >= 3) mx = Math.max(mx, nums[2]);
    }
    return mx;
  };
  const heavy = { backdropFilter: { visible: 0, rendered: 0, sels: [] }, blurShadow: { visible: 0, rendered: 0, sels: [] }, willChange: { visible: 0, rendered: 0, sels: [] }, animations: { declaredElements: 0, infiniteElements: 0, transitionElements: 0, running: 0, runningInfinite: 0, sels: [] } };
  const addH = (k, rec) => { heavy[k].rendered++; if (rec.vis) { heavy[k].visible++; if (heavy[k].sels.length < 14) heavy[k].sels.push(sel(rec.e)); } };
  for (const e of els) {
    const rec = info.get(e);
    if (!rec.rendered) continue;
    const c = rec.c;
    const bf = c.backdropFilter || c.webkitBackdropFilter;
    if (bf && bf !== 'none') addH('backdropFilter', rec);
    if (blurOf(c.boxShadow) > 12) addH('blurShadow', rec);
    if (c.willChange && c.willChange !== 'auto') addH('willChange', rec);
    if (c.animationName && c.animationName !== 'none' && rec.vis) { heavy.animations.declaredElements++; if (/infinite/.test(c.animationIterationCount)) heavy.animations.infiniteElements++; if (heavy.animations.sels.length < 14) heavy.animations.sels.push(sel(e) + ' ' + c.animationName.split(',')[0]); }
    if (rec.vis && c.transitionDuration && /[1-9]/.test(c.transitionDuration.replace(/0(\.0+)?m?s/g, '0')) && c.transitionProperty !== 'none') heavy.animations.transitionElements++;
  }
  try {
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running') continue;
      heavy.animations.running++;
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      if (t && t.iterations === Infinity) heavy.animations.runningInfinite++;
    }
  } catch (err) { /* old engine */ }
  if (freeze) freeze.disabled = false;

  // ======================================================================================================
  // Wider metrics (additive: nothing above this line reads them, and the fields above are unchanged)
  // ======================================================================================================
  const cap = (a, n) => a.slice(0, n);

  // ---- which colour scheme this really is (a stylesheet with no light theme renders dark under both)
  const mq = (q) => { try { return matchMedia(q).matches; } catch (err) { return null; } };
  const schemeCheck = {
    requested: cfg.scheme || null, prefersDark: mq('(prefers-color-scheme: dark)'), prefersLight: mq('(prefers-color-scheme: light)'),
    colorScheme: cs(doc).colorScheme, dataTheme: doc.getAttribute('data-theme'), bodyBackground: cs(body).backgroundColor, bodyColor: cs(body).color,
  };
  schemeCheck.applied = cfg.scheme === 'light' ? schemeCheck.prefersLight === true : cfg.scheme === 'dark' ? schemeCheck.prefersDark === true : null;
  const bgBody = parseCol(cs(body).backgroundColor);
  schemeCheck.bodyLuminance = bgBody && bgBody[3] > 0 ? R2(lum(bgBody)) : null;

  // ---- the safe area: padding of a fixed probe that uses env(safe-area-inset-*)
  const insets = (() => {
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    body.appendChild(p);
    const c = getComputedStyle(p);
    const v = { top: parseFloat(c.paddingTop) || 0, right: parseFloat(c.paddingRight) || 0, bottom: parseFloat(c.paddingBottom) || 0, left: parseFloat(c.paddingLeft) || 0 };
    p.remove();
    return v;
  })();
  const SAFE = { l: insets.left, t: insets.top, r: W - insets.right, b: H - insets.bottom };
  const overSafe = (b) => ({ left: Math.max(0, SAFE.l - b.l), top: Math.max(0, SAFE.t - b.t), right: Math.max(0, b.r - SAFE.r), bottom: Math.max(0, b.b - SAFE.b) });
  const unsafe = (o) => o.left > 0.5 || o.top > 0.5 || o.right > 0.5 || o.bottom > 0.5;
  const fmtOver = (o) => ({ left: R1(o.left), top: R1(o.top), right: R1(o.right), bottom: R1(o.bottom) });

  // ---- canvas text (minimap, meter, academy plots): drawn with fillText, so invisible to the DOM passes
  const canvasText = (() => {
    const recsMap = window.__psgCanvasText;
    if (!recsMap) return { enabled: false };
    let sctx = null;
    const items = [];
    let withText = 0, hidden = 0;
    for (const cv of document.querySelectorAll('canvas')) {
      const a = recsMap.get(cv);
      if (!a || !a.length) continue;
      const rec = info.get(cv);
      const r = cv.getBoundingClientRect();
      if (!rec || !rec.vis || !(cv.width > 0 && cv.height > 0)) { hidden++; continue; }
      withText++;
      const sx = r.width / cv.width, sy = r.height / cv.height;
      if (!sctx) sctx = document.createElement('canvas').getContext('2d');
      for (const q of a) {
        sctx.font = q.font; sctx.textAlign = q.align; sctx.textBaseline = q.base;
        const tm = sctx.measureText(q.text);
        const xs = [q.x - tm.actualBoundingBoxLeft, q.x + tm.actualBoundingBoxRight], ys = [q.y - tm.actualBoundingBoxAscent, q.y + tm.actualBoundingBoxDescent];
        const px = [], py = [];
        for (const xx of xs) for (const yy of ys) { px.push(r.left + (q.m[0] * xx + q.m[2] * yy + q.m[4]) * sx); py.push(r.top + (q.m[1] * xx + q.m[3] * yy + q.m[5]) * sy); }
        const bx = { l: Math.min(...px), t: Math.min(...py), r: Math.max(...px), b: Math.max(...py) };
        const fpx = parseFloat(/([\d.]+)px/.exec(q.font) ? /([\d.]+)px/.exec(q.font)[1] : 'NaN');
        const size = Math.hypot(q.m[0], q.m[1]) * sx * fpx;
        const it = { canvas: sel(cv), text: q.text.slice(0, 28), px: R1(size), rect: rectJ(bx), ops: [q.op], font: q.font };
        const dup = items.find((o) => o.canvas === it.canvas && o.text === it.text && o.px === it.px && Math.abs(o.rect.x - it.rect.x) < 3 && Math.abs(o.rect.y - it.rect.y) < 3);
        if (dup) { if (!dup.ops.includes(q.op)) dup.ops.push(q.op); continue; } // a stroke under a fill is one label
        it.under12 = size < 11.99;
        it.clipped = bx.l < r.left - 0.5 || bx.t < r.top - 0.5 || bx.r > r.right + 0.5 || bx.b > r.bottom + 0.5;
        it.outsideViewport = bx.l < -0.5 || bx.t < -0.5 || bx.r > W + 0.5 || bx.b > H + 0.5;
        it._b = bx;
        items.push(it);
      }
    }
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const x = isect(items[i]._b, items[j]._b);
        if (x && x.r - x.l > 1 && x.b - x.t > 1) pairs.push({ a: items[i].text, b: items[j].text, canvasA: items[i].canvas, canvasB: items[j].canvas, area: Math.round(area(x)) });
      }
    }
    for (const it of items) delete it._b;
    return {
      enabled: true, canvasesWithText: withText, hiddenCanvasesWithText: hidden, total: items.length,
      under12: items.filter((o) => o.under12).length, minPx: items.length ? Math.min(...items.map((o) => o.px)) : null,
      edgeClipped: items.filter((o) => o.clipped).length, outsideViewport: items.filter((o) => o.outsideViewport).length,
      overlapCount: pairs.length, overlaps: cap(pairs, 20), items: cap(items, 80),
    };
  })();

  // ---- under 12 px, DOM + canvas
  const under12All = {
    dom: fontCensus.under12, canvas: canvasText.enabled ? canvasText.under12 : null,
    total: fontCensus.under12 + (canvasText.enabled ? canvasText.under12 : 0),
    smallestDom: small.filter((s) => s.size < 11.99).slice(0, 12),
  };

  // ---- how many distinct values the design uses (visible text for the type values, visible painted boxes for the rest)
  const distinct = (() => {
    const S = { fontSize: new Map(), fontWeight: new Map(), lineHeight: new Map(), lineHeightRatio: new Map(), letterSpacing: new Map(), borderRadius: new Map(), zIndex: new Map(), boxShadow: new Map() };
    const bump = (k, v) => { S[k].set(v, (S[k].get(v) || 0) + 1); };
    for (const t of texts) {
      const c = t.rec.c;
      bump('fontSize', R1(t.fs));
      bump('fontWeight', String(c.fontWeight));
      const lh = parseFloat(c.lineHeight);
      bump('lineHeight', isNaN(lh) ? String(c.lineHeight) : R1(lh) + 'px');
      if (!isNaN(lh)) bump('lineHeightRatio', R2(lh / t.fs));
      const ls = parseFloat(c.letterSpacing);
      bump('letterSpacing', (isNaN(ls) ? 0 : R2(ls)) + 'px');
    }
    for (const e of els) {
      const rec = info.get(e);
      if (!rec.vis) continue;
      const c = rec.c;
      if (painted(rec)) { const br = c.borderRadius; if (br && !/^0(px|%)?( 0(px|%)?)*$/.test(br)) bump('borderRadius', br); }
      if (c.zIndex !== 'auto') bump('zIndex', c.zIndex);
      if (c.boxShadow && c.boxShadow !== 'none') bump('boxShadow', c.boxShadow);
    }
    const out = {};
    for (const k of Object.keys(S)) {
      const arr = [...S[k].entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
      out[k] = { count: arr.length, values: cap(arr, 24).map(([v, n]) => [v, n]) };
    }
    return out;
  })();

  // ---- the accent colour: where the yellow is (exact token, and the yellow hue family around it)
  const accentUse = (() => {
    const raw = getComputedStyle(doc).getPropertyValue('--accent').trim();
    const acc = raw ? parseCol(raw) : null;
    if (!acc || acc[3] <= 0) return { token: raw || null, found: false };
    const hsl = (c) => {
      const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
      let h = 0;
      if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return { h: (h * 60 + 360) % 360, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
    };
    const ah = hsl(acc);
    const exact = (c) => c && c[3] > 0.05 && Math.abs(c[0] - acc[0]) <= 1.5 && Math.abs(c[1] - acc[1]) <= 1.5 && Math.abs(c[2] - acc[2]) <= 1.5;
    const family = (c) => {
      if (!c || c[3] <= 0.05) return false;
      const h = hsl(c);
      const dh = Math.min(Math.abs(h.h - ah.h), 360 - Math.abs(h.h - ah.h));
      return dh <= 14 && h.s >= 0.55 && h.l >= 0.3 && h.l <= 0.88;
    };
    const tokensOf = (s) => (s && s !== 'none' ? (s.match(/(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]+\)/g) || []).map(parseCol) : []);
    const byEx = {}, byFam = {};
    let nEx = 0, nFam = 0, primary = 0;
    const list = [];
    const textEls = new Set(texts.map((t) => t.e));
    for (const e of els) {
      const rec = info.get(e);
      if (!rec.vis || rec.inert) continue;
      const c = rec.c;
      const hits = [];
      const add = (prop, cols) => { for (const col of cols) { if (exact(col)) { hits.push([prop, true]); return; } if (family(col)) { hits.push([prop, false]); return; } } };
      if (textEls.has(e)) add('text', [parseCol(c.color)]);
      add('background', [parseCol(c.backgroundColor)]);
      add('background-gradient', tokensOf(c.backgroundImage));
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(c['border' + side + 'Width']) > 0 && c['border' + side + 'Style'] !== 'none') { add('border', [parseCol(c['border' + side + 'Color'])]); if (hits.some((h) => h[0] === 'border')) break; }
      if (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0) add('outline', [parseCol(c.outlineColor)]);
      add('shadow', tokensOf(c.boxShadow));
      if (c.textDecorationLine && c.textDecorationLine !== 'none') add('decoration', [parseCol(c.textDecorationColor)]);
      if (e.ownerSVGElement || e.tagName.toLowerCase() === 'svg') { add('fill', [parseCol(c.fill)]); add('stroke', [parseCol(c.stroke)]); }
      if (c.accentColor && c.accentColor !== 'auto') add('accent-color', [parseCol(c.accentColor)]);
      if (e.matches('.btn.primary')) primary++;
      if (!hits.length) continue;
      const anyEx = hits.some((h) => h[1]);
      if (anyEx) nEx++; else nFam++;
      for (const [p, ex] of hits) { const m = ex ? byEx : byFam; m[p] = (m[p] || 0) + 1; }
      if (list.length < 60) list.push({ sel: sel(e), props: hits.map((h) => h[0] + (h[1] ? '' : '~')).join(' ') });
    }
    return { token: raw, rgb: acc.slice(0, 3).map(Math.round), found: true, elementsExact: nEx, elementsFamilyOnly: nFam, elements: nEx + nFam, byPropExact: byEx, byPropFamily: byFam, primaryButtons: primary, items: list };
  })();

  // ---- dialogs: does each open panel fit the viewport, without sideways scrolling
  const dialogFits = (() => {
    const out = [];
    for (const e of els) {
      const rec = info.get(e);
      if (!rec.vis || !(e.classList.contains('modal') || /^(menu|academy|coachMark|loading|boot)$/.test(e.id))) continue;
      const r = e.getBoundingClientRect();
      const inViewport = r.left >= -0.5 && r.top >= -0.5 && r.right <= W + 0.5 && r.bottom <= H + 0.5;
      const noHScroll = e.scrollWidth <= e.clientWidth + 1;
      const so = overSafe(box(r));
      out.push({ sel: sel(e), inert: rec.inert, rect: rectJ(box(r)), inViewport, noHScroll, scrollsY: e.scrollHeight > e.clientHeight + 1, insideSafeArea: !unsafe(so), over: unsafe(so) ? fmtOver(so) : undefined, fits: inViewport && noHScroll });
    }
    return { count: out.length, failures: out.filter((x) => !x.fits).length, allFit: out.every((x) => x.fits), items: out };
  })();

  // ---- the safe area: no tappable thing and no text under a notch, home bar or rounded corner
  const insideSafeArea = (() => {
    const bad = [];
    let nT = 0, nX = 0;
    for (const t of tvis) { nT++; const o = overSafe(t.rec.v); if (unsafe(o)) bad.push({ kind: 'target', sel: sel(t.e), rect: rectJ(t.rec.v), over: fmtOver(o) }); }
    for (const t of texts) { if (t.rec.inert) continue; nX++; const o = overSafe(t.tb.v); if (unsafe(o)) bad.push({ kind: 'text', sel: sel(t.e), text: t.label.slice(0, 28), rect: rectJ(t.tb.v), over: fmtOver(o) }); }
    if (canvasText.enabled) for (const it of canvasText.items) { const b = { l: it.rect.x, t: it.rect.y, r: it.rect.x + it.rect.w, b: it.rect.y + it.rect.h }; const o = overSafe(b); if (unsafe(o) && !it.outsideViewport) bad.push({ kind: 'canvas-text', sel: it.canvas, text: it.text, rect: it.rect, over: fmtOver(o) }); }
    return { insets, active: insets.top + insets.right + insets.bottom + insets.left > 0, safeRect: rectJ(SAFE), checked: { targets: nT, texts: nX }, outside: bad.length, outsideTargets: bad.filter((x) => x.kind === 'target').length, outsideTexts: bad.filter((x) => x.kind !== 'target').length, items: cap(bad, 40) };
  })();

  // ---- every tappable thing, not only the native controls: roles, listeners (addEventListener / onclick), labels
  const tapAll = (() => {
    const clickable = window.__psgClickable;
    const ROLE = '[role="tab"], [role="switch"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="link"], [role="option"], [role="slider"]';
    const items = [];
    for (const e of els) {
      const rec = info.get(e);
      if (!rec.rendered || !rec.raw || isScene(e) || e === body) continue;
      let kind = null;
      if (isInter(e)) kind = 'native';
      else if (e.matches(ROLE)) kind = 'role';
      else if ((clickable && clickable.has(e)) || typeof e.onclick === 'function' || e.hasAttribute('onclick')) kind = 'listener';
      else if (e.tagName === 'LABEL' && e.control && !(info.get(e.control) && info.get(e.control).raw)) kind = 'label';
      if (!kind) continue;
      const raw = rec.raw, w = raw.r - raw.l, h = raw.b - raw.t;
      const it = { sel: sel(e), kind, rect: rectJ(raw), under44: w < 43.5 || h < 43.5, under32: w < 31.5 || h < 31.5, inView: !!rec.v, inert: rec.inert, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' };
      if (rec.v && !rec.inert && !it.disabled) { // is the middle of the visible part really this element's? (something laid over it eats the tap)
        const cx = (rec.v.l + rec.v.r) / 2, cy = (rec.v.t + rec.v.b) / 2;
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== e && !e.contains(top) && !top.contains(e) && !(e.tagName === 'LABEL' && e.control && (top === e.control))) it.obscuredBy = sel(top);
      }
      items.push(it);
    }
    const live = items.filter((x) => x.inView && !x.inert);
    const counted = live.filter((x) => !x.disabled);
    return {
      total: items.length, inView: live.length,
      byKind: items.reduce((m, x) => { m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {}),
      under44InView: counted.filter((x) => x.under44).length, under32InView: counted.filter((x) => x.under32).length,
      under44InViewDisabled: live.filter((x) => x.disabled && x.under44).length,
      listenerOnlyUnder44: counted.filter((x) => x.kind !== 'native' && x.under44).length,
      obscured: counted.filter((x) => x.obscuredBy).length,
      worst: cap(counted.filter((x) => x.under44).sort((a, b) => Math.min(a.rect.w, a.rect.h) - Math.min(b.rect.w, b.rect.h)), 20),
      obscuredItems: cap(counted.filter((x) => x.obscuredBy), 20),
      items,
    };
  })();

  // ---- focus visibility (last: it moves focus)
  const props = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'color', 'textDecorationLine', 'transform', 'filter', 'opacity'];
  const snap = (c) => props.map((p) => c[p]).join('|');
  const foc = { count: 0, withVisibleFocus: 0, without: [], focusVisibleMatched: 0 };
  if (cfg.focus) {
    const prev = document.activeElement;
    for (const t of targets) {
      if (!t.inView || t.inert || t.disabled || (t.e.tabIndex < 0 && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(t.e.tagName))) continue;
      foc.count++;
      const before = snap(getComputedStyle(t.e));
      try { t.e.focus({ preventScroll: true, focusVisible: true }); } catch (err) { t.e.focus(); }
      const fv = t.e.matches(':focus-visible');
      if (fv) foc.focusVisibleMatched++;
      const c2 = getComputedStyle(t.e);
      const after = snap(c2);
      const oc = parseCol(c2.outlineColor);
      const ring = c2.outlineStyle !== 'none' && (c2.outlineStyle === 'auto' || parseFloat(c2.outlineWidth) > 0) && (!oc || oc[3] > 0);
      if (fv && (ring || before !== after)) foc.withVisibleFocus++; else if (fv) foc.without.push(sel(t.e)); else foc.without.push(sel(t.e) + ' (:focus-visible did not match)');
      t.e.blur();
    }
    if (prev && prev.focus && prev !== body) try { prev.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // ---- focusable pass over the whole document, in tab order, skipping the contents of closed <details> (their summary
  // stays): the targets pass above also reaches things a keyboard user cannot (content-visibility:hidden still lays out)
  const focusableAll = (() => {
    if (!cfg.focus) return { enabled: false };
    const FOC = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';
    const skipped = { closedDetails: 0, inert: 0, hidden: 0, disabled: 0, negativeTabindex: 0, offscreen: 0 };
    const closedDetails = (e) => {
      let child = e;
      for (let p = e.parentElement; p; child = p, p = p.parentElement) {
        if (p.tagName !== 'DETAILS' || p.open) continue;
        const first = [...p.children].find((x) => x.tagName === 'SUMMARY');
        if (child !== first) return true;
      }
      return false;
    };
    const list = [];
    for (const e of body.querySelectorAll(FOC)) {
      if (e.tabIndex < 0) { skipped.negativeTabindex++; continue; }
      if (e.disabled || e.closest('fieldset:disabled')) { skipped.disabled++; continue; }
      if (closedDetails(e)) { skipped.closedDetails++; continue; }
      if (e.closest('[inert]')) { skipped.inert++; continue; }
      let seen;
      try { seen = e.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }); } catch (err) { const i = info.get(e); seen = !!(i && i.rendered && i.c.visibility === 'visible'); }
      const r = e.getBoundingClientRect();
      if (!seen || r.width < 0.5 || r.height < 0.5) { skipped.hidden++; continue; }
      if (r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) { skipped.offscreen++; }
      list.push(e);
    }
    // positive tabindex values come first in the real tab order, then document order
    const ordered = list.map((e, i) => ({ e, i })).sort((a, b) => ((a.e.tabIndex > 0 ? a.e.tabIndex : 1e9) - (b.e.tabIndex > 0 ? b.e.tabIndex : 1e9)) || a.i - b.i).map((x) => x.e);
    const prev = document.activeElement;
    const out = { enabled: true, reachable: ordered.length, tested: 0, focused: 0, focusVisibleMatched: 0, withVisibleFocus: 0, without: [], notFocusable: [], skipped, order: [] };
    for (const e of ordered) {
      out.tested++;
      if (out.order.length < 60) out.order.push(sel(e));
      const before = snap(getComputedStyle(e));
      try { e.focus({ preventScroll: true, focusVisible: true }); } catch (err) { e.focus(); }
      if (document.activeElement !== e) { out.notFocusable.push(sel(e)); continue; }
      out.focused++;
      const fv = e.matches(':focus-visible');
      if (fv) out.focusVisibleMatched++;
      const c2 = getComputedStyle(e);
      const oc = parseCol(c2.outlineColor);
      const ring = c2.outlineStyle !== 'none' && (c2.outlineStyle === 'auto' || parseFloat(c2.outlineWidth) > 0) && (!oc || oc[3] > 0);
      if (fv && (ring || before !== snap(c2))) out.withVisibleFocus++; else out.without.push(sel(e) + (fv ? '' : ' (:focus-visible did not match)'));
      e.blur();
    }
    if (prev && prev.focus && prev !== body) try { prev.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    out.without = cap(out.without, 40);
    out.notFocusable = cap(out.notFocusable, 40);
    return out;
  })();

  const contrastUnparsed = { count: unparsedCols.size, samples: [...unparsedCols].slice(0, 8) }; // colours the contrast pass could not read at all
  const g = window.game;
  return {
    gameState: g ? g.state : null,
    bodyClasses: [...body.classList],
    dataState: body.dataset.state || null,
    hud: (document.getElementById('hud') || {}).dataset ? Object.assign({}, document.getElementById('hud').dataset) : null,
    domNodes: document.getElementsByTagName('*').length,
    chromeCoverage: covFrac(gAny, 0),
    chromeCoverageSolid: covFrac(gSolid, 0),
    chromeCoverageBottom45: covFrac(gAny, y45),
    chromeCoverageBottom45Solid: covFrac(gSolid, y45),
    scrim,
    components: { total: components.length, live: live.length, inert: components.length - live.length },
    overlaps: { count: pairs.length, areaPx: overlapArea, pairs: pairs.slice(0, 60) },
    offscreen: { partialCount: off.partial.length, fullyCount: off.fully.length, partial: off.partial.slice(0, 40), fully: off.fully.slice(0, 20) },
    hScroll: hs,
    scrollers: scrollers.slice(0, 20),
    tapTargets: tap,
    fontCensus,
    contrast,
    focusable: foc,
    heavy,
    // ---- appended metrics (the keys above keep their order; see the header comment)
    schemeCheck,
    tapAll,
    focusableAll,
    under12: under12All,
    distinct,
    dialogFits,
    accentUse,
    canvasText,
    insideSafeArea,
    contrastUnparsed,
  };
}

// ---- the fingerprint (--fingerprint): getComputedStyle of every element, layout + paint properties only.
// Compact on purpose: one dictionary of distinct values per property, and each node is a row of dictionary
// indexes. Node keys do not depend on class names: the nearest ancestor id (or "body") plus tag[n-th of its tag].
function fingerprintPage() {
  const doc = document.documentElement, body = document.body;
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
  const PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear', 'zIndex', 'boxSizing', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
    ...SIDES.map((s) => 'margin' + s), ...SIDES.map((s) => 'padding' + s),
    ...SIDES.flatMap((s) => ['border' + s + 'Width', 'border' + s + 'Style', 'border' + s + 'Color']),
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
    'overflowX', 'overflowY', 'flexDirection', 'flexWrap', 'flexGrow', 'flexShrink', 'flexBasis', 'order', 'alignItems', 'alignSelf', 'alignContent', 'justifyContent', 'justifyItems', 'justifySelf',
    'rowGap', 'columnGap', 'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow', 'gridAutoColumns', 'gridAutoRows', 'gridColumnStart', 'gridColumnEnd', 'gridRowStart', 'gridRowEnd',
    'transform', 'translate', 'scale', 'rotate', 'zoom', 'contentVisibility', 'objectFit', 'verticalAlign', 'visibility', 'opacity', 'mixBlendMode', 'isolation',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariantNumeric', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'textTransform', 'textIndent', 'textOverflow', 'whiteSpace', 'overflowWrap', 'wordBreak', 'listStyleType',
    'color', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundClip', 'boxShadow', 'textShadow',
    'outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'filter', 'backdropFilter', 'clipPath', 'maskImage',
    'textDecorationLine', 'textDecorationColor', 'textDecorationStyle', 'textDecorationThickness', 'textUnderlineOffset',
    'fill', 'stroke', 'strokeWidth', 'accentColor', 'colorScheme', 'pointerEvents', 'cursor', 'touchAction', 'userSelect',
  ];
  const TIMING = ['animationName', 'animationDuration', 'animationDelay', 'animationIterationCount', 'animationTimingFunction', 'animationFillMode', 'animationDirection', 'transitionProperty', 'transitionDuration', 'transitionDelay', 'transitionTimingFunction', 'willChange'];
  const props = PROPS.concat(TIMING);
  const dict = props.map(() => new Map());
  const idx = (p, v) => { const m = dict[p]; let i = m.get(v); if (i === undefined) { i = m.size; m.set(v, i); } return i; };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|LINK|META|TITLE|BASE)$/;
  const els = [doc, body, ...body.querySelectorAll('*')].filter((e) => !SKIP.test(e.tagName));
  const keyOf = (e) => {
    if (e === doc) return 'html';
    if (e === body) return 'body';
    const segs = [];
    let n = e;
    while (n && n !== body) {
      if (n.id) { segs.unshift('#' + n.id); break; }
      const p = n.parentElement;
      let i = 0;
      if (p) for (const s of p.children) { if (s === n) break; if (s.tagName === n.tagName) i++; }
      segs.unshift(n.tagName.toLowerCase() + '[' + i + ']');
      n = p;
    }
    if (n === body) segs.unshift('body');
    return segs.join('/');
  };
  const seen = new Map();
  const uniq = (k) => { const c = (seen.get(k) || 0) + 1; seen.set(k, c); return c === 1 ? k : k + '~' + c; };
  const rows = [];
  const cls = {};
  for (const e of els) {
    const key = uniq(keyOf(e));
    const row = new Array(props.length).fill(-1);
    const c = getComputedStyle(e);
    for (let i = 0; i < PROPS.length; i++) row[i] = idx(i, String(c[PROPS[i]]));
    rows.push({ key, row, e });
    const cn = typeof e.className === 'string' ? e.className.trim() : (e.getAttribute && e.getAttribute('class')) || '';
    cls[key] = e.tagName.toLowerCase() + (cn ? '.' + cn.split(/\s+/).slice(0, 3).join('.') : '');
    for (const ps of ['::before', '::after']) {
      const pc = getComputedStyle(e, ps);
      if (!pc.content || pc.content === 'none' || pc.content === 'normal') continue;
      const prow = new Array(props.length).fill(-1);
      for (let i = 0; i < PROPS.length; i++) prow[i] = idx(i, String(pc[PROPS[i]]));
      const pk = uniq(key + ps);
      rows.push({ key: pk, row: prow, e: null, pseudo: ps, owner: e });
      cls[pk] = cls[key] + ps;
    }
  }
  // animation / transition timing, read with the harness's "no animation" style off (re-enabled before any frame can run)
  const freeze = document.getElementById('__psgFreeze');
  if (freeze) freeze.disabled = true;
  for (const r of rows) {
    const c = getComputedStyle(r.e || r.owner, r.pseudo || null);
    for (let i = 0; i < TIMING.length; i++) r.row[PROPS.length + i] = idx(PROPS.length + i, String(c[TIMING[i]]));
  }
  if (freeze) freeze.disabled = false;
  return { props, dict: dict.map((m) => [...m.keys()]), rows: rows.map((r) => [r.key, r.row]), cls };
}

// ---------------------------------------------------------------------------------------------- page driver
class Pg {
  constructor(cdp, o, vp, scheme, base) { this.cdp = cdp; this.o = o; this.vp = vp; this.scheme = scheme; this.base = base; this.errors = []; this.det = !o.live; this.instrument = o.instrument !== false && !o.perf; this.insetsOn = false; this.held = null; }
  async ev(expr, timeout) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, timeout || this.o.timeout);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page eval failed: ${(d.exception && (d.exception.description || d.exception.value)) || d.text}\n  in: ${String(expr).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    return r.result.value;
  }
  async init() {
    const c = this.cdp;
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Performance.enable');
    c.listen('Runtime.exceptionThrown', (p) => this.errors.push('exception: ' + (p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text).split('\n')[0]));
    c.listen('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') this.errors.push('console.error: ' + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)); });
    c.listen('Log.entryAdded', (p) => { if (p.entry.level === 'error' && !/favicon|Failed to load resource.*(404|net::ERR_FILE_NOT_FOUND)/.test(p.entry.text + (p.entry.url || ''))) this.errors.push('log: ' + p.entry.text.slice(0, 200) + (p.entry.url ? ' ' + p.entry.url.slice(-60) : '')); });
    try { await c.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }); } catch (e) { /* ignore */ }
    try { await c.send('Emulation.setLocaleOverride', { locale: 'en-US' }); } catch (e) { /* ignore */ }
    // requests paused by Fetch (only while a scenario holds or fails the game's module): kept, failed or continued
    c.listen('Fetch.requestPaused', (p) => {
      if (this.held && this.held.mode === 'hold') this.held.reqs.push(p.requestId);
      else if (this.held && this.held.mode === 'fail') c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' }).catch(() => {});
      else c.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    });
  }
  async setViewport(vp, scheme) {
    const c = this.cdp;
    this.vp = vp; this.scheme = scheme;
    await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.dpr, mobile: vp.touch, screenWidth: vp.w, screenHeight: vp.h, positionX: 0, positionY: 0 });
    await c.send('Emulation.setTouchEmulationEnabled', vp.touch ? { enabled: true, maxTouchPoints: 5, configuration: 'mobile' } : { enabled: false });
    await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    // notch viewports report safe-area insets (env(safe-area-inset-*)); every other viewport must see zeros again
    if (vp.insets) { await c.send('Emulation.setSafeAreaInsetsOverride', { insets: vp.insets }); this.insetsOn = true; }
    else if (this.insetsOn) { await c.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, right: 0, bottom: 0, left: 0 } }); this.insetsOn = false; }
  }
  // load the game with a seeded storage / fixed hash. Returns {boot:'ok'|'error'}; for a scenario that holds or
  // fails the game's module (holdBoot / failBoot) it returns {boot:'held'|'failed'} with the page still booting.
  async load(scenario) {
    const c = this.cdp;
    if (this.scriptId) { try { await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }); } catch (e) { /* ignore */ } }
    await this.navRaw('about:blank');
    const cfg = { seed: scenario.seed || {}, det: this.det, now: FIXED_NOW, noWebgl: !!scenario.noWebgl, instrument: this.instrument };
    let src = `(${preBoot.toString()})(${JSON.stringify(cfg)});`;
    if (this.o.initJs) src += '\n;' + fs.readFileSync(this.o.initJs, 'utf8');
    this.scriptId = (await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src })).identifier;
    if (scenario.holdBoot || scenario.failBoot) {
      this.held = { mode: scenario.holdBoot ? 'hold' : 'fail', reqs: [] };
      await c.send('Fetch.enable', { patterns: [{ urlPattern: '*dist/game.js*', requestStage: 'Request' }] });
      // the load event never fires while the module is pending, so do not wait for it
      const nav = await c.send('Page.navigate', { url: `${this.base}?nosw${scenario.hash || ''}` });
      if (nav.errorText) throw new Error(`navigate: ${nav.errorText}`);
      await waitFor(() => this.ev(`!!document.getElementById('boot') && document.readyState !== 'loading'`), this.o.timeout, 'the boot screen');
      if (scenario.holdBoot) await waitFor(() => this.held.reqs.length > 0, this.o.timeout, 'the game module request to be held');
      else await waitFor(() => this.ev(`!!document.querySelector('#boot button')`), this.o.timeout, 'the load-failed boot screen');
      await this.ev(`document.fonts.ready.then(()=>true)`);
      await this.ev(`(${installFreeze.toString()})(${JSON.stringify(this.o.injectCssText || '')})`);
      return { boot: scenario.holdBoot ? 'held' : 'failed' };
    }
    await this.navRaw(`${this.base}?nosw${scenario.hash || ''}`);
    return this.finishBoot();
  }
  // let a held game module through and finish booting (also the clean-up when a scenario stops early)
  async releaseBoot() {
    if (!this.held) return null;
    const c = this.cdp, h = this.held;
    this.held = null;
    for (const id of h.reqs) await c.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
    await c.send('Fetch.disable').catch(() => {});
    if (h.mode === 'fail') return { boot: 'failed' };
    return this.finishBoot();
  }
  async finishBoot() {
    // wait for boot: either window.game exists and #boot is gone, or the boot message turned into an error
    const st = await waitFor(async () => this.ev(`(()=>{ const b=document.getElementById('boot'); if(!b && window.game) return 'ok'; if(b && b.querySelector('.boot-msg')) return 'error'; return null; })()`), this.o.timeout, 'the game to boot', 150);
    if (st === 'ok') {
      await this.ev(`(${afterBoot.toString()})(${this.det})`);
      if (this.vp.touch) {
        const t = await this.ev(`document.body.classList.contains('touch')`);
        if (!t) { await this.ev(`game.input.showTouch(true)`); this.touchForced = true; }
      } else await this.ev(`game.input.showTouch(false)`);
    }
    await this.ev(`document.fonts.ready.then(()=>true)`);
    await this.ev(`(${installFreeze.toString()})(${JSON.stringify(this.o.injectCssText || '')})`);
    if (this.o.injectJs && st === 'ok') await this.ev(fs.readFileSync(this.o.injectJs, 'utf8'));
    return { boot: st };
  }
  async navRaw(url) {
    const done = this.cdp.once('Page.loadEventFired', this.o.timeout);
    const nav = await this.cdp.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
    await done;
  }
  async step(n = 1, dt = 1 / 60) { return this.ev(`game.debugStep(${n}, ${dt})`); }
  // step one frame at a time until cond (a JS expression) is truthy; returns frames used, throws if never
  async until(cond, max = 600, what = cond) {
    const r = await this.ev(`(()=>{ for (let i=0;i<${max};i++){ game.debugStep(1,1/60); if (${cond}) return i+1; } return -1; })()`);
    if (r < 0) throw new Error(`gave up after ${max} frames waiting for: ${what}`);
    return r;
  }
  async settle(ms = 40) { await sleep(ms); }
}

// ---------------------------------------------------------------------------------------------- scenarios
const BASE_SEED = () => ({ 'psg-tutorial-done': '1', 'psg-settings': { ffSeen: 3, tees: 'middle' }, 'psg-tips': { plays: 1 } });

function resumeSnapshot() {
  const holes = [[4, 5, 4, 3], [4, 6, 4, 3]];
  return {
    v: 1, t: FIXED_NOW - 3600000, i: 4, p: 0, mid: null, done: false,
    opts: { courseId: 'augusta', holes: [...Array(18).keys()], mode: '18', seed: 4242, players: null, daily: null, solo: false, target: null, tees: 'middle' },
    players: [{ scores: [], attempts: [], stats: { holes: [1, 2, 3, 4].map((n, k) => ({ number: n, par: holes[0][k], yards: 380, strokes: holes[1][k], putts: 2, fir: k % 2 === 0, gir: k % 2 === 1, penalties: 0, sg: { OTT: -0.1, APP: -0.3, ARG: 0, PUTT: -0.2 }, shots: [] })), cur: null } }],
  };
}
function resumeSeed() {
  const s = resumeSnapshot();
  const strokes = [5, 6, 4, 3];
  s.players[0].scores = strokes.map((st, k) => ({ number: k + 1, strokes: st }));
  s.players[0].stats.holes.forEach((h, k) => { h.strokes = strokes[k]; });
  return { ...BASE_SEED(), 'psg-resume': s };
}
function historySeed() {
  const e = (date, course, mode, holes, strokes, par, putts, pen, fir, firN, gir, sg, tees) => ({ date, course, mode, holes, player: null, seed: 100 + holes, strokes, par, putts, penalties: pen, fir, firN, gir, sg, sgTotal: sg.OTT + sg.APP + sg.ARG + sg.PUTT, profile: 'mid', difficulty: 'standard', tees });
  return {
    ...BASE_SEED(),
    'psg-history': [
      e('2026-08-14T15:10:00.000Z', 'augusta', '18', 18, 94, 72, 35, 3, 5, 14, 3, { OTT: -2.1, APP: -4.2, ARG: -1.1, PUTT: -1.9 }, 'middle'),
      e('2026-08-30T09:00:00.000Z', 'standrews', '18', 18, 91, 72, 34, 2, 6, 14, 4, { OTT: -1.8, APP: -3.9, ARG: -0.7, PUTT: -1.2 }, 'middle'),
      e('2026-09-11T17:30:00.000Z', 'pebble', 'front', 9, 47, 36, 17, 1, 3, 7, 2, { OTT: -0.9, APP: -1.8, ARG: -0.3, PUTT: -0.6 }, 'middle'),
      e('2026-09-20T08:40:00.000Z', 'augusta', '18', 18, 88, 72, 33, 1, 7, 14, 5, { OTT: -1.2, APP: -3.1, ARG: -0.4, PUTT: -0.8 }, 'middle'),
      e('2026-09-28T12:00:00.000Z', 'sawgrass', 'back', 9, 45, 36, 16, 0, 4, 7, 3, { OTT: -0.4, APP: -1.2, ARG: 0.1, PUTT: -0.5 }, 'middle'),
      e('2026-10-05T10:15:00.000Z', 'augusta', 'single', 1, 3, 3, 2, 0, 0, 0, 1, { OTT: 0, APP: 0.2, ARG: 0, PUTT: -0.1 }, 'middle'),
      e('2026-10-12T14:20:00.000Z', 'standrews', '18', 18, 85, 72, 32, 1, 8, 14, 6, { OTT: -0.7, APP: -2.4, ARG: -0.2, PUTT: -0.5 }, 'middle'),
      e('2026-10-19T16:45:00.000Z', 'augusta', '18', 18, 83, 72, 31, 0, 8, 14, 7, { OTT: -0.5, APP: -2.0, ARG: 0.2, PUTT: -0.3 }, 'middle'),
    ],
  };
}

const ROUND_OPTS = { courseId: 'augusta', holes: [11], mode: 'single', seed: 27 };

// swing the meter at the caddie's marker (power) and the centre of the impact zone (accuracy)
async function swingAtMarker(P, hooks = {}) {
  await P.step(30);
  await P.ev('game.meterClick()');
  await P.until('game.meter.state==="power"', 5);
  if (hooks.mid) {
    await P.until('game.meter.v >= 0.5*(game.meter.marker||0.8)', 400, 'meter mid power');
    await hooks.mid();
  }
  await P.until('game.meter.v >= (game.meter.marker||0.8)', 400, 'meter at the marker');
  await P.ev('game.meterClick()');
  await P.until('game.meter.state==="accuracy" && game.meter.v < 0.015', 200, 'accuracy at zero');
  await P.ev('game.meterClick()');
  await P.until('game.state==="flight"', 400, 'impact');
}
const clearToasts = (P) => P.ev(`(()=>{ game.ui.toasts.innerHTML=''; const b=document.getElementById('banner'); b.classList.remove('show'); clearTimeout(game.ui.bannerT); return true; })()`);

// move the ball next to the cup and re-enter address
const teleportToGreen = (P, dx = 3.2, dz = 2.4) => P.ev(`(()=>{ const h=game.hole, c=h.cup; game.ball={...game.ball, p:[c.x+${dx},0,c.z+${dz}], isTee:false}; game.startFlyover(); game.endFlyover(); return game.state; })()`);

// ---- helpers for the extra scenarios (layout stress, summaries, the missing coach cards, the specimen)
// two 72-character player names with no space to wrap at: the worst a saved name or an old save can hand the layout
const LONG_NAME = 'Maximilianalexanderbartholomewchristophersonmontgomeryfitzwilliamhargreaves'.slice(0, 72);
const LONG_NAME_2 = 'Bartholomewjonathanchristopherfitzgeraldmontgomerywashingtonjeffersonlincoln'.slice(0, 72);

// a new round, walked to its first address the way the "round" scenario does it
async function toAddress(P, opts = ROUND_OPTS) {
  await P.ev(`game.ui.begin(${JSON.stringify(opts)})`);
  await P.until('game.state==="flyover"', 30, 'the flyover to start');
  await P.step(45);
  await P.ev('game.endFlyover()');
  await P.step(70);
  await P.until('!game.caddie.analysis && !game.powerJob && !game.caddie.reading', 400, 'the caddie to finish thinking');
  await P.step(5);
}

// every course's holes as the game has them (name, par, yards), read from the page
const readCourses = (P) => P.ev(`(()=>{ const out={}; for (const id of ['augusta','standrews','pebble','sawgrass']) { game.showcase(id); out[id]=game.world.course.holes.map((h)=>({name:h.name,par:h.par,yds:h.yds})); } game.showcase('augusta'); return out; })()`);

// the id of the coach card on screen (the guided hole's tip), else null
const COACH_CARD = `(()=>{ const t=game.ui.tutorial; return t&&t.cur&&!t.suspended&&t.el&&!t.el.classList.contains('hidden')?t.cur.id:null; })()`;

// A finished round as the game saves one (a snapshot with done:true), so the real summary and scorecard can be
// opened without playing it. deltas: per player, the score against par on each hole ('P' = picked up).
function doneSnapshot(courseHoles, { courseId, mode, holes, names, deltas, target = null, attempts = null, tees = 'middle', seed = 4242 }) {
  const rec = (idx, h, strokes, k, who) => {
    const d = strokes - h.par;
    const putts = Math.max(1, Math.min(4, 2 + (who + k) % 3 - 1 + (d > 1 ? 1 : 0)));
    const r2 = (x) => Math.round(x * 100) / 100;
    return {
      number: idx + 1, par: h.par, yards: h.yds, strokes, putts, fir: h.par === 3 ? null : (k + who) % 3 !== 1, gir: strokes - putts <= h.par - 2,
      penalties: d >= 2 && (k + who) % 2 === 0 ? 1 : 0,
      sg: { OTT: r2(-0.12 * d + 0.06 * (((k + who) % 3) - 1)), APP: r2(-0.28 * d + 0.05), ARG: r2(((k + who) % 4 - 1.5) * 0.08), PUTT: r2(-0.2 * d + 0.07 * ((who % 2) ? -1 : 1)) },
      shots: [],
    };
  };
  const players = names.map((_, who) => {
    const scores = [], stats = [];
    holes.forEach((idx, k) => {
      const h = courseHoles[idx], dl = deltas ? deltas[who][k] : 0;
      const picked = dl === 'P';
      const strokes = picked ? 12 : Math.max(1, h.par + dl);
      const s = { number: idx + 1, strokes };
      if (picked) s.pickedUp = true;
      scores.push(s);
      stats.push(rec(idx, h, strokes, k, who));
    });
    return { scores: attempts ? [] : scores, attempts: attempts ? attempts[who] : [], stats: { holes: attempts ? [] : stats, cur: null } };
  });
  return {
    v: 1, t: FIXED_NOW - 600000, i: holes.length - 1, p: 0, mid: null, done: true,
    opts: { courseId, holes, mode, seed, players: names.length > 1 || names[0] ? names : null, daily: null, solo: false, target, tees },
    players,
  };
}

// The specimen's in-page half (serialized into the page, so it cannot close over this module). The phases run in
// order on one page, each in its own evaluation so the coverage probe sees every intermediate DOM state:
//   menu     the ?perf readout and its copy box, the open "About this course" card
//   summary  every player tab of the summary, the blocks only a challenge summary has
//   hudA / hudB   the full and the essential HUD, lie variants, a long hole score
//   toastN / bannerN   one toast or banner of each kind
//   sc-under / sc-over / sc-multi   the scorecard for a single player under par, over par, and hot seat
//   panels   shot panel with the challenge strip, relief, settings, help, stats, pause, confirm, intro, caption
//   all      every dynamic body class on and every panel unhidden at once
function specimenFill(phase) {
  const g = window.game, ui = g.ui, b = document.body;
  const $ = (id) => document.getElementById(id);
  const one = (sel) => document.querySelector(sel);
  if (phase === 'menu') {
    const hud = document.createElement('button');
    hud.id = 'perfHud'; hud.type = 'button'; hud.textContent = '58 fps · 3 slow · high 1.0x · 142 calls';
    b.appendChild(hud);
    const dump = document.createElement('textarea');
    dump.id = 'perfDump'; dump.readOnly = true; dump.value = 'perf summary\nframes 600\nslow 3';
    b.appendChild(dump);
    const more = one('.cc-more');
    if (more) more.open = true;
    return true;
  }
  if (phase === 'summary') {
    const tabs = [...document.querySelectorAll('.sum-tabs button')];
    for (const t of tabs.slice().reverse()) t.click(); // each player's card in turn, the first player's last
    $('summary').insertAdjacentHTML('beforeend', '<div class="challenge-note won">Score to beat: <b>+2 (74)</b> – you beat it!</div><div class="challenge-note">Score to beat: <b>12.5 ft</b> – not this time.</div><div class="attempts"><span>Your balls</span><i>14 ft</i><i class="miss">✕</i><i>9 ft</i></div><div class="share-box" id="shareBox"><span>Copy this challenge link</span><input id="shareUrl" readonly aria-label="Challenge link" value="https://example.test/pure-strike-golf/#c=augusta.front.0-1-2-3-4-5-6-7-8.4242.m.38"></div>');
    return true;
  }
  if (phase === 'hudA' || phase === 'hudB') {
    const full = phase === 'hudA';
    b.classList.toggle('target-view', full);
    b.classList.add('touch', 'in-round');
    $('lieBox').dataset.lie = full ? 'deep' : 'splash';
    for (const l of document.querySelectorAll('.lie-line')) l.dataset.lie = full ? 'splash' : 'deep';
    $('hcScore').className = 'hc-score over';
    one('#touchControls .tc-swing').classList.add('down');
    g.flashShapeRow();
    return true;
  }
  if (phase.startsWith('toast')) {
    const kind = phase.slice(5);
    ui.toast('Sample toast ' + (kind || 'plain'), kind);
    if (kind === 'out') ui.toasts.lastChild.classList.add('out');
    return true;
  }
  if (phase.startsWith('banner')) { ui.banner('Sample banner', phase.slice(6), 600000); return true; }
  if (phase.startsWith('sc-')) {
    const ch = g.course.holes, holes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const names = phase === 'sc-multi' ? ['Sam', 'Bartholomew-Jay', 'Wolfgang Amadeus', 'Al'] : [null];
    const dl = { 'sc-under': [[-2, -1, 0, -1, 0, -1, 0, 0, -1, 0, -1, 0]], 'sc-over': [[1, 2, 1, 0, 3, 1, 2, 0, 1, 2, 1, 4]], 'sc-multi': [[-2, -1, 0, 1, 2, 3, 0, -1, 0, 1, 0, 0], [0, 1, 'P', 2, 0, 1, 1, 0, 2, 0, 1, 0], [-1, 0, 0, 3, 0, 0, 0, -2, 0, 1, 0, 'P'], [1, 1, 0, 0, 'P', 1, 0, 1, 0, 2, 0, 1]] }[phase];
    const round = {
      holes, tees: 'middle',
      players: names.map((name, w) => {
        const scores = holes.map((idx, k) => (dl[w][k] === 'P' ? { number: idx + 1, strokes: 12, pickedUp: true } : { number: idx + 1, strokes: Math.max(1, ch[idx].par + dl[w][k]) }));
        const strokes = scores.reduce((t, s) => t + s.strokes, 0), par = holes.reduce((t, idx) => t + ch[idx].par, 0);
        return { name, scores, stats: { totals: () => ({ strokes, par, putts: 30, fir: 7, firN: 12, gir: 8, penalties: 1, sg: { OTT: -1, APP: -2, ARG: 0.3, PUTT: -0.4 }, sgTotal: -3.1 }) } };
      }),
    };
    ui.scorecard(g.course, round, true, () => {}, 'Next hole');
    return true;
  }
  if (phase === 'panels') {
    const opts = [
      { title: 'Drop at the entry point', desc: 'Keep the pin in line behind the point where the ball crossed the hazard line.', es: 2.74, dist: 92, isTee: false, surface: 'fairway' },
      { title: 'Replay from the tee', desc: 'Go back to where you last played from and hit again.', es: 3.12, dist: 165, isTee: true, surface: 'tee' },
      { title: 'Drop on the far side', desc: 'Only when the ball last crossed the margin on the far side of the water.', es: 2.98, dist: 74, isTee: false, surface: 'rough' },
    ];
    ui.relief(opts, () => {}, (m) => Math.round(m) + ' yds');
    if (g.lastInfo) {
      g.showResult(g.lastInfo, g.lastSg, { title: 'Ball 2 of 5', label: '12 ft from the pin', best: '8.2 ft', isBest: false });
      g.showResult(g.lastInfo, g.lastSg, { title: 'Ball 3 of 5', label: '4.1 ft from the pin', best: '4.1 ft', isBest: true });
      const tips = one('#shotPanel .sp-tips');
      if (tips) tips.insertAdjacentHTML('beforeend', '<div class="tip"><b>Sample tip</b><p>The caddie explains the shot here.</p><details class="why"><summary>Why?</summary><p>The reason behind the tip, in a sentence or two.</p></details></div>');
    }
    ui.showSettings(true);
    const clash = one('.remap-row .seg');
    if (clash) clash.classList.add('on', 'clash');
    ui.showHelp(true);
    ui.showStats(true);
    ui.holeIntro(g.hole, g.course, '165 yds', '8 mph, into', 'Bo to play');
    ui.caption('[crowd roars]');
    ui.confirm({ title: 'Start a new round?', text: 'Your unfinished round will be replaced.', ok: 'Start new round', danger: true }, () => {});
    ui.loading(true, 'Hole 12 – Sample Hole');
    return true;
  }
  if (phase === 'pause') { if (!ui.paused) ui.togglePause(); return true; }
  if (phase === 'all') {
    for (const c of ['touch', 'in-round', 'flyover', 'sc-open', 'reduced-motion', 'shot-open', 'coaching', 'target-view']) b.classList.add(c);
    for (const id of ['menu', 'hud', 'caddie', 'pinTag', 'helpBar', 'ffHint', 'intro', 'shotPanel', 'relief', 'scorecard', 'pause', 'confirmBox', 'help', 'summary', 'settings', 'stats', 'editor', 'academy', 'loading', 'gfxLost']) {
      const e = $(id);
      if (e) e.classList.remove('hidden');
    }
    for (const e of document.querySelectorAll('#hud > .panel')) e.classList.add('tut-focus');
    $('perfHud').classList.add('slow');
    return true;
  }
  return false;
}

// 45 saved rounds over eight months, for the stats screen with a long history
function manyHistorySeed(n = 45) {
  const courses = ['augusta', 'standrews', 'pebble', 'sawgrass'], modes = ['18', 'front', '18', 'back', 'single'];
  const rounds = [];
  for (let i = 0; i < n; i++) {
    const mode = modes[i % modes.length], holes = { 18: 18, front: 9, back: 9, single: 1 }[mode], par = holes === 1 ? 4 : holes * 4;
    const over = Math.max(2, Math.round(((16 - i * 0.25 + (((i * 7) % 5) - 2)) * holes) / 18));
    const strokes = par + over, putts = Math.round(holes * (2.05 - i * 0.004));
    const r1 = (x) => Math.round(x * 10) / 10, sc = holes / 18, t = i / n;
    const sg = { OTT: r1((-2.1 + 1.6 * t) * sc), APP: r1((-4.2 + 2.2 * t) * sc), ARG: r1((-1.1 + 0.9 * t) * sc), PUTT: r1((-1.9 + 1.3 * t) * sc) };
    const d = new Date(Date.UTC(2026, 2, 1, 10, 0, 0) + i * 5 * 86400000);
    rounds.push({
      date: d.toISOString(), course: courses[i % 4], mode, holes, player: null, seed: 100 + holes, strokes, par, putts, penalties: i % 4 === 0 ? 2 : i % 3 === 0 ? 1 : 0,
      fir: Math.round(holes * 0.5 * (0.6 + t)), firN: Math.round(holes * 0.78), gir: Math.round(holes * 0.45 * (0.5 + t)), sg, sgTotal: r1(sg.OTT + sg.APP + sg.ARG + sg.PUTT),
      profile: 'mid', difficulty: 'standard', tees: i % 4 === 0 ? 'middle' : 'back',
    });
  }
  return { ...BASE_SEED(), 'psg-history': rounds };
}

const SCENARIOS = [
  {
    id: 'menu', seed: BASE_SEED(),
    states: ['menu', 'menu-drawer', 'settings', 'settings-bottom', 'help', 'stats-empty', 'academy-list', 'academy-lab', 'editor'],
    async run(S) {
      const { P } = S;
      await P.step(20);
      await S.cap('menu');
      await P.ev(`document.getElementById('menuDrawer').open = true`); await P.step(2);
      await S.cap('menu-drawer');
      await P.ev(`document.getElementById('menuDrawer').open = false`);
      await P.ev(`game.ui.showSettings(true)`); await P.step(2);
      await S.cap('settings');
      await P.ev(`(${scrollToEnd.toString()})('#settings')`);
      await S.cap('settings-bottom');
      await P.ev(`game.ui.showSettings(false)`);
      await P.ev(`game.ui.showHelp(true)`); await P.step(2);
      await S.cap('help');
      await P.ev(`game.ui.showHelp(false)`);
      await P.ev(`game.ui.showStats(true)`); await P.step(2);
      await S.cap('stats-empty');
      await P.ev(`game.ui.showStats(false)`);
      await P.ev(`game.ui.academy.open()`); await P.step(3);
      await S.cap('academy-list');
      await P.ev(`(()=>{ const n=document.querySelectorAll('#academy .ac-item').length; for(let i=0;i<n;i++){ document.querySelectorAll('#academy .ac-item')[i].click(); if(document.querySelector('#academy [data-p]')) break; } const p=document.querySelector('#academy [data-p]'); if(p) p.click(); const h=document.getElementById('labHit'); if(h) h.click(); return !!p; })()`);
      await P.step(3);
      await S.cap('academy-lab');
      await P.ev(`game.ui.academy.close()`);
      await P.ev(`game.ui.editor.open('augusta', 11)`); await P.step(5);
      await S.cap('editor');
      await P.ev(`game.ui.editor.close()`);
    },
  },
  {
    id: 'resume', seed: resumeSeed(), states: ['menu-resume'],
    async run(S) { await S.P.step(20); await S.cap('menu-resume'); },
  },
  {
    id: 'challenge', seed: BASE_SEED(), hash: '#c=augusta.single.11.27.m.74', states: ['menu-challenge'],
    async run(S) { await S.P.step(20); await S.cap('menu-challenge'); },
  },
  {
    id: 'history', seed: historySeed(), states: ['stats-filled'],
    async run(S) {
      await S.P.step(10);
      await S.P.ev(`game.ui.showStats(true)`); await S.P.step(3);
      await S.cap('stats-filled');
    },
  },
  {
    id: 'boot', seed: BASE_SEED(), noWebgl: true, expectBootError: true, states: ['boot-error'],
    async run(S) { await S.cap('boot-error'); },
  },
  {
    id: 'round', seed: BASE_SEED(),
    states: ['loading', 'hole-intro', 'address-essential', 'toast-banner', 'address-target-view', 'scorecard-peek', 'pause', 'confirm', 'swing-active', 'flight', 'result', 'result-open', 'address-putt', 'address-putt-target', 'address-putt-target-long', 'address-putt-target-short', 'relief', 'scorecard-final', 'summary'],
    async run(S) {
      const { P } = S;
      await P.step(10);
      // loading overlay: the hole builds on a 30 ms (virtual) timer, so right after begin() it is up
      await P.ev(`game.ui.begin(${JSON.stringify(ROUND_OPTS)})`);
      await S.cap('loading');
      await P.until('game.state==="flyover"', 30, 'the flyover to start');
      await P.step(45);
      await S.cap('hole-intro');
      await P.ev('game.endFlyover()');
      await P.step(70);
      await P.until('!game.caddie.analysis && !game.powerJob && !game.caddie.reading', 400, 'the caddie to finish thinking');
      await P.step(5);
      if (S.perfNow) await S.perfNow('address-essential');
      await S.cap('address-essential');
      // toast + banner (synthetic sample text, long enough to wrap on a phone)
      await P.ev(`(()=>{ game.ui.toast('Sample toast message'); game.ui.toast('A second, longer toast that may wrap onto two lines', 'bad'); game.ui.banner('Sample banner: Birdie', 'great', 600000); })()`);
      await P.step(2);
      await S.cap('toast-banner');
      await clearToasts(P);
      await P.ev('game.toggleTargetView()'); await P.step(10); await clearToasts(P);
      await S.cap('address-target-view');
      await P.ev('game.toggleTargetView()'); await P.step(10); await clearToasts(P);
      await P.ev('game.peekScorecard()'); await P.step(2);
      await S.cap('scorecard-peek');
      await P.ev('game.closeScorecardPeek()');
      await P.ev('game.ui.togglePause()'); await P.settle();
      await S.cap('pause');
      await P.ev(`document.getElementById('pQuit').click()`); await P.settle();
      await S.cap('confirm');
      await P.ev(`document.getElementById('cfNo').click()`); await P.settle();
      await P.ev(`document.getElementById('pResume').click()`); await P.settle();
      // the real swing
      await swingAtMarker(P, { mid: () => S.cap('swing-active') });
      await P.step(25);
      if (S.perfNow) await S.perfNow('flight');
      await S.cap('flight');
      await P.ev('game.skipFlight()');
      await P.until('game.state==="result" || game.state==="relief"', 400, 'the result');
      const next = await P.ev('game.resultNext');
      await P.step(5);
      await S.cap('result');
      await P.ev(`(document.querySelector('#shotPanel .sp-more')||{click(){}}).click()`); await P.step(2);
      await S.cap('result-open');
      let realRelief = false;
      if (next === 'water') {
        await P.ev('game.continueAfterResult()'); await P.step(3);
        await S.cap('relief'); realRelief = true;
        await P.ev(`document.querySelector('#relief .relief-opt').click()`);
        await P.step(70);
      } else if (next === 'holed') {
        await P.ev('game.continueAfterResult()'); await P.step(3);
      } else {
        await P.ev('game.continueAfterResult()'); await P.step(70);
      }
      let onGreen = await P.ev('game.state==="address" && !!game.club && !!game.club.putter');
      if (!onGreen && (await P.ev('game.state')) !== 'scorecard') { await teleportToGreen(P); S.note('address-putt: ball teleported beside the cup (the shot did not finish on the green)'); await P.step(70); onGreen = await P.ev('!!game.club.putter'); }
      if (onGreen) {
        await P.until('!game.caddie.analysis && !game.caddie.reading', 400, 'the putt read').catch(() => {});
        await P.step(10);
        await S.cap('address-putt');
        // the putting target view: at the read's length, then a long lag and a tap-in (ball moved along the line from the cup)
        await P.ev('game.toggleTargetView()'); await P.step(90); await clearToasts(P);
        await S.cap('address-putt-target');
        for (const [name, dx, dz] of [['address-putt-target-long', 7.5, 5.5], ['address-putt-target-short', 0.5, 0.4]]) {
          await teleportToGreen(P, dx, dz); await P.step(70);
          await P.until('!game.caddie.analysis && !game.caddie.reading', 400, 'the putt read').catch(() => {});
          if (!(await P.ev('!!game.club.putter'))) { S.miss(name, 'the teleported ball did not get the putter'); continue; }
          await P.ev('game.toggleTargetView()'); await P.step(120); await clearToasts(P);
          await S.cap(name);
        }
        await P.ev('game.toggleTargetView()'); await P.step(10);
      } else S.miss('address-putt', 'could not get the golfer to a putting address');
      if (!realRelief) {
        const ent = await P.ev(`(()=>{ const h=game.hole, c=h.cup; let best=null; for(let x=-700;x<=700;x+=5) for(let z=-700;z<=700;z+=5){ if(h.surface(x,z)==='water'){ const d=Math.hypot(x-c.x,z-c.z); if(!best||d<best.d) best={x,z,d}; } } return best; })()`);
        if (!ent) S.miss('relief', 'no water on this hole to build a relief entry from, and the shot did not go in the water');
        else {
          await P.ev(`(()=>{ game.pendingWater={entry:{x:${ent.x},z:${ent.z}}}; game.resultNext='water'; game.state='result'; game.continueAfterResult(); })()`);
          await P.step(3);
          await S.cap('relief');
          S.note('relief: synthetic water entry (real rules.reliefOptions + real dialog); the shot itself did not go in the water');
          await P.ev(`(()=>{ game.ui.relief(null); game.state='address'; game.resultNext=null; game.pendingWater=null; })()`);
        }
      }
      await P.ev(`(()=>{ game.strokes=3; game.finishHole(); })()`);
      await P.step(5);
      await S.cap('scorecard-final');
      await P.ev(`document.getElementById('scNext').click()`);
      await P.step(5);
      await S.cap('summary');
    },
  },
  {
    id: 'tutorial', seed: { 'psg-settings': { ffSeen: 3, tees: 'middle' }, 'psg-tips': { plays: 1 } },
    states: ['menu-firstrun', ...['flyover', 'distance', 'wind', 'club', 'aim', 'meter', 'relief', 'result', 'green', 'putt', 'again', 'holed'].map((s) => 'tutorial-step-' + s)],
    async run(S) {
      const { P } = S;
      await P.step(20);
      await S.cap('menu-firstrun');
      await P.ev('game.ui.tutorial.start()');
      const seen = new Set();
      let putts = 0;
      for (let it = 0; it < 90; it++) {
        const st = await P.ev(`(()=>{ const t=game.ui.tutorial; return { active: game.tutorial===t, id: t.cur&&t.cur.id, shown: !!(t.cur&&!t.suspended&&t.el&&!t.el.classList.contains('hidden')), state: game.state, next: game.resultNext }; })()`);
        if (!st.active) break;
        if (st.id && st.shown) {
          if (!seen.has(st.id)) { seen.add(st.id); await P.step(2); await S.cap('tutorial-step-' + st.id); }
          if (st.id === 'flyover') await P.ev('game.endFlyover()');
          else if (st.id === 'meter' || st.id === 'putt') { if (st.id === 'putt') putts++; await swingAtMarker(P); }
          else if (st.id === 'relief') await P.ev(`document.querySelector('#relief .relief-opt').click()`);
          else if (st.id === 'result') await P.ev('game.continueAfterResult()');
          else if (st.id === 'holed') { await P.ev(`game.ui.tutorial.advance(null)`); }
          else await P.ev('game.ui.tutorial.advance()');
          await P.step(70);
          continue;
        }
        if (st.state === 'flyover') { await P.step(40); continue; }
        if (st.state === 'flight') { await P.ev('game.skipFlight()'); await P.until('game.state==="result"||game.state==="relief"', 400); continue; }
        if (st.state === 'result') { await P.step(30); const again = await P.ev(`game.state==="result" && !game.ui.tutorial.cur`); if (again) await P.ev('game.continueAfterResult()'); await P.step(70); continue; }
        if (st.state === 'relief') { await P.ev(`document.querySelector('#relief .relief-opt').click()`); await P.step(70); continue; }
        if (st.state === 'address') {
          await P.until('!game.caddie.analysis && !game.powerJob && !game.caddie.reading', 400).catch(() => {});
          const putter = await P.ev('!!game.club.putter');
          if (putter && putts >= 3) { await teleportToGreen(P, 0.7, 0.5); putts = 0; S.note('tutorial: ball teleported to 1 m after missed putts so the final card can show'); await P.step(70); continue; }
          if (putter) putts++;
          await swingAtMarker(P); await P.step(5); continue;
        }
        await P.step(30);
      }
      for (const s of ['flyover', 'distance', 'wind', 'club', 'aim', 'meter', 'relief', 'result', 'green', 'putt', 'again', 'holed']) {
        if (!seen.has(s)) S.miss('tutorial-step-' + s, 'this coach mark never became active on the harness line of play (the lesson shows relief/again only when the ball finds water or misses the green)');
      }
    },
  },

  // ------------------------------------------------------------------ the extra scenarios (each is a fresh page load, after the originals above)
  {
    id: 'menu-extra', seed: BASE_SEED(),
    states: ['toast-over-dialog', 'big-root-font-20', 'big-root-font-32'],
    async run(S) {
      const { P } = S;
      await P.step(20);
      // toasts and a banner stack above an open dialog
      await P.ev(`game.ui.showSettings(true)`); await P.step(2);
      await P.ev(`(()=>{ game.ui.toast('Sample toast over a dialog'); game.ui.toast('A second, longer toast that wraps onto two lines on a phone', 'bad'); game.ui.toast('A third toast', 'good'); game.ui.banner('Sample banner over a dialog', 'great', 600000); })()`);
      await P.step(2);
      await S.cap('toast-over-dialog');
      await clearToasts(P);
      await P.ev(`game.ui.showSettings(false)`);
      // a browser whose default font size is 125% / 200%: the root font size, forced
      for (const px of [20, 32]) {
        await P.ev(`document.documentElement.style.setProperty('font-size','${px}px','important')`);
        await P.step(3);
        await S.cap('big-root-font-' + px);
      }
    },
  },
  {
    id: 'menu-setup', states: ['menu-setup-stress'],
    seed: { ...BASE_SEED(), 'psg-sel': { courseId: 'standrews', mode: 'single', hole: 17, players: 4, names: [LONG_NAME, 'Bo', LONG_NAME_2, 'Di'], about: true, drawer: true } },
    async run(S) { await S.P.step(20); await S.cap('menu-setup-stress'); },
  },
  ...[1.5, 0.8].map((k) => ({
    id: 'ui-scale-' + k, seed: { ...BASE_SEED(), 'psg-settings': { ffSeen: 3, tees: 'middle', uiScale: k } },
    states: [`ui-scale-${k}`, `ui-scale-${k}-settings`, `ui-scale-${k}-address`],
    async run(S) {
      const { P } = S, n = `ui-scale-${k}`;
      await P.step(20);
      await S.cap(n);
      await P.ev(`game.ui.showSettings(true)`); await P.step(2);
      await S.cap(n + '-settings');
      await P.ev(`game.ui.showSettings(false)`);
      await toAddress(P);
      await S.cap(n + '-address');
    },
  })),
  {
    id: 'history-many', seed: manyHistorySeed(45), states: ['stats-many', 'stats-many-bottom'],
    async run(S) {
      const { P } = S;
      await P.step(10);
      await P.ev(`game.ui.showStats(true)`); await P.step(3);
      await S.cap('stats-many');
      await P.ev(`(${scrollToEnd.toString()})('#stats')`);
      await S.cap('stats-many-bottom');
    },
  },
  {
    id: 'round-extra', seed: BASE_SEED(), states: ['address-target-view-input'],
    async run(S) {
      const { P } = S;
      await P.step(10);
      await toAddress(P);
      await clearToasts(P);
      // the button / key path (input.dispatch -> updateHUD(true)), not the game method the older state calls
      await P.ev(`game.input.dispatch('targetView')`); await P.step(10); await clearToasts(P);
      await S.cap('address-target-view-input');
    },
  },
  {
    // two players with 72-character names on the hole with the longest name of any course
    id: 'hole-name-stress', seed: BASE_SEED(),
    states: ['hole-name-stress', 'hole-name-stress-address', 'hole-name-stress-turn', 'hole-name-stress-scorecard', 'hole-name-stress-summary'],
    async run(S) {
      const { P } = S;
      await P.step(10);
      const courses = await readCourses(P);
      let pick = null;
      for (const [courseId, holes] of Object.entries(courses)) holes.forEach((h, idx) => { if (!pick || h.name.length > pick.name.length) pick = { courseId, idx, name: h.name }; });
      S.note(`hole-name-stress: longest hole name is "${pick.name}" (${pick.courseId} hole ${pick.idx + 1})`);
      await P.ev(`(()=>{ const s=game.ui.sel; s.players=2; s.names=[${JSON.stringify(LONG_NAME)},${JSON.stringify(LONG_NAME_2)},'Player 3','Player 4']; })()`);
      await P.ev(`game.ui.begin(${JSON.stringify({ courseId: pick.courseId, holes: [pick.idx], mode: 'single', seed: 27 })})`);
      await P.until('game.state==="flyover"', 30, 'the flyover to start');
      await P.step(45);
      await S.cap('hole-name-stress');
      await P.ev('game.endFlyover()');
      await P.step(70);
      await P.until('!game.caddie.analysis && !game.powerJob && !game.caddie.reading', 400, 'the caddie to finish thinking');
      await P.step(5);
      await clearToasts(P);
      await S.cap('hole-name-stress-address');
      // the first player holes out: a toast with their name and a banner naming the next player
      await P.ev(`(()=>{ game.strokes=4; game.finishHole(); })()`);
      await P.step(3);
      await S.cap('hole-name-stress-turn');
      await clearToasts(P);
      await P.until('game.state==="address"', 200, 'the second player to address');
      await P.ev(`(()=>{ game.strokes=6; game.finishHole(); })()`);
      await P.step(5);
      await S.cap('hole-name-stress-scorecard');
      await P.ev(`document.getElementById('scNext').click()`);
      await P.until('game.state==="summary"', 200, 'the summary');
      await P.step(3);
      await S.cap('hole-name-stress-summary');
    },
  },
  {
    // finished rounds opened from a saved snapshot (the real summary and scorecard, without playing the holes)
    id: 'summary-extra', seed: BASE_SEED(),
    states: ['summary-hotseat', 'scorecard-hotseat', 'summary-challenge', 'summary-share'],
    async run(S) {
      const { P } = S;
      await P.step(10);
      const courses = await readCourses(P);
      const aug = courses.augusta;
      const seat = doneSnapshot(aug, {
        courseId: 'augusta', mode: 'front', holes: [...Array(9).keys()], names: ['Sam', 'Bartholomew-Jay', 'Wolfgang Amadeus', 'Al'],
        deltas: [[0, -1, 0, 1, 0, -2, 0, 1, 0], [1, 1, 2, 0, 'P', 1, 0, 2, 1], [0, 0, -1, 0, 1, 0, 3, 0, 0], [2, 1, 0, 'P', 1, 0, 1, 0, 2]],
      });
      await P.ev(`game.startRound(null, ${JSON.stringify(seat)})`);
      await P.until('game.state==="summary"', 200, 'the hot-seat summary');
      await P.step(3);
      await S.cap('summary-hotseat');
      await P.ev(`document.getElementById('sumCardBtn').click()`); await P.step(3);
      await S.cap('scorecard-hotseat');
      // closest to the pin, two players, five balls each (one wet), against a score to beat
      let hole = -1;
      aug.forEach((h, i) => { if (h.par === 3 && (hole < 0 || h.yds < aug[hole].yds)) hole = i; });
      const ctp = doneSnapshot(aug, { courseId: 'augusta', mode: 'ctp', holes: [hole], names: ['Sam', 'Alexandria'], attempts: [[14.2, null, 5.2, 23.5, 31], [null, null, 19.4, null, 12.8]], target: 74 });
      await P.ev(`game.startRound(null, ${JSON.stringify(ctp)})`);
      await P.until('game.state==="summary" && !document.getElementById("summary").classList.contains("hidden")', 200, 'the challenge summary');
      await P.step(3);
      await S.cap('summary-challenge');
      // the clipboard write is refused (as in an insecure context or an embedded browser), so the link shows in the share box
      // instead; whether headless Chrome allows the write varies by machine, so it is forced to fail
      await P.ev(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true })`);
      await P.ev(`document.getElementById('sumShare').click()`);
      await P.step(5);
      // the link carries the harness server's random port: show the public origin instead so the capture is repeatable
      const box = await P.ev(`(()=>{ const i=document.getElementById('shareUrl'); if(!i) return false; i.value=i.value.replace(location.origin+location.pathname,'https://acolyer13.github.io/pure-strike-golf/'); i.select(); return true; })()`);
      if (!box) S.note('summary-share: the share box did not appear after the forced clipboard failure');
      await S.cap('summary-share');
    },
  },
  {
    // the guided hole's relief / not-on-yet / hole-complete cards, driven by the real tutorial: every wait is
    // "step frames until the card is up", never a fixed number of frames
    id: 'tutorial-extra', seed: { 'psg-settings': { ffSeen: 3, tees: 'middle' }, 'psg-tips': { plays: 1 } },
    states: ['tutorial-step-relief', 'tutorial-step-again', 'tutorial-step-holed'],
    async run(S) {
      const { P } = S;
      const card = (id, max = 1500) => P.until(`(${COACH_CARD})===${JSON.stringify(id)}`, max, `the "${id}" coach card`);
      const idle = () => P.until('!game.caddie.analysis && !game.powerJob && !game.caddie.reading', 600, 'the caddie to finish thinking').catch(() => {});
      await P.step(20);
      await P.ev('game.ui.tutorial.start()');
      await card('flyover');
      await P.ev('game.endFlyover()');
      for (const id of ['distance', 'wind', 'club', 'aim']) { await card(id); await P.ev('game.ui.tutorial.advance()'); }
      await card('meter');
      await idle();
      // aim at the water: the aim nearest the pin line whose full-power-at-the-marker flight ends in the penalty area
      const water = await P.ev(`(()=>{ const g=game, a0=g.aim, pw=g.suggestedPower||1; let best=null; for (let k=-60;k<=60;k++){ const a=a0+k*0.02; const o=g.caddie.simOutcome(g.club,a,{power:pw,withWind:true,dt:1/90}); if(o.result==='water'&&(!best||Math.abs(k)<best.k)) best={a,k}; } if(best) g.setAim(best.a); return best; })()`);
      if (!water) S.note('tutorial-extra: no aim ends in the water from this tee, so the relief card is reached through a synthetic water entry');
      await P.step(2);
      await swingAtMarker(P);
      await P.ev('game.skipFlight()');
      await P.until('game.state==="result"||game.state==="relief"', 800, 'the result');
      if ((await P.ev('game.resultNext')) !== 'water') {
        if (!(await P.ev('game.state==="relief"'))) {
          const ent = await P.ev(`(()=>{ const h=game.hole, c=h.cup; let best=null; for(let x=-700;x<=700;x+=5) for(let z=-700;z<=700;z+=5){ if(h.surface(x,z)==='water'){ const d=Math.hypot(x-c.x,z-c.z); if(!best||d<best.d) best={x,z,d}; } } return best; })()`);
          if (ent) { await P.ev(`(()=>{ game.pendingWater={entry:{x:${ent.x},z:${ent.z}}}; game.resultNext='water'; game.state='result'; })()`); S.note('tutorial-extra: the swing did not end in the water; a synthetic water entry was set'); }
        }
      }
      if (await P.ev('game.state==="result"')) await P.ev('game.continueAfterResult()');
      await card('relief');
      await S.cap('tutorial-step-relief');
      await P.ev(`document.querySelector('#relief .relief-opt').click()`);
      await P.until('game.state==="address"', 900, 'the drop to finish');
      await idle();
      await card('again');
      await S.cap('tutorial-step-again');
      if (!S.need('tutorial-step-holed')) return;
      // on to the green: a few inches from the cup so a marker-power putt drops
      await P.ev('game.ui.tutorial.advance()');
      for (let k = 0; k < 4; k++) {
        await teleportToGreen(P, 0.7, 0.5);
        await P.until('game.state==="address"', 300, 'the putting address');
        await idle();
        await swingAtMarker(P);
        await P.ev('game.skipFlight()');
        await P.until('game.state==="result"', 900, 'the putt result');
        if (await P.ev('game.resultNext==="holed"')) { await card('holed', 600); await S.cap('tutorial-step-holed'); return; }
        await P.ev('game.continueAfterResult()');
      }
      S.miss('tutorial-step-holed', 'four putts from a few inches did not drop');
    },
  },
  {
    // the boot screen while the game module is held back, and the "couldn't load" version of it
    id: 'boot-held', seed: BASE_SEED(), holdBoot: true, states: ['boot'],
    async run(S) { await S.cap('boot'); },
  },
  {
    id: 'boot-failed', seed: BASE_SEED(), failBoot: true, states: ['boot-load-failed'],
    async run(S) { await S.cap('boot-load-failed'); },
  },
  {
    // every dynamic body class and every panel on at once, with sample content wherever the game only fills a panel
    // at run time, so the stylesheet rules no ordinary state reaches still render (see specimenFill)
    id: 'specimen', states: ['specimen'],
    seed: { ...historySeed(), 'psg-sel': { courseId: 'augusta', mode: 'single', hole: 12, players: 2, names: [LONG_NAME, 'Bo', 'Player 3', 'Player 4'], about: true, drawer: true } },
    async run(S) {
      const { P } = S;
      const fill = (ph) => P.ev(`(${specimenFill.toString()})(${JSON.stringify(ph)})`);
      await P.step(20);
      await fill('menu');
      // a finished hot-seat round, for the summary's tabs and leaderboard
      const courses = await readCourses(P);
      const seat = doneSnapshot(courses.augusta, {
        courseId: 'augusta', mode: 'front', holes: [...Array(9).keys()], names: ['Sam', 'Bartholomew-Jay', 'Wolfgang Amadeus', 'Al'],
        deltas: [[0, -1, 0, 1, 0, -2, 0, 1, 0], [1, 1, 2, 0, 'P', 1, 0, 2, 1], [0, 0, -1, 0, 1, 0, 3, 0, 0], [2, 1, 0, 'P', 1, 0, 1, 0, 2]],
      });
      await P.ev(`game.startRound(null, ${JSON.stringify(seat)})`);
      await P.until('game.state==="summary"', 200, 'the hot-seat summary');
      await P.step(3);
      await fill('summary');
      // a real round with the two seeded players, one real shot, then the result (or the water)
      await toAddress(P);
      await fill('hudA'); await P.step(1);
      await fill('hudB');
      await swingAtMarker(P);
      await P.step(25);
      await P.ev('game.skipFlight()');
      await P.until('game.state==="result"||game.state==="relief"', 400, 'the result');
      await P.step(5);
      for (const ph of ['toast', 'toastgood', 'toastbad', 'toastout', 'bannergood', 'bannerbad', 'bannergreat', 'sc-under', 'sc-over', 'sc-multi', 'panels', 'hudA', 'hudB', 'pause', 'all']) await fill(ph);
      await S.cap('specimen');
    },
  },
];
// the layout-relevant states added after the first release of this tool (all of them; they are what widens the oracle)
const CORE_EXTRA_STATES = [
  'specimen', 'ui-scale-1.5', 'ui-scale-1.5-settings', 'ui-scale-1.5-address', 'ui-scale-0.8', 'ui-scale-0.8-settings', 'ui-scale-0.8-address',
  'toast-over-dialog', 'address-target-view-input', 'boot', 'boot-load-failed', 'hole-name-stress', 'hole-name-stress-address', 'hole-name-stress-turn',
  'hole-name-stress-scorecard', 'hole-name-stress-summary', 'menu-setup-stress', 'big-root-font-20', 'big-root-font-32', 'summary-hotseat', 'scorecard-hotseat',
  'summary-challenge', 'summary-share', 'stats-many', 'stats-many-bottom',
];
const ALL_STATES = (() => {
  const seen = new Map();
  for (const s of SCENARIOS) for (const n of s.states) { if (!seen.has(n)) seen.set(n, { state: n, scenario: s.id }); else seen.get(n).scenario += ',' + s.id; }
  return [...seen.values()];
})();
// --states presets.
//   layout = the states whose LAYOUT matters (what a refactor of the stylesheet or the UI code can move): every screen and
//   dialog, the HUD at its three detail levels, the swing/flight/result/putt/relief states, the tutorial cards, and the
//   stress and variant states. It leaves out the cosmetic duplicates (settings-bottom, toast-banner, ...).
//   core = 13 states that between them reach every region of the UI at every size; small enough for the ~40-viewport edge set.
//   The specimen state (every dynamic body class on, every panel unhidden) is what makes a short list safe: it renders the
//   stylesheet rules that no ordinary state reaches.
const LAYOUT_STATES = [
  'menu', 'menu-drawer', 'settings', 'help', 'stats-filled', 'academy-list', 'editor', 'hole-intro', 'address-essential', 'address-target-view',
  'swing-active', 'flight', 'result', 'result-open', 'address-putt', 'relief', 'pause', 'confirm', 'scorecard-final', 'summary', 'tutorial-step-*',
  ...CORE_EXTRA_STATES,
];
const CORE_STATES = [
  'menu', 'menu-drawer', 'settings', 'stats-filled', 'hole-intro', 'address-essential', 'address-target-view',
  'flight', 'result-open', 'pause', 'scorecard-final', 'specimen',
];
const STATE_PRESETS = { core: CORE_STATES, layout: LAYOUT_STATES };

const matcher = (pats) => {
  if (!pats) return () => true;
  const res = pats.map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
  return (name) => res.some((r) => r.test(name));
};

// ---------------------------------------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  if (o.listViewports) { for (const n of listViewports(o)) console.log(n); return; }
  if (o.states) o.states = o.states.flatMap((p) => (STATE_PRESETS[p] ? STATE_PRESETS[p] : [p]));
  if (o.listStates) { const w = matcher(o.states); for (const s of ALL_STATES) if (w(s.state)) console.log(`${s.state.padEnd(28)} [${s.scenario}]`); return; }
  if (o.perf && !o.states) o.states = ['address-essential', 'flight'];
  const want = matcher(o.states);
  if (o.injectCss) o.injectCssText = fs.readFileSync(o.injectCss, 'utf8');
  const viewports = resolveViewports(o).map(parseViewport);
  fs.mkdirSync(o.out, { recursive: true });
  const base = await startServer(o);
  console.log(`game at ${base}`);

  let chrome = await startChrome(o, !!o.software);
  const glProbe = `(()=>{ const c=document.createElement('canvas'); const g=c.getContext('webgl2')||c.getContext('webgl'); if(!g) return null; const e=g.getExtension('WEBGL_debug_renderer_info'); return e? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'webgl'; })()`;
  const probe = async (ch) => { const r = await ch.cdp.send('Runtime.evaluate', { expression: glProbe, returnByValue: true }); return r.result.value; };
  let renderer = await probe(chrome);
  let software = !!o.software;
  if (!renderer && !software) {
    console.log('no WebGL on the real GPU path; relaunching Chrome with SwiftShader');
    chrome.cdp.close(); killTree(chrome.rec.pid); procs.delete(chrome.rec);
    await sleep(1000);
    software = true;
    chrome = await startChrome(o, true);
    renderer = await probe(chrome);
  }
  console.log(`Chrome ${chrome.version}; WebGL: ${renderer || 'NONE'}${software ? ' (software)' : ''}`);

  const manifest = { tool: 'tools/shots.mjs', generated: new Date().toISOString(), chrome: chrome.version, webgl: renderer, software, base, args: process.argv.slice(2), deterministic: !o.live, fixedNow: new Date(FIXED_NOW).toISOString(), flatFill: FLAT, captures: [], missing: [], notes: [] };
  const perfOut = [];
  const save = () => fs.writeFileSync(path.join(o.out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const P = new Pg(chrome.cdp, o, null, null, base);
  await P.init();

  for (const vp of viewports) {
    for (const scheme of o.scheme) {
      await P.setViewport(vp, scheme);
      const dir = path.join(o.out, vp.name, scheme);
      fs.mkdirSync(dir, { recursive: true });
      const vpInfo = { name: vp.name, w: vp.w, h: vp.h, dpr: vp.dpr, touch: vp.touch };
      if (vp.insets) vpInfo.insets = vp.insets;
      console.log(`\n== ${vp.name} ${vp.w}x${vp.h}@${vp.dpr}${vp.touch ? ' touch' : ''}${vp.insets ? ' safe-area ' + JSON.stringify(vp.insets) : ''} ${scheme}`);
      // a state can be listed by more than one scenario (a later one fills what an earlier one could not reach):
      // once captured it is never captured again, and a MISSING entry for it is withdrawn
      const captured = new Set();
      for (const sc of SCENARIOS) {
        const mine = sc.states.filter((s) => want(s) && !captured.has(s));
        if (!mine.length) continue;
        const done = new Set();
        const dropMissing = (state) => { manifest.missing = manifest.missing.filter((m) => !(m.viewport === vp.name && m.scheme === scheme && m.state === state)); };
        const S = {
          P,
          need: (state) => sc.states.includes(state) && want(state) && !done.has(state) && !captured.has(state), // would cap(state) capture it?
          note(t) { const m = `${vp.name}/${scheme}: ${t}`; if (!manifest.notes.includes(m)) manifest.notes.push(m); },
          miss(state, reason) { if (done.has(state) || captured.has(state)) return; done.add(state); dropMissing(state); manifest.missing.push({ viewport: vp.name, scheme, state, reason }); console.log(`  - ${state}: MISSING (${reason})`); },
          async cap(state) {
            if (!sc.states.includes(state) || !want(state) || done.has(state) || captured.has(state)) return;
            done.add(state);
            try { await capture(P, o, vp, vpInfo, scheme, dir, state, manifest); captured.add(state); dropMissing(state); console.log(`  + ${state}`); } catch (e) { dropMissing(state); manifest.missing.push({ viewport: vp.name, scheme, state, reason: 'capture failed: ' + e.message.split('\n')[0] }); console.log(`  - ${state}: capture failed: ${e.message.split('\n')[0]}`); }
          },
          async perfNow(which) {
            if (!o.perf) return;
            try { perfOut.push(await perfProbe(chrome.cdp, P, o, vpInfo, scheme, which)); console.log(`  ~ perf ${which}`); } catch (e) { manifest.notes.push(`perf ${which} failed on ${vp.name}: ${e.message.split('\n')[0]}`); }
          },
        };
        let st;
        try {
          st = await P.load(sc);
          const expect = sc.holdBoot ? 'held' : sc.failBoot ? 'failed' : sc.expectBootError ? 'error' : 'ok';
          if (st.boot !== expect) throw new Error(`boot ${st.boot} (expected ${expect})`);
          if (P.touchForced) S.note('body.touch was not set by touch emulation alone; forced with game.input.showTouch(true)');
          P.touchForced = false;
          await sc.run(S);
        } catch (e) {
          console.log(`  ! scenario ${sc.id}: ${e.message.split('\n')[0]}`);
          for (const s of mine) if (!done.has(s)) S.miss(s, `scenario "${sc.id}" stopped before this state: ${e.message.split('\n')[0].slice(0, 220)}`);
          if (P.cdp.closed) throw e;
        } finally {
          if (P.held) await P.releaseBoot().catch(() => {}); // never leave the game module paused
        }
        for (const s of mine) if (!done.has(s)) S.miss(s, `scenario "${sc.id}" finished without reaching this state`);
        save();
      }
    }
  }
  manifest.states = { captured: [...new Set(manifest.captures.map((c) => c.state))], missing: [...new Set(manifest.missing.map((m) => m.state))] };
  save();
  if (o.perf) fs.writeFileSync(path.join(o.out, 'perf.json'), JSON.stringify({ frames: o.perfFrames, note: 'synchronous game.debugStep frames; CPU/JS side only', results: perfOut }, null, 1));
  console.log(`\n${manifest.captures.length} captures, ${manifest.missing.length} missing -> ${path.join(o.out, 'manifest.json')}`);
  P.cdp.close();
}

async function capture(P, o, vp, vpInfo, scheme, dir, state, manifest) {
  const c = P.cdp;
  P.errors.length = 0;
  await P.ev(`document.fonts.ready.then(()=>true)`);
  await P.settle(50);
  // keyboard modality so :focus-visible behaves like keyboard navigation (ScrollLock is bound to nothing)
  try {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ScrollLock', code: 'ScrollLock', windowsVirtualKeyCode: 145 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ScrollLock', code: 'ScrollLock', windowsVirtualKeyCode: 145 });
  } catch (e) { /* ignore */ }
  const m = await P.ev(`(${measurePage.toString()})(${JSON.stringify({ flat: FLAT, focus: true, scheme })})`);
  // the original keys keep their order; the wider metrics follow pageErrors
  const extra = {};
  for (const k of WIDER_METRICS) { extra[k] = m[k]; delete m[k]; }
  const metrics = { viewport: vpInfo, scheme, state, ...m, pageErrors: P.errors.slice(0, 10).concat((await P.ev('window.__psgErrors||[]')).slice(0, 5)), ...extra };
  const stem = path.join(dir, state);
  const rel = (p) => path.relative(o.out, p).split(path.sep).join('/');
  let fpFile = null;
  if (o.fingerprint) {
    const fp = await P.ev(`(${fingerprintPage.toString()})()`);
    fpFile = rel(stem + '.fp.json');
    fs.writeFileSync(stem + '.fp.json', fingerprintJson({ viewport: vpInfo, scheme, state }, fp));
  }
  let file = null, flatFile = null;
  if (o.shots) {
    await P.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`);
    // the first capture after a style change can be taken mid-raster (progressively rendered blurred shadows), so take two and keep the second
    const grab = async () => Buffer.from((await c.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })).data, 'base64');
    const shot = async () => { await grab(); await P.settle(120); return grab(); };
    await P.settle(40);
    fs.writeFileSync(stem + '.png', await shot());
    file = rel(stem + '.png');
    if (o.flat) {
      await P.ev(`(()=>{ let s=document.getElementById('__psgFlat'); if(!s){ s=document.createElement('style'); s.id='__psgFlat'; document.head.appendChild(s);} s.textContent='canvas#c,canvas#swingOverlay{visibility:hidden!important}html,body{background:rgb(${FLAT.join(',')})!important}'; return true; })()`);
      await P.settle(40);
      fs.writeFileSync(stem + '.flat.png', await shot());
      await P.ev(`(()=>{ const s=document.getElementById('__psgFlat'); if(s) s.remove(); return true; })()`);
      flatFile = rel(stem + '.flat.png');
    }
  }
  fs.writeFileSync(stem + '.json', JSON.stringify(metrics, null, 1));
  const entry = { file, flatFile, metricsFile: rel(stem + '.json'), viewport: vpInfo, scheme, state };
  if (fpFile) entry.fingerprintFile = fpFile;
  manifest.captures.push(entry);
}

// the metrics added after the first release of this tool (appended to every JSON, after pageErrors)
const WIDER_METRICS = ['schemeCheck', 'tapAll', 'focusableAll', 'under12', 'distinct', 'dialogFits', 'accentUse', 'canvasText', 'insideSafeArea', 'contrastUnparsed'];

// <state>.fp.json: a header, then one line per node (key -> row of dictionary indexes) so a diff of two files is readable
function fingerprintJson(head, fp) {
  const out = [];
  out.push('{"v":1,"viewport":' + JSON.stringify(head.viewport) + ',"scheme":' + JSON.stringify(head.scheme) + ',"state":' + JSON.stringify(head.state));
  out.push(',"props":' + JSON.stringify(fp.props));
  out.push(',"dict":' + JSON.stringify(fp.dict));
  out.push(',"cls":' + JSON.stringify(fp.cls));
  out.push(',"nodes":{\n' + fp.rows.map(([k, row]) => JSON.stringify(k) + ':' + JSON.stringify(row)).join(',\n') + '\n}}\n');
  return out.join('\n');
}

async function perfProbe(c, P, o, vpInfo, scheme, which) {
  const get = async () => {
    const r = await c.send('Performance.getMetrics');
    const m = {};
    for (const x of r.metrics) m[x.name] = x.value;
    const heap = await c.send('Runtime.getHeapUsage').catch(() => null);
    return { m, heap };
  };
  let layers = null;
  const onLayers = (p) => { layers = (p.layers || []).length; };
  try { c.listen('LayerTree.layerTreeDidChange', onLayers); await c.send('LayerTree.enable'); } catch (e) { /* optional */ }
  await P.settle(100);
  const a = await get();
  const n = o.perfFrames;
  const t0 = Date.now();
  // chunks of 10 frames: V8 time is only attributed to ScriptDuration at the end of each CDP-evaluated task
  for (let done = 0; done < n; done += 10) await P.ev(`game.debugStep(${Math.min(10, n - done)}, 1/60)`, 300000);
  const wall = Date.now() - t0;
  const b = await get();
  await P.settle(150);
  try { await c.send('LayerTree.disable'); } catch (e) { /* ignore */ }
  const d = (k) => (b.m[k] ?? 0) - (a.m[k] ?? 0);
  const out = {
    state: which, viewport: vpInfo, scheme, frames: n, wallMs: wall, wallMsPerFrame: Math.round((wall / n) * 100) / 100,
    delta: { LayoutCount: d('LayoutCount'), RecalcStyleCount: d('RecalcStyleCount'), LayoutDurationMs: Math.round(d('LayoutDuration') * 1e5) / 100, RecalcStyleDurationMs: Math.round(d('RecalcStyleDuration') * 1e5) / 100, ScriptDurationMs: Math.round(d('ScriptDuration') * 1e5) / 100, TaskDurationMs: Math.round(d('TaskDuration') * 1e5) / 100, Nodes: d('Nodes'), JSEventListeners: d('JSEventListeners') },
    perFrame: { LayoutCount: Math.round((d('LayoutCount') / n) * 1000) / 1000, RecalcStyleCount: Math.round((d('RecalcStyleCount') / n) * 1000) / 1000, ScriptMs: Math.round((d('ScriptDuration') / n) * 1e5) / 100, TaskMs: Math.round((d('TaskDuration') / n) * 1e5) / 100 },
    after: { Nodes: b.m.Nodes, JSEventListeners: b.m.JSEventListeners, LayoutObjects: b.m.LayoutObjects, JSHeapUsedMB: b.m.JSHeapUsedSize ? Math.round(b.m.JSHeapUsedSize / 1048576 * 10) / 10 : null, heapUsageMB: b.heap ? Math.round(b.heap.usedSize / 1048576 * 10) / 10 : null, layers },
    gameStateAfter: await P.ev('game.state'),
  };
  return out;
}

main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error('\nshots: ' + (e && e.stack ? e.stack : e)); cleanup(); process.exit(1); });
