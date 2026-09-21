'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeService, parseRepos, GRANTABLE } = require('./code-service.cjs');

const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function repo(name = 'noevia-srepo-') {
  const dir = temp(name);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'qa@example.invalid'); git('config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'first');
  return dir;
}
const project = { id: 'p1' };
const settle = async (service, ws, id) => {
  for (let i = 0; i < 300 && !['completed', 'failed', 'cancelled'].includes(service.get(ws, project, id)?.status); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return service.get(ws, project, id);
};

test('only repositories the operator registered are offered, and only real ones', () => {
  const good = repo();
  const notGit = temp('noevia-plain-');
  const parsed = parseRepos(`noevia|${good},plain|${notGit},relative|not/absolute,broken|/does/not/exist,dupe|${good},noevia|${good}`);
  assert.deepEqual(parsed.map((r) => r.id), ['noevia', 'dupe'], 'non-git, relative, missing and duplicate entries are dropped');
  assert.equal(parsed[0].path, fs.realpathSync(good));
  assert.deepEqual(parseRepos(''), []);
  assert.deepEqual(parseRepos(undefined), []);
});

function service(extra = {}) {
  const dir = temp('noevia-sws-');
  const ws = { dir };
  const repoPath = repo();
  const svc = createCodeService({ repos: [{ id: 'noevia', path: repoPath }],
    // What this deployment gives the agent to run on; a server without it refuses tasks.
    engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder' }),
    connect: async () => ({ prompt: async () => ({ stopReason: 'end_turn' }) }), timeoutMs: 50, ...extra });
  return { svc, ws, repoPath };
}

test('a task cannot name a path the operator did not register', async () => {
  const { svc, ws } = service();
  await assert.rejects(() => svc.start(ws, project, { repository: '/etc', prompt: 'x' }), /registered/);
  await assert.rejects(() => svc.start(ws, project, { repository: '../../etc', prompt: 'x' }), /registered/);
  await assert.rejects(() => svc.start(ws, project, { prompt: 'x' }), /registered/);
  await assert.rejects(() => svc.start(ws, project, { repository: 'noevia', prompt: '  ' }), /Describe the task/);
  await assert.rejects(() => svc.start(ws, project, { repository: 'noevia', prompt: 'x'.repeat(8001) }), /too long/);
});

test('capabilities and domains are filtered to what noevia will grant at all', async () => {
  const { svc, ws } = service();
  const started = await svc.start(ws, project, { repository: 'noevia', prompt: 'fix',
    capabilities: ['edit_file', 'open_browser', 'external_account', 'not_a_thing'],
    domains: ['Registry.NPMJS.org', 'not a domain', 'localhost', '../evil', 'x.test'] });
  assert.deepEqual(started.capabilities, ['edit_file'], 'browser and external account belong to the node, not here');
  assert.deepEqual(started.domains, ['registry.npmjs.org', 'x.test'], 'bare names and junk are dropped');
  assert.ok(GRANTABLE.every((c) => typeof c === 'string'));
  await settle(svc, ws, started.taskId);
});

test('one task at a time per project', async () => {
  let release;
  const { svc, ws } = service({ connect: async () => ({ prompt: () => new Promise((r) => { release = () => r({ stopReason: 'end_turn' }); }) }) });
  const first = await svc.start(ws, project, { repository: 'noevia', prompt: 'one' });
  await assert.rejects(() => svc.start(ws, project, { repository: 'noevia', prompt: 'two' }), /already has a task running/);
  release();
  await settle(svc, ws, first.taskId);
  // Once it has finished, the next task starts.
  const second = await svc.start(ws, project, { repository: 'noevia', prompt: 'three' });
  assert.ok(second.taskId);
  await settle(svc, ws, second.taskId);
});

test('a task from another project is not found, rather than forbidden', async () => {
  const { svc, ws } = service();
  const started = await svc.start(ws, project, { repository: 'noevia', prompt: 'fix' });
  await settle(svc, ws, started.taskId);
  assert.throws(() => svc.get(ws, { id: 'other' }, started.taskId), /Task not found/);
  assert.throws(() => svc.get(ws, project, '00000000-0000-4000-8000-000000000000'), /Task not found/);
});

test('an approval reaches the waiting task, and an unknown decision is refused', async () => {
  let ask;
  const { svc, ws } = service({
    connect: async ({ handlers }) => ({ prompt: async () => {
      ask = handlers.requestPermission({ toolCall: { kind: 'edit', locations: [] }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] });
      await ask; return { stopReason: 'end_turn' };
    } }),
  });
  const started = await svc.start(ws, project, { repository: 'noevia', prompt: 'fix', capabilities: ['edit_file'] });
  for (let i = 0; i < 200 && !svc.get(ws, project, started.taskId)?.approval; i++) await new Promise((r) => setTimeout(r, 5));
  const waiting = svc.get(ws, project, started.taskId);
  assert.ok(waiting.approval, 'the task reports what it is waiting for');
  assert.equal(waiting.approval.action, 'edit_file');
  assert.throws(() => svc.decide(ws, project, started.taskId, 'maybe'), /Unknown decision/);
  assert.deepEqual(svc.decide(ws, project, started.taskId, 'approve'), { ok: true });
  assert.deepEqual(await ask, { outcome: 'selected', optionId: 'y' });
  assert.throws(() => svc.decide(ws, project, started.taskId, 'approve'), /no longer waiting/);
  await settle(svc, ws, started.taskId);
});

