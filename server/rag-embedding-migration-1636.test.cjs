'use strict';
// #1636: per-model vector slots, the profile framing on the wire, and the re-index path
// (set next -> background fill -> switch -> rollback -> finish) over project indexes.
// Synthetic text and a fake embeddings server only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

delete process.env.RAG_DIR;
for (const k of ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBED_MODEL', 'EMBEDDING_PROFILE', 'EMBEDDING_NEXT_MODEL', 'EMBEDDING_NEXT_BASE_URL', 'EMBEDDING_NEXT_PROFILE']) delete process.env[k];

const { createEmbeddingConfig } = require('./embedding-config.cjs');
const { createEmbeddingMigration } = require('./embedding-migration.cjs');

let depsOk = true;
try { require('better-sqlite3'); require('sqlite-vec'); } catch { depsOk = false; }
const dbTest = depsOk ? test : test.skip;

// Keyword vectors: same width for both models (like nomic and EmbeddingGemma 2, both 768), but
// the "gemma" model writes them reversed, so comparing across models gives wrong answers.
const WORDS = ['apple', 'banana', 'cherry', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
function vectorFor(model, text) {
  const t = String(text).toLowerCase();
  const v = WORDS.map((w) => (t.split(w).length - 1) + 0.01);
  return /gemma/.test(model) ? v.reverse() : v;
}
function startServer({ refuse = null } = {}) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ url: req.url, model: body.model, input: body.input, auth: req.headers.authorization || null });
    if (refuse && body.input.some((t) => refuse(body.model, t))) { res.statusCode = 400; res.end('{"error":"input is too large to process"}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorFor(body.model, text) })) }));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => srv.close() })));
}

// The hit is the chunk cut from that one paragraph (chunks overlap, so they may start mid-word).
const only = (body, word) => body.includes(word) && WORDS.filter((w) => w !== word).every((w) => !body.includes(w));
const para = (word) => `${word} `.repeat(320).trim();
const LARGE = [para('apple'), para('banana'), para('cherry')].join('\n\n'); // > 2400 chars: chunked and embedded
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function freshRag() { delete require.cache[require.resolve('./rag.cjs')]; return require('./rag.cjs'); }

async function setup({ active, next = null, users = [USER_A], removed = [], refuse = null, baseUrl = null, engineUrl = 'http://engine.invalid', batch = null, onPause = null } = {}) {
  const server = await startServer({ refuse });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-1636-'));
  const env = { ...(baseUrl === '' ? {} : { EMBEDDING_BASE_URL: baseUrl || server.url }), EMBEDDING_MODEL: active?.model || 'nomic-test', EMBEDDING_PROFILE: active?.profile || '' };
  if (next) Object.assign(env, { EMBEDDING_NEXT_MODEL: next.model, EMBEDDING_NEXT_PROFILE: next.profile, EMBEDDING_NEXT_BASE_URL: server.url });
  const config = createEmbeddingConfig({ env, stateFile: path.join(dir, 'embedding-config.json') });
  const rag = freshRag();
  rag.init({ dataDir: dir, inferenceUrl: engineUrl, embeddingConfig: config,
    userDataDirFn: (id) => path.join(dir, 'users', id), listUserIds: () => users, userActive: (id) => !removed.includes(id) });
  const pauses = [];
  const migration = createEmbeddingMigration({ config, rag, env: { EMBEDDING_REINDEX_DUTY: '0.5', EMBEDDING_REINDEX_MIN_PAUSE_MS: '0', ...(batch ? { EMBEDDING_REINDEX_BATCH: String(batch) } : {}) },
    sleep: async (ms) => { pauses.push(ms); await onPause?.(ms, pauses.length); }, log: () => {} });
  return { server, dir, config, rag, migration, pauses, done: () => { migration.stop(); server.close(); } };
}

function openDb(dir, user, project) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dir, 'users', user, 'rag', `${project}.db`));
  require('sqlite-vec').load(db);
  return db;
}

dbTest('default profile: the wire carries the raw chunk and query text, exactly as before #1636', async () => {
  const s = await setup();
  try {
    const r = await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
    assert.ok(r.embedded >= 3);
    const stored = s.server.seen.flatMap((x) => x.input);
    for (const text of stored) assert.ok(LARGE.includes(text), 'every document input is a verbatim slice of the file');
    s.server.seen.length = 0;
    const hits = await s.rag.searchProject('p1', 'banana', USER_A);
    assert.deepEqual(s.server.seen.map((x) => x.input), [['banana']], 'the query is sent unchanged');
    assert.ok(only(hits[0].body, 'banana'), hits[0].body.slice(0, 40));
    // The default slot is the legacy table, so a release from before #1636 still finds these vectors.
    const db = openDb(s.dir, USER_A, 'p1');
    assert.equal(db.prepare("SELECT value FROM vec_meta WHERE key='dim'").get().value, '8');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vec_items_rowids').get().n, r.embedded);
    db.close();
  } finally { s.done(); }
});

