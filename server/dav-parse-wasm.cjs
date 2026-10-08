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
//   - crates/load-verdict   loadVerdict = why a failed auto-tune step failed   (LAYA_LOAD_ADVISOR, #1004)
//                                        new logic, no JS twin; see chat-template-caps.cjs
//                                                                             (CHAT_TEMPLATE_CAPS_IMPL, #1002)
//   - crates/tune-contention tuneContention = auto-tune vs another router client (always on; fails closed, #1062)
//   - crates/long-profile   longProfilePairs/longProfileSection/longProfilePick = a model's
//                           <id>-long profile: pairing, its models.ini section, the entry a chat
//                           is served by (always on; fails closed, #1079)
//   - crates/prompt-framing frameUntrusted/escapeClosing, provenance*, packet* = prompt-framing.cjs,
//                          provenance-policy.cjs, task-packet.cjs                (PROMPT_FRAMING_IMPL, #769/#740)
//   - crates/s3-sign        s3Sign/s3Region = s3-sign.cjs signS3RequestJs, s3-region.cjs normalizeS3Region
//                                                                             (S3_SIGN_IMPL)
//
// Memory: WebAssembly memory only grows. A listing or path call needs at most ~16 MiB; an upload
// decode copies the upload in (at most 25 MiB) and holds one copy of its text (at most 3 bytes per
// input byte, so ~75 MiB), so one 25 MiB decode can leave the instance at ~100 MiB+. After any call
// whose input or reply passes RESET_AFTER_BYTES the instance is dropped (the compiled module stays
// cached, so the next call only re-instantiates, ~ms) and that memory is released to the GC.
//
// Secret calls (#979, and s3Sign, which carries the S3 secret key) carry key bytes, so they never share an instance: after every secretOpen or
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
const EXPORTS = ['memory', 'dav_input', 'dav_list', 's3_list', 'storage_path', 'upload_validate', 'upload_classify', 'upload_decode', 'secret_open', 'secret_seal', 'mcp_rpc_body', 'mcp_schema_refs', 'template_caps', 'provider_error', 'serving_verdict', 'autotune_plan', 'preset_reload', 'load_verdict', 'tune_contention', 'frame_untrusted', 'escape_closing', 'provenance', 'task_packet', 'long_profile', 's3_sign', 's3_region', 'dav_output_ptr', 'dav_output_len'];

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

// load_verdict::MAX_INPUT_BYTES and the names it replies with (#1004).
const MAX_VERDICT_BYTES = 32 * 1024;
const VERDICT_OUTCOMES = new Set(['oom', 'load_failed', 'timeout', 'over_time', 'recall_failed', 'template']);
const VERDICT_LABELS = new Set(['oom', 'load_failed', 'timeout', 'recall_failed', 'template', 'unknown']);
const VERDICT_SOURCES = new Set(['measured', 'rule', 'advisor', 'fallback']);

/** load-verdict (#1004): a failed auto-tune step's outcome from the calibrator's `cause`, the
 *  engine's `evidence` ({ status, exitCode, text } or null) and the decision service's `advice`
 *  ({ label, confidence } or null). Refusals throw DavParseError ('input', 'too_large'); a reply
 *  of an unexpected shape throws 'reply'. */
function loadVerdict(request) { return loadVerdictText(JSON.stringify(request)); }
/** loadVerdict on the request's JSON text as is. */
function loadVerdictText(text) {
  if (typeof text !== 'string') throw new DavParseError('load verdict request must be text', 'input');
  const bytes = encoder.encode(text.isWellFormed() ? text : text.toWellFormed());
  if (bytes.length > MAX_VERDICT_BYTES) throw new DavParseError('load verdict request is too large', 'too_large');
  const r = invoke(bytes, (e) => e.load_verdict());
  const ok = r && VERDICT_OUTCOMES.has(r.outcome) && VERDICT_SOURCES.has(r.source) && VERDICT_LABELS.has(r.rule)
    && (r.ruleId === null || typeof r.ruleId === 'string') && typeof r.ask === 'boolean' && typeof r.adviceUsed === 'boolean'
    && typeof r.reason === 'string'
    && (r.advice === null || (r.advice && VERDICT_LABELS.has(r.advice.label) && posInt(r.advice.permille) && r.advice.permille <= 1000));
  if (!ok) throw new DavParseError('load verdict reply has an unexpected shape', 'reply');
  return r;
}

