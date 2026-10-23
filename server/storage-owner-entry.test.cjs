'use strict';
// Product request-entry controls. Import the complete original index and use its
// exported handler. Rust CI orchestration/mutation qualification is separate.
// This source has not been executed; retain the disposable fixture on failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');

// sbstndalton/noevia#1071: GET /api/integrations/storage is the Rust front's with no switch of its
// own; the deployment below is the live one (native auth), with no storage selector at all.
const OWNER = {
  NOEVIA_FRONT: 'rust',
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Complete synthetic SQL state, including schema; assertion diagnostics contain
// its digest rather than rows or credentials. Reads use the actual auth database.
function sqlDigest(db) {
  return db.transaction(() => {
    const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const tables = schema.map(({ name }) => {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/, 'M4_ENTRY/schema_identifier');
      const rows = db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort();
      return { name, rows };
    });
    return digest(JSON.stringify({ schema, tables }));
  })();
}

// Finite synthetic namespace/content observation, including DB/WAL/SHM and keys.
// Excludes access times; no deletion, symlink following or mutation is performed.
function fileManifest(root) {
  const rows = [];
  let bytes = 0;
  function visit(current, depth) {
    assert.ok(depth <= 8 && rows.length < 2048, 'M4_ENTRY/fixture_namespace_cap');
    const stat = fs.lstatSync(current);
    assert.ok(stat.isDirectory() || stat.isFile(), 'M4_ENTRY/fixture_file_kind');
    const row = { path: path.relative(root, current), mode: stat.mode, ino: stat.ino, dev: stat.dev, nlink: stat.nlink };
    if (stat.isFile()) {
      assert.equal(stat.nlink, 1, 'M4_ENTRY/fixture_singleton');
      assert.ok(stat.size <= 8 * 1024 * 1024, 'M4_ENTRY/fixture_file_cap');
      bytes += stat.size;
      assert.ok(bytes <= 16 * 1024 * 1024, 'M4_ENTRY/fixture_total_cap');
      row.size = stat.size;
      row.sha256 = digest(fs.readFileSync(current));
    }
    rows.push(row);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), depth + 1);
    }
  }
  visit(root, 0);
  return rows;
}

