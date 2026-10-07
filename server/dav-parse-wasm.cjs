'use strict';

// Loader for dav-parse.wasm: noevia-rs's storage parsers in one module, built from
// sbstndalton/noevia-rs (bins/dav-parse-wasm) at the ref in server/dav-parse.lock and placed at
// server/wasm/dav-parse.wasm by the image build (or DAV_PARSE_WASM). Node's built-in WebAssembly
// runs it: no imports, no WASI, no native addon. It carries three Rust ports, each behind its own
// switch (default js):
//   - crates/dav-parse      listRecords  = dav-listing.cjs listingRecordsJs  (DAV_PARSE_IMPL, #967)
//   - crates/s3-list-parse  s3ListPage   = s3-listing.cjs s3PageRecordsJs    (S3_PARSE_IMPL, #976)
//   - crates/storage-path   storagePath  = storage-path.cjs's rules          (STORAGE_PATH_IMPL, #978)
//   - crates/upload-sniff   uploadValidate/uploadClassify/uploadDecode
//                                        = upload-sniff.cjs validate/classify/decodeText
//                                                                             (UPLOAD_SNIFF_IMPL, #977)
//
// Memory: WebAssembly memory only grows. A listing or path call needs at most ~16 MiB; an upload
// decode copies the upload in (at most 25 MiB) and holds one copy of its text (at most 3 bytes per
// input byte, so ~75 MiB), so one 25 MiB decode can leave the instance at ~100 MiB+. After any call
// whose input or reply passes RESET_AFTER_BYTES the instance is dropped (the compiled module stays
// cached, so the next call only re-instantiates, ~ms) and that memory is released to the GC.
//
// Everything here fails closed. The module must match the pinned sha256, import nothing and
// export exactly the ABI below; a refusal, a trap or a reply of the wrong shape throws a
// DavParseError (status 502). Nothing falls back to the JS parser.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCK_FILE = path.join(__dirname, 'dav-parse.lock');
const DEFAULT_WASM = path.join(__dirname, 'wasm', 'dav-parse.wasm');
// URL + NUL + body (dav_parse::MAX_BODY_BYTES + MAX_TARGET_BYTES + 1); each call's own cap.
const MAX_INPUT_BYTES = 16 * 1024 * 1024 + 8 * 1024 + 1;
// upload_sniff::MAX_DECODE_BYTES: the module-wide cap since #977, used only by uploadDecode.
const MAX_DECODE_BYTES = 25 * 1024 * 1024;
// Only the first bytes decide an archive magic number (`ustar` ends at 262).
const SNIFF_BYTES = 262;
const RESET_AFTER_BYTES = 1024 * 1024;
const EXPORTS = ['memory', 'dav_input', 'dav_list', 's3_list', 'storage_path', 'upload_validate', 'upload_classify', 'upload_decode', 'dav_output_ptr', 'dav_output_len'];

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
// Decoded upload text may itself start with U+FEFF (a BOM after the BOM); it must come back as is.
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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

/** The S3 page's records. Unlike a DAV listing, a directory (CommonPrefixes) name may hold '/'
 *  (the JS reference keeps a prefix outside the query prefix whole); a file name never does. */
function validS3Records(reply) {
  if (!Array.isArray(reply.entries)) return null;
  const out = [];
  for (const e of reply.entries) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name || typeof e.isDir !== 'boolean'
      || (!e.isDir && e.name.includes('/')) || !(e.size === null || (!e.isDir && typeof e.size === 'string' && /^\d+$/.test(e.size)))) return null;
    out.push({ name: e.name, isDir: e.isDir, size: e.size });
  }
  return out;
}

/** Write `input` into the module, run `call(exports)` and return `{ status, bytes }` (the reply
 *  bytes, copied out); a trap or a refusal of the size throws a DavParseError. */
