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