function response() {
  const chunks = [], headers = {};
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
  res.writeHead = (status, values = {}) => {
    res.statusCode = status;
    res.headersSent = true;
    for (const [name, value] of Object.entries(values)) res.setHeader(name, value);
    return res;
  };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  return { res, finished, result() { return { status: res.statusCode, headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } };
}

function request(target, { method = 'GET', host = 'localhost', cookie, hostile = false } = {}) {
  const req = Readable.from([]);
  req.url = target;
  req.method = method;
  req.headers = { host, ...(cookie ? { cookie } : {}) };
  const reads = [];
  if (hostile) {
    for (const name of ['cookie', 'authorization']) {
      Object.defineProperty(req.headers, name, { get() { reads.push(name); assert.fail('M4_ENTRY/pre_identity'); } });
    }
    Object.defineProperty(req, 'socket', { get() { reads.push('socket'); assert.fail('M4_ENTRY/pre_identity'); } });
  } else {
    req.socket = { remoteAddress: '127.0.0.1' };
  }
  return { req, reads };
}

function ownedReply(reply) {
  assert.equal(reply.status, 503, 'M4_ENTRY/owned_status');
  assert.deepEqual(reply.body, { error: 'Storage metadata reads are owned by the Rust front.', code: 'RUST_STORAGE_READS_OWNED' }, 'M4_ENTRY/owned_body');
  assert.equal(reply.headers['content-type'], 'application/json', 'M4_ENTRY/content_type');
  assert.equal(reply.headers['cache-control'], 'no-store', 'M4_ENTRY/no_store');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff', 'M4_ENTRY/security_headers');
  assert.equal(reply.headers['x-frame-options'], 'DENY', 'M4_ENTRY/security_headers');
  assert.equal(reply.headers['referrer-policy'], 'same-origin', 'M4_ENTRY/security_headers');
  assert.ok(reply.headers['content-security-policy'].includes("frame-ancestors 'none'"), 'M4_ENTRY/security_headers');
}

test('M4_ENTRY/complete_original_index', { concurrency: false }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-storage-owner-entry-'));
  const env = {
    ...OWNER, UI_DATA_DIR: dir, PUBLIC_ORIGIN: 'http://localhost', LEGACY_AUTH_COMPAT: 'false',
    DIARY_AUTH_TOKEN: 'synthetic-sidecar-token', UI_AUTH_TOKEN: '', MODEL_MANAGER_KIND: 'none',
    MODEL_LOADER_URL: '', CODE_EGRESS_PORT: '0', COWORK_CODE_NET_ADDR: '',
    MCP_INTERNAL_PORT: '0', MCP_SERVERS: '',
    SECRETS_KEY_PREVIOUS: '', CORPUS_BACKEND: 'webdav', WEBDAV_BASE_URL: 'https://synthetic.invalid/dav',
    WEBDAV_USERNAME: 'synthetic', WEBDAV_PASSWORD: 'synthetic-migration-secret', CORPUS_ROOT: 'synthetic',
  };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  const realFetch = global.fetch;
  let auth;
  try {
    Object.assign(process.env, env);
    global.fetch = async () => { assert.fail('M4_ENTRY/unexpected_network'); };
    const { createSecretStore } = require('./secrets.cjs');
    const { createAuth } = require('./auth.cjs');
    const secrets = createSecretStore(dir);
    // The genuine auth constructor (migrations), before index installs its own. No fake
    // authenticate/getStorage/saveStorage implementation.
    const realWarn = console.warn;
    try {
      console.warn = (...args) => {
        if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('FIRST-RUN SETUP CODE: ')) {
          realWarn.call(console, 'FIRST-RUN SETUP CODE: [redacted synthetic fixture]');
          return;
        }
        realWarn.apply(console, args);
      };
      auth = createAuth({ dataDir: dir, publicOrigin: 'http://localhost', secrets });
    } finally { console.warn = realWarn; }
    // First-run setup is the Rust front's (#1071): the owner and its session are seeded directly.
    const { id, cookie } = require('../tests/server/seed-account.cjs').seedAccount(dir, {
      username: 'synthetic-owner', displayName: 'Synthetic', diaryEnabled: true, publicOrigin: 'http://localhost',
    });
    assert.equal(auth.authenticate(request('/api/integrations/storage', { cookie }).req)?.user.id, id, 'M4_ENTRY/valid_identity');
    // Deliberately legacy plaintext/local state: if an early refusal moves after
    // migration, actual getStorage can reseal and saveStorage can migrate it.
    auth.db.prepare('INSERT INTO storage_connections(user_id,kind,secret,updated_at) VALUES(?,?,?,?)').run(id, 'local', 'synthetic-legacy-secret', 1);
    const workspace = path.join(dir, 'users', id);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workspace, 'migration.json'), '{"version":1,"source":"synthetic"}', { flag: 'wx', mode: 0o600 });
    // #1071: Node saves projects.json / free-chats.json only through the Rust project store.
    require('../tests/server/project-store-server.cjs').installProjectStore(dir);
    const { handleRequest } = require('./index.cjs');
    async function invoke(target, options) {
      const input = request(target, options), output = response();
      await assert.doesNotReject(() => handleRequest(input.req, output.res), 'M4_ENTRY/pre_identity');
      await output.finished;
      return { ...output.result(), reads: input.reads };
    }

    await t.test('M4_ENTRY/pre_identity_normalized_get', async () => {
      for (const target of ['/api/integrations/storage', '/api/integrations/storage?q=synthetic', '/api/integrations/./storage', '/api/integrations/x/../storage', '/api/integrations/%2e/storage']) {
        const reply = await invoke(target, { hostile: true });
        ownedReply(reply);
        assert.deepEqual(reply.reads, [], 'M4_ENTRY/pre_identity');
        assert.equal(reply.headers['x-noevia-api'], '1', 'M4_ENTRY/api_marker');
      }
      ownedReply(await invoke('/api/integrations/storage', { hostile: true, host: 'a b[' }));
    });

    await t.test('M4_ENTRY/malformed_target_before_identity', async () => {
      for (const target of ['//[', 'http://[', '//a b']) {
        const reply = await invoke(target, { hostile: true });
        assert.equal(reply.status, 400, 'M4_ENTRY/malformed_status');
        assert.deepEqual(reply.body, { error: 'invalid URL' }, 'M4_ENTRY/malformed_body');
        assert.equal(reply.headers['cache-control'], 'no-store', 'M4_ENTRY/no_store');
        assert.deepEqual(reply.reads, [], 'M4_ENTRY/pre_identity');
      }
    });

    await t.test('M4_ENTRY/valid_identity_no_workspace_or_migration_effect', async () => {
      const beforeSql = sqlDigest(auth.db), beforeFiles = fileManifest(dir);
      ownedReply(await invoke('/api/integrations/storage', { cookie }));
      assert.equal(sqlDigest(auth.db), beforeSql, 'M4_ENTRY/pre_migration_sql');
      assert.deepEqual(fileManifest(dir), beforeFiles, 'M4_ENTRY/pre_workspace_files');
      assert.equal(auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get(id).secret, 'synthetic-legacy-secret', 'M4_ENTRY/no_reseal');
    });

    await t.test('M4_ENTRY/method_and_path_neighbors_keep_auth_gate', async () => {
      for (const method of ['HEAD', 'PUT', 'POST', 'OPTIONS', 'DELETE', 'get']) {
        assert.equal((await invoke('/api/integrations/storage', { method })).status, 401, 'M4_ENTRY/method_not_owned');
      }
      for (const target of ['/api/integrations/storage/', '/api/integrations/storage/files', '/api/integrations/%73torage', '/api/integrations/storage-other']) {
        assert.equal((await invoke(target)).status, 401, 'M4_ENTRY/path_not_owned');
      }
    });

    await t.test('M4_ENTRY/actual_factory_defense_before_reseal', async () => {
      const { createStorageRoutes } = require('./routes/storage.cjs');
      const { json } = require('./http.cjs');
      const routes = createStorageRoutes({ json, authService: auth });
      const input = request('/api/integrations/storage', { cookie });
      const authn = auth.authenticate(input.req);
      assert.equal(authn?.user.id, id, 'M4_ENTRY/valid_identity');
      const beforeSql = sqlDigest(auth.db), output = response();
      assert.equal(await routes(input.req, output.res, { path: '/api/integrations/storage', authn }), true, 'M4_ENTRY/factory_handled');
      await output.finished;
      assert.equal(output.result().status, 503, 'M4_ENTRY/factory_before_storage');
      assert.deepEqual(output.result().body, { error: 'Storage metadata reads are owned by the Rust front.', code: 'RUST_STORAGE_READS_OWNED' }, 'M4_ENTRY/factory_body');
      assert.equal(sqlDigest(auth.db), beforeSql, 'M4_ENTRY/factory_no_reseal');
    });

    await t.test('M4_ENTRY/retired_selector_values_change_nothing', async () => {
      try {
        for (const value of [undefined, '', '0', '1', 'true']) {
          if (value === undefined) delete process.env.NOEVIA_RUST_STORAGE_READS;
          else process.env.NOEVIA_RUST_STORAGE_READS = value;
          const beforeSql = sqlDigest(auth.db);
          ownedReply(await invoke('/api/integrations/storage', { cookie }));
          assert.equal(sqlDigest(auth.db), beforeSql, 'M4_ENTRY/no_reseal');
        }
      } finally { delete process.env.NOEVIA_RUST_STORAGE_READS; }
    });
  } finally {
    auth?.db.close();
    global.fetch = realFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // Retain synthetic files. The index's private database remains process-owned.
  }
});
