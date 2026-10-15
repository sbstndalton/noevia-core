'use strict';
// #1776: reading paths never create an index file. A search, caption read or index walk over a project
// that has no index returns empty and leaves the disk as it was. Synthetic ids only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.RAG_DIR;
for (const k of ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBED_MODEL', 'EMBEDDING_PROFILE', 'EMBEDDING_NEXT_MODEL', 'EMBEDDING_NEXT_BASE_URL', 'EMBEDDING_NEXT_PROFILE', 'EMBEDDING_IMAGE_MODEL', 'NOEVIA_MULTIMODAL_RAG']) delete process.env[k];
const { createEmbeddingConfig } = require('./embedding-config.cjs');

let depsOk = true;
try { require('better-sqlite3'); require('sqlite-vec'); } catch { depsOk = false; }
const dbTest = depsOk ? test : test.skip;

const USER = '33333333-3333-4333-8333-333333333333';
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);

function freshRag(dir) {
  delete require.cache[require.resolve('./rag.cjs')];
  const rag = require('./rag.cjs');
  const config = createEmbeddingConfig({ env: { EMBEDDING_BASE_URL: 'http://127.0.0.1:9', EMBEDDING_MODEL: 'gemma-test', EMBEDDING_PROFILE: 'embeddinggemma-2' }, stateFile: path.join(dir, 'embedding-config.json') });
  rag.init({ dataDir: dir, inferenceUrl: 'http://engine.invalid', embeddingConfig: config,
    userDataDirFn: (id) => path.join(dir, 'users', id), listUserIds: () => [USER], userActive: () => true });
  return rag;
}

for (const userId of [USER, null]) {
  dbTest(`#1776: search, caption and walk paths create nothing for a project without an index (${userId ? 'account' : 'shared'})`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-1776-'));
    const rag = freshRag(dir);
    const before = walk(dir);
    assert.deepEqual(await rag.searchProject('proj-none', 'anything', userId), []);
    assert.deepEqual(await rag.searchProjectWithImages('proj-none', 'anything', userId), { text: [], images: [], indexed: [] });
    assert.equal(rag.readCaption('proj-none', userId, 'a'.repeat(64)), null);
    assert.equal(rag.writeCaption('proj-none', userId, 'a'.repeat(64), 'x', 'm'), false);
    assert.equal(rag.indexCoverage({ projectId: 'proj-none', userId }, { profile: 'embeddinggemma-2', model: 'gemma-test' }), null);
    assert.deepEqual(walk(dir), before, 'no rag directory, index file, -wal or -shm was created');
  });
}
