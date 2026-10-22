#!/usr/bin/env node
// shots-diff.mjs - compare two tools/shots.mjs output directories (zero dependencies).
//
// USAGE
//   node tools/shots-diff.mjs <dirA> <dirB> [options]
//
//   A is the baseline ("before"), B the candidate ("after"). Captures are matched by
//   viewport name + colour scheme + state using each directory's manifest.json.
//
// OPTIONS
//   --threshold <N>      per-channel tolerance, 0-255 (default 0). A pixel is "changed" when any of its R, G, B, A
//                        channels differs by more than N. 0 = bit-exact.
//   --expect-identical   exit with status 1 if any compared flat image has a changed pixel, a size mismatch, or a
//                        capture is present in only one directory (use for determinism checks / pure refactors)
//   --max-changed <pct>  exit with status 1 if any flat image changes more than pct percent of its pixels
//   --images <which>     flat (default) | full | both: which PNG set to compare. "flat" is the DOM/CSS-only
//                        variant, immune to 3D-scene noise; "full" includes the canvas.
//   --out <dir>          where diff PNGs and diff.json are written (default <dirB>/_diff)
//   --no-png             do not write diff PNGs
//   --states <list>      only these states (comma list, * wildcards)
//   --viewport <list>    only these viewport names
//   --scheme <s>         only dark or light
//   --json               print the summary as JSON instead of a table
//   --fingerprint        also compare the computed-style fingerprints written by `shots.mjs --fingerprint`
//                        (<state>.fp.json): every property of every element present in BOTH captures (elements are keyed
//                        by their nearest ancestor id plus tag index, never by class) must match. Changes are reported
//                        grouped by (property, old -> new) with the number of elements and a sample. With
//                        --expect-identical a changed property on a shared element fails the run, and so does a capture
//                        that has no fingerprint on either side. Elements present in only one capture are counted and
//                        listed but do not fail the run (a refactor may add a node); add --fp-strict to fail on them too.
//   --fp-props <list>    compare only these computed properties (camelCase names, e.g. color,backgroundColor)
//   --fp-ignore <list>   skip these computed properties
//   --fp-strict          elements present in only one capture also fail --expect-identical
//   --fp-detail <n>      change groups printed per capture (default 6; the JSON always carries all of them)
//   --help
//
// DIFF PNG  changed pixels are painted red over a dimmed greyscale copy of A; size mismatches are not drawn.
//
// REPORTED PER CAPTURE
//   changed pixels / total and percent, bounding box of the change, and for the metrics files (see shots.mjs):
//   chromeCoverage (and Bottom45), overlaps.count, tap targets under 44 CSS px (in view, not inert/disabled),
//   smallest font size and number of text elements under 12px, contrast failures (WCAG AA), offscreen partial
//   count, horizontal scroll, heavy features (backdrop-filter / blurred shadows) and DOM nodes. Rows are printed
//   only when something moved. The summary line gives totals and the worst changes. With --fingerprint each row also
//   reports changed computed properties (count, elements, grouped samples) and elements only in A / only in B.
//
// EXIT STATUS  0 ok; 1 when --expect-identical / --max-changed is violated; 2 for usage or I/O errors.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------------------------- PNG
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, depth = 0, ct = 0, interlace = 0, plte = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  if (depth !== 8 && !(depth < 8 && ct === 3)) throw new Error(`unsupported PNG depth ${depth}`);
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!chans) throw new Error(`unsupported PNG colour type ${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (chans * depth) >> 3), stride = Math.ceil((w * chans * depth) / 8);
  const px = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  // normalise to RGBA8
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, i = y * stride;
      let r, g, b, a = 255;
      if (ct === 6) { const k = i + x * 4; r = px[k]; g = px[k + 1]; b = px[k + 2]; a = px[k + 3]; }
      else if (ct === 2) { const k = i + x * 3; r = px[k]; g = px[k + 1]; b = px[k + 2]; }
      else if (ct === 0) { r = g = b = px[i + x]; }
      else if (ct === 4) { r = g = b = px[i + x * 2]; a = px[i + x * 2 + 1]; }
      else {
        const bits = (px[i + ((x * depth) >> 3)] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
        r = plte[bits * 3]; g = plte[bits * 3 + 1]; b = plte[bits * 3 + 2]; if (trns && bits < trns.length) a = trns[bits];
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return { w, h, data: out };
}

function encodePng(w, h, rgba) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------------------------- args
const HELP = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0].split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
function parseArgs(argv) {
  const o = { threshold: 0, images: 'flat', png: true, dirs: [] };
  const need = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--threshold') o.threshold = +need(i++);
    else if (a === '--expect-identical') o.identical = true;
    else if (a === '--max-changed') o.maxChanged = +need(i++);
    else if (a === '--images') { o.images = need(i++); if (!['flat', 'full', 'both'].includes(o.images)) throw new Error('--images flat|full|both'); }
    else if (a === '--out') o.out = path.resolve(need(i++));
    else if (a === '--no-png') o.png = false;
    else if (a === '--states') o.states = need(i++).split(',').filter(Boolean);
    else if (a === '--viewport') o.viewport = need(i++).split(',').filter(Boolean);
    else if (a === '--scheme') o.scheme = need(i++);
    else if (a === '--json') o.json = true;
    else if (a === '--fingerprint') o.fingerprint = true;
    else if (a === '--fp-props') o.fpProps = need(i++).split(',').filter(Boolean);
    else if (a === '--fp-ignore') o.fpIgnore = need(i++).split(',').filter(Boolean);
    else if (a === '--fp-strict') o.fpStrict = true;
    else if (a === '--fp-detail') o.fpDetail = +need(i++);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a} (try --help)`);
    else o.dirs.push(path.resolve(a));
  }
  if (Number.isNaN(o.threshold) || o.threshold < 0) throw new Error('--threshold must be a number >= 0');
  if (o.fpDetail === undefined) o.fpDetail = 6;
  if (Number.isNaN(o.fpDetail) || o.fpDetail < 0) throw new Error('--fp-detail must be a number >= 0');
  if ((o.fpProps || o.fpIgnore || o.fpStrict) && !o.fingerprint) throw new Error('--fp-props / --fp-ignore / --fp-strict need --fingerprint');
  return o;
}
const wild = (pats) => { if (!pats) return () => true; const res = pats.map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')); return (n) => res.some((r) => r.test(n)); };

// ---------------------------------------------------------------------------------------------- compare
const key = (c) => `${c.viewport.name}/${c.scheme}/${c.state}`;
function loadManifest(dir) {
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) throw new Error(`no manifest.json in ${dir}`);
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { dir, m, map: new Map(m.captures.map((c) => [key(c), c])) };
}
const readJson = (dir, rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch (e) { return null; } };

