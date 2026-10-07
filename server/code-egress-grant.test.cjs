// Signed egress grants (#926, docs/egress-grant-contract.md): the web side mints exactly the bytes
// noevia-rs verifies. The vectors file is shared with noevia-rs crates/egress (identical copy).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { mintGrant, grantHosts, createRustEgressClient, startEgressFromEnv, GRANT_KEY_LABEL } = require('./code-egress.cjs');
const vectors = require('../contracts/egress-grant.v1.vectors.json');
const schema = require('../contracts/egress-grant.v1.schema.json');

const KEY = Buffer.from(vectors.keyHex, 'hex');

test('every valid vector mints byte for byte', () => {
  assert.equal(vectors.contract, 'egress-grant');
  assert.equal(vectors.version, 1);
  assert.ok(vectors.valid.length >= 4);
  for (const v of vectors.valid) {
    const token = mintGrant(KEY, v.grant);
    assert.equal(token, v.token, v.name);
    const [prefix, body] = token.split('.');
    assert.equal(prefix, 'ngr1');
    assert.equal(Buffer.from(body, 'base64url').toString('utf8'), v.payload, v.name);
    // The canonical payload satisfies the published schema's key set and order.
    assert.deepEqual(Object.keys(JSON.parse(v.payload)), schema.required, v.name);
  }
});

test('invalid vectors never equal a token the web would mint for the same grant', () => {
  const minted = new Set(vectors.valid.map((v) => v.token));
  for (const v of vectors.invalid) assert.ok(!minted.has(v.token) || v.error === 'Expired' || v.error === 'NotYetValid', v.name);
});

test('grantHosts normalises like hostAllowed and refuses what the proxy would', () => {
  assert.deepEqual(grantHosts(['Registry.NPMjs.example.', '.pypi.example', 'registry.npmjs.example', '']), ['registry.npmjs.example', 'pypi.example']);
  for (const bad of ['*.example', 'exa mple.test', 'a..b', 'host:443', '[::1]']) assert.throws(() => grantHosts([bad]), /not a domain/, bad);
  assert.throws(() => grantHosts(Array.from({ length: 65 }, (_, i) => `h${i}.example`)), /64/);
});

test('the Rust client mints a grant per task and posts a signed revoke when it ends', async () => {
  const posts = [], logs = [];
  let t = 1_800_000_000_000;
  const client = createRustEgressClient({ key: KEY, endpoint: 'egress-rs:8040', now: () => t, ttlMs: 60_000,
    lifetimeMs: 3_600_000, log: (e) => logs.push(e), post: async (endpoint, token) => { posts.push({ endpoint, token }); return 204; } });
  assert.equal(client.endpoint, 'egress-rs:8040');
  assert.equal(typeof client.activity, 'undefined'); // harness checks typeof before calling it
  const g1 = client.grant({ taskId: 'task-1', domains: ['Example.org'] });
  assert.deepEqual(g1.domains, ['example.org']);
  const payload = JSON.parse(Buffer.from(g1.token.split('.')[1], 'base64url').toString('utf8'));
  assert.deepEqual({ ...payload, nonce: '' }, { v: 1, act: 'grant', task: 'task-1', hosts: ['example.org'], iat: t, exp: t + 3_600_000, idle: 60_000, nonce: '' });
  assert.match(payload.nonce, /^[A-Za-z0-9_-]{22}$/);
  // The MAC is HMAC-SHA256 over everything before the last dot.
  const [signed, tag] = [g1.token.slice(0, g1.token.lastIndexOf('.')), g1.token.slice(g1.token.lastIndexOf('.') + 1)];
  assert.equal(tag, crypto.createHmac('sha256', KEY).update(signed).digest('base64url'));
  // A re-grant in the same millisecond still moves iat forward, so the proxy sees it as newer.
  const g2 = client.grant({ taskId: 'task-1', domains: ['example.org'] });
  assert.ok(JSON.parse(Buffer.from(g2.token.split('.')[1], 'base64url')).iat > payload.iat);
  assert.notEqual(g1.token, g2.token);
  assert.throws(() => client.grant({ taskId: 'task-1', domains: [] }), /at least one domain/);
  assert.throws(() => client.grant({ taskId: 'bad id', domains: ['example.org'] }), /taskId/);

  assert.equal(client.revoke('task-1'), 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, 'egress-rs:8040');
  const rv = JSON.parse(Buffer.from(posts[0].token.split('.')[1], 'base64url'));
  assert.equal(rv.act, 'revoke');
  assert.deepEqual(rv.hosts, []);
  assert.ok(rv.iat > JSON.parse(Buffer.from(g2.token.split('.')[1], 'base64url')).iat);
  assert.deepEqual(logs, []);
});

const settle = () => new Promise((r) => setTimeout(r, 30));

