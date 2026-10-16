// Bundles src/main.js (with the vendored three.js) into one minified file, dist/game.js.
// The game is ~50 ES modules; fetched one by one, each waits on its importer, so a slow or
// high-latency connection pays a round trip per level of the import graph. One file is one request.
// The bundle is committed (like vendor/), so GitHub Pages and start.bat need no build step.
//
//   node tools/bundle.mjs          rebuild dist/game.js
//   node tools/bundle.mjs --check  exit 1 if dist/game.js is out of date with src/ and vendor/
import fs from 'node:fs';
import path from 'node:path';
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

// git may check the file out with CRLF on Windows; the bundle is the same either way
const lf = (b) => b.toString('utf8').replace(/\r\n/g, '\n');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await bundle();
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUT) || lf(fs.readFileSync(OUT)) !== lf(out)) {
      console.error('dist/game.js is out of date: run npm run bundle');
      process.exit(1);
    }
    console.log('dist/game.js is current');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, out);
    console.log(`wrote dist/game.js (${(out.length / 1024).toFixed(0)} kB)`);
  }
}
