'use strict';
// sbstndalton/noevia#2210: the Rust front's reload against this process's own maintenance gate, over real HTTP and
// the real manager. Synthetic router only; no engine is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLeaseRoutes, PREFIX, HARD_MS, MAX_MS } = require('./model-maintenance-lease.cjs');
const { createMaintenanceGate } = require('./inference-maintenance.cjs');
const { createLlamaCppManager } = require('./llamacpp-manager.cjs');

const SECRET = 'synthetic-store-token-0123456789abcdef';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** The real manager with no gate configured (no admin token): its maintenance gate is in-process. */
function realManager() {
  return createLlamaCppManager({
    baseUrl: 'http://127.0.0.1:9/v1', gateAdminToken: null, fetchStream: async () => ({ ok: false }),
    gate: { hasAdmin: () => false, waiting: () => 0 },
    fetchJson: async () => ({ ok: true, status: 200, body: { data: [] } }),
  });
}

async function serve(t, { hold, ...options }) {
  const logs = [];
  const routes = createLeaseRoutes({ secret: SECRET, hold, log: (m) => logs.push(m), json: (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  }, ...options });
  const server = http.createServer(async (req, res) => {
    if (!(await routes.handle(req, res))) { res.writeHead(418); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (method, path = PREFIX, headers = { 'x-noevia-store-token': SECRET }, body) => {
    const r = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return { ask, routes, logs };
}

test('chat active refuses the lease with the 409, and nothing is held', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  const leave = manager.enterInference();
  const refused = await ask('POST');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.chatActive, true);
  assert.equal(manager.maintenanceHeld(), false);
  leave();
  assert.equal((await ask('POST')).status, 201, 'the same request passes once the chat has ended');
});

test('a held lease holds chat, tune, calibration and every other hold back, until it is released', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  const { body: { lease } } = await ask('POST');
  assert.throws(() => manager.enterInference(), (e) => e.status === 503, 'chat is held back');
  await assert.rejects(manager.enterInferenceWithin(10), (e) => e.status === 503 && e.retryable === true);
  assert.equal(manager.maintenanceHeld(), true);
  assert.equal(manager.tuningActive(), true, 'tune and calibration read this');
  assert.equal(manager.inferenceBusy(), true, 'the Rust lease is visible to optional inference');
  assert.throws(() => manager.holdMaintenance('calibration'), (e) => e.status === 409, 'a tune or calibration start is refused');
  assert.equal((await ask('POST')).status, 409, 'a second reload is refused');
  // A chat that waits within its allowance gets in as soon as the lease ends.
  const waiting = manager.enterInferenceWithin(2000);
  assert.equal((await ask('DELETE', `${PREFIX}/${lease}`)).status, 204);
  (await waiting)();
  assert.equal(manager.maintenanceHeld(), false);
  assert.equal((await ask('DELETE', `${PREFIX}/${lease}`)).status, 204, 'release is idempotent');
});

test('Node\'s own reload, delete and prune path (exclusive) is refused during a lease', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  await ask('POST');
  await assert.rejects(manager.reloadPresets({ unload: true }), (e) => e.status === 409);
});

test('a lease whose front died expires by itself; a renewed one lasts; an ended one answers 404', async (t) => {
  const manager = realManager();
  const { ask, logs, routes } = await serve(t, { hold: () => manager.holdMaintenance(), ttlMs: 120 });
  const { body: { lease, ttlMs } } = await ask('POST');
  assert.equal(ttlMs, 120);
  for (let i = 0; i < 4; i++) {
    await delay(60);
    assert.equal((await ask('POST', `${PREFIX}/${lease}/renew`)).status, 200);
    assert.equal(manager.maintenanceHeld(), true, 'renewed: still held');
  }
  await delay(250);
  assert.equal(manager.maintenanceHeld(), false, 'not renewed: over by itself');
  assert.equal(routes.leases.size(), 0);
  assert.match(logs.join('\n'), /was not renewed/);
  manager.enterInference()();
  assert.equal((await ask('POST', `${PREFIX}/${lease}/renew`)).status, 404, 'the front learns it has ended');
});

