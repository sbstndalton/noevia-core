// #897: scripts/check-boundaries.cjs keeps src/ and server/ from importing each other, so the
// two can move to separate repos. Synthetic trees only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '../../scripts/check-boundaries.cjs');
const { findViolations } = require(script);

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-boundaries-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test('a clean tree (shared data through contracts/) passes', (t) => {
  const root = tree({
    'contracts/limits.json': '{"n":1}',
    'src/a.ts': "import limits from '../contracts/limits.json';\nimport { b } from './b';\n",
    'src/b.ts': 'export const b = 1;\n',
    'server/x.cjs': "const limits = require('../contracts/limits.json');\nconst y = require('./y.cjs');\n",
    'server/routes/y.cjs': "require('../x.cjs'); require('node:fs');\n",
    'server/x.test.cjs': "fs.readFileSync(path.join(__dirname, '../src/a.ts'));\n",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(findViolations(root), []);
  const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('src/ importing from server/ in any syntax is reported with file and line', (t) => {
  const root = tree({
    'src/components/Icon.tsx': "import x from 'react';\nimport icons from '../../server/icons.json';\n",
    'src/lazy.ts': "const m = await import('../server/m.cjs');\nexport { y } from '../server/y';\n",
    'src/side.ts': "import '../server/side-effect';\n",
    'server/icons.json': '[]',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const found = findViolations(root).map((v) => `${v.file}:${v.line}:${v.specifier}`).sort();
  assert.deepEqual(found, [
    'src/components/Icon.tsx:2:../../server/icons.json',
    'src/lazy.ts:1:../server/m.cjs',
    'src/lazy.ts:2:../server/y',
    'src/side.ts:1:../server/side-effect',
  ]);
  const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /src\/components\/Icon\.tsx:2: src\/ must not import from server\//);
});

test('server/ requiring from src/ is reported, nested routes included', (t) => {
  const root = tree({
    'server/routes/r.cjs': "const { f } = require('../../src/f.ts');\n",
    'server/node_modules/pkg/index.js': "require('../../../src/ignored');\n",
    'src/f.ts': 'export const f = 1;\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const found = findViolations(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, path.join('server', 'routes', 'r.cjs'));
  assert.equal(found[0].rule, 'server/ must not import from src/');
});

test('the real apps/web tree has no cross-boundary imports', () => {
  assert.deepEqual(findViolations(path.join(__dirname, '../..')), []);
});
