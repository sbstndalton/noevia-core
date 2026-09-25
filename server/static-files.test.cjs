const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createStaticFiles } = require('./static-files.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-static-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>' + 'x'.repeat(2000));
  fs.writeFileSync(path.join(root, 'assets', 'index-abc.js'), 'console.log(1);'.repeat(400));
  fs.writeFileSync(path.join(root, 'assets', 'tiny.css'), 'a{}');
  fs.writeFileSync(path.join(root, 'assets', 'font.woff2'), Buffer.alloc(4000, 7));
  fs.mkdirSync(root + '-evil');
  fs.writeFileSync(path.join(root + '-evil', 'secret.txt'), 'nope');
  return root;
}

function call(files, urlPath, headers = {}, method = 'GET') {
  const found = files.resolve(urlPath);
  const res = { status: 0, headers: {}, body: null,
    writeHead(status, h) { this.status = status; this.headers = h; },
    end(body) { this.body = body === undefined ? null : body; } };
  files.send({ method, headers }, res, found.filePath, urlPath);
  return res;
}

test('hashed assets are immutable and compressed for clients that accept it', () => {
  const root = fixture();
  const files = createStaticFiles(root);
  const br = call(files, '/assets/index-abc.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal(br.headers['Content-Encoding'], 'br');
  assert.equal(br.headers.Vary, 'Accept-Encoding');
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), 'console.log(1);'.repeat(400));
  const gz = call(files, '/assets/index-abc.js', { 'accept-encoding': 'gzip, br;q=0' });
  assert.equal(gz.headers['Content-Encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gz.body).toString(), 'console.log(1);'.repeat(400));
  const plain = call(files, '/assets/index-abc.js');
  assert.equal(plain.headers['Content-Encoding'], undefined);
  assert.equal(plain.body.toString(), 'console.log(1);'.repeat(400));
  assert.notEqual(br.headers.ETag, plain.headers.ETag);
});

test('small and binary files are sent as they are', () => {
  const files = createStaticFiles(fixture());
  assert.equal(call(files, '/assets/tiny.css', { 'accept-encoding': 'br' }).headers['Content-Encoding'], undefined);
  const font = call(files, '/assets/font.woff2', { 'accept-encoding': 'br' });
  assert.equal(font.headers['Content-Encoding'], undefined);
  assert.equal(font.headers['Content-Type'], 'font/woff2');
});

test('index.html is never cached (iOS standalone apps do not reliably revalidate) but still answers 304 for an in-flight conditional request', () => {
  const root = fixture();
  const files = createStaticFiles(root);
  const first = call(files, '/', { 'accept-encoding': 'br' });
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.match(first.headers['Content-Type'], /^text\/html/);
  const again = call(files, '/', { 'accept-encoding': 'br', 'if-none-match': first.headers.ETag });
  assert.equal(again.status, 304);
  assert.equal(again.body, null);
  // A deploy changes the file, so the old tag no longer matches.
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>' + 'y'.repeat(2100));
  const changed = call(files, '/', { 'accept-encoding': 'br', 'if-none-match': first.headers.ETag });
  assert.equal(changed.status, 200);
  assert.match(zlib.brotliDecompressSync(changed.body).toString(), /y{2100}/);
});

test('version.json is never cached, so the stale-shell guard always sees the current build', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'version.json'), '{"version":"1.2.3"}');
  const files = createStaticFiles(root);
  const res = call(files, '/version.json');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Content-Type'], 'application/json');
});

test('HEAD sends headers only', () => {
  const files = createStaticFiles(fixture());
  const head = call(files, '/assets/index-abc.js', { 'accept-encoding': 'br' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.ok(head.headers['Content-Length'] > 0);
});

test('paths cannot leave the build directory', () => {
  const root = fixture();
  const files = createStaticFiles(root);
  assert.deepEqual(files.resolve('/../' + path.basename(root) + '-evil/secret.txt'), { forbidden: true });
  assert.deepEqual(files.resolve('/../../etc/passwd'), { forbidden: true });
  assert.equal(files.resolve('/missing.js'), null);
  assert.equal(files.resolve('/assets'), null);
});
