// Serves the built web client. Hashed files under /assets/ never change, so
// browsers and Cloudflare may keep them for a year; everything else (index.html,
// theme.js, …) is revalidated with an ETag so a deploy is picked up immediately
// but an unchanged file costs a 304 instead of a download. Text files are sent
// brotli- or gzip-compressed; compressed bodies are cached in memory per file.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.webmanifest']);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';
// index.html (and any other .html shell) gets the strongest possible directive:
// a plain ETag-revalidated `no-cache` is enough for desktop/Android browsers,
// but iOS Safari's cache for a standalone/home-screen web app has been observed
// to keep serving a stale top-level navigation response without revalidating it
// (issue #311) — the app shell then never fetches the JS bundle that carries
// the current Logo. `no-store` forbids caching the response at all, so there is
// nothing for that cache to serve stale. src/stale-shell-guard.ts is the
// belt-and-suspenders fix for caches that ignore this header too.
const NO_STORE = 'no-store';

function createStaticFiles(root) {
  const cache = new Map();

  function entry(filePath) {
    const stat = fs.statSync(filePath);
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const body = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const next = {
      mtimeMs: stat.mtimeMs, size: stat.size, body, ext,
      etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
      encoded: {},
    };
    if (COMPRESSIBLE.has(ext) && body.length > 1024) {
      next.encoded.br = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
      next.encoded.gzip = zlib.gzipSync(body, { level: 9 });
    }
    cache.set(filePath, next);
    return next;
  }

  function encodingFor(req, file) {
    const accepted = new Set();
    for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
      const [name, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
      const q = params.find((p) => p.startsWith('q='));
      if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name);
    }
    const allowed = (name) => accepted.has(name);
    if (file.encoded.br && allowed('br')) return 'br';
    if (file.encoded.gzip && allowed('gzip')) return 'gzip';
    return null;
  }

  // Resolves a URL path to a file under root, or null. Never escapes root.
  function resolve(urlPath) {
    const filePath = path.normalize(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
    // path.sep suffix check: a bare startsWith(root) would also accept a
    // sibling directory like `${root}-evil`.
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return { forbidden: true };
    try { if (fs.statSync(filePath).isFile()) return { filePath }; } catch { /* missing */ }
    return null;
  }

  function send(req, res, filePath, urlPath) {
    const file = entry(filePath);
    const hashed = urlPath.startsWith('/assets/');
    const encoding = encodingFor(req, file);
    // version.json is polled by src/stale-shell-guard.ts to detect a stale
    // shell; it must never be served from any cache (client, CDN, or a proxy
    // in between), or the check it powers becomes meaningless.
    const cacheControl = hashed ? IMMUTABLE : (file.ext === '.html' || urlPath === '/version.json') ? NO_STORE : REVALIDATE;
    const headers = {
      'Content-Type': TYPES[file.ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: encoding ? `${file.etag.slice(0, -1)}-${encoding}"` : file.etag,
    };
    if (Object.keys(file.encoded).length) headers.Vary = 'Accept-Encoding';
    const tags = String(req.headers['if-none-match'] || '').split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (tags.includes(headers.ETag) || tags.includes('*')) {
      res.writeHead(304, headers);
      return res.end();
    }
    const body = encoding ? file.encoded[encoding] : file.body;
    if (encoding) headers['Content-Encoding'] = encoding;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // Compress everything once in the background so the first visitor after a
  // restart does not wait for brotli.
  function warm() {
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.isFile()) entry(full);
      }
    };
    setImmediate(() => { try { walk(root); } catch { /* served lazily instead */ } });
  }

  return { resolve, send, warm };
}

module.exports = { createStaticFiles };
