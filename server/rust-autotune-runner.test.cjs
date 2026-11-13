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