test('a failed revoke is retried and logged only after the last attempt, without the token', async () => {
  const logs = [], tokens = [];
  const client = createRustEgressClient({ key: KEY, endpoint: 'egress-rs-code:8040', log: (e) => logs.push(e), revokeDelaysMs: [5, 10],
    post: async (_e, token) => { tokens.push(token); throw Object.assign(Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
  client.revoke('task-9');
  await settle();
  assert.equal(tokens.length, 3);
  assert.equal(new Set(tokens).size, 1, 'the same signed revoke is resent');
  assert.deepEqual(logs, [{ event: 'egress.revoke_failed', taskId: 'task-9', attempts: 3, error: 'ECONNREFUSED' }]);
  assert.ok(!JSON.stringify(logs).includes(tokens[0]));
});

test('a revoke that fails once then succeeds logs nothing', async () => {
  const logs = [];
  let calls = 0;
  const client = createRustEgressClient({ key: KEY, endpoint: 'egress-rs-code:8040', log: (e) => logs.push(e), revokeDelaysMs: [5, 10],
    post: async () => { calls++; if (calls === 1) throw Object.assign(Error('reset'), { code: 'ECONNRESET' }); return 204; } });
  client.revoke('task-8');
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(logs, []);
  // A non-204 answer counts as a failure too.
  const statuses = [];
  const c2 = createRustEgressClient({ key: KEY, endpoint: 'x:1', log: (e) => statuses.push(e), revokeDelaysMs: [1],
    post: async () => 503 });
  c2.revoke('task-7');
  await settle();
  assert.deepEqual(statuses, [{ event: 'egress.revoke_failed', taskId: 'task-7', attempts: 2, status: 503 }]);
});

test('default grant lifetime is 2 h, configurable, capped at 24 h', () => {
  const t = 1_800_000_000_000;
  const exp = (opts) => JSON.parse(Buffer.from(createRustEgressClient({ key: KEY, endpoint: 'x:1', now: () => t, ...opts })
    .grant({ taskId: 'a', domains: ['example.org'] }).token.split('.')[1], 'base64url')).exp - t;
  assert.equal(exp({}), 2 * 3_600_000);
  assert.equal(exp({ lifetimeMs: 30 * 60_000 }), 30 * 60_000);
  assert.equal(exp({ lifetimeMs: 48 * 3_600_000 }), 24 * 3_600_000);
});

test('CODE_EGRESS_IMPL=rust writes the derived key file and returns the client; node stays the default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-grant-'));
  const derived = [];
  const secrets = { derive: (label, bytes) => { derived.push([label, bytes]); return Buffer.alloc(32, 7); } };
  try {
    const file = path.join(dir, 'keys', 'grant.key');
    const logs = [];
    const gid = String(process.getgid()); // a group this (non-root) test may chown to
    const env = { CODE_EGRESS_IMPL: 'rust', CODE_EGRESS_PORT: '8040', CODE_EGRESS_GRANT_KEY_FILE: file, CODE_EGRESS_KEY_GID: gid };
    const client = startEgressFromEnv(env, { secrets, log: (e) => logs.push(e) });
    assert.equal(client.impl, 'rust');
    assert.equal(client.endpoint, 'egress-rs-code:8040');
    assert.deepEqual(derived, [[GRANT_KEY_LABEL, 32]]);
    assert.equal(GRANT_KEY_LABEL, 'code-egress-grant');
    assert.equal(fs.readFileSync(file, 'utf8'), `${'07'.repeat(32)}\n`);
    const st = fs.statSync(file);
    assert.equal(st.mode & 0o777, 0o440, 'owner + group read only, never world-readable');
    assert.equal(st.gid, Number(gid));
    // Rewritten on restart (atomic replace over the read-only previous file).
    startEgressFromEnv(env, { secrets });
    assert.equal(fs.statSync(file).mode & 0o777, 0o440);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['grant.key'], 'no temp file left behind');
    assert.throws(() => startEgressFromEnv({ ...env, CODE_EGRESS_KEY_GID: '' }, { secrets }), /KEY_GID/);
    derived.length = 1;
    assert.ok(!JSON.stringify(logs).includes('0707'), 'key material must not be logged');
    assert.throws(() => startEgressFromEnv({ CODE_EGRESS_IMPL: 'rust', CODE_EGRESS_PORT: '8040' }, { secrets }), /GRANT_KEY_FILE/);
    assert.throws(() => startEgressFromEnv({ CODE_EGRESS_IMPL: 'rust', CODE_EGRESS_PORT: '8040', CODE_EGRESS_GRANT_KEY_FILE: file }), /secret store/);
    // Default and explicit `node` keep the in-process proxy (nothing changes in production).
    const node = startEgressFromEnv({ CODE_EGRESS_PORT: '38750', CODE_EGRESS_BIND: '127.0.0.1' }, { secrets });
    try { assert.ok(node.server); assert.equal(node.impl, undefined); assert.equal(node.endpoint, 'egress:38750'); }
    finally { await new Promise((r) => node.server.listening ? r() : node.server.once('listening', r)); node.server.close(); }
    assert.equal(derived.length, 1, 'node mode derives no grant key');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
