'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createShutdownHooks } = require('./shutdown-hooks.cjs');

const fakeProcess = () => Object.assign(new EventEmitter(), { pid: 4242, killed: [], kill(pid, signal) { this.killed.push([pid, signal]); } });

test('on SIGTERM every hook runs, then the signal is sent again so the process ends the default way', async () => {
  const proc = fakeProcess(), order = [];
  const hooks = createShutdownHooks({ proc, timeoutMs: 1000 });
  hooks.add(() => { order.push('sync'); });
  hooks.add(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('async'); });
  hooks.install();
  proc.emit('SIGTERM');
  assert.deepEqual(proc.killed, [], 'not ended before the hooks finished');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(order, ['sync', 'async']);
  assert.deepEqual(proc.killed, [[4242, 'SIGTERM']]);
  assert.equal(proc.listenerCount('SIGTERM'), 0, 'a second signal is not intercepted');
});

test('a hook that throws or never finishes does not stop the shutdown', async () => {
  const proc = fakeProcess(), ran = [];
  const hooks = createShutdownHooks({ proc, timeoutMs: 30 });
  hooks.add(() => { throw Error('synthetic'); });
  hooks.add(() => new Promise(() => {}));
  hooks.add(() => { ran.push('third'); });
  hooks.install();
  proc.emit('SIGINT');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(ran, ['third']);
  assert.deepEqual(proc.killed, [[4242, 'SIGINT']]);
});
