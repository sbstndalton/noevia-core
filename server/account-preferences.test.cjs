// The interface preferences' names and reader. The Rust front reads and writes the record
// (/api/account/preferences, sbstndalton/noevia#1071; noevia-rs crates/server-account).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ap = require('./account-preferences.cjs');

test('defaults, a saved record and a damaged file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-prefs-'));
  try {
    assert.deepEqual(ap.read(dir), { notifications: { replyFinished: true, approvalNeeded: true }, sendKey: 'enter', locale: 'system', updatedAt: null });
    fs.writeFileSync(path.join(dir, 'account-preferences.json'), JSON.stringify({ notifications: { replyFinished: false, billing: true }, sendKey: 'mod-enter', locale: 'nb-NO', updatedAt: 8 }));
    assert.deepEqual(ap.read(dir), { notifications: { replyFinished: false, approvalNeeded: true }, sendKey: 'mod-enter', locale: 'nb-NO', updatedAt: 8 }, 'unknown events are ignored');
    fs.writeFileSync(path.join(dir, 'account-preferences.json'), JSON.stringify({ sendKey: 'space', locale: 'xx-YY' }));
    assert.deepEqual([ap.read(dir).sendKey, ap.read(dir).locale], ['enter', 'system'], 'unknown values read as the defaults');
    fs.writeFileSync(path.join(dir, 'account-preferences.json'), '{nope');
    assert.equal(ap.read(dir).sendKey, 'enter', 'a damaged file never breaks the composer');
    assert.equal(typeof ap.write, 'undefined', 'writing them is the Rust front\'s');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only the events noevia produces, and no finance categories', () => {
  assert.deepEqual(ap.NOTIFICATION_EVENTS, ['replyFinished', 'approvalNeeded']);
  assert.ok(!ap.NOTIFICATION_EVENTS.some((e) => /bill|credit|pay|subscri/i.test(e)));
  assert.deepEqual(ap.SEND_KEYS, ['enter', 'mod-enter']);
});