function metricsOf(j) {
  if (!j) return null;
  const sm = j.fontCensus || {};
  return {
    chromeCoverage: j.chromeCoverage, chromeCoverageBottom45: j.chromeCoverageBottom45, chromeCoverageSolid: j.chromeCoverageSolid,
    overlaps: j.overlaps ? j.overlaps.count : null,
    tapUnder44: j.tapTargets ? j.tapTargets.under44InView : null,
    tightGaps: j.tapTargets ? j.tapTargets.tightGapInView : null,
    smallestFont: sm.minSize ?? null, fontUnder12: sm.under12 ?? null,
    contrastFailures: j.contrast ? j.contrast.failures : null,
    sceneRisk: j.contrast ? j.contrast.sceneRisk : null,
    offscreen: j.offscreen ? j.offscreen.partialCount + j.offscreen.fullyCount : null,
    hScroll: j.hScroll ? (j.hScroll.any ? 1 : 0) : null,
    backdropFilter: j.heavy ? j.heavy.backdropFilter.visible : null,
    blurShadow: j.heavy ? j.heavy.blurShadow.visible : null,
    domNodes: j.domNodes,
  };
}

// ---------------------------------------------------------------------------------------------- fingerprints
// <state>.fp.json (written by shots.mjs --fingerprint): { props:[name...], dict:[[distinct values per prop]...], cls:{key:"tag.class"},
// nodes:{key:[dictionary index per prop]} }. Indexes are local to a file, so values are compared as strings.
function loadFp(dir, c) {
  if (!c.fingerprintFile) return null;
  const j = readJson(dir, c.fingerprintFile);
  return j && j.props && j.dict && j.nodes ? j : null;
}
function diffFp(fa, fb, o) {
  const inB = new Map(fb.props.map((p, i) => [p, i]));
  const props = [];
  fa.props.forEach((p, i) => { if (inB.has(p) && (!o.fpProps || o.fpProps.includes(p)) && !(o.fpIgnore && o.fpIgnore.includes(p))) props.push([p, i, inB.get(p)]); });
  const onlyA = [], onlyB = [], groups = new Map(), changedNodes = new Set();
  let changedProps = 0, shared = 0;
  for (const k of Object.keys(fa.nodes)) {
    const rb = fb.nodes[k];
    if (!rb) { onlyA.push(k); continue; }
    shared++;
    const ra = fa.nodes[k];
    for (const [p, ia, ib] of props) {
      const va = fa.dict[ia][ra[ia]], vb = fb.dict[ib][rb[ib]];
      if (va === vb) continue;
      changedProps++; changedNodes.add(k);
      const gk = p + '\u0000' + va + '\u0000' + vb;
      let g = groups.get(gk);
      if (!g) { g = { prop: p, a: va, b: vb, nodes: [] }; groups.set(gk, g); }
      g.nodes.push(k);
    }
  }
  for (const k of Object.keys(fb.nodes)) if (!fa.nodes[k]) onlyB.push(k);
  const named = (k) => `${k}${(fa.cls && fa.cls[k]) || (fb.cls && fb.cls[k]) ? ' (' + ((fa.cls && fa.cls[k]) || fb.cls[k]) + ')' : ''}`;
  return {
    shared, changedProps, changedNodes: changedNodes.size, onlyA: onlyA.length, onlyB: onlyB.length,
    onlyAList: onlyA.slice(0, 30).map(named), onlyBList: onlyB.slice(0, 30).map(named),
    groups: [...groups.values()].sort((x, y) => y.nodes.length - x.nodes.length).map((g) => ({ prop: g.prop, a: g.a, b: g.b, count: g.nodes.length, sample: g.nodes.slice(0, 4).map(named) })),
  };
}
const shortVal = (s, n = 60) => { s = String(s); return s.length > n ? s.slice(0, n - 3) + '...' : s; };

