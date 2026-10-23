'use strict';
// rust-auth.cjs on a stand-in database (no native modules): which statements the guard refuses,
// that reads and exempt writers still run, that the guard is unconditional (sbstndalton/noevia#1071:
// no switch, no environment), and which sign-in and account routes Node refuses as the Rust front's.
// auth-rust-mode.test.cjs covers the same on createAuth's real database and the real router.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createRustAuthGuard, ownedRoute, refuseOwned, OWNED_ROUTES, ROUTE_REFUSAL, writeTarget, writeTargets, OWNED_TABLES, FRONT_SETTING_KEYS } = require('./rust-auth.cjs');

function fakeDb() {
  const ran = [];
  const stmt = (sql) => {
    const s = {
      sql,
      run: (...args) => { ran.push(['run', sql, args]); return { changes: 1 }; },
      get: (...args) => { ran.push(['get', sql, args]); return undefined; },
      all: (...args) => { ran.push(['all', sql, args]); return []; },
      iterate: (...args) => { ran.push(['iterate', sql, args]); return [][Symbol.iterator](); },
      bind() { return s; },
      pluck() { return s; },
    };
    return s;
  };
  return { ran, prepare: (sql) => stmt(sql), exec: (sql) => { ran.push(['exec', sql, []]); } };
}

const on = () => createRustAuthGuard();

