'use strict';
// sbstndalton/noevia#2384: the facts the Rust front's reasoning-settings read asks this process for, over the REAL
// reasoning-effort.cjs modeFor and provider registry (no reimplementation), and the GET refusal marker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createReasoningReadFacts, PATH } = require('./rust-reasoning-read-facts.cjs');
const { refuseOwned, REFUSAL, OWNED_ROUTES } = require('./rust-reasoning-read.cjs');
const { createProviderRegistry } = require('./providers.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');

const SECRET = 'synthetic-secret';
const PROVIDERS = [
  { id: 'default', baseUrl: 'http://engine.invalid/v1', apiKey: 'k0', capabilities: {} },
  { id: 'real', baseUrl: 'http://api.invalid/v1', apiKey: 'k1', capabilities: { reasoningEffortParam: true } },
  { id: 'scoped', baseUrl: 'http://api2.invalid/v1', apiKey: 'k2', capabilities: { reasoningEffortParam: true, reasoningEffortModels: ['m-ok'] } },
];
const { getProvider } = createProviderRegistry({ PROVIDERS, DEFAULT_PROVIDER_ID: 'default' });

function rig({ secret = SECRET, modeFor } = {}) {
  const sent = [], seen = [];
  const handle = createReasoningReadFacts({
    secret, json: (res, status, body) => sent.push({ status, body }),
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return JSON.parse(s); },
    modeFor: modeFor || (async (ask) => { seen.push(ask); return reasoningEffort.modeFor(getProvider(ask.provider || 'default'), ask.model, ask.effort); }),
    log: () => {},
  });
  const call = (body, { method = 'POST', url = PATH, headers = { 'x-noevia-store-token': SECRET }, remote = '127.0.0.1' } = {}) => {
    const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, url, headers, socket: { remoteAddress: remote } });
    return handle(req, {});
  };
  return { call, sent, seen };
}

test('the mode is the route\'s: off at the default effort, real for a documented pair, a hint otherwise', async () => {
  const r = rig();
  const ask = async (provider, model, effort) => { assert.equal(await r.call({ user: 'u1', provider, model, effort }), true); return r.sent.pop(); };
  assert.deepEqual(await ask(null, '', 'default'), { status: 200, body: { mode: 'off' } });
  assert.deepEqual(await ask(null, '', 'high'), { status: 200, body: { mode: 'hint' } });
  assert.deepEqual(await ask('real', 'any', 'low'), { status: 200, body: { mode: 'real' } });
  assert.deepEqual(await ask('scoped', 'm-ok', 'high'), { status: 200, body: { mode: 'real' } });
  assert.deepEqual(await ask('scoped', 'other', 'high'), { status: 200, body: { mode: 'hint' } });
  assert.deepEqual(await ask('ghost', 'm-ok', 'high'), { status: 200, body: { mode: 'hint' } }, 'an unknown provider falls back to the default provider');
  // The default provider and the empty model are applied where the route applied them.
  assert.deepEqual(r.seen.at(-1), { user: 'u1', provider: 'ghost', model: 'm-ok', effort: 'high' });
  assert.deepEqual(r.seen[1], { user: 'u1', provider: null, model: '', effort: 'high' });
});

test('a provider that rejected the parameter during a turn is a hint again (the live rejection set stays this process\'s)', async () => {
  const r = rig();
  const provider = getProvider('real');
  const before = await (async () => { await r.call({ user: 'u1', provider: 'real', model: 'rej-m', effort: 'high' }); return r.sent.pop(); })();
  assert.equal(before.body.mode, 'real');
  // The turn's own request path records the rejection (reasoning-effort.cjs requestWithEffort).
  const replies = [new Response('unknown field reasoning_effort', { status: 400 }), new Response('{}', { status: 200 })];
  await reasoningEffort.requestWithEffort(async () => replies.shift(), 'http://api.invalid/v1', {}, { model: 'rej-m', messages: [] }, provider, 'rej-m', 'high', () => {});
  await r.call({ user: 'u1', provider: 'real', model: 'rej-m', effort: 'high' });
  assert.equal(r.sent.pop().body.mode, 'hint');
});

test('only the front\'s own loopback call with the per-start secret is answered; anything else is an unknown path', async () => {
  const r = rig();
  const body = { user: 'u1', provider: null, model: '', effort: 'high' };
  assert.equal(await r.call(body, { url: '/internal/other' }), false);
  for (const opts of [{ method: 'GET' }, { headers: {} }, { headers: { 'x-noevia-store-token': 'wrong' } }, { remote: '10.0.0.5' },
    { headers: { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '1.2.3.4' } }, { headers: { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '1.2.3.4' } }]) {
    assert.equal(await r.call(body, opts), true);
    assert.deepEqual(r.sent.pop(), { status: 404, body: { error: 'Not found' } }, JSON.stringify(opts));
  }
  const empty = rig({ secret: '' });
  assert.equal(await empty.call(body, { headers: { 'x-noevia-store-token': '' } }), true);
  assert.equal(empty.sent.pop().status, 404, 'an empty secret trusts nobody');
  assert.equal(r.seen.length, 0, 'nothing was looked up for a refused call');
});

test('a malformed ask is a 400 and a lookup that fails or answers nothing known is a 503, never a guessed mode', async () => {
  const r = rig();
  await r.call('{'); assert.deepEqual(r.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  for (const bad of [{}, { user: '', effort: 'high' }, { user: 'u1', effort: 'max' }, { user: 5, effort: 'high' }, { user: 'u1' }]) {
    await r.call(bad); assert.equal(r.sent.pop().status, 400, JSON.stringify(bad));
  }
  for (const modeFor of [async () => { throw new Error('no such user'); }, async () => 'maybe', async () => undefined]) {
    const x = rig({ modeFor });
    await x.call({ user: 'u1', provider: null, model: '', effort: 'high' });
    assert.deepEqual(x.sent.pop(), { status: 503, body: { error: 'Reasoning facts are unavailable.' } });
  }
});

test('the GET refusal marker refuses exactly GET /api/reasoning-settings, whatever the query', () => {
  const sent = [];
  const json = (_res, status, body) => sent.push({ status, body });
  const parseRequestUrl = (req) => new URL(req.url, 'http://localhost');
  assert.deepEqual([...OWNED_ROUTES], ['GET /api/reasoning-settings']);
  assert.equal(refuseOwned({ method: 'GET', url: '/api/reasoning-settings?projectId=p1' }, {}, { parseRequestUrl, json }), true);
  assert.deepEqual(sent.pop(), { status: 503, body: REFUSAL });
  for (const [method, url] of [['PUT', '/api/reasoning-settings'], ['POST', '/api/reasoning-settings'], ['GET', '/api/reasoning-settings/'], ['GET', '/api/reasoning-setting'], ['GET', '/api/routing-default']]) {
    assert.equal(refuseOwned({ method, url }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  assert.equal(sent.length, 0);
});
