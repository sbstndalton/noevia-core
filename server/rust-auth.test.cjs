'use strict';
// rust-auth.cjs on a stand-in database (no native modules): which statements the guard refuses
// while NOEVIA_RUST_AUTH is on, that reads and exempt writers still run, and that the switch needs
// NOEVIA_FRONT=rust. auth-rust-mode.test.cjs covers the same on createAuth's real database.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createRustAuthGuard, enabledFrom, writeTarget, writeTargets, OWNED_TABLES } = require('./rust-auth.cjs');

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

const on = () => createRustAuthGuard({ enabled: true });

test('the switch needs NOEVIA_RUST_AUTH=1 and NOEVIA_FRONT=rust', () => {
  const warned = [];
  const warn = (m) => warned.push(m);
  assert.equal(enabledFrom({ NOEVIA_RUST_AUTH: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH_CONFIRMED: '1' }, warn), true);
  for (const env of [{}, { NOEVIA_RUST_AUTH: 'true', NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH_CONFIRMED: '1' }, { NOEVIA_RUST_AUTH: ' 1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH_CONFIRMED: '1' }, { NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH_CONFIRMED: '1' }]) {
    assert.equal(enabledFrom(env, warn), false, JSON.stringify(env));
  }
  assert.equal(warned.length, 0);
  assert.equal(enabledFrom({ NOEVIA_RUST_AUTH: '1', NOEVIA_FRONT: 'node' }, warn), false);
  assert.equal(enabledFrom({ NOEVIA_RUST_AUTH: '1' }, warn), false);
  assert.equal(warned.length, 2);
  // Without the supervisor's confirmation the switch stays off and says so.
  for (const c of [undefined, '', '0', 'true']) {
    assert.equal(enabledFrom({ NOEVIA_RUST_AUTH: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH_CONFIRMED: c }, warn), false, String(c));
  }
  assert.equal(warned.length, 6);
  assert.match(warned[5], /NOEVIA_RUST_AUTH_CONFIRMED/);
  assert.ok(!warned.join('').match(/[0-9a-f]{32}/), 'no values in the warning');
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
  for (const key of ['setup_code_hash', 'public_origin', 'public_origin_admin', 'passkey_decoy_key']) {
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('${key}',?)`).run('v'), (e) => e.code === 'RUST_AUTH_OWNED', key);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, 'v'), (e) => e.code === 'RUST_AUTH_OWNED', key);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run([key, 'v']), (e) => e.code === 'RUST_AUTH_OWNED', key);
  }
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('feature:nativeClientAuth', 'false');
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('previous_origins',?)").run('[]');
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('reasoning_effort_default',?)").run('low');
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

test('off, nothing changes', () => {
  const guard = createRustAuthGuard({ enabled: false });
  const raw = fakeDb();
  const db = guard.install(raw);
  assert.equal(db.prepare, raw.prepare);
  db.prepare('DELETE FROM sessions').run();
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin',?)").run('x');
  assert.equal(db.ran.length, 2);
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

test('sampling capability refuses only its key and ambiguous writes in real SQLite', () => {
  const Database = require('better-sqlite3');
  for (const samplingSettingsEnabled of [false, true]) {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value); INSERT INTO settings VALUES('auto_sampling_presets_enabled','true'),('reasoning_effort_default','medium')");
      const guard = createRustAuthGuard({ enabled: true, samplingSettingsEnabled });
      guard.install(db);
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('reasoning_effort_default','high');
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('reasoning_effort_default',?)").run('low');
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='reasoning_effort_default'").get().value,'low');
      const attempts = [
        () => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('auto_sampling_presets_enabled','false'),
        () => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('auto_sampling_presets_enabled',?)").run('false'),
        () => db.prepare('UPDATE settings SET value=? WHERE key=?').run('false','auto_sampling_presets_enabled'),
        () => db.prepare("UPDATE settings SET value='false'").run(),
        () => db.exec('DELETE FROM settings'),
        () => guard.exempt(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('auto_sampling_presets_enabled','false')),
      ];
      if (samplingSettingsEnabled) {
        for (const attempt of attempts) assert.throws(attempt,{code:'RUST_SAMPLING_SETTINGS_OWNED',status:503});
        assert.equal(db.prepare("SELECT value FROM settings WHERE key='auto_sampling_presets_enabled'").get().value,'true');
      } else {
        attempts[0]();
        assert.equal(db.prepare("SELECT value FROM settings WHERE key='auto_sampling_presets_enabled'").get().value,'false');
      }
    } finally { db.close(); }
  }
});