test('an unanswered approval times out as a refusal', async () => {
  let ask;
  const { svc, ws } = service({
    timeoutMs: 20,
    connect: async ({ handlers }) => ({ prompt: async () => {
      ask = handlers.requestPermission({ toolCall: { kind: 'edit', locations: [] }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] });
      await ask; return { stopReason: 'end_turn' };
    } }),
  });
  const started = await svc.start(ws, project, { repository: 'noevia', prompt: 'fix', capabilities: ['edit_file'] });
  await settle(svc, ws, started.taskId);
  assert.deepEqual(await ask, { outcome: 'selected', optionId: 'n' });
});

test('cancelling refuses whatever was waiting, so no card can be answered afterwards', async () => {
  let ask;
  const { svc, ws } = service({
    timeoutMs: 60000,
    connect: async ({ handlers }) => ({ prompt: async () => {
      ask = handlers.requestPermission({ toolCall: { kind: 'edit', locations: [] }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] });
      await ask; return { stopReason: 'end_turn' };
    } }),
  });
  const started = await svc.start(ws, project, { repository: 'noevia', prompt: 'fix', capabilities: ['edit_file'] });
  for (let i = 0; i < 200 && !svc.get(ws, project, started.taskId)?.approval; i++) await new Promise((r) => setTimeout(r, 5));
  svc.cancel(ws, project, started.taskId);
  assert.deepEqual(await ask, { outcome: 'selected', optionId: 'n' }, 'the harness is told no, not left hanging');
  assert.equal(svc.get(ws, project, started.taskId).approval, null);
  assert.throws(() => svc.decide(ws, project, started.taskId, 'approve'), /no longer waiting/);
});

test('the listed task carries no host path and no repository location', async () => {
  const { svc, ws, repoPath } = service();
  const started = await svc.start(ws, project, { repository: 'noevia', prompt: 'fix' });
  await settle(svc, ws, started.taskId);
  const [listed] = svc.list(ws, project);
  assert.equal(JSON.stringify(listed).includes(repoPath), false);
  assert.deepEqual(svc.repositories(), [{ id: 'noevia' }], 'the browser learns the name, never the path');
});

