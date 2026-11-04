'use strict';
// #2303: the public calibration job is the Rust front's. Production wiring has no public calibrator, so
// the internal bridges answer { available: false }, and nothing in this process touches the state
// file the front writes (no boot recover). Auto-tune's private calibrator is a separate path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelManager } = require('./model-manager.cjs');
const { createCalibrationRoutesBridge } = require('./rust-calibration-routes-bridge.cjs');
const { createCalibrationCancelBridge } = require('./rust-calibration-cancel-bridge.cjs');

function synthetic(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cal-2303-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir, 'models.ini');
  fs.writeFileSync(ini, '[synth]\nmodel = /models/synth.gguf\nctx-size = 4096\n');
  const stateFile = path.join(dir, 'native-calibration-0123456789abcdef.json');
  // What a native front leaves mid-run: an old Core's recover() would interrupt and restore it.
  const running = JSON.stringify({ job: { id: 'native-job', model: 'synth', status: 'running', steps: [], originalText: '[synth]\nctx-size = 2048\n', lastRevision: 'x' }, history: {} });
  fs.writeFileSync(stateFile, running);
  const calls = [];
  const fetchJson = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${new URL(url).pathname}`);
    return { ok: true, status: 200, body: { data: [] } };
  };
  const manager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, fetchJson, calibrationStatePath: stateFile, autoconfig: {}, ...extra });
  return { manager, stateFile, running, ini, calls };
}

const secret = 'synthetic-front-secret';
const trustedRequest = (url) => ({ url, method: 'POST', headers: { 'x-noevia-store-token': secret }, socket: { remoteAddress: '127.0.0.1' }, once() {}, removeListener() {} });

test('#2303 production wiring has no public calibrator and never touches the native state file', async (t) => {
  const f = synthetic(t);
  assert.equal(f.manager.calibration, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), f.running);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), '[synth]\nmodel = /models/synth.gguf\nctx-size = 4096\n');
});

test('#2303 the internal bridges answer available:false over the production manager', async (t) => {
  const f = synthetic(t);
  const sent = [];
  const json = (_res, status, body) => sent.push({ status, body });
  const routes = createCalibrationRoutesBridge({ secret, json, readJson: async () => ({}), calibration: () => f.manager.calibration, log: () => {} });
  const cancel = createCalibrationCancelBridge({ secret, json, readJson: async () => ({}), calibration: () => f.manager.calibration, log: () => {} });
  const res = { once() {}, removeListener() {}, writableEnded: false };
  assert.equal(await routes(trustedRequest('/internal/calibration-routes/facts'), res), true);
  assert.equal(await cancel(trustedRequest('/internal/calibration-cancel/facts'), res), true);
  assert.deepEqual(sent, [{ status: 200, body: { available: false } }, { status: 200, body: { available: false } }]);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), f.running);
});

test('#2303 Core exports the calibration worker marker the release pairs on', () => {
  const { CALIBRATION_WORKER_OWNER } = require('./rust-calibration-routes.cjs');
  assert.equal(CALIBRATION_WORKER_OWNER, 'noevia-calibration-worker-rust/1');
});

test('#2303 index.cjs does not recover the calibration job at boot', () => {
  // Recovering here would interrupt a job the front is still running after a Node-only restart.
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.equal(/calibration\s*\?\.\s*recover\s*\(/.test(source), false);
  assert.equal(/publicCalibrator/.test(source), false);
});

test('#2303 the public calibrator stays constructible for the oracle fixtures only when asked', (t) => {
  const f = synthetic(t, { publicCalibrator: true });
  assert.equal(typeof f.manager.calibration?.stateFacts, 'function');
  assert.equal(typeof f.manager.calibration?.recover, 'function');
});
