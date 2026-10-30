'use strict';
// sbstndalton/noevia#2190 round 5: Sign in with ChatGPT's token broker is the Rust front's (noevia-rs
// chatgpt_oauth_routes.rs, tested there through real HTTP with a synthetic OpenAI). Node refuses the
// device sign-in and the model list before authentication, never writes the token table but for the
// rotation's reseal, and asks the broker for access tokens over the internal store. Synthetic values only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const owned = require('./rust-chatgpt-oauth.cjs');
const { createRustAuthGuard, FRONT_TABLES } = require('./rust-auth.cjs');

// Shared with noevia-rs tests/chatgpt_oauth.rs: the stored token JSON in core's key order, sealed
// enc:v2 for account A with key [7;32] and nonce 0x01..0x0c (iv | tag | body, AAD noevia:user:<id>).
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TOKENS_JSON = '{"accessToken":"synthetic-access","refreshToken":"synthetic-refresh","accountId":"acct-synthetic","fedRamp":false,"expiresAt":1800000000000,"email":"ada@example.test","plan":"plus","connectedAt":1700000000000}';
const TOKENS_GOLDEN = 'enc:v2:AQIDBAUGBwgJCgsMvIx2UeZ0MdLawavEpU9ZGcBeif0Jj5FfsVFpe_uFmWKnnD9E2i5Gjh2M7fzPPTVtHCAWKmJhuTAK3BzxETwpBOoZEbPdEMh5qMaTYfmN8kPbxfh7anMdAhRASFTL2COT7vI4WbMjgWVi91-vKf2-CI2YXjrKc4XpaNiVDbQP1qC4ptUwi4Y9a9mka1rUefilYdzGw2i0rQd6eTq-jREEkAFE4B8Zt7oEAyrKvttFdGOLRDzHYtS7izHOkalFMILFX0426a7T8VAf_AgRZYrOKl_yE27UT6vK5yR8GIlqqZGn';

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return owned.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('exactly the broker\'s methods and paths are refused, before the body is read', () => {
  assert.deepEqual(owned.ROUTE_REFUSAL, { error: 'Sign in with ChatGPT is owned by the Rust front.', code: 'RUST_CHATGPT_OAUTH_OWNED' });
  assert.ok(Object.isFrozen(owned.ROUTE_REFUSAL) && Object.isFrozen(owned.ROUTES));
  for (const [method, url] of [['POST', '/api/providers/chatgpt/device'], ['POST', '/api/providers/chatgpt/device/poll'], ['POST', '/api/providers/chatgpt/device/cancel'],
    ['GET', '/api/providers/chatgpt/models'], ['GET', '/api/providers/chatgpt/models?refresh=1'], ['POST', '/api/x/../providers/chatgpt/device']]) {
    assert.deepEqual(refuse(method, url), { status: 503, body: owned.ROUTE_REFUSAL }, `${method} ${url}`);
  }
  for (const [method, url] of [['GET', '/api/providers/chatgpt/device'], ['DELETE', '/api/providers/chatgpt/models'], ['post', '/api/providers/chatgpt/device'],
    ['GET', '/api/providers/chatgpt'], ['DELETE', '/api/providers/chatgpt'], ['POST', '/api/providers/chatgpt/device/'], ['GET', '/api/providers/chatgpt-oauth/models']]) {
    assert.equal(refuse(method, url), null, `${method} ${url}`);
  }
});

