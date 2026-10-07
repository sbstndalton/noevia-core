'use strict';
// SANDBOX_BRIDGE_IMPL=rust (#999): sandbox-bridge.wasm against the JS references, on the shared
// fixtures, on seeded random input, inside a live bridge and supervisor, and failing closed.
// Needs code-sandbox/wasm/sandbox-bridge.wasm (or SANDBOX_BRIDGE_WASM); skipped without it unless
// SANDBOX_BRIDGE_WASM_REQUIRED=1 (CI sets it, after building the module at the pinned ref).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createBridge, lines, toolCallFor } = require('./pi-acp-bridge.cjs');
const { createSupervisor, insideRoot, containedJs, parseStartJs } = require('./supervisor.cjs');
const sb = require('./sandbox-bridge-wasm.cjs');

const wasmFile = process.env.SANDBOX_BRIDGE_WASM || sb.DEFAULT_WASM;
const available = fs.existsSync(wasmFile);
if (!available && process.env.SANDBOX_BRIDGE_WASM_REQUIRED === '1') throw new Error(`sandbox-bridge.wasm is required but missing at ${wasmFile}`);
const skip = available ? false : 'sandbox-bridge.wasm not built (tools/build-sandbox-bridge-wasm.sh in noevia-rs)';

// The fixture table sits at the repo root's tests/fixtures (core checkout) or apps/web/tests/fixtures
// (the noevia-shaped CI workspace, where this directory is services/code-sandbox).
const FIXTURES = [path.join(__dirname, '../tests/fixtures/sandbox-bridge.v1.json'), path.join(__dirname, '../../apps/web/tests/fixtures/sandbox-bridge.v1.json')]
  .find((f) => fs.existsSync(f));
const fixtures = FIXTURES ? JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) : null;

/** Run a framer over chunks: per chunk `{ messages }` or `{ overflow }`. */
function frameWith(make, limit, chunks) {
  const events = [];
  const push = make((m) => events[events.length - 1].messages.push(m), (size) => { events[events.length - 1] = { overflow: size }; }, limit);
  for (const c of chunks) { events.push({ messages: [] }); push(c); }
  push.free?.();
  return events;
}
/** Deep equality that survives 2000-level nesting (assert.deepEqual recurses), keeping -0 apart. */
const same = (a, b, msg) => {
  const enc = (v) => JSON.stringify(v, (k, x) => (Object.is(x, -0) ? '-0' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : x));
  assert.equal(enc(a), enc(b), msg);
};
const rustFrame = (onLine, onOverflow, limit) => sb.linesRust(onLine, onOverflow, limit, (err) => { throw err; });
/** toolCallFor's outcome as the wire sees it, or the error class. */
const wire = (fn, payload) => { try { return { json: JSON.stringify(fn(payload)) }; } catch (err) { return { error: err.constructor.name }; } };

let seed = 0x999f;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rand() * a.length)];

test('the fixture table is present and big enough', { skip: !FIXTURES && 'no fixture table' }, () => {
  assert.equal(fixtures.version, 1);
  assert.ok(fixtures.frame.length >= 300 && fixtures.toolCall.length >= 400 && fixtures.start.length >= 200 && fixtures.contained.length >= 500);
});

test('framing: every fixture, JS and Rust agree (and match the table)', { skip: skip || (!FIXTURES && 'no fixtures') }, () => {
  for (const c of fixtures.frame) {
    const js = frameWith(lines, c.limit, c.chunks);
    const rust = frameWith(rustFrame, c.limit, c.chunks);
    same(rust, js, c.name);
    const table = c.expect.map((e) => (e.overflow !== undefined ? { overflow: e.overflow } : { messages: e.lines.map((l) => JSON.parse(l)) }));
    same(rust, table, c.name);
  }
});

test('toolCallFor: every fixture, identical on the wire', { skip: skip || (!FIXTURES && 'no fixtures') }, () => {
  for (const c of fixtures.toolCall) {
    const payload = JSON.parse(c.payload);
    const rust = wire(sb.toolCallForRust, payload);
    assert.deepEqual(rust, wire(toolCallFor, payload), c.name);
    assert.deepEqual(rust, c.expect.json !== undefined ? { json: c.expect.json } : { error: c.expect.error === 'type_error' ? 'TypeError' : c.expect.error }, c.name);
  }
});

