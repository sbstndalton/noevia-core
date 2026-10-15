'use strict';
// #1841 OCR and Docling, #1844 the sensitivity check's own decision service: assignable on Settings → Inference
// machines. Synthetic addresses and a loopback fixture only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createInferenceMachines } = require('./inference-machines.cjs');
const workers = require('./document-workers.cjs');
const ocr = require('./ocr.cjs');
const docling = require('./docling.cjs');
const docx = require('./docx.cjs');
const { createDecisionSettings, describeDecision } = require('./decision-settings.cjs');

const ANSWERS = { 'pi5.lan': ['192.168.1.50'], 'public.example': ['93.184.216.34'] };
const lookup = async (host) => { if (!ANSWERS[host]) throw Object.assign(Error('nf'), { code: 'ENOTFOUND' }); return ANSWERS[host].map((address) => ({ address, family: 4 })); };
const memoryStore = (seed = {}) => { const m = new Map(Object.entries(seed)); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k) }; };
const registry = () => createInferenceMachines({ store: memoryStore(), lookup, log: () => {} });

test.afterEach(() => workers.useMachines());

function withEnv(env, fn) {
  const before = {};
  for (const k of Object.keys(env)) { before[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const restore = () => { for (const k of Object.keys(env)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}

/** A loopback worker that records what it was sent and answers like OCR / Docling. */
async function worker(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen.push({ url: req.url, headers: req.headers, size: Buffer.concat(chunks).length }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply(req.url))); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('default: nothing assigned reads the environment and the plain global fetch, as before', async () => {
  const machines = registry();
  workers.useMachines((kind) => machines.urlFor(kind));
  await withEnv({ OCR_BASE_URL: 'http://ocr:8030', DOCLING_BASE_URL: undefined }, async () => {
    assert.equal(machines.urlFor('ocr'), null);
    assert.equal(machines.urlFor('documents'), null);
    assert.equal(machines.urlFor('sensitivity'), null);
    const r = workers.resolve('ocr');
    assert.deepEqual({ url: r.url, machine: r.machine, fetch: r.fetch === globalThis.fetch }, { url: 'http://ocr:8030', machine: false, fetch: true });
    assert.equal(docling.enabled(), false);
    assert.equal(workers.resolve('documents').url, undefined);
    assert.ok(require('./documents.cjs').EXTRACTOR_VERSION.endsWith(':' + ocr.VERSION));
  });
  await withEnv({ OCR_BASE_URL: undefined, DOCLING_BASE_URL: 'http://docling:8031' }, async () => {
    assert.equal(docling.enabled(), true);
    assert.equal(require('./documents.cjs').EXTRACTOR_VERSION, `docling-pages-v1:${docling.VERSION}`);
  });
  // An explicit url / fetchImpl (callers and tests) still wins and keeps the global fetch.
  const calls = [];
  const out = await ocr.extractPages(Buffer.from('x'), [1], { url: 'http://explicit:1/', fetchImpl: async (u) => { calls.push(String(u)); return new Response(JSON.stringify({ pages: [{ number: 1, text: 't' }] })); } });
  assert.deepEqual(calls, ['http://explicit:1/extract']);
  assert.equal(out[0].text, 't');
});

test('assignment overrides the environment; unassigning falls back to it', async () => {
  const machines = registry();
  workers.useMachines((kind) => machines.urlFor(kind));
  const { machine } = await machines.add({ name: 'Pi 5', address: 'pi5.lan' }, 'admin');
  await withEnv({ OCR_BASE_URL: 'http://ocr:8030', DOCLING_BASE_URL: 'http://docling:8031' }, async () => {
    machines.assign({ service: 'ocr', machine: machine.id, port: 8030 }, 'admin');
    machines.assign({ service: 'documents', machine: machine.id, port: 8031 }, 'admin');
    assert.deepEqual(machines.view().machines.find((m) => m.id === machine.id).services, ['ocr', 'documents']);
    const o = workers.resolve('ocr'), d = workers.resolve('documents');
    assert.equal(o.url, 'http://pi5.lan:8030'); assert.equal(d.url, 'http://pi5.lan:8031');
    assert.ok(o.machine && d.machine && o.fetch !== globalThis.fetch, 'a machine address goes through the on-this-network fetch');
    machines.assign({ service: 'ocr', machine: 'local' }, 'admin');
    assert.equal(workers.resolve('ocr').url, 'http://ocr:8030');
    assert.equal(workers.resolve('ocr').fetch, globalThis.fetch);
  });
  // Assigned with nothing in the environment: the worker counts as configured.
  await withEnv({ OCR_BASE_URL: undefined, DOCLING_BASE_URL: undefined }, async () => {
    assert.equal(docling.enabled(), true);
    assert.equal(workers.configured('ocr'), false);
    machines.assign({ service: 'ocr', machine: machine.id, port: 8030 }, 'admin');
    assert.equal(workers.configured('ocr'), true);
  });
});

test('a public or link-local machine cannot be added, and services cannot be assigned to a missing one', async () => {
  const machines = registry();
  await assert.rejects(machines.add({ name: 'Cloud', address: 'public.example' }, 'admin'), (e) => e.code === 'publicAddress');
  await assert.rejects(machines.add({ name: 'Cloud', address: '93.184.216.34' }, 'admin'), (e) => e.code === 'publicAddress');
  await assert.rejects(machines.add({ name: 'LL', address: '169.254.10.10' }, 'admin'), (e) => e.code === 'publicAddress');
  for (const service of ['ocr', 'documents', 'sensitivity']) assert.throws(() => machines.assign({ service, machine: 'm_missing', port: 8030 }, 'admin'), (e) => e.status === 404);
});

test('connect time: an address that is, or now resolves to, link-local is refused and nothing is sent', async () => {
  workers.useMachines((kind) => (kind === 'ocr' ? 'http://169.254.10.10:8030' : null));
  await withEnv({ OCR_BASE_URL: undefined }, async () => {
    await assert.rejects(ocr.extractPages(Buffer.from('%PDF-'), [1]), (e) => e.code === 'EPUBLICADDR');
    await assert.rejects(docx.extract(Buffer.from('x')), (e) => e.code === 'EPUBLICADDR');
  });
  // A name re-pointed to 169.254.x after it was saved: the socket's own lookup (what serviceFetch connects with) refuses it.
  const lookupRefuses = (name) => new Promise((resolve) => require('./service-endpoint.cjs').createServiceLookup({ resolve: (h, o, cb) => cb(null, [{ address: '169.254.10.10', family: 4 }]) })(name, { all: true }, (err) => resolve(err)));
  const err = await lookupRefuses('pi5.lan');
  assert.equal(err?.code, 'EPUBLICADDR');
});

test('a machine worker receives the document and no token; a redirect is not followed', async () => {
  const w = await worker((url) => (url === '/extract' ? { pages: [{ number: 1, text: 'hello' }] } : { text: 'doc', truncated: false }));
  const redirect = http.createServer((req, res) => { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); res.end(); });
  await new Promise((r) => redirect.listen(0, '127.0.0.1', r));
  try {
    const port = { ocr: w.port, documents: w.port };
    workers.useMachines((kind) => (port[kind] ? `http://127.0.0.1:${port[kind]}` : null));
    await withEnv({ OCR_BASE_URL: 'http://ocr:8030', COWORK_DECISION_API_KEY: 'local-secret', INFERENCE_API_KEY: 'local-secret-2', DIARY_SERVICE_TOKEN: 'local-secret-3' }, async () => {
      const pages = await ocr.extractPages(Buffer.from('%PDF-1'), [1]);
      assert.equal(pages[0].text, 'hello');
      const sent = w.seen[0];
      assert.equal(sent.url, '/extract');
      assert.equal(sent.headers['content-type'], 'application/pdf');
      assert.equal(sent.headers.authorization, undefined);
      assert.equal(sent.headers.cookie, undefined);
      assert.equal(Object.keys(sent.headers).filter((k) => /auth|token|key|secret/i.test(k)).length, 0);
      assert.ok(!JSON.stringify(sent.headers).includes('local-secret'));
      const doc = await docling.extractDocument('a.pdf', Buffer.from('x')).catch((e) => e);
      assert.ok(w.seen.length >= 2, 'docling went to the machine too');
      assert.equal(w.seen[1].headers.authorization, undefined);
      assert.equal(doc.pages[0].text, 'hello');
      port.ocr = redirect.address().port;
      await assert.rejects(ocr.extractPages(Buffer.from('%PDF-1'), [1]), /redirect|refused/);
    });
  } finally { await w.close(); await new Promise((r) => redirect.close(r)); }
});

test('sensitivity: unassigned it is exactly today (own URL or shared); assigned, the machine wins with link-local refused and no foreign key', async () => {
  const machines = registry();
  const { machine } = await machines.add({ name: 'Pi 5', address: 'pi5.lan' }, 'admin');
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url: String(url), headers: init.headers }); return new Response(JSON.stringify({ selected: 'a', scores: { a: 0.9, b: 0.1 } })); };
  const make = (env) => createDecisionSettings({ store: memoryStore(), env, fetchImpl, sensitivityFetchImpl: fetchImpl,
    machineUrl: () => machines.urlFor('decision'), sensitivityMachineUrl: () => machines.urlFor('sensitivity') });
  const ask = (b) => b.decide({ question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  // Shared (no URL of its own): follows the decision service.
  const shared = make({ COWORK_DECISION_URL: 'http://kev:11435', COWORK_DECISION_API_KEY: 'shared-key' });
  assert.equal(shared.sensitivityBackend(), shared.backend());
  assert.equal(shared.describe().sensitivity.shared, true);
  // Its own URL: unchanged.
  const own = make({ COWORK_DECISION_URL: 'http://kev:11435', COWORK_SENSITIVITY_DECISION_URL: 'http://laya:8040', COWORK_SENSITIVITY_DECISION_API_KEY: 'sens-key', COWORK_SENSITIVITY_DECISION_MODEL: 'kev-0.8b' });
  await ask(own.sensitivityBackend()).catch(() => {});
  assert.equal(sent.at(-1).url.startsWith('http://laya:8040'), true);
  assert.match(JSON.stringify(sent.at(-1).headers), /sens-key/);
  // Assigned: the machine's address, no key of another host.
  machines.assign({ service: 'sensitivity', machine: machine.id, port: 8040 }, 'admin');
  const moved = make({ COWORK_DECISION_URL: 'http://kev:11435', COWORK_DECISION_API_KEY: 'shared-key', COWORK_SENSITIVITY_DECISION_URL: 'http://laya:8040', COWORK_SENSITIVITY_DECISION_API_KEY: 'sens-key', COWORK_SENSITIVITY_DECISION_MODEL: 'kev-0.8b' });
  await ask(moved.sensitivityBackend()).catch(() => {});
  assert.equal(sent.at(-1).url.startsWith('http://pi5.lan:8040'), true);
  assert.ok(!/sens-key|shared-key/.test(JSON.stringify(sent.at(-1).headers)), 'no local key goes to another host');
  assert.notEqual(moved.sensitivityBackend(), moved.backend(), 'the decision service is not moved by it');
  assert.equal(moved.backend().id, 'decision-service');
  assert.equal(moved.describe().sensitivity.shared, false);
  // Unassigned again: back to its own URL.
  machines.assign({ service: 'sensitivity', machine: 'local' }, 'admin');
  assert.equal(machines.urlFor('sensitivity'), null);
  await ask(moved.sensitivityBackend()).catch(() => {});
  assert.equal(sent.at(-1).url.startsWith('http://laya:8040'), true);
});

test('sensitivity on a machine uses the link-local-refusing fetch, never the decision service one', async () => {
  const machines = registry();
  const { machine } = await machines.add({ name: 'Pi 5', address: 'pi5.lan' }, 'admin');
  machines.assign({ service: 'sensitivity', machine: machine.id, port: 8040 }, 'admin');
  const wire = [];
  const s = createDecisionSettings({ store: memoryStore(), env: {}, fetchImpl: async () => assert.fail('machine traffic must not use the link-local-allowed fetch'),
    sensitivityFetchImpl: async (url) => { wire.push(String(url)); throw Object.assign(new Error('refused'), { code: 'EPUBLICADDR' }); }, sensitivityMachineUrl: () => machines.urlFor('sensitivity') });
  await assert.rejects(s.sensitivityBackend().decide({ question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }));
  assert.equal(wire.length, 1);
  assert.equal(describeDecision({}, null, 'http://169.254.1.1:8040').sensitivity.state, 'off', 'a link-local machine address is not active');
  assert.equal(createDecisionSettings({ store: memoryStore(), env: {}, sensitivityMachineUrl: () => 'http://169.254.1.1:8040' }).sensitivityBackend(), null);
});
