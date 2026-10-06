// Copies the pinned three.js build, the addons the game imports (plus everything
// they import, recursively) and the Barlow web fonts from node_modules into the
// repo, so the deployed site has no runtime dependency on a CDN or Google Fonts.
//
//   node tools/vendor.mjs          copy (overwrites vendor/three and fonts/)
//   node tools/vendor.mjs --check  exit 1 if the vendored files differ from node_modules
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const check = process.argv.includes('--check');

// addon entry points, relative to three/examples/jsm
const ADDONS = [
  'objects/Sky.js',
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/ShaderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/GTAOPass.js',
  'postprocessing/OutputPass.js',
];
const FONTS = [
  ['@fontsource/barlow', 'barlow-latin', [400, 500, 600, 700, 800]],
  ['@fontsource/barlow-condensed', 'barlow-condensed-latin', [600, 700, 800]],
];

/** Walks relative `import ... from './x.js'` statements from each entry. */
function collectAddons() {
  const base = path.join(nm, 'three/examples/jsm');
  const seen = new Set();
  const queue = [...ADDONS];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(path.join(base, rel), 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  }
  return [...seen].sort();
}

function plan() {
  const files = [
    ['three/build/three.module.js', 'vendor/three/build/three.module.js'],
    ['three/LICENSE', 'vendor/three/LICENSE'],
  ];
  for (const rel of collectAddons()) files.push([`three/examples/jsm/${rel}`, `vendor/three/addons/${rel}`]);
  for (const [pkg, stem, weights] of FONTS) {
    for (const w of weights) files.push([`${pkg}/files/${stem}-${w}-normal.woff2`, `fonts/${stem}-${w}-normal.woff2`]);
    files.push([`${pkg}/LICENSE`, `fonts/${stem.replace('-latin', '')}-LICENSE`]);
  }
  return files;
}

const files = plan();
if (!fs.existsSync(path.join(nm, 'three/package.json'))) {
  console.error('node_modules/three is missing: run `npm install` first');
  process.exit(2);
}
let changed = 0;
for (const [from, to] of files) {
  const src = fs.readFileSync(path.join(nm, from));
  const dst = path.join(root, to);
  const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(src);
  if (same) continue;
  changed++;
  if (check) { console.log(`differs: ${to}`); continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, src);
  console.log(`copied ${to}`);
}
// stray addons that are no longer imported would silently rot
const want = new Set(files.map(([, to]) => to.replace(/\\/g, '/')));
const addonDir = path.join(root, 'vendor/three/addons');
if (fs.existsSync(addonDir)) {
  for (const f of fs.readdirSync(addonDir, { recursive: true })) {
    const rel = `vendor/three/addons/${String(f).replace(/\\/g, '/')}`;
    if (fs.statSync(path.join(root, rel)).isFile() && !want.has(rel)) {
      changed++;
      if (check) console.log(`stale: ${rel}`);
      else { fs.unlinkSync(path.join(root, rel)); console.log(`removed ${rel}`); }
    }
  }
}
const ver = JSON.parse(fs.readFileSync(path.join(nm, 'three/package.json'), 'utf8')).version;
if (check) {
  console.log(changed ? `${changed} vendored file(s) out of date with three@${ver}: run npm run vendor` : `vendored files match three@${ver} (${files.length} files)`);
  process.exit(changed ? 1 : 0);
}
console.log(`${changed ? changed + ' file(s) updated' : 'already up to date'} (three@${ver}, ${files.length} files)`);