dbTest('embeddinggemma-2 profile: documents carry their file title, queries the search prefix', async () => {
  const s = await setup({ active: { model: 'gemma-test', profile: 'embeddinggemma-2' } });
  try {
    await s.rag.indexProjectFile('p1', 'folder/Recipes.md', LARGE, USER_A);
    for (const text of s.server.seen.flatMap((x) => x.input)) assert.ok(text.startsWith('title: Recipes.md | text: '), text.slice(0, 40));
    s.server.seen.length = 0;
    const hits = await s.rag.searchProject('p1', 'cherry', USER_A);
    assert.deepEqual(s.server.seen[0].input, ['task: search result | query: cherry']);
    assert.ok(only(hits[0].body, 'cherry'), hits[0].body.slice(0, 40));
  } finally { s.done(); }
});

dbTest('a legacy index is never searched with another model, even at the same vector width', async () => {
  const s = await setup();
  try {
    await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
  } finally { s.done(); }
  // Same files, now configured straight to another model and profile with no re-index.
  const g = await setup({ active: { model: 'gemma-test', profile: 'embeddinggemma-2' } });
  try {
    fs.cpSync(path.join(s.dir, 'users'), path.join(g.dir, 'users'), { recursive: true });
    assert.deepEqual(await g.rag.searchProject('p1', 'banana', USER_A), [], 'no slot for this model: no vector search');
    assert.equal(g.server.seen.length, 0, 'not even a query embedding is spent on it');
  } finally { g.done(); }
});

dbTest('re-index without downtime: next fills beside active, switch is atomic, rollback and finish', async () => {
  const s = await setup();
  try {
    await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
    await s.rag.indexProjectFile('p2', 'small.md', 'apple pie, a small file', USER_A); // direct injection, never embedded
    const next = { baseUrl: s.server.url, model: 'gemma-test', profile: 'embeddinggemma-2' };

    // Switching before a re-index has covered every project is refused.
    s.migration.setNext(next);
    await assert.rejects(s.migration.switchToNext(), (e) => e.code === 'notReady' && e.status === 409);
    // While the next model is being built, search still uses the active model only.
    s.server.seen.length = 0;
    { const [hit] = await s.rag.searchProject('p1', 'banana', USER_A); assert.ok(only(hit.body, 'banana'), hit.body.slice(0, 40)); }
    // (The background fill has started, so gemma document batches may also be on the wire.)
    assert.deepEqual(s.server.seen.filter((x) => x.input.length === 1 && /banana$/.test(x.input[0]) && x.input[0].length < 40).map((x) => [x.model, x.input[0]]), [['nomic-test', 'banana']]);

    await s.migration.kick();
    const st = s.migration.status();
    assert.equal(st.coverage.next.complete, true);
    assert.equal(st.coverage.next.chunks, st.coverage.active.chunks, 'the small file is not counted: it is injected whole');
    assert.ok(s.pauses.length > 0, 'the fill pauses between batches');

    s.server.seen.length = 0;
    await s.migration.switchToNext();
    assert.equal(s.config.active().model, 'gemma-test');
    { const [hit] = await s.rag.searchProject('p1', 'cherry', USER_A); assert.ok(only(hit.body, 'cherry'), hit.body.slice(0, 40)); }
    assert.deepEqual(s.server.seen.map((x) => x.input), [['task: search result | query: cherry']]);

    // Saved: a restart keeps the switch, whatever the environment says.
    const reread = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'nomic-test' }, stateFile: path.join(s.dir, 'embedding-config.json') });
    assert.equal(reread.active().model, 'gemma-test');
    assert.equal(reread.previous().model, 'nomic-test');

    s.migration.rollback();
    s.server.seen.length = 0;
    { const [hit] = await s.rag.searchProject('p1', 'apple', USER_A); assert.ok(only(hit.body, 'apple'), hit.body.slice(0, 40)); }
    assert.deepEqual(s.server.seen.map((x) => [x.model, x.input]), [['nomic-test', ['apple']]], 'the old vectors serve again at once');

    await assert.rejects(s.migration.switchToNext(), (e) => e.code === 'noNext' && e.status === 409); // nothing is next after a rollback
    assert.equal(s.config.next(), null);
    s.migration.finish(); // drops the rolled-away gemma vectors
    const db = openDb(s.dir, USER_A, 'p1');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vec_meta WHERE key LIKE 'slot:%'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'vecmap_%'").get().n, 0);
    db.close();
  } finally { s.done(); }
});