test('#1071: the guard is unconditional: no option or environment turns it off', () => {
  const saved = { ...process.env };
  try {
    for (const env of [{}, { NOEVIA_RUST_AUTH: '0' }, { NOEVIA_RUST_AUTH: '1', NOEVIA_FRONT: 'node' }, { NOEVIA_RUST_AUTH_CONFIRMED: '' }]) {
      for (const k of ['NOEVIA_RUST_AUTH', 'NOEVIA_RUST_AUTH_CONFIRMED', 'NOEVIA_FRONT']) delete process.env[k];
      Object.assign(process.env, env);
      for (const guard of [createRustAuthGuard(), createRustAuthGuard({ enabled: false })]) {
        assert.equal(guard.enabled, true, JSON.stringify(env));
        const raw = fakeDb();
        const original = raw.prepare;
        const db = guard.install(raw);
        assert.notEqual(db.prepare, original, 'installed');
        assert.throws(() => db.prepare('DELETE FROM sessions').run(), (e) => e.code === 'RUST_AUTH_OWNED' && e.status === 503);
        assert.throws(() => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin',?)").run('x'), (e) => e.code === 'RUST_AUTH_OWNED');
      }
    }
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  // No source decides it from the environment any more: the switch, its confirmation and the
  // front selector are not read by the guard or by index.cjs to build it.
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'rust-auth.cjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /process\.env|NOEVIA_RUST_AUTH|NOEVIA_FRONT/);
  assert.equal(require('./rust-auth.cjs').enabledFrom, undefined);
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /createRustAuthGuard\(\)/);
  assert.doesNotMatch(index.replace(/^\s*\/\/.*$/gm, ''), /NOEVIA_RUST_AUTH/);
});

// noevia-rs contracts/http/routes.toml, the owner = "rust" sign-in and account entries with the
// methods Rust answers (a method not listed stays Node's).
const RUST_ROUTES = [
  ['/api/account/instructions', null], ['/api/account/memory', null], ['/api/account/preferences', null],
  ['/api/admin/invitations', ['POST']], ['/api/admin/users', ['GET']], ['/api/admin/users/u1/disabled', ['PUT']], ['/api/admin/users/u1/recovery', ['POST']],
  ['/api/auth/device/approve', null], ['/api/auth/device/code', null], ['/api/auth/device/token', null], ['/api/auth/device/lookup', null],
  ['/api/auth/devices', null], ['/api/auth/devices/g1', null], ['/api/auth/invitations/accept', ['POST']],
  ['/api/auth/login/passkey/options', ['POST']], ['/api/auth/login/passkey/verify', ['POST']], ['/api/auth/login/password', ['POST']],
  ['/api/auth/logout', ['POST']], ['/api/auth/passkeys/register/options', ['POST']], ['/api/auth/passkeys/register/verify', ['POST']],
  ['/api/auth/passkeys/k1', ['DELETE', 'PATCH']], ['/api/auth/recovery/complete', ['POST']], ['/api/auth/session', ['GET']],
  ['/api/auth/sessions/s1', ['DELETE']], ['/api/profile', ['GET', 'PATCH']], ['/api/profile/app-passwords', ['GET', 'POST']],
  ['/api/profile/app-passwords/0123456789abcdef0123456789abcdef', ['DELETE']], ['/api/profile/appearance', null],
  ['/api/profile/features', ['PUT']], ['/api/profile/onboarding', ['POST']], ['/api/setup/complete', ['POST']], ['/api/setup/status', ['GET']],
];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

test('#1071: Node refuses exactly the sign-in and account routes the Rust front answers', () => {
  assert.equal(OWNED_ROUTES.length, 23);
  for (const [p, methods] of RUST_ROUTES) {
    for (const m of METHODS) assert.equal(ownedRoute(m, p), methods === null || methods.includes(m), `${m} ${p}`);
  }
  // What stays Node's: account deletion, Settings -> Web address and Sharing, the Diary connectors,
  // retention, the feature switches, the device approval page, and look-alike paths.
  for (const [m, p] of [
    ['DELETE', '/api/admin/users/u1'], ['GET', '/api/admin/web-address'], ['POST', '/api/admin/web-address'], ['POST', '/api/admin/secrets/rotate'],
    ['GET', '/api/admin/features'], ['GET', '/api/profile/sharing'], ['PUT', '/api/profile/sharing'], ['GET', '/api/profile/diary-connectors'],
    ['GET', '/api/account/retention'], ['PUT', '/api/account/retention'], ['GET', '/device'], ['GET', '/api/auth/sessionx'], ['GET', '/api/profile/'],
    ['GET', '/api/auth/session/x'], ['DELETE', '/api/auth/passkeys/a/b'], ['GET', '/api/workspace'], ['GET', '/api/auth/status'],
  ]) assert.equal(ownedRoute(m, p), false, `${m} ${p}`);
  const sent = [];
  const json = (_res, status, body) => sent.push({ status, body });
  assert.equal(refuseOwned({ method: 'POST' }, {}, '/api/auth/login/password', json), true);
  assert.deepEqual(sent.pop(), { status: 503, body: ROUTE_REFUSAL });
  assert.deepEqual(ROUTE_REFUSAL, { error: 'Sign-in and the account are owned by the Rust front.', code: 'RUST_AUTH_OWNED' });
  assert.equal(refuseOwned({ method: 'GET' }, {}, '/api/workspace', json), false);
  assert.equal(sent.length, 0);
});

test('write targets are read off the statement', () => {
  assert.deepEqual(writeTarget('INSERT INTO sessions(id_hash) VALUES(?)'), { table: 'sessions', key: null });
  assert.deepEqual(writeTarget('  insert or replace into Users VALUES(?)'), { table: 'users', key: null });
  assert.deepEqual(writeTarget('UPDATE passkeys SET counter=?'), { table: 'passkeys', key: null });
  assert.deepEqual(writeTarget('DELETE FROM device_grants WHERE id=?'), { table: 'device_grants', key: null });
  assert.deepEqual(writeTarget('REPLACE INTO challenges VALUES(?)'), { table: 'challenges', key: null });
  assert.deepEqual(writeTarget("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin',?)"), { table: 'settings', key: 'public_origin' });
  assert.deepEqual(writeTarget("DELETE FROM settings WHERE key='setup_code_hash' AND value=?"), { table: 'settings', key: 'setup_code_hash' });
  assert.deepEqual(writeTarget('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)'), { table: 'settings', key: null });
  assert.equal(writeTarget('SELECT * FROM sessions'), null);
  assert.equal(writeTarget('CREATE TABLE IF NOT EXISTS app_passwords(id TEXT)'), null);
});

test('while on, owned writes throw 503 when they run; reads and other tables do not', () => {
  const guard = on();
  const db = guard.install(fakeDb());
  // Preparing is fine (modules prepare at construction); running is refused.
  const write = db.prepare('UPDATE sessions SET last_seen_at=? WHERE id_hash=?');
  for (const method of ['run', 'get', 'all', 'iterate']) {
    assert.throws(() => write[method](1, 'h'), (e) => e.status === 503 && e.code === 'RUST_AUTH_OWNED', method);
  }
  assert.throws(() => write.bind(1, 'h').run(), (e) => e.code === 'RUST_AUTH_OWNED', 'bind() keeps the guard');
  for (const t of OWNED_TABLES) assert.throws(() => db.prepare(`DELETE FROM ${t}`).run(), (e) => e.code === 'RUST_AUTH_OWNED', t);
  db.prepare('SELECT * FROM sessions WHERE id_hash=?').get('h');
  db.prepare('INSERT INTO audit_events(action,created_at) VALUES(?,?)').run('x', 1);
  db.prepare('INSERT INTO storage_connections(user_id) VALUES(?)').run('u');
  db.prepare('DELETE FROM diary_connectors WHERE user_id=?').run('u');
  db.exec('CREATE TABLE IF NOT EXISTS x(y)');
  assert.throws(() => db.exec('CREATE TABLE a(b); DELETE FROM sessions'), (e) => e.code === 'RUST_AUTH_OWNED');
  assert.ok(!db.ran.some(([, sql]) => /sessions/.test(sql) && !/SELECT/.test(sql)), 'no owned write reached the database');
});

test('settings: only the owned keys, literal or bound', () => {
  const db = on().install(fakeDb());
  for (const key of ['setup_code_hash', 'public_origin', 'passkey_decoy_key']) {
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('${key}',?)`).run('v'), (e) => e.code === 'RUST_AUTH_OWNED', key);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, 'v'), (e) => e.code === 'RUST_AUTH_OWNED', key);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run([key, 'v']), (e) => e.code === 'RUST_AUTH_OWNED', key);
  }
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('feature:nativeClientAuth', 'false');
  // The front's own keys (#1071) are refused with their own codes.
  for (const [key, [, code]] of Object.entries(FRONT_SETTING_KEYS)) {
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('${key}',?)`).run('v'), (e) => e.code === code, key);
  }
});

