'use strict';
// Members' Google Drive connections survive a secrets.key rotation (#866). Since sbstndalton/noevia#2190 round 7 the
// Rust front owns the sealed token files and since the round's review it is also the only one that WRITES them: the
// rotation asks it to re-seal them (POST /v1/gdrive/reseal, under its own fence, so a disconnect or a sign-in during
// the rotation is never undone by a stale rewrite) and then only checks, read-only, that each file opens under the
// current key. The front's side (reading with the previous key, the re-seal, the in-flight disconnect) is
// noevia-rs tests/gdrive.rs: a_file_sealed_under_the_retired_key_is_read_without_being_rewritten and
// the_rotation_reseals_through_the_fence_and_a_disconnect_in_flight_is_not_undone. Synthetic tokens, no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { sealer, checkTokenFile } = require('./gdrive-seal.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { runRotation } = require('./secrets-rotate.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-gkr-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const noPrev = { env: {} };
const member = { id: 'u-member' }, other = { id: 'u-other' };
// The provider files are the Rust front's (rust-providers-reseal.cjs): no front, no provider rows here.
const noProviders = async () => ({ tables: {}, failures: [] });
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

/**
 * TEST ONLY: what the Rust front's POST /v1/gdrive/reseal does (gdrive.rs `reseal_users`): a file that opens under the
 * previous key is sealed again under the current one, field for field; counts only. `during` runs in the middle of it.
 */
function frontReseal(dir, secrets, during = async () => {}) {
  return async () => {
    const files = path.join(dir, 'google-drive-users');
    const counts = { current: 0, rotated: 0, empty: 0, failed: 0 };
    await during(files);
    for (const f of fs.existsSync(files) ? fs.readdirSync(files).filter((n) => n.endsWith('.sealed')).sort() : []) {
      const file = path.join(files, f);
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) { counts.empty += 1; continue; }
      if (opens(file, secrets.derive('google-drive-user'))) { counts.current += 1; continue; }
      const old = secrets.derivePrevious('google-drive-user') && opens(file, secrets.derivePrevious('google-drive-user'));
      if (!old) { counts.failed += 1; continue; }
      fs.writeFileSync(file, sealer(secrets.derive('google-drive-user')).seal(old), { mode: 0o600 });
      counts.rotated += 1;
    }
    return { ok: true, counts };
  };
}

test('the rotation has the front re-seal every member file so the previous key can be removed', async () => {
  const { dir, fresh, files } = connectedBeforeRotation();
  assert.equal(fresh.hasPreviousKey(), true);
  assert.equal(opens(path.join(files, `${member.id}.sealed`), fresh.derive('google-drive-user')), null, 'not yet readable with the new key alone');
  const report = await runRotation({ resealProviders: noProviders, secrets: fresh, db: noDb, dataDir: dir, gdriveReseal: frontReseal(dir, fresh) });
  assert.deepEqual(report.tables.google_drive_users, { current: 0, rotated: 2, upgraded: 0, empty: 0, failed: 0 });
  assert.equal(report.totals.failed, 0);
  assert.ok(!JSON.stringify(report).includes('synthetic-refresh'), 'the report never carries a token');

  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  const only = createSecretStore(dir, noPrev);
  assert.equal(only.hasPreviousKey(), false);
  for (const user of [member, other]) assert.deepEqual(opens(path.join(files, `${user.id}.sealed`), only.derive('google-drive-user')), record(user));
  // Idempotent: a second run finds everything current.
  const again = await runRotation({ resealProviders: noProviders, secrets: only, db: noDb, dataDir: dir, gdriveReseal: frontReseal(dir, only) });
  assert.deepEqual(again.tables.google_drive_users, { current: 2, rotated: 0, upgraded: 0, empty: 0, failed: 0 });
});

