'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createAutotuneStateClient, Fenced } = require('./autotune-state-client.cjs');

const WRITER = 'a'.repeat(32);
function rig(handler, opts = {}) {
  const sent = [];
  const call = async (op, payload) => { sent.push({ op, payload: JSON.parse(JSON.stringify(payload)) }); return handler(op, payload, sent.length); };
  return { client: createAutotuneStateClient({ call, base: 'native-autotune-0123456789abcdef.json', ...opts }), sent };
}
const attached = { status: 200, body: { writer: WRITER, rev: 2, jobRev: 3, epoch: 4, state: { history: {}, settings: {} } } };

test('attach binds to the named state file and learns the writer, job revision and epoch', async () => {
  const { client, sent } = rig(() => attached);
  const r = await client.attach();
  assert.deepEqual(sent, [{ op: 'attach', payload: { base: 'native-autotune-0123456789abcdef.json', available: true } }]);
  assert.equal(client.writer, WRITER); assert.equal(client.jobRev, 3); assert.equal(client.epoch, 4);
  assert.deepEqual(r.state, { history: {}, settings: {} });
});

test('a refused, malformed or unreachable attach is a fenced outcome, never a half-attached client', async () => {
  for (const handler of [() => ({ status: 503, body: {} }), () => ({ status: 200, body: { writer: 'short', state: {} } }),
    () => ({ status: 200, body: { writer: WRITER } }), () => { throw new Error('ECONNREFUSED'); }, () => null]) {
    const { client } = rig(handler);
    await assert.rejects(client.attach(), e => e instanceof Fenced && e.fenced === true);
    assert.equal(client.writer, null);
  }
});

test('commit sends the writer and job revision with the whole job and history, and adopts the revisions it is answered', async () => {
  const { client, sent } = rig((op) => op === 'attach' ? attached : { status: 200, body: { rev: 9, jobRev: 3, epoch: 5, settings: { m: { allowQ5Kv: true } } } });
  await client.attach();
  const reply = await client.commit({ job: { id: 'j' }, history: { m: [] } });
  assert.deepEqual(sent[1], { op: 'commit', payload: { writer: WRITER, jobRev: 3, history: { m: [] }, job: { id: 'j' } } });
  assert.equal(client.epoch, 5);
  assert.deepEqual(reply.settings, { m: { allowQ5Kv: true } });
  // A state with no job leaves the key out (the owner removes the job).
  await client.commit({ history: {} });
  assert.equal(Object.hasOwn(sent[2].payload, 'job'), false);
  await client.commit({ job: { id: 'k' }, history: {}, register: true });
  assert.equal(sent[3].payload.register, true);
});

test('a refused commit carries the owner state and why; an unreachable owner is fenced too', async () => {
  const state = { rev: 7, jobRev: 8, epoch: 9, state: { history: {}, settings: {} } };
  const { client } = rig((op) => op === 'attach' ? attached : { status: 409, body: { fenced: 'job', state } });
  await client.attach();
  await assert.rejects(client.commit({ job: {}, history: {} }), e => e.fenced && e.why === 'job' && e.state === undefined === false && e.state.jobRev === 8);
  for (const handler of [() => { throw new Error('timeout'); }, () => ({ status: 500, body: null }), () => ({ status: 409, body: { fenced: 'writer' } })]) {
    const r = rig((op) => op === 'attach' ? attached : handler());
    await r.client.attach();
    await assert.rejects(r.client.commit({ job: {}, history: {} }), e => e.fenced === true);
  }
  await assert.rejects(rig(() => attached).client.commit({ history: {} }), e => e.fenced && e.why === 'not attached');
});

test('the start hold: busy is false, a refused writer is fenced, end never throws', async () => {
  let mode = 'ok';
  const { client } = rig((op) => op === 'attach' ? attached : mode === 'busy' ? { status: 409, body: { busy: true } } : mode === 'fenced' ? { status: 409, body: { fenced: 'writer' } } : mode === 'down' ? (() => { throw new Error('x'); })() : { status: 200, body: { rev: 1 } });
  await client.attach();
  assert.equal(await client.begin(), true);
  mode = 'busy'; assert.equal(await client.begin(), false);
  mode = 'fenced'; await assert.rejects(client.begin(), e => e.fenced);
  mode = 'down'; await client.end();
});

test('sync returns the owner state and adopts its revisions', async () => {
  const { client } = rig((op) => op === 'attach' ? attached : { status: 200, body: { rev: 3, jobRev: 11, epoch: 12, state: { history: {}, settings: { m: {} } } } });
  await client.attach();
  const r = await client.sync();
  assert.deepEqual(r.state.settings, { m: {} });
  assert.deepEqual([client.jobRev, client.epoch], [11, 12]);
});

test('constructing without its parts fails fast', () => {
  assert.throws(() => createAutotuneStateClient({ base: 'x' }));
  assert.throws(() => createAutotuneStateClient({ call: async () => null }));
});
