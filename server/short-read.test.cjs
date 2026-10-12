'use strict';
// #1461 / #1508: the shared short-lived read. Concurrent callers share one call; the answer is kept
// for the TTL; a failed call is not kept; clear() drops the answer at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSharedRead } = require('./short-read.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('callers that arrive while a read is in flight share the one call', async () => {
  let loads = 0, release;
  const read = createSharedRead(() => { loads += 1; return new Promise((resolve) => { release = resolve; }); }, 1000);
  const a = read.get(), b = read.get(), c = read.get();
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(loads, 1);
  release({ models: 3 });
  assert.deepEqual(await Promise.all([a, b, c]), [{ models: 3 }, { models: 3 }, { models: 3 }]);
});

test('an answer is kept for the TTL after it lands, then read again', async () => {
  let loads = 0;
  const read = createSharedRead(async () => ++loads, 40);
  assert.equal(await read.get(), 1);
  assert.equal(await read.get(), 1, 'within the TTL the same answer is served');
  await sleep(60);
  assert.equal(await read.get(), 2, 'after the TTL the source is asked again');
});

test('a failed read is not kept: the next caller asks again', async () => {
  let loads = 0;
  const read = createSharedRead(async () => { loads += 1; if (loads === 1) throw new Error('engine down'); return 'up'; }, 1000);
  await assert.rejects(read.get(), /engine down/);
  assert.equal(await read.get(), 'up');
  assert.equal(loads, 2);
});

test('clear() drops the kept answer at once, so a write is never answered with what came before it', async () => {
  let loads = 0;
  const read = createSharedRead(async () => ++loads, 60000);
  assert.equal(await read.get(), 1);
  read.clear();
  assert.equal(await read.get(), 2);
});

test('a read still in flight when clear() runs is not stored over the newer one', async () => {
  let loads = 0; const resolvers = [];
  const read = createSharedRead(() => { loads += 1; return new Promise((resolve) => resolvers.push(resolve)); }, 60000);
  const first = read.get();
  read.clear();
  const second = read.get();
  assert.equal(loads, 2);
  resolvers[0]('before-write'); resolvers[1]('after-write');
  assert.equal(await first, 'before-write');
  assert.equal(await second, 'after-write');
  assert.equal(await read.get(), 'after-write', 'the newest read is the one kept');
  assert.equal(loads, 2);
});

test('an answer the caller marks as not keepable is shared with those waiting, but the next caller asks again', async () => {
  let loads = 0;
  const read = createSharedRead(async () => { loads += 1; return { degraded: loads === 1 }; }, 60000, (value) => !value.degraded);
  const [a, b] = await Promise.all([read.get(), read.get()]);
  assert.equal(a, b);
  assert.equal(loads, 1, 'concurrent callers still share the one call');
  assert.deepEqual(await read.get(), { degraded: false }, 'the next caller after a degraded answer asks again');
  assert.equal(loads, 2);
  assert.equal(await read.get().then(v => v.degraded), false);
  assert.equal(loads, 2, 'a good answer is kept');
});
