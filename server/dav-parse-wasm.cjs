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
//   - crates/secret-envelope secretOpen/secretSeal = secret-envelope.cjs openJs/encryptJs
//                                                                             (SECRET_ENVELOPE_IMPL, #979)
//   - crates/mcp-frame     mcpRpcBody/mcpSchemaRefs = mcp.cjs parseRpcBody/resolveSchemaRefs
//                                                                             (MCP_FRAME_IMPL, #980)
//   - crates/chat-template-caps + provider-error  templateCaps/providerErrorKind/servingVerdict
//   - crates/autotune-plan  autotunePlan = auto-tune's next step                (AUTOTUNE_PLAN_IMPL, #1003)
//   - crates/preset-reload  presetReload = may the router re-read models.ini now (PRESET_RELOAD_IMPL, #1012)
//                                        new logic, no JS twin; see chat-template-caps.cjs
//                                                                             (CHAT_TEMPLATE_CAPS_IMPL, #1002)
//
// Memory: WebAssembly memory only grows. A listing or path call needs at most ~16 MiB; an upload
// decode copies the upload in (at most 25 MiB) and holds one copy of its text (at most 3 bytes per
// input byte, so ~75 MiB), so one 25 MiB decode can leave the instance at ~100 MiB+. After any call
// whose input or reply passes RESET_AFTER_BYTES the instance is dropped (the compiled module stays
// cached, so the next call only re-instantiates, ~ms) and that memory is released to the GC.
//
// Secret calls (#979) carry key bytes, so they never share an instance: after every secretOpen or
// secretSeal, whatever happened, the whole linear memory is overwritten with zeros and the
// instance dropped (the module itself also wipes its input buffer). The input this loader builds
// is zeroed too. The caller's own Buffers (the key, the returned plaintext) are the caller's
// responsibility.
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
const EXPORTS = ['memory', 'dav_input', 'dav_list', 's3_list', 'storage_path', 'upload_validate', 'upload_classify', 'upload_decode', 'secret_open', 'secret_seal', 'mcp_rpc_body', 'mcp_schema_refs', 'template_caps', 'provider_error', 'serving_verdict', 'autotune_plan', 'preset_reload', 'dav_output_ptr', 'dav_output_len'];

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
  // Only the extension decides (#989): send 'x' + path.extname(name), whose extname is the same,
  // so a name of any length crosses. An extension past 1024 units matches no group either way.
  const ext = path.extname(name);
  const reply = invoke(encoder.encode(`x${ext.length > 1024 ? ext.slice(0, 1024) : ext}`), (e) => e.upload_classify(), 64 * 1024);
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

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
// secret_envelope::MAX_PLAIN_BYTES, MAX_ENVELOPE_UNITS, MAX_USER_BYTES.
const MAX_SECRET_PLAIN_BYTES = 8 * 1024 * 1024;
const MAX_SECRET_UNITS = 12 * 1024 * 1024;
const MAX_SECRET_USER_BYTES = 64 * 1024;
const SECRET_REFUSALS = new Set(['bound', 'unopenable', 'too_large', 'input']);

/** Run one secret call on `input` (zeroed afterwards), then wipe the instance's memory and drop
 *  it. Returns `{ status, bytes }`; never puts input bytes in an error. */
function invokeSecret(input, call) {
  try {
    // The module-wide cap (MAX_DECODE_BYTES): a value at MAX_SECRET_UNITS is ~24 MiB as UTF-16.
    if (input.length > MAX_DECODE_BYTES) throw new DavParseError('secret input is too large', 'too_large');
    const wasm = ensure();
    try {
      const { exports } = wasm;
      const ptr = exports.dav_input(input.length) >>> 0;
      if (!ptr) throw new DavParseError('dav-parse refused the input size', 'too_large');
      new Uint8Array(exports.memory.buffer, ptr, input.length).set(input);
      const status = call(exports) >>> 0;
      const outPtr = exports.dav_output_ptr() >>> 0, outLen = exports.dav_output_len() >>> 0;
      return { status, bytes: new Uint8Array(exports.memory.buffer, outPtr, outLen).slice() };
    } catch (err) {
      if (err instanceof DavParseError) throw err;
      throw new DavParseError('dav-parse module failed', 'trap');
    } finally {
      try { new Uint8Array(wasm.exports.memory.buffer).fill(0); } catch { /* the instance is dropped anyway */ }
      if (cached && cached.instance === wasm) cached.instance = null;
    }
  } finally {
    input.fill(0);
  }
}