dbTest('a vector never outlives the text it was made from (chunk ids are reused)', async () => {
  const s = await setup();
  try {
    await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
    const next = { baseUrl: s.server.url, model: 'gemma-test', profile: 'embeddinggemma-2' };
    s.migration.setNext(next);
    await s.migration.kick();
    // Rewrite the file: its chunks are dropped and new ones take the freed ids.
    const changed = [para('delta'), para('echo'), para('foxtrot')].join('\n\n');
    await s.rag.indexProjectFile('p1', 'notes.md', changed, USER_A);
    const cov = s.rag.indexCoverage({ userId: USER_A, projectId: 'p1' }, next);
    assert.equal(cov.vectors, 0, 'the next slot holds nothing for the new text yet');
    await s.migration.kick();
    await s.migration.switchToNext();
    const hits = await s.rag.searchProject('p1', 'echo', USER_A);
    assert.ok(only(hits[0].body, 'echo'), hits[0].body.slice(0, 40));
    assert.ok(hits.every((h) => !/apple|banana|cherry/.test(h.body)));
  } finally { s.done(); }
});

dbTest('tenants: each account is re-embedded inside its own index files; removed accounts are skipped', async () => {
  const s = await setup({ users: [USER_A, USER_B, '33333333-3333-4333-8333-333333333333'], removed: ['33333333-3333-4333-8333-333333333333'] });
  try {
    await s.rag.indexProjectFile('shared-name', 'a.md', LARGE, USER_A);
    await s.rag.indexProjectFile('shared-name', 'b.md', [para('golf'), para('hotel'), para('delta')].join('\n\n'), USER_B);
    const removedDir = path.join(s.dir, 'users', '33333333-3333-4333-8333-333333333333', 'rag');
    fs.mkdirSync(removedDir, { recursive: true });
    assert.equal(s.rag.listIndexes().length, 2, 'only active accounts are listed');
    s.migration.setNext({ baseUrl: s.server.url, model: 'gemma-test', profile: 'embeddinggemma-2' });
    await s.migration.kick();
    await s.migration.switchToNext();
    const a = await s.rag.searchProject('shared-name', 'hotel', USER_A);
    const b = await s.rag.searchProject('shared-name', 'hotel', USER_B);
    assert.ok(a.every((h) => h.file === 'a.md'), 'account A sees only its own file');
    assert.ok(b.length && b.every((h) => h.file === 'b.md'));
    assert.ok(only(b[0].body, 'hotel'), b[0].body.slice(0, 40));
  } finally { s.done(); }
});

dbTest('an endpoint move of the same model is checked for identical vectors before it is used', async () => {
  const s = await setup();
  const other = await startServer();
  try {
    await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
    s.migration.setNext({ baseUrl: other.url, model: 'nomic-test', profile: 'nomic-v1' });
    await s.migration.switchToNext();
    assert.equal(s.config.active().baseUrl, other.url.replace(/\/+$/, ''));
    assert.ok(other.seen.length >= 1, 'the parity sample went to the new address');
    s.server.seen.length = 0; other.seen.length = 0;
    await s.rag.searchProject('p1', 'apple', USER_A);
    assert.equal(s.server.seen.length, 0); assert.equal(other.seen.length, 1);
  } finally { s.done(); other.close(); }
});

dbTest('a chunk the new server refuses is skipped, the rest of the file is filled, and the switch waits for it', async () => {
  const s = await setup({ refuse: (model, text) => /gemma/.test(model) && /banana/.test(text) && !/query:/.test(text) });
  try {
    await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
    s.migration.setNext({ baseUrl: s.server.url, model: 'gemma-test', profile: 'embeddinggemma-2' });
    await s.migration.kick();
    const st = s.migration.status();
    assert.ok(st.lastPass.refused >= 1, 'the refused chunk is reported');
    assert.ok(st.coverage.next.vectors >= 1 && st.coverage.next.vectors < st.coverage.active.vectors, 'the other chunks got vectors');
    assert.equal(st.coverage.next.ready, false);
    await assert.rejects(s.migration.switchToNext(), (e) => e.code === 'notReady' && e.coverage.ready === false);
    await s.migration.switchToNext({ force: true });
    assert.equal(s.config.active().model, 'gemma-test');
  } finally { s.done(); }
});