test('a file sealed under neither key is counted as failed, never rewritten, and leaks no token', async () => {
  const { dir, fresh, files } = connectedBeforeRotation();
  const lost = path.join(files, `${other.id}.sealed`);
  const text = fs.readFileSync(path.join(files, `${member.id}.sealed`), 'utf8');
  fs.writeFileSync(lost, 'AAAA' + text.slice(4)); // tampered: opens under neither key
  const report = await runRotation({ resealProviders: noProviders, secrets: fresh, db: noDb, dataDir: dir, gdriveReseal: frontReseal(dir, fresh) });
  assert.deepEqual(report.tables.google_drive_users, { current: 0, rotated: 1, upgraded: 0, empty: 0, failed: 1 });
  assert.equal(report.failures[0].ref, `${other.id}.sealed`);
  assert.match(report.failures[0].error, /not sealed under the current key/);
  assert.equal(fs.readFileSync(lost, 'utf8'), 'AAAA' + text.slice(4));
});

test('without a previous key a file sealed under the old key is unreadable, and an empty file is skipped', () => {
  const { dir, files } = connectedBeforeRotation();
  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  const only = createSecretStore(dir, noPrev);
  assert.equal(only.derivePrevious('google-drive-user'), null);
  assert.equal(opens(path.join(files, `${member.id}.sealed`), only.derive('google-drive-user')), null);
  assert.throws(() => checkTokenFile(path.join(files, `${member.id}.sealed`), only.derive('google-drive-user')), /not sealed under the current key/);
  fs.writeFileSync(path.join(files, 'u-empty.sealed'), '');
  assert.equal(checkTokenFile(path.join(files, 'u-empty.sealed'), only.derive('google-drive-user')), 'empty');
});

test('Node writes none of the files: with no front, a failing front or a throwing one they stay byte for byte as they were', async () => {
  for (const gdriveReseal of [null, async () => ({ ok: false, status: 503 }), async () => ({ ok: false, status: 404 }), async () => { throw new Error('connect ECONNREFUSED'); }]) {
    const { dir, fresh, files } = connectedBeforeRotation();
    const before = fs.readdirSync(files).map((f) => fs.readFileSync(path.join(files, f), 'utf8'));
    const report = await runRotation({ resealProviders: noProviders, secrets: fresh, db: noDb, dataDir: dir, gdriveReseal });
    assert.deepEqual(fs.readdirSync(files).map((f) => fs.readFileSync(path.join(files, f), 'utf8')), before, 'not one byte written by Node');
    const t = report.tables.google_drive_users;
    assert.equal(t.rotated, 0);
    assert.ok(t.failed >= 2, JSON.stringify(t)); // both files still under the retired key, plus the front\'s refusal
    assert.ok(report.failures.some((f) => f.table === 'google_drive_users' && /Rust front/.test(f.error)), JSON.stringify(report.failures));
    assert.equal(fresh.hasPreviousKey(), true, 'and the retired key is still what reads them');
  }
});

test('the front\'s re-seal is awaited first: the check runs after it, and an account that disconnects meanwhile is not brought back', async () => {
  const { dir, fresh, files } = connectedBeforeRotation();
  const gone = path.join(files, `${other.id}.sealed`);
  let finished = false;
  const slow = frontReseal(dir, fresh, async (f) => {
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(path.join(f, `${other.id}.sealed`)); // the account disconnects while the rotation runs
  });
  const report = await runRotation({ resealProviders: noProviders, secrets: fresh, db: noDb, dataDir: dir, gdriveReseal: async () => { const r = await slow(); finished = true; return r; } });
  assert.equal(finished, true);
  assert.equal(fs.existsSync(gone), false, 'Node did not resurrect it');
  assert.deepEqual(report.tables.google_drive_users, { current: 0, rotated: 1, upgraded: 0, empty: 0, failed: 0 });
  assert.deepEqual(opens(path.join(files, `${member.id}.sealed`), fresh.derive('google-drive-user')), record(member));
});

test('gdrive-seal.cjs cannot write a token file', () => {
  const src = fs.readFileSync(path.join(__dirname, 'gdrive-seal.cjs'), 'utf8');
  assert.doesNotMatch(src, /writeFileSync|renameSync|appendFileSync|unlinkSync|rmSync/);
});
