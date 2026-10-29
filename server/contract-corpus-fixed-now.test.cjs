'use strict';
// The contract corpus servers (tools/contract-corpus: generate.cjs records, serve.cjs replays, noevia-rs
// corpus-launcher and replay-front.sh run them) pin the #1573 date line with NOEVIA_CONTRACT_FIXED_NOW, so
// a corpus recorded on one day replays the same on another. Fake mocks and a captured spawn: no server runs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const mocks = require('../tools/contract-corpus/mocks.cjs');
const { currentNow, systemPart } = require('./current-time-part.cjs');
const fakeMocks = { inference: { address: () => ({ port: 19001 }) }, diary: { address: () => ({ port: 19002 }) }, close: () => {} };

test('the recorder and replay environment fixes the date line to one documented instant', () => {
  assert.equal(mocks.CORPUS_NOW, '2026-10-12T12:00:00Z');
  const env = mocks.serverEnv({ port: 18021, dataDir: '/synthetic/corpus', origin: 'http://127.0.0.1:18021', mocks: fakeMocks });
  assert.equal(env.NOEVIA_CONTRACT_FIXED_NOW, mocks.CORPUS_NOW);
  const original = console.warn; console.warn = () => {};
  try {
    assert.equal(currentNow(env).toISOString(), '2026-10-12T12:00:00.000Z', 'the value is one the server accepts');
    assert.match(systemPart(currentNow(env), env.TZ), /^Today is Monday, 12 October 2026 \(UTC\)\./);
  } finally { console.warn = original; }
  const recording = mocks.serverEnv({ port: 18021, dataDir: '/synthetic/corpus', origin: 'http://127.0.0.1:18021', mocks: fakeMocks, record: '/synthetic/out' });
  assert.equal(recording.NOEVIA_CONTRACT_FIXED_NOW, mocks.CORPUS_NOW, 'recording and replay state the same day');
});

test('serve.cjs hands the fixed instant to the server it spawns, and a caller cannot replace it', async () => {
  let captured;
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const serve = path.join(__dirname, '../tools/contract-corpus/serve.cjs');
  await vm.runInNewContext(fs.readFileSync(serve, 'utf8'), {
    require: (name) => name === 'node:child_process' ? { spawn: (_bin, _args, options) => { captured = options.env; return child; } } : name === './mocks.cjs' ? { ...mocks, startMocks: async () => fakeMocks } : require(name),
    process: { argv: [process.execPath, serve], env: { UI_DATA_DIR: '/synthetic/corpus', UI_PORT: '18021', NOEVIA_CONTRACT_FIXED_NOW: '2030-01-01T00:00:00Z', NOEVIA_PROJECT_STORE_PORT: '19003', NOEVIA_PROJECT_STORE_TOKEN: 'synthetic-store-token-'.padEnd(64, 'x'), NOEVIA_START_ID: '0123456789abcdef0123456789abcdef' }, execPath: process.execPath, on: () => {}, exit: () => { throw Error('unexpected launcher exit'); } }, console,
  }, { filename: 'tools/contract-corpus/serve.cjs' });
  assert.ok(captured);
  assert.equal(captured.NOEVIA_CONTRACT_FIXED_NOW, '2026-10-12T12:00:00Z');
  // sbstndalton/noevia#1071: the project store the harness hands over reaches Node, and its port is
  // one the outbound guard lets Node reach.
  assert.equal(captured.NOEVIA_PROJECT_STORE_PORT, '19003');
  assert.equal(captured.NOEVIA_CORPUS_ALLOWED_PORTS, '19001,19002,19003');
  // The feature runtime registers under the start id the harness gives the front and Node.
  assert.equal(captured.NOEVIA_START_ID, '0123456789abcdef0123456789abcdef');
});

test('serve.cjs refuses to start Node without the start id the front shares', async () => {
  let spawned = false;
  const serve = path.join(__dirname, '../tools/contract-corpus/serve.cjs');
  for (const start of [undefined, '', 'not-a-start-id', '0123456789ABCDEF0123456789ABCDEF']) {
    const env = { UI_DATA_DIR: '/synthetic/corpus', UI_PORT: '18021', NOEVIA_PROJECT_STORE_PORT: '19003', NOEVIA_PROJECT_STORE_TOKEN: 'synthetic-store-token-'.padEnd(64, 'x'), ...(start === undefined ? {} : { NOEVIA_START_ID: start }) };
    await assert.rejects(vm.runInNewContext(fs.readFileSync(serve, 'utf8'), {
      require: (name) => name === 'node:child_process' ? { spawn: () => { spawned = true; } } : name === './mocks.cjs' ? { ...mocks, startMocks: async () => fakeMocks } : require(name),
      process: { argv: [process.execPath, serve], env, execPath: process.execPath, on: () => {}, exit: () => { throw Error('launcher exit'); } }, console: { error: () => {} },
    }, { filename: 'tools/contract-corpus/serve.cjs' }), /launcher exit/);
  }
  assert.equal(spawned, false);
});
