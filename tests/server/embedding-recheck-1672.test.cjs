'use strict';
// #1672: a next embeddings server that was seen serving the next model is checked again while the
// re-index runs. If it is restarted with another model, indexing into the next slot pauses and the
// slot's partial vectors (some may be the other model's) are dropped so they are rebuilt.
// Synthetic model names only; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmbeddingConfig } = require('../../server/embedding-config.cjs');
const { createEmbeddingMigration } = require('../../server/embedding-migration.cjs');

function harness({ recheckMs = '60000' } = {}) {
  let clock = 1_000_000;
  const env = { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: 'http://embed:8080/v1' };
  const config = createEmbeddingConfig({ env, log: () => {} });
  const filled = []; const dropped = []; const logs = [];
  let remaining = 3; // chunks still missing a vector for the next slot
  const rag = {
    served: ['nomic-embed-text-v1', 'embeddinggemma-2'],
    probes: 0,
    onBatch: null,
    listIndexes: () => [{ userId: 'u1', projectId: 'p1' }],
    indexCoverage: () => ({ chunks: 3, vectors: 3 }),
    fillMissing: async (_e, target) => {
      if (target.model !== 'embeddinggemma-2' || remaining <= 0) return { attempted: 0, embedded: 0, refused: [], remaining: 0 };
      filled.push(target.model);
      clock += 1000;
      rag.onBatch?.();
      remaining -= 1;
      return { attempted: 1, embedded: 1, refused: [], remaining };
    },
    dropIndexSlot: (_e, t) => { dropped.push(t.model); remaining = 3; },
    embed: async () => [[1, 0]],
    servedModels: async () => { rag.probes += 1; if (rag.served instanceof Error) throw rag.served; return rag.served; },
  };
  const m = createEmbeddingMigration({ config, rag, now: () => clock,
    env: { EMBEDDING_REINDEX_MIN_PAUSE_MS: '0', EMBEDDING_NEXT_RECHECK_MS: recheckMs }, sleep: async () => {}, log: (l) => logs.push(l) });
  // more(n): n newly uploaded chunks need a next vector.
  return { m, rag, config, filled, dropped, logs, advance: (ms) => { clock += ms; }, more: (n) => { remaining += n; } };
}

test('the next server swapped to another model mid re-index: indexing pauses and the next slot is dropped for rebuild', async () => {
  const h = harness({ recheckMs: '1500' });
  try {
    await h.m.setNext({ model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed:8080/v1' });
    await h.m.kick();
    // The sidecar is restarted with another model after the first batch of the next pass.
    h.filled.length = 0; h.dropped.length = 0;
    h.rag.onBatch = () => { h.rag.served = ['nomic-embed-text-v1', 'bge-m3']; };
    h.more(5);
    h.advance(10_000);
    await h.m.kick();
    assert.ok(h.filled.length <= 2, `indexing paused within the recheck interval (${h.filled.length} batches)`);
    assert.deepEqual(h.dropped, ['embeddinggemma-2'], 'partial next vectors are dropped so the slot is rebuilt');
    const st = h.m.status();
    assert.equal(st.nextServed, false);
    assert.equal(st.nextHeld.code, 'modelNotServed');
    assert.equal(h.config.next().model, 'embeddinggemma-2', 'the re-index stays pending, not abandoned');
    assert.ok(h.logs.some((l) => /no longer serves embeddinggemma-2/.test(l)), h.logs.join('\n'));
    // Further passes write nothing into the next slot until it is served again.
    h.rag.onBatch = null; h.filled.length = 0;
    h.advance(10_000);
    await h.m.kick();
    assert.deepEqual(h.filled, []);
    // Served again: the slot is rebuilt from scratch.
    h.rag.served = ['nomic-embed-text-v1', 'embeddinggemma-2'];
    h.advance(10_000);
    await h.m.kick();
    assert.ok(h.filled.length >= 1);
    assert.equal(h.m.status().nextServed, true);
  } finally { h.m.stop(); }
});

test('an unreachable next server pauses indexing but keeps the slot (nothing proves it was polluted)', async () => {
  const h = harness({ recheckMs: '1500' });
  try {
    await h.m.setNext({ model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed:8080/v1' });
    await h.m.kick();
    h.rag.served = new Error('ECONNREFUSED');
    h.filled.length = 0;
    h.more(2);
    h.advance(10_000);
    await h.m.kick();
    assert.deepEqual(h.filled, []);
    assert.deepEqual(h.dropped, []);
    assert.equal(h.m.status().nextHeld.code, 'endpointUnverified');
  } finally { h.m.stop(); }
});

test('a recent check is trusted: no probe per pass inside the recheck interval', async () => {
  const h = harness({ recheckMs: '600000' });
  try {
    await h.m.setNext({ model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed:8080/v1' });
    const probes = h.rag.probes;
    await h.m.kick();
    await h.m.kick();
    assert.equal(h.rag.probes, probes, 'no extra probe');
    h.advance(600_001);
    await h.m.kick();
    assert.equal(h.rag.probes, probes + 1, 'probed again once the interval passed');
  } finally { h.m.stop(); }
});

test('a batch written after a model swap, then a transient check failure, then modelNotServed: the slot is dropped', async () => {
  const h = harness({ recheckMs: '1500' });
  try {
    await h.m.setNext({ model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed:8080/v1' });
    await h.m.kick();
    // Swap lands right after a check passed: the next batch is written while another model is served.
    h.filled.length = 0; h.dropped.length = 0;
    h.rag.onBatch = () => { h.rag.served = new Error('ECONNRESET'); h.rag.onBatch = null; };
    h.more(5);
    h.advance(10_000);
    await h.m.kick();
    assert.ok(h.filled.length >= 1, 'a batch was written since the last good check');
    assert.deepEqual(h.dropped, [], 'a transient failure alone keeps the slot');
    assert.equal(h.m.status().nextHeld.code, 'endpointUnverified');
    // The server comes back serving another model: the batch written since the last good check is suspect.
    h.rag.served = ['nomic-embed-text-v1', 'bge-m3'];
    h.advance(10_000);
    await h.m.kick();
    assert.deepEqual(h.dropped, ['embeddinggemma-2']);
    assert.equal(h.m.status().nextHeld.code, 'modelNotServed');
  } finally { h.m.stop(); }
});
