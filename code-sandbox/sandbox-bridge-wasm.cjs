'use strict';
// Loader for sandbox-bridge.wasm (#999): the Rust port of the code sandbox's untrusted-input
// handling, behind SANDBOX_BRIDGE_IMPL=js|rust (default js; any other value means js, with one
// warning). Built from sbstndalton/noevia-rs (bins/sandbox-bridge-wasm, crates/sandbox-bridge) at
// the ref in code-sandbox/sandbox-bridge.lock and placed at code-sandbox/wasm/sandbox-bridge.wasm by
// the image build (or SANDBOX_BRIDGE_WASM). Node's built-in WebAssembly runs it in-process: no
// imports, no WASI, no native addon, no child process.
//
//   linesRust       = pi-acp-bridge.cjs lines()        (the agent's and the client's JSONL framing)
//   toolCallForRust = pi-acp-bridge.cjs toolCallFor()
//   parseStartRust  = supervisor.cjs parseStartJs()    (the connection's first line)
//   containedRust   = supervisor.cjs containedJs()     (insideRoot's decision; realpath stays in JS:
//                                                       symlinks are the filesystem's, not the string's)
//
// Why WebAssembly and not a CLI like model-files/docx-text: framing runs once per stream chunk and
// toolCallFor once per tool call, inside the bridge process. A process per chunk would cost
// milliseconds per message; a long-lived child would need its own framing and protocol, i.e. the
// very parser being ported, in front of it. A module in-process has neither problem.
//
// Framing state (the partial line) lives in the module's memory, so a bridge holds one instance
// for its whole life. Each framing state is capped at the 16 MiB line limit (as in JS), and memory
// only grows: a bridge that saw a near-limit line keeps ~64 MiB+ of linear memory until it exits.
//
// Everything fails closed with fixed messages. The module must match the pinned sha256, import
// nothing and export exactly the ABI below; a missing module, a trap, a reply of the wrong shape
// or a disagreement JS can detect (a line the module passed that JSON.parse refuses) throws a
// SandboxBridgeError, and the callers end the session or refuse the connection. Nothing falls back
// to the JS implementation, and no failure can turn into a permission.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCK_FILE = path.join(__dirname, 'sandbox-bridge.lock');
const DEFAULT_WASM = path.join(__dirname, 'wasm', 'sandbox-bridge.wasm');
const DEFAULT_LIMIT = 16 * 1024 * 1024;
// sandbox_bridge_wasm::MAX_INPUT_BYTES: a chunk of at most DEFAULT_LIMIT UTF-16 units as UTF-8.
const MAX_INPUT_BYTES = 3 * 16 * 1024 * 1024 + 16;
const EXPORTS = ['memory', 'sb_input', 'sb_frame_new', 'sb_frame_push', 'sb_frame_reset', 'sb_frame_free',
  'sb_tool_call', 'sb_start', 'sb_contained', 'sb_output_ptr', 'sb_output_len'];
// The one message every failure carries (the reason is a code on the error, never input text).
const FAILED = 'the sandbox bridge (rust) failed';

class SandboxBridgeError extends Error {
  constructor(reason) {
    super(FAILED);
    this.name = 'SandboxBridgeError';
    this.code = 'sandbox_bridge_failed';
    this.reason = reason;
  }
}

function readLock(file = LOCK_FILE) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(\S+)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

let cached = null; // { module, instance, generation } or { error }
let generation = 0;

function load({ file = process.env.SANDBOX_BRIDGE_WASM || DEFAULT_WASM, expectedSha256 } = {}) {
  let expected = expectedSha256;
  if (expected === undefined) {
    try { expected = readLock().SANDBOX_BRIDGE_WASM_SHA256; } catch { throw new SandboxBridgeError('lock'); }
  }
  if (!/^[0-9a-f]{64}$/.test(String(expected || ''))) throw new SandboxBridgeError('lock');
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { throw new SandboxBridgeError('missing'); }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new SandboxBridgeError('checksum');
  let module;
  try { module = new WebAssembly.Module(bytes); } catch { throw new SandboxBridgeError('compile'); }
  if (WebAssembly.Module.imports(module).length) throw new SandboxBridgeError('abi');
  const names = WebAssembly.Module.exports(module).map((e) => e.name);
  if (EXPORTS.some((n) => !names.includes(n))) throw new SandboxBridgeError('abi');
  return { module, instance: null };
}

/** The live instance (loading the module once per process); throws a SandboxBridgeError. */
function ensure() {
  if (!cached) {
    try { cached = load(); } catch (err) { cached = { error: err }; }
  }
  if (cached.error) throw cached.error;
  if (!cached.instance) {
    try { cached.instance = new WebAssembly.Instance(cached.module, {}); } catch { throw new SandboxBridgeError('instantiate'); }
    generation++;
  }
  return cached.instance;
}

