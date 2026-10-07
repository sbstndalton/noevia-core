'use strict';
// Keeps docs/spec-model-loader-api-v1.md in step with the code on both sides of the web to
// model-loader contract (#269): the routes model-loader serves (services/model-manager/app/api.py)
// and the routes web calls (server callers and the admin UI through /api/model-manager).
// A route added or removed on either side fails here until the doc table is updated.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const norm = p => p.replace(/\{[^}]*\}/g, '{}');
const key = (m, p) => `${m} ${norm(p)}`;

function documented() {
  const doc = read('docs', 'spec-model-loader-api-v1.md');
  const m = /<!-- route-table:start -->([\s\S]*?)<!-- route-table:end -->/.exec(doc);
  assert.ok(m, 'route table markers missing from the contract doc');
  const rows = new Map();
  for (const line of m[1].split('\n')) {
    const c = line.split('|').map(s => s.trim());
    if (c.length < 5 || !/^(GET|POST|PUT|DELETE|PATCH)$/.test(c[1])) continue;
    const k = key(c[1], c[2]);
    assert.ok(!rows.has(k), `duplicate row ${k}`);
    rows.set(k, new Set(c[3].split(',').map(s => s.trim())));
  }
  return rows;
}

function served() {
  const src = read('services', 'model-manager', 'app', 'api.py');
  assert.match(src, /APIRouter\(prefix="\/api\/v1"\)/);
  const out = new Set();
  for (const m of src.matchAll(/^@router\.(get|post|put|delete|patch)\(\s*"([^"]*)"/gm)) out.add(key(m[1].toUpperCase(), '/api/v1' + m[2]));
  return out;
}

// Route text of a server-side call, `${...}` normalised, query string dropped.
const cleanPath = raw => raw.replace(/\$\{[^}]*\}/g, '{}').replace(/(\{\})+/g, '{}').split('?')[0];

function serverCalls() {
  const out = new Set();
  const dir = path.join(__dirname);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.cjs') && !f.endsWith('.test.cjs'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // modelService.managerFetch('models'), managerFetch(`sections/${x}/safe-defaults`, 'POST')
    for (const m of src.matchAll(/managerFetch\(\s*([`'])((?:(?!\1).)*)\1\s*(?:,\s*'(GET|POST|PUT|DELETE)')?/g)) {
      out.add(key(m[3] || 'GET', '/api/v1/' + cleanPath(m[2])));
    }
  }
  // Direct fetches with a literal path: refreshModelScan and the delete guard read the folder scan.
  for (const f of ['models.cjs', path.join('routes', 'models.cjs')]) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\}\/api\/v1\/(models)[`'"]\s*,\s*\{\s*method:\s*'(GET|POST|PUT|DELETE)'/g)) out.add(key(m[2], '/api/v1/' + m[1]));
  }
  // The single-writer endpoint.
  const w = fs.readFileSync(path.join(dir, 'models-ini-writer.cjs'), 'utf8');
  const e = /\+'\/api\/v1\/([\w-]+)'/.exec(w);
  assert.ok(e && /method:'PUT'/.test(w), 'models-ini-writer.cjs no longer PUTs a literal /api/v1 path');
  out.add(key('PUT', '/api/v1/' + e[1]));
  return out;
}

function browserCalls() {
  const dir = path.join(root, 'apps', 'web', 'src', 'components', 'models');
  const out = new Set();
  for (const f of fs.readdirSync(dir).filter(f => /\.tsx?$/.test(f))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // mm<T>(`path`, {...}) and the download queue's act(`path`) helper (always POST, empty body).
    for (const m of src.matchAll(/\b(mm|act)(?:<[^()]*?>)?\(\s*([`'])((?:(?!\2).)*)\2/g)) {
      const [, fn, , raw] = m;
      // Options belong to this call only: stop at the next mm call on the same line.
      const rest = src.slice(m.index + m[0].length).split('\n')[0].split(/\bmm(?:<|\()/)[0];
      if (fn === 'act' && f !== 'DownloadTab.tsx') continue;
      const method = fn === 'act' ? 'POST' : (/method:\s*'(GET|POST|PUT|DELETE)'/.exec(rest)?.[1] || (/\bbody\b/.test(rest) ? 'POST' : 'GET'));
      out.add(key(method, '/api/v1/' + cleanPath(raw)));
    }
  }
  return out;
}

const diff = (a, b) => [...a].filter(x => !b.has(x)).sort();

test('the doc route table matches the routes model-loader serves', () => {
  const doc = new Set(documented().keys()), code = served();
  assert.ok(code.size > 30, 'api.py route scan looks broken');
  assert.deepEqual(diff(code, doc), [], 'routes in api.py that the contract doc does not list');
  assert.deepEqual(diff(doc, code), [], 'routes in the contract doc that api.py no longer serves');
});

test('every route web calls is served, and the doc marks each caller kind', () => {
  const rows = documented(), code = served();
  const server = serverCalls(), browser = browserCalls();
  assert.ok(server.size >= 3 && browser.size > 20, 'caller scans look broken');
  for (const k of [...server, ...browser]) assert.ok(code.has(k), `web calls ${k}, which model-loader does not serve`);
  assert.deepEqual([...rows].filter(([, who]) => who.has('server')).map(([k]) => k).sort(), [...server].sort(), 'doc "server" rows differ from the routes the web server calls');
  assert.deepEqual([...rows].filter(([, who]) => who.has('browser')).map(([k]) => k).sort(), [...browser].sort(), 'doc "browser" rows differ from the routes the admin UI calls');
  for (const [k, who] of rows) assert.ok([...who].every(w => ['server', 'browser', 'proxy', 'healthcheck'].includes(w)), `unknown caller kind on ${k}`);
});

test('the documented single-writer contract matches the web client', () => {
  const doc = read('docs', 'spec-model-loader-api-v1.md'), w = read('apps', 'web', 'server', 'models-ini-writer.cjs');
  assert.match(w, /X-Model-Loader-Token/);
  // #1003: the only optional field is auto-tune's skip-backup hint, sent as backup:false.
  assert.match(w, /JSON\.stringify\(\{baseRevision,text,\.\.\.\(backup===false\?\{backup:false\}:\{\}\)\}\)/);
  assert.match(w, /,30000\)/, 'PUT /models-ini timeout changed; update section 3 of the doc');
  assert.match(doc, /X-Model-Loader-Token/);
  assert.match(doc, /\| `PUT \/models-ini` \(web `models-ini-writer\.cjs`\) \| 30 s \|/);
  const py = read('services', 'model-manager', 'app', 'api.py');
  assert.match(py, /MODELS_INI_MAX_BYTES = 1024 \* 1024/);
  for (const status of ['400', '401', '404', '405', '409', '413']) assert.ok(new RegExp(`\\b${status}\\b`).test(doc), `doc lacks status ${status}`);
});