function secretRefusal(status, bytes) {
  let code = 'unknown';
  try { const r = JSON.parse(utf8(bytes)); if (r && SECRET_REFUSALS.has(r.error)) code = r.error; } catch { /* keep unknown */ }
  bytes.fill(0);
  return new DavParseError(`secret refused by dav-parse (${status === 2 ? 'input' : code})`, status === 2 ? 'input' : code);
}

/** `0` or `1 u32le(len) utf8`. */
function secretUser(user) {
  if (user === null) return new Uint8Array([0]);
  const u = encoder.encode(user);
  if (u.length > MAX_SECRET_USER_BYTES) throw new DavParseError('secret user id is too large', 'too_large');
  const out = new Uint8Array(5 + u.length);
  out[0] = 1;
  new DataView(out.buffer).setUint32(1, u.length, true);
  out.set(u, 5);
  return out;
}

const isKey = (k) => k instanceof Uint8Array && k.length === KEY_BYTES;

/** secret-envelope.cjs openJs (#979), through the module. `keys` is [current] or [current,
 *  previous]; `user` is String(userId) or null (no user); `text` is the stored value as a string.
 *  Returns `{ keyUsed: 'none'|'current'|'previous', plain: Uint8Array }` (plain is empty for
 *  'none'; the caller decodes and then zeroes it). Refusals throw a DavParseError whose reason is
 *  'bound', 'unopenable', 'too_large' or 'input'. */
function secretOpen(keys, user, text) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2 || !keys.every(isKey)) throw new DavParseError('secret keys have the wrong shape', 'input');
  if (typeof text !== 'string' || !(user === null || typeof user === 'string')) throw new DavParseError('secret input has the wrong type', 'input');
  if (text.length > MAX_SECRET_UNITS) throw new DavParseError('secret value is too large', 'too_large');
  const u = secretUser(user);
  const input = new Uint8Array(1 + keys.length * KEY_BYTES + u.length + text.length * 2);
  input[0] = keys.length;
  keys.forEach((k, i) => input.set(k, 1 + i * KEY_BYTES));
  input.set(u, 1 + keys.length * KEY_BYTES);
  const view = new DataView(input.buffer);
  const at = 1 + keys.length * KEY_BYTES + u.length;
  for (let i = 0; i < text.length; i++) view.setUint16(at + i * 2, text.charCodeAt(i), true);
  u.fill(0);
  const { status, bytes } = invokeSecret(input, (e) => e.secret_open());
  if (status !== 0) throw secretRefusal(status, bytes);
  const tag = bytes[0];
  if (bytes.length < 1 || tag > keys.length || (tag === 0 && bytes.length !== 1)) {
    bytes.fill(0);
    throw new DavParseError('secret open reply has an unexpected shape', 'reply');
  }
  return { keyUsed: ['none', 'current', 'previous'][tag], plain: bytes.subarray(1) };
}

const ENVELOPE_TEXT = /^enc:v([12]):[A-Za-z0-9_-]+$/;

/** secret-envelope.cjs encryptJs (#979) after its empty-value check, through the module.
 *  `plain` is the UTF-8 bytes, `nonce` 12 bytes from crypto.randomBytes, `user` as secretOpen. */
