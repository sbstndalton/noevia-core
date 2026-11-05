'use strict';
// Chat port S8 review (P2-1): when the front loses the admission lease that covers a Diary local exchange,
// it closes the call. The sidecar call behind it must end then too, not run on for up to 600 s while the gate no
// longer counts it. Driven through the real route (routes/diary.cjs over diary.cjs and http.cjs fetchJson) against a
// synthetic sidecar that never answers. Synthetic only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createDiary } = require('./diary.cjs');
const { createDiaryRoutes } = require('./routes/diary.cjs');
const { fetchJson, readJson, json } = require('./http.cjs');
const { createLeases } = require('./inference-admission-lease.cjs');

async function stalledSidecar(t) {
  const seen = { asked: null, closed: null };
  let asked, closed;
  seen.asked = new Promise((r) => { asked = r; });
  seen.closed = new Promise((r) => { closed = r; });
  const server = http.createServer((req, res) => {
    asked(req.url);
    // Never answers; reports when the caller closed the connection.
    req.socket.once('close', () => closed(Date.now()));
    void res;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

test('a Diary local exchange whose caller went away ends its sidecar call within 1 s', { timeout: 10000 }, async (t) => {
  const { base, seen } = await stalledSidecar(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-s8-diary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requestScope = new AsyncLocalStorage();
  const user = { id: 'u1', username: 'qa-synth', role: 'member', disabled_at: null };
  const authService = {
    getStorage: () => ({ kind: 'local' }), diaryEnabled: () => true,
    publicUser: (row) => (row ? { id: row.id, username: row.username, role: row.role } : null),
    db: { prepare: () => ({ get: () => user }) },
  };
  const diary = createDiary({ fs, path, fetchJson, DIARY_BASE: base, DIARY_TOKEN: 'synthetic-token', DIARY_SOURCE: 'sidecar', requestScope, authService, endpointApproved: () => true });
  const sent = [];
  let handled;
  const finished = new Promise((resolve, reject) => { handled = { resolve, reject }; });
  const leases = createLeases({ log() {} });
  const routes = createDiaryRoutes({
    json: (res, status, body) => { sent.push({ status, body }); return json(res, status, body); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; }, readJson, fetchJson,
    DIARY_BASE: base, authService, currentWorkspace: () => ({ userId: 'u1', dir }), diary,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(leases.cover(req.headers['x-noevia-admission-lease'], 'diary'), true);
    requestScope.run({ workspace: { userId: 'u1', dir }, authn: { user } },
      () => routes.diary(req, res, { path: url.pathname, authn: { user }, url }))
      .then(handled.resolve, handled.reject);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  // A synthetic front closes its real loopback request when Node's sole lease arbiter ends the lease.
  let frontRequest;
  const lease = leases.add({ gate: 'diary', release: () => frontRequest.destroy() });
  t.after(() => { leases.release(lease); frontRequest?.destroy(); });
  frontRequest = http.request({ host: '127.0.0.1', port: server.address().port,
    path: '/api/diary/local-exchange', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-noevia-admission-lease': lease },
  });
  frontRequest.on('error', () => {}); // Expected socket close on loss.
  frontRequest.end(JSON.stringify({ message: 'QA-SYNTH hello' }));
  assert.equal(await seen.asked, '/api/local-exchange');
  const left = Date.now();
  assert.equal(leases.release(lease), true);
  let timer;
  const closedAt = await Promise.race([seen.closed, new Promise((r) => { timer = setTimeout(() => r(null), 1000); })]);
  clearTimeout(timer);
  assert.notEqual(closedAt, null, 'the sidecar call kept running after the lease was lost');
  assert.ok(closedAt - left < 1000);
  assert.equal(await finished, true);
  assert.deepEqual(sent, [], 'nothing is written to a caller that is gone');
});
