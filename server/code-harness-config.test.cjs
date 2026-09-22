'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { configFor, pinFilesFor, writeHarnessConfig, PERMISSION, EDIT_TOOLS } = require('./code-harness-config.cjs');

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
  for (const harness of ['aider', 'goose', '', null]) {
    assert.throws(() => pinFilesFor({ ...base, harness }), (e) => e.status === 409 && /cannot pin/.test(e.message));
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

const fileOf = (pinned, p) => pinned.files.find((f) => f.path === p);

test('Claude Code: every edit, command and fetch asks, bypass and auto modes are off, one endpoint', () => {
  const pinned = pinFilesFor({ ...base, harness: 'claude-code', apiKey: 'k' });
  const local = JSON.parse(fileOf(pinned, '.claude/settings.local.json').content);
  assert.equal(fileOf(pinned, '.claude/settings.local.json').base, 'cwd', 'project-local outranks user settings');
  assert.deepEqual(local.permissions.ask, ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']);
  assert.deepEqual(local.permissions.allow, []);
  assert.equal(local.permissions.defaultMode, 'default');
  assert.equal(local.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(local.permissions.disableAutoMode, 'disable');
  assert.equal(local.env.ANTHROPIC_BASE_URL, 'http://llama:8080', 'Claude Code appends /v1/messages itself');
  assert.equal(local.env.ANTHROPIC_MODEL, base.model);
  assert.equal(local.env.ANTHROPIC_API_KEY, 'k');
  assert.equal(local.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(local.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(fileOf(pinned, '.claude/settings.json').base, 'home');
  assert.ok(Object.isFrozen(EDIT_TOOLS), 'a caller cannot widen or narrow the list');
});

test('Codex is refused: measured, its commands run without asking inside its own sandbox', () => {
  assert.throws(() => pinFilesFor({ ...base, harness: 'codex' }), (e) => e.status === 409 && /cannot pin/.test(e.message) && /without asking/.test(e.message));
});

test('pi: one local provider and model, no install telemetry, and a gate that fails closed', () => {
  const pinned = pinFilesFor({ ...base, harness: 'pi', contextTokens: 16384 });
  assert.ok(pinned.files.every((f) => f.base === 'home'));
  const models = JSON.parse(fileOf(pinned, '.pi/agent/models.json').content);
  assert.equal(models.providers.noevia.baseUrl, 'http://llama:8080/v1');
  assert.equal(models.providers.noevia.api, 'openai-completions');
  assert.equal(models.providers.noevia.models[0].contextWindow, 16384);
  const settings = JSON.parse(fileOf(pinned, '.pi/agent/settings.json').content);
  assert.deepEqual(settings, { defaultProvider: 'noevia', defaultModel: base.model, enableInstallTelemetry: false });
});

test('pi gate: reads pass, everything else asks with full input, and no channel or an error blocks', async () => {
  const gate = fileOf(pinFilesFor({ ...base, harness: 'pi' }), '.pi/agent/extensions/noevia-gate.js').content;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(gate).toString('base64'));
  let handler; mod.default({ on: (name, fn) => { assert.equal(name, 'tool_call'); handler = fn; } });
  const asked = [];
  const ui = (answer) => ({ hasUI: true, ui: { confirm: async (title, body) => { asked.push([title, body]); if (answer instanceof Error) throw answer; return answer; } } });
  assert.equal(await handler({ toolName: 'read', input: { path: 'a' } }, ui(false)), undefined);
  assert.equal(await handler({ toolName: 'bash', input: { command: 'rm -rf build' } }, ui(true)), undefined);
  assert.match(asked[0][1], /rm -rf build/, 'the full arguments are shown');
  assert.equal((await handler({ toolName: 'write', input: {} }, ui(false))).block, true);
  assert.equal((await handler({ toolName: 'edit', input: {} }, ui(new Error('channel closed')))).block, true);
  assert.equal((await handler({ toolName: 'some_new_tool', input: {} }, { hasUI: false })).block, true);
  assert.equal((await handler({ toolName: 'bash', input: {} }, ui('yes'))).block, true, 'only a literal true allows');
});

test('home-based harnesses need the private home and write everything into it, owned by the harness user', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-harness-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'tree'), home = path.join(root, 'home'); fs.mkdirSync(cwd); fs.mkdirSync(home);
  assert.throws(() => writeHarnessConfig({ ...base, harness: 'pi', cwd }), (e) => e.status === 409 && /home/.test(e.message));
  const chowned = [];
  t.mock.method(fs, 'chownSync', (file) => { chowned.push(path.relative(root, file)); });
  const record = writeHarnessConfig({ ...base, harness: 'claude-code', cwd, home, owner: { uid: 1000, gid: 1000 } });
  assert.deepEqual(record.files, ['./.claude/settings.local.json', '~/.claude/settings.json']);
  assert.ok(fs.existsSync(path.join(cwd, '.claude/settings.local.json')) && fs.existsSync(path.join(home, '.claude/settings.json')));
  assert.deepEqual(chowned.sort(), ['home/.claude', 'home/.claude/settings.json', 'tree/.claude', 'tree/.claude/settings.local.json']);
  assert.equal(fs.statSync(path.join(home, '.claude/settings.json')).mode & 0o777, 0o600);
});