// tune_contention::MAX_INPUT_BYTES and its reply vocabulary (#1062).
const MAX_CONTENTION_BYTES = 64 * 1024;
const CONTENTION_ACTIONS = new Set(['proceed', 'wait', 'unload', 'give_up']);
const CONTENTION_REASONS = { proceed: ['clear'], wait: ['loading', 'other', 'busy', 'settling'], unload: ['idle', 'idle_unknown'], give_up: ['timed_out'] };

/** tune-contention (#1062): may auto-tune go on while another router client has a model live?
 *  `{ tuning, rows: [{ id, status, busy }], prev, startedAt, now, maxWaitMs, quietMs }` ->
 *  `{ action, reason, foreign, unload, fingerprint, since, waitedMs }`. Refusals throw
 *  DavParseError ('input', 'too_large'); a reply of an unexpected shape throws 'reply'. */
function tuneContention(request) { return tuneContentionText(JSON.stringify(request)); }
/** tuneContention on the request's JSON text as is. */
function tuneContentionText(text) {
  if (typeof text !== 'string') throw new DavParseError('tune contention request must be text', 'input');
  const bytes = encoder.encode(text.isWellFormed() ? text : text.toWellFormed());
  if (bytes.length > MAX_CONTENTION_BYTES) throw new DavParseError('tune contention request is too large', 'too_large');
  const r = invoke(bytes, (e) => e.tune_contention());
  const ids = (list) => Array.isArray(list) && list.every((id) => typeof id === 'string' && id.length > 0);
  const ok = r && CONTENTION_ACTIONS.has(r.action) && CONTENTION_REASONS[r.action].includes(r.reason)
    && ids(r.foreign) && ids(r.unload) && (r.action === 'proceed') === (r.foreign.length === 0)
    && (r.action === 'unload' ? r.unload.length === r.foreign.length && r.unload.every((id) => r.foreign.includes(id)) : r.unload.length === 0)
    && typeof r.fingerprint === 'string' && Number.isSafeInteger(r.since) && r.since >= 0
    && Number.isSafeInteger(r.waitedMs) && r.waitedMs >= 0;
  if (!ok) throw new DavParseError('tune contention reply has an unexpected shape', 'reply');
  return { action: r.action, reason: r.reason, foreign: r.foreign, unload: r.unload, fingerprint: r.fingerprint, since: r.since, waitedMs: r.waitedMs };
}

// long_profile::MAX_INPUT_BYTES and the reasons it replies with (#1079).
const MAX_LONG_PROFILE_BYTES = 3 * 1024 * 1024;
const LONG_SUFFIX = '-long';
const SECTION_REFUSALS = new Set(['invalid_id', 'is_long', 'ambiguous', 'no_base', 'exists', 'no_model', 'bad_path', 'too_large', 'unsafe']);
const PICK_REASONS = new Set(['low', 'high', 'no_long', 'is_long']);
/** long-profile (#1079) on a request's JSON text as is: the raw reply (status 0), or a
 *  DavParseError carrying the module's refusal code. */
function longProfileText(text) {
  if (typeof text !== 'string') throw new DavParseError('long profile request must be text', 'input');
  const bytes = encoder.encode(text.isWellFormed() ? text : text.toWellFormed());
  if (bytes.length > MAX_LONG_PROFILE_BYTES) throw new DavParseError('long profile request is too large', 'too_large');
  return invoke(bytes, (e) => e.long_profile());
}
const isPair = (p) => p && typeof p.base === 'string' && typeof p.long === 'string' && p.base && p.long === p.base + LONG_SUFFIX;
/** Which of the router's rows ({ id, model: file path or null }) are a model and its long
 *  profile: [{ base, long }] in byte order of base. */
