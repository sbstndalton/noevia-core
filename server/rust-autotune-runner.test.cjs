'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { IMPL_ENV, AUTOTUNE_RUNNER_OWNER, frontOwnsRunner } = require('./rust-autotune-runner.cjs');
const { createModelManager } = require('./model-manager.cjs');

test('#2516: only AUTOTUNE_RUNNER_IMPL=rust hands auto-tune to the front', () => {
  assert.equal(IMPL_ENV, 'AUTOTUNE_RUNNER_IMPL');
  assert.equal(AUTOTUNE_RUNNER_OWNER, 'noevia-autotune-runner-rust/1');
  assert.equal(frontOwnsRunner({}), false);
  assert.equal(frontOwnsRunner({ AUTOTUNE_RUNNER_IMPL: 'rust' }), true);
  for (const value of ['', 'node', 'Rust', ' rust', 'rust ', 'true', '1']) assert.equal(frontOwnsRunner({ AUTOTUNE_RUNNER_IMPL: value }), false, value);
  assert.equal(frontOwnsRunner(undefined), false);
});

test('#2516: without a state path (front-owned) the manager builds no auto-tuner and reads no file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-autotune-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir, 'models.ini');
  fs.writeFileSync(ini, 'version = 1\n[qa-synthetic]\nmodel = /models/qa-synthetic.gguf\n');
  const base = { kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, fetchJson: async () => ({ ok: true, body: { data: [] } }),
    calibrationStatePath: path.join(dir, 'cal.json') };
  const nodeOwned = createModelManager({ ...base, autotuneStatePath: path.join(dir, 'tune.json') });
  assert.ok(nodeOwned.autotune, 'Node owns auto-tune when a state path is given');
  const frontOwned = createModelManager({ ...base, autotuneStatePath: null });
  assert.equal(frontOwned.autotune, null);
  assert.equal(frontOwned.capabilities.autotune, false);
});

const { createFrontAutotune } = require('./rust-autotune-runner.cjs');
function fakeFront(replies) {
  const asked = [];
  return { asked, client: { async autotune(op, payload) { asked.push([op, payload]); const r = replies[op]; if (r instanceof Error) throw r; return r; } } };
}

test('#2516: the front facade reads the run\'s state and asks the front for the owed re-read', async () => {
  const f = fakeFront({ state: { status: 200, body: { running: true } }, flush: { status: 200, body: { flushed: true } } });
  const facade = createFrontAutotune({ client: f.client, intervalMs: 60000 });
  assert.equal(facade.tuningActive(), false, 'false until the front answers');
  await facade.poll();
  assert.equal(facade.tuningActive(), true);
  await facade.flushReload('qa-synthetic');
  assert.deepEqual(f.asked.at(-1), ['flush', { model: 'qa-synthetic' }]);
  await facade.flushReload();
  assert.deepEqual(f.asked.at(-1), ['flush', {}]);
});

test('#2516: a front that cannot re-read, or cannot be reached, refuses the load with the runner\'s sentence', async () => {
  const says = 'The model server has not re-read the restored settings yet. Try again shortly.';
  const refused = createFrontAutotune({ client: fakeFront({ flush: { status: 503, body: { error: says } }, state: new Error('down') }).client, log: () => {} });
  await assert.rejects(refused.flushReload('m'), (e) => e.publicMessage === says);
  await refused.poll();
  assert.equal(refused.tuningActive(), false, 'an unreachable front is no active run');
  const gone = createFrontAutotune({ client: fakeFront({ flush: new Error('timeout') }).client, log: () => {} });
  await assert.rejects(gone.flushReload('m'), (e) => e.publicMessage === says);
  // A front without the routes runs no auto-tune: nothing is owed.
  const older = createFrontAutotune({ client: fakeFront({ flush: { status: 404, body: { error: 'Not found' } } }).client });
  await older.flushReload('m');
});

test('#2516: the manager asks the front facade before a load and counts its run as tuning', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-autotune-facade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir, 'models.ini');
  fs.writeFileSync(ini, 'version = 1\n[qa-synthetic]\nmodel = /models/qa-synthetic.gguf\n');
  const f = fakeFront({ state: { status: 200, body: { running: true } }, flush: { status: 200, body: { flushed: true } } });
  const frontAutotune = createFrontAutotune({ client: f.client, intervalMs: 60000 });
  const manager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini,
    fetchJson: async () => ({ ok: true, body: { data: [] } }), calibrationStatePath: path.join(dir, 'cal.json'), autotuneStatePath: null, frontAutotune });
  assert.equal(manager.autotune, null);
  assert.equal(manager.tuningActive(), false);
  await frontAutotune.poll();
  assert.equal(manager.tuningActive(), true);
  await manager.prepareLoad('qa-synthetic').catch(() => {});
  assert.ok(f.asked.some(([op, p]) => op === 'flush' && p.model === 'qa-synthetic'), JSON.stringify(f.asked));
});
