// Bundles src/main.js (with the vendored three.js) into one minified file, dist/game.js.
// The game is ~50 ES modules; fetched one by one, each waits on its importer, so a slow or
// high-latency connection pays a round trip per level of the import graph. One file is one request.
// The bundle is committed (like vendor/), so GitHub Pages and start.bat need no build step.
//
//   node tools/bundle.mjs          rebuild dist/game.js and stamp the service worker's cache version
//   node tools/bundle.mjs --check  exit 1 if dist/game.js or the stamp is out of date with src/ and vendor/
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(root, 'dist/game.js');

// build in memory; the same options serve the dev server, the check and the written file
export async function bundle() {
  const r = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    // the import map in older builds of index.html did this at run time
    alias: { three: './vendor/three/build/three.module.js', 'three/addons': './vendor/three/addons' },
    write: false,
    outfile: 'dist/game.js',
    logLevel: 'warning',
  });
  return Buffer.from(r.outputFiles[0].contents);
}

// The service worker's cache name is a hash of everything it caches that we build or edit by
// hand, so a change to the bundle, page, styles or worker itself can't ship under an old name.
export const SW = path.join(root, 'sw.js');
const VERSION_LINE = /^const VERSION = '[^']*';$/m;
export function swVersion(out) {
  const read = (f) => lf(fs.readFileSync(path.join(root, f)));
  const h = createHash('sha256').update(lf(out)).update(read('index.html')).update(read('styles.css'))
    .update(read('sw.js').replace(VERSION_LINE, '')).digest('hex').slice(0, 8);
  return `psg-${h}`;
}
export function stampedSw(out) {
  return fs.readFileSync(SW, 'utf8').replace(VERSION_LINE, `const VERSION = '${swVersion(out)}';`);
}

// git may check the file out with CRLF on Windows; the bundle is the same either way
const lf = (b) => b.toString('utf8').replace(/\r\n/g, '\n');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await bundle();
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUT) || lf(fs.readFileSync(OUT)) !== lf(out)) {
      console.error('dist/game.js is out of date: run npm run bundle');
      process.exit(1);
    }
    if (lf(fs.readFileSync(SW)) !== lf(stampedSw(out))) {
      console.error('sw.js cache version is out of date: run npm run bundle');
      process.exit(1);
    }
    console.log('dist/game.js and the sw.js cache version are current');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, out);
    fs.writeFileSync(SW, stampedSw(out));
    console.log(`wrote dist/game.js (${(out.length / 1024).toFixed(0)} kB), cache ${swVersion(out)}`);
  }
}