function longProfilePairs(rows) {
  if (!Array.isArray(rows)) throw new DavParseError('long profile rows must be a list', 'input');
  const r = longProfileText(JSON.stringify({ op: 'pairs', rows: rows.map((x) => ({ id: x?.id, model: x?.model ?? null })) }));
  const ids = new Set(rows.map((x) => x?.id));
  if (!r || !Array.isArray(r.pairs) || !r.pairs.every((p) => isPair(p) && ids.has(p.base) && ids.has(p.long))) throw new DavParseError('long profile reply has an unexpected shape', 'reply');
  return r.pairs.map((p) => ({ base: p.base, long: p.long }));
}
/** models.ini `text` with [<base>-long] appended: { ok: true, id, text } or { ok: false, reason }. */
function longProfileSection({ text, base, model = null, mmproj = null }) {
  const r = longProfileText(JSON.stringify({ op: 'section', text: typeof text === 'string' ? text.toWellFormed() : text, base, model, mmproj }));
  const ok = r && (r.ok === true
    ? r.id === base + LONG_SUFFIX && typeof r.text === 'string' && r.text.startsWith(text) && r.text.length > text.length
    : r.ok === false && SECTION_REFUSALS.has(r.reason));
  if (!ok) throw new DavParseError('long profile reply has an unexpected shape', 'reply');
  return r.ok ? { ok: true, id: r.id, text: r.text } : { ok: false, reason: r.reason };
}
/** The entry that serves `model` for `profile` ('low' | 'high'): { model, long, reason }. */
function longProfilePick({ model, profile, pairs }) {
  const r = longProfileText(JSON.stringify({ op: 'pick', model, profile, pairs: Array.isArray(pairs) ? pairs.map((p) => ({ base: p?.base, long: p?.long })) : pairs }));
  const known = new Set([model, ...(pairs || []).flatMap((p) => [p.base, p.long])]);
  const ok = r && typeof r.model === 'string' && known.has(r.model) && typeof r.long === 'boolean' && PICK_REASONS.has(r.reason);
  if (!ok) throw new DavParseError('long profile reply has an unexpected shape', 'reply');
  return { model: r.model, long: r.long, reason: r.reason };
}

// prompt_framing::MAX_TEXT_UNITS / MAX_LABEL_UNITS / MAX_PROVENANCE_BYTES / MAX_PACKET_BYTES.
const FRAME_TEXT_UNITS = 8 * 1024 * 1024;
const FRAME_LABEL_UNITS = 1024 * 1024;
const MAX_PROVENANCE_BYTES = 24 * 1024 * 1024;
const MAX_PACKET_BYTES = 1024 * 1024;
const FRAME_TAG = /^[A-Za-z0-9_-]{1,64}$/;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** UTF-16LE bytes as a JS string, lone surrogates kept (TextDecoder would replace them). */
function fromUtf16le(bytes) {
  if (bytes.length % 2) throw new DavParseError('prompt framing reply has an odd length', 'reply');
  const n = bytes.length / 2;
  let units;
  if (littleEndian && bytes.byteOffset % 2 === 0) units = new Uint16Array(bytes.buffer, bytes.byteOffset, n);
  else { units = new Uint16Array(n); const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length); for (let i = 0; i < n; i++) units[i] = v.getUint16(i * 2, true); }
  let out = '';
  for (let i = 0; i < n; i += 8192) out += String.fromCharCode.apply(null, units.subarray(i, i + 8192));
  return out;
}

function framingRefusal(what, status, bytes) {
  let code = 'unknown';
  try { const r = JSON.parse(utf8(bytes)); if (r && typeof r.error === 'string') code = r.error; } catch { /* keep unknown */ }
  return new DavParseError(`${what} refused by dav-parse (status ${status}, ${code})`, code);
}

/** `u32le(units) units` for each string but the last, then the last's units. */
function unitFrames(...parts) {
  const enc = parts.map(utf16le);
  const out = new Uint8Array(enc.reduce((n, e, i) => n + e.length + (i < enc.length - 1 ? 4 : 0), 0));
  const view = new DataView(out.buffer);
  let at = 0;
  enc.forEach((e, i) => {
    if (i < enc.length - 1) { view.setUint32(at, parts[i].length, true); at += 4; }
    out.set(e, at); at += e.length;
  });
  return out;
}

