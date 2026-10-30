'use strict';
// sbstndalton/noevia#2202: the MCP server credentials (an account's OAuth sign-ins and its own API
// keys for a directory server) are the Rust front's (noevia-rs mcp_broker.rs, mcp_routes.rs, tested
// there through real HTTP with a synthetic MCP server and OAuth service). Node refuses their routes
// before authentication, never writes their three tables, asks the broker for one call's access
// token or key headers, and re-reads who is ready from the file the broker publishes. Synthetic
// values only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const owned = require('./rust-mcp-credentials.cjs');
const { createRustAuthGuard, FRONT_TABLES } = require('./rust-auth.cjs');

// Shared with noevia-rs tests/mcp_credentials.rs: key [7;32], nonce 0x01..0x0c, sealed with Node's
// own crypto.createCipheriv (iv | tag | body, AAD noevia:user:<id> for enc:v2).
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GOLDEN = [
  ['{"accessToken":"synthetic-access","refreshToken":"synthetic-refresh","expiresAt":1800000000000}', 'enc:v2:AQIDBAUGBwgJCgsMI17GHu5yPOtiRO5ls-yDyMBeif0Jj5FfsVFpe_uFmWKnnD9E2i5Gjh2M7fzPPTVtHCAWKmJhuTAK3BzxETwpBOoZEbPdEMh5qMaTYfmN8kPbxfh7anMZGQdGT1_M0DOT7uFhCuBnnCYrqRv3fLmq', A],
  ['{"resource":"https://mcp.example.test/mcp","issuer":"https://auth.example.test","authorizationEndpoint":"https://auth.example.test/authorize","tokenEndpoint":"https://auth.example.test/token","registrationEndpoint":"https://auth.example.test/register","secretMethod":"client_secret_basic","scopes":["read"],"clientId":"synthetic-client","clientSecret":null,"redirectUri":"https://noevia.example.test/api/mcp-oauth/callback"}', 'enc:v1:AQIDBAUGBwgJCgsM6cDf01pcxElA-gdc2zMrzcBemvsZhZdehlsgJLfP1zSklmsfnSZRl1DE9P7BKCp7EHhRK3MopjYJlmS8Eyo0U7VJQPCRDNRorNzKY6SJ4UXWmPUhJzwMDRIBSV_M5WWd9rEsTrg43n9h-F-uI-eSBcvEEzXBY_WyJ8DDQ6IdgPzy64Ihm9gxYd26WkKTbb34IpjZki3w9Vg4IHD3jVhLhQdDp0t-uLoVLCbcq5QPOm7RRCnHLNm4yDTWmOkCcsHYQ1cg5faU4Ute5gIZdIGIRwmiTDiKDO-ItmAlR9cf98WqZjAXhpTmADcNlP1ogUI0JK_GngyghTtzudO0JtsYFbzSuEv-JtWwhmUyk3FuZsL-YgJRDENb9_EZHwoWVvtuokH7wmNqBxvlJSCqtQDzN9_5XFyXpXZ2HeQKNn4dq68SZRDxy-ra1DJ0651zZnyeUrIRno_c57uZFJPaw2-PrwLWrtaiyZO1hRqalhgjZ1mFpdSeH67PklPv578pTeiS6YZk8t6ulLYJm3Yl8DAMFuWWK5-3yt1zT1EM92Gu1C3w59slZPJI9FVy5HNbr6pAY2JwVwAIVAA', null],
  ['{"X-Api-Key":"synthetic-key"}', 'enc:v2:AQIDBAUGBwgJCgsMkdk8PVlaYeAV80cSjk3YCsBesLMrmosBrlt7PK-F0Dm6kTlVxiJRyhXE9b3R', A],
];

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return owned.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('exactly the broker\'s methods and paths are refused, before the body is read', () => {
  assert.deepEqual(owned.ROUTE_REFUSAL, { error: 'MCP server keys and sign-ins are owned by the Rust front.', code: 'RUST_MCP_CREDENTIALS_OWNED' });
  assert.ok(Object.isFrozen(owned.ROUTE_REFUSAL) && Object.isFrozen(owned.ROUTES) && Object.isFrozen(owned.TABLES));
  for (const [method, url] of [
    ['GET', '/api/mcp-keys/servers'], ['PUT', '/api/mcp-keys/dir-notes'], ['DELETE', '/api/mcp-keys/dir-notes'], ['PUT', '/api/mcp-keys/servers'],
    ['GET', '/api/mcp-oauth/servers'], ['POST', '/api/mcp-oauth/dir-notes/connect'], ['DELETE', '/api/mcp-oauth/dir-notes'], ['GET', '/api/mcp-oauth/callback'],
    ['GET', '/api/mcp-oauth/callback?state=s&code=c'], ['GET', '/api/x/../mcp-keys/servers'], ['DELETE', '/api/mcp-oauth/callback'],
  ]) {
    assert.deepEqual(refuse(method, url), { status: 503, body: owned.ROUTE_REFUSAL }, `${method} ${url}`);
  }
  // Anything core's anchored patterns never matched stays Node's (its 404): other methods, other id shapes.
  for (const [method, url] of [
    ['POST', '/api/mcp-keys/servers'], ['GET', '/api/mcp-keys/dir-notes'], ['PUT', '/api/mcp-keys/Dir-Notes'], ['PUT', '/api/mcp-keys/dir_notes'], ['PUT', '/api/mcp-keys/a/b'],
    ['PUT', '/api/mcp-keys/dir-notes/'], ['post', '/api/mcp-oauth/dir-notes/connect'], ['GET', '/api/mcp-oauth/dir-notes/connect'], ['POST', '/api/mcp-oauth/Dir/connect'],
    ['POST', '/api/mcp-oauth/callback'], ['GET', '/api/mcp-oauth/dir-notes'], ['GET', '/api/mcp-oauth/'], ['GET', '/api/admin/mcp-directory'], ['PUT', '/api/admin/mcp-directory/dir-x/keys'],
  ]) {
    assert.equal(refuse(method, url), null, `${method} ${url}`);
  }
});

