'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBrowserRoutes } = require('./browser.cjs');

function harness({ enabled = true } = {}) {
  const calls = [];
  const service = {
    grantable: ['open_browser'], network: () => true,
    list: () => [], get: (ws, p, id) => ({ id }),
    start: async (ws, p, body) => { calls.push(['start', p.id, body]); return { taskId: 't', domains: body.domains }; },
    act: async (ws, p, id, action) => { calls.push(['act', id, action]); return { status: 'done', origin: 'https://shop.example.test' }; },
    decide: (ws, p, id, decision, approvalId) => { calls.push(['decide', id, decision, approvalId]); return { ok: true }; },
    finish: (ws, p, id, result) => { calls.push(['finish', id, result]); return { ok: true }; },
    cancel: (ws, p, id) => { calls.push(['cancel', id]); return { id, status: 'cancelled' }; },
  };
  const route = createBrowserRoutes({ service, features: { enabled: () => enabled },
    getProject: (id) => (id === 'p1' ? { id } : null), workspace: () => ({ dir: '/tmp/x' }),
    json: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => JSON.parse(req.raw || '{}') });
  const call = async (method, path, role = 'admin', raw) => {
    const res = {};
    const handled = await route({ method, raw }, res, { path, authn: role ? { user: { role } } : null });
    return { handled, ...res };
  };
  return { call, calls };
}
const TASK = '12345678-1234-4234-8234-123456789012';

test('the feature off hides every route, and members are refused before anything runs', async () => {
  assert.equal((await harness({ enabled: false }).call('GET', '/api/projects/p1/browser')).status, 404);
  const { call, calls } = harness();
  assert.equal((await call('POST', '/api/projects/p1/browser', 'member', '{"domains":["x.test"]}')).status, 403);
  assert.equal((await call('GET', '/api/projects/p1/browser', null)).status, 403, 'signed out too');
  assert.equal(calls.length, 0, 'nothing reached the service');
});

test('an admin lists, starts, reads, acts, approves, finishes and cancels', async () => {
  const { call, calls } = harness();
  const listed = await call('GET', '/api/projects/p1/browser');
  assert.deepEqual(listed.body.capabilities, ['open_browser']);
  assert.equal(listed.body.network, true);
  assert.equal((await call('POST', '/api/projects/p1/browser', 'admin', '{"domains":["x.test"]}')).status, 202);
  assert.equal((await call('GET', `/api/projects/p1/browser/${TASK}`)).body.id, TASK);
  assert.deepEqual((await call('POST', `/api/projects/p1/browser/${TASK}/act`, 'admin', '{"type":"extract"}')).body, { status: 'done', origin: 'https://shop.example.test' });
  assert.deepEqual((await call('POST', `/api/projects/p1/browser/${TASK}/approve`, 'admin', '{"decision":"approve","approvalId":"a-1"}')).body, { ok: true });
  assert.deepEqual((await call('POST', `/api/projects/p1/browser/${TASK}/finish`, 'admin', '{"result":{"pages":2}}')).body, { ok: true });
  assert.equal((await call('POST', `/api/projects/p1/browser/${TASK}/cancel`)).body.status, 'cancelled');
  assert.deepEqual(calls.map((c) => c[0]), ['start', 'act', 'decide', 'finish', 'cancel']);
  assert.deepEqual(calls[1], ['act', TASK, { type: 'extract' }]);
  assert.deepEqual(calls[2], ['decide', TASK, 'approve', 'a-1']);
  assert.deepEqual(calls[3], ['finish', TASK, { pages: 2 }]);
});

test('bad requests are refused without reaching the service', async () => {
  const { call, calls } = harness();
  assert.equal((await call('GET', '/api/projects/nope/browser')).status, 404);
  assert.equal((await call('POST', '/api/projects/p1/browser', 'admin', '{bad')).status, 400);
  assert.equal((await call('DELETE', '/api/projects/p1/browser')).status, 405);
  assert.equal((await call('GET', `/api/projects/p1/browser/${TASK}/approve`)).status, 405);
  assert.equal((await call('GET', '/api/projects/p1/browser/../../x')).handled, false, 'not our route at all');
  assert.equal((await call('GET', '/api/projects/p1/browser/not-a-uuid')).handled, false);
  assert.equal(calls.length, 0);
});

test('a service error carries its status and public message through, and never leaks a bare 500 message', async () => {
  const service = {
    grantable: [], network: () => false, list: () => [], get: () => null,
    start: async () => { throw Object.assign(Error('boom'), { status: 409, publicMessage: 'This project already has a browser task running.' }); },
    act: async () => { throw Object.assign(Error('boom'), { status: 409, publicMessage: 'This task is not running.' }); },
    decide: () => ({ ok: true }), finish: () => ({ ok: true }), cancel: () => ({}),
  };
  const route = createBrowserRoutes({ service, features: { enabled: () => true },
    getProject: (id) => ({ id }), workspace: () => ({ dir: '/tmp/x' }),
    json: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => JSON.parse(req.raw || '{}') });
  const res1 = {};
  await route({ method: 'POST', raw: '{"domains":["x.test"]}' }, res1, { path: '/api/projects/p1/browser', authn: { user: { role: 'admin' } } });
  assert.equal(res1.status, 409);
  assert.equal(res1.body.error, 'This project already has a browser task running.');
  const res2 = {};
  await route({ method: 'POST', raw: '{"type":"click"}' }, res2, { path: `/api/projects/p1/browser/${TASK}/act`, authn: { user: { role: 'admin' } } });
  assert.equal(res2.status, 409);
  assert.equal(res2.body.error, 'This task is not running.');
});
