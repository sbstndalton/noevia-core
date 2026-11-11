'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('./rerank-settings.cjs');
// The native integration harness supplies two independent processes sharing synthetic SQLite.
test('remote identical saves, resets and ABA invalidate the real consumer cache', {
  skip: !process.env.RERANK_TEST_FRONT,
}, async (t) => {
  const observations = [];
  t.after(() => {
    if (process.env.RERANKER_CONSUMER_REPORT) require("node:fs").writeFileSync(process.env.RERANKER_CONSUMER_REPORT, JSON.stringify(observations, null, 2));
  });
  let invalidations = 0;
  const client = createClient({ env: {
    NOEVIA_PROJECT_STORE_PORT: process.env.RERANK_TEST_STORE_PORT,
    NOEVIA_PROJECT_STORE_TOKEN: 'synthetic-store-token-0123456789abcdef',
  }, onChange() { invalidations++; } });
  const front = process.env.RERANK_TEST_FRONT;
  async function write(method, body) {
    const response = await fetch(`${front}/api/models/reranker`, {
      method, headers: { origin: front, 'x-csrf-token': 'csrf',
        cookie: 'cowork_session=admin-token; cowork_csrf=csrf', 'content-type': 'application/json' },
      body: method === 'DELETE' ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.text());
  }
  const x = { enabled: true, choice: 'tei' };
  await write('PUT', x);
  await client.read();
  for (const mutate of [
    () => write('PUT', x),
    async () => { await write('PUT', { enabled: false, choice: 'tei' }); await write('PUT', x); },
    () => write('DELETE'), () => write('DELETE'),
  ]) {
    const before = invalidations;
    await mutate();
    await client.read();
    observations.push({ before, after: invalidations, expected: before + 1 });
    assert.equal(invalidations, before + 1);
    await client.read();
    assert.equal(invalidations, before + 1, 'unchanged reads keep the cache');
  }
});
