'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createClient } = require('./rust-media-background.cjs');
test('source hints coalesce per tenant/project, preserve newer generations, and stop synchronously', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-owner-'));
  try {
    const client = createClient({ dataDir: dir, start: 'synthetic-start' });
    client.schedule('one', 'same'); client.schedule('two', 'same');
    const folder = path.join(dir, 'media-worker-requests');
    assert.equal(fs.readdirSync(folder).length, 2);
    client.schedule('one', 'same');
    const requests = fs.readdirSync(folder).map(f => JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')));
    assert.equal(requests.find(r => r.user === 'one').sequence, 3);
    assert.equal(requests.find(r => r.user === 'two').sequence, 2);
    client.stop(); client.schedule('one', 'another');
    assert.equal(fs.readdirSync(folder).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('server starts no Node media, figure or document scheduler', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.doesNotMatch(source, /createMediaBackfill|createFigureSweep|createDocumentBackfill/);
  for (const file of ['figure-sweep.cjs', 'document-backfill.cjs']) assert.equal(fs.existsSync(path.join(__dirname, file)), false);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'multimodal-rag.cjs'), 'utf8'), /function createMediaBackfill|function exclusive/);
});