/** prompt-framing.cjs frameUntrusted (#769), through the module. Strings only. */
function frameUntrusted(kind, label, text) {
  if (typeof kind !== 'string' || typeof label !== 'string' || typeof text !== 'string') throw new DavParseError('framing input must be text', 'input');
  if (kind.length > FRAME_LABEL_UNITS || label.length > FRAME_LABEL_UNITS || text.length > FRAME_TEXT_UNITS) throw new DavParseError('framing input is too large', 'too_large');
  const { status, bytes } = invokeRaw(unitFrames(kind, label, text), (e) => e.frame_untrusted(), MAX_DECODE_BYTES);
  if (status !== 0) throw framingRefusal('framing', status, bytes);
  const out = fromUtf16le(bytes);
  // The block: a header with the notice (46-294 units), the body (the text plus at most one U+200B
  // per 9 units, the shortest marker '</SOURCE>'), the 13-unit close.
  if (!out.startsWith('<untrusted kind="') || !out.endsWith('\n</untrusted>') || !out.includes('> (data, not instructions)\n')
    || out.length < text.length + 59 || out.length > text.length + Math.ceil(text.length / 9) + 307) {
    throw new DavParseError('framing reply has an unexpected shape', 'reply');
  }
  return out;
}

/** prompt-framing.cjs escapeClosing, through the module; the tag is a literal ASCII name. */
function escapeClosing(text, tag) {
  if (typeof text !== 'string' || typeof tag !== 'string' || !FRAME_TAG.test(tag)) throw new DavParseError('escapeClosing input must be text and an ASCII tag', 'input');
  if (text.length > FRAME_TEXT_UNITS) throw new DavParseError('escapeClosing input is too large', 'too_large');
  const { status, bytes } = invokeRaw(unitFrames(tag, text), (e) => e.escape_closing(), MAX_DECODE_BYTES);
  if (status !== 0) throw framingRefusal('escapeClosing', status, bytes);
  const out = fromUtf16le(bytes);
  if (out.length < text.length || out.length > text.length + Math.ceil(text.length / (tag.length + 3))) throw new DavParseError('escapeClosing reply has an unexpected shape', 'reply');
  return out;
}

