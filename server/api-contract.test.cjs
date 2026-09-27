const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

test('the real HTTP handler marks public readiness and session errors as API v1', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-api-contract-'));
  process.env.UI_DATA_DIR = dataDir;
  const originalLog = console.log;
  const originalWarn = console.warn;
  let handleRequest;
  try {
    // First-run messages include a synthetic setup code; keep the test output clean.
    console.log = () => {};
    console.warn = () => {};
    ({ handleRequest } = require('./index.cjs'));
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  const server = http.createServer((req, res) => { void handleRequest(req, res); });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ready = await fetch(`${base}/api/ready`);
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get('x-noevia-api'), '1');
    assert.deepEqual(Object.keys(await ready.json()).sort(), ['ready', 'version']);

    const denied = await fetch(`${base}/api/profile`);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('x-noevia-api'), '1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