function invokeRaw(input, call, max = MAX_INPUT_BYTES) {
  if (input.length > max) throw new DavParseError('storage input is too large to check', 'too_large');
  const wasm = ensure();
  let status, bytes;
  try {
    const { exports } = wasm;
    const ptr = exports.dav_input(input.length) >>> 0;
    if (!ptr) throw new DavParseError('dav-parse refused the input size', 'too_large');
    new Uint8Array(exports.memory.buffer, ptr, input.length).set(input);
    status = call(exports) >>> 0;
    const outPtr = exports.dav_output_ptr() >>> 0, outLen = exports.dav_output_len() >>> 0;
    bytes = new Uint8Array(exports.memory.buffer, outPtr, outLen).slice();
  } catch (err) {
    // A trap leaves the instance in an unknown state: start the next call from a fresh one.
    if (cached) cached.instance = null;
    if (err instanceof DavParseError) throw err;
    throw new DavParseError('dav-parse module failed', 'trap');
  }
  // Large calls leave the (never-shrinking) memory big: drop the instance, keep the module.
  if (cached && (input.length > RESET_AFTER_BYTES || bytes.length > RESET_AFTER_BYTES)) cached.instance = null;
  return { status, bytes };
}

function utf8(bytes, d = decoder) {
  try { return d.decode(bytes); } catch { throw new DavParseError('dav-parse reply is not UTF-8', 'reply'); }
}

/** invokeRaw with a JSON reply: `reply` on status 0; a refusal or non-JSON reply throws. */
function invoke(input, call, max) {
  const { status, bytes } = invokeRaw(input, call, max);
  const text = utf8(bytes);
  let reply;
  try { reply = JSON.parse(text); } catch { throw new DavParseError('dav-parse reply is not JSON', 'reply'); }
  if (status !== 0) {
    const code = reply && typeof reply.error === 'string' ? reply.error : 'unknown';
    throw new DavParseError(`storage input refused by dav-parse (${code})`, code);
  }
  return reply;
}

/** `u32le(len(a)) a b`: the framing s3_list and storage_path read. */
function framed(a, b) {
  const ea = encoder.encode(a), eb = encoder.encode(b);
  const out = new Uint8Array(4 + ea.length + eb.length);
  new DataView(out.buffer).setUint32(0, ea.length, true);
  out.set(ea, 4);
  out.set(eb, 4 + ea.length);
  return out;
}

/** Same contract as dav-listing.cjs's listingRecordsJs, through the WebAssembly module. */
function listRecords(body, target) {
  if (typeof body !== 'string' || typeof target !== 'string') throw new DavParseError('dav-parse input must be text', 'input');
  if (target.includes('\0')) throw new DavParseError('dav-parse target must not contain NUL', 'input');
  const reply = invoke(encoder.encode(`${target}\0${body}`), (e) => e.dav_list());
  const records = validRecords(reply);
  if (!records) throw new DavParseError('dav-parse reply has an unexpected shape', 'reply');
  return records;
}

/** Same contract as s3-listing.cjs's s3PageRecordsJs (#976), through the WebAssembly module. */
function s3ListPage(body, queryPrefix) {
  if (typeof body !== 'string' || typeof queryPrefix !== 'string') throw new DavParseError('s3 listing input must be text', 'input');
  // A lone surrogate cannot cross into Rust unchanged, and a changed prefix could strip the wrong keys.
  if (!queryPrefix.isWellFormed()) throw new DavParseError('s3 listing prefix is not well-formed text', 'input');
  const reply = invoke(framed(queryPrefix, body), (e) => e.s3_list());
  const records = reply && typeof reply === 'object' && typeof reply.truncated === 'boolean'
    && (reply.next === null || typeof reply.next === 'string') ? validS3Records(reply) : null;
  if (!records) throw new DavParseError('s3 listing reply has an unexpected shape', 'reply');
  return { records, truncated: reply.truncated, next: reply.next };
}

const PATH_OPS = { safeRelativePath: 1, cleanRoot: 2, joinRoot: 3, isPlainFilename: 4 };

/** One storage-path rule (#978) on strings `a` (and `b` for joinRoot), through the module: a
 *  string for the path rules, a boolean for isPlainFilename. */
function storagePath(op, a, b = '') {
  const code = PATH_OPS[op];
  if (!code) throw new DavParseError('unknown storage path rule', 'input');
  if (typeof a !== 'string' || typeof b !== 'string') throw new DavParseError('storage path input must be text', 'input');
  // A lone surrogate would come back as U+FFFD: a different path. Only the filename rule, whose
  // answer U+FFFD cannot change (same length, not a forbidden character), may take one.
  if (op !== 'isPlainFilename' && !(a.isWellFormed() && b.isWellFormed())) throw new DavParseError('storage path is not well-formed text', 'input');
  const reply = invoke(framed(a, b), (e) => e.storage_path(code));
  const value = reply && typeof reply === 'object' ? reply.value : undefined;
  if (typeof value !== (op === 'isPlainFilename' ? 'boolean' : 'string')) throw new DavParseError('storage path reply has an unexpected shape', 'reply');
  return value;
}

