'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createEmbeddingConfig } = require('../../server/embedding-config.cjs');
const { createEmbeddingRoutes } = require('../../server/routes/embedding.cjs');

// Record against the unmodified route at the pinned main. The only network peer
// is a disposable loopback server; no inference or user text is involved.
test('synthetic request and config oracle', async (t) => {
  const fake = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-next' }] }));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fake.close(resolve)));
  const base = `http://127.0.0.1:${fake.address().port}`;
  const requests = [
    ['GET', null, null], ['GET', 'member', null], ['PUT', 'admin', {}],
    ['POST', 'admin', 'malformed'], ['POST', 'admin', null], ['POST', 'admin', []],
    ['POST', 'admin', {}], ['POST', 'admin', { action: 'unknown' }],
    ['POST', 'admin', { action: 'set-next' }],
    ['POST', 'admin', { action: 'clear-next', scope: 'bad' }],
    ['POST', 'admin', { action: 'service-off' }], ['POST', 'admin', { action: 'service-switch' }],
    ['POST', 'admin', { action: 'set-next', target: { model: 'fixture-next' } }],
    ['POST', 'admin', { action: 'set-next', scope: 'projects', target: { model: 'not-served' } }],
    ['POST', 'admin', { action: 'clear-next', scope: 'projects' }], ['GET', 'admin', null],
  ];
  const answers = [];
  for (const [method, role, body] of requests) {
    // The handler returns a handled boolean; capture its response callback.
    let answer;
    const res = { setHeader() {} };
    // Use a wrapper response slot because json's result is intentionally discarded.
    const capture = createEmbeddingRoutes({
      json: (_res, status, value) => { answer = { status, body: value }; },
      readJson: async () => { if (body === 'malformed') throw Error('bad'); return body; },
      migration: { status: () => ({ fixture: true }), clearNext: () => ({ fixture: true }) },
      authService: {}, fetchJson: async () => { throw Error('unexpected network'); },
      checkAddress: async () => ({ ok: true }), servedModels: async () => {
        const r = await fetch(`${base}/v1/models`); return (await r.json()).data.map((v) => v.id);
      },
    });
    await capture({ method }, res, { path: '/api/embedding', authn: role ? { user: { id: 'fixture-admin', role } } : null });
    answers.push({ method, role, input: body, ...answer });
  }
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'fixture-active' }, log() {} });
  const steps = [ ['switchToNext'], ['rollback'], ['finish'], ['setNext', { model: 'fixture-active' }],
    ['setNext', { model: 'fixture-next', baseUrl: ' http://127.0.0.1:1234/v1/// ' }],
    ['switchToNext'], ['rollback'], ['finish'], ['clearNext'] ];
  const states = steps.map(([action, input]) => {
    try { const c = config[action](input); return { action, input: input ?? null, state: { active: c.active, next: c.next, previous: c.previous } }; }
    catch (e) { return { action, input: input ?? null, error: { status: e.status, code: e.code, message: e.message } }; }
  });
  const oracle = { core: '99ebd9c951b16cb6beeeae8bd79722cf4f3368bb', requests: answers, states };
  const file = path.join(__dirname, '../fixtures/embedding-route-oracle.json');
  if (process.env.RECORD_EMBEDDING_ORACLE === '1') fs.writeFileSync(file, JSON.stringify(oracle, null, 2) + '\n');
  else assert.deepEqual(oracle, JSON.parse(fs.readFileSync(file, 'utf8')));
});
