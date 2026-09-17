'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFolderSync } = require('./model-folder-sync.cjs');

const fail = (status, message = 'no') => Object.assign(Error(message), { status });

test('new files are registered once and the engine is reloaded once', async () => {
  const registered = [], logs = []; let reloads = 0, stems = ['new-a', 'new-b'];
  const sync = createFolderSync({ listUnregistered: async () => stems, register: async (s) => { registered.push(s); }, reloadPresets: async () => { reloads++; return { ok: true }; }, log: (m) => logs.push(m) });
  await sync.run();
  assert.deepEqual(registered, ['new-a', 'new-b']);
  assert.equal(reloads, 1);
  assert.match(logs[0], /set up 2 new models.*new-a, new-b/);
  stems = [];
  await sync.run();
  assert.equal(reloads, 1, 'nothing new, no reload');
});

test('a file the manager refuses is never retried, across restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sync-'));
  const file = path.join(dir, 'skip.json');
  try {
    let attempts = 0;
    const make = () => createFolderSync({ stateFile: file, listUnregistered: async () => ['mtp-head'], register: async () => { attempts++; throw fail(400, 'draft heads are not registered on their own'); }, reloadPresets: async () => ({ ok: true }) });
    const first = make();
    await first.run(); await first.run();
    assert.equal(attempts, 1);
    assert.deepEqual(first.skipped(), ['mtp-head']);
    await make().run();
    assert.equal(attempts, 1, 'the skip list survives a restart');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a transient failure is retried next time, and a busy engine is reported not fatal', async () => {
  let attempts = 0; const logs = [];
  const sync = createFolderSync({ listUnregistered: async () => ['later'], register: async () => { if (++attempts === 1) throw fail(502, 'model manager unreachable'); }, reloadPresets: async () => ({ ok: false, status: 409 }), log: (m) => logs.push(m) });
  await sync.run();
  assert.equal(attempts, 1);
  await sync.run();
  assert.equal(attempts, 2);
  assert.match(logs.at(-1), /after its next reload/);
});

test('a failing scan is logged and never throws', async () => {
  const logs = [];
  const sync = createFolderSync({ listUnregistered: async () => { throw Error('offline'); }, register: async () => {}, reloadPresets: async () => ({ ok: true }), log: (m) => logs.push(m) });
  const out = await sync.run();
  assert.equal(out.error, 'offline');
  assert.match(logs[0], /folder scan failed: offline/);
});

test('scans repeat on a timer and stop cleanly', async () => {
  const timers = []; let runs = 0;
  const sync = createFolderSync({ listUnregistered: async () => { runs++; return []; }, register: async () => {}, reloadPresets: async () => ({ ok: true }),
    setTimer: (fn) => { timers.push(fn); return { id: timers.length, unref() {} }; }, clearTimer: () => {} });
  sync.start(); sync.start();
  assert.equal(timers.length, 1, 'start twice, one timer');
  await timers[0]();
  assert.equal(runs, 1);
  assert.equal(timers.length, 2, 'reschedules itself');
  sync.stop();
});
