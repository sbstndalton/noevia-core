'use strict';
// Synthetic Node contract recorder. NODE_MANAGER_ROUTES points to the frozen origin/main
// routes module copied beside its dependencies for recording; no network or engine is used.
const { createModelRoutes } = require(process.env.NODE_MANAGER_ROUTES || '../../server/routes/models.cjs');
async function run(s) {
  const calls = [], headers = {};
  let answer;
  const routes = createModelRoutes({
    json: (_, status, body) => { answer = { status, body, headers }; },
    readBody: async () => s.raw || '{}', readJson: async () => ({}),
    fetchJson: async (url, init, timeout) => {
      calls.push({ url, method: init.method, timeout });
      if (s.drop) throw Error('synthetic transport');
      const status = s.status || 200;
      return { ok: status >= 200 && status < 300, status, body: s.body === undefined ? { ok: true } : s.body };
    },
    env: s.disabled ? {} : { MODEL_LOADER_URL: 'http://synthetic.invalid/', MODEL_LOADER_TOKEN: 'synthetic-token' },
    modelManager: {}, currentWorkspace: () => ({}),
    service: { modelScanCache: new Map(), servedCatalogue: async () => [], autoRoles: () => ({}), modelsInstalled: async () => [], lastLoadedModel: () => null, clearLastLoadedModel() {}, clearRoleReferences: async () => [] },
  });
  const url = new URL('http://synthetic.invalid' + s.path);
  const req = { method: s.method || 'GET', url: s.path };
  await routes(req, { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } }, { path: url.pathname, url, authn: { user: { id: 'synthetic', role: s.role || 'admin' } } });
  return { ...answer, calls };
}
const scenarios = [
  { name: 'sections', path: '/api/model-manager/sections', body: { sections: ['sample'] } },
  { name: 'query-preserved', path: '/api/model-manager/status?x=1&x=2' },
  { name: 'escaped-name', path: '/api/model-manager/sections/sample%20name' },
  { name: 'empty-rest', path: '/api/model-manager/' },
  { name: 'member', path: '/api/model-manager/sections', role: 'member' },
  { name: 'disabled', path: '/api/model-manager/sections', disabled: true },
  { name: 'member-disabled', path: '/api/model-manager/sections', disabled: true, role: 'member' },
  ...['bad%2fname', 'bad%5cname', 'bad%', 'bad..name', 'bad!name', '%2e%2e%2fname'].map((p, i) => ({ name: `invalid-${i}`, path: `/api/model-manager/${p}` })),
  ...[null, '', 'plain', false, 12, ['sample']].map((body, i) => ({ name: `body-${i}`, path: '/api/model-manager/status', body })),
  ...[400, 409, 500, 503].flatMap(status => [
    { name: `detail-${status}`, path: '/api/model-manager/status', status, body: { detail: 'synthetic refusal', error: 'ignored' } },
    { name: `fallback-${status}`, path: '/api/model-manager/status', status, body: {} },
  ]),
  { name: 'transport', path: '/api/model-manager/status', drop: true },
];
(async () => {
  const results = [];
  for (const s of scenarios) results.push({ ...s, expect: await run(s) });
  process.stdout.write(JSON.stringify({ version: 1, core: process.env.ORACLE_CORE, node: process.version, scenarios: results }, null, 2) + '\n');
})();
