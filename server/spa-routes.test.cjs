'use strict';
// #359: the static fallback serves index.html for the client's own places (so a shared link, a
// reload or Back/Forward to /c/<id> opens the app there) without swallowing anything else: /api/*,
// build assets, WebDAV-looking paths and unknown paths keep their JSON 404, traversal stays 403.
// Built from the real static-files.cjs over a synthetic build directory; the server never boots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isClientRoute, createStaticFallback } = require('./spa-routes.cjs');
const { createStaticFiles } = require('./static-files.cjs');
const { json } = require('./http.cjs');

const INDEX = '<!doctype html><title>synthetic shell</title><div id="root"></div>';
function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-spa-'));
  fs.writeFileSync(path.join(root, 'index.html'), INDEX);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log("synthetic")');
  fs.writeFileSync(path.join(root, 'theme.js'), '/* synthetic */');
  return root;
}

function call(serve, pathname) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false, status: 0, headers: {}, body: '',
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; this.headersSent = true; },
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { this.body = body === undefined ? '' : String(body); resolve(this); },
    };
    serve({ method: 'GET', headers: {} }, res, pathname);
  });
}

test('client places get index.html, uncached', async () => {
  const root = build();
  const serve = createStaticFallback({ staticFiles: createStaticFiles(root), indexFile: path.join(root, 'index.html'), json });
  for (const p of ['/', '/c/c-1727000000000-abc', '/p/proj-1', '/p/proj-1/sources', '/p/proj-1/new', '/settings/appearance',
    '/customise/skills', '/models', '/models/org%2Fmodel.gguf', '/diary', '/archived', '/code', '/projects', '/chat', '/settings']) {
    const res = await call(serve, p);
    assert.equal(res.status, 200, p);
    assert.equal(res.body, INDEX, p);
    assert.equal(res.headers['Cache-Control'], 'no-store', `${p}: the shell must never be cached (#311)`);
  }
});

test('assets, API paths, DAV-looking and unknown paths are untouched', async () => {
  const root = build();
  const serve = createStaticFallback({ staticFiles: createStaticFiles(root), indexFile: path.join(root, 'index.html'), json });
  const asset = await call(serve, '/assets/index-abc123.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'console.log("synthetic")');
  assert.match(asset.headers['Cache-Control'], /immutable/);
  assert.equal((await call(serve, '/theme.js')).body, '/* synthetic */');
  for (const p of ['/assets/missing-999.js', '/api/nope', '/api/chats/c-1/history', '/api', '/remote.php/dav/files/x',
    '/dav/files/x', '/.well-known/caldav', '/nope', '/c/a/b', '/c/<x>', '/p/proj-1/unknown', '/settings/a/b', '/favicon.ico']) {
    const res = await call(serve, p);
    assert.equal(res.status, 404, p);
    assert.match(res.headers['Content-Type'], /application\/json/, p);
    assert.equal(JSON.parse(res.body).error, 'not found', p);
  }
});

test('traversal out of the build directory stays forbidden', async () => {
  const root = build();
  const serve = createStaticFallback({ staticFiles: createStaticFiles(root), indexFile: path.join(root, 'index.html'), json });
  const res = await call(serve, '/../../etc/passwd');
  assert.equal(res.status, 403);
});

test('isClientRoute: narrow on purpose', () => {
  for (const p of ['/', '/c/abc', '/c/abc/', '/p/a_b-1', '/p/x/code', '/settings/notifications', '/customize/connectors', '/models/x%20y']) {
    assert.equal(isClientRoute(p), true, p);
  }
  for (const p of ['/api/', '/api/workspace', '/assets/x.js', '//evil.example', '/\\evil', '/c/' + 'a'.repeat(121), '/models/a/b',
    '/settings/UPPER', null, undefined, 42, '/' + 'x'.repeat(800)]) {
    assert.equal(isClientRoute(p), false, String(p));
  }
});
