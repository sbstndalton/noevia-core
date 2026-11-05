'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelManager } = require('./model-manager.cjs');
const { fakeGate } = require('./fixtures/fake-inference-gate.cjs');
const cases = require('./fixtures/model-delete-manager.json');

// Also consumed by noevia-server/tests/model_delete.rs. These cases use no model files or engines.
for (const fixture of cases) test(`delete native oracle: ${fixture.name}`, async () => {
  let index = 0;
  const name = 'folder/é +?#&=!.gguf';
  const manager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic.invalid/v1/',
    gate: fakeGate(), fetchStream: async () => ({ ok: false }),
    fetchJson: async (url, options, timeout) => {
      const step = fixture.steps[index++];
      assert.ok(step, 'no calls beyond the expected retry');
      assert.equal(options.method, step.method);
      assert.equal(timeout, step.method === 'POST' ? 120000 : 60000);
      assert.equal(options.headers['X-Noevia-Gate-Admin'], undefined);
      if (step.method === 'DELETE') assert.equal(url, `http://synthetic.invalid/models?model=${encodeURIComponent(name)}`);
      else {
        assert.equal(url, 'http://synthetic.invalid/models/unload');
        assert.deepEqual(JSON.parse(options.body), { model: name });
      }
      if (step.transportError) throw Error('synthetic transport failure');
      return { ok: step.status >= 200 && step.status < 300, status: step.status, body: step.body };
    } });
  if (fixture.expected.error) await assert.rejects(manager.removeModel(name), /synthetic transport failure/);
  else assert.deepEqual(await manager.removeModel(name), fixture.expected);
  assert.equal(index, fixture.steps.length);
  assert.equal(manager.inferenceBusy(), false, 'mutation registration always released');
});

test('delete registers active work across both attempts without taking an exclusive maintenance hold', async () => {
  let resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let deletes = 0;
  const manager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic.invalid',
    gate: fakeGate(), fetchStream: async () => ({ ok: false }),
    fetchJson: async (url, options) => {
      assert.equal(manager.maintenanceHeld(), false);
      assert.equal(manager.inferenceBusy(), true);
      await assert.rejects(async () => manager.holdMaintenance('synthetic'), { status: 409, chatActive: true });
      if (options.method === 'DELETE' && ++deletes === 1) {
        entered(); await waiting;
        return { ok: false, status: 409 };
      }
      return { ok: true, status: 200 };
    } });
  const pending = manager.removeModel('synthetic');
  await started;
  assert.equal(manager.inferenceBusy(), true);
  // The registration coexists with chat admission; an exclusive hold would refuse it.
  const leave = manager.enterInference();
  leave();
  resume();
  assert.equal((await pending).ok, true);
  assert.equal(deletes, 2);
  assert.equal(manager.inferenceBusy(), false);
});

for (const [status, location, rejects] of [[302, true, true], [302, false, true], [304, false, false]]) {
  test(`delete HTTP redirect policy: ${status}, location=${location}`, async (t) => {
    const http = require('node:http');
    const { fetchJson } = require('./http.cjs');
    const calls = [];
    const server = http.createServer((req, res) => {
      req.resume();
      calls.push(req.url);
      res.statusCode = req.method === 'DELETE' ? status : 200;
      if (req.method === 'DELETE' && location) res.setHeader('Location', '/must-not-follow');
      res.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const manager = createModelManager({ kind: 'llamacpp', baseUrl: `http://127.0.0.1:${server.address().port}`,
      gate: fakeGate(), fetchJson, fetchStream: async () => ({ ok: false }) });
    if (rejects) await assert.rejects(manager.removeModel('synthetic'));
    else assert.equal((await manager.removeModel('synthetic')).status, status);
    assert.equal(calls.length, rejects ? 2 : 4);
    assert.ok(!calls.includes('/must-not-follow'));
  });
}
