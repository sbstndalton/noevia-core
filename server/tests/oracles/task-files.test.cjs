'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { defaultFiles } = require('../../code-harness.cjs');

// Synthetic files only; use the evidence directory instead of a shared temporary directory.
test('harness file oracle refuses links before truncating and creates nested files', () => {
  const evidence = process.env.TASK_FILES_EVIDENCE;
  assert.ok(evidence, 'TASK_FILES_EVIDENCE must name the worker evidence directory');
  const dir = fs.mkdtempSync(path.join(evidence, 'file-oracle-'));
  try {
    const root = path.join(dir, 'root');
    fs.mkdirSync(root);
    const external = path.join(dir, 'external');
    fs.writeFileSync(external, 'preserved');
    fs.symlinkSync(external, path.join(root, 'alias'));
    fs.linkSync(external, path.join(root, 'hard'));
    const results = [];
    for (const [name, message] of [['alias', 'Refusing to follow a symlink'], ['hard', 'Refusing a file with more than one hard link']]) {
      let error;
      try { defaultFiles.write(path.join(root, name), 'bad', root); } catch (caught) { error = caught; }
      assert.equal(error?.code, -32602);
      assert.equal(error?.message, message);
      results.push({ name, code: error.code, message: error.message });
    }
    assert.equal(fs.readFileSync(external, 'utf8'), 'preserved');
    const nested = path.join(root, 'nested/file');
    defaultFiles.write(nested, 'hello', root);
    assert.equal(defaultFiles.read(nested, 5, root), 'hello');
    assert.throws(() => defaultFiles.read(nested, 4, root), { code: -32602, message: 'File too large' });
    fs.writeFileSync(path.join(evidence, 'task-files-node.json'), JSON.stringify({ refusals: results, nested: 'hello', tooLarge: { code: -32602, message: 'File too large' } }, null, 2) + '\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
