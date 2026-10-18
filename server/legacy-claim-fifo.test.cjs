'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { claimLegacyRoot } = require('./legacy-claim.cjs');
const owner = '11111111-1111-4111-8111-111111111111';
function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-fifo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a regular file swapped to a FIFO immediately before open fails without hanging', (t) => {
  if (process.platform !== 'linux') return t.skip('FIFO replacement regression uses Linux mkfifo');
  const modulePath = require.resolve('./legacy-claim.cjs');
  const script = String.raw`
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const claim = require(process.argv[1]).claimLegacyRoot;
    const root = process.argv[2], target = process.argv[3], kind = process.argv[4];
    const original = fs.openSync;
    let swapped = false;
    fs.openSync = function(file, flags, ...rest) {
      if (!swapped && file === target) {
        fs.unlinkSync(file);
        const result = cp.spawnSync('mkfifo', ['-m', '600', file]);
        if (result.status !== 0) throw new Error('mkfifo failed');
        swapped = true;
      }
      return original.call(fs, file, flags, ...rest);
    };
    try {
      const result = claim(root, '11111111-1111-4111-8111-111111111111');
      if (kind !== 'owner' || result !== false) process.exitCode = 2;
    } catch (error) {
      if (kind !== 'source' || error.status !== 503) process.exitCode = 3;
    }
    if (!swapped) process.exitCode = 4;
  `;
  for (const kind of ['owner', 'source']) {
    const root = rootFor(t);
    const target = path.join(root, kind === 'owner' ? 'legacy-owner.json' : 'projects.json');
    if (kind === 'owner') {
      fs.writeFileSync(path.join(root, 'projects.json'), '{}');
      fs.writeFileSync(target, JSON.stringify({ userId: owner }));
    } else {
      fs.writeFileSync(target, '{}');
    }
    const child = spawnSync(process.execPath, ['-e', script, modulePath, root, target, kind], {
      encoding: 'utf8', timeout: 3000,
    });
    assert.equal(child.error, undefined, `${kind} child exceeded its deadline: ${child.error}`);
    assert.equal(child.status, 0, `${kind} child failed: ${child.stderr}`);
  }
});

