'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createResearchRoutes, parseSearchResults } = require('./research.cjs');

function harness({ enabled = true, reason = null } = {}) {
  const calls = [];
  const service = {
    budget: { maxWebCalls: 12 },
    plan: async (ws, p, q) => { calls.push(['plan', p.id, q]); return ['a', 'b', 'c']; },
    start: async (ws, p, body) => { calls.push(['start', p.id, body]); return { id: 'j' }; },
    list: () => [], get: (ws, p, id) => ({ id }), cancel: (ws, p, id) => { calls.push(['cancel', id]); return { id, status: 'cancelled' }; },
    savePartial: async () => { throw Object.assign(Error('Only a cancelled job with finished sections can be saved.'), { status: 409, publicMessage: 'Only a cancelled job with finished sections can be saved.' }); },
  };
  const route = createResearchRoutes({ service, features: { enabled: () => enabled }, getProject: (id) => (id === 'p1' ? { id } : null),
    workspace: () => ({ dir: '/tmp/x' }), available: () => reason, json: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => JSON.parse(req.raw || '{}') });
  const call = async (method, path, role = 'admin', raw) => { const res = {}; const handled = await route({ method, raw }, res, { path, authn: role ? { user: { role } } : null }); return { handled, ...res }; };
  return { call, calls };
}
const JOB = '12345678-1234-4234-8234-123456789012';

test('feature off hides every route; members are refused', async () => {
  assert.equal((await harness({ enabled: false }).call('GET', '/api/projects/p1/research')).status, 404);
  const { call, calls } = harness();
  assert.equal((await call('POST', '/api/projects/p1/research', 'member', '{"question":"q"}')).status, 403);
  assert.equal(calls.length, 0);
});

test('admin plan, start, get, cancel, save and errors', async () => {
  const { call, calls } = harness();
  assert.deepEqual((await call('POST', '/api/projects/p1/research/plan', 'admin', '{"question":"q"}')).body, { subQuestions: ['a', 'b', 'c'] });
  assert.equal((await call('POST', '/api/projects/p1/research', 'admin', '{"question":"q"}')).status, 202);
  assert.equal((await call('GET', `/api/projects/p1/research/${JOB}`)).body.id, JOB);
  assert.equal((await call('POST', `/api/projects/p1/research/${JOB}/cancel`)).body.status, 'cancelled');
  const save = await call('POST', `/api/projects/p1/research/${JOB}/save`);
  assert.deepEqual([save.status, save.body.error], [409, 'Only a cancelled job with finished sections can be saved.']);
  assert.equal((await call('GET', '/api/projects/nope/research')).status, 404);
  assert.equal((await call('POST', '/api/projects/p1/research', 'admin', '{bad')).status, 400);
  assert.equal((await call('DELETE', '/api/projects/p1/research')).status, 405);
  assert.equal((await call('GET', '/api/projects/p1/research/../x')).handled, false);
  assert.deepEqual(calls.map((c) => c[0]), ['plan', 'start', 'cancel']);
});

test('unavailable prerequisites refuse plan and start with the reason, but listing still works', async () => {
  const { call, calls } = harness({ reason: 'Offer the web-search toolbox first.' });
  assert.deepEqual((await call('POST', '/api/projects/p1/research', 'admin', '{"question":"q"}')).body, { error: 'Offer the web-search toolbox first.' });
  assert.equal((await call('POST', '/api/projects/p1/research/plan', 'admin', '{"question":"q"}')).status, 409);
  const listed = await call('GET', '/api/projects/p1/research');
  assert.deepEqual([listed.status, listed.body.available, listed.body.reason], [200, false, 'Offer the web-search toolbox first.']);
  assert.equal(calls.length, 0);
});

test('search result parsing', () => {
  assert.deepEqual(parseSearchResults('{"results":[{"url":"https://a.test","title":"A"},{"title":"no url"}]}'), [{ url: 'https://a.test', title: 'A' }]);
  assert.deepEqual(parseSearchResults('Detailed Results:\n\nTitle: B page\nURL: https://b.test/x\nContent: ...\n\nURL: https://c.test'), [{ url: 'https://b.test/x', title: 'B page' }, { url: 'https://c.test', title: 'https://c.test' }]);
  assert.deepEqual(parseSearchResults('URL: javascript:alert(1)'), []);
});
