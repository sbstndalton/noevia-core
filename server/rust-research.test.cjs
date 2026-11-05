'use strict';
// #2218: deep research is the Rust front's. Node refuses every method of its paths before authentication, the front's
// loopback bridge offers only the two facts only this process holds (the model it last loaded, a project's retrieval) as the
// asking user, and the old handlers, the search-tool bridge and the Node tool executor are gone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-research.cjs');
const { createResearchBridge } = require('./rust-research-bridge.cjs');
const { stripBoilerplate } = require('./strip-boilerplate.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);
const JOB = '0123abcd-0123-4abc-8def-0123456789ab';

test('every method of the old matcher is refused, and nothing beside it', () => {
  assert.equal(ROUTE_REFUSAL.code, 'RUST_RESEARCH_OWNED');
  assert.equal(OWNED_ROUTES.size, 5);
  for (const r of OWNED_ROUTES) assert.match(r, /^ALL /);
  for (const p of [`/api/projects/p/research`, `/api/projects/p/research/plan`, `/api/projects/p/research/${JOB}`, `/api/projects/p/research/${JOB}/cancel`, `/api/projects/p/research/${JOB}/save`, '/api/projects/p%2F1/research']) {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) assert.equal(owned(m, p), true, `${m} ${p}`);
  }
  for (const p of ['/api/projects/p/researching', '/api/projects/p/research/not-a-job', '/api/projects/p/code', '/api/projects/p/browser', '/api/projects/a/b/research']) assert.equal(owned('GET', p), false, p);
  const seen = [];
  const res = {};
  const parseRequestUrl = (req) => new URL(req.url, 'http://localhost');
  assert.equal(refuseOwned({ method: 'GET', url: '/api/projects/p/research' }, res, { parseRequestUrl, json: (_, s, b) => seen.push([s, b]) }), true);
  assert.deepEqual(seen, [[503, ROUTE_REFUSAL]]);
  assert.equal(refuseOwned({ method: 'GET', url: '/x' }, res, { parseRequestUrl: () => null, json }), false, 'an unparseable target falls through');
});

test('the marker pairs with the capability, before authentication, and the Node handlers are gone', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const marker = "require('./rust-research.cjs').refuseOwned(";
  assert.ok(index.includes(marker));
  assert.ok(index.indexOf(marker) < index.indexOf('requestAuth.authenticate(req)', index.indexOf('async function handleRequestInner')));
  for (const gone of ['routes/research.cjs', 'research-service.cjs', 'research-runner.cjs', 'research-plan.cjs', 'research-sources.cjs', 'research-model.cjs', 'research-jobs.cjs']) {
    assert.equal(fs.existsSync(path.join(__dirname, gone)), false, gone);
    assert.equal(index.includes(`./${gone}`), false, gone);
  }
});

