'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./dav-matrix.cjs');
const { createFakeDav } = require('./fake-dav.cjs');

async function withFake(faults, fn) {
  const fake = createFakeDav({ faults });
  const url = await fake.listen();
  try { return await fn(fake, { baseUrl: url, user: fake.user, password: fake.password, largeMb: 1 }); } finally { await fake.close(); }
}

test('parseMultistatus decodes hrefs, entities, prefixes and collections', () => {
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/dav/u/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    <D:response><D:href>/dav/u/a%20b%20%26%20%C3%BC.md</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>12</D:getcontentlength><D:getetag>&quot;abc&quot;</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    <response><href>/dav/u/x&amp;y/</href><resourcetype><collection/></resourcetype></response></D:multistatus>`;
  const [root, file, bare] = m.parseMultistatus(xml);
  assert.equal(root.isCollection, true);
  assert.equal(file.name, 'a b & ü.md');
  assert.equal(file.length, 12);
  assert.equal(file.etag, '"abc"');
  assert.equal(file.isCollection, false);
  assert.equal(bare.name, 'x&y');
  assert.equal(bare.isCollection, true);
  assert.deepEqual(m.parseMultistatus('not xml'), []);
});

test('parseEnvFile handles comments, export, quotes', () => {
  const env = m.parseEnvFile('# c\nexport NOEVIA_QA_DAV_URL="https://x/y/"\nNOEVIA_QA_DAV_USER=noevia-qa\n\nNOEVIA_QA_DAV_APP_PASSWORD=\'p w\'\n');
  assert.deepEqual(env, { NOEVIA_QA_DAV_URL: 'https://x/y/', NOEVIA_QA_DAV_USER: 'noevia-qa', NOEVIA_QA_DAV_APP_PASSWORD: 'p w' });
});

test('readConfig refuses missing, credentialed, admin-looking and non-http settings', () => {
  const good = { NOEVIA_QA_DAV_URL: 'https://c.example/remote.php/dav/files/noevia-qa', NOEVIA_QA_DAV_USER: 'noevia-qa', NOEVIA_QA_DAV_APP_PASSWORD: 'secret' };
  const ok = m.readConfig(good);
  assert.equal(ok.ok, true);
  assert.ok(ok.config.baseUrl.endsWith('/'));
  assert.equal(m.readConfig({}).problems.length, 3);
  assert.equal(m.readConfig({ ...good, NOEVIA_QA_DAV_USER: 'admin' }).ok, false);
  assert.equal(m.readConfig({ ...good, NOEVIA_QA_DAV_USER: 'sebastian' }).ok, false);
  assert.equal(m.readConfig({ ...good, NOEVIA_QA_DAV_USER: 'sebastian', NOEVIA_QA_ALLOW_ANY_USER: '1' }).ok, true);
  assert.equal(m.readConfig({ ...good, NOEVIA_QA_DAV_URL: 'ftp://x/' }).ok, false);
  assert.equal(m.readConfig({ ...good, NOEVIA_QA_DAV_URL: 'https://u:p@x/' }).ok, false);
  const bad = m.readConfig({ ...good, NOEVIA_QA_DAV_URL: 'https://u:p@x/' });
  assert.ok(!JSON.stringify(bad).includes('secret'));
});

test('dry run prints the plan, hides the password and sends no request', async () => {
  const out = [];
  let called = 0;
  const code = await m.main(['--dry-run'], { NOEVIA_QA_DAV_URL: 'https://c.example/dav/', NOEVIA_QA_DAV_USER: 'noevia-qa', NOEVIA_QA_DAV_APP_PASSWORD: 'hunter2-secret' },
    { out: (s) => out.push(s), err: (s) => out.push(s) }, () => { called++; throw new Error('network'); });
  assert.equal(code, 0);
  assert.equal(called, 0);
  const text = out.join('\n');
  assert.match(text, /DRY RUN/);
  assert.match(text, /set \(hidden\)/);
  assert.ok(!text.includes('hunter2'));
  for (const [id] of m.ROWS) assert.ok(text.includes(id), id);
  const missing = [];
  assert.equal(await m.main(['--dry-run'], {}, { out: (s) => missing.push(s), err: () => {} }), 2);
  assert.match(missing.join('\n'), /MISSING/);
});

test('a real run without configuration exits 2 and sends nothing', async () => {
  const err = [];
  assert.equal(await m.main([], {}, { out: () => {}, err: (s) => err.push(s) }, () => { throw new Error('network'); }), 2);
  assert.ok(err.some((s) => /NOEVIA_QA_DAV_URL is not set/.test(s)));
});

test('the full matrix passes against the fake server and cleans up', async () => {
  await withFake({}, async (fake, config) => {
    const run = await m.runMatrix(config);
    const failed = run.results.filter((r) => r.status !== 'PASS');
    assert.deepEqual(failed, [], JSON.stringify(failed));
    assert.equal(run.results.length, m.ROWS.length);
    assert.equal(run.leftover, null);
    assert.deepEqual([...fake.tree.keys()], [''], 'the QA folder and everything in it is gone');
    const wrong = fake.log.filter((l) => !l.authorized);
    assert.equal(wrong.length, 1, 'exactly one wrong-password request');
    assert.ok(fake.log.every((l) => l.url.startsWith(fake.prefix)), 'nothing outside the account root');
    const touched = fake.log.filter((l) => l.method !== 'PROPFIND' && l.url !== fake.prefix).every((l) => l.url.includes('noevia-qa-matrix-'));
    assert.ok(touched, 'every write is inside the QA folder');
  });
});

test('the report table lists every row and the counts', async () => {
  await withFake({}, async (fake, config) => {
    const run = await m.runMatrix(config);
    const table = m.renderTable(run.results);
    assert.match(table, /RESULT\s+CHECK\s+TIME\s+DETAIL/);
    for (const [id] of m.ROWS) assert.ok(table.includes(id), id);
    assert.match(table, /10 pass, 0 fail, 0 skipped of 10/);
  });
});

test('a server with a constant ETag fails etag-change but cleanup still runs', async () => {
  await withFake({ staticEtag: true }, async (fake, config) => {
    const run = await m.runMatrix(config);
    const by = Object.fromEntries(run.results.map((r) => [r.id, r]));
    assert.equal(by['etag-change'].status, 'FAIL');
    assert.match(by['etag-change'].detail, /ETag/);
    assert.equal(by.cleanup.status, 'PASS');
    assert.equal(fake.tree.size, 1);
  });
});

test('a server that ignores If-Match fails with the 412 expectation', async () => {
  await withFake({ ignoreIfMatch: true }, async (fake, config) => {
    const run = await m.runMatrix(config);
    const r = run.results.find((x) => x.id === 'etag-change');
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /412/);
  });
});

test('a 401 without a challenge fails auth-401', async () => {
  await withFake({ noChallenge: true }, async (fake, config) => {
    const run = await m.runMatrix(config);
    assert.equal(run.results.find((x) => x.id === 'auth-401').status, 'FAIL');
  });
});

test('wrong credentials everywhere: root row fails, the rest skip, nothing is created, exit code 1', async () => {
  await withFake({}, async (fake, config) => {
    const run = await m.runMatrix({ ...config, password: 'nope' });
    assert.equal(run.results[0].status, 'FAIL');
    assert.match(run.results[0].detail, /401/);
    assert.ok(run.results.slice(1).every((r) => r.status === 'SKIP'));
    assert.equal(run.leftover, null);
    assert.equal(fake.tree.size, 1);
    const out = [];
    const code = await m.main([], { NOEVIA_QA_DAV_URL: config.baseUrl, NOEVIA_QA_DAV_USER: config.user, NOEVIA_QA_DAV_APP_PASSWORD: 'nope' }, { out: (s) => out.push(s), err: () => {} });
    assert.equal(code, 1);
    assert.ok(!out.join('\n').includes('nope'));
  });
});

test('an unreachable server fails rows without leaking the password and does not throw', async () => {
  const run = await m.runMatrix({ baseUrl: 'http://127.0.0.1:1/dav/', user: 'noevia-qa', password: 'sekrit-pw', largeMb: 1 });
  assert.equal(run.results[0].status, 'FAIL');
  assert.ok(!JSON.stringify(run).includes('sekrit-pw'));
});
