'use strict';
// #2516: with AUTOTUNE_RUNNER_IMPL=rust the Rust front owns auto-tune. The real index.cjs boot (under the recording
// preload native-calibration-boot.probe.cjs) must then build no Node auto-tuner, hand the manager the front facade,
// and leave the front's running job in native-autotune-<hash>.json untouched (no boot recover() here); without the
// variable it builds the auto-tuner as before (and its boot recovery marks a running job interrupted).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const davParseWasm = require('./dav-parse-wasm.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const BASE = 'http://127.0.0.1:9';
const INI = '[*]\nn-gpu-layers = 99\n\n[synth]\nmodel = /models/synth.gguf\nctx-size = 12288\n';
const RUNNING = JSON.stringify({ history: {}, settings: {}, job: { id: 'qa-front-job', model: 'synth', bulk: false, mode: 'fast', promptBudgetSeconds: 120,
  status: 'running', phase: 'KV cache', startedAt: 1, log: [], models: [{ model: 'synth', status: 'running', kv: ['bf16', 'q8_0'],
    phases: [{ id: 'kv', label: 'KV cache', status: 'running', steps: [] }] }], _revision: '0'.repeat(64), queueProgress: { done: 0, total: 1 } } });

async function boot(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-autotune-boot-'));
  const out = path.join(dir, 'probe.jsonl');
  const ini = path.join(dir, 'models.ini');
  const state = path.join(dir, `native-autotune-${crypto.createHash('sha256').update(BASE).digest('hex').slice(0, 16)}.json`);
  fs.writeFileSync(ini, INI); fs.writeFileSync(state, RUNNING); fs.writeFileSync(out, '');
  // Core's readiness asks the paired front's store for the auto-roles proof; a synthetic store answers it.
  const store = await require('../tests/server/project-store-server.cjs').startProjectStore(dir);
  let child, closed;
  t.after(async () => {
    await store.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) {
      let timer;
      try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('boot child did not close within 5 seconds')), 5000); })]); }
      finally { clearTimeout(timer); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['--require', path.join(__dirname, 'native-calibration-boot.probe.cjs'), path.join(__dirname, 'index.cjs')], {
    env: { ...process.env, UI_DATA_DIR: dir, UI_PORT: '0', PORT: '0', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://localhost', DIARY_AUTH_TOKEN: 'test-cowork-token', DAV_PARSE_WASM: wasmFile,
      // The paired front Core probes at boot (rust-embedding-background.cjs); without it Core exits at createOwner.
      NOEVIA_SERVER_BIN: require('../tests/server/project-store-server.cjs').syntheticFrontBin(dir),
      NOEVIA_PROJECT_STORE_PORT: String(store.port), NOEVIA_PROJECT_STORE_TOKEN: store.token, NOEVIA_START_ID: '0123456789abcdef0123456789abcdef',
      MODEL_MANAGER_KIND: 'llamacpp', MODEL_MANAGER_BASE_URL: BASE, LLAMACPP_PRESET_PATH: ini,
      CALIBRATION_BOOT_PROBE_OUT: out, CALIBRATION_BOOT_PROBE_MUTATE: '[]', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve) => child.once('close', resolve));
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  const deadline = Date.now() + 30000;
  while (!/cowork-ui listening/.test(stdout) && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.match(stdout, /cowork-ui listening/, `stdout ${stdout.slice(-800)}\nstderr ${stderr.slice(-800)}`);
  // The boot work after listen (a recover() reads the calibration at once; its restore takes a moment).
  await new Promise((r) => setTimeout(r, 1500));
  const records = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { records, state: fs.readFileSync(state, 'utf8'), ini: fs.readFileSync(ini, 'utf8') };
}


test('#2516 the boot with AUTOTUNE_RUNNER_IMPL=rust builds no auto-tuner and leaves the front\'s run alone', { skip: skipWasm }, async (t) => {
  const result = await boot(t, { AUTOTUNE_RUNNER_IMPL: 'rust' });
  const manager = result.records.find((r) => r.manager === 'llamacpp');
  assert.ok(manager, JSON.stringify(result.records));
  assert.equal(manager.autotuneStatePath, null);
  assert.equal(manager.frontAutotune, 'set');
  assert.equal(result.state, RUNNING);
  assert.equal(result.ini, INI);
});

test('#2516 without the variable the boot builds the auto-tuner as before', { skip: skipWasm }, async (t) => {
  const result = await boot(t, {});
  const manager = result.records.find((r) => r.manager === 'llamacpp');
  assert.ok(manager, JSON.stringify(result.records));
  assert.equal(manager.autotuneStatePath, 'set');
  assert.equal(manager.frontAutotune, null);
  // Node owns the run, so its boot recovery marks the running job interrupted.
  assert.match(result.state, /"interrupted"/);
});