test('start line and containment: every fixture', { skip: skip || (!FIXTURES && 'no fixtures') }, () => {
  for (const c of fixtures.start) {
    assert.equal(JSON.stringify(sb.parseStartRust(c.line)), c.expect, c.name);
    assert.equal(JSON.stringify(sb.parseStartRust(c.line)), JSON.stringify(parseStartJs(c.line)), c.name);
  }
  for (const c of fixtures.contained) {
    assert.equal(sb.containedRust(c.root, c.resolved), c.expect.contained, c.name);
    assert.equal(containedJs(c.root, c.resolved), c.expect.contained, c.name);
  }
});

test('seeded random: framing, toolCallFor, start and containment agree live', { skip }, () => {
  const pieces = ['{"type":"x"}', '{"a":[1,{"b":null}]}', '"s"', '-0.5e3', '[', ']', '{', '}', ',', '"', '\\', '\\ud800', 'true', '\n', '\r',
    '\r\n', ' ', ' ', '﻿', 'é', '😀', ' ', '{"__proto__":1}', '{"k":1,"k":2}', '01', '1e400', '{"t":"\u0001"}'];
  for (let n = 0; n < 1500; n++) {
    let text = '';
    for (let i = 1 + Math.floor(rand() * 40); i > 0; i--) text += pick(pieces);
    const chunks = [];
    for (let at = 0; at < text.length;) {
      let len = 1 + Math.floor(rand() * 16);
      if (/[\ud800-\udbff]/.test(text[at + len - 1] || '')) len++;
      chunks.push(text.slice(at, at + len)); at += len;
    }
    const limit = pick([4, 16, 64, 16 * 1024 * 1024]);
    same(frameWith(rustFrame, limit, chunks), frameWith(lines, limit, chunks), JSON.stringify({ limit, chunks }));
  }
  const scalars = [null, true, false, 0, -0, 1, 2.5, 1e21, 1e-7, '', 'bash', 'read', 'write', 'ls', 'toString', 'constructor', '__proto__', 'é😀', '/abs', 'a/b'];
  const keys = ['toolName', 'toolCallId', 'input', 'outsideWorkspace', 'path', 'file_path', 'command', 'noeviaOutsideWorkspace', '__proto__', '0', '7', 'x', 'toString'];
  const value = (d) => {
    const r = rand();
    if (d > 3 || r < 0.5) return pick(scalars);
    if (r < 0.7) return Array.from({ length: Math.floor(rand() * 4) }, () => value(d + 1));
    let text = '{';
    for (let i = Math.floor(rand() * 5); i > 0; i--) text += `${text.length > 1 ? ',' : ''}${JSON.stringify(pick(keys))}:${JSON.stringify(value(d + 1))}`;
    return JSON.parse(text + '}');
  };
  for (let n = 0; n < 3000; n++) {
    let text = '{';
    for (let i = Math.floor(rand() * 6); i > 0; i--) {
      const k = rand() < 0.7 ? pick(['toolName', 'toolCallId', 'input', 'outsideWorkspace']) : pick(keys);
      const v = k === 'outsideWorkspace' && rand() < 0.6 ? true : k === 'toolName' && rand() < 0.6 ? pick(['bash', 'read', 'edit', 'grep', 'valueOf']) : value(1);
      text += `${text.length > 1 ? ',' : ''}${JSON.stringify(k)}:${JSON.stringify(v)}`;
    }
    const payload = JSON.parse(text + '}');
    assert.deepEqual(wire(sb.toolCallForRust, payload), wire(toolCallFor, payload), text);
    const line = JSON.stringify({ noevia: rand() < 0.8 ? 'start' : value(1), cwd: value(1), env: value(1) });
    assert.equal(JSON.stringify(sb.parseStartRust(line)), JSON.stringify(parseStartJs(line)), line);
  }
  const segs = ['w', 'a', '.', '..', '...', '..x', 'x.', '', 'é', 'é', '😀', '\\', ' ', '%2e'];
  const mk = () => { let p = ''; for (let i = 1 + Math.floor(rand() * 5); i > 0; i--) p += '/' + pick(segs); return p; };
  for (let n = 0; n < 5000; n++) {
    const root = mk(), resolved = rand() < 0.5 ? root + mk() : mk();
    assert.equal(sb.containedRust(root, resolved), containedJs(root, resolved), `${root} ${resolved}`);
  }
});

test('a huge line overflows at the same size, at the default 16 MiB limit', { skip }, () => {
  const big = 'x'.repeat(16 * 1024 * 1024 + 1);
  for (const chunks of [['{"a":1}\n{"b"', big, '\n{"c":2}\n'], ['{"a":"', 'y'.repeat(8 * 1024 * 1024), 'z'.repeat(8 * 1024 * 1024 + 5), '"}\n{"d":3}\n']]) {
    assert.deepEqual(frameWith(rustFrame, undefined, chunks), frameWith(lines, undefined, chunks));
  }
});

