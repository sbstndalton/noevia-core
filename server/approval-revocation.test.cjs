'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApprovalRegistry, REGISTRY_PROTOCOL } = require('./rust-approval-registry.cjs');
const { createRevocationRoute, PREFIX } = require('./approval-revocation.cjs');
const { json, readJson } = require('./http.cjs');

test('private epoch acknowledgement is authenticated and invalidates the actual redeemed fence', async t => {
  const registry = createApprovalRegistry({ approvals: async op => ({ status: 200, body: op === 'granted'
    ? { granted: true, ticket: 'synthetic-ticket' }
    : { redeemed: true, protocol: REGISTRY_PROTOCOL, window_ms: 2000 } }) });
  const handle = createRevocationRoute({ secret: 'synthetic-secret', registry, json, readJson });
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  const grant = await registry.chatWideApproved('owner', 'chat', 'project:p', {});
  const fence = await registry.redeemChatGrant('owner', 'chat', 'project:p', {}, grant);
  const ask = headers => fetch(url, { method: 'POST', headers: { 'content-type':'application/json', ...headers }, body: JSON.stringify({ user: 'owner', chat: 'chat', protocol: REGISTRY_PROTOCOL }) });
  for (const headers of [{}, { 'x-noevia-store-token':'wrong' }, { 'x-noevia-store-token':'synthetic-secret', 'x-noevia-client-ip':'203.0.113.1' }, { 'x-noevia-store-token':'synthetic-secret', 'x-forwarded-for':'203.0.113.1' }]) {
    assert.equal((await ask(headers)).status, 404);
    assert.equal(fence.open(), true);
  }
  const response = await ask({ 'x-noevia-store-token':'synthetic-secret' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { acknowledged:true, protocol:REGISTRY_PROTOCOL });
  assert.equal(fence.open(), false, 'ack is after synchronous epoch advance');
});

for (const kind of ['token-load', 'retry', 'metadata']) {
  test(`built-in write rechecks after ${kind}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-write-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    fs.writeFileSync(path.join(dir, 'gdrive-connections.json'), JSON.stringify({ backup:{ usable:false }, personal:{ owner:'connected' } }));
    let epoch = 0, tokens = 0, writes = 0, release, entered, parkMetadata = false;
    const parked = new Promise(r => { release = r; });
    const waiting = new Promise(r => { entered = r; });
    const accounts = require('./gdrive-broker.cjs').createDriveAccounts({ dataDir:dir,
      broker:{ gdriveSession:async () => {
        tokens++;
        if ((kind === 'token-load' && tokens === 1) || (kind === 'retry' && tokens === 2)) { entered(); await parked; }
        return { ok:true, session:{ accessToken:`synthetic-${tokens}`, generation:'1' } };
      } }, fetchImpl:async (_url, init) => {
        if (init.method === 'PATCH' || init.method === 'POST') {
          writes++;
          return { status:401 };
        }
        if (parkMetadata) { entered(); await parked; }
        return new Response(_url.includes('alt=media') ? 'synthetic' : JSON.stringify({ id:'file', name:'note', mimeType:'text/plain', version:'1' }));
      } });
    const driveTools = require('./gdrive-tools.cjs').createDriveTools({ accounts });
    const { AsyncLocalStorage } = require('node:async_hooks');
    const scope = new AsyncLocalStorage();
    const tools = require('./toolboxes.cjs').createToolboxes({ driveTools, scope });
    if (kind === 'metadata') {
      const read = await driveTools.execute({ id:'owner' }, 'drive_read_file', { fileId:'file' });
      assert.match(read, /synthetic/);
      parkMetadata = true;
    }
    const name = kind === 'metadata' ? 'drive_update_file' : 'drive_create_file';
    const outcome = {};
    const run = scope.run({ authn:{ user:{ id:'owner' } } }, () => tools.executeToolCall(null, name,
      JSON.stringify({ name:'note', fileId:'file', content:'synthetic' }), new Set([name]), undefined, outcome,
      { writeFence:{ open:() => epoch === 0 } }));
    await waiting;
    epoch++;
    release();
    const result = await run;
    assert.equal(writes, kind === 'retry' ? 1 : 0, 'no write fetch after revoke');
    assert.equal(outcome.notRun, true);
    assert.match(result, /permission changed before the write was sent/);
  });
}