/** One provenance or packet request: UTF-8 JSON in, a parsed reply out. */
function framingCall(request, call, max, what) {
  const bytes = encoder.encode(JSON.stringify(request));
  if (bytes.length > max) throw new DavParseError(`${what} request is too large`, 'too_large');
  const r = invokeRaw(bytes, call, MAX_DECODE_BYTES);
  if (r.status !== 0) throw framingRefusal(what, r.status, r.bytes);
  try { return JSON.parse(utf8(r.bytes)); } catch { throw new DavParseError(`${what} reply is not JSON`, 'reply'); }
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const nonEmpty = (s) => typeof s === 'string' && s.length > 0;
function validStore(r) {
  const s = r?.state, st = r?.stats;
  const ok = s && isCount(s.maxChars) && isCount(s.chars) && typeof s.saturated === 'boolean' && s.chars <= s.maxChars
    && Array.isArray(s.sources) && s.sources.length <= 64 && s.sources.every(nonEmpty)
    && Array.isArray(s.texts) && (!s.saturated || s.texts.length === 0)
    && s.texts.every((t) => Array.isArray(t) && t.length === 2 && isCount(t[0]) && t[0] < s.sources.length && nonEmpty(t[1]))
    && st && st.chars === s.chars && isCount(st.grams) && st.sources === s.sources.length && st.saturated === s.saturated;
  if (!ok) throw new DavParseError('provenance store reply has an unexpected shape', 'reply');
  return { state: s, stats: { chars: st.chars, grams: st.grams, sources: st.sources, saturated: st.saturated } };
}
const provenance = (request) => framingCall(request, (e) => e.provenance(), MAX_PROVENANCE_BYTES, 'provenance');

/** provenance-policy.cjs createTaintStore (#769): an empty store's `{ state, stats }`. */
function provenanceNew(maxChars) {
  if (!isCount(maxChars) || maxChars > 4_000_000) throw new DavParseError('provenance maxChars must be an integer from 0 to 4000000', 'input');
  return validStore(provenance({ op: 'new', maxChars }));
}
/** The store after ingestMessages' text parts (`contents`). */
function provenanceIngest(state, contents) { return validStore(provenance({ op: 'ingest', state, contents })); }
/** The store after add(source, text) (`source` already `String(source || 'untrusted text')`). */
function provenanceAdd(state, source, text) { return validStore(provenance({ op: 'add', state, source, text })); }
/** sourceOf(value): a source name or null. */
function provenanceSource(state, value) {
  const r = provenance({ op: 'source', state, value });
  if (!r || !(r.source === null || nonEmpty(r.source))) throw new DavParseError('provenance source reply has an unexpected shape', 'reply');
  return r.source;
}
/** checkWrite on the call's argument text (`object`: the JSON text of an object argument). */
function provenanceCheck(state, args, object) {
  const r = provenance({ op: 'check', state, args, object });
  if (r && r.unchecked === true && Object.keys(r).length === 1) return [{ field: null, source: null, unchecked: true }];
  if (!r || !Array.isArray(r.found) || r.found.length > 5 || !r.found.every((f) => f && nonEmpty(f.field) && nonEmpty(f.source))) {
    throw new DavParseError('provenance check reply has an unexpected shape', 'reply');
  }
  return r.found.map((f) => ({ field: f.field, source: f.source }));
}
/** The policy's helpers, for differential tests: normalise, key, candidates, blocks. */
function provenanceProbe(op, value) {
  const field = { normalise: 'value', key: 'key', candidates: 'value', blocks: 'content' }[op];
  if (!field || typeof value !== 'string') throw new DavParseError('provenance probe input is wrong', 'input');
  const r = provenance({ op, [field]: value });
  const out = { normalise: r?.value, key: r?.sensitive, candidates: r?.candidates, blocks: r?.blocks }[op];
  const ok = { normalise: typeof out === 'string', key: typeof out === 'boolean', candidates: Array.isArray(out) && out.every((c) => typeof c === 'string'),
    blocks: Array.isArray(out) && out.every((b) => Array.isArray(b) && b.length === 3 && typeof b[0] === 'string' && (b[1] === null || typeof b[1] === 'string') && typeof b[2] === 'string') }[op];
  if (!ok) throw new DavParseError('provenance probe reply has an unexpected shape', 'reply');
  return out;
}

const PACKET_KINDS = ['tool', 'web', 'file', 'project', 'chat'];
const PACKET_RULE = /^\$[\s\S]*: (must be a string|must not be empty|longer than \d+ characters|contains a control or formatting character|must be an object|is not part of the schema|must be an array|has more than \d+ items|must be 1|is required|must be one of tool, web, file, project, chat|larger than 16384 bytes|unreadable)$/;
/** A packet as task-packet.cjs builds it (fresh plain objects, the JS's key order). */
function validPacket(p) {
  const strs = (a, max, each) => Array.isArray(a) && a.length <= max && a.every((s) => nonEmpty(s) && s.length <= each);
  const ok = p && p.packet_schema === 1 && nonEmpty(p.goal) && p.goal.length <= 400 && Array.isArray(p.facts) && p.facts.length <= 24
    && p.facts.every((f) => f && nonEmpty(f.text) && f.text.length <= 600 && f.source && PACKET_KINDS.includes(f.source.kind) && nonEmpty(f.source.ref)
      && f.source.ref.length <= 300 && (f.quote === undefined || (nonEmpty(f.quote) && f.quote.length <= 400)))
    && strs(p.constraints, 12, 300) && strs(p.open_questions, 12, 300);
  if (!ok) throw new DavParseError('task packet reply has an unexpected shape', 'reply');
  return {
    packet_schema: 1, goal: p.goal,
    facts: p.facts.map((f) => ({ text: f.text, source: { kind: f.source.kind, ref: f.source.ref }, ...(f.quote !== undefined ? { quote: f.quote } : {}) })),
    constraints: [...p.constraints], open_questions: [...p.open_questions],
  };
}
const packetCall = (request) => framingCall(request, (e) => e.task_packet(), MAX_PACKET_BYTES, 'task packet');

/** task-packet.cjs parsePacket (#740): `{ ok, packet }` or `{ ok: false, reason, error }`. */
function packetParse(output) {
  if (typeof output !== 'string') throw new DavParseError('task packet output must be text', 'input');
  const r = packetCall({ op: 'parse', output });
  if (r?.ok === true) return { ok: true, packet: validPacket(r.packet) };
  const ok = r?.ok === false && ((r.reason === 'invalid-json' && ['$: no JSON', '$: not JSON'].includes(r.error)) || (r.reason === 'schema' && typeof r.error === 'string' && PACKET_RULE.test(r.error)));
  if (!ok) throw new DavParseError('task packet reply has an unexpected shape', 'reply');
  return { ok: false, reason: r.reason, error: r.error };
}
/** task-packet.cjs validatePacket on a JSON tree: `{ ok, packet }` or `{ ok: false, error }`. */
function packetValidate(raw) {
  const r = packetCall({ op: 'validate', packet: raw });
  if (r?.ok === true) return { ok: true, packet: validPacket(r.packet) };
  if (r?.ok !== false || typeof r.error !== 'string' || !PACKET_RULE.test(r.error)) throw new DavParseError('task packet reply has an unexpected shape', 'reply');
  return { ok: false, error: r.error };
}
/** task-packet.cjs renderPacket of a packet parsePacket returned. */
function packetRender(packet, label) {
  if (typeof label !== 'string') throw new DavParseError('task packet label must be text', 'input');
  const r = packetCall({ op: 'render', packet, label });
  if (!r || typeof r.text !== 'string' || !r.text.startsWith('<untrusted kind="task packet"') || !r.text.endsWith('\n</untrusted>')) {
    throw new DavParseError('task packet render reply has an unexpected shape', 'reply');
  }
  return r.text;
}

// s3_sign::MAX_FIELD_BYTES, MAX_QUERY_PAIRS, MAX_PAYLOAD_BYTES (the JS has no caps; core's values
// are far below them).
const MAX_S3_FIELD_BYTES = 64 * 1024;
const MAX_S3_QUERY_PAIRS = 256;
const MAX_S3_PAYLOAD_BYTES = 16 * 1024 * 1024;
const S3_REFUSALS = new Set(['input', 'too_large']);
const HEX64 = /^[0-9a-f]{64}$/;
const S3_REGION_TEXT = /^[a-z0-9-]{1,32}$/;
const s3Input = (what) => new DavParseError(`s3 signing input refused (${what})`, 'input');

function s3Refusal(status, bytes) {
  let code = 'unknown';
  try { const r = JSON.parse(utf8(bytes)); if (r && S3_REFUSALS.has(r.error)) code = r.error; } catch { /* keep unknown */ }
  return new DavParseError(`s3 request refused by dav-parse (${status === 2 ? 'input' : code})`, status === 2 ? 'input' : code);
}

/** s3-sign.cjs signS3RequestJs, through the module (S3_SIGN_IMPL=wasm). Same arguments and the
 *  same headers object (same keys, same order). `url` is what the JS reads: a string `host` and
 *  `pathname` and a URLSearchParams `searchParams` (a URL). The method, secret and payload are
 *  passed as UTF-8 (a lone surrogate as U+FFFD, exactly what the JS hashes). Text echoed in the
 *  headers (access key, region, token, date) must be well-formed: the JS would send a lone
 *  surrogate the module cannot express, so that is refused. The input (with the secret key) is
 *  zeroed and the instance's memory wiped after the call; errors carry a reason, never input. */
function s3Sign(method, url, payload, accessKey, secretKey, opts = {}) {
  if (!url || typeof url.host !== 'string' || typeof url.pathname !== 'string' || !(url.searchParams instanceof URLSearchParams)) throw s3Input('url');
  if (typeof method !== 'string' || typeof accessKey !== 'string' || typeof secretKey !== 'string') throw s3Input('type');
  const o = opts || {};
  const region = o.region || '';
  const sessionToken = o.sessionToken || '';
  const amzDate = o.amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  if (typeof region !== 'string' || typeof sessionToken !== 'string' || typeof amzDate !== 'string') throw s3Input('type');
  if (![accessKey, region, sessionToken, amzDate].every((x) => x.isWellFormed())) throw s3Input('text');
  let body;
  try { body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || ''); } catch { throw s3Input('payload'); }
  if (body.length > MAX_S3_PAYLOAD_BYTES) throw new DavParseError('s3 payload is too large to sign', 'too_large');
  const query = [...url.searchParams.entries()];
  if (query.length > MAX_S3_QUERY_PAIRS) throw new DavParseError('s3 query is too large to sign', 'too_large');
  const secret = Buffer.from(secretKey, 'utf8');
  const fields = [encoder.encode(method), encoder.encode(url.host), encoder.encode(url.pathname), encoder.encode(accessKey), secret,
    encoder.encode(region), encoder.encode(sessionToken), encoder.encode(amzDate)];
  for (const [k, v] of query) fields.push(encoder.encode(k), encoder.encode(v));
  let input;
  try {
    if (fields.some((f) => f.length > MAX_S3_FIELD_BYTES)) throw new DavParseError('s3 field is too large to sign', 'too_large');
    input = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 4) + body.length);
    const view = new DataView(input.buffer);
    let at = 0;
    const put = (f) => { view.setUint32(at, f.length, true); input.set(f, at + 4); at += 4 + f.length; };
    fields.slice(0, 8).forEach(put);
    view.setUint32(at, query.length, true); at += 4;
    fields.slice(8).forEach(put);
    input.set(body, at);
  } finally {
    secret.fill(0);
  }
  const { status, bytes } = invokeSecret(input, (e) => e.s3_sign());
  if (status !== 0) throw s3Refusal(status, bytes);
  let reply;
  try { reply = JSON.parse(utf8(bytes)); } catch { throw new DavParseError('s3 sign reply is not JSON', 'reply'); }
  const names = ['host', 'x-amz-content-sha256', 'x-amz-date', ...(sessionToken ? ['x-amz-security-token'] : [])];
  const keys = reply && typeof reply === 'object' && !Array.isArray(reply) ? Object.keys(reply) : [];
  const auth = reply?.Authorization;
  const prefix = `AWS4-HMAC-SHA256 Credential=${accessKey}/${amzDate.slice(0, 8)}/${region || 'us-east-1'}/s3/aws4_request, SignedHeaders=${names.join(';')}, Signature=`;
  if (keys.join('\n') !== [...names, 'Authorization'].join('\n') || reply.host !== url.host || typeof reply['x-amz-content-sha256'] !== 'string' || !HEX64.test(reply['x-amz-content-sha256'])
    || reply['x-amz-date'] !== amzDate || (sessionToken && reply['x-amz-security-token'] !== sessionToken)
    || typeof auth !== 'string' || !auth.startsWith(prefix) || !HEX64.test(auth.slice(prefix.length))) {
    throw new DavParseError('s3 sign reply has an unexpected shape', 'reply');
  }
  const out = {};
  for (const k of [...names, 'Authorization']) out[k] = reply[k];
  return out;
}

