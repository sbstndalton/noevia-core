'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { rewriteHtml, rewriteJson } = require('./model-loader-proxy.cjs');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-model-loader-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
process.env.LEGACY_AUTH_COMPAT = 'false';
process.env.PUBLIC_ORIGIN = 'http://localhost';

// Synthetic Model Loader upstream.
const seen = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === '/config') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<a href="/models">Models</a><form hx-post="/config/section/a/save"><input name="model" value="/models/foo.gguf"></form><script src="/_vendor/htmx.min.js"></script><script>fetch(\'/palette.json\')</script><a href="https://huggingface.co/x">hf</a>'); }
    if (req.url === '/palette.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"items":[{"url":"/config/section/a/edit","label":"/models/foo.gguf"}]}'); }
    if (req.url === '/config/section/a/save') { res.writeHead(200, { 'HX-Redirect': '/config?saved=a' }); return res.end(''); }
    if (req.url === '/redirect') { res.writeHead(303, { Location: `http://127.0.0.1:${upstream.address().port}/config?edit=a` }); return res.end(); }
    if (req.url === '/bin') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4' }); return res.end(Buffer.from([0, 1, 2, 255])); }
    res.writeHead(404); res.end();
  });
});

let handleRequest, admin, member;
async function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...headers } });
  const chunks = [], responseHeaders = {};
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.statusCode = 200; res.headersSent = false;
  res.setHeader = (name, value) => { responseHeaders[name.toLowerCase()] = value; };
  res.writeHead = (status, next = {}) => { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(next)) responseHeaders[k.toLowerCase()] = v; return res; };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handleRequest(req, res);
  await finished;
  return { status: res.statusCode, headers: responseHeaders, body: Buffer.concat(chunks) };
}
const session = r => { const body = JSON.parse(r.body.toString()); return { cookie: r.headers['set-cookie'].map(c => c.split(';')[0]).join('; '), csrf: body.csrfToken }; };

test.before(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.MODEL_LOADER_URL = `http://127.0.0.1:${upstream.address().port}`;
  ({ handleRequest } = require('./index.cjs'));
  const setup = await request('/api/setup/complete', { method: 'POST', headers: { origin: 'http://localhost' }, body: JSON.stringify({ setupCode: fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: 'http://localhost', username: 'owner', password: 'synthetic model loader password' }) });
  assert.equal(setup.status, 201); admin = session(setup);
  const invite = await request('/api/admin/invitations', { method: 'POST', headers: { cookie: admin.cookie, origin: 'http://localhost', 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'member' }) });
  const joined = await request('/api/auth/invitations/accept', { method: 'POST', headers: { origin: 'http://localhost' }, body: JSON.stringify({ token: JSON.parse(invite.body.toString()).token, username: 'member', password: 'synthetic model loader password' }) });
  member = session(joined);
});
test.after(() => { upstream.close(); fs.rmSync(testDataDir, { recursive: true, force: true }); });

test('rewrites URL attributes, fetch calls and palette links but never form values', () => {
  const html = rewriteHtml('<a href="/config">c</a><img src="/_vendor/x.png"><button hx-delete=\'/models/delete\'></button><input value="/models/foo.gguf"><a href="//cdn.example/x">x</a><a href="/model-loader/already">a</a><script>fetch(`/prompts/${id}`)</script>');
  assert.match(html, /href="\/model-loader\/config"/);
  assert.match(html, /src="\/model-loader\/_vendor\/x.png"/);
  assert.match(html, /hx-delete='\/model-loader\/models\/delete'/);
  assert.match(html, /value="\/models\/foo.gguf"/);
  assert.match(html, /href="\/\/cdn.example\/x"/);
  assert.match(html, /href="\/model-loader\/already"/);
  assert.match(html, /fetch\(`\/model-loader\/prompts\//);
  assert.equal(rewriteJson('{"url":"/config","label":"/models/a.gguf"}'), '{"url":"/model-loader/config","label":"/models/a.gguf"}');
});

test('only administrators reach Model Loader; signed-out visitors go to sign-in', async () => {
  const anon = await request('/model-loader/config');
  assert.equal(anon.status, 302); assert.equal(anon.headers.location, '/');
  assert.equal((await request('/model-loader/config', { headers: { cookie: member.cookie } })).status, 403);
  const bare = await request('/model-loader', { headers: { cookie: admin.cookie } });
  assert.equal(bare.status, 302); assert.equal(bare.headers.location, '/model-loader/');
  assert.equal(seen.length, 0);
});

test('admin pages are proxied with rewritten links, a strict policy and no noevia credentials', async () => {
  const r = await request('/model-loader/config', { headers: { cookie: admin.cookie, accept: 'text/html', 'hx-request': 'true', 'hx-current-url': 'https://cowork.example/model-loader/config?x=1' } });
  assert.equal(r.status, 200);
  const html = r.body.toString();
  assert.match(html, /href="\/model-loader\/models"/);
  assert.match(html, /hx-post="\/model-loader\/config\/section\/a\/save"/);
  assert.match(html, /value="\/models\/foo.gguf"/);
  assert.match(html, /src="\/model-loader\/_vendor\/htmx.min.js"/);
  assert.match(html, /fetch\('\/model-loader\/palette.json'\)/);
  assert.match(r.headers['content-security-policy'], /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
  assert.doesNotMatch(r.headers['content-security-policy'], /unpkg|jsdelivr|tailwindcss/);
  const hit = seen.at(-1);
  assert.equal(hit.url, '/config'); assert.equal(hit.headers.cookie, undefined); assert.equal(hit.headers.authorization, undefined);
  assert.equal(hit.headers['hx-request'], 'true'); assert.match(hit.headers['hx-current-url'], /^http:\/\/127\.0\.0\.1:\d+\/config\?x=1$/);
  const palette = await request('/model-loader/palette.json', { headers: { cookie: admin.cookie } });
  assert.equal(palette.body.toString(), '{"items":[{"url":"/model-loader/config/section/a/edit","label":"/models/foo.gguf"}]}');
});

test('writes need a same-origin request; redirects and binary bodies pass through correctly', async () => {
  const body = 'model=%2Fmodels%2Ffoo.gguf&ctx-size=8192';
  const form = { cookie: admin.cookie, 'content-type': 'application/x-www-form-urlencoded' };
  assert.equal((await request('/model-loader/config/section/a/save', { method: 'POST', headers: { ...form, origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await request('/model-loader/config/section/a/save', { method: 'POST', headers: form, body })).status, 403);
  const saved = await request('/model-loader/config/section/a/save', { method: 'POST', headers: { ...form, origin: 'http://localhost' }, body });
  assert.equal(saved.status, 200); assert.equal(saved.headers['hx-redirect'], '/model-loader/config?saved=a');
  assert.equal(seen.at(-1).body, body);
  const viaFetchMetadata = await request('/model-loader/config/section/a/save', { method: 'POST', headers: { ...form, 'sec-fetch-site': 'same-origin' }, body });
  assert.equal(viaFetchMetadata.status, 200);
  const redirect = await request('/model-loader/redirect', { headers: { cookie: admin.cookie } });
  assert.equal(redirect.status, 303); assert.equal(redirect.headers.location, '/model-loader/config?edit=a');
  const bin = await request('/model-loader/bin', { headers: { cookie: admin.cookie } });
  assert.deepEqual([...bin.body], [0, 1, 2, 255]);
});