const GROUPS = new Set(['Documents', 'Images', 'Text', 'Other']);
const REFUSALS = new Map([['filename', 400], ['empty', 400], ['too_big', 413], ['archive', 400]]);
const UPLOAD_CAP = 25 * 1024 * 1024;

/** upload-sniff.cjs validateJs (#977), through the module: null when accepted, else
 *  `{ refusal: 'filename'|'empty'|'too_big'|'archive', status }`. Only what decides the answer
 *  crosses: the name (cut to 201 UTF-16 units: anything longer fails the 200-unit rule either way),
 *  the length (clamped to CAP + 1) and the first SNIFF_BYTES bytes. */
function uploadValidate(name, bytes) {
  if (typeof name !== 'string' || !(bytes instanceof Uint8Array)) throw new DavParseError('upload input has the wrong type', 'input');
  // A lone surrogate crosses as U+FFFD: same length, not '/', '\\', '.', a control or ASCII, so
  // every rule answers the same.
  const en = encoder.encode(name.length > 200 ? name.slice(0, 201) : name);
  const head = bytes.subarray(0, SNIFF_BYTES);
  const input = new Uint8Array(8 + en.length + head.length);
  const view = new DataView(input.buffer);
  view.setUint32(0, Math.min(bytes.length, UPLOAD_CAP + 1), true);
  view.setUint32(4, en.length, true);
  input.set(en, 8);
  input.set(head, 8 + en.length);
  const reply = invoke(input, (e) => e.upload_validate());
  const value = reply && typeof reply === 'object' ? reply.value : undefined;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || REFUSALS.get(value.refusal) !== value.status) throw new DavParseError('upload validate reply has an unexpected shape', 'reply');
  return { refusal: value.refusal, status: value.status };
}

/** upload-sniff.cjs classifyJs (#977), through the module. */
function uploadClassify(name) {
  if (typeof name !== 'string') throw new DavParseError('upload name must be text', 'input');
  // A lone surrogate crosses as U+FFFD; neither can be part of a known extension.
  const reply = invoke(encoder.encode(name), (e) => e.upload_classify(), 64 * 1024);
  const value = reply && typeof reply === 'object' ? reply.value : undefined;
  if (!GROUPS.has(value)) throw new DavParseError('upload classify reply has an unexpected shape', 'reply');
  return value;
}

const ENCODINGS = [null, 'utf-8', 'utf-16le', 'utf-16be', 'windows-1252'];

/** upload-sniff.cjs decodeTextJs (#977), through the module: null (not text) or
 *  `{ text, encoding }`. The whole upload crosses (decoding needs it), at most MAX_DECODE_BYTES. */
function uploadDecode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new DavParseError('upload bytes have the wrong type', 'input');
  const { status, bytes: out } = invokeRaw(bytes, (e) => e.upload_decode(), MAX_DECODE_BYTES);
  if (status !== 0) {
    let code = 'unknown';
    try { const r = JSON.parse(utf8(out)); if (r && typeof r.error === 'string') code = r.error; } catch { /* keep unknown */ }
    throw new DavParseError(`upload input refused by dav-parse (${code})`, code);
  }
  if (!out.length || out[0] >= ENCODINGS.length) throw new DavParseError('upload decode reply has an unexpected shape', 'reply');
  if (out[0] === 0) {
    if (out.length !== 1) throw new DavParseError('upload decode reply has an unexpected shape', 'reply');
    return null;
  }
  return { text: utf8(out.subarray(1), textDecoder), encoding: ENCODINGS[out[0]] };
}

/** Test hook: the cached instance's linear memory in bytes (0 when there is none). */
function memoryBytes() { return cached?.instance ? cached.instance.exports.memory.buffer.byteLength : 0; }

/** Test hook: forget the cached module (and its failure). */
function reset() { cached = null; }

module.exports = { listRecords, s3ListPage, storagePath, uploadValidate, uploadClassify, uploadDecode, load, readLock, reset, memoryBytes, DavParseError, DEFAULT_WASM, MAX_INPUT_BYTES, MAX_DECODE_BYTES, SNIFF_BYTES, RESET_AFTER_BYTES };