/** s3-region.cjs normalizeS3Region, through the module. */
function s3Region(value) {
  const text = String(value || '');
  const input = encoder.encode(text);
  const { status, bytes } = invokeRaw(input, (e) => e.s3_region());
  if (status !== 0) throw s3Refusal(status, bytes);
  const region = utf8(bytes);
  if (!S3_REGION_TEXT.test(region)) throw new DavParseError('s3 region reply has an unexpected shape', 'reply');
  return region;
}

/** Test hook: the cached instance's linear memory in bytes (0 when there is none). */
function memoryBytes() { return cached?.instance ? cached.instance.exports.memory.buffer.byteLength : 0; }

// Every switch that runs this module (#996). Each reads its value as trim().toLowerCase().
// CHAT_TEMPLATE_CAPS_IMPL counts only when set to wasm explicitly; its default (also wasm) is
// checked by chat-template-caps.cjs startup(), which falls back to off instead of stopping.
const IMPL_FLAGS = ['DAV_PARSE_IMPL', 'S3_PARSE_IMPL', 'STORAGE_PATH_IMPL', 'UPLOAD_SNIFF_IMPL', 'SECRET_ENVELOPE_IMPL', 'MCP_FRAME_IMPL', 'CHAT_TEMPLATE_CAPS_IMPL', 'AUTOTUNE_PLAN_IMPL', 'PRESET_RELOAD_IMPL', 'PROMPT_FRAMING_IMPL', 'S3_SIGN_IMPL'];