test('two tasks waiting at once each get their own answer', async () => {
  // Same workspace, different projects: both wait, and answering one must not touch the other.
  const asks = {};
  const dir = temp('noevia-sws-');
  const ws = { dir };
  const repoPath = repo();
  const svc = createCodeService({ repos: [{ id: 'noevia', path: repoPath }], timeoutMs: 60000,
    engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder' }),
    connect: async ({ handlers }) => ({ prompt: async () => {
      const key = Object.keys(asks).length ? 'b' : 'a';
      asks[key] = handlers.requestPermission({ toolCall: { kind: 'edit', locations: [] },
        options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] });
      await asks[key]; return { stopReason: 'end_turn' };
    } }) });
  const one = { id: 'one' }, two = { id: 'two' };
  const a = await svc.start(ws, one, { repository: 'noevia', prompt: 'first', capabilities: ['edit_file'] });
  const b = await svc.start(ws, two, { repository: 'noevia', prompt: 'second', capabilities: ['edit_file'] });
  for (let i = 0; i < 300 && !(svc.get(ws, one, a.taskId)?.approval && svc.get(ws, two, b.taskId)?.approval); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(svc.get(ws, one, a.taskId).approval && svc.get(ws, two, b.taskId).approval, 'both are waiting');
  svc.decide(ws, one, a.taskId, 'approve');
  assert.deepEqual(await asks.a, { outcome: 'selected', optionId: 'y' });
  assert.ok(svc.get(ws, two, b.taskId).approval, 'the other task is still waiting for its own answer');
  svc.decide(ws, two, b.taskId, 'deny');
  assert.deepEqual(await asks.b, { outcome: 'selected', optionId: 'n' });
});

test('a harness or preparation mode noevia does not offer is refused at the server', async () => {
  const { svc, ws } = service();
  assert.deepEqual(svc.harnesses(), [{ id: 'opencode', label: 'OpenCode', version: null }]);
  await assert.rejects(() => svc.start(ws, project, { repository: 'noevia', prompt: 'x', harness: 'claude-code' }),
    /not configured on this server/, 'the browser list is a convenience, not the authority');
  await assert.rejects(() => svc.start(ws, project, { repository: 'noevia', prompt: 'x', promptPreparation: 'invented' }),
    /Unknown prompt preparation/);
  // Unavailable modes are refused with the measured reason, not silently downgraded to Direct.
  await assert.rejects(() => svc.start(ws, project, { repository: 'noevia', prompt: 'x', promptPreparation: 'local' }),
    /0 of 18/);
  await assert.rejects(() => svc.start(ws, project, { repository: 'noevia', prompt: 'x', promptPreparation: 'frontier' }),
    /outbound allowlist/);
});

test('prompt preparation offers Direct and nothing that lacks evidence', async () => {
  const { svc, ws } = service();
  const modes = svc.promptPreparation();
  assert.deepEqual(modes.filter((m) => m.available).map((m) => m.id), ['direct']);
  assert.equal(modes.some((m) => m.id === 'auto'), false, 'Auto needs evidence first (spec §2)');
  for (const mode of modes) assert.ok(mode.reason.length > 20, `${mode.id} should say why`);
  // The default start is Direct, and it is recorded on the run.
  const started = await svc.start(ws, project, { repository: 'noevia', prompt: 'fix' });
  assert.equal(started.promptPreparation, 'direct');
  assert.equal(started.harness, 'opencode');
  await settle(svc, ws, started.taskId);
});

test('the deployment names its harness, and whether it is sandboxed', () => {
  const { defaultHarnesses } = require('./code-service.cjs');
  assert.deepEqual(defaultHarnesses({ CODE_HARNESS_NAME: 'claude-code', CODE_HARNESS_VERSION: '2.0' }),
    [{ id: 'claude-code', label: 'claude-code', version: '2.0' }]);
  assert.deepEqual(defaultHarnesses({ CODE_HARNESS_NAME: '  ' })[0].id, 'opencode');
  const { svc } = service();
  assert.equal(svc.sandboxed(), false);
  const { svc: sandboxed } = service({ sandboxKind: 'sandbox' });
  assert.equal(sandboxed.sandboxed(), true);
});

test('the harness user is read only in the form that can be acted on', () => {
  const { parseUser } = require('./code-service.cjs');
  assert.deepEqual(parseUser('1000:1000'), { uid: 1000, gid: 1000 });
  assert.deepEqual(parseUser(' 65534:65534 '), { uid: 65534, gid: 65534 });
  for (const bad of ['1000', 'node:node', '', undefined, '-1:0', '1000:1000:1000', '99999999:1']) {
    assert.equal(parseUser(bad), null, JSON.stringify(bad));
  }
});
