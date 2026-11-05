'use strict';
// #2396: "Use deployment default" on the reranker switch (DELETE /api/models/reranker) used to answer 503
// "settings key unknown is written by the Rust front", so an admin override could never be cleared. The real route, the
// real settings module and the real guarded auth database (synthetic data only); the Rust front does not write this key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createAuth } = require('./auth.cjs');
const { createModelRoutes } = require('./routes/models.cjs');
const { createRerankSettings, KEY } = require('./rerank-settings.cjs');
const { settingsStore } = require('./features.cjs');

const ORIGIN = 'https://noevia.example.test';
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

function fixture(t, { store } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rerank-2396-'));
  const auth = quiet(() => createAuth({ dataDir: dir, publicOrigin: ORIGIN }));
  t.after(() => { auth.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { RERANK_BACKEND: 'tei', RERANK_BASE_URL: 'http://rerank.example.test:8080', NOEVIA_FEATURE_RAG_RERANK: 'true' };
  const audits = [];
  const rerankSettings = createRerankSettings({ store: store ? store(auth.db) : settingsStore(auth.db), env, audit: (...a) => audits.push(a) });
  const sent = [];
  const routes = createModelRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async () => '',
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async () => ({ ok: false }),
    env: {}, modelManager: { enabled: false }, currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelsInstalled: async () => [], modelScanCache: new Map() },
    rerankSettings,
  });
  const call = async (method, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    const handled = await routes(req, new EventEmitter(), { path: '/api/models/reranker', authn: { user: { id: 'admin1', role: 'admin' } }, url: new URL('http://localhost/api/models/reranker') });
    assert.equal(handled, true);
    return sent.pop();
  };
  const rows = () => auth.db.prepare('SELECT key FROM settings WHERE key=?').all(KEY).length;
  return { auth, call, rows, audits, sent };
}

test('#2396: switching the reranker off and back to the deployment default answers 200 with source deployment', async (t) => {
  const f = fixture(t);
  const off = await f.call('PUT', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.source, 'admin');
  assert.equal(off.body.enabled, false);
  assert.equal(f.rows(), 1);
  const reset = await f.call('DELETE');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.source, 'deployment');
  assert.equal(reset.body.enabled, true, 'the deployment switch applies again');
  assert.equal(f.rows(), 0, 'the saved row is gone');
  assert.deepEqual(f.audits.map((a) => a[0]), ['rerank.configure', 'rerank.reset']);
  // PUT { reset: true } is the same reset, and a reset with nothing saved is still a 200.
  assert.equal((await f.call('PUT', { enabled: false })).status, 200);
  const viaPut = await f.call('PUT', { reset: true });
  assert.deepEqual([viaPut.status, viaPut.body.source], [200, 'deployment']);
  assert.deepEqual([(await f.call('DELETE')).status, f.rows()], [200, 0]);
});

test('#2396: a single-writer guard refusal is logged, never shown: the admin gets the generic error', async (t) => {
  const refusing = (db) => ({ ...settingsStore(db), delete: () => { throw Object.assign(new Error('settings key unknown is written by the Rust front'), { status: 503, code: 'RUST_AUTH_OWNED' }); } });
  const f = fixture(t, { store: refusing });
  assert.equal((await f.call('PUT', { enabled: false })).status, 200);
  const logged = []; const err = console.error; console.error = (...a) => logged.push(a.join(' '));
  let res;
  try { res = await f.call('DELETE'); } finally { console.error = err; }
  assert.deepEqual(res, { status: 500, body: { error: 'The reranker settings could not be changed.' } });
  assert.doesNotMatch(JSON.stringify(res), /Rust|guard|settings key/i);
  assert.match(logged.join('\n'), /RUST_AUTH_OWNED/);
  // The module's own refusals keep their words and ids.
  const own = await f.call('PUT', { enabled: true, choice: 'nope' });
  assert.deepEqual([own.status, own.body.errorId], [400, 'unknownReranker']);
});