test('a Buffer chunk is coerced as JS does; a lone surrogate fails closed', { skip }, () => {
  const buf = Buffer.from('{"a":"é"}\n');
  assert.deepEqual(frameWith(rustFrame, 64, [buf]), frameWith(lines, 64, [buf]));
  const failures = [];
  const push = sb.linesRust(() => assert.fail('nothing is delivered'), () => {}, 64, (err) => failures.push(err));
  push('{"a":"\ud800"}\n');
  push('{"b":1}\n'); // dead after a failure: nothing more is framed
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof sb.SandboxBridgeError);
  assert.equal(failures[0].message, sb.FAILED);
});

test('toolCallFor: the one in-process difference is a function-valued kind, absent on the wire', { skip }, () => {
  const payload = { toolName: 'constructor', input: {} };
  assert.equal(typeof toolCallFor(payload).kind, 'function');
  assert.equal(sb.toolCallForRust(payload).kind, undefined);
  assert.equal(JSON.stringify(sb.toolCallForRust(payload)), JSON.stringify(toolCallFor(payload)));
  assert.throws(() => sb.toolCallForRust({ toolName: { toString: 1 } }), TypeError);
  assert.throws(() => toolCallFor({ toolName: { toString: 1 } }), TypeError);
});

// ---- the bridge under SANDBOX_BRIDGE_IMPL=rust ----
function fakePi() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { writable: true, writes: [], write(s) { this.writes.push(s); } };
  child.kill = () => {};
  return child;
}
const flush = () => new Promise((r) => setImmediate(r));

/** Drive one scripted session and return everything the client and pi saw. */
async function session(bridgeImpl, piEvents, { clientAnswer = 'allow_once', raw = [] } = {}) {
  const child = fakePi();
  const toBridge = new PassThrough(), fromBridge = new PassThrough();
  const out = [];
  fromBridge.on('error', () => {});
  fromBridge.on('data', (chunk) => { for (const l of chunk.toString('utf8').split('\n')) if (l.trim()) out.push(JSON.parse(l)); });
  createBridge({ input: toBridge, output: fromBridge, spawnFn: () => child, env: { HOME: '/task/home' }, askTimeoutMs: 200, bridgeImpl });
  const send = (m) => toBridge.write(JSON.stringify(m) + '\n');
  send({ id: 1, method: 'initialize', params: {} });
  send({ id: 2, method: 'session/new', params: { cwd: '/task' } });
  await flush();
  for (const r of raw) toBridge.write(r);
  await flush();
  for (const e of piEvents) { child.stdout.emit('data', typeof e === 'string' ? e : JSON.stringify(e) + '\n'); await flush(); }
  for (const m of out.filter((x) => x.method === 'session/request_permission')) {
    send({ id: m.id, result: { outcome: { outcome: 'selected', optionId: clientAnswer } } });
  }
  await new Promise((r) => setTimeout(r, 20));
  return { out, pi: child.stdin.writes.map((w) => JSON.parse(w)) };
}

const confirm = (id, payload) => ({ type: 'extension_ui_request', id, method: 'confirm', message: JSON.stringify(payload) });
const SCRIPT = [
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Looking.' } },
  { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/a.js' } },
  { type: 'tool_execution_end', toolCallId: 't1' },
  confirm('ui1', { noevia: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: { command: 'npm test' } }),
  confirm('ui2', { noevia: 'tool_call', toolCallId: 'c2', toolName: 'read', input: { path: '/etc/hosts' }, outsideWorkspace: true }),
  confirm('ui3', { noevia: 'other' }),
  { type: 'extension_ui_request', id: 'ui4', method: 'confirm', message: 'not json' },
  `${JSON.stringify(confirm('ui5', { noevia: 'tool_call', toolName: 'write', input: { file_path: 'b.txt' } })).slice(0, 25)}`,
  `${JSON.stringify(confirm('ui5', { noevia: 'tool_call', toolName: 'write', input: { file_path: 'b.txt' } })).slice(25)}\r\n\n  \n`,
];

test('a scripted session is identical under js and rust, approvals included', { skip }, async () => {
  for (const answer of ['allow_once', 'reject_once']) {
    const js = await session('js', SCRIPT, { clientAnswer: answer });
    const rust = await session('rust', SCRIPT, { clientAnswer: answer });
    assert.deepEqual(rust, js, answer);
    const answers = rust.pi.filter((m) => m.type === 'extension_ui_response');
    assert.deepEqual(answers.map((a) => [a.id, a.confirmed]),
      [['ui3', false], ['ui4', false], ['ui1', answer === 'allow_once'], ['ui2', answer === 'allow_once'], ['ui5', answer === 'allow_once']]);
  }
});

test('a Rust framing failure ends the session with one fixed message and refuses what is pending', { skip }, async () => {
  const { out, pi } = await session('rust', [confirm('ui1', { noevia: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } }),
    '{"type":"agent_settled","x":"\ud800"}\n'], { clientAnswer: 'never' });
  const err = out.find((m) => m.id === null && m.error);
  assert.equal(err.error.message, 'the sandbox bridge (rust) failed; closing the session');
  assert.ok(!pi.some((m) => m.type === 'extension_ui_response' && m.confirmed === true), 'nothing was allowed');
});

