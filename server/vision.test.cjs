'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisionProbe } = require('./vision.cjs');

test('a missing projector is explained and a repaired server is retried', async () => {
  let time = 0; let calls = 0;
  const probe = createVisionProbe({ now: () => time, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response('provide the mmproj', { status: 500 }) : new Response('{}');
  } });
  assert.match((await probe('http://model', {}, 'qwen')).reason, /projector/);
  assert.equal((await probe('http://model', {}, 'qwen')).supported, false);
  assert.equal(calls, 1);
  time = 31000;
  assert.equal((await probe('http://model', {}, 'qwen')).supported, true);
});

test('identical model names at different endpoints or credentials do not share verdicts', async () => {
  let calls = 0;
  const probe = createVisionProbe({ fetchImpl: async () => { calls++; return new Response('{}'); } });
  await probe('http://one', { Authorization: 'Bearer a' }, 'model');
  await probe('http://two', { Authorization: 'Bearer a' }, 'model');
  await probe('http://two', { Authorization: 'Bearer b' }, 'model');
  assert.equal(calls, 3);
});

test('network failures report availability instead of claiming the model is text-only', async () => {
  const probe = createVisionProbe({ fetchImpl: async () => { throw new Error('offline'); } });
  const result = await probe('http://offline', {}, 'model');
  assert.equal(result.supported, false);
  assert.match(result.reason, /timed out/);
});
