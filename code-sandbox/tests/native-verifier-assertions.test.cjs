'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { assertRefusal, assertNotAdmitted } = require('./native-verifier-assertions.cjs');
for (const [mode, status, code] of [
  ['bad-head', 'error', 'checkout'], ['unconfigured', 'unavailable', 'not_configured'],
  ['hostile-config', 'error', 'hostile_source'], ['copy-deadline', 'error', 'checkout'],
]) {
  test(mode + ' requires its correlated gate; gate bypass/transport failures reject', () => {
    assertRefusal(mode, { status, report: null, error: { code } });
    for (const wrong of [
      { status: 'error', report: null, error: { code: 'unreachable' } },
      { status: 'unavailable', report: null, error: { code: 'busy' } },
      { status: 'passed', report: { passed: true }, error: null },
      { status, report: null, error: { code: 'wrong-gate' } },
    ]) assert.throws(() => assertRefusal(mode, wrong));
  });
}
test('non-admission witness catches execution even when no report is returned', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-verifier-witness-'));
  try {
    assertNotAdmitted(directory);
    fs.writeFileSync(path.join(directory, 'operator-started'), 'actual command admission');
    assert.throws(() => assertNotAdmitted(directory), /operator command was admitted/);
    assert.throws(() => assertNotAdmitted(path.join(directory, 'missing')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