test('a lease ends at its hard limit, whatever its renewal time, and renewal cannot keep it past that', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance(), ttlMs: 5000, hardMs: 200 });
  const { body: { lease } } = await ask('POST');
  await delay(70);
  assert.equal((await ask('POST', `${PREFIX}/${lease}/renew`)).status, 200);
  await delay(250);
  assert.equal(manager.maintenanceHeld(), false, 'over at its limit, though renewed for much longer');
  assert.equal((await ask('POST', `${PREFIX}/${lease}/renew`)).status, 404);
});

test('no window between check and act: in one tick, either the chat or the lease wins, never both', async () => {
  const gate = createMaintenanceGate();
  // The hold is taken synchronously, so a chat entering right after it is refused...
  const release = gate.hold();
  assert.throws(() => gate.enter(), (e) => e.status === 503);
  release();
  // ...and a chat that entered first refuses the hold, however close together they are.
  const leave = gate.enter();
  assert.throws(() => gate.hold(), (e) => e.status === 409 && e.chatActive === true);
  leave();
});

test('concurrent asks: exactly one lease', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  const answers = await Promise.all([ask('POST'), ask('POST'), ask('POST'), ask('POST')]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [201, 409, 409, 409]);
});

test('only the front may ask: a wrong or missing secret, or a proxied request, is the 404 of an unknown path', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  for (const headers of [{}, { 'x-noevia-store-token': 'wrong' }, { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '192.0.2.7' }, { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '192.0.2.7' }]) {
    assert.equal((await ask('POST', PREFIX, headers)).status, 404, JSON.stringify(Object.keys(headers)));
  }
  assert.equal(manager.maintenanceHeld(), false);
  assert.equal((await ask('GET')).status, 404);
  assert.equal((await ask('POST', `${PREFIX}/nothex/renew`)).status, 404);
});

test('an empty secret refuses everyone, and an engine without holds has no lease', async (t) => {
  const manager = realManager();
  const blank = await serve(t, { hold: () => manager.holdMaintenance(), secret: '' });
  assert.equal((await blank.ask('POST', PREFIX, { 'x-noevia-store-token': '' })).status, 404);
  const none = await serve(t, { hold: null });
  assert.equal((await none.ask('POST')).status, 404);
});

test('a failure other than busy is not a lease', async (t) => {
  const { ask } = await serve(t, { hold: async () => { throw new Error('gate down'); } });
  assert.equal((await ask('POST')).status, 503);
});

test('other paths are not this route\'s', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  assert.equal((await ask('POST', '/internal/model-maintenance/leases')).status, 418);
});

// Calibration (a Rust front run of hours) asks for a longer hard cap, bounded; renewal liveness is unchanged.
test('the hard cap defaults to HARD_MS and a requested maxMs is clamped to [HARD_MS, 24 h]', async (t) => {
  assert.equal(HARD_MS, 60 * 60 * 1000);
  assert.equal(MAX_MS, 24 * 60 * 60 * 1000);
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  const cases = [[undefined, HARD_MS], ['{}', HARD_MS], ['', HARD_MS], [JSON.stringify({ maxMs: 1000 }), HARD_MS], [JSON.stringify({ maxMs: 3 * HARD_MS }), 3 * HARD_MS],
    [JSON.stringify({ maxMs: MAX_MS }), MAX_MS], [JSON.stringify({ maxMs: 100 * MAX_MS }), MAX_MS], [JSON.stringify({ maxMs: -5 }), HARD_MS]];
  for (const [body, cap] of cases) {
    const r = await ask('POST', PREFIX, { 'x-noevia-store-token': SECRET }, body);
    assert.equal(r.status, 201, String(body));
    assert.equal(r.body.hardMs, cap, String(body));
    assert.equal((await ask('DELETE', `${PREFIX}/${r.body.lease}`)).status, 204);
  }
});

