'use strict';
// #1755 part 1: service endpoints are any address on this network (LAN, Tailscale, a Docker service
// name), judged by what a name resolves to at connect time. #1753(a): the shared decision key goes
// only to COWORK_DECISION_URL's host. Synthetic hosts and addresses only; DNS is stubbed throughout.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { configuration } = require('./decision-endpoint.cjs');
const { configuration: systemOneConfiguration } = require('./system-one-router.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');

// Required per test, so on a tree without the helper each test fails on its own.
const helper = () => require('./service-endpoint.cjs');

const DNS = {
  'rock5b.local': ['10.20.30.40'],
  'pi5.lan': ['192.168.50.5'],
  'pi5.tail1234.ts.net': ['100.101.102.103'],
  laya: ['172.18.0.5'], kev: ['172.18.0.6'], llama: ['172.18.0.7'], embed: ['172.18.0.8'],
  'cloud.example': ['93.184.216.34'],
  'mixed.lan': ['192.168.1.9', '93.184.216.34'],
  'mixed6.local': ['fd00::9', '2606:2800:220:1:248:1893:25c8:1946'],
  'zero.lan': ['0.0.0.0'], 'multicast.lan': ['239.1.2.3'], 'metadata.lan': ['169.254.169.254'],
  'fixture.local': ['127.0.0.1'],
};
const lookup = async (host) => {
  if (!DNS[host]) throw Object.assign(Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return DNS[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
// The callback shape net's `lookup` option uses.
const resolveFrom = (table) => (host, _opts, cb) => {
  const list = typeof table === 'function' ? table(host) : table[host];
  if (!list) return cb(Object.assign(Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
  cb(null, list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
};
// The connect-time check itself: the `lookup` the socket uses (tests/hermetic-network.cjs refuses any
// socket to a name, so name cases call the lookup the socket would call; literals go end to end).
const lookupVia = (resolve, host) => new Promise((ok, fail) => helper().createServiceLookup({ resolve })(host, { all: true }, (e, list) => (e ? fail(e) : ok(list))));
const memory = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };

async function fixtureServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return server.address().port;
}

test('a public IP literal is refused, by every caller and by the helper', async () => {
  for (const url of ['http://8.8.8.8:8040', 'https://93.184.216.34', 'http://[2606:4700:4700::1111]:8040']) {
    assert.ok(configuration({ COWORK_DECISION_URL: url }).reason, url);
    assert.ok(systemOneConfiguration({ COWORK_SYSTEM_ONE_URL: url }).reason, url);
    const r = await helper().checkServiceEndpoint(url, { lookup });
    assert.equal(r.ok, false, url);
    assert.equal(r.transient, false, url);
  }
  await assert.rejects(helper().createServiceFetch({ resolve: resolveFrom(DNS) })('http://8.8.8.8:8040/health'), /not on this network/);
});

test('a name that resolves to a public address is refused (stub DNS), before and at connect', async (t) => {
  const r = await helper().checkServiceEndpoint('http://cloud.example:8040', { lookup });
  assert.equal(r.ok, false);
  assert.match(r.reason, /93\.184\.216\.34 is a public address/);
  // The connection test says so plainly.
  const settings = createDecisionSettings({ store: memory(), env: {}, lookup, fetchImpl: async () => assert.fail('no request to a public host') });
  await assert.rejects(settings.test({ url: 'http://cloud.example:8040', timeoutMs: 500 }), (e) => e.status === 400 && e.messageId === 'invalidUrl');
  // And the socket's lookup refuses it.
  await assert.rejects(lookupVia(resolveFrom(DNS), 'cloud.example'), (e) => e.code === 'EPUBLICADDR');
});

test('a name with a mix of private and public answers is refused', async () => {
  for (const host of ['mixed.lan', 'mixed6.local']) {
    const r = await helper().checkServiceEndpoint(`http://${host}:8040`, { lookup });
    assert.equal(r.ok, false, host);
    assert.equal(r.transient, false, host);
  }
  await assert.rejects(lookupVia(resolveFrom(DNS), 'mixed.lan'), (e) => e.code === 'EPUBLICADDR');
  await assert.rejects(lookupVia(resolveFrom(DNS), 'mixed6.local'), (e) => e.code === 'EPUBLICADDR');
});

test('a Tailscale address (100.64.0.0/10) is accepted, as a literal and as a *.ts.net name', async () => {
  assert.equal(configuration({ COWORK_DECISION_URL: 'http://100.101.102.103:8040' }).reason, null);
  assert.equal(configuration({ COWORK_DECISION_URL: 'http://100.101.102.103:8040' }).baseUrl, 'http://100.101.102.103:8040');
  assert.equal(systemOneConfiguration({ COWORK_SYSTEM_ONE_URL: 'http://100.64.0.1:8080/v1' }).baseUrl, 'http://100.64.0.1:8080');
  assert.equal(configuration({ COWORK_DECISION_URL: 'http://pi5.tail1234.ts.net:8040' }).baseUrl, 'http://pi5.tail1234.ts.net:8040');
  assert.deepEqual(await helper().checkServiceEndpoint('http://pi5.tail1234.ts.net:8040', { lookup }), { ok: true });
  assert.deepEqual(await helper().checkServiceEndpoint('http://100.127.255.254:8040', { lookup }), { ok: true });
  // 100.128.0.0 is outside the CGNAT block: public.
  assert.equal((await helper().checkServiceEndpoint('http://100.128.0.1:8040', { lookup })).ok, false);
});

test('rock5b.local resolving to 10.x is accepted, and Settings tests a LAN name through the checked lookup', async (t) => {
  assert.equal(configuration({ COWORK_DECISION_URL: 'http://rock5b.local:8040' }).baseUrl, 'http://rock5b.local:8040');
  assert.deepEqual(await helper().checkServiceEndpoint('http://rock5b.local:8040', { lookup }), { ok: true });
  assert.deepEqual(await helper().checkServiceEndpoint('https://pi5.lan:8443', { lookup }), { ok: true });
  // The socket's lookup hands back exactly the checked answers.
  assert.deepEqual(await lookupVia(resolveFrom(DNS), 'rock5b.local'), [{ address: '10.20.30.40', family: 4 }]);
  assert.deepEqual(await lookupVia(resolveFrom(DNS), 'pi5.tail1234.ts.net'), [{ address: '100.101.102.103', family: 4 }]);
  // Settings saves a .local URL, and its connection test goes through the on-this-network fetch.
  const port = await fixtureServer(t, (req, res) => { assert.equal(req.url, '/health'); res.setHeader('content-type', 'application/json'); res.end('{"ready":true}'); });
  const urls = [];
  const real = helper().createServiceFetch({ resolve: resolveFrom(DNS) });
  // The fixture board is 127.0.0.1 (the only address a test may connect to): the name is checked, then the literal is fetched.
  const fetchImpl = async (url, init) => { urls.push(url); const u = new URL(url); await lookupVia(resolveFrom(DNS), u.hostname); return real(`http://127.0.0.1:${port}${u.pathname}`, init); };
  const settings = createDecisionSettings({ store: memory(), env: {}, lookup, fetchImpl });
  assert.equal(settings.save({ url: 'http://rock5b.local:8040', timeoutMs: 500 }, 'admin').url, 'http://rock5b.local:8040');
  assert.equal((await settings.test({ url: 'http://rock5b.local:8040', timeoutMs: 500 })).messageId, 'ready');
  assert.deepEqual(urls, ['http://rock5b.local:8040/health']);
});

test('Docker single-label service names are accepted (laya, kev, llama, embed)', async () => {
  for (const name of ['laya', 'kev', 'llama', 'embed']) {
    assert.equal(configuration({ COWORK_DECISION_URL: `http://${name}:8040` }).baseUrl, `http://${name}:8040`, name);
    assert.deepEqual(await helper().checkServiceEndpoint(`http://${name}:8040`, { lookup }), { ok: true }, name);
  }
});

test('a redirect is still refused, whatever it points at', async (t) => {
  const port = await fixtureServer(t, (_q, res) => { res.statusCode = 302; res.setHeader('location', 'http://93.184.216.34/'); res.end(); });
  const fetchImpl = helper().createServiceFetch({ resolve: resolveFrom(DNS) });
  await assert.rejects(fetchImpl(`http://127.0.0.1:${port}/health`, { redirect: 'error' }), /redirect \(302\)/);
  const settings = createDecisionSettings({ store: memory(), env: {}, lookup, fetchImpl });
  await assert.rejects(settings.test({ url: `http://127.0.0.1:${port}`, timeoutMs: 500 }), (e) => e.status === 502 && e.messageId === 'notReady');
  // The decision endpoint's default fetch is the same one, and it refuses the redirect too.
  const { createDecisionEndpoint } = require('./decision-endpoint.cjs');
  const endpoint = createDecisionEndpoint({ env: { COWORK_DECISION_URL: `http://127.0.0.1:${port}` } });
  await assert.rejects(endpoint.choice({ state: 's', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), (e) => e.reason === 'network');
});

test('DNS rebinding: a name that answers private to the check and public to the connection is refused at connect', async () => {
  let calls = 0;
  const flip = () => (++calls === 1 ? ['10.0.0.9'] : ['93.184.216.34']);
  assert.deepEqual(await helper().checkServiceEndpoint('http://rebind.lan:8040', { lookup: async (h) => flip().map((address) => ({ address, family: 4 })) }), { ok: true });
  // The socket resolves through its own lookup, which judges the answers it is about to connect to.
  await assert.rejects(lookupVia(resolveFrom(() => flip()), 'rebind.lan'), (e) => e.code === 'EPUBLICADDR');
  // The single-address form net uses without `all` is guarded the same way.
  await assert.rejects(new Promise((ok, fail) => helper().createServiceLookup({ resolve: resolveFrom(() => ['93.184.216.34']) })('rebind.lan', {}, (e, a) => (e ? fail(e) : ok(a)))), (e) => e.code === 'EPUBLICADDR');
});

test('unspecified, multicast, metadata, query, fragment and login are refused; link-local is allowed for decision services', async () => {
  for (const url of ['http://0.0.0.0:8040', 'http://[::]:8040', 'http://224.0.0.1:8040', 'http://[ff02::1]:8040', 'http://169.254.169.254',
    'http://zero.lan:8040', 'http://multicast.lan:8040', 'http://metadata.lan', 'http://laya:8040/?k=v', 'http://laya:8040/#f', 'http://u:p@laya:8040', 'ftp://laya:8040']) {
    assert.equal((await helper().checkServiceEndpoint(url, { lookup })).ok, false, url);
  }
  for (const url of ['http://169.254.10.20:8040', 'http://[fe80::1]:8040']) {
    // #1760: link-local is opt-in; the decision service passes it.
    assert.equal((await helper().checkServiceEndpoint(url, { lookup })).ok, false, `${url} refused by default`);
    assert.deepEqual(await helper().checkServiceEndpoint(url, { lookup, linkLocal: true }), { ok: true }, url);
    assert.equal(configuration({ COWORK_DECISION_URL: url }).reason, null, `${url} accepted for the decision service`);
  }
  for (const url of ['http://[fd12:3456::7]:8040', 'http://[::1]:8040', 'http://127.0.0.1:8040']) {
    assert.deepEqual(await helper().checkServiceEndpoint(url, { lookup }), { ok: true }, url);
  }
  // Embeddings keep refusing link-local (#1636).
  const { checkEmbeddingAddress } = require('./embedding-address.cjs');
  assert.equal((await checkEmbeddingAddress('http://169.254.10.20/v1', { lookup })).ok, false);
  assert.deepEqual(await checkEmbeddingAddress('http://rock5b.local:8080/v1', { lookup }), { ok: true });
});

// #1753(a): the shared COWORK_DECISION_API_KEY is sent only to COWORK_DECISION_URL's host.
function settingsWithSpy() {
  const endpointPath = path.join(__dirname, 'decision-endpoint.cjs');
  const settingsPath = path.join(__dirname, 'decision-settings.cjs');
  const real = require(endpointPath);
  const seen = [];
  const savedEndpoint = require.cache[endpointPath], savedSettings = require.cache[settingsPath];
  require.cache[endpointPath] = { ...savedEndpoint, exports: { ...real, createDecisionEndpoint: (o) => { seen.push(o.env); return real.createDecisionEndpoint(o); } } };
  delete require.cache[settingsPath];
  try { return { create: require(settingsPath).createDecisionSettings, seen }; } finally {
    require.cache[endpointPath] = savedEndpoint; require.cache[settingsPath] = savedSettings;
  }
}

test('#1753: a decision URL saved in Settings on another host gets no shared key; the deployment host keeps it', () => {
  const { create, seen } = settingsWithSpy();
  const env = { COWORK_DECISION_URL: 'http://kev:11435', COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_DECISION_API_KEY: 'synthetic-shared-key' };
  const other = create({ store: memory(), env });
  other.save({ url: 'http://10.9.8.7:8040', timeoutMs: 500 }, 'admin');
  assert.ok(other.backend());
  assert.equal(seen.at(-1).COWORK_DECISION_URL, 'http://10.9.8.7:8040');
  assert.equal('COWORK_DECISION_API_KEY' in seen.at(-1), false, 'another host must not receive the shared key');
  const same = create({ store: memory(), env });
  same.save({ url: 'http://kev:11435', timeoutMs: 500 }, 'admin');
  assert.ok(same.backend());
  assert.equal(seen.at(-1).COWORK_DECISION_API_KEY, 'synthetic-shared-key');
  const deployment = create({ store: memory(), env });
  assert.ok(deployment.backend());
  assert.equal(seen.at(-1).COWORK_DECISION_API_KEY, 'synthetic-shared-key', 'the deployment URL keeps its key');
});

test('#1760: 100.100.100.200 (Alibaba Cloud metadata, inside 100.64.0.0/10) is refused; its neighbours are Tailscale', async () => {
  for (const url of ['http://100.100.100.200', 'http://100.100.100.200:8040', 'http://[::ffff:100.100.100.200]:8040']) {
    for (const linkLocal of [false, true]) {
      const r = await helper().checkServiceEndpoint(url, { lookup, linkLocal });
      assert.equal(r.ok, false, url);
      assert.match(r.reason, /cloud metadata/, url);
    }
    assert.ok(configuration({ COWORK_DECISION_URL: url }).reason, url);
    assert.ok(systemOneConfiguration({ COWORK_SYSTEM_ONE_URL: url }).reason, url);
  }
  assert.match(helper().whyNotLocal('100.100.100.200'), /cloud metadata/);
  assert.equal(helper().whyNotLocal('100.100.100.201'), null);
  assert.equal(helper().whyNotLocal('100.100.100.199'), null);
  // A name that resolves to it is refused, before and at connect.
  const table = { 'alibaba.lan': ['100.100.100.200'] };
  assert.equal((await helper().checkServiceEndpoint('http://alibaba.lan:8040', { lookup: async (h) => table[h].map((address) => ({ address, family: 4 })) })).ok, false);
  await assert.rejects(lookupVia(resolveFrom(table), 'alibaba.lan'), (e) => e.code === 'EPUBLICADDR');
  await assert.rejects(helper().createServiceFetch({ resolve: resolveFrom(table) })('http://100.100.100.200/latest/meta-data'), /not on this network/);
});

test('#1760: link-local is off by default; System One and the sensitivity check refuse 169.254.x and fe80::', async () => {
  const urls = ['http://169.254.10.20:8040', 'http://[fe80::1]:8040'];
  for (const url of urls) {
    assert.equal((await helper().checkServiceEndpoint(url, { lookup })).ok, false, url);
    assert.ok(helper().parseServiceUrl(url).reason, url);
    await assert.rejects(helper().serviceFetch(url + '/health'), /not on this network/, url);
    await assert.rejects(helper().createServiceFetch()(url + '/health'), /not on this network/, url);
    assert.ok(systemOneConfiguration({ COWORK_SYSTEM_ONE_URL: url }).reason, `System One refuses ${url}`);
  }
  // A name that resolves to link-local is refused at connect by the default lookup, accepted only with the opt-in.
  await assert.rejects(lookupVia(resolveFrom({ 'll.lan': ['169.254.10.20'] }), 'll.lan'), (e) => e.code === 'EPUBLICADDR');
  await assert.rejects(lookupVia(resolveFrom({ 'll6.lan': ['fe80::1'] }), 'll6.lan'), (e) => e.code === 'EPUBLICADDR');
  // The sensitivity check: its own URL is refused, while the decision service's URL (the same) is kept.
  for (const url of urls) {
    const settings = createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: url, COWORK_SENSITIVITY_DECISION_URL: url }, fetchImpl: async () => assert.fail('no request') });
    assert.ok(settings.backend(), `the decision service keeps ${url}`);
    assert.equal(settings.sensitivityBackend(), null, `the sensitivity check refuses ${url}`);
    const only = createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: 'http://laya:8040', COWORK_SENSITIVITY_DECISION_URL: url } });
    assert.equal(only.sensitivityBackend(), null, `${url} as the sensitivity URL`);
  }
  // Without its own URL the sensitivity check uses the decision service, as before.
  assert.ok(createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: 'http://laya:8040' } }).sensitivityBackend());
});