test('a payload JS cannot coerce throws the same TypeError under both, and is never a permission', { skip }, async () => {
  // In JS this TypeError escapes onUiRequest as an unhandled rejection (in production the bridge
  // process exits and the supervisor stops pi's group). Rust mode must do exactly the same.
  const seen = {};
  for (const impl of ['js', 'rust']) {
    const rejections = [];
    const listeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (err) => rejections.push(err));
    try {
      const { out, pi } = await session(impl, [confirm('ui1', { noevia: 'tool_call', toolName: { toString: 1 } })]);
      assert.ok(!out.some((m) => m.method === 'session/request_permission'), impl);
      assert.ok(!pi.some((m) => m.confirmed === true), impl);
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const l of listeners) process.on('unhandledRejection', l);
    }
    seen[impl] = rejections.map((e) => `${e.constructor.name}: ${e.message}`);
  }
  assert.deepEqual(seen.rust, seen.js);
  assert.deepEqual(seen.js, ['TypeError: Cannot convert object to primitive value']);
});

// ---- failing closed when the module is unusable ----
test('a missing or mismatched module refuses to load, with the fixed message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sbw-'));
  try {
    assert.throws(() => sb.load({ file: path.join(dir, 'none.wasm'), expectedSha256: '0'.repeat(64) }), (e) => e instanceof sb.SandboxBridgeError && e.reason === 'missing' && e.message === sb.FAILED);
    fs.writeFileSync(path.join(dir, 'x.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    assert.throws(() => sb.load({ file: path.join(dir, 'x.wasm'), expectedSha256: '0'.repeat(64) }), (e) => e.reason === 'checksum');
    const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, 'x.wasm'))).digest('hex');
    assert.throws(() => sb.load({ file: path.join(dir, 'x.wasm'), expectedSha256: sha }), (e) => e.reason === 'abi', 'an empty module lacks the ABI');
    assert.throws(() => sb.load({ file: path.join(dir, 'x.wasm'), expectedSha256: 'not-a-sha' }), (e) => e.reason === 'lock');
    const lock = sb.readLock();
    assert.match(lock.SANDBOX_BRIDGE_WASM_SHA256, /^[0-9a-f]{64}$/);
    assert.match(lock.NOEVIA_RS_REF, /^[0-9a-f]{40}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('with no usable module, the bridge will not start and the supervisor refuses every connection', async () => {
  const saved = process.env.SANDBOX_BRIDGE_WASM;
  process.env.SANDBOX_BRIDGE_WASM = path.join(os.tmpdir(), 'noevia-no-such-sandbox-bridge.wasm');
  sb._reset();
  try {
    assert.throws(() => createBridge({ input: new PassThrough(), output: new PassThrough(), bridgeImpl: 'rust' }), sb.SandboxBridgeError);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sbw-root-'));
    const spawned = [];
    const logs = [];
    const sup = createSupervisor({ command: 'agent', root, bridgeImpl: 'rust', log: (l) => logs.push(l), spawnFn: () => { spawned.push(1); return fakePi(); } });
    const { port } = await sup.listen(0, '127.0.0.1');
    const reply = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(JSON.stringify({ noevia: 'start', cwd: root, env: {} }) + '\n'));
      let data = ''; s.setEncoding('utf8'); s.on('data', (d) => { data += d; }); s.on('close', () => resolve(data)); s.on('error', () => {});
    });
    await sup.close();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(spawned.length, 0, 'nothing was started');
    assert.equal(JSON.parse(reply).error.message, 'the sandbox bridge is unavailable');
  } finally {
    if (saved === undefined) delete process.env.SANDBOX_BRIDGE_WASM; else process.env.SANDBOX_BRIDGE_WASM = saved;
    sb._reset();
  }
});

