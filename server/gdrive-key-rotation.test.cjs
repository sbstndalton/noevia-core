'use strict';
// Members' Google Drive connections survive a secrets.key rotation (#866): the sealed token files are
// re-sealed by the rotation. Since sbstndalton/noevia#2190 round 7 the Rust front owns the files and reads
// them with the previous key until then (noevia-rs tests/gdrive.rs); the re-seal stays here, because
// `npm run secrets:rotate` and the admin route run in Node. Synthetic tokens, no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { sealer, resealTokenFile } = require('./gdrive-seal.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { runRotation } = require('./secrets-rotate.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-gkr-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const noPrev = { env: {} };
const member = { id: 'u-member' }, other = { id: 'u-other' };
// No database tables here: rotationTables skips tables that do not exist.
const noDb = { prepare: () => ({ get: () => undefined, all: () => [] }) };
const retire = (dir) => fs.renameSync(path.join(dir, 'secrets.key'), path.join(dir, 'secrets.key.previous'));
const record = (user) => ({ refreshToken: `synthetic-refresh-${user.id}`, email: null, connectedAt: 5, owner: user.id });

function connectedBeforeRotation() {
  const dir = temp();
  const old = createSecretStore(dir, noPrev);
  const files = path.join(dir, 'google-drive-users');
  fs.mkdirSync(files);
  for (const user of [member, other]) fs.writeFileSync(path.join(files, `${user.id}.sealed`), sealer(old.derive('google-drive-user')).seal(record(user)));
  retire(dir); // a new secrets.key is generated on the next start, the old one is kept as the previous key
  return { dir, fresh: createSecretStore(dir, noPrev), files };
}
const opens = (file, key) => { try { return sealer(key).open(fs.readFileSync(file, 'utf8')); } catch { return null; } };

test('the rotation re-seals every member file so the previous key can be removed', () => {
  const { dir, fresh, files } = connectedBeforeRotation();
  assert.equal(fresh.hasPreviousKey(), true);
  assert.equal(opens(path.join(files, `${member.id}.sealed`), fresh.derive('google-drive-user')), null, 'not yet readable with the new key alone');
  const report = runRotation({ secrets: fresh, db: noDb, dataDir: dir });
  assert.deepEqual(report.tables.google_drive_users, { current: 0, rotated: 2, upgraded: 0, empty: 0, failed: 0 });
  assert.equal(report.totals.failed, 0);
  assert.ok(!JSON.stringify(report).includes('synthetic-refresh'), 'the report never carries a token');

  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  const only = createSecretStore(dir, noPrev);
  assert.equal(only.hasPreviousKey(), false);
  for (const user of [member, other]) assert.deepEqual(opens(path.join(files, `${user.id}.sealed`), only.derive('google-drive-user')), record(user));
  // Idempotent: a second run finds everything current.
  const again = runRotation({ secrets: only, db: noDb, dataDir: dir });
  assert.deepEqual(again.tables.google_drive_users, { current: 2, rotated: 0, upgraded: 0, empty: 0, failed: 0 });
});

test('a file sealed under neither key is counted as failed, never rewritten, and leaks no token', () => {
  const { dir, fresh, files } = connectedBeforeRotation();
  const lost = path.join(files, `${other.id}.sealed`);
  const text = fs.readFileSync(path.join(files, `${member.id}.sealed`), 'utf8');
  fs.writeFileSync(lost, 'AAAA' + text.slice(4)); // tampered: opens under neither key
  const report = runRotation({ secrets: fresh, db: noDb, dataDir: dir });
  assert.deepEqual(report.tables.google_drive_users, { current: 0, rotated: 1, upgraded: 0, empty: 0, failed: 1 });
  assert.equal(report.failures[0].ref, `${other.id}.sealed`);
  assert.match(report.failures[0].error, /no longer available/);
  assert.equal(fs.readFileSync(lost, 'utf8'), 'AAAA' + text.slice(4));
});

test('without a previous key a file sealed under the old key is unreadable, and an empty file is skipped', () => {
  const { dir, files } = connectedBeforeRotation();
  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  const only = createSecretStore(dir, noPrev);
  assert.equal(only.derivePrevious('google-drive-user'), null);
  assert.equal(opens(path.join(files, `${member.id}.sealed`), only.derive('google-drive-user')), null);
  assert.throws(() => resealTokenFile(path.join(files, `${member.id}.sealed`), only.derive('google-drive-user'), null), /no longer available/);
  fs.writeFileSync(path.join(files, 'u-empty.sealed'), '');
  assert.equal(resealTokenFile(path.join(files, 'u-empty.sealed'), only.derive('google-drive-user'), null), 'empty');
});
