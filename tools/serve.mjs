// Tiny zero-dependency static file server: node tools/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = +(process.argv[2] || process.env.PORT || 8321);
const TEXT = /^(text|application\/(json|manifest))/;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.webmanifest': 'application/manifest+json' };

// With dev dependencies installed, /dist/game.js is rebuilt from src/ on every request, so edits show
// on reload with no build step. Without them (a plain download) the committed bundle is served.
let rebuild = null;
try { rebuild = (await import('./bundle.mjs')).bundle; } catch (e) { /* esbuild not installed */ }

http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/dist/game.js' && rebuild) {
    try {
      const data = await rebuild();
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
      return;
    } catch (e) { console.error(e.message); }
  }
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const type = types[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': TEXT.test(type) ? type + '; charset=utf-8' : type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(port, () => console.log(`Pure Strike Golf running at http://localhost:${port}`));
