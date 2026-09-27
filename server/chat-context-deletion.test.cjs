'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const context = require('./chat-context.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');

const DELETED_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const health = (model = 'synthetic') => ({ ok: true, body: {
  manager: 'synthetic', version: '1', all_models_loaded: [{ model_name: model, loaded: true,
    backend_alive: true, recipe_options: { ctx_size: 4096 } }],
} });
const messages = () => Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `synthetic turn ${i} ` + 'history '.repeat(50) }));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chat-context-deletion-'));
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' });
  const workspace = store.get(DELETED_ID);
  const other = store.get(OTHER_ID);
  other.saveProjects();
  return { root, store, workspace, other, assertActive: () => workspace.assertActive() };
}

test('a held manager health response cannot recreate a deleted account context observation', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  try {
    const manager = { enabled: true, health: async () => { entered.resolve(); await release.promise; return health(); } };
    const pending = context.resolveRuntimeLimit({ manager, model: 'synthetic', dir: f.workspace.dir,
      scope: 'synthetic-provider', assertActive: f.assertActive });
    await entered.promise;
    f.store.remove(DELETED_ID);
    assert.equal(fs.existsSync(f.workspace.dir), false);
    release.resolve();
    await assert.rejects(pending, (error) => error.status === 410);
    assert.equal(fs.existsSync(f.workspace.dir), false);
    assert.ok(fs.existsSync(path.join(f.other.dir, 'projects.json')));
  } finally {
    release.resolve();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a held manager load cannot persist context after account deletion', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  try {
    const manager = {
      enabled: true,
      health: async () => health('other'),
      load: async () => { entered.resolve(); await release.promise; return { ok: true }; },
    };
    const pending = context.resolveRuntimeLimit({ manager, model: 'synthetic', dir: f.workspace.dir,
      scope: 'synthetic-provider', assertActive: f.assertActive });
    await entered.promise;
    f.store.remove(DELETED_ID);
    release.resolve();
    await assert.rejects(pending, (error) => error.status === 410);
    assert.equal(fs.existsSync(f.workspace.dir), false);
  } finally {
    release.resolve();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a held compaction summary cannot recreate a deleted account context state', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  try {
    const pending = context.prepare({ dir: f.workspace.dir, id: 'synthetic-chat', messages: messages(),
      tools: [], limit: 16000, model: 'synthetic', force: true, assertActive: f.assertActive,
      summarize: async () => { entered.resolve(); await release.promise; return 'Synthetic facts only.'; } });
    await entered.promise;
    f.store.remove(DELETED_ID);
    release.resolve();
    await assert.rejects(pending, (error) => error.status === 410);
    assert.equal(fs.existsSync(f.workspace.dir), false);
  } finally {
    release.resolve();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('normal context and optional round log persist for active users, then reject stale round writes', async () => {
  const f = fixture();
  const previousLog = process.env.CONTEXT_LOG;
  const previousWarn = console.warn;
  try {
    const resolved = await context.resolveRuntimeLimit({ manager: { enabled: true, health: async () => health() },
      model: 'synthetic', dir: f.workspace.dir, scope: 'synthetic-provider', assertActive: f.assertActive });
    assert.equal(resolved.limit, 4096);
    const prepared = await context.prepare({ dir: f.workspace.dir, id: 'synthetic-chat',
      messages: [{ role: 'user', content: 'synthetic question' }], tools: [], limit: 4096,
      model: 'synthetic', assertActive: f.assertActive });
    assert.equal(prepared.messages.length, 1);
    context.save(f.workspace.dir, 'round', { meter: { used: 1 } }, f.assertActive);
    process.env.CONTEXT_LOG = '1';
    context.logRound({ dir: f.workspace.dir, chatId: 'round', model: 'synthetic', limit: 4096,
      round: 0, compacted: false, messages: [{ role: 'user', content: 'synthetic' }], tools: [], assertActive: f.assertActive });
    assert.ok(fs.existsSync(path.join(f.workspace.dir, 'context-log.jsonl')));
    f.store.remove(DELETED_ID);
    assert.throws(() => context.save(f.workspace.dir, 'round', {}, f.assertActive), (error) => error.status === 410);
    let warning = '';
    console.warn = (...parts) => { warning = parts.join(' '); }; // Best-effort log failure must not write.
    context.logRound({ dir: f.workspace.dir, chatId: 'round', model: 'synthetic', limit: 4096,
      round: 1, compacted: false, messages: [], tools: [], assertActive: f.assertActive });
    assert.match(warning, /account no longer exists/);
    assert.equal(fs.existsSync(f.workspace.dir), false);
    assert.ok(fs.existsSync(path.join(f.other.dir, 'projects.json')));
    context.save(f.other.dir, 'other-round', { meter: { used: 2 } }, () => f.other.assertActive());
    assert.deepEqual(context.read(f.other.dir, 'other-round'), { meter: { used: 2 } });
  } finally {
    console.warn = previousWarn;
    if (previousLog === undefined) delete process.env.CONTEXT_LOG;
    else process.env.CONTEXT_LOG = previousLog;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