test('exempt writers run, and only inside exempt()', () => {
  const guard = on();
  const db = guard.install(fakeDb());
  const del = db.prepare('DELETE FROM users WHERE id=?');
  assert.equal(guard.exempt(() => del.run('u').changes), 1);
  assert.throws(() => del.run('u'), (e) => e.code === 'RUST_AUTH_OWNED');
  // Nested and throwing exemptions restore the guard.
  assert.throws(() => guard.exempt(() => guard.exempt(() => { throw new Error('boom'); })), /boom/);
  assert.throws(() => del.run('u'), (e) => e.code === 'RUST_AUTH_OWNED');
});

test('write detection: CTE writes, schema-qualified and quoted names, REPLACE/UPSERT, multi-target', () => {
  const owned = (sql) => writeTargets(sql).some((t) => OWNED_TABLES.has(t.table));
  for (const sql of [
    'WITH x AS (SELECT 1) INSERT INTO sessions(id_hash) SELECT 1 FROM x',
    'WITH x AS (SELECT id FROM users) UPDATE users SET disabled_at=1 WHERE id IN (SELECT id FROM x)',
    'WITH RECURSIVE x(n) AS (SELECT 1) DELETE FROM sessions WHERE 1',
    'INSERT INTO main.users(id) VALUES(?)',
    'UPDATE "main"."users" SET x=1',
    'DELETE FROM `main`.`sessions`',
    'DELETE FROM [passkeys]',
    'INSERT INTO "users" VALUES(1)',
    'REPLACE INTO main.challenges VALUES(?)',
    'UPSERT INTO invitations VALUES(?)',
    'INSERT INTO users(id) VALUES(?) ON CONFLICT(id) DO UPDATE SET x=1',
    'INSERT INTO audit_events(a) VALUES(1); DELETE FROM sessions',
    '/* note */ UPDATE -- c\n sessions SET x=1',
    'INSERT OR IGNORE INTO temp.recoveries VALUES(1)',
    'update   OR  ROLLBACK users set a=1',
  ]) assert.equal(owned(sql), true, sql);
  assert.deepEqual(writeTargets("INSERT OR REPLACE INTO main.settings(key,value) VALUES('public_origin',?)"), [{ table: 'settings', key: 'public_origin' }]);
  for (const sql of [
    'SELECT * FROM users',
    "INSERT INTO audit_events(detail) VALUES('DELETE FROM users')",
    'INSERT INTO diary_connectors(a) VALUES(1) ON CONFLICT(a) DO UPDATE SET b=1',
    'WITH x AS (SELECT 1) INSERT INTO storage_connections SELECT * FROM x',
    '-- DELETE FROM users\nSELECT 1',
    'SELECT updated_at FROM users',
  ]) assert.equal(owned(sql), false, sql);
});