function secretSeal(key, nonce, plain, user) {
  if (!isKey(key) || !(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES || !(plain instanceof Uint8Array)) throw new DavParseError('secret seal input has the wrong shape', 'input');
  if (!(user === null || typeof user === 'string')) throw new DavParseError('secret input has the wrong type', 'input');
  if (plain.length > MAX_SECRET_PLAIN_BYTES) throw new DavParseError('secret value is too large', 'too_large');
  const u = secretUser(user);
  const input = new Uint8Array(KEY_BYTES + NONCE_BYTES + u.length + plain.length);
  input.set(key, 0);
  input.set(nonce, KEY_BYTES);
  input.set(u, KEY_BYTES + NONCE_BYTES);
  input.set(plain, KEY_BYTES + NONCE_BYTES + u.length);
  u.fill(0);
  const { status, bytes } = invokeSecret(input, (e) => e.secret_seal());
  if (status !== 0) throw secretRefusal(status, bytes);
  let text;
  try { text = decoder.decode(bytes); } catch { text = ''; }
  const m = ENVELOPE_TEXT.exec(text);
  // iv + tag + body in unpadded base64url.
  if (!m || Number(m[1]) !== (user === null ? 1 : 2) || text.length - 7 !== Math.ceil(((NONCE_BYTES + 16 + plain.length) * 4) / 3)) {
    throw new DavParseError('secret seal reply has an unexpected shape', 'reply');
  }
  return text;
}

// mcp_frame::MAX_BODY_UNITS and schema::MAX_SCHEMA_UNITS.
const MCP_BODY_UNITS = 8 * 1024 * 1024;
const MCP_SCHEMA_UNITS = 2 * 1024 * 1024;
const MCP_KINDS = ['reply', 'mismatch', 'none', 'other', 'invalid'];

/** A JS string as its UTF-16LE code units (lone surrogates included). */
function utf16le(text) {
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

/** `5 u32le(n) units`, a number, a boolean, null, or 0 (=== nothing parsed from JSON). */
function mcpExpected(id) {
  if (typeof id === 'number') { const b = new Uint8Array(9); b[0] = 4; new DataView(b.buffer).setFloat64(1, id, true); return b; }
  if (typeof id === 'string') {
    const u = utf16le(id), b = new Uint8Array(5 + u.length);
    b[0] = 5; new DataView(b.buffer).setUint32(1, id.length, true); b.set(u, 5); return b;
  }
  if (id === null) return new Uint8Array([1]);
  if (typeof id === 'boolean') return new Uint8Array([id ? 3 : 2]);
  return new Uint8Array([0]);
}

/** mcp.cjs parseRpcBody's decision (#980), through the module: `{ kind, text? }` where kind is
 *  'reply'|'mismatch' (with the message as JSON text), 'none', 'other' or 'invalid'. */
function mcpRpcBody(sse, text, expectedId) {
  if (typeof sse !== 'boolean' || typeof text !== 'string') throw new DavParseError('mcp body has the wrong type', 'input');
  if (text.length > MCP_BODY_UNITS) throw new DavParseError('mcp body is too large', 'too_large');
  const id = mcpExpected(expectedId), body = utf16le(text);
  const input = new Uint8Array(1 + id.length + body.length);
  input[0] = sse ? 1 : 0;
  input.set(id, 1);
  input.set(body, 1 + id.length);
  const { status, bytes } = invokeRaw(input, (e) => e.mcp_rpc_body(), MAX_DECODE_BYTES);
  if (status !== 0) {
    let code = 'unknown';
    try { const r = JSON.parse(utf8(bytes)); if (r && typeof r.error === 'string') code = r.error; } catch { /* keep unknown */ }
    throw new DavParseError(`mcp body refused by dav-parse (${code})`, code);
  }
  const kind = MCP_KINDS[bytes[0]];
  if (!bytes.length || !kind || (bytes[0] > 1 && bytes.length !== 1)) throw new DavParseError('mcp body reply has an unexpected shape', 'reply');
  return bytes[0] > 1 ? { kind } : { kind, text: utf8(bytes.subarray(1)) };
}

/** mcp.cjs resolveSchemaRefs (#980), through the module, on mcp.cjs schemaWire's text:
 *  `{ ok: true, text }` (the encoded tree) or `{ ok: false, text }` (`{"code","ref"}`). */
function mcpSchemaRefs(wire) {
  if (typeof wire !== 'string') throw new DavParseError('mcp schema has the wrong type', 'input');
  if (wire.length > MCP_SCHEMA_UNITS) throw new DavParseError('mcp schema is too large', 'too_large');
  const { status, bytes } = invokeRaw(utf16le(wire), (e) => e.mcp_schema_refs(), MAX_DECODE_BYTES);
  if (status !== 0) {
    let code = 'unknown';
    try { const r = JSON.parse(utf8(bytes)); if (r && typeof r.error === 'string') code = r.error; } catch { /* keep unknown */ }
    throw new DavParseError(`mcp schema refused by dav-parse (${code})`, code);
  }
  if (bytes.length < 2 || bytes[0] > 1) throw new DavParseError('mcp schema reply has an unexpected shape', 'reply');
  return { ok: bytes[0] === 0, text: utf8(bytes.subarray(1)) };
}

// chat_template_caps::MAX_TEMPLATE_BYTES; provider_error classifies at most 256 KiB of a body, so
// at most that many UTF-16 units (<= 768 KiB of UTF-8) cross.
const MAX_TEMPLATE_BYTES = 256 * 1024;
const MAX_ERROR_UNITS = 256 * 1024;
const CAPS_FIELDS = ['known', 'tools', 'toolCalls', 'toolRole', 'systemRole', 'strictAlternation', 'raises', 'thinking', 'sendTools'];
const ERROR_KINDS = new Set(['context_full', 'template_or_tools_unsupported', 'bad_request', 'backend_down', 'other']);

/** chat-template-caps analyze (#1002): the capability booleans of a chat template. A template
 *  over MAX_TEMPLATE_BYTES is refused (DavParseError 'too_large'). */
function templateCaps(template) {
  if (typeof template !== 'string') throw new DavParseError('chat template must be text', 'input');
  const bytes = encoder.encode(template);
  if (bytes.length > MAX_TEMPLATE_BYTES) throw new DavParseError('chat template is too large', 'too_large');
  const reply = invoke(bytes, (e) => e.template_caps());
  if (!reply || typeof reply !== 'object' || CAPS_FIELDS.some((k) => typeof reply[k] !== 'boolean')) throw new DavParseError('template caps reply has an unexpected shape', 'reply');
  return Object.fromEntries(CAPS_FIELDS.map((k) => [k, reply[k]]));
}

/** `u32le(status) utf8(body)`, the body cut to MAX_ERROR_UNITS (the module cuts it further). */
function statusBody(status, body) {
  if (!Number.isInteger(status) || status < 0 || status > 0xffffffff || typeof body !== 'string') throw new DavParseError('provider error input has the wrong type', 'input');
  let text = body.length > MAX_ERROR_UNITS ? body.slice(0, MAX_ERROR_UNITS) : body;
  if (!text.isWellFormed()) text = text.toWellFormed();
  const eb = encoder.encode(text);
  const out = new Uint8Array(4 + eb.length);
  new DataView(out.buffer).setUint32(0, status, true);
  out.set(eb, 4);
  return out;
}

/** provider-error classify (#1002): `{ kind, reason }`, the reason sanitised and capped. */
function providerErrorKind(status, body) {
  const reply = invoke(statusBody(status, body), (e) => e.provider_error());
  if (!reply || !ERROR_KINDS.has(reply.kind) || typeof reply.reason !== 'string') throw new DavParseError('provider error reply has an unexpected shape', 'reply');
  return { kind: reply.kind, reason: reply.reason };
}

/** Autotune's serving verdict (#1003): `{ passed, kind, reason }` for one chat reply. */
function servingVerdict(status, body) {
  const reply = invoke(statusBody(status, body), (e) => e.serving_verdict());
  if (!reply || typeof reply.passed !== 'boolean' || typeof reply.reason !== 'string'
    || !(reply.passed ? reply.kind === null : ERROR_KINDS.has(reply.kind))) throw new DavParseError('serving verdict reply has an unexpected shape', 'reply');
  return { passed: reply.passed, kind: reply.kind, reason: reply.reason };
}

// autotune_plan::MAX_INPUT_BYTES and the step shapes it replies with (#1003).
const MAX_PLAN_BYTES = 64 * 1024;
const PLAN_STEPS = new Set(['probe', 'phase', 'verify', 'serving', 'done', 'fail']);
const PLAN_KV = new Set(['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl']);
const PLAN_PHASES = new Set(['sampling', 'drafting', 'batch']);
const PLAN_STOPS = new Set(['unsizeable', 'no_rung', 'does_not_fit', 'no_context', 'phase_failed', 'verify_failed', 'serving_failed']);
const posInt = (n) => Number.isSafeInteger(n) && n >= 0;

/** autotune-plan (#1003): auto-tune's next step for `request` (facts, memory, ladder, kv,
 *  results). Refusals throw DavParseError ('input', 'too_large'); a reply of an unexpected shape
 *  throws 'reply'. */
function autotunePlan(request) { return autotunePlanText(JSON.stringify(request)); }
/** autotunePlan on the request's JSON text as is. */
function autotunePlanText(text) {
  if (typeof text !== 'string') throw new DavParseError('autotune plan request must be text', 'input');
  const bytes = encoder.encode(text.isWellFormed() ? text : text.toWellFormed());
  if (bytes.length > MAX_PLAN_BYTES) throw new DavParseError('autotune plan request is too large', 'too_large');
  const r = invoke(bytes, (e) => e.autotune_plan());
  const ok = r && PLAN_STEPS.has(r.step) && (r.step === 'fail'
    ? PLAN_STOPS.has(r.code) && typeof r.message === 'string'
    : posInt(r.ctx) && PLAN_KV.has(r.kv)
      && (r.step !== 'phase' || PLAN_PHASES.has(r.id))
      && (!['probe', 'verify'].includes(r.step) || (posInt(r.fill) && posInt(r.estimateMib))));
  if (!ok) throw new DavParseError('autotune plan reply has an unexpected shape', 'reply');
  return r;
}

// preset_reload::MAX_INPUT_BYTES / MAX_FILE_BYTES / MAX_LOADED and its reply shape (#1012).
const MAX_RELOAD_BYTES = 5 * 1024 * 1024;
const RELOAD_REASONS = new Set(['unchanged', 'changed', 'ambiguous']);
const RELOAD_DETAILS = new Set(['duplicate_section', 'header', 'line']);

/** preset-reload (#1012): may the llama.cpp router re-read models.ini without unloading a loaded
 *  model? `{ baseline, current, loaded }` -> `{ safe, reason, changed, detail }`. Refusals throw
 *  DavParseError ('input', 'too_large'); a reply of an unexpected shape throws 'reply'. */
function presetReload({ baseline, current, loaded }) {
  if (typeof baseline !== 'string' || typeof current !== 'string' || !Array.isArray(loaded) || !loaded.every((id) => typeof id === 'string')) {
    throw new DavParseError('preset reload request must be two texts and a list of ids', 'input');
  }
  const bytes = encoder.encode(JSON.stringify({ baseline: baseline.toWellFormed(), current: current.toWellFormed(), loaded }));
  if (bytes.length > MAX_RELOAD_BYTES) throw new DavParseError('preset reload request is too large', 'too_large');
  const r = invoke(bytes, (e) => e.preset_reload());
  const ok = r && typeof r.safe === 'boolean' && RELOAD_REASONS.has(r.reason) && Array.isArray(r.changed)
    && r.changed.every((id) => typeof id === 'string' && loaded.includes(id))
    && r.safe === (r.reason === 'unchanged')
    && (r.reason === 'ambiguous' ? RELOAD_DETAILS.has(r.detail) : r.detail === null)
    && (r.reason === 'changed') === (r.changed.length > 0);
  if (!ok) throw new DavParseError('preset reload reply has an unexpected shape', 'reply');
  return { safe: r.safe, reason: r.reason, changed: r.changed, detail: r.detail };
}

/** Test hook: the cached instance's linear memory in bytes (0 when there is none). */
function memoryBytes() { return cached?.instance ? cached.instance.exports.memory.buffer.byteLength : 0; }

// Every switch that runs this module (#996). Each reads its value as trim().toLowerCase().
// CHAT_TEMPLATE_CAPS_IMPL counts only when set to wasm explicitly; its default (also wasm) is
// checked by chat-template-caps.cjs startup(), which falls back to off instead of stopping.
const IMPL_FLAGS = ['DAV_PARSE_IMPL', 'S3_PARSE_IMPL', 'STORAGE_PATH_IMPL', 'UPLOAD_SNIFF_IMPL', 'SECRET_ENVELOPE_IMPL', 'MCP_FRAME_IMPL', 'CHAT_TEMPLATE_CAPS_IMPL', 'AUTOTUNE_PLAN_IMPL', 'PRESET_RELOAD_IMPL'];

/** The *_IMPL switches set to wasm in `env`. */
function wasmFlags(env = process.env) {
  return IMPL_FLAGS.filter((k) => String(env[k] ?? '').trim().toLowerCase() === 'wasm');
}

/** Startup check (#996): when any switch is wasm, load and verify the module now (lock, sha256,
 *  no imports, the full ABI) instead of failing on the first request. Returns the flags; throws
 *  an Error naming them and the reason when the module is unusable. */
function verifyAtStartup(env = process.env) {
  const flags = wasmFlags(env);
  if (!flags.length) return flags;
  cached = null;
  try {
    cached = load({ file: env.DAV_PARSE_WASM || DEFAULT_WASM });
  } catch (err) {
    cached = null;
    const reason = err instanceof DavParseError ? err.reason : 'unexpected';
    throw Object.assign(new Error(`${flags.join(', ')} set to wasm, but dav-parse.wasm failed verification (${reason}): ${err?.message || err}`), { reason, flags });
  }
  return flags;
}

/** Test hook: forget the cached module (and its failure). */
function reset() { cached = null; }

module.exports = { wasmFlags, verifyAtStartup, IMPL_FLAGS, listRecords, s3ListPage, storagePath, uploadValidate, uploadClassify, uploadDecode, secretOpen, secretSeal, mcpRpcBody, mcpSchemaRefs, templateCaps, providerErrorKind, servingVerdict, autotunePlan, autotunePlanText, MAX_PLAN_BYTES, presetReload, MAX_RELOAD_BYTES, MAX_TEMPLATE_BYTES, MCP_BODY_UNITS, MCP_SCHEMA_UNITS, MAX_SECRET_PLAIN_BYTES, MAX_SECRET_UNITS, MAX_SECRET_USER_BYTES, load, readLock, reset, memoryBytes, DavParseError, DEFAULT_WASM, MAX_INPUT_BYTES, MAX_DECODE_BYTES, SNIFF_BYTES, RESET_AFTER_BYTES };
