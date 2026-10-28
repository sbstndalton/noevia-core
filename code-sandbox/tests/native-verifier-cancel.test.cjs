'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { waitForCancellation } = require('./native-verifier-cancel.cjs');

test('actual observer release completes the wait and releases stdin', async () => {
  const input = new PassThrough();
  try {
    const waiting = waitForCancellation(input, new Promise(() => {}));
    input.write('cancel\n');
    await waiting;
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.isPaused(), true);
  } finally { input.destroy(); }
});

test('verifier closure fails promptly without requiring an observer release', async () => {
  const input = new PassThrough(); let close;
  const closed = new Promise((resolve) => { close = resolve; });
  try {
    const waiting = waitForCancellation(input, closed);
    close();
    await assert.rejects(waiting, /closed before observed command cancellation/);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.isPaused(), true);
  } finally { input.destroy(); }
});

test('socket errors also release the pending observer listener', async () => {
  const input = new PassThrough(); let fail;
  const closed = new Promise((resolve, reject) => { fail = reject; });
  try {
    const waiting = waitForCancellation(input, closed);
    fail(Error('owned socket deadline'));
    await assert.rejects(waiting, /owned socket deadline/);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.isPaused(), true);
  } finally { input.destroy(); }
});
