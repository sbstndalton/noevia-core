'use strict';

// Loader for dav-parse.wasm (#967): the Rust port of dav-listing.cjs's listingRecordsJs, built
// from sbstndalton/noevia-rs (crates/dav-parse, bins/dav-parse-wasm) at the ref in
// server/dav-parse.lock and placed at server/wasm/dav-parse.wasm by the image build (or
// DAV_PARSE_WASM). Node's built-in WebAssembly runs it: no imports, no WASI, no native addon.
//
// Everything here fails closed. The module must match the pinned sha256, import nothing and
// export exactly the ABI below; a refusal, a trap or a reply of the wrong shape throws a
// DavParseError (status 502). Nothing falls back to the JS parser.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCK_FILE = path.join(__dirname, 'dav-parse.lock');
const DEFAULT_WASM = path.join(__dirname, 'wasm', 'dav-parse.wasm');
// URL + NUL + body; mirrors the module's own cap (dav_parse::MAX_BODY_BYTES + MAX_TARGET_BYTES + 1).
const MAX_INPUT_BYTES = 16 * 1024 * 1024 + 8 * 1024 + 1;
const EXPORTS = ['memory', 'dav_input', 'dav_list', 'dav_output_ptr', 'dav_output_len'];

class DavParseError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'DavParseError';
    this.status = 502;
    this.code = 'dav_parse_failed';
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

let cached = null; // { module, instance } or { error }

function load({ file = process.env.DAV_PARSE_WASM || DEFAULT_WASM, expectedSha256 } = {}) {
  let expected = expectedSha256;
  if (expected === undefined) {
    try { expected = readLock().DAV_PARSE_WASM_SHA256; } catch { throw new DavParseError('dav-parse lock file is unreadable', 'lock'); }
  }
  if (!/^[0-9a-f]{64}$/.test(String(expected || ''))) throw new DavParseError('dav-parse lock file has no wasm sha256', 'lock');
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { throw new DavParseError(`dav-parse module not found at ${file}`, 'missing'); }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new DavParseError(`dav-parse module sha256 ${actual} is not the pinned ${expected}`, 'checksum');
  let module;
  try { module = new WebAssembly.Module(bytes); } catch { throw new DavParseError('dav-parse module does not compile', 'compile'); }
  if (WebAssembly.Module.imports(module).length) throw new DavParseError('dav-parse module must not import anything', 'abi');
  const names = WebAssembly.Module.exports(module).map((e) => e.name);
  if (EXPORTS.some((n) => !names.includes(n))) throw new DavParseError('dav-parse module does not export the expected ABI', 'abi');
  return { module, instance: new WebAssembly.Instance(module, {}) };
}

function ensure() {
  if (!cached) {
    try { cached = load(); } catch (err) { cached = { error: err }; }
  }
  if (cached.error) throw cached.error;
  if (!cached.instance) cached.instance = new WebAssembly.Instance(cached.module, {});
  return cached.instance;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function validRecords(reply) {
  if (!reply || typeof reply !== 'object' || !Array.isArray(reply.entries)) return null;
  const out = [];
  for (const e of reply.entries) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name || e.name.includes('/')
      || typeof e.isDir !== 'boolean' || !(e.size === null || (typeof e.size === 'string' && /^\d+$/.test(e.size)))) return null;
    out.push({ name: e.name, isDir: e.isDir, size: e.size });
  }
  return out;
}

/** Same contract as dav-listing.cjs's listingRecordsJs, through the WebAssembly module. */
function listRecords(body, target) {
  if (typeof body !== 'string' || typeof target !== 'string') throw new DavParseError('dav-parse input must be text', 'input');
  if (target.includes('\0')) throw new DavParseError('dav-parse target must not contain NUL', 'input');
  const input = encoder.encode(`${target}\0${body}`);
  if (input.length > MAX_INPUT_BYTES) throw new DavParseError('storage listing is too large to check', 'too_large');
  const wasm = ensure();
  let status, text;
  try {
    const { exports } = wasm;
    const ptr = exports.dav_input(input.length) >>> 0;
    if (!ptr) throw new DavParseError('dav-parse refused the input size', 'too_large');
    new Uint8Array(exports.memory.buffer, ptr, input.length).set(input);
    status = exports.dav_list() >>> 0;
    const outPtr = exports.dav_output_ptr() >>> 0, outLen = exports.dav_output_len() >>> 0;
    text = decoder.decode(new Uint8Array(exports.memory.buffer, outPtr, outLen));
  } catch (err) {
    // A trap leaves the instance in an unknown state: start the next call from a fresh one.
    if (cached) cached.instance = null;
    if (err instanceof DavParseError) throw err;
    throw new DavParseError('dav-parse module failed', 'trap');
  }
  let reply;
  try { reply = JSON.parse(text); } catch { throw new DavParseError('dav-parse reply is not JSON', 'reply'); }
  if (status !== 0) {
    const code = reply && typeof reply.error === 'string' ? reply.error : 'unknown';
    throw new DavParseError(`storage listing refused by dav-parse (${code})`, code);
  }
  const records = validRecords(reply);
  if (!records) throw new DavParseError('dav-parse reply has an unexpected shape', 'reply');
  return records;
}

/** Test hook: forget the cached module (and its failure). */
function reset() { cached = null; }

module.exports = { listRecords, load, readLock, reset, DavParseError, DEFAULT_WASM, MAX_INPUT_BYTES };