test('index.cjs refuses the routes before authentication and builds the client on the broker', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const at = index.indexOf("require('./rust-mcp-credentials.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(at > 0 && at < index.indexOf('const preAuth = requestAuth.authenticate(req);'));
  assert.match(index, /createMcpCredentials\(\{ broker: PROJECT_STORE, dataDir: DATA_DIR \}\)/);
  assert.match(index, /resealMcp: \(\) => require\('\.\/rust-mcp-credentials\.cjs'\)\.resealMcpCredentials\(PROJECT_STORE\)/);
  assert.doesNotMatch(index, /mcp-oauth\.cjs|createMcpOAuth/, 'the OAuth client, discovery and token store are gone from Node');
  assert.equal(fs.existsSync(path.join(__dirname, 'mcp-oauth.cjs')), false);
  const code = fs.readFileSync(path.join(__dirname, 'routes', 'mcp-directory.cjs'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /\/api\/mcp-keys|\/api\/mcp-oauth\/(?!callback`)|mcpOAuth\.(?:finish|disconnect)|userKey/);
});

test('the three tables are refused for every Node write, exempt or not, with no allowance', () => {
  const Database = require('better-sqlite3');
  const raw = new Database(':memory:');
  owned.ensureSchema(raw);
  raw.exec("INSERT INTO mcp_oauth_tokens VALUES('u','s','old',1); INSERT INTO mcp_oauth_clients VALUES('s','old',1); INSERT INTO directory_mcp_user_keys VALUES('u','s','old',1)");
  const guard = createRustAuthGuard();
  const db = guard.install(raw);
  const refused = (e) => e.status === 503 && e.code === 'RUST_MCP_CREDENTIALS_OWNED';
  for (const table of owned.TABLES) {
    assert.equal(FRONT_TABLES[table].code, 'RUST_MCP_CREDENTIALS_OWNED');
    assert.equal(FRONT_TABLES[table].allowed, null);
    const col = table === 'directory_mcp_user_keys' ? 'headers_enc' : 'data_enc';
    const width = table === 'mcp_oauth_clients' ? 3 : 4;
    const marks = Array(width).fill('?').join(',');
    const writes = [
      `INSERT INTO ${table} VALUES(${marks})`,
      `UPDATE ${table} SET ${col}=?`,
      `UPDATE ${table} SET ${col}=? WHERE ${col}=?`,
      `DELETE FROM ${table}`,
      `DELETE FROM ${table} WHERE ${col}=?`,
      `REPLACE INTO "${table}" VALUES(${marks})`,
    ];
    for (const sql of writes) {
      const args = ['a', 'b', 'c', 'd'].slice(0, (sql.match(/\?/g) || []).length);
      assert.throws(() => db.prepare(sql).run(...args), refused, sql);
      assert.throws(() => guard.exempt(() => db.prepare(sql).run(...args)), refused, `exempt: ${sql}`);
    }
    assert.throws(() => db.exec(`DELETE FROM ${table}`), refused);
  }
  // Reads and the DDL (Node is the migrator) run.
  owned.ensureSchema(db);
  assert.equal(db.prepare('SELECT data_enc FROM mcp_oauth_tokens').get().data_enc, 'old');
  assert.equal(raw.prepare('SELECT count(*) n FROM directory_mcp_user_keys').get().n, 1, 'nothing was written');
  // The shared key of a server stays Node's table.
  db.exec('CREATE TABLE IF NOT EXISTS directory_mcp_servers(id TEXT PRIMARY KEY, headers_enc TEXT)');
  db.prepare("INSERT INTO directory_mcp_servers VALUES('s','x')").run();
});

test('no Node source writes the three tables', () => {
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
    for (const m of src.matchAll(/(?:INSERT|REPLACE|UPDATE|DELETE)[^`'"\n]*(?:mcp_oauth_tokens|mcp_oauth_clients|directory_mcp_user_keys)[^`'"]*/gi)) {
      offenders.push(`${path.relative(__dirname, f)}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, []);
  // The rotation's generic CAS statement is never built for them: the broker re-seals them.
  const names = require('./secrets-rotate.cjs').rotationTables({ db: { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) }, dataDir: os.tmpdir() }).map((t) => t.name);
  for (const t of owned.TABLES) assert.ok(!names.includes(t), t);
  assert.ok(names.includes('directory_mcp_servers'), 'a server\'s shared key is still Node\'s to re-seal');
});

test('the stored formats the broker writes: the golden vectors both ways, tokens and keys bound to their owner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-mcp-golden-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secrets.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  const secrets = require('./secrets.cjs').createSecretStore(root, { env: {} });
  const crypto = require('node:crypto');
  const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const [plain, golden, user] of GOLDEN) {
    // Node opens what the Rust broker sealed (and the account binding holds)...
    assert.equal(secrets.decrypt(golden, user ?? undefined), plain);
    if (user) assert.throws(() => secrets.decrypt(golden, B), `${golden.slice(0, 12)} is bound to its owner`);
    // ...and Node's own seal of the same JSON with the same nonce is byte-identical to the broker's.
    const gcm = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), nonce);
    if (user) gcm.setAAD(Buffer.from(`noevia:user:${user}`));
    const body = Buffer.concat([gcm.update(plain, 'utf8'), gcm.final()]);
    assert.equal(`enc:${user ? 'v2' : 'v1'}:${Buffer.concat([nonce, gcm.getAuthTag(), body]).toString('base64url')}`, golden);
    // A row Node sealed itself (random nonce) opens with the same key and binding: the broker opens rows written before this change.
    assert.equal(secrets.decrypt(secrets.encrypt(plain, user ?? undefined), user ?? undefined), plain);
  }
});

function stateFile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-mcp-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, owned.STATE_FILE);
  // As the broker writes it: a new file renamed over the old one.
  const publish = (doc) => { const tmp = `${file}.${Math.random()}.tmp`; fs.writeFileSync(tmp, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode: 0o600 }); fs.renameSync(tmp, file); };
  return { root, file, publish };
}

test('who is ready is re-read from the published file, and an unreadable file means nobody is', (t) => {
  const { root, file, publish } = stateFile(t);
  const creds = owned.createMcpCredentials({ broker: {}, dataDir: root });
  // Not published yet: nobody is ready (fails closed).
  assert.equal(creds.oauth.status(A, 's'), 'disconnected');
  assert.equal(creds.oauth.connected(A, 's'), false);
  assert.equal(creds.keys.hasKey(A, 's'), false);
  publish({ version: 1, oauth: { [A]: { s: 'connected', r: 'reauth' } }, keys: { [B]: ['k'] } });
  assert.equal(creds.oauth.status(A, 's'), 'connected');
  assert.equal(creds.oauth.connected(A, 's'), true);
  assert.equal(creds.oauth.status(A, 'r'), 'needs-reauth');
  assert.equal(creds.oauth.connected(A, 'r'), false);
  assert.equal(creds.oauth.status(B, 's'), 'disconnected', 'another account is not connected');
  assert.equal(creds.oauth.status(null, 's'), 'disconnected');
  assert.equal(creds.keys.hasKey(B, 'k'), true);
  assert.equal(creds.keys.hasKey(A, 'k'), false, 'another account\'s key is not mine');
  assert.equal(creds.keys.hasKey(B, 'other'), false);
  const first = creds.signal();
  // A new publication is seen at once (a new file: the signal moves).
  publish({ version: 1, oauth: {}, keys: {} });
  assert.equal(creds.oauth.connected(A, 's'), false);
  assert.equal(creds.keys.hasKey(B, 'k'), false);
  assert.notEqual(creds.signal(), first);
  // Garbage, another version or the wrong shape: never served, never the last good value.
  publish({ version: 1, oauth: { [A]: { s: 'connected' } }, keys: {} });
  assert.equal(creds.oauth.connected(A, 's'), true);
  for (const bad of ['{', 'null', JSON.stringify({ version: 2, oauth: {}, keys: {} }), JSON.stringify({ version: 1, oauth: [], keys: 3 })]) {
    publish(bad);
    assert.equal(creds.oauth.connected(A, 's'), false, bad);
    assert.equal(creds.keys.hasKey(A, 's'), false, bad);
  }
  fs.rmSync(file);
  assert.equal(creds.oauth.connected(A, 's'), false);
  assert.equal(creds.signal(), '', 'a missing file has a stable signal');
});

test('the broker is asked for one call\'s access token or key, a refusal is none, and nothing is cached', async (t) => {
  const { root } = stateFile(t);
  const calls = [];
  const answers = [];
  const broker = new Proxy({}, { get: (_t, op) => async (...args) => { calls.push([op, ...args]); return answers.shift(); } });
  const creds = owned.createMcpCredentials({ broker, dataDir: root });
  answers.push({ ok: true, session: { accessToken: 'AT1', expiresAt: 5, generation: 'g1' } });
  assert.deepEqual(await creds.oauth.session(A, 's'), { accessToken: 'AT1', expiresAt: 5, generation: 'g1' });
  answers.push({ ok: true, session: { accessToken: 'AT2', expiresAt: 6, generation: 'g2' } });
  assert.equal(await creds.oauth.tokenFor(A, 's'), 'AT2', 'asked again: never cached here');
  answers.push({ ok: true, session: { accessToken: 'AT3', expiresAt: null, generation: 'g3' } });
  assert.equal((await creds.oauth.session(A, 's', 'AT2')).accessToken, 'AT3');
  assert.deepEqual(calls, [['mcpSession', A, 's', null, { signal: null }], ['mcpSession', A, 's', null, { signal: null }], ['mcpSession', A, 's', 'AT2', { signal: null }]]);
  answers.push({ ok: false, status: 401, error: 'Sign in again', code: 'reconnect' });
  assert.equal(await creds.oauth.tokenFor(A, 's'), null);
  answers.push({ ok: false, status: 401, error: 'No sign-in', code: 'disconnected' });
  assert.equal(await creds.oauth.session(A, 's'), null, 'no sign-in is null: the account has to sign in');
  assert.equal(await creds.oauth.session('', 's'), null);
  assert.equal(calls.length, 5, 'no account, no call');
  answers.push({ ok: true, marked: true });
  assert.equal(await creds.oauth.reject(A, 's', 'g3'), true);
  answers.push({ ok: false, status: 503 });
  assert.equal(await creds.oauth.reject(A, 's', 'g3'), false);
  assert.equal(calls.at(-1)[0], 'mcpReject', 'a mark is never held up by a Stop: it takes no signal');
  // Keys: one call's headers, or none.
  answers.push({ ok: true, headers: { 'X-Api-Key': 'k' } });
  assert.deepEqual(await creds.keys.headers(A, 'k'), { 'X-Api-Key': 'k' });
  answers.push({ ok: false, status: 401, error: 'no key', code: 'disconnected' });
  assert.equal(await creds.keys.headers(A, 'k'), null);
  assert.equal(await creds.keys.headers(null, 'k'), null);
  // The administrator's calls throw the broker's words, with what the routes read.
  answers.push({ ok: false, status: 409, error: 'needs an app', needsClient: true, issuer: 'https://as.example' });
  await assert.rejects(creds.oauth.start({ userId: A, serverId: 's', serverUrl: 'https://s.example/mcp', challenge: 'c', purpose: 'add' }), (e) => e.status === 409 && e.needsClient === true && e.issuer === 'https://as.example' && e.message === 'needs an app');
  assert.deepEqual(calls.at(-1), ['mcpStart', { user: A, server: 's', serverUrl: 'https://s.example/mcp', challenge: 'c', purpose: 'add' }]);
  answers.push({ ok: true, signIn: 'https://as.example/authorize?x=1' });
  assert.equal(await creds.oauth.start({ userId: A, serverId: 's', serverUrl: 'https://s.example/mcp' }), 'https://as.example/authorize?x=1');
  answers.push({ ok: false, status: 503 });
  await assert.rejects(creds.oauth.forget('s'), (e) => e.status === 503 && /unavailable/.test(e.message));
  answers.push({ ok: true });
  await creds.oauth.forgetUser(A);
  answers.push({ ok: true });
  await creds.keys.set(A, 's', { K: 'v' });
  assert.deepEqual(calls.slice(-2), [['mcpForgetUser', A], ['mcpKeySet', A, 's', { K: 'v' }]]);
  answers.push({ ok: true, client: { manual: true, clientId: 'id', hasSecret: false, redirectUri: 'r', issuer: 'i' } });
  assert.equal((await creds.oauth.clientInfo('s')).clientId, 'id');
  answers.push({ ok: false, status: 400, error: 'Enter the client ID the service gave you (one word, no spaces).' });
  await assert.rejects(creds.oauth.setClient({ serverId: 's', serverUrl: 'u', clientId: ' ' }), /Enter the client ID/);
});

test('the store client speaks the MCP broker protocol: the secret, the ops, refusals as data', async () => {
  const { createClient } = require('./project-store-client.cjs');
  const seen = [];
  const answers = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, token: init.headers['x-noevia-store-token'], body: JSON.parse(init.body) });
    const [status, body] = answers.shift();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const token = 'synthetic-store-token-0123456789abcdef';
  const client = createClient({ port: 4321, token, fetchImpl });
  answers.push([200, { accessToken: 'AT', expiresAt: 5, generation: 'g', refreshToken: 'must-not-pass' }]);
  assert.deepEqual(await client.mcpSession('u', 's', 'AT-old'), { ok: true, session: { accessToken: 'AT', expiresAt: 5, generation: 'g' } });
  assert.deepEqual(seen.pop(), { url: 'http://127.0.0.1:4321/v1/mcp/session', token, body: { user: 'u', server: 's', rejected: 'AT-old' } });
  answers.push([200, { accessToken: 'AT', generation: 'g' }]);
  assert.equal((await client.mcpSession('u', 's')).session.expiresAt, null);
  assert.deepEqual(seen.pop().body, { user: 'u', server: 's' });
  answers.push([401, { error: 'sign in', code: 'reconnect', status: 401 }]);
  assert.deepEqual(await client.mcpSession('u', 's'), { ok: false, status: 401, error: 'sign in', code: 'reconnect' });
  // Only the broker's own refusals carry their status; anything else is "try again".
  answers.push([401, { error: 'unauthorised' }]);
  assert.deepEqual(await client.mcpSession('u', 's'), { ok: false, status: 503 });
  answers.push([404, { error: 'not found' }]);
  assert.deepEqual(await client.mcpKey('u', 's'), { ok: false, status: 503 });
  answers.push([200, { headers: { 'X-Api-Key': 'k' } }]);
  assert.deepEqual(await client.mcpKey('u', 's'), { ok: true, headers: { 'X-Api-Key': 'k' } });
  assert.equal(seen.pop().url, 'http://127.0.0.1:4321/v1/mcp/key');
  answers.push([200, { headers: [] }]);
  assert.equal((await client.mcpKey('u', 's')).ok, false, 'a list is not headers');
  answers.push([409, { error: 'needs an app', status: 409, needsClient: true, issuer: 'https://as.example' }]);
  assert.deepEqual(await client.mcpStart({ user: 'u', server: 's', serverUrl: 'https://s.example/mcp', challenge: 'c', purpose: 'add' }), { ok: false, status: 409, error: 'needs an app', code: undefined, needsClient: true, issuer: 'https://as.example' });
  assert.deepEqual(seen.pop(), { url: 'http://127.0.0.1:4321/v1/mcp/start', token, body: { user: 'u', server: 's', serverUrl: 'https://s.example/mcp', challenge: 'c', purpose: 'add' } });
  answers.push([200, { ok: true }]);
  assert.deepEqual(await client.mcpForgetServer('s'), { ok: true });
  assert.deepEqual(seen.pop().body, { server: 's' });
  answers.push([200, { ok: true }]);
  await client.mcpForgetUser('u');
  assert.deepEqual(seen.pop().body, { user: 'u' });
  answers.push([200, { ok: true }]);
  await client.mcpSetClient({ server: 's', serverUrl: 'https://s.example/mcp', clientId: 'id', clientSecret: 'sec' });
  assert.deepEqual(seen.pop().body, { server: 's', serverUrl: 'https://s.example/mcp', clientId: 'id', clientSecret: 'sec', challenge: '' });
  answers.push([200, { client: null }]);
  assert.deepEqual(await client.mcpClientInfo('s'), { ok: true, client: null });
  answers.push([200, { marked: true }]);
  assert.deepEqual(await client.mcpReject('u', 's', 'g'), { ok: true, marked: true });
  answers.push([200, { ok: true }]);
  await client.mcpKeySet('u', 's', { K: 'v' });
  assert.deepEqual(seen.pop().body, { user: 'u', server: 's', headers: { K: 'v' } });
  // The broker unreachable is "busy", thrown by the transport; the adapter turns it into a null session.
  const down = createClient({ port: 4321, token, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.mcpSession('u', 's'), (e) => e.status === 503);
});

test('L6: a broker that cannot say is "try again", not "sign in first"; "sign in first" is only what the broker says it is', async () => {
  const unusable = (extra = {}) => async () => ({ ok: false, status: 503, ...extra });
  const down = async () => { throw Object.assign(new Error('The project store is busy.'), { status: 503 }); };
  for (const [label, broker] of [
    ['unreachable', { mcpSession: down, mcpKey: down }],
    ['an answer it cannot use', { mcpSession: unusable(), mcpKey: unusable() }],
    ['the broker\'s own transient refusal', { mcpSession: unusable({ error: 'The sign-in to this server could not be refreshed right now. Try again in a moment.', code: 'transient' }), mcpKey: unusable({ error: 'x', code: 'transient' }) }],
    ['a 401 without a code (not the broker\'s)', { mcpSession: async () => ({ ok: false, status: 401 }), mcpKey: async () => ({ ok: false, status: 401 }) }],
  ]) {
    const creds = owned.createMcpCredentials({ broker, dataDir: os.tmpdir() });
    const trouble = (e) => e.transient === true && e.code === 'MCP_BROKER_UNAVAILABLE' && e.status === 503 && !/sign in first/i.test(e.message);
    await assert.rejects(creds.oauth.session(A, 's'), trouble, label);
    await assert.rejects(creds.oauth.tokenFor(A, 's'), trouble, label);
    await assert.rejects(creds.keys.headers(A, 's'), trouble, label);
  }
  // The broker's words reach the caller when it gave some.
  const said = owned.createMcpCredentials({ broker: { mcpSession: unusable({ error: 'Try again in a moment.', code: 'transient' }) }, dataDir: os.tmpdir() });
  await assert.rejects(said.oauth.session(A, 's'), /^Error: Try again in a moment\.$/);
  // "Sign in" / "add your key" is exactly the broker's disconnected and reconnect.
  for (const code of ['disconnected', 'reconnect']) {
    const creds = owned.createMcpCredentials({ broker: { mcpSession: async () => ({ ok: false, status: 401, error: 'x', code }), mcpKey: async () => ({ ok: false, status: 401, error: 'x', code }) }, dataDir: os.tmpdir() });
    assert.equal(await creds.oauth.session(A, 's'), null, code);
    assert.equal(await creds.keys.headers(A, 's'), null, code);
  }
  // A mark is soft: it never throws.
  const soft = owned.createMcpCredentials({ broker: { mcpReject: down }, dataDir: os.tmpdir() });
  assert.equal(await soft.oauth.reject(A, 's', 'g'), false);
});

test('L6: the chat\'s signal reaches the broker call, and a Stop is an AbortError, not an outage', async () => {
  const seen = [];
  const stopped = new AbortController();
  const broker = {
    mcpSession: async (_u, _s, _r, opts) => { seen.push(opts.signal); return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))); },
    mcpKey: async (_u, _s, opts) => { seen.push(opts.signal); throw new Error('boom'); },
  };
  const creds = owned.createMcpCredentials({ broker, dataDir: os.tmpdir() });
  const pending = creds.oauth.session(A, 's', 'old', { signal: stopped.signal });
  stopped.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError' && e.code === 'ABORT_ERR' && e.transient !== true);
  assert.equal(seen[0], stopped.signal);
  // A failure while the signal has fired is the Stop; the same failure with a live signal is the outage.
  await assert.rejects(creds.keys.headers(A, 's', { signal: stopped.signal }), (e) => e.name === 'AbortError');
  await assert.rejects(creds.keys.headers(A, 's', { signal: new AbortController().signal }), (e) => e.transient === true);
});

test('L6: the store client lets the caller\'s signal cancel a broker call promptly, and says so', async () => {
  const { createClient } = require('./project-store-client.cjs');
  const token = 'synthetic-store-token-0123456789abcdef';
  let signalSeen;
  const hang = async (_url, init) => { signalSeen = init.signal; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
  const client = createClient({ port: 4321, token, fetchImpl: hang });
  const stop = new AbortController();
  const started = Date.now();
  const pending = client.mcpSession('u', 's', null, { signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(pending, (e) => e.name === 'AbortError' && e.code === 'ABORT_ERR');
  assert.ok(Date.now() - started < 5000, 'cancelled at the Stop, not at the 45 s deadline');
  assert.equal(signalSeen.aborted, true);
  // Without a caller signal the deadline still applies (a signal exists and is not aborted).
  let plain;
  await createClient({ port: 4321, token, fetchImpl: async (_u, init) => { plain = init.signal; return new Response('{}', { status: 200 }); } }).mcpKey('u', 's');
  assert.ok(plain instanceof AbortSignal && plain.aborted === false);
  // A refusal from the broker with its status (the wire `status`) is data; the same without it is "try again".
  const answer = (status, body) => createClient({ port: 4321, token, fetchImpl: async () => new Response(JSON.stringify(body), { status }) });
  assert.deepEqual(await answer(400, { error: 'invalid user or server', status: 400 }).mcpKey('u', 's'), { ok: false, status: 400, error: 'invalid user or server', code: undefined });
  assert.deepEqual(await answer(400, { error: 'invalid user or server' }).mcpKey('u', 's'), { ok: false, status: 503 });
});