test('index.cjs refuses the routes before authentication and builds the client on the broker', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const at = index.indexOf("require('./rust-chatgpt-oauth.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(at > 0 && at < index.indexOf('const preAuth = requestAuth.authenticate(req);'));
  assert.match(index, /createChatGptOAuth\(\{\s*db: authService\.db, broker: PROJECT_STORE,/);
  assert.doesNotMatch(index, /createChatGptOAuth\(\{[^}]*secrets:/, 'the client gets no key: it opens no token');
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'providers.cjs'), 'utf8');
  assert.doesNotMatch(routes, /startDeviceLogin|pollDeviceLogin|cancelDeviceLogin/);
});

test('chatgpt_oauth_tokens is refused exempt or not, but for the exact rotation reseal', () => {
  assert.equal(FRONT_TABLES.chatgpt_oauth_tokens.code, 'RUST_CHATGPT_OAUTH_OWNED');
  assert.equal(owned.RESEAL_SQL, 'UPDATE chatgpt_oauth_tokens SET data_enc=? WHERE user_id=? AND data_enc=?');
  const Database = require('better-sqlite3');
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE chatgpt_oauth_tokens(user_id TEXT PRIMARY KEY, data_enc TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'connected', updated_at INTEGER NOT NULL)`);
  raw.prepare("INSERT INTO chatgpt_oauth_tokens VALUES('u','old','connected',1)").run();
  const guard = createRustAuthGuard();
  const db = guard.install(raw);
  const refused = (e) => e.status === 503 && e.code === 'RUST_CHATGPT_OAUTH_OWNED';
  const writes = [
    "INSERT INTO chatgpt_oauth_tokens(user_id, data_enc, state, updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET data_enc=excluded.data_enc",
    "UPDATE chatgpt_oauth_tokens SET state='reconnect', updated_at=? WHERE user_id=?",
    "UPDATE chatgpt_oauth_tokens SET data_enc=?, updated_at=? WHERE user_id=? AND state='connected' AND data_enc=?",
    `${owned.RESEAL_SQL} OR 1=1`,
    'DELETE FROM chatgpt_oauth_tokens WHERE user_id=?',
    'REPLACE INTO "chatgpt_oauth_tokens"(user_id,data_enc,updated_at) VALUES(?,?,?)',
  ];
  for (const sql of writes) {
    assert.throws(() => db.prepare(sql).run('a', 'b', 'c', 'd'), refused, sql);
    assert.throws(() => guard.exempt(() => db.prepare(sql).run('a', 'b', 'c', 'd')), refused, `exempt: ${sql}`);
  }
  assert.throws(() => db.exec('DELETE FROM chatgpt_oauth_tokens'), refused);
  // The DDL (Node is the migrator), reads and the reseal run.
  db.exec(`CREATE TABLE IF NOT EXISTS chatgpt_oauth_tokens(user_id TEXT PRIMARY KEY, data_enc TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'connected', updated_at INTEGER NOT NULL)`);
  assert.equal(db.prepare('SELECT state FROM chatgpt_oauth_tokens WHERE user_id=?').get('u').state, 'connected');
  assert.equal(db.prepare(owned.RESEAL_SQL).run('new', 'u', 'old').changes, 1);
  assert.equal(db.prepare(owned.RESEAL_SQL).run('newer', 'u', 'old').changes, 0, 'compare-and-swap: a value saved meanwhile is kept');
  assert.equal(raw.prepare('SELECT data_enc FROM chatgpt_oauth_tokens').get().data_enc, 'new');
});

test('no Node source writes chatgpt_oauth_tokens but the reseal', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (/\.c?js$/.test(e.name) && !/\.test\.c?js$/.test(e.name)) files.push(f);
    }
  };
  walk(__dirname);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:INSERT|REPLACE|UPDATE|DELETE)[^`'"\n]*chatgpt_oauth_tokens[^`'"]*/gi)) {
      if (m[0].trim() !== owned.RESEAL_SQL) offenders.push(`${path.relative(__dirname, f)}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, []);
  // secrets-rotate.cjs's generic CAS statement is, for this table, exactly the reseal.
  const rotate = require('./secrets-rotate.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE chatgpt_oauth_tokens(user_id TEXT PRIMARY KEY, data_enc TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'connected', updated_at INTEGER NOT NULL)`);
  const seen = [];
  const spy = { prepare: (sql) => { seen.push(sql); return db.prepare(sql); }, exec: (s) => db.exec(s) };
  const table = rotate.rotationTables({ db: spy, dataDir: os.tmpdir() }).find((x) => x.name === 'chatgpt_oauth_tokens');
  db.prepare("INSERT INTO chatgpt_oauth_tokens VALUES('u','v','connected',1)").run();
  table.write(['u'], 'v2', 'v');
  assert.equal(seen.filter((s) => /^UPDATE/.test(s)).pop(), owned.RESEAL_SQL);
});

test('the stored token format the broker writes: enc:v2 bound to the owner, the golden vector both ways', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chatgpt-golden-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secrets.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  const secrets = require('./secrets.cjs').createSecretStore(root, { env: {} });
  // Node opens what the Rust broker sealed (and the account binding holds)...
  assert.equal(secrets.decrypt(TOKENS_GOLDEN, A), TOKENS_JSON);
  assert.throws(() => secrets.decrypt(TOKENS_GOLDEN, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
  // ...and Node's own seal of the same JSON with the same nonce is byte-identical to the broker's.
  const crypto = require('node:crypto');
  const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const gcm = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), nonce);
  gcm.setAAD(Buffer.from(`noevia:user:${A}`));
  const body = Buffer.concat([gcm.update(TOKENS_JSON, 'utf8'), gcm.final()]);
  assert.equal(`enc:v2:${Buffer.concat([nonce, gcm.getAuthTag(), body]).toString('base64url')}`, TOKENS_GOLDEN);
  // A Node-sealed row (random nonce) opens with the same key and binding, as the broker opens rows
  // written before this change.
  assert.equal(secrets.decrypt(secrets.encrypt(TOKENS_JSON, A), A), TOKENS_JSON);
});

