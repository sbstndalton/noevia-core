'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createCodeRoutes } = require('./code.cjs');

function harness({ enabled = true } = {}) {
  const calls = [];
  const service = {
    repositories: () => [{ id: 'noevia' }],
    grantable: ['read_repository', 'edit_file'], defaultCapabilities: ['read_repository'],
    list: () => [], get: (ws, p, id) => ({ id }),
    start: async (ws, p, body) => { calls.push(['start', p.id, body]); return { taskId: 't', branch: 'noevia/task-t' }; },
    decide: (ws, p, id, decision) => { calls.push(['decide', id, decision]); return { ok: true }; },
    cancel: (ws, p, id) => { calls.push(['cancel', id]); return { id, status: 'cancelled' }; },
  };
  const route = createCodeRoutes({ service, features: { enabled: () => enabled },
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
  assert.equal((await harness({ enabled: false }).call('GET', '/api/projects/p1/code')).status, 404);
  const { call, calls } = harness();
  assert.equal((await call('POST', '/api/projects/p1/code', 'member', '{"prompt":"x"}')).status, 403);
  assert.equal((await call('GET', '/api/projects/p1/code', null)).status, 403, 'signed out too');
  assert.equal(calls.length, 0, 'nothing reached the service');
});

test('an admin lists, starts, reads, approves and cancels', async () => {
  const { call, calls } = harness();
  const listed = await call('GET', '/api/projects/p1/code');
  assert.deepEqual(listed.body.repositories, [{ id: 'noevia' }]);
  assert.deepEqual(listed.body.capabilities, ['read_repository', 'edit_file']);
  assert.equal((await call('POST', '/api/projects/p1/code', 'admin', '{"repository":"noevia","prompt":"fix"}')).status, 202);
  assert.equal((await call('GET', `/api/projects/p1/code/${TASK}`)).body.id, TASK);
  assert.deepEqual((await call('POST', `/api/projects/p1/code/${TASK}/approve`, 'admin', '{"decision":"approve"}')).body, { ok: true });
  assert.equal((await call('POST', `/api/projects/p1/code/${TASK}/cancel`)).body.status, 'cancelled');
  assert.deepEqual(calls.map((c) => c[0]), ['start', 'decide', 'cancel']);
  assert.deepEqual(calls[1], ['decide', TASK, 'approve']);
});

test('bad requests are refused without reaching the service', async () => {
  const { call, calls } = harness();
  assert.equal((await call('GET', '/api/projects/nope/code')).status, 404);
  assert.equal((await call('POST', '/api/projects/p1/code', 'admin', '{bad')).status, 400);
  assert.equal((await call('DELETE', '/api/projects/p1/code')).status, 405);
  assert.equal((await call('GET', `/api/projects/p1/code/${TASK}/approve`)).status, 405);
  assert.equal((await call('GET', '/api/projects/p1/code/../../x')).handled, false, 'not our route at all');
  assert.equal((await call('GET', '/api/projects/p1/code/not-a-uuid')).handled, false);
  assert.equal(calls.length, 0);
});

test('an approval decision is passed through verbatim, so the service decides what is valid', async () => {
  const { call, calls } = harness();
  await call('POST', `/api/projects/p1/code/${TASK}/approve`, 'admin', '{"decision":"approve_all"}');
  await call('POST', `/api/projects/p1/code/${TASK}/approve`, 'admin', '{}');
  assert.deepEqual(calls.map((c) => c[2]), ['approve_all', '']);
});
