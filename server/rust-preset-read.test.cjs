'use strict';
// #2387 (G2): the preset facts (parse, editor limit, revision, defaults, field names) are Rust's.
// The Rust front answers GET /api/models/preset from its own read of models.ini (noevia-rs
// bins/noevia-server/tests/preset_read.rs); Node reads the very same code through dav-parse.wasm.
// There is no facts bridge between them any more: this file proves Node's reads come from the
// native reader, agree with the frozen JS oracle, and keep the three read outcomes apart.
// Needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); the pinned module is built by the image build.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const dav = require('./dav-parse-wasm.cjs');
const runtime = require('./llamacpp-presets.cjs');
const reference = require('../tests/reference/llamacpp-presets-js.cjs');
const { refuseOwned } = require('./rust-preset-read.cjs');

const LIMITS = { capMib: 1024, hardMaxMib: 2048 };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
function fixture(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.ini');
  if (text !== undefined) fs.writeFileSync(file, text);
  return { dir, file, store: () => runtime.createPresetStore(file, { cacheRam: LIMITS }) };
}
const TEXT = '[*]\nparallel=2\n[m]\nc=4096\nmodel=/private/synthetic.gguf\n';
const wasmPath = require.resolve('./dav-parse-wasm.cjs'), original = require.cache[wasmPath];
/** Wraps the wasm module's exports for this test, counting calls by export name. */
function spied(t, over = {}) {
  const calls = [];
  const wrapped = { ...dav };
  for (const key of ['llamacppPresetsParse', 'llamacppPresetsFacts']) {
    const fn = over[key] || dav[key];
    wrapped[key] = (...args) => { calls.push(key); return fn(...args); };
  }
  require.cache[wasmPath] = { id: wasmPath, filename: wasmPath, loaded: true, exports: wrapped };
  t.after(() => { require.cache[wasmPath] = original; });
  return calls;
}

test('exact GET refuses before Node route, other methods and paths stay available', () => {
  for (const [method, url, owns] of [
    ['GET', '/api/models/preset?model=m', true],
    ['PUT', '/api/models/preset', false],
    ['HEAD', '/api/models/preset', false],
    ['GET', '/api/models/preset/', false],
    ['GET', '/api/models/preset/suggest', false],
  ]) {
    let status;
    assert.equal(refuseOwned({ method, url }, {}, {
      parseRequestUrl: req => new URL(req.url, 'http://localhost'),
      json: (_res, s) => { status = s; },
    }), owns);
    assert.equal(status, owns ? 503 : undefined);
  }
});

test('the facts bridge is gone: no module, no route, no wiring', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'rust-preset-read-bridge.cjs')), false);
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.ok(!index.includes('rust-preset-read-bridge') && !index.includes('/internal/preset-read'));
  assert.ok(index.includes("require('./rust-preset-read.cjs').refuseOwned"), 'the exact GET is still refused here');
  // The pair marker the supervisor and the release assembly look for, and the exports it names.
  const marker = require('./rust-preset-facts.cjs');
  assert.equal(marker.PROTOCOL, 'noevia-preset-facts/1');
  for (const name of marker.NATIVE_EXPORTS) assert.equal(typeof dav[name], 'function', name);
  assert.doesNotThrow(() => marker.verifyNative(dav));
  // A module from before the native reader stops startup instead of failing every read.
  assert.throws(() => marker.verifyNative({ ...dav, llamacppPresetsFacts: () => { throw Object.assign(Error('x'), { reason: 'input' }); } }), /lacks the native preset reader \(input\)/);
  assert.throws(() => marker.verifyNative({ ...dav, llamacppPresetsParse: undefined }), /has no llamacppPresetsParse/);
  assert.ok(fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8').includes("require('./rust-preset-facts.cjs').verifyNative(davParseWasm)"));
  assert.ok(fs.readFileSync(path.join(__dirname, 'llamacpp-presets.cjs'), 'utf8').includes("require('./rust-preset-facts.cjs')"));
});

test('Node reads the facts from the native reader, with the conditional writer revision', (t) => {
  const { file, store } = fixture(t, TEXT);
  const calls = spied(t);
  const s = store();
  const facts = s.get('m');
  assert.ok(calls.includes('llamacppPresetsFacts'), 'get() asked the native reader');
  assert.equal(facts.revision, sha(TEXT));
  assert.equal(facts.exists, true);
  assert.deepEqual(facts.options, { 'ctx-size': '4096' });
  assert.deepEqual(facts.defaults, { parallel: '2' });
  assert.deepEqual(facts.fields, Object.keys(reference.fields));
  assert.equal(JSON.stringify(facts).includes('/private/'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), TEXT, 'a read never changes the file');
  const absent = s.get('');
  assert.equal(absent.exists, false);
  assert.deepEqual(absent.options, {});
  assert.deepEqual(absent.defaults, facts.defaults);
  // snapshot(), prepare() and the writer's revision check use that same read.
  calls.length = 0;
  assert.equal(s.snapshot().revision, facts.revision);
  assert.ok(calls.includes('llamacppPresetsParse'), 'snapshot() parsed natively');
  const candidate = s.prepare({ model: 'm', baseRevision: facts.revision, options: { parallel: '3' } });
  assert.equal(candidate.baseRevision, facts.revision);
  assert.equal(candidate.revision, sha(candidate.text), 'the candidate revision is the native one');
  assert.ok(calls.includes('llamacppPresetsParse'), 'the replaced lines are the native reader\'s');
  // A file that moved: the old revision is stale, and the new one reads current.
  fs.writeFileSync(file, '[m]\nc=8192\n');
  assert.throws(() => s.prepare({ model: 'm', baseRevision: facts.revision, options: { parallel: '3' } }), { status: 409 });
  assert.equal(s.get('m').revision, sha('[m]\nc=8192\n'));
});

