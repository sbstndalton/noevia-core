'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInferenceMachines } = require('../tests/reference/inference-machines.node.cjs');
const { modelIds } = require('./chat-machines.cjs');

test('registry JSON compatibility: private use, lone units, overflow and ignored depth', async () => {
  for (const name of ['\u{10f800}', '\u{10ffff}', '\ud800', '\ue000\ud800']) {
    const rows = new Map();
    const store = { get: k => rows.get(k), set: (k,v) => rows.set(k,v) };
    const open = () => createInferenceMachines({ store, audit() {}, log() {} });
    const registry = open();
    const body = JSON.parse(`{"name":${JSON.stringify(name)},"address":"192.168.1.2","ignored":1e400,"deep":${'['.repeat(300)}0${']'.repeat(300)}}`);
    const { machine } = await registry.add(body, 'admin');
    assert.equal(open().view().machines.find(m => m.id === machine.id).name, name);
    await open().update({ id: machine.id, name: 'renamed' }, 'admin');
    assert.equal(open().view().machines.find(m => m.id === machine.id).name, 'renamed');
  }
});

test('model identifiers fall through null and missing fields only', () => {
  assert.deepEqual(modelIds({ data: [{ id: null, model: 'synthetic-model' }] }), ['synthetic-model']);
  assert.deepEqual(modelIds({ models: [{ model: null, name: 'synthetic-model' }] }), ['synthetic-model']);
  for (const id of [false, 0, '', {}, []]) {
    assert.deepEqual(modelIds({ data: [{ id, model: 'synthetic-model' }] }), []);
  }
});

test('replacement coercion: String() of the name/address value and ToPrimitive failures', async () => {
  const { build } = require('./machines-coerce-cases.cjs');
  const { cases } = await build();
  const byRaw = raw => cases.find(c => c.input.raw === raw);
  const byNest = (n, leaf) => cases.find(c => c.input.nest && c.input.nest[0] === n && c.input.nest[1] === leaf);
  // An own toString that is not callable has no primitive form: a TypeError before anything is saved,
  // directly, inside arrays and under an escaped key. Own valueOf and nested objects do not matter.
  for (const raw of ['{"toString":1}', '[{"toString":null}]', '{"toStrin\\u0067":"x"}', '["a",["b",{"toString":1}]]', '[[{"toString":1}]]']) {
    assert.deepEqual(byRaw(raw).add, { throws: 'TypeError', writes: 0 }, raw);
  }
  assert.deepEqual(byRaw('{"valueOf":1}').add, { ok: '[object Object]' });
  assert.deepEqual(byRaw('{"a":{"toString":1}}').add, { ok: '[object Object]' });
  assert.deepEqual(byRaw('[1,[2,[null,{"x":{"toString":1}}]]]').add, { ok: '1,2,,[object Object]' });
  // Ordinary nesting coerces through String(). The corpus holds no stack-sensitive depths: the
  // exact V8 boundary is qualified only by the pinned-image harness (noevia qualify-machines-depth.sh).
  assert.deepEqual(byNest(1000, '"x"').add, { ok: 'x' });
  assert.deepEqual(byNest(100, '{"toString":1}').coerce, { throws: 'TypeError' });
  assert.equal(cases.some(c => c.input.nest && c.input.nest[0] > 1000), false);
  // A deep array inside an object is never walked.
  assert.deepEqual(cases.find(c => c.input.inObject === 100000).coerce, { text: 'a,[object Object]' });
});

test('registry accepts a very deep ignored field in a request', async () => {
  const rows = new Map();
  const registry = createInferenceMachines({ store: { get: k => rows.get(k), set: (k, v) => rows.set(k, v) }, audit() {}, log() {} });
  const body = JSON.parse(`{"action":"add","name":"deep","address":"192.168.1.2","ignored":${'['.repeat(400000)}0${']'.repeat(400000)}}`);
  const { machine } = await registry.add(body, 'admin');
  assert.equal(machine.name, 'deep');
});