async function bridge(t, overrides = {}) {
  const calls = [];
  const handle = createResearchBridge({
    secret: SECRET, json, readJson, log: () => {},
    asUser: (user, fn) => { calls.push(['as', user]); return fn(); },
    facts: () => ({ lastLoaded: 'm' }),
    retrieve: async (projectId, question, user) => { calls.push(['retrieve', projectId, question, user]); return [{ file: 'f', text: 't' }]; },
    ...overrides,
  });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res)) { res.statusCode = 418; res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = (op, body, headers = { 'x-noevia-store-token': SECRET }, signal) => fetch(`http://127.0.0.1:${server.address().port}/internal/research/${op}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  return { post, calls };
}

test('the bridge answers only the front', async (t) => {
  const { post, calls } = await bridge(t);
  for (const headers of [{}, { 'x-noevia-store-token': 'no' }, { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '203.0.113.1' }, { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '203.0.113.1' }]) {
    assert.equal((await post('facts', { user: 'u' }, headers)).status, 404);
  }
  assert.equal((await post('other', { user: 'u' })).status, 404);
  assert.deepEqual(calls, []);
});

test('the search tools and the availability of them are not this process\'s any more: their paths are unknown', async (t) => {
  const { post, calls } = await bridge(t);
  for (const op of ['tool', 'availability']) assert.equal((await post(op, { user: 'u', name: 'tavily_search', args: { query: 'q' } })).status, 404, op);
  assert.deepEqual(calls, []);
  const bridgeSource = fs.readFileSync(path.join(__dirname, 'rust-research-bridge.cjs'), 'utf8');
  for (const gone of ['executeOperatorToolCall', 'tavily_search', 'validTool']) assert.equal(bridgeSource.includes(gone), false, gone);
  const wiring = fs.readFileSync(path.join(__dirname, 'mcp-wiring.cjs'), 'utf8');
  for (const gone of ['executeOperatorToolCall', 'operatorServerFor', 'routeMcpTool', 'mcpAuthHeaders', 'oauthSessionFor']) assert.equal(wiring.includes(gone), false, gone);
  assert.equal(fs.existsSync(path.join(__dirname, 'tool-rate-limit.cjs')), false, 'the 429 wait is the front\'s');
});

test('the facts and a project\'s retrieval, as the asking user', async (t) => {
  const { post, calls } = await bridge(t);
  let r = await post('facts', { user: 'u1' });
  assert.deepEqual([r.status, await r.json()], [200, { lastLoaded: 'm' }]);
  assert.deepEqual(calls, [['as', 'u1']]);
  calls.length = 0;
  r = await post('facts', {});
  assert.equal(r.status, 400, 'a user is required');
  r = await post('retrieve', { user: 'u2', projectId: 'p', question: 'q' });
  assert.deepEqual(await r.json(), { hits: [{ file: 'f', text: 't' }] });
  assert.deepEqual(calls, [['as', 'u2'], ['retrieve', 'p', 'q', 'u2']]);
  r = await post('retrieve', { user: 'u2', projectId: 7, question: 'q' });
  assert.equal(r.status, 400);
});

test('a failing read keeps its public words and hides the rest; a caller going away aborts the retrieval', async (t) => {
  const { post } = await bridge(t, { retrieve: async () => { throw Object.assign(Error('x'), { publicMessage: 'The index is rebuilding.' }); } });
  let r = await post('retrieve', { user: 'u', projectId: 'p', question: 'q' });
  assert.deepEqual([r.status, await r.json()], [502, { error: 'The index is rebuilding.' }]);
  const hidden = await bridge(t, { retrieve: async () => { throw Error('/secret/path'); } });
  r = await hidden.post('retrieve', { user: 'u', projectId: 'p', question: 'q' });
  assert.deepEqual(await r.json(), { error: 'Research could not reach this tool.' });
  let closed = false;
  const slow = await bridge(t, { retrieve: () => new Promise((resolve) => { setTimeout(() => { closed = true; resolve([]); }, 200); }) });
  const controller = new AbortController();
  const pending = slow.post('retrieve', { user: 'u', projectId: 'p', question: 'q' }, undefined, controller.signal).catch(() => 'gone');
  await new Promise((res) => setTimeout(res, 30));
  controller.abort();
  assert.equal(await pending, 'gone');
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(closed, true, 'the retrieval was left to finish, but no answer was written to a caller that left');
});

test('Kiwix keeps the page cleaner research used to lend it', () => {
  assert.equal(stripBoilerplate('<nav>x</nav><h2>Title</h2><p>Body &amp; more</p>\nCookie settings'), '## Title\nBody & more');
});

// H1 of the #2218 review: index.cjs read process.env.NOEVIA_PROJECT_STORE_TOKEN after clientFromEnv had deleted it
// (#1916), so the lease and the bridge were built with an empty secret and every call was a 404. The tests above pass
// a secret in by hand, which is how that slipped through; these read the wiring itself.
test('index.cjs hands the lease and the bridge the secret it took before clientFromEnv deleted it', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const taken = index.indexOf("const FRONT_SECRET = String(process.env.NOEVIA_PROJECT_STORE_TOKEN || '');");
  const deleted = index.indexOf('clientFromEnv(process.env)');
  assert.ok(taken > 0 && deleted > 0 && taken < deleted, 'the secret is taken before clientFromEnv removes it from process.env');
  assert.equal(index.slice(deleted).includes('process.env.NOEVIA_PROJECT_STORE_TOKEN'), false, 'nothing reads the deleted variable afterwards');
  for (const ctor of ["require('./inference-admission-lease.cjs').createAdmissionRoutes({", "require('./rust-research-bridge.cjs').createResearchBridge({"]) {
    const at = index.indexOf(ctor);
    assert.ok(at > deleted, ctor);
    assert.match(index.slice(at, at + 200), /secret: FRONT_SECRET\b/, `${ctor} gets the captured secret`);
  }
  assert.match(index, /if \(await inferenceAdmission\.handle\(req, res\)\) return;/);
  assert.match(index, /if \(await researchBridge\(req, res\)\) return;/);
});

test('clientFromEnv takes the token out of the environment, so a later read finds nothing (the thing H1 relied on)', () => {
  const { clientFromEnv } = require('./project-store-client.cjs');
  const env = { NOEVIA_PROJECT_STORE_PORT: '1', NOEVIA_PROJECT_STORE_TOKEN: SECRET };
  clientFromEnv(env);
  assert.equal(env.NOEVIA_PROJECT_STORE_TOKEN, undefined);
});