test('missing, malformed and valid-empty files are three different outcomes', (t) => {
  const missing = fixture(t);
  assert.throws(() => missing.store().get('m'), { code: 'ENOENT' });
  const empty = fixture(t, '');
  const facts = empty.store().get('m');
  assert.equal(facts.revision, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.deepEqual([facts.exists, facts.options, facts.defaults], [false, {}, {}]);
  const comment = fixture(t, '; synthetic comment only\n\n');
  assert.equal(comment.store().get('m').exists, false);
  const duplicate = fixture(t, '[m]\n[m]\n');
  assert.throws(() => duplicate.store().get('m'), { status: 409, message: 'Duplicate preset sections require operator repair' });
  const big = fixture(t, 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => big.store().get('m'), { status: 413, message: 'Preset file exceeds the editor limit' });
  assert.equal(fixture(t, 'x'.repeat(1024 * 1024)).store().get('m').exists, false, 'exactly the limit is a file');
  const wide = fixture(t, '€'.repeat(Math.floor(1024 * 1024 / 3) + 1));
  assert.throws(() => wide.store().get('m'), { status: 413 }, 'the limit counts UTF-8 bytes');
  const linked = fixture(t);
  fs.symlinkSync(path.join(linked.dir, 'absent.ini'), linked.file);
  assert.throws(() => linked.store().get('m'), { status: 409, message: 'Preset path must be a regular file' });
  const dir = fixture(t);
  fs.mkdirSync(dir.file);
  assert.throws(() => dir.store().get('m'), { status: 409, message: 'Preset path must be a regular file' });
});

test('a native fault is an unavailable parser, never a silent JS parse', (t) => {
  const { store } = fixture(t, TEXT);
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  t.after(() => { console.warn = warn; });
  const bad = (name) => ({ [name]: () => { throw Object.assign(Error('synthetic'), { reason: 'trap' }); } });
  for (const [name, call] of [['llamacppPresetsFacts', (s) => s.get('m')], ['llamacppPresetsParse', (s) => s.snapshot()]]) {
    spied(t, bad(name));
    assert.throws(() => call(store()), { status: 503, message: 'Preset state is unavailable. Try again shortly.' });
  }
  // A fault word the reader does not know is a fault too, not a partial answer.
  spied(t, { llamacppPresetsFacts: () => ({ fault: 'bogus' }) });
  assert.throws(() => store().get('m'), { status: 503 });
  assert.ok(seen.every((m) => !m.includes('synthetic') && !m.includes('/private/')));
});

test('the runtime reads agree with the frozen JS oracle over the shared corpus', (t) => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/llamacpp-presets.v1.json'), 'utf8'));
  const { file } = fixture(t, '');
  const ours = runtime.createPresetStore(file, { cacheRam: LIMITS }), theirs = reference.createPresetStore(file, { cacheRam: LIMITS });
  const outcome = (fn) => { try { return { value: JSON.stringify(fn()) }; } catch (e) { return { status: e.status, message: e.message }; } };
  let rows = 0, faults = 0;
  for (const row of fixtures.rows) {
    if (row.op !== 6) continue;
    const [text, model] = JSON.parse(row.wire);
    fs.writeFileSync(file, text);
    const want = outcome(() => theirs.get(model));
    assert.deepEqual(outcome(() => ours.get(model)), want, `${JSON.stringify(text)} ${JSON.stringify(model)}`);
    if (want.status) faults++;
    else assert.equal(outcome(() => ours.snapshot()).value, outcome(() => theirs.snapshot()).value);
    rows++;
  }
  assert.ok(rows > 3000 && faults > 0, `${rows} rows, ${faults} faults`);
});

test('the source keeps no second parser: no section or option pattern, no field table', () => {
  const source = fs.readFileSync(path.join(__dirname, 'llamacpp-presets.cjs'), 'utf8');
  for (const gone of ['\\[([^\\]\\r\\n]+)\\]', '([^=\\s]+)\\s*=', 'LLAMA_ARG_CTX_SIZE', 'createHash', 'const fields=', 'const canonical=']) {
    assert.ok(!source.includes(gone), `${gone} is still in llamacpp-presets.cjs`);
  }
  assert.equal(typeof dav.llamacppPresetsParse, 'function');
  assert.equal(typeof dav.llamacppPresetsFacts, 'function');
});
