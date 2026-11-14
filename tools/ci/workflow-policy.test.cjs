'use strict';
// CI throughput policy (2026-11-13): pull requests never write the shared build cache, and every
// workflow has one run group per pull request (superseded runs cancelled) and one per branch for pushes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', '.github', 'workflows');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml'));

test('workflows exist', () => assert.ok(files.length > 0));

for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  test(`${f}: buildx cache-to only on push`, () => {
    for (const line of text.split('\n').filter((l) => /^\s*cache-to:/.test(l))) {
      assert.match(line, /github\.event_name == 'push' &&/, line.trim());
    }
  });
  test(`${f}: run groups per pull request and per branch`, () => {
    assert.match(text, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-.*\|\| github\.ref \}\}\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/m);
  });
}
