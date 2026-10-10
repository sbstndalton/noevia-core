'use strict';
// The sampling-settings route over a fake settings table: default-on, only an admin changes
// it, and the preset catalogue it returns. Selection logic is sampling-presets.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createSamplingSettingsRoutes } = require('./sampling-settings.cjs');
const { PRESETS, PRESETS_VERSION } = require('../sampling-presets.cjs');

function fixture() {
  const sent = [], audits = [];
  const settings = new Map();
  const routes = createSamplingSettingsRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    authService: {
      db: { transaction: (fn) => fn, prepare: () => ({ get: () => (settings.has('k') ? { value: settings.get('k') } : undefined), run: (_k, v) => settings.set('k', v) }) },
      audit: (...args) => audits.push(args),
    },
  });
  const call = (method, path, body, role = 'member') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: 'u1', role } } });
  };
  return { call, sent, audits, settings };
}

test('defaults to enabled, exposes the preset catalogue, and only an admin may change it', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/sampling-setting'), false);
  await f.call('GET', '/api/sampling-settings');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: true, presets: PRESETS, version: PRESETS_VERSION, admin: false } });

  await f.call('PUT', '/api/sampling-settings', { enabled: false });
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required' } });

  await f.call('PUT', '/api/sampling-settings', '{', 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });

  await f.call('PUT', '/api/sampling-settings', { enabled: 'no' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'enabled must be true or false' } });

  await f.call('PUT', '/api/sampling-settings', { enabled: false }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: false } });
  assert.deepEqual(f.audits, [['sampling.autoPresets', 'u1', null, { enabled: false }]]);

  await f.call('GET', '/api/sampling-settings', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: false, presets: PRESETS, version: PRESETS_VERSION, admin: true } });

  await f.call('PUT', '/api/sampling-settings', { enabled: true }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: true } });
  await f.call('GET', '/api/sampling-settings');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: true, presets: PRESETS, version: PRESETS_VERSION, admin: false } });

  await f.call('DELETE', '/api/sampling-settings');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
});

// #1282: every valid JSON non-object shape returns validation, without writes or audit.
test('rejects null, arrays and scalar bodies without changing settings or audit', async () => {
  for (const raw of ['null', '[]', '[true]', '"text"', '0', 'false', '{}', '{"enabled":null}', '{"enabled":1}']) {
    const f = fixture();
    await f.call('PUT', '/api/sampling-settings', raw, 'admin');
    assert.deepEqual(f.sent, [{ status: 400, body: { error: 'enabled must be true or false' } }], raw);
    assert.equal(f.settings.size, 0, raw);
    assert.deepEqual(f.audits, [], raw);
  }
});

test('checks administrator before parsing null or malformed bodies', async () => {
  for (const raw of ['null', '{', '']) {
    const f = fixture();
    await f.call('PUT', '/api/sampling-settings', raw, 'member');
    assert.deepEqual(f.sent, [{ status: 403, body: { error: 'Administrator required' } }]);
    assert.equal(f.settings.size, 0);
    assert.deepEqual(f.audits, []);
  }
});

// #1298: exercise the real createAuth database and audit collaborator, including SQL refusal.
test('setting and authenticated audit commit together or both roll back in real SQLite', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampling-atomic-'));
  let auth;
  try {
    const warn = console.warn;
    try {
      console.warn = () => {}; // Never emit the synthetic first-run setup code.
      auth = require('../auth.cjs').createAuth({ dataDir: dir, publicOrigin: 'http://127.0.0.1:8021', rpId: '127.0.0.1' });
    } finally { console.warn = warn; }
    auth.db.prepare("INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES('synthetic-admin','a','a','Synthetic','admin','x','a',1,1)").run();
    auth.db.prepare("INSERT OR REPLACE INTO settings VALUES('auto_sampling_presets_enabled','true')").run();
    const sent = [];
    const route = createSamplingSettingsRoutes({ json: (_r, status, body) => sent.push({ status, body }), readBody: require('../http.cjs').readBody, authService: auth });
    const invoke = () => { const req = Readable.from(['{"enabled":false}']); req.method = 'PUT'; return route(req, {}, { path: '/api/sampling-settings', authn: { user: { id: 'synthetic-admin', role: 'admin' } } }); };
    auth.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit refusal'); END;");
    await assert.rejects(invoke(), { code: 'SQLITE_CONSTRAINT_TRIGGER' });
    assert.deepEqual(sent, []);
    assert.equal(auth.db.prepare("SELECT value FROM settings WHERE key='auto_sampling_presets_enabled'").get().value, 'true');
    assert.equal(auth.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='sampling.autoPresets'").get().n, 0);
    auth.db.exec('DROP TRIGGER reject_audit;');
    await invoke();
    assert.deepEqual(sent, [{ status: 200, body: { enabled: false } }]);
    assert.equal(auth.db.prepare("SELECT value FROM settings WHERE key='auto_sampling_presets_enabled'").get().value, 'false');
    const row = auth.db.prepare("SELECT actor_user_id,target_user_id,action,detail FROM audit_events WHERE action='sampling.autoPresets'").get();
    assert.deepEqual(row, { actor_user_id: 'synthetic-admin', target_user_id: null, action: 'sampling.autoPresets', detail: '{"enabled":false}' });
  } finally { auth?.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only confirmed native sampling ownership refuses Node decisions and writes', async () => {
  const { enabledFrom } = require('./sampling-settings.cjs');
  const env = { NOEVIA_FRONT:'rust',NOEVIA_RUST_AUTH:'1',NOEVIA_RUST_AUTH_CONFIRMED:'1',NOEVIA_RUST_SAMPLING_SETTINGS:'1',NOEVIA_RUST_SAMPLING_SETTINGS_CONFIRMED:'1' };
  assert.equal(enabledFrom(env),true);
  for (const key of Object.keys(env)) assert.equal(enabledFrom({...env,[key]:undefined}),false,key);
  for (const method of ['GET','PUT','DELETE']) {
    let sent;
    const routes = createSamplingSettingsRoutes({env,json:(_res,status,body)=>{sent={status,body};},readBody:()=>{throw Error('must not read body');},authService:{db:{prepare:()=>{throw Error('must not read or write settings');}},audit:()=>{throw Error('must not audit');}}});
    assert.equal(await routes({method},{},{path:'/api/sampling-settings',authn:{user:{role:'admin'}}}),true);
    assert.deepEqual(sent,{status:503,body:{error:'Sampling settings are owned by the Rust front.'}});
  }
});
