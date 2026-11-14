'use strict';
// Track R11: the Rust front's native pull records its download in this process's tracker over the loopback bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const { createDownloadsBridge, PREFIX } = require('./rust-model-downloads-bridge.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);

async function serve(modelManager) {
  const handle = createDownloadsBridge({ secret: SECRET, json, readJson, modelManager });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res)) { res.statusCode = 599; res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = async (op, body, { secret = SECRET, method = 'POST', headers = {} } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}${op}`, { method, headers: { 'x-noevia-store-token': secret, 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('requested and rejected reach the tracker, for the front only', async () => {
  const seen = [];
  const s = await serve({ trackDownload: { requested: (m) => seen.push(['requested', m]), rejected: (m) => seen.push(['rejected', m]) } });
  try {
    assert.deepEqual(await s.call('requested', JSON.stringify({ model: 'qa/model:Q4' })), { status: 200, body: { ok: true } });
    assert.deepEqual(await s.call('rejected', JSON.stringify({ model: 'qa/model:Q4' })), { status: 200, body: { ok: true } });
    assert.deepEqual(seen, [['requested', 'qa/model:Q4'], ['rejected', 'qa/model:Q4']]);
    // Not the front, another op, another method, a proxied request: the 404 of an unknown path.
    assert.equal((await s.call('requested', '{"model":"qa/x"}', { secret: 'wrong' })).status, 404);
    assert.equal((await s.call('completed', '{"model":"qa/x"}')).status, 404);
    assert.equal((await s.call('requested', undefined, { method: 'GET' })).status, 404);
    assert.equal((await s.call('requested', '{"model":"qa/x"}', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status, 404);
    // A body without exactly one text model.
    for (const bad of ['{}', '{"model":""}', '{"model":5}', '[]', 'null', `{"model":"${'x'.repeat(513)}"}`, '{"model":"qa/x","extra":1}', '{nope'])
      assert.equal((await s.call('requested', bad)).status, 400, bad);
    assert.equal(seen.length, 2);
  } finally { await s.close(); }
});

test('a server without a tracker answers 404', async () => {
  const s = await serve({ kind: 'none' });
  try { assert.equal((await s.call('requested', '{"model":"qa/x"}')).status, 404); } finally { await s.close(); }
});

test('index.cjs mounts the bridge on the captured secret and the manager exports the hook', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /require\('\.\/rust-model-downloads-bridge\.cjs'\)\.createDownloadsBridge\(\{ secret: FRONT_SECRET, json, readJson, modelManager \}\)/);
  assert.match(index, /await modelDownloadsBridge\(req, res\)/);
  assert.match(fs.readFileSync(path.join(__dirname, 'llamacpp-manager.cjs'), 'utf8'), /trackDownload: Object\.freeze\(\{ requested: model => tracker\.requested\(model\), rejected: model => tracker\.rejected\(model\) \}\)/);
});