test('a maxMs that is not a whole number (or a body that is not {maxMs}) is a 400 and holds nothing', async (t) => {
  const manager = realManager();
  const { ask, routes } = await serve(t, { hold: () => manager.holdMaintenance() });
  for (const body of [JSON.stringify({ maxMs: 1.5 }), JSON.stringify({ maxMs: '3600000' }), JSON.stringify({ maxMs: null }), JSON.stringify({ maxMs: 2 ** 60 }),
    JSON.stringify({ other: 1 }), '[]', 'not json', 'x'.repeat(5000)]) {
    const r = await ask('POST', PREFIX, { 'x-noevia-store-token': SECRET }, body);
    assert.equal(r.status, 400, body.slice(0, 40));
    assert.equal(manager.maintenanceHeld(), false);
    assert.equal(routes.leases.size(), 0);
  }
});

test('a lease ends at its requested cap, and an unrenewed one still ends after ttlMs whatever its cap', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance(), ttlMs: 5000, hardMs: 100, maxMs: 1000 });
  const long = (await ask('POST', PREFIX, { 'x-noevia-store-token': SECRET }, JSON.stringify({ maxMs: 300 }))).body;
  assert.equal(long.hardMs, 300);
  await delay(180);
  assert.equal((await ask('POST', `${PREFIX}/${long.lease}/renew`)).status, 200, 'past the default cap, inside the requested one');
  assert.equal(manager.maintenanceHeld(), true);
  await delay(220);
  assert.equal(manager.maintenanceHeld(), false, 'over at the requested cap');
  assert.equal((await ask('POST', `${PREFIX}/${long.lease}/renew`)).status, 404);
  const quick = await serve(t, { hold: () => manager.holdMaintenance(), ttlMs: 120, hardMs: 100, maxMs: 10000 });
  const lease = (await quick.ask('POST', PREFIX, { 'x-noevia-store-token': SECRET }, JSON.stringify({ maxMs: 10000 }))).body;
  assert.equal(lease.hardMs, 10000);
  assert.equal(lease.ttlMs, 120, 'liveness unchanged');
  await delay(260);
  assert.equal(manager.maintenanceHeld(), false, 'not renewed: over by itself long before its cap');
});

// #2286 group E precondition: the configured-gate path observes a foreign Rust hold too,
// rather than relying only on Node's in-process maintenance counter.
test('a foreign gate hold is visible to real-manager tuningActive and inferenceBusy', {timeout:8000}, async t => {
  let held=false; const paths=[];
  const gate=http.createServer((req,res)=>{
    paths.push(req.method+' '+req.url);
    let status=200,body;
    if(req.method==='GET'&&req.url==='/gate/v1/status') body={maintenance:{held}};
    else if(req.method==='POST'&&req.url==='/gate/v1/maintenance') {held=true;status=201;body={hold:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',idle_ttl_ms:60000};}
    else if(req.method==='DELETE'&&req.url==='/gate/v1/maintenance/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {held=false;status=204;}
    else {status=500;body={error:'unexpected synthetic gate request'};}
    res.writeHead(status,{'content-type':'application/json'});res.end(body===undefined?'':JSON.stringify(body));
  });
  await new Promise(resolve=>gate.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{gate.closeAllConnections();gate.close(resolve);}));
  const base='http://127.0.0.1:'+gate.address().port;
  assert.equal((await fetch(base+'/gate/v1/maintenance',{method:'POST'})).status,201);
  const manager=createLlamaCppManager({baseUrl:base+'/v1',gateAdminToken:'synthetic-admin',
    fetchStream:async()=>assert.fail('precondition never runs inference'),fetchJson:async()=>({ok:true,status:200,body:{data:[]}})});
  t.after(()=>manager.close());
  const until=async(predicate,ms)=>{const end=Date.now()+ms;while(!predicate()&&Date.now()<end)await delay(10);assert.equal(predicate(),true);};
  await until(()=>manager.tuningActive(),1000);
  assert.equal(manager.inferenceBusy(),true);
  assert.equal((await fetch(base+'/gate/v1/maintenance/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',{method:'DELETE'})).status,204);
  await until(()=>!manager.tuningActive(),4500);
  assert.equal(manager.inferenceBusy(),false);
  assert.ok(paths.every(p=>p.startsWith('GET /gate/v1/status')||p.startsWith('POST /gate/v1/maintenance')||p.startsWith('DELETE /gate/v1/maintenance/')),'no model/load/inference path was called');
});