test('as processes: with rust and no module, the supervisor exits non-zero and the bridge answers one error', () => {
  const { spawnSync } = require('node:child_process');
  const missing = path.join(os.tmpdir(), 'noevia-no-such-sandbox-bridge.wasm');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sbw-root-'));
  try {
    const sup = spawnSync(process.execPath, [path.join(__dirname, 'supervisor.cjs')], { timeout: 10000, encoding: 'utf8',
      env: { PATH: process.env.PATH, CODE_HARNESS_COMMAND: 'true', WORKSPACE_ROOT: root, PORT: '0', SANDBOX_BRIDGE_IMPL: 'rust', SANDBOX_BRIDGE_WASM: missing } });
    assert.equal(sup.status, 2, sup.stderr);
    assert.match(sup.stderr, /SANDBOX_BRIDGE_IMPL=rust but sandbox-bridge\.wasm is unavailable/);
    const bridge = spawnSync(process.execPath, [path.join(__dirname, 'pi-acp-bridge.cjs')], { timeout: 10000, encoding: 'utf8', input: '',
      env: { PATH: process.env.PATH, HOME: root, SANDBOX_BRIDGE_IMPL: 'rust', SANDBOX_BRIDGE_WASM: missing } });
    assert.equal(bridge.status, 1);
    assert.equal(JSON.parse(bridge.stdout.trim()).error.message, 'the sandbox bridge (rust) failed; closing the session');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- the supervisor under SANDBOX_BRIDGE_IMPL=rust ----
test('insideRoot with the Rust decision: realpaths in JS, symlinks included', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sbw-root-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sbw-out-'));
  try {
    fs.mkdirSync(path.join(root, 'task-1'));
    fs.mkdirSync(path.join(root, '..x'));
    fs.symlinkSync(outside, path.join(root, 'escape'));
    for (const c of [path.join(root, 'task-1'), root, outside, path.join(root, 'escape'), path.join(root, 'nope'), '/etc', '', path.join(root, '..x'),
      path.join(root, 'task-1', '..', '..'), `${root}/task-1/./`]) {
      assert.equal(insideRoot(root, c, sb.containedRust), insideRoot(root, c), c);
    }
    assert.equal(insideRoot(root, path.join(root, 'escape'), sb.containedRust), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('the rust supervisor starts the agent like js does and hands it the flag', { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sbw-root-'));
  fs.mkdirSync(path.join(root, 't1'));
  const runs = {};
  try {
    for (const impl of ['js', 'rust']) {
      const calls = [];
      const sup = createSupervisor({ command: 'agent', args: ['acp'], root, bridgeImpl: impl, log: () => {},
        spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts.cwd, env: opts.env }); const c = fakePi(); c.stdin = new PassThrough(); return c; } });
      const { port } = await sup.listen(0, '127.0.0.1');
      for (const line of [JSON.stringify({ noevia: 'start', cwd: path.join(root, 't1'), env: { HOME: '/h', SECRET: 'x', PATH: '/p' } }),
        JSON.stringify({ noevia: 'start', cwd: path.join(root, 't1', '..', '..') }), 'nope', '{"noevia":"start","cwd":{"toString":1}}']) {
        await new Promise((resolve) => {
          const s = net.connect(port, '127.0.0.1', () => s.write(line + '\n'));
          s.on('data', () => {}); s.on('error', () => {}); s.on('close', resolve);
          setTimeout(() => { s.destroy(); resolve(); }, 300).unref();
        });
      }
      await sup.close();
      runs[impl] = calls;
    }
    assert.equal(runs.js.length, 1);
    assert.deepEqual(runs.rust.map(({ env, ...rest }) => rest), runs.js.map(({ env, ...rest }) => rest));
    assert.deepEqual(runs.js[0].env, { HOME: '/h', PATH: '/p' });
    assert.deepEqual(runs.rust[0].env, { HOME: '/h', PATH: '/p', SANDBOX_BRIDGE_IMPL: 'rust' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SANDBOX_BRIDGE_IMPL: js by default, rust on request, anything else js with a warning', () => {
  const warned = [];
  assert.equal(sb.resolveImpl(undefined), 'js');
  assert.equal(sb.resolveImpl(''), 'js');
  assert.equal(sb.resolveImpl('js'), 'js');
  assert.equal(sb.resolveImpl('rust'), 'rust');
  assert.equal(sb.resolveImpl('RUST', (w) => warned.push(w)), 'js');
  assert.equal(warned.length, 1);
});
