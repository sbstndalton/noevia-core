'use strict';
// Core boots under this harness's environment only with the feature runtime registered through the
// project store under a valid shared start id, and refuses to run without one (no bypass).
// Synthetic loopback fixtures only; no OCR engine, model or Diary is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { SERVER, GUARD, startMocks, serverEnv } = require('../contract-corpus/mocks.cjs');
const { startProjectStore } = require('../../tests/server/project-store-server.cjs');
const { bindProjectStore } = require('./boot.cjs');

async function boot({ startId }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-ocr-boot-'));
  const mocks = await startMocks();
  const store = await startProjectStore(dataDir);
  const probe = await new Promise(resolve => { const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const env = serverEnv({ port: probe, dataDir, origin: `http://127.0.0.1:${probe}`, mocks });
  const given = bindProjectStore(env, store);
  if (startId === 'none') delete env.NOEVIA_START_ID; else if (startId) env.NOEVIA_START_ID = startId;
  const proc = spawn(process.execPath, ['--require', GUARD, SERVER], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  proc.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
  const exited = new Promise(resolve => proc.once('exit', code => resolve(code)));
  const cleanup = async () => {
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGTERM'); await Promise.race([exited, new Promise(r => setTimeout(r, 3000).unref())]); if (proc.exitCode === null) proc.kill('SIGKILL'); }
    mocks.close(); await store.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { proc, exited, errors: () => errors, port: probe, given, cleanup };
}

async function until(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  return null;
}

test('Core becomes ready through the stand-in store with the shared start id', async () => {
  const node = await boot({});
  try {
    assert.match(node.given, /^[0-9a-f]{32}$/);
    const ok = await until(async () => {
      if (node.proc.exitCode !== null) assert.fail(`Core exited: ${node.errors()}`);
      try { return (await fetch(`http://127.0.0.1:${node.port}/api/ready`)).ok; } catch { return false; }
    }, 30000);
    assert.ok(ok, `Core did not become ready: ${node.errors()}`);
  } finally { await node.cleanup(); }
});

test('without a valid start id Core refuses to start instead of bypassing the feature barrier', async () => {
  for (const startId of ['none', 'not-a-start-id']) {
    const node = await boot({ startId });
    try {
      const code = await Promise.race([node.exited, new Promise(r => setTimeout(() => r('timeout'), 30000).unref())]);
      assert.notEqual(code, 'timeout', `Core kept running without a start id (${startId})`);
      assert.notEqual(code, 0);
      assert.match(node.errors(), /Feature runtime context is unavailable/);
    } finally { await node.cleanup(); }
  }
});