test('the store client speaks the broker protocol: the secret, the ops, refusals as data, no refresh token', async () => {
  const { createClient } = require('./project-store-client.cjs');
  const seen = [];
  const answers = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body), timeout: init.signal });
    const [status, body] = answers.shift();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const client = createClient({ port: 4321, token: 'synthetic-store-token-0123456789abcdef', fetchImpl });
  answers.push([200, { accessToken: 'AT', accountId: 'acct', fedRamp: true, expiresAt: 5, generation: 'g', refreshToken: 'must-not-pass' }]);
  const s = await client.chatgptSession('u', 'AT-old');
  assert.deepEqual(s, { ok: true, session: { accessToken: 'AT', accountId: 'acct', fedRamp: true, expiresAt: 5, generation: 'g' } });
  assert.equal(seen[0].url, 'http://127.0.0.1:4321/v1/chatgpt/session');
  assert.equal(seen[0].headers['x-noevia-store-token'], 'synthetic-store-token-0123456789abcdef');
  assert.deepEqual(seen[0].body, { user: 'u', rejected: 'AT-old' });
  answers.push([401, { error: 'Reconnect needed: synthetic.', code: 'reconnect', status: 401 }]);
  assert.deepEqual(await client.chatgptSession('u'), { ok: false, status: 401, error: 'Reconnect needed: synthetic.', code: 'reconnect' });
  assert.deepEqual(seen[1].body, { user: 'u' });
  // The store's own refusals (a wrong secret, an older front without the op) are "try again".
  answers.push([401, { error: 'unauthorised' }]);
  assert.deepEqual(await client.chatgptSession('u'), { ok: false, status: 503 });
  answers.push([404, { error: 'not found' }]);
  assert.deepEqual(await client.chatgptCatalogue('u'), { ok: false, status: 503 });
  answers.push([200, { models: [{ slug: 'm' }] }]);
  assert.deepEqual(await client.chatgptCatalogue('u'), { ok: true, models: [{ slug: 'm' }] });
  answers.push([200, { marked: true }]);
  assert.deepEqual(await client.chatgptReject('u', 'g'), { ok: true, marked: true });
  answers.push([200, { ok: true }]);
  assert.deepEqual(await client.chatgptDisconnect('u'), { ok: true });
  assert.equal(client.chatgptForget, undefined, 'the front forgets a deleted account\'s tokens itself');
  assert.equal(seen.slice(-1)[0].url.split('/').pop(), 'disconnect');
});
