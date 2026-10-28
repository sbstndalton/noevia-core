'use strict';
// Exact qualifier acceptance gates. Transport failure is not a correlated refusal.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const refusals = Object.freeze({
  'bad-head': ['error', 'checkout'],
  unconfigured: ['unavailable', 'not_configured'],
  'hostile-config': ['error', 'hostile_source'],
  'copy-deadline': ['error', 'checkout'],
});
function assertRefusal(mode, result) {
  const expected = refusals[mode]; assert.ok(expected, 'unknown refusal case');
  assert.equal(result.status, expected[0]); assert.equal(result.error?.code, expected[1]);
  assert.equal(result.report, null, 'a refusal is not a passing measured report');
}
function assertNotAdmitted(directory) {
  assert.ok(fs.statSync(directory).isDirectory(), 'independent witness mount must exist');
  assert.equal(fs.existsSync(path.join(directory, 'operator-started')), false, 'operator command was admitted');
}
function assertFinalAdmission(receipt, nonce, count) {
  assert.ok(receipt && typeof receipt === 'object', 'trusted receipt is required');
  assert.equal(receipt.noevia, 'verify-admission/1');
  assert.equal(receipt.nonce, nonce, 'stale or unrelated admission evidence');
  assert.equal(receipt.complete, true, 'unfinished admission evidence');
  assert.ok(receipt.testHelpersSpawned === 0 || receipt.testHelpersSpawned === 1);
  assert.equal(receipt.testHelpersSpawned, count, 'actual test-helper creation count');
}
module.exports = { assertRefusal, assertNotAdmitted, assertFinalAdmission };