test('while on, CTE and schema-qualified owned writes throw when they run', () => {
  const db = on().install(fakeDb());
  for (const sql of [
    'WITH x AS (SELECT 1) INSERT INTO sessions(id_hash) SELECT 1 FROM x',
    'UPDATE main.users SET disabled_at=1',
    'INSERT INTO audit_events(a) VALUES(1); REPLACE INTO "users" VALUES(1)',
  ]) {
    assert.throws(() => db.prepare(sql).run(), (e) => e.code === 'RUST_AUTH_OWNED', sql);
  }
  assert.throws(() => db.exec('WITH x AS (SELECT 1) DELETE FROM main.sessions'), (e) => e.code === 'RUST_AUTH_OWNED');
});

test('secrets-rotate.cjs\'s separate database handle writes no owned table', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'secrets-rotate.cjs'), 'utf8');
  // Every table the rotation names, and every statement it runs, are checked against the owned list.
  const named = [...src.matchAll(/sqlTable\(db, '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(named.length >= 6);
  for (const t of named) assert.ok(!OWNED_TABLES.has(t), t);
  for (const m of src.matchAll(/prepare\(([`'"])((?:(?!\1)[\s\S])*)\1/g)) {
    for (const target of writeTargets(m[2])) assert.ok(!OWNED_TABLES.has(target.table) || target.table === 'audit_events', m[2]);
  }
});

test('#1071: under native auth the front\'s setting keys are refused in real SQLite, exempt or not, and other keys still write', () => {
  const Database = require('better-sqlite3');
  for (const [key, [, code]] of Object.entries(FRONT_SETTING_KEYS)) {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value); INSERT INTO settings VALUES('${key}','before'),('synthetic_node_key','medium')`);
      const guard = createRustAuthGuard();
      guard.install(db);
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('synthetic_node_key', 'high');
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('synthetic_node_key',?)").run('low');
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='synthetic_node_key'").get().value, 'low');
      const exact = [
        () => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, 'after'),
        () => db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('${key}',?)`).run('after'),
        () => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(key, 'after').run(),
        () => guard.exempt(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, 'after')),
      ];
      for (const attempt of exact) assert.throws(attempt, { code, status: 503 });
      // Ambiguous writes may touch the key: refused too, inside exempt() as well.
      const ambiguous = [
        () => db.prepare('UPDATE settings SET value=? WHERE key=?').run('after', key),
        () => db.prepare("UPDATE settings SET value='after'").run(),
        () => db.exec('DELETE FROM settings'),
        () => db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('synthetic_node_key',?),('${key}',?)`).run('low', 'after'),
        () => db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('${key}', lower(?))`).run('AFTER'),
        () => guard.exempt(() => db.prepare("UPDATE 'settings' SET value='after'").run()),
        () => db.prepare('INSERT OR REPLACE INTO main."settings"(key,value) VALUES(?,?)').run(key, 'after'),
        () => db.prepare("INSERT OR REPLACE INTO 'settings'(key,value) VALUES(?,?)").run(key, 'after'),
        () => db.prepare(`/* synthetic */ INSERT OR REPLACE INTO settings(key,value) VALUES('${key}',?)`).run('after'),
      ];
      for (const attempt of ambiguous) assert.throws(attempt, { status: 503 });
      assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value, 'before', key);
    } finally { db.close(); }
  }
});
test('quoted identifiers are detected without treating string/comment payloads as writes', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE users(id TEXT);CREATE TABLE audit_events(detail TEXT);INSERT INTO users VALUES('synthetic')");
    createRustAuthGuard().install(db);
    assert.throws(() => db.prepare("DELETE FROM 'users'").run(),{code:'RUST_AUTH_OWNED'});
    assert.throws(() => db.exec("SELECT '--'; DELETE FROM 'main'.'users'"),{code:'RUST_AUTH_OWNED'});
    for (const sql of [
      "INSERT INTO audit_events(detail) VALUES('DELETE FROM settings')",
      "INSERT INTO audit_events(detail) VALUES('UPDATE')",
      "INSERT INTO audit_events(detail) VALUES('settings')",
      "INSERT INTO audit_events(detail) VALUES('escaped '' DELETE FROM users -- /*')",
      "/* DELETE FROM 'settings' */ INSERT INTO audit_events(detail) VALUES('safe') -- UPDATE settings",
    ]) {
      assert.deepEqual(writeTargets(sql),[{table:'audit_events',key:null}]);
      db.prepare(sql).run();
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_events').get().n,5);
  } finally { db.close(); }
});

test('auth settings guard refuses unproven writes and retains actual SQLite bindings', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value); INSERT INTO settings VALUES('public_origin','before'),('synthetic_node_key','medium')");
    const guard = createRustAuthGuard(); guard.install(db);
    const before = () => db.prepare('SELECT key,value FROM settings ORDER BY key').all();
    const original = before();
    const attempts = [
      () => db.prepare('UPDATE settings SET value=? WHERE key=?').run('after','public_origin'),
      () => db.prepare('UPDATE settings SET value=?').run('after'),
      () => db.prepare("UPDATE settings SET value='after' WHERE key='public_origin'").run(),
      () => db.prepare('UPDATE settings SET value=@value WHERE key=@key').run({value:'after',key:'public_origin'}),
      () => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(@key,@value)').run({key:'public_origin',value:'after'}),
      () => db.prepare('INSERT OR REPLACE INTO main."settings"(key,value) VALUES(?,?)').run('public_origin','after'),
      () => db.prepare("/* synthetic */ INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin',?)").run('after'),
      () => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('synthetic_node_key',?),('public_origin',?)").run('low','after'),
      () => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin',lower(?))").run('AFTER'),
      () => db.exec("INSERT OR REPLACE INTO settings(key,value) VALUES('synthetic_node_key','low');UPDATE settings SET value='after'"),
      () => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(['public_origin','after']),
      () => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind('public_origin','after').run(),
      () => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(['public_origin','after']).safeIntegers().run(),
      () => db.prepare("DELETE FROM settings WHERE key='public_origin'").run(),
      () => db.exec('DELETE FROM settings'),
      () => db.prepare("INSERT OR REPLACE INTO 'settings'(key,value) VALUES(?,?)").run('public_origin','after'),
      () => db.prepare("UPDATE 'main'.'settings' SET value=? WHERE key=?").run('after','public_origin'),
      () => db.exec("SELECT '--'; UPDATE settings SET value='after'"),
      () => db.exec("SELECT '/*'; UPDATE settings SET value='after'"),
    ];
    for (const attempt of attempts) {
      assert.throws(attempt,{code:'RUST_AUTH_OWNED',status:503}); assert.deepEqual(before(),original);
    }
    const bindings = ['public_origin','after'];
    const bound = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(bindings);
    bindings[0] = 'synthetic_node_key';
    assert.throws(() => bound.run(),{code:'RUST_AUTH_OWNED',status:503}); assert.deepEqual(before(),original);
    // The actual currently supported Node writer forms still work, including bound statements.
    assert.doesNotThrow(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind('synthetic_node_key','high').run());
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('synthetic_node_key',?)").run('low');
    db.prepare("DELETE FROM settings WHERE key='synthetic_node_key' AND value=?").run('low');
    assert.equal(before().length,1);
    // Existing explicitly exempt auth writers (single-key forms) remain available; an unrecognised
    // shape is refused even inside exempt() (it could touch the front's keys, #1071); exceptions
    // restore protection.
    guard.exempt(() => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin',?)").run('exempt'));
    assert.throws(() => guard.exempt(() => db.prepare('UPDATE settings SET value=? WHERE key=?').run('x','public_origin')),{code:'RUST_AUTH_OWNED'});
    assert.throws(() => guard.exempt(() => { throw Error('synthetic'); }),/synthetic/);
    assert.throws(() => db.prepare('UPDATE settings SET value=?').run('after'),{code:'RUST_AUTH_OWNED'});
    assert.equal(before()[0].value,'exempt');
  } finally { db.close(); }
});

test('settings: an old "off" option guards anyway, and the front\'s keys stay refused inside exempt()', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value);INSERT INTO settings VALUES('public_origin','before'),('auto_sampling_presets_enabled','true')");
    createRustAuthGuard({ enabled: false }).install(db);
    assert.throws(() => db.prepare('UPDATE settings SET value=? WHERE key=?').run('after','public_origin'), { code: 'RUST_AUTH_OWNED' });
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind('public_origin','bound').run(), { code: 'RUST_AUTH_OWNED' });
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind('auto_sampling_presets_enabled','false').run(), { code: 'RUST_SAMPLING_SETTINGS_OWNED' });
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='public_origin'").get().value,'before');
  } finally { db.close(); }
  const guarded = new Database(':memory:');
  try {
    guarded.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value);INSERT INTO settings VALUES('auto_sampling_presets_enabled','true')");
    const guard = createRustAuthGuard(); guard.install(guarded);
    assert.throws(() => guard.exempt(() => guarded.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind('auto_sampling_presets_enabled','false').run()),{code:'RUST_SAMPLING_SETTINGS_OWNED'});
    assert.equal(guarded.prepare('SELECT value FROM settings').get().value,'true');
  } finally { guarded.close(); }
});