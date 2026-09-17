'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createProjectSweep } = require('./project-sweep.cjs');
const { removeEmptyFolder } = require('./storage-client.cjs');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sweep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('local: removes empty dirs inside the tenant, keeps non-empty, idempotent', t => {
  const root = tempRoot(t); const tenant = path.join(root, 'tenant'); fs.mkdirSync(tenant);
  const empty = path.join(tenant, 'project-uploads', 'abc'); fs.mkdirSync(empty, { recursive: true });
  const full = path.join(tenant, 'project-assets', 'p1'); fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, 'raced-upload'), 'x');
  const logs = [];
  const sweep = createProjectSweep({ log: e => logs.push(e) });
  const first = sweep.sweepLocal(tenant, [empty, full]);
  assert.deepEqual(first.map(r => [r.removed, r.reason]), [[true, undefined], [false, 'not-empty']]);
  assert.equal(fs.existsSync(empty), false);
  assert.equal(fs.readFileSync(path.join(full, 'raced-upload'), 'utf8'), 'x');
  assert.deepEqual(sweep.sweepLocal(tenant, [empty]).map(r => r.reason), ['missing']);
});

test('local: refuses dirs outside the tenant, including through a symlink, and the root itself', t => {
  const root = tempRoot(t); const tenant = path.join(root, 'tenant'); fs.mkdirSync(tenant);
  const outside = path.join(root, 'other-tenant-empty'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(tenant, 'link'));
  const sweep = createProjectSweep();
  const results = sweep.sweepLocal(tenant, [outside, path.join(tenant, 'link'), path.join(tenant, '..', 'other-tenant-empty'), tenant]);
  assert.deepEqual(results.map(r => r.reason), ['outside-tenant', 'outside-tenant', 'outside-tenant', 'outside-tenant']);
  assert.ok(fs.existsSync(outside) && fs.existsSync(tenant));
});

test('local: a file path is not removed', t => {
  const root = tempRoot(t); const file = path.join(root, 'f'); fs.writeFileSync(file, 'x');
  assert.equal(createProjectSweep().sweepLocal(root, [file])[0].reason, 'not-directory');
  assert.ok(fs.existsSync(file));
});

function fakeDav(tree, etags) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url).replace(/^\/+|\/+$/g, '');
    calls.push([req.method, p, req.headers['if-match']]);
    if (req.method === 'PROPFIND') {
      if (!(p in tree)) { res.writeHead(404); return res.end(); }
      const self = `<d:response><d:href>/${encodeURI(p)}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>${etags[p] ? `<d:getetag>&quot;${etags[p]}&quot;</d:getetag>` : ''}</d:prop></d:propstat></d:response>`;
      const kids = tree[p].map(k => `<d:response><d:href>/${encodeURI(p + '/' + k)}</d:href></d:response>`).join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${self}${kids}</d:multistatus>`);
    }
    if (req.method === 'DELETE') {
      if (!(p in tree)) { res.writeHead(404); return res.end(); }
      if (req.headers['if-match'] !== `"${etags[p]}"`) { res.writeHead(412); return res.end(); }
      if (tree[p].length) { res.writeHead(500); return res.end(); }
      delete tree[p];
      const parent = p.split('/').slice(0, -1).join('/');
      if (tree[parent]) tree[parent] = tree[parent].filter(k => k !== p.split('/').pop());
      res.writeHead(204); return res.end();
    }
    res.writeHead(405); res.end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('remote: empty group folders then the project folder go; a non-empty one stays', async t => {
  const tree = { 'noevia projects': ['Alpha', 'Beta'], 'noevia projects/Alpha': ['Documents'], 'noevia projects/Alpha/Documents': [],
    'noevia projects/Beta': ['Documents'], 'noevia projects/Beta/Documents': ['keep.pdf'] };
  const etags = { 'noevia projects/Alpha': 'a1', 'noevia projects/Alpha/Documents': 'd1', 'noevia projects/Beta': 'b1', 'noevia projects/Beta/Documents': 'bd' };
  const dav = await fakeDav(tree, etags); t.after(() => dav.server.close());
  const conn = { kind: 'nextcloud', baseUrl: dav.url, username: 'u', secret: 's' };
  // Alpha's parent etag changes when Documents is removed, as a real server's would.
  const storage = { removeEmptyFolder: async (c, p) => { const r = await removeEmptyFolder(c, p); if (r.removed && p.endsWith('/Documents')) etags['noevia projects/Alpha'] = 'a2'; return r; } };
  const sweep = createProjectSweep({ storage });
  const alpha = await sweep.sweepRemote(conn, 'noevia projects/Alpha', { root: 'noevia projects', groups: ['Documents', 'Images'] });
  assert.deepEqual(alpha.map(r => [r.dir, r.removed, r.reason]), [
    ['noevia projects/Alpha/Documents', true, undefined], ['noevia projects/Alpha/Images', false, 'missing'], ['noevia projects/Alpha', true, undefined]]);
  const beta = await sweep.sweepRemote(conn, 'noevia projects/Beta', { root: 'noevia projects', groups: ['Documents'] });
  assert.deepEqual(beta.map(r => r.reason), ['not-empty', 'not-empty']);
  assert.ok(tree['noevia projects/Beta/Documents'].includes('keep.pdf'));
});

test('remote: a child written between check and delete fails the If-Match precondition', async t => {
  const tree = { 'noevia projects': ['Gamma'], 'noevia projects/Gamma': [] };
  const etags = { 'noevia projects/Gamma': 'g1' };
  const dav = await fakeDav(tree, etags); t.after(() => dav.server.close());
  const conn = { kind: 'webdav', baseUrl: dav.url };
  dav.server.prependListener('request', req => { if (req.method === 'DELETE') { tree['noevia projects/Gamma'].push('late.md'); etags['noevia projects/Gamma'] = 'g2'; } });
  assert.deepEqual(await removeEmptyFolder(conn, 'noevia projects/Gamma'), { removed: false, reason: 'changed' });
  assert.ok('noevia projects/Gamma' in tree);
});

test('remote: no ETag means no DELETE; outside the projects root and S3 are refused', async t => {
  const tree = { 'noevia projects': ['Delta'], 'noevia projects/Delta': [] };
  const dav = await fakeDav(tree, {}); t.after(() => dav.server.close());
  const conn = { kind: 'webdav', baseUrl: dav.url };
  assert.equal((await removeEmptyFolder(conn, 'noevia projects/Delta')).reason, 'no-etag');
  assert.ok(!dav.calls.some(c => c[0] === 'DELETE'));
  const sweep = createProjectSweep({ storage: { removeEmptyFolder } });
  for (const folder of ['noevia projects', 'Documents/Delta', 'noevia projects/Delta/sub', 'noevia projects/../x']) {
    assert.equal((await sweep.sweepRemote(conn, folder, { root: 'noevia projects' }))[0].reason, 'outside-projects-root', folder);
  }
  assert.deepEqual(await sweep.sweepRemote({ kind: 's3' }, 'noevia projects/Delta', { root: 'noevia projects' }), []);
});

test('afterDelete logs removals but not already-missing dirs', async t => {
  const root = tempRoot(t); const d = path.join(root, 'x'); fs.mkdirSync(d);
  const logs = [];
  await createProjectSweep({ log: e => logs.push(e) }).afterDelete({ tenantRoot: root, localDirs: [d, path.join(root, 'gone')], projectId: 'p' });
  assert.deepEqual(logs, [{ event: 'project.sweep', projectId: 'p', dir: d, removed: true, reason: undefined }]);
});