const slotModels = (db) => db.prepare("SELECT value FROM vec_meta WHERE key LIKE 'slot:%'").all().map((r) => JSON.parse(r.value).model).sort();

dbTest('an embeddings server that redirects gets the text no further: the request fails and nothing reaches the other address', async () => {
  const sink = await startServer();
  const hops = [];
  const redirector = http.createServer((req, res) => {
    hops.push(req.url);
    res.statusCode = 307; // a 307 keeps the method and the body: the worst case for an SSRF-style bounce
    res.setHeader('Location', `${sink.url.replace(/\/v1$/, '')}${req.url}`);
    res.end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const redirectUrl = `http://127.0.0.1:${redirector.address().port}/v1`;
  const s = await setup({ baseUrl: redirectUrl });
  try {
    await assert.rejects(s.rag.embed(['project text that must stay here'], { target: { baseUrl: redirectUrl, model: 'm', profile: 'nomic-v1' } }));
    assert.equal(hops.length, 1, 'the first server was asked once');
    assert.deepEqual(sink.seen, [], 'the second server saw nothing');
    // The health probe of the active sidecar follows the same rule.
    assert.equal(await s.rag.retrievalStatus(), 'degraded');
    assert.equal(hops.length, 2, 'the sidecar probe asked once and was not followed');
    assert.deepEqual(sink.seen, []);
  } finally { s.done(); redirector.close(); }
  // The engine path (no dedicated address) is the same: embeddings and the router probe (GET /v1/models).
  const engineHops = [];
  const engine = http.createServer((req, res) => {
    engineHops.push(`${req.method} ${req.url}`);
    res.statusCode = 308;
    res.setHeader('Location', `${sink.url.replace(/\/v1$/, '')}${req.url}`);
    res.end();
  });
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  const viaEngine = await setup({ baseUrl: '', engineUrl: `http://127.0.0.1:${engine.address().port}` });
  try {
    assert.equal(viaEngine.config.active().baseUrl, null, 'no dedicated server: the engine');
    assert.equal(await viaEngine.rag.retrievalStatus(), 'degraded');
    assert.deepEqual(engineHops, ['GET /v1/models'], 'probeEmbeddingRouter asked once and was not followed');
    await assert.rejects(viaEngine.rag.embed(['text'], { target: viaEngine.config.active() }));
    assert.deepEqual(engineHops, ['GET /v1/models', 'POST /v1/embeddings']);
    assert.deepEqual(sink.seen, [], 'nothing reached the other address');
  } finally { viaEngine.done(); engine.close(); sink.close(); }
});

dbTest('the fill is paced: busy at most the duty share of the wall time (fake clock)', async () => {
  for (const duty of [0.5, 0.25]) {
    const clock = { t: 0 };
    const cycles = []; // { busy, pause } per batch that was followed by a pause
    const busyMs = [200, 400, 100, 300, 200, 200];
    let n = 0;
    const rag = {
      listIndexes: () => [{ userId: USER_A, projectId: 'p1' }],
      fillMissing: async () => { const busy = busyMs[n++]; clock.t += busy; cycles.push({ busy, pause: 0 }); return { attempted: 1, embedded: 1, refused: [], remaining: busyMs.length - n }; },
    };
    const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'a' } });
    const migration = createEmbeddingMigration({ config, rag, env: { EMBEDDING_REINDEX_DUTY: String(duty), EMBEDDING_REINDEX_MIN_PAUSE_MS: '0' },
      now: () => clock.t, sleep: async (ms) => { clock.t += ms; cycles.at(-1).pause = ms; }, log: () => {} });
    await migration.kick();
    const paced = cycles.filter((c) => c.pause > 0);
    assert.equal(cycles.length, busyMs.length);
    assert.equal(paced.length, busyMs.length - 1, 'a pause after every batch but the last');
    for (const c of paced) assert.ok(c.busy / (c.busy + c.pause) <= duty + 1e-9, `batch of ${c.busy} ms then ${c.pause} ms at duty ${duty}`);
    const busy = paced.reduce((a, c) => a + c.busy, 0);
    const wall = paced.reduce((a, c) => a + c.busy + c.pause, 0);
    assert.ok(busy / wall <= duty + 1e-9, `busy ratio ${busy / wall} at duty ${duty}`);
    migration.stop();
  }
});

