'use strict';
// #1431: a Nextcloud Login Flow v2 sign-in survives a web restart. The pending flow is kept on disk,
// its poll token sealed with the credential key (bound to the account), expires with its TTL, and
// a flow that no key can open is simply gone. The routes are the real storage routes over a fake
// Nextcloud (synthetic hosts and credentials); a "restart" is a new store and a new routes object
// on the same file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createNextcloudFlowStore } = require('./nextcloud-flows.cjs');
const { createStorageRoutes } = require('./routes/storage.cjs');
const { createSecretStore } = require('./secrets.cjs');

function secretsIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1431-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, secrets: createSecretStore(dir) };
}

test('#1431: a pending flow written before a restart is found after it, and still completes', async (t) => {
  const { dir, secrets } = secretsIn(t);
  const file = path.join(dir, 'nextcloud-login-flows.json');
  let now = 1_000;
  const before = createNextcloudFlowStore({ file, secrets, now: () => now });
  before.set('flow-1', { userId: 'u1', endpoint: 'https://cloud.example/login/v2/poll', token: 'synthetic-poll-token', origin: 'https://cloud.example', expires: 1_000 + 600_000 });

  // Nothing secret is in clear on disk: not the poll token, not the endpoint.
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.equal(onDisk.includes('synthetic-poll-token'), false);
  assert.equal(onDisk.includes('cloud.example/login'), false);

  // The web process restarts: a new store on the same file knows the flow.
  const after = createNextcloudFlowStore({ file, secrets, now: () => now });
  const flow = after.get('flow-1');
  assert.ok(flow, 'the pending sign-in survives the restart');
  assert.equal(flow.token, 'synthetic-poll-token');
  assert.equal(flow.endpoint, 'https://cloud.example/login/v2/poll');
  assert.equal(flow.userId, 'u1');
  assert.equal(after.size, 1);
});

test('#1431: a sealed flow is bound to its account: moved to another account it cannot be opened', async (t) => {
  const { dir, secrets } = secretsIn(t);
  const file = path.join(dir, 'flows.json');
  const store = createNextcloudFlowStore({ file, secrets, now: () => 0 });
  store.set('flow-1', { userId: 'u1', endpoint: 'https://cloud.example/poll', token: 'synthetic-token', origin: 'https://cloud.example', expires: 9e12 });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.flows['flow-1'].userId = 'u2';
  fs.writeFileSync(file, JSON.stringify(disk));
  const reloaded = createNextcloudFlowStore({ file, secrets, now: () => 0 });
  assert.equal(reloaded.get('flow-1'), undefined, 'a copy of the sealed box under another account is refused');
  assert.equal(reloaded.size, 0, 'and dropped, not kept as a bad record');
});

test('#1431: an expired flow is gone after its TTL, from memory and from disk', async (t) => {
  const { dir, secrets } = secretsIn(t);
  const file = path.join(dir, 'flows.json');
  let now = 0;
  const store = createNextcloudFlowStore({ file, secrets, now: () => now });
  store.set('flow-1', { userId: 'u1', endpoint: 'https://cloud.example/poll', token: 't', origin: 'https://cloud.example', expires: 600_000 });
  now = 600_001;
  assert.equal(store.get('flow-1'), undefined);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).flows['flow-1'], undefined, 'removed from disk too');
});

test('#1431: a damaged flow file starts empty with a warning; it does not stop the server', async (t) => {
  const { dir, secrets } = secretsIn(t);
  const file = path.join(dir, 'flows.json');
  fs.writeFileSync(file, '{ not json');
  const warnings = [];
  const store = createNextcloudFlowStore({ file, secrets, now: () => 0, warn: (m) => warnings.push(m) });
  assert.equal(store.size, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('synthetic-token'), false);
  store.set('flow-2', { userId: 'u1', endpoint: 'https://cloud.example/poll', token: 't', origin: 'https://cloud.example', expires: 9e12 });
  assert.equal(store.size, 1, 'a new flow can be written after the damage');
});

test('#1431: a poll that arrives after a restart completes the sign-in with the same flow id', async (t) => {
  const { dir, secrets } = secretsIn(t);
  const file = path.join(dir, 'flows.json');
  const saved = [];
  const network = async (url) => {
    if (url.endsWith('/index.php/login/v2')) return { ok: true, status: 200, json: async () => ({ login: 'https://cloud.example/login/flow/abc', poll: { endpoint: 'https://cloud.example/login/v2/poll', token: 'ptok' } }) };
    if (url.endsWith('/login/v2/poll')) return { ok: true, status: 200, json: async () => ({ server: 'https://cloud.example/', loginName: 'ada', appPassword: 'synthetic-app-pw' }) };
    if (url.includes('/ocs/v2.php/cloud/user')) return { ok: true, status: 200, json: async () => ({ ocs: { data: { id: 'ada' } } }) };
    if (url.includes('/ocs/v2.php/core/apppassword')) return { ok: true, status: 200 };
    if (url.includes('/remote.php/dav/files/')) return { ok: false, status: 207 };
    throw new Error(`unexpected ${url}`);
  };
  const routesFor = (flowStore) => {
    const sent = [];
    const routes = createStorageRoutes({
      json: (res, status, body) => sent.push({ status, body }),
      readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
      authService: { getStorage: () => ({ kind: 'local' }), saveStorage: (_id, body) => { saved.push(body); return { ok: true, kind: body.kind }; } },
      storageClient: { isBrowsable: () => false, listFiles: async () => [] },
      endpointApproved: () => true,
      fetch: network,
      crypto: { randomUUID: () => 'flow-1' },
      flowStore,
    });
    const call = (p, body) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
      req.method = 'POST';
      return routes(req, {}, { path: p, authn: { user: { id: 'u1', role: 'member' } } }).then(() => sent.at(-1));
    };
    return { call };
  };
  const before = routesFor(createNextcloudFlowStore({ file, secrets }));
  const started = await before.call('/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example/' });
  assert.equal(started.status, 200);
  // The restart: the old process is gone, the new one reads the same file.
  const after = routesFor(createNextcloudFlowStore({ file, secrets }));
  const polled = await after.call('/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1', corpusRoot: 'Diary' });
  assert.equal(polled.status, 200, JSON.stringify(polled));
  assert.equal(saved.length, 1, 'the connection is saved after the restart');
  assert.equal(saved[0].secret, 'synthetic-app-pw');
});

test('#1431: a cancelled flow still cannot be saved by a poll that was already on its way', async (t) => {
  const store = createNextcloudFlowStore({ now: () => 0 });
  store.set('flow-1', { userId: 'u1', endpoint: 'https://cloud.example/poll', token: 't', origin: 'https://cloud.example', expires: 9e12 });
  const first = store.get('flow-1');
  store.delete('flow-1');
  store.set('flow-1', { userId: 'u1', endpoint: 'https://cloud.example/poll', token: 't2', origin: 'https://cloud.example', expires: 9e12 });
  assert.notEqual(store.get('flow-1').nonce, first.nonce, 'a replaced flow with the same id is a different flow');
});
