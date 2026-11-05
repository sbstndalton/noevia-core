'use strict';
// Synthetic route contract captured before native task ownership changes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodeRoutes } = require('./code.cjs');
const { createBrowserRoutes } = require('./browser.cjs');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
for (const surface of ['code', 'browser']) {
  const factory = surface === 'code' ? createCodeRoutes : createBrowserRoutes;
  for (const action of ['', 'cancel', 'approve', ...(surface === 'browser' ? ['act', 'finish'] : [])]) {
    test(`${surface} ${action || 'start'} preserves dispatch and response`, async () => {
      const calls = [];
      const body = { decision: 'approve_all', approvalId: 'card', result: { done: true }, type: 'click' };
      const ws = { dir: '/synthetic/account' }, project = { id: 'p' };
      let response;
      const service = Object.fromEntries(['start', 'cancel', 'decide', 'act', 'finish'].map(name => [name, (...args) => {
        calls.push([name, ...args]); return { receipt: name };
      }]));
      const route = factory({ service, features: { enabled: () => true }, getProject: () => project,
        workspace: () => ws, json: (_, status, value) => { response = { status, value }; }, readJson: async () => body });
      const path = `/api/projects/p/${surface}${action ? `/${ID}/${action}` : ''}`;
      assert.equal(await route({ method: 'POST' }, {}, { path, authn: { user: { role: 'admin' } } }), true);
      const name = action === 'approve' ? 'decide' : action || 'start';
      assert.deepEqual(response, { status: action ? 200 : 202, value: { receipt: name } });
      const args = name === 'start' ? [ws, project, body] : name === 'cancel' ? [ws, project, ID]
        : name === 'decide' ? [ws, project, ID, 'approve_all', 'card']
        : [ws, project, ID, name === 'finish' ? body.result : body];
      assert.deepEqual(calls, [[name, ...args]]);
    });
  }
  for (const scenario of ['disabled', 'member', 'missing', 'json', 'unavailable', 'internal']) {
    test(`${surface} start ${scenario} error contract`, async () => {
      let response;
      const route = factory({
        service: { start: async () => { throw scenario === 'unavailable' ? Object.assign(Error('private'), { status: 503, publicMessage: 'Authority unavailable' }) : Error('secret'); } },
        features: { enabled: () => scenario !== 'disabled' }, getProject: () => scenario === 'missing' ? null : { id: 'p' }, workspace: () => ({}),
        json: (_, status, value) => { response = { status, value }; }, readJson: async () => { if (scenario === 'json') throw SyntaxError(); return {}; },
      });
      await route({ method: 'POST' }, {}, { path: `/api/projects/p/${surface}`, authn: { user: { role: scenario === 'member' ? 'member' : 'admin' } } });
      const expected = {
        disabled: [404, `${surface === 'code' ? 'Code' : 'Browser'} mode is not enabled on this server.`],
        member: [403, 'Administrator required'], missing: [404, 'project not found'], json: [400, 'invalid JSON'],
        unavailable: [503, 'Authority unavailable'], internal: [500, `${surface === 'code' ? 'Code' : 'Browser'} request failed`],
      }[scenario];
      assert.deepEqual(response, { status: expected[0], value: { error: expected[1] } });
    });
  }
}
for (const surface of ['code', 'browser']) {
  const factory = surface === 'code' ? createCodeRoutes : createBrowserRoutes;
  test(`${surface} action without task id retains the existing start alias`, async () => {
    let response, started = 0;
    const route = factory({ service: { start: async () => { started++; return { taskId: ID }; } },
      features: { enabled: () => true }, getProject: () => ({ id: 'p' }), workspace: () => ({}),
      json: (_, status, value) => { response = { status, value }; }, readJson: async () => ({}) });
    assert.equal(await route({ method: 'POST' }, {}, { path: `/api/projects/p/${surface}/cancel`, authn: { user: { role: 'admin' } } }), true);
    assert.equal(started, 1);
    assert.deepEqual(response, { status: 202, value: { taskId: ID } });
  });
  test(`${surface} project and method rejection precede JSON reads`, async () => {
    let status, reads = 0;
    for (const exists of [false, true]) {
      const route = factory({ service: {}, features: { enabled: () => true }, getProject: () => exists ? { id: 'p' } : null,
        workspace: () => ({}), json: (_, code) => { status = code; }, readJson: async () => { reads++; throw SyntaxError(); } });
      await route({ method: 'HEAD' }, {}, { path: `/api/projects/p/${surface}`, authn: { user: { role: 'admin' } } });
      assert.equal(status, exists ? 405 : 404);
    }
    assert.equal(reads, 0);
  });
}
