const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ap = require('./account-preferences.cjs');

test('defaults, partial patches and a damaged file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-prefs-'));
  try {
    assert.deepEqual(ap.read(dir), { notifications: { replyFinished: true, approvalNeeded: true }, sendKey: 'enter', locale: 'system', updatedAt: null });
    let r = ap.write(dir, { notifications: { replyFinished: false } }, 7);
    assert.deepEqual(r.notifications, { replyFinished: false, approvalNeeded: true }, 'approval alerts stay on when completion alerts go off');
    r = ap.write(dir, { sendKey: 'mod-enter', locale: 'nb-NO' }, 8);
    assert.equal(r.notifications.replyFinished, false, 'an unrelated patch keeps earlier choices');
    assert.deepEqual(ap.read(dir), { notifications: { replyFinished: false, approvalNeeded: true }, sendKey: 'mod-enter', locale: 'nb-NO', updatedAt: 8 });
    fs.writeFileSync(path.join(dir, 'account-preferences.json'), '{nope');
    assert.equal(ap.read(dir).sendKey, 'enter', 'a damaged file never breaks the composer');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses unknown events, keys and locales instead of coercing them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-prefs-bad-'));
  try {
    assert.throws(() => ap.write(dir, { notifications: { billing: true } }), /Unknown notification event/);
    assert.throws(() => ap.write(dir, { notifications: { replyFinished: 'yes' } }), /true or false/);
    assert.throws(() => ap.write(dir, { sendKey: 'space' }), /enter/);
    assert.throws(() => ap.write(dir, { locale: 'xx-YY' }), /not available/);
    assert.throws(() => ap.write(dir, []), /object/);
    assert.equal(fs.existsSync(path.join(dir, 'account-preferences.json')), false, 'nothing saved on refusal');
    assert.ok(!ap.NOTIFICATION_EVENTS.some((e) => /bill|credit|pay|subscri/i.test(e)), 'no finance categories');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
