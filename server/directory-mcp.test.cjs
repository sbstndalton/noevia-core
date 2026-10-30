'use strict';
// The directory table is the Rust front's (sbstndalton/noevia#2202 round 2): this module re-reads it. The tests play the
// front's part with plain statements (its writes are the only ones the table sees) and check what the chat-time MCP client
// would see: a server added meanwhile shows on the next use, a changed key is a changed signal, an unreadable table is no
// servers at all, and nothing here writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createDirectoryMcp, hostedUrlOk } = require('./directory-mcp.cjs');

const secrets = { decrypt: (v) => Buffer.from(String(v).replace(/^enc:/, ''), 'base64').toString() };
const seal = (obj) => 'enc:' + Buffer.from(JSON.stringify(obj)).toString('base64');
let n = 0;
/** One row, as the front's mcp_directory_insert writes it. */
function insert(db, { id, url = 'https://mcp.example.test/mcp', oauth = 0, personal = 0, headers = null, declared = '[]', addedBy = 'admin-1', title = 't' } = {}) {
  db.prepare('INSERT INTO directory_mcp_servers(id, registry_name, title, url, added_by, added_at, headers_enc, oauth, personal, declared_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, `reg-${id}`, title, url, addedBy, ++n, headers ? seal(headers) : null, oauth, personal, declared);
}

test('the table is made here (Node is the schema migrator) and an empty one lists nothing', () => {
  const db = new Database(':memory:');
  const dir = createDirectoryMcp({ db, secrets });
  assert.deepEqual(dir.list(), []);
  assert.deepEqual(dir.asServers(), []);
  const cols = db.prepare("SELECT name FROM pragma_table_info('directory_mcp_servers')").all().map((c) => c.name);
  for (const c of ['id', 'registry_name', 'title', 'url', 'added_by', 'added_at', 'headers_enc', 'oauth', 'personal', 'declared_json']) assert.ok(cols.includes(c), c);
});

test('a server the front adds, re-keys or removes shows on the next use, without a restart', () => {
  const db = new Database(':memory:');
  const dir = createDirectoryMcp({ db, secrets });
  const first = dir.signal();
  insert(db, { id: 'dir-weather', title: 'Weather' });
  assert.notEqual(dir.signal(), first, 'a new row moves the signal');
  assert.deepEqual(dir.asServers(), [{ id: 'dir-weather', url: 'https://mcp.example.test/mcp', auth: 'none', directory: true, title: 'Weather', addedBy: 'admin-1' }]);
  // The administrator's shared key is set: the server now authenticates as a directory server and the key opens only on demand.
  db.prepare('UPDATE directory_mcp_servers SET headers_enc=? WHERE id=?').run(seal({ Authorization: 'Bearer SECRET-1' }), 'dir-weather');
  assert.equal(dir.asServers()[0].auth, 'directory');
  assert.deepEqual(dir.headersFor('dir-weather'), { Authorization: 'Bearer SECRET-1' });
  assert.deepEqual(dir.list()[0].keyHeaders, ['Authorization']);
  db.prepare('UPDATE directory_mcp_servers SET headers_enc=? WHERE id=?').run(seal({ Authorization: 'Bearer SECRET-2' }), 'dir-weather');
  assert.deepEqual(dir.headersFor('dir-weather'), { Authorization: 'Bearer SECRET-2' }, 'a replaced key is read at once');
  db.prepare('DELETE FROM directory_mcp_servers WHERE id=?').run('dir-weather');
  assert.deepEqual(dir.list(), []);
  assert.deepEqual(dir.headersFor('dir-weather'), {}, 'a removed server has no key');
});

test('the list never carries a key or its ciphertext, and the rest of a row reads as the admin page needs it', () => {
  const db = new Database(':memory:');
  const dir = createDirectoryMcp({ db, secrets });
  insert(db, { id: 'dir-a', headers: { 'X-Key': 'SECRET-LIST' }, declared: '[{"name":"X-Key","required":true,"secret":true,"description":"","template":null}]' });
  insert(db, { id: 'dir-b', oauth: 1 });
  insert(db, { id: 'dir-c', personal: 1, declared: 'not json' });
  const text = JSON.stringify(dir.list());
  assert.ok(!text.includes('SECRET-LIST') && !text.includes('enc:'), 'no key, no ciphertext');
  assert.deepEqual(dir.list().map((s) => [s.id, s.oauth, s.personal, s.keyHeaders]), [['dir-a', false, false, ['X-Key']], ['dir-b', true, false, []], ['dir-c', false, true, []]]);
  assert.deepEqual(dir.list()[0].declaredHeaders.map((h) => h.name), ['X-Key']);
  assert.deepEqual(dir.list()[2].declaredHeaders, [], 'a declaration that is not JSON is none');
  assert.deepEqual(dir.asServers().map((s) => s.auth), ['directory', 'oauth', 'personal']);
  assert.ok(Object.keys(dir.list()[0]).every((k) => k !== 'headersEnc'));
});

test('a table that cannot be read means NO servers, never the last list (fails closed), and recovers', () => {
  const db = new Database(':memory:');
  const dir = createDirectoryMcp({ db, secrets });
  insert(db, { id: 'dir-a' });
  assert.equal(dir.list().length, 1);
  const hidden = db.prepare("SELECT sql FROM sqlite_master WHERE name='directory_mcp_servers'").get().sql;
  db.exec('ALTER TABLE directory_mcp_servers RENAME TO directory_mcp_servers_away');
  assert.deepEqual(dir.list(), [], 'unreadable: nothing is offered');
  assert.deepEqual(dir.asServers(), []);
  assert.equal(dir.signal(), 'unreadable');
  db.exec('ALTER TABLE directory_mcp_servers_away RENAME TO directory_mcp_servers');
  assert.equal(dir.list().length, 1, 'read again once it can be');
  assert.ok(hidden);
});

test('a key no secret opens is no key, not a crash', () => {
  const db = new Database(':memory:');
  const dir = createDirectoryMcp({ db, secrets: { decrypt: () => { throw new Error('lost key'); } } });
  insert(db, { id: 'dir-a', headers: { A: 'b' } });
  assert.deepEqual(dir.headersFor('dir-a'), {});
  assert.equal(dir.asServers()[0].auth, 'none', 'with no usable key it is a server with none');
  const plain = createDirectoryMcp({ db, secrets: null });
  assert.deepEqual(plain.headersFor('dir-a'), {});
});

test('this module writes nothing: the writers (add, remove, keys) are gone and no statement names the table', () => {
  const dir = createDirectoryMcp({ db: new Database(':memory:'), secrets });
  for (const gone of ['add', 'remove', 'setKeys', 'userHeadersFor', 'hasUserKey', 'setUserKey', 'clearUserKey', 'forgetUser']) assert.equal(dir[gone], undefined, gone);
  const code = fs.readFileSync(path.join(__dirname, 'directory-mcp.cjs'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+directory_mcp/i);
  assert.equal(dir.idFor('io.github.x/weather'), 'dir-io-github-x-weather');
});

test('a hosted address is https with no placeholder; QA may stand a loopback server in', () => {
  assert.equal(hostedUrlOk('https://mcp.example.test/mcp'), true);
  for (const bad of ['http://mcp.example.test/mcp', 'https://{host}/mcp', 'https://a b/', '', undefined, 'ftp://x']) assert.equal(hostedUrlOk(bad), false, String(bad));
  assert.equal(hostedUrlOk('http://127.0.0.1:9/mcp'), false);
  process.env.NOEVIA_QA_ALLOW_LOOPBACK_MCP = '1';
  try { assert.equal(hostedUrlOk('http://127.0.0.1:9/mcp'), true); assert.equal(hostedUrlOk('http://10.0.0.1:9/mcp'), false); } finally { delete process.env.NOEVIA_QA_ALLOW_LOOPBACK_MCP; }
});
