'use strict';
// #2303: with CALIBRATION_WORKER_OWNER exported, the Rust front owns the calibration job. The real index.cjs boot,
// with production options, must construct no public calibrator and must not recover the job (nothing at boot reads
// the manager's calibration), and must hand the front's load bridge the manager's own load decision. This boots index.cjs itself under a recording preload
// (native-calibration-boot.probe.cjs), with a running job a native front left in the state file, instead of reading
// source shapes. The fixtures rewrite the real modules as they load, to prove the check fails when either is
// reintroduced, including behind a comment-prefixed line or split across lines.
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
const INI = '[*]\nn-gpu-layers = 99\n\n[synth]\nmodel = /models/synth.gguf\nctx-size = 12288\n\n[synth-invalid]\nmodel = /models/synth.gguf\nctx-size = 4096.5\n';
const RUNNING = JSON.stringify({ job: { id: 'native-job', model: 'synth', status: 'running', phase: 'Long-prompt test at 12,288 tokens', steps: [], originalText: '[*]\nn-gpu-layers = 99\n\n[synth]\nmodel = /models/synth.gguf\nctx-size = 4096\n', originalRevision: 'a'.repeat(64), lastRevision: crypto.createHash('sha256').update(INI).digest('hex') }, history: {} });
const AUTOTUNE_RECOVER = '    modelManager.autotune?.recover().catch(() => undefined);';
const GATED = 'const calibrator=presets&&publicCalibrator?require(';
const PRESET_OPTION = '  presetPath: process.env.LLAMACPP_PRESET_PATH,';

async function boot(t, mutations = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cal-boot-'));
  const out = path.join(dir, 'probe.jsonl');
  const ini = path.join(dir, 'models.ini');
  const state = path.join(dir, `native-calibration-${crypto.createHash('sha256').update(BASE).digest('hex').slice(0, 16)}.json`);
  fs.writeFileSync(ini, INI); fs.writeFileSync(state, RUNNING); fs.writeFileSync(out, '');
  let child, closed;
  t.after(async () => {
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
      NOEVIA_PROJECT_STORE_PORT: '9', NOEVIA_PROJECT_STORE_TOKEN: 'synthetic-store-token-'.padEnd(64, 'x'), NOEVIA_START_ID: '0123456789abcdef0123456789abcdef',
      MODEL_MANAGER_KIND: 'llamacpp', MODEL_MANAGER_BASE_URL: BASE, LLAMACPP_PRESET_PATH: ini,
      CALIBRATION_BOOT_PROBE_OUT: out, CALIBRATION_BOOT_PROBE_MUTATE: JSON.stringify(mutations) },
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

// What the check refuses: a public calibrator built, production asking for one, the calibration read at boot (a
// recover()), or the front's running job touched.
function violations({ records, state, ini }) {
  const found = [];
  if (records.some((r) => r.mutationMissed)) found.push('a fixture did not apply');
  if (records.some((r) => r.createCalibrator === 'public')) found.push('public calibrator constructed');
  if (records.some((r) => r.manager === 'llamacpp' && r.publicCalibrator !== null)) found.push('production asks for publicCalibrator');
  if (records.some((r) => 'calibrationRead' in r || r.recover)) found.push('calibration read at boot');
  if (state !== RUNNING) found.push('state file changed');
  if (ini !== INI) found.push('models.ini changed');
  return found;
}

test('#2303 Core exports the worker marker this boot check stands behind', () => {
  assert.equal(require('./rust-calibration-routes.cjs').CALIBRATION_WORKER_OWNER, 'noevia-calibration-worker-rust/2');
});

test('#2303 the real boot builds no public calibrator and leaves the front\'s running job alone', { skip: skipWasm }, async (t) => {
  const result = await boot(t);
  assert.ok(result.records.some((r) => r.manager === 'llamacpp'), JSON.stringify(result.records));
  assert.deepEqual(violations(result), []);
  // Generation 2: the front's loads are decided by this process's own overBudget(), wired from the manager.
  assert.ok(result.records.some((r) => r.loadRefusalRoute === 'function'), JSON.stringify(result.records));
  assert.ok(result.records.some((r) => r.loadRefusalAnswer === 'invalid_size'), JSON.stringify(result.records));
});

test('#2303 fixture: a boot recover() behind a comment-prefixed line is caught', { skip: skipWasm }, async (t) => {
  const result = await boot(t, [{ file: 'index.cjs', from: AUTOTUNE_RECOVER, to: `    /* boot */ modelManager.calibration?.recover().catch(() => undefined);\n${AUTOTUNE_RECOVER}` }]);
  assert.ok(result.records.some((r) => r.mutated === 'index.cjs'));
  assert.ok(violations(result).includes('calibration read at boot'), JSON.stringify(result.records));
});

test('#2303 fixture: a boot recover() split across lines is caught', { skip: skipWasm }, async (t) => {
  const result = await boot(t, [{ file: 'index.cjs', from: AUTOTUNE_RECOVER, to: `    modelManager.calibration\n      ?.recover()\n      .catch(() => undefined);\n${AUTOTUNE_RECOVER}` }]);
  assert.ok(violations(result).includes('calibration read at boot'), JSON.stringify(result.records));
});

test('#2303 fixture: an ungated public calibrator behind a comment-prefixed line is caught', { skip: skipWasm }, async (t) => {
  const result = await boot(t, [{ file: 'llamacpp-manager.cjs', from: GATED, to: '/* gate removed */ const calibrator=presets?require(' }]);
  assert.ok(result.records.some((r) => r.mutated === 'llamacpp-manager.cjs'));
  assert.ok(violations(result).includes('public calibrator constructed'), JSON.stringify(result.records));
});

test('#2303 fixture: production wiring that asks for the public calibrator is caught', { skip: skipWasm }, async (t) => {
  const result = await boot(t, [{ file: 'index.cjs', from: PRESET_OPTION, to: `${PRESET_OPTION} // test-only option\n  publicCalibrator: true,` }]);
  const found = violations(result);
  assert.ok(found.includes('production asks for publicCalibrator') && found.includes('public calibrator constructed'), JSON.stringify(found));
});

test('#2303 fixture: both reintroduced recover the front\'s job, which the check sees', { skip: skipWasm }, async (t) => {
  const result = await boot(t, [
    { file: 'llamacpp-manager.cjs', from: GATED, to: 'const calibrator=presets?require(' },
    { file: 'index.cjs', from: AUTOTUNE_RECOVER, to: `    modelManager.calibration?.recover().catch(() => undefined);\n${AUTOTUNE_RECOVER}` },
  ]);
  const found = violations(result);
  assert.ok(found.includes('state file changed'), JSON.stringify({ found, state: result.state }));
  assert.match(result.state, /"interrupted"/);
});
