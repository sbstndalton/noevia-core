const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { resolveVersion } = require('./version-resolve.cjs');

function makeBaseDir({ root, server } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-resolve-'));
  const baseDir = path.join(dir, 'server');
  fs.mkdirSync(baseDir, { recursive: true });
  if (root !== undefined) fs.writeFileSync(path.join(dir, 'package.json'), root);
  if (server !== undefined) fs.writeFileSync(path.join(baseDir, 'package.json'), server);
  return { dir, baseDir };
}

test('STAMP_VERSION env wins over any package.json on disk', () => {
  const { baseDir, dir } = makeBaseDir({ root: JSON.stringify({ version: '1.2.3' }) });
  try {
    assert.equal(resolveVersion({ STAMP_VERSION: '9.9.9' }, baseDir), '9.9.9');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('falls back to the root package.json when STAMP_VERSION is unset', () => {
  const { baseDir, dir } = makeBaseDir({ root: JSON.stringify({ version: '1.2.3' }), server: JSON.stringify({ version: '0.1.0' }) });
  try {
    assert.equal(resolveVersion({}, baseDir), '1.2.3');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('falls back to server/package.json when the root file is missing (#337)', () => {
  const { baseDir, dir } = makeBaseDir({ server: JSON.stringify({ version: '0.1.0' }) });
  try {
    assert.equal(resolveVersion({}, baseDir), '0.1.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('falls back to server/package.json when the root file is present but unreadable JSON', () => {
  const { baseDir, dir } = makeBaseDir({ root: '{not json', server: JSON.stringify({ version: '0.1.0' }) });
  try {
    assert.equal(resolveVersion({}, baseDir), '0.1.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('returns "unknown" when nothing is readable, and never throws', () => {
  const { baseDir, dir } = makeBaseDir({});
  try {
    assert.equal(resolveVersion({}, baseDir), 'unknown');
    assert.doesNotThrow(() => resolveVersion(undefined, baseDir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