/** Test hook: forget the module (so a test can point SANDBOX_BRIDGE_WASM elsewhere). */
function _reset() { cached = null; }

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function utf8(bytes) {
  try { return decoder.decode(bytes); } catch { throw new SandboxBridgeError('reply'); }
}

/** Write `input`, run `call(exports)`, return `{ status, bytes }`; a trap drops the instance. */
function invokeRaw(input, call) {
  if (input.length > MAX_INPUT_BYTES) throw new SandboxBridgeError('too_large');
  const wasm = ensure();
  try {
    const { exports } = wasm;
    const ptr = exports.sb_input(input.length) >>> 0;
    if (!ptr && input.length) throw new SandboxBridgeError('too_large');
    new Uint8Array(exports.memory.buffer, ptr, input.length).set(input);
    const status = call(exports) >>> 0;
    const outPtr = exports.sb_output_ptr() >>> 0, outLen = exports.sb_output_len() >>> 0;
    return { status, bytes: new Uint8Array(exports.memory.buffer, outPtr, outLen).slice() };
  } catch (err) {
    // A trap leaves the instance (and every framing state in it) unusable: start over, and let
    // framers created on the old one notice through `generation`.
    if (cached) cached.instance = null;
    if (err instanceof SandboxBridgeError) throw err;
    throw new SandboxBridgeError('trap');
  }
}

function jsonReply(bytes) {
  try { return JSON.parse(utf8(bytes)); } catch { throw new SandboxBridgeError('reply'); }
}

// A framing state the JS side dropped is freed in the module too (a bridge holds two for its life;
// this is for everything else, e.g. tests). Only on the instance it was created on.
const framers = new FinalizationRegistry(({ handle, born }) => { freeFramer(handle, born); });
function freeFramer(handle, born) {
  if (!handle || born !== generation || !cached?.instance) return;
  try { cached.instance.exports.sb_frame_free(handle); } catch { /* the instance is gone with it */ }
}

/**
 * pi-acp-bridge.cjs lines(), through the module. Same contract, plus `onFail(error)`: called once
 * with a SandboxBridgeError when the module fails (after which this framer drops everything), and
 * `push.free()` to release the framing state early (also done when the closure is collected).
 * Chunks are text (the bridge's streams are setEncoding('utf8')); a Buffer is coerced as JS's
 * `buffer += chunk` would. A string holding a lone surrogate (never produced by a utf8 stream)
 * cannot cross into Rust unchanged, so it fails closed.
 */
function linesRust(onLine, onOverflow = () => {}, limit = DEFAULT_LIMIT, onFail = (err) => { throw err; }) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 0xffffffff) throw new SandboxBridgeError('input');
  let handle = 0, born = -1, dead = false;
  const token = {};
  const free = () => { if (handle) { framers.unregister(token); freeFramer(handle, born); handle = 0; } };
  const push = (chunk) => {
    if (dead) return;
    const messages = [];
    try {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      if (!text.isWellFormed()) throw new SandboxBridgeError('input');
      const { exports } = ensure();
      if (!handle) {
        handle = exports.sb_frame_new(limit) >>> 0;
        born = generation;
        if (!handle) throw new SandboxBridgeError('framers');
        framers.register(push, { handle, born }, token);
      }
      if (born !== generation) throw new SandboxBridgeError('lost_state');
      if (text.length > limit) {
        // This chunk overflows by itself; the module only has to say what it was holding.
        const held = exports.sb_frame_reset(handle) >>> 0;
        if (held === 0xffffffff) throw new SandboxBridgeError('handle');
        onOverflow(held + text.length);
        return;
      }
      const { status, bytes } = invokeRaw(encoder.encode(text), (e) => e.sb_frame_push(handle));
      if (born !== generation) throw new SandboxBridgeError('lost_state');
      if (status === 1) {
        if (bytes.length !== 4) throw new SandboxBridgeError('reply');
        onOverflow(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true));
        return;
      }
      if (status !== 0) throw new SandboxBridgeError('refused');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let at = 0; at < bytes.length;) {
        if (at + 4 > bytes.length) throw new SandboxBridgeError('reply');
        const len = view.getUint32(at, true); at += 4;
        if (at + len > bytes.length) throw new SandboxBridgeError('reply');
        const line = utf8(bytes.subarray(at, at + len)); at += len;
        // JS itself parses each line, so a message's value is the JS one by construction. A line the
        // module passed but JSON.parse refuses is a disagreement: fail, never guess.
        try { messages.push(JSON.parse(line)); } catch { throw new SandboxBridgeError('disagreement'); }
      }
    } catch (err) {
      dead = true;
      free();
      onFail(err instanceof SandboxBridgeError ? err : new SandboxBridgeError('trap'));
      return;
    }
    for (const message of messages) onLine(message);
  };
  push.free = () => { dead = true; free(); };
  return push;
}