dbTest('clearing the next model mid-fill stops the fill, drops the partial vectors and leaves the active model serving', async () => {
  const s = await setup({ batch: 1, onPause: async (_ms, count) => { if (count === 1) s.migration.clearNext(); } });
  try {
    await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
    s.migration.setNext({ baseUrl: s.server.url, model: 'gemma-test', profile: 'embeddinggemma-2' });
    await s.migration.kick();
    assert.equal(s.pauses.length, 1, 'the fill stopped at the first pause, with chunks still to do');
    assert.equal(s.server.seen.filter((x) => /gemma/.test(x.model)).length, 1, 'one gemma batch (of one chunk) was ever sent');
    assert.equal(s.config.next(), null);
    assert.equal(s.config.active().model, 'nomic-test');
    const db = openDb(s.dir, USER_A, 'p1');
    assert.deepEqual(slotModels(db), ['nomic-test'], 'the partly built slot is gone');
    db.close();
    s.server.seen.length = 0;
    const [hit] = await s.rag.searchProject('p1', 'banana', USER_A);
    assert.ok(only(hit.body, 'banana'), hit.body.slice(0, 40));
    assert.deepEqual(s.server.seen.map((x) => [x.model, x.input]), [['nomic-test', ['banana']]]);
  } finally { s.done(); }
});

dbTest('a switch is for the next that was checked: if next changed during the parity check, nothing switches', async () => {
  const s = await setup();
  const other = await startServer();
  try {
    await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
    const sameModelElsewhere = { baseUrl: other.url, model: 'nomic-test', profile: 'nomic-v1' };
    s.config.setNext(sameModelElsewhere);
    let swapped = false;
    const racing = createEmbeddingMigration({ config: s.config, env: { EMBEDDING_REINDEX_MIN_PAUSE_MS: '0' }, sleep: async () => {}, log: () => {},
      rag: { ...s.rag, embed: async (...args) => {
        if (!swapped) { swapped = true; s.config.setNext({ baseUrl: s.server.url, model: 'gemma-test', profile: 'embeddinggemma-2' }); } // an administrator picks another model meanwhile
        return s.rag.embed(...args);
      } } });
    await assert.rejects(racing.switchToNext(), (e) => e.code === 'nextChanged' && e.status === 409);
    assert.equal(s.config.active().model, 'nomic-test');
    assert.equal(s.config.active().baseUrl, s.server.url.replace(/\/+$/, ''), 'the endpoint did not move');
    assert.equal(s.config.next().model, 'gemma-test', 'the newer choice is untouched');
    assert.equal(s.config.previous(), null);
    racing.stop();
  } finally { s.done(); other.close(); }
});

dbTest('switching drops the vectors of the rollback target it displaces; a rollback drops a partly built next', async () => {
  const s = await setup();
  try {
    await s.rag.indexProjectFile('p1', 'notes.md', LARGE, USER_A);
    const gemma = { baseUrl: s.server.url, model: 'gemma-test', profile: 'embeddinggemma-2' };
    const gemmaB = { baseUrl: s.server.url, model: 'gemma-test-b', profile: 'embeddinggemma-2' };
    s.migration.setNext(gemma);
    await s.migration.kick();
    await s.migration.switchToNext(); // active gemma-test, previous nomic-test
    const db = openDb(s.dir, USER_A, 'p1');
    try {
      assert.deepEqual(slotModels(db), ['gemma-test', 'nomic-test']);

      // A rollback leaves no partly built next behind.
      s.migration.setNext(gemmaB);
      await s.migration.kick();
      assert.deepEqual(slotModels(db), ['gemma-test', 'gemma-test-b', 'nomic-test']);
      s.migration.rollback(); // active nomic-test, previous gemma-test, next abandoned
      assert.equal(s.config.active().model, 'nomic-test');
      assert.equal(s.config.next(), null);
      assert.deepEqual(slotModels(db), ['gemma-test', 'nomic-test'], 'gemma-test-b was only half built and is dropped');

      // Going forward again: the older previous (gemma-test) is displaced when nomic-test's successor takes over.
      s.migration.setNext(gemmaB);
      await s.migration.kick();
      await s.migration.switchToNext(); // active gemma-test-b, previous nomic-test; gemma-test displaced
      assert.equal(s.config.previous().model, 'nomic-test');
      assert.deepEqual(slotModels(db), ['gemma-test-b', 'nomic-test'], 'the displaced target no longer holds vectors');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'vecmap_%'").get().n, 1);
    } finally { db.close(); }
    // Rolling back to the target that is kept still works at once.
    s.migration.rollback();
    s.server.seen.length = 0;
    const [hit] = await s.rag.searchProject('p1', 'apple', USER_A);
    assert.ok(only(hit.body, 'apple'), hit.body.slice(0, 40));
  } finally { s.done(); }
});
