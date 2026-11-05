'use strict';
// A frozen oracle from origin/main. All engine calls are synthetic functions; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const SOURCE = '99ebd9c951b16cb6beeeae8bd79722cf4f3368bb';
const revision = text => crypto.createHash('sha256').update(text).digest('hex');
const before = '[synthetic]\nctx-size = 4096\n';
const after = '[synthetic]\nctx-size = 8192\n';
const phase = () => ({ id: 'context', label: 'Context size', status: 'running', _beforeText: before,
  steps: [{ id: 'capacity', label: 'Load and long-prompt recall', status: 'running' }] });
const job = () => ({ id: 'synthetic-job', model: 'synthetic', status: 'running', phase: 'Context size',
  _revision: revision(after), models: [{ model: 'synthetic', status: 'running', phases: [phase()] }] });
const cases = [
  { name: 'empty', state: {} },
  { name: 'completed', state: { job: { ...job(), status: 'passed' } } },
  { name: 'restore-phase', state: { job: job() } },
  { name: 'external-edit', text: 'external edit', state: { job: job() } },
  { name: 'deferred-reload', foreign: true, state: { job: job() } },
  { name: 'unload-refused', unloadFails: true, state: { job: job() } },
  { name: 'reload-refused', reloadFails: true, state: { job: job() } },
  { name: 'no-snapshot', state: { job: { ...job(), models: [{ model: 'synthetic', status: 'running', phases: [{ ...phase(), _beforeText: undefined }] }] } } },
  { name: 'pending-revision', state: { job: { ...job(), _revision: 'older', _pendingRevision: revision(after) } } },
  { name: 'pending-not-ours', state: { job: { ...job(), _revision: 'older', _pendingRevision: 'different' } } },
  { name: 'legacy', state: { job: { id: 'old', model: 'synthetic', status: 'running', originalText: before, lastRevision: revision(after) } } },
  { name: 'legacy-external-edit', text: 'external edit', state: { job: { id: 'old', model: 'synthetic', status: 'running', originalText: before, lastRevision: revision(after) } } },
];
test('recorded recovery behavior of the original actor with fake files and engine', async () => {
  const filename = path.join(__dirname, 'llamacpp-full-autotune.cjs');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(__dirname);
  mod._compile(execFileSync('git', ['show', SOURCE + ':server/llamacpp-full-autotune.cjs'], { encoding: 'utf8' }), filename);
  const evidence = process.env.K5_EVIDENCE;
  assert.ok(evidence, 'K5_EVIDENCE must name the private evidence folder');
  const records = [];
  for (const input of cases) {
    const dir = fs.mkdtempSync(path.join(evidence, 'oracle-'));
    try {
      const file = path.join(dir, 'state.json');
      fs.writeFileSync(file, JSON.stringify(input.state));
      let text = input.text ?? after, loaded = true;
      const effects = [];
      const actor = mod.exports.createFullAutotuner({ stateFile: file, now: () => 123456,
        presets: { snapshot: () => ({ text, revision: revision(text) }),
          commit: async ({ baseRevision, text: next }) => { assert.equal(baseRevision, revision(text)); effects.push('restore'); text = next; } },
        rawModels: async () => ({ ok: true, body: { data: [{ id: 'synthetic', status: { value: loaded ? 'loaded' : 'unloaded' } },
          ...(input.foreign ? [{ id: 'other', status: { value: 'loaded' } }] : [])] } }),
        request: async (url) => {
          assert.ok(['/models/unload', '/models?reload=1'].includes(url), 'unexpected engine call');
          effects.push(url === '/models/unload' ? 'unload' : 'reload');
          if (url === '/models/unload') { if (!input.unloadFails) loaded = false; return { ok: !input.unloadFails }; }
          return { ok: !input.reloadFails };
        },
        sleep: async () => {}, servingChecks: {}, planner: {}, loadAdvisor: {}, longProfiles: {},
        invalidateBaseline: async () => { effects.push('invalidate'); return true; },
      });
      await actor.recover();
      records.push({ input: JSON.parse(JSON.stringify(input)), expected: { state: JSON.parse(fs.readFileSync(file)), text, effects } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const target = path.join(__dirname, 'fixtures/autotune-recovery-node.json');
  if (process.env.K5_RECORD === '1') fs.writeFileSync(target, JSON.stringify({ source: SOURCE, now: 123456, records }, null, 2) + '\n');
  else assert.deepEqual(records, JSON.parse(fs.readFileSync(target)).records);
});