function diffImages(fa, fb, thr, wantPng) {
  const A = decodePng(fs.readFileSync(fa)), B = decodePng(fs.readFileSync(fb));
  if (A.w !== B.w || A.h !== B.h) return { sizeMismatch: true, a: `${A.w}x${A.h}`, b: `${B.w}x${B.h}`, changed: Math.max(A.w * A.h, B.w * B.h), total: Math.max(A.w * A.h, B.w * B.h), pct: 100 };
  const n = A.w * A.h;
  let changed = 0, x0 = A.w, y0 = A.h, x1 = -1, y1 = -1;
  const out = wantPng ? Buffer.alloc(n * 4) : null;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(A.data[o] - B.data[o]), Math.abs(A.data[o + 1] - B.data[o + 1]), Math.abs(A.data[o + 2] - B.data[o + 2]), Math.abs(A.data[o + 3] - B.data[o + 3]));
    const diff = d > thr;
    if (diff) { changed++; const x = i % A.w, y = (i / A.w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (out) {
      if (diff) { out[o] = 255; out[o + 1] = 30; out[o + 2] = 60; out[o + 3] = 255; }
      else { const g = Math.round((0.3 * A.data[o] + 0.59 * A.data[o + 1] + 0.11 * A.data[o + 2]) * 0.35 + 40); out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
    }
  }
  return { changed, total: n, pct: Math.round((changed / n) * 1e6) / 1e4, bbox: changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null, size: `${A.w}x${A.h}`, png: out ? encodePng(A.w, A.h, out) : null };
}

function fpLines(fp, o) {
  if (!fp) return [];
  if (fp.missing) return [`   fingerprint: MISSING in ${fp.missing === 'both' ? 'A and B' : fp.missing}`];
  if (!fp.changedProps && !fp.onlyA && !fp.onlyB) return [];
  const out = [`   fingerprint: ${fp.changedProps} changed propert${fp.changedProps === 1 ? 'y' : 'ies'} on ${fp.changedNodes} of ${fp.shared} shared elements; ${fp.onlyB} only in B, ${fp.onlyA} only in A`];
  for (const g of fp.groups.slice(0, o.fpDetail)) out.push(`     ${g.prop}: ${shortVal(g.a)} -> ${shortVal(g.b)}  x${g.count}  e.g. ${g.sample.slice(0, 2).join('; ')}`);
  if (fp.groups.length > o.fpDetail) out.push(`     ... ${fp.groups.length - o.fpDetail} more change group(s)`);
  if (fp.onlyB) out.push(`     only in B: ${fp.onlyBList.slice(0, 4).join('; ')}${fp.onlyB > 4 ? ' ...' : ''}`);
  if (fp.onlyA) out.push(`     only in A: ${fp.onlyAList.slice(0, 4).join('; ')}${fp.onlyA > 4 ? ' ...' : ''}`);
  return out;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }
  if (o.dirs.length !== 2) throw new Error('need exactly two directories: shots-diff.mjs <dirA> <dirB> (try --help)');
  const [A, B] = o.dirs.map(loadManifest);
  const outDir = o.out || path.join(B.dir, '_diff');
  const inState = wild(o.states), inVp = o.viewport ? (n) => o.viewport.includes(n) : () => true;
  const keys = new Set([...A.map.keys(), ...B.map.keys()]);
  const kinds = o.images === 'both' ? ['flat', 'full'] : [o.images];
  const rows = [], onlyA = [], onlyB = [];
  let worst = 0, anyChanged = false, anyProblem = false, compared = 0, identical = 0;
  const fpt = { compared: 0, changedCaptures: 0, changedProps: 0, changedNodes: 0, onlyInB: 0, onlyInA: 0, missing: [] };
  for (const k of [...keys].sort()) {
    const ca = A.map.get(k), cb = B.map.get(k), c = ca || cb;
    if (!inState(c.state) || !inVp(c.viewport.name) || (o.scheme && c.scheme !== o.scheme)) continue;
    if (!ca) { onlyB.push(k); continue; }
    if (!cb) { onlyA.push(k); continue; }
    const row = { key: k, viewport: c.viewport.name, scheme: c.scheme, state: c.state, images: {}, metrics: {} };
    for (const kind of kinds) {
      const ra = kind === 'flat' ? ca.flatFile : ca.file, rb = kind === 'flat' ? cb.flatFile : cb.file;
      if (!ra || !rb || !fs.existsSync(path.join(A.dir, ra)) || !fs.existsSync(path.join(B.dir, rb))) { row.images[kind] = { missing: true }; continue; }
      const d = diffImages(path.join(A.dir, ra), path.join(B.dir, rb), o.threshold, o.png);
      compared++;
      if (d.changed === 0) identical++; else { anyChanged = true; worst = Math.max(worst, d.pct); }
      if (d.png) {
        const f = path.join(outDir, c.viewport.name, c.scheme, `${c.state}${kind === 'flat' ? '.flat' : ''}.diff.png`);
        if (d.changed > 0) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d.png); d.diffFile = path.relative(outDir, f).split(path.sep).join('/'); }
        else { try { fs.rmSync(f); } catch (e) { /* none */ } }
      }
      delete d.png;
      row.images[kind] = d;
    }
    const ma = metricsOf(readJson(A.dir, ca.metricsFile)), mb = metricsOf(readJson(B.dir, cb.metricsFile));
    if (ma && mb) for (const m of Object.keys(ma)) if (ma[m] !== mb[m]) row.metrics[m] = { a: ma[m], b: mb[m] };
    if (o.fingerprint) {
      const fa = loadFp(A.dir, ca), fb = loadFp(B.dir, cb);
      if (!fa || !fb) { row.fp = { missing: !fa && !fb ? 'both' : !fa ? 'A' : 'B' }; fpt.missing.push(k); }
      else {
        row.fp = diffFp(fa, fb, o);
        fpt.compared++;
        if (row.fp.changedProps) { fpt.changedCaptures++; fpt.changedProps += row.fp.changedProps; fpt.changedNodes += row.fp.changedNodes; }
        fpt.onlyInB += row.fp.onlyB; fpt.onlyInA += row.fp.onlyA;
      }
    }
    rows.push(row);
  }
  const sizeBad = rows.some((r) => Object.values(r.images).some((i) => i.sizeMismatch || i.missing));
  const summary = {
    a: A.dir, b: B.dir, threshold: o.threshold, images: o.images, compared, identical, changed: compared - identical, worstPct: worst,
    onlyInA: onlyA, onlyInB: onlyB, ...(o.fingerprint ? { fingerprint: fpt } : {}), rows,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'diff.json'), JSON.stringify(summary, null, 1));

  if (o.json) console.log(JSON.stringify(summary, null, 1));
  else {
    console.log(`A: ${A.dir}\nB: ${B.dir}\nthreshold ${o.threshold}, images: ${o.images}\n`);
    for (const r of rows) {
      const parts = [];
      for (const [kind, d] of Object.entries(r.images)) {
        if (d.missing) parts.push(`${kind}: missing image`);
        else if (d.sizeMismatch) parts.push(`${kind}: SIZE ${d.a} -> ${d.b}`);
        else parts.push(`${kind}: ${d.changed === 0 ? '0 changed' : `${d.changed}/${d.total} px = ${d.pct}%${d.bbox ? ` bbox ${d.bbox.x},${d.bbox.y} ${d.bbox.w}x${d.bbox.h}` : ''}`}`);
      }
      const mt = Object.entries(r.metrics).map(([m, v]) => `${m} ${v.a} -> ${v.b}`);
      const fpl = fpLines(r.fp, o);
      if (Object.values(r.images).every((d) => !d.missing && !d.sizeMismatch && d.changed === 0) && !mt.length && !fpl.length) continue;
      console.log(`${r.key}\n   ${parts.join(' | ')}${mt.length ? '\n   metrics: ' + mt.join('; ') : ''}${fpl.length ? '\n' + fpl.join('\n') : ''}`);
    }
    if (onlyA.length) console.log(`\nonly in A (${onlyA.length}): ${onlyA.slice(0, 12).join(', ')}${onlyA.length > 12 ? ' ...' : ''}`);
    if (onlyB.length) console.log(`\nonly in B (${onlyB.length}): ${onlyB.slice(0, 12).join(', ')}${onlyB.length > 12 ? ' ...' : ''}`);
    console.log(`\n${compared} image(s) compared, ${identical} identical, ${compared - identical} changed (worst ${worst}%). Diff output: ${outDir}`);
    if (o.fingerprint) console.log(`fingerprints: ${fpt.compared} compared, ${fpt.changedCaptures} changed (${fpt.changedProps} properties on ${fpt.changedNodes} elements), ${fpt.onlyInB} elements only in B, ${fpt.onlyInA} only in A, ${fpt.missing.length} missing${fpt.missing.length ? ': ' + fpt.missing.slice(0, 6).join(', ') + (fpt.missing.length > 6 ? ' ...' : '') : ''}`);
  }
  const fpBad = o.fingerprint && (fpt.changedCaptures > 0 || fpt.missing.length > 0 || (o.fpStrict && (fpt.onlyInA > 0 || fpt.onlyInB > 0)));
  if (o.identical && (anyChanged || sizeBad || onlyA.length || onlyB.length || compared === 0 || fpBad)) {
    console.error(`FAIL: --expect-identical${fpBad ? ' (fingerprint: ' + fpt.changedCaptures + ' capture(s) with changed properties, ' + fpt.missing.length + ' without a fingerprint' + (o.fpStrict ? ', ' + (fpt.onlyInA + fpt.onlyInB) + ' unmatched elements' : '') + ')' : ''}`);
    anyProblem = true;
  }
  if (o.maxChanged !== undefined && worst > o.maxChanged) { console.error(`FAIL: worst change ${worst}% > ${o.maxChanged}%`); anyProblem = true; }
  return anyProblem ? 1 : 0;
}

try { process.exitCode = main(); } catch (e) { console.error('shots-diff: ' + e.message); process.exitCode = 2; }