/** The *_IMPL switches set to wasm in `env`. */
function wasmFlags(env = process.env) {
  return IMPL_FLAGS.filter((k) => String(env[k] ?? '').trim().toLowerCase() === 'wasm');
}

/** Startup check (#996): when any switch is wasm, load and verify the module now (lock, sha256,
 *  no imports, the full ABI) instead of failing on the first request. Returns the flags; throws
 *  an Error naming them and the reason when the module is unusable. */
/** The runtime URL behaviour prompt-framing's port was pinned against (Node 22's ada maps U+1E9E
 *  to "ss" in hosts; noevia-rs crates/prompt-framing idna_compat does the same). A runtime that
 *  disagrees would make JS and wasm hosts differ, so PROMPT_FRAMING_IMPL=wasm refuses to start. */
function framingRuntimeMatches(hostname = (h) => new URL(h).hostname) {
  try { return hostname('http://\u1e9e.io') === 'ss.io'; } catch { return false; }
}

function verifyAtStartup(env = process.env, { hostname } = {}) {
  const flags = wasmFlags(env);
  if (!flags.length) return flags;
  if (flags.includes('PROMPT_FRAMING_IMPL') && !framingRuntimeMatches(hostname)) {
    cached = null;
    throw Object.assign(new Error(`PROMPT_FRAMING_IMPL set to wasm, but this runtime's URL parser (Node ${process.version}) does not map U+1E9E to "ss" as the pinned port does (runtime)`), { reason: 'runtime', flags });
  }
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

module.exports = { s3Sign, s3Region, MAX_S3_FIELD_BYTES, MAX_S3_QUERY_PAIRS, MAX_S3_PAYLOAD_BYTES, wasmFlags, verifyAtStartup, framingRuntimeMatches, IMPL_FLAGS, frameUntrusted, escapeClosing, provenanceNew, provenanceIngest, provenanceAdd, provenanceSource, provenanceCheck, provenanceProbe, packetParse, packetValidate, packetRender, FRAME_TEXT_UNITS, FRAME_LABEL_UNITS, MAX_PROVENANCE_BYTES, MAX_PACKET_BYTES, listRecords, s3ListPage, storagePath, uploadValidate, uploadClassify, uploadDecode, secretOpen, secretSeal, mcpRpcBody, mcpSchemaRefs, templateCaps, providerErrorKind, servingVerdict, autotunePlan, autotunePlanText, MAX_PLAN_BYTES, presetReload, MAX_RELOAD_BYTES, loadVerdict, loadVerdictText, MAX_VERDICT_BYTES, tuneContention, tuneContentionText, MAX_CONTENTION_BYTES, longProfilePairs, longProfileSection, longProfilePick, longProfileText, MAX_LONG_PROFILE_BYTES, MAX_TEMPLATE_BYTES, MCP_BODY_UNITS, MCP_SCHEMA_UNITS, MAX_SECRET_PLAIN_BYTES, MAX_SECRET_UNITS, MAX_SECRET_USER_BYTES, load, readLock, reset, memoryBytes, DavParseError, DEFAULT_WASM, MAX_INPUT_BYTES, MAX_DECODE_BYTES, SNIFF_BYTES, RESET_AFTER_BYTES };
