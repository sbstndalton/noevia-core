'use strict';
// rust-auth.cjs on a stand-in database (no native modules): which statements the guard refuses
// while NOEVIA_RUST_AUTH is on, that reads and exempt writers still run, and that the switch needs
// NOEVIA_FRONT=rust. auth-rust-mode.test.cjs covers the same on createAuth's real database.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createRustAuthGuard, enabledFrom, writeTarget, OWNED_TABLES } = require('./rust-auth.cjs');

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
  assert.equal(enabledFrom({ NOEVIA_RUST_AUTH: '1', NOEVIA_FRONT: 'rust' }, warn), true);
  for (const env of [{}, { NOEVIA_RUST_AUTH: 'true', NOEVIA_FRONT: 'rust' }, { NOEVIA_RUST_AUTH: ' 1', NOEVIA_FRONT: 'rust' }, { NOEVIA_FRONT: 'rust' }]) {
    assert.equal(enabledFrom(env, warn), false, JSON.stringify(env));
  }
  assert.equal(warned.length, 0);
  assert.equal(enabledFrom({ NOEVIA_RUST_AUTH: '1', NOEVIA_FRONT: 'node' }, warn), false);
  assert.equal(enabledFrom({ NOEVIA_RUST_AUTH: '1' }, warn), false);
  assert.equal(warned.length, 2);
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
