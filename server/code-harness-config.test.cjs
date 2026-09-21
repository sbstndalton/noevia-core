'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { configFor, writeHarnessConfig, PERMISSION } = require('./code-harness-config.cjs');

const base = { harness: 'opencode', model: 'Ornith-1.5-9B-Q5_K_M', engine: 'http://llama:8080/v1' };

test('every action class asks, and there is no way to write a config that does not', () => {
  const { json } = configFor(base);
  assert.deepEqual(json.permission, { edit: 'ask', bash: 'ask', webfetch: 'ask' });
  // The caller cannot pass its own permissions in: a "never ask" is not expressible here.
  const { json: attempted } = configFor({ ...base, permission: { edit: 'allow' }, json: { permission: {} } });
  assert.deepEqual(attempted.permission, { edit: 'ask', bash: 'ask', webfetch: 'ask' });
  // And the returned object is a copy, so a caller mutating it cannot change the next task's.
  attempted.permission.edit = 'allow';
  assert.equal(PERMISSION.edit, 'ask');
  assert.equal(configFor(base).json.permission.edit, 'ask');
});

test('the agent is given one endpoint and one model, and never updates itself', () => {
  const { name, json } = configFor({ ...base, contextTokens: 32768 });
  assert.equal(name, 'opencode.json');
  assert.equal(json.autoupdate, false);
  assert.equal(json.share, 'disabled');
  assert.equal(json.model, 'local/Ornith-1.5-9B-Q5_K_M');
  assert.equal(json.small_model, json.model, 'a second endpoint it could not reach is worse than one it can');
  assert.equal(json.provider.local.options.baseURL, 'http://llama:8080/v1');
  assert.equal(json.provider.local.models['Ornith-1.5-9B-Q5_K_M'].limit.context, 32768);
  assert.equal(json.provider.local.models['Ornith-1.5-9B-Q5_K_M'].tool_call, true);
});

test('a harness whose configuration noevia cannot pin is refused, not run with its defaults', () => {
  for (const harness of ['claude-code', 'codex', '', null]) {
    assert.throws(() => configFor({ ...base, harness }), (e) => e.status === 409 && /cannot pin/.test(e.message));
  }
});

test('a deployment with no model or no endpoint refuses the task instead of starting a useless agent', () => {
  assert.throws(() => configFor({ ...base, model: '' }), (e) => e.status === 409 && /needs a model/.test(e.message));
  assert.throws(() => configFor({ ...base, engine: null }), (e) => e.status === 409 && /no model endpoint/.test(e.message));
  // Not a URL at all, and a relative path, are both refused: the sandbox would resolve neither.
  assert.throws(() => configFor({ ...base, engine: 'llama:8080' }), (e) => e.status === 409);
  assert.throws(() => configFor({ ...base, engine: '/v1' }), (e) => e.status === 409);
});

test('the file lands in the task workspace, owned by whoever the harness runs as', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-harness-config-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const chowned = [];
  const realChown = fs.chownSync;
  t.mock.method(fs, 'chownSync', (file, uid, gid) => { chowned.push([path.basename(file), uid, gid]); });
  const record = writeHarnessConfig({ ...base, cwd, owner: { uid: 1000, gid: 1000 } });
  assert.equal(record.file, 'opencode.json');
  assert.deepEqual(record.permission, { edit: 'ask', bash: 'ask', webfetch: 'ask' });
  assert.deepEqual(chowned, [['opencode.json', 1000, 1000]]);
  const written = JSON.parse(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8'));
  assert.equal(written.permission.bash, 'ask');
  assert.equal(realChown === fs.chownSync, false);
});

test('an api key is written only when the deployment has one, and never invented', () => {
  assert.equal(configFor(base).json.provider.local.options.apiKey, 'none');
  assert.equal(configFor({ ...base, apiKey: 'k' }).json.provider.local.options.apiKey, 'k');
});
