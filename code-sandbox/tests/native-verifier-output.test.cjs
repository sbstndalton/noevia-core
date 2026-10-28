'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

test('the actual fixture writer delivers all bytes through a deliberately backpressured owned pipe', async () => {
  const modulePath = require.resolve('./native-verifier-output.cjs');
  const script = `require(${JSON.stringify(modulePath)}).writeTail(process.stdout).catch(e=>{console.error(e);process.exitCode=1})`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let total = 0, stderr = '';
  child.stdout.on('data', (bytes) => { total += bytes.length; assert.ok(total <= 2 * 1024 * 1024 + 32); chunks.push(bytes); });
  child.stderr.on('data', (bytes) => { stderr += bytes; assert.ok(stderr.length <= 8192); });
  child.stdout.pause();
  const release = setTimeout(() => child.stdout.resume(), 100);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr);
    const actual = Buffer.concat(chunks);
    const trailer = Buffer.from('\u001b[31m\u0000END\n');
    assert.equal(actual.length, 2 * 1024 * 1024 + trailer.length);
    assert.deepEqual(actual.subarray(0, 2 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024, 120));
    assert.deepEqual(actual.subarray(2 * 1024 * 1024), trailer);
  } finally {
    clearTimeout(release); clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