/**
 * The payload as JSON text for the module. JSON.stringify would turn Infinity (what JSON.parse makes
 * of `1e400`) into null and -0 into 0, and toolCallFor sees the difference (`String(Infinity)`), so
 * numbers are written as lexemes that parse back to the same value. Everything else is
 * JSON.stringify's own rules (own enumerable keys in order; undefined and functions skipped in
 * objects, null in arrays). A payload too deep to walk fails closed.
 */
function encodePayload(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'number') {
      out.push(Object.is(v, -0) ? '-0' : v === Infinity ? '1e400' : v === -Infinity ? '-1e400' : Number.isNaN(v) ? 'null' : String(v));
    } else if (typeof v === 'string' || typeof v === 'boolean' || v === null) {
      out.push(JSON.stringify(v));
    } else if (typeof v === 'bigint') {
      throw new SandboxBridgeError('input');
    } else if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
      out.push('null'); // only reached inside an array: object members like these are skipped below
    } else if (Array.isArray(v)) {
      out.push('[');
      v.forEach((item, i) => { if (i) out.push(','); walk(item); });
      out.push(']');
    } else {
      out.push('{');
      let first = true;
      for (const key of Object.keys(v)) {
        const item = v[key];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        if (!first) out.push(',');
        first = false;
        out.push(JSON.stringify(key), ':');
        walk(item);
      }
      out.push('}');
    }
  };
  try { walk(value); } catch { throw new SandboxBridgeError('input'); }
  return out.join('');
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * pi-acp-bridge.cjs toolCallFor(), through the module. Where JS throws a TypeError (coercing an
 * object with an own `toString`), so does this; every other failure is a SandboxBridgeError.
 * One visible difference in-process only: for a tool named after an Object.prototype method JS
 * returns `kind` as that function, this omits `kind`; JSON.stringify (the wire) is identical.
 */
function toolCallForRust(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new SandboxBridgeError('input');
  const text = encodePayload(payload);
  const { status, bytes } = invokeRaw(encoder.encode(text), (e) => e.sb_tool_call());
  const reply = jsonReply(bytes);
  if (status === 1 && reply && reply.error === 'type_error') throw new TypeError('Cannot convert object to primitive value');
  if (status !== 0 || !isObject(reply) || typeof reply.toolCallId !== 'string' || typeof reply.title !== 'string'
    || !(reply.rawInput !== null && typeof reply.rawInput === 'object')
    || !(reply.kind === undefined || typeof reply.kind === 'string' || isObject(reply.kind))
    || !(reply.locations === undefined || Array.isArray(reply.locations))) throw new SandboxBridgeError('reply');
  return reply;
}

/** supervisor.cjs parseStartJs(), through the module. */
function parseStartRust(line) {
  const text = String(line);
  if (!text.isWellFormed()) throw new SandboxBridgeError('input');
  const { status, bytes } = invokeRaw(encoder.encode(text), (e) => e.sb_start());
  const reply = jsonReply(bytes);
  if (status !== 0 || !isObject(reply) || typeof reply.start !== 'boolean') throw new SandboxBridgeError('reply');
  if (!reply.start) return { start: false };
  if (!(reply.cwd === null || typeof reply.cwd === 'string') || !isObject(reply.env)
    || Object.values(reply.env).some((v) => typeof v !== 'string')) throw new SandboxBridgeError('reply');
  return { start: true, cwd: reply.cwd, env: reply.env };
}

/** supervisor.cjs containedJs(), through the module (both arguments are real paths). */
function containedRust(resolvedRoot, resolved) {
  const a = String(resolvedRoot), b = String(resolved);
  if (!a.isWellFormed() || !b.isWellFormed()) throw new SandboxBridgeError('input');
  const ea = encoder.encode(a), eb = encoder.encode(b);
  const input = new Uint8Array(4 + ea.length + eb.length);
  new DataView(input.buffer).setUint32(0, ea.length, true);
  input.set(ea, 4);
  input.set(eb, 4 + ea.length);
  const { status, bytes } = invokeRaw(input, (e) => e.sb_contained());
  const reply = jsonReply(bytes);
  if (status !== 0 || !isObject(reply) || typeof reply.contained !== 'boolean') throw new SandboxBridgeError('reply');
  return reply.contained;
}

/** `rust` or `js` from the flag's value; anything else is js, with one warning through `warn`. */
function resolveImpl(raw, warn = () => {}) {
  if (raw === undefined || raw === '' || raw === 'js') return 'js';
  if (raw === 'rust') return 'rust';
  warn(`SANDBOX_BRIDGE_IMPL=${JSON.stringify(String(raw))} is not js or rust; using js`);
  return 'js';
}

module.exports = { linesRust, toolCallForRust, encodePayload, parseStartRust, containedRust, resolveImpl, ensure, load, readLock,
  SandboxBridgeError, FAILED, DEFAULT_WASM, LOCK_FILE, _reset };
