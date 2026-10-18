'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { claimLegacyRoot } = require('./legacy-claim.cjs');
const owner = '11111111-1111-4111-8111-111111111111';
const helper = process.env.NOEVIA_LEGACY_CLAIM_BIN;
function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-fifo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Node wrapper reaches native authority for FIFO owner and source markers without hanging', {
  skip: process.platform !== 'linux' || !helper || !path.isAbsolute(helper),
}, (t) => {
  for (const kind of ['owner', 'source']) {
    const root = rootFor(t);
    if (kind === 'owner') fs.writeFileSync(path.join(root, 'projects.json'), '{}');
    const target = path.join(root, kind === 'owner' ? 'legacy-owner.json' : 'projects.json');
    const result = spawnSync('mkfifo', ['-m', '600', target], { encoding: 'utf8', timeout: 1000 });
    assert.equal(result.status, 0, result.stderr);
    process.env.NOEVIA_LEGACY_CLAIM_BIN = helper;
    const started = Date.now();
    if (kind === 'owner') assert.equal(claimLegacyRoot(root, owner), false);
    else assert.throws(() => claimLegacyRoot(root, owner), (error) => error.status === 503);
    assert.ok(Date.now() - started < 7000);
  }
});
