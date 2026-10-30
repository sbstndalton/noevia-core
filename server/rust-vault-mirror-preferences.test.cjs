'use strict';
// #2190 round 3: Node refuses the mirror preferences the Rust front owns, and runs the mirror at
// once for the nudges the Rust front writes. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PATH, ROUTE_REFUSAL, NUDGES_FILE, refuseOwned, readNudges, startNudges } = require('./rust-vault-mirror-preferences.cjs');

const parseRequestUrl = (req, base) => { try { return new URL(req.url, base || 'http://localhost'); } catch { return null; } };
const call = (method, url) => { const out = {}; const handled = refuseOwned({ method, url, headers: {} }, out, { parseRequestUrl, json: (res, status, body) => { res.status = status; res.body = body; } }); return { handled, ...out }; };

test('every method on the exact path is refused with the stable code; other paths fall through', () => {
  for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS']) {
    const r = call(method, PATH);
    assert.equal(r.handled, true, method); assert.equal(r.status, 503); assert.deepEqual(r.body, ROUTE_REFUSAL);
  }
  assert.equal(ROUTE_REFUSAL.code, 'RUST_VAULT_MIRROR_PREFERENCES_OWNED');
  assert.equal(call('GET', `${PATH}?x=1`).handled, true, 'the query is not part of the path');
  for (const other of ['/api/chat-vault-mirror/preferences/', '/api/chat-vault-mirror', '/api/chat-framing/preferences']) assert.equal(call('GET', other).handled, false, other);
});

test('readNudges keeps finite times only and tolerates a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudges-'));
  try {
    const file = path.join(dir, NUDGES_FILE);
    assert.deepEqual({ ...readNudges(file) }, {});
    fs.writeFileSync(file, JSON.stringify({ version: 1, nudges: { a: 5, b: 'x', c: null } }));
    assert.deepEqual({ ...readNudges(file) }, { a: 5 });
    fs.writeFileSync(file, 'not json');
    assert.throws(() => readNudges(file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the first read is a baseline; each newer nudge schedules that account at once, once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudges-'));
  const file = path.join(dir, NUDGES_FILE);
  const write = (nudges) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ version: 1, nudges })); fs.renameSync(tmp, file); };
  const scheduled = []; const logs = [];
  try {
    write({ old: 1 });
    const poller = startNudges({ dataDir: dir, schedule: (...a) => scheduled.push(a), intervalMs: 0, log: (m) => logs.push(m) });
    poller.tick();
    assert.deepEqual(scheduled, [], 'a restart does not replay old nudges');
    write({ old: 1, u1: 10 });
    poller.tick(); poller.tick();
    assert.deepEqual(scheduled, [['u1', null, { immediate: true }]]);
    write({ old: 2, u1: 10 });
    poller.tick();
    assert.deepEqual(scheduled.at(-1), ['old', null, { immediate: true }]);
    assert.equal(scheduled.length, 2);
    fs.writeFileSync(file, 'garbage!');
    poller.tick(); poller.tick();
    assert.equal(logs.length, 1, 'an unreadable file is logged once, without detail');
    assert.equal(scheduled.length, 2);
    write({ old: 2, u1: 11 });
    poller.tick();
    assert.deepEqual(scheduled.at(-1), ['u1', null, { immediate: true }]);
    poller.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing file at start is an empty baseline: the first nudge after it schedules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudges-'));
  const scheduled = [];
  try {
    const poller = startNudges({ dataDir: dir, schedule: (...a) => scheduled.push(a), intervalMs: 0 });
    fs.writeFileSync(path.join(dir, NUDGES_FILE), JSON.stringify({ version: 1, nudges: { u1: 3 } }));
    poller.tick();
    assert.deepEqual(scheduled, [['u1', null, { immediate: true }]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('index.cjs refuses before authentication and no longer mounts the Node route', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const refusal = src.indexOf("require('./rust-vault-mirror-preferences.cjs').refuseOwned(");
  assert.ok(refusal > 0);
  assert.ok(refusal > src.indexOf("require('./rust-storage-integrations.cjs').refuseOwned("));
  assert.ok(refusal < src.indexOf('const preAuth = requestAuth.authenticate(req);'));
  assert.ok(!src.includes('routes/chat-vault-mirror.cjs'));
  assert.ok(src.includes("require('./rust-vault-mirror-preferences.cjs').startNudges("));
  assert.ok(!fs.existsSync(path.join(__dirname, 'routes', 'chat-vault-mirror.cjs')));
});
