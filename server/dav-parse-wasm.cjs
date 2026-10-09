'use strict';

// Loader for dav-parse.wasm: noevia-rs's storage parsers in one module, built from
// sbstndalton/noevia-rs (bins/dav-parse-wasm) at the ref in server/dav-parse.lock and placed at
// server/wasm/dav-parse.wasm by the image build (or DAV_PARSE_WASM). Node's built-in WebAssembly
// runs it: no imports, no WASI, no native addon. It carries three Rust ports, each behind its own
// switch (default js), except the ones marked always on (#1071: no JS twin at runtime, tests/server/oracle/ keeps it for the fixtures):
//   - crates/dav-parse      listRecords  = tests/server/oracle/dav-listing.cjs listingRecordsJs  (#967; always on, #1071)
//   - crates/s3-list-parse  s3ListPage   = tests/server/oracle/s3-listing.cjs s3PageRecordsJs    (#976; always on, #1071)
//   - crates/storage-path   storagePath  = storage-path.cjs's rules          (STORAGE_PATH_IMPL, #978)
//   - crates/upload-sniff   uploadValidate/uploadClassify/uploadDecode
//                                        = upload-sniff.cjs validate/classify/decodeText
//                                                                             (#977; always on, #1071)
//   - crates/secret-envelope secretOpen/secretSeal = secret-envelope.cjs openJs/encryptJs
//                                                                             (SECRET_ENVELOPE_IMPL, #979)
//   - crates/mcp-frame     mcpRpcBody/mcpSchemaRefs = mcp.cjs parseRpcBody/resolveSchemaRefs
//                                                                             (#980; always on, #1071)
//   - crates/chat-template-caps + provider-error  templateCaps/providerErrorKind/servingVerdict
//   - crates/autotune-plan  autotunePlan = auto-tune's next step                (always on, #1003/#1071)
//   - crates/preset-reload  presetReload = may the router re-read models.ini now (always on, #1012/#1071)
//   - crates/load-verdict   loadVerdict = why a failed auto-tune step failed   (always on, #1004/#1071)
//                                        new logic, no JS twin; see chat-template-caps.cjs
//                                                                             (always on, #1002/#1071)
//   - crates/tune-contention tuneContention = auto-tune vs another router client (always on; fails closed, #1062)
//   - crates/long-profile   longProfilePairs/longProfileSection/longProfilePick = a model's
//                           <id>-long profile: pairing, its models.ini section, the entry a chat
//                           is served by (always on; fails closed, #1079)
//   - crates/prompt-framing frameUntrusted/escapeClosing, provenance*, packet* = prompt-framing.cjs,
//                          provenance-policy.cjs, task-packet.cjs                (#769/#740; always on, #1071)
//   - crates/s3-sign        s3Sign/s3Region = s3-sign.cjs signS3Request, s3-region.cjs normalizeS3Region
//                                                                             (always on, #1071)
//   - crates/ssrf-policy   ssrfUrl/ssrfAddressesPublic = ssrf.cjs isPublicUrl (before DNS) and
//                          isPrivateIp, public-fetch.cjs's URL check             (#795; always on, #1071)
//   - crates/stream-guard  streamGuardNew/Feed/End/Check, streamGuardCorrection = stream-guard.cjs's
//                          IncrementalValidator and buildCorrectionRequest; the validator state is
//                          bytes held here between calls, nothing stays in the module (STREAM_GUARD_IMPL, #516/#704)
//   - crates/gguf (node)   ggufSummary = gguf-meta.cjs summarize(readGguf(file)) over the byte
//                          ranges the caller has read; file I/O stays in the JS (GGUF_META_IMPL)
//   - crates/policy-leaves authTokens = auth-tokens.cjs resolveAuthTokens (#294, a secret call);
//                          toolPolicyMode/toolPolicySet = tool-policy.cjs's decision and set()
//                          checks, the database stays in the JS (was POLICY_LEAVES_IMPL, retired #1071)
//   - crates/review-verdict reviewVerdictRead/reviewEventBound = code-review-verdict.cjs readVerdict
//                          and boundReviewEvent over a tagged copy of the JS value (was CODE_REVIEW_VERDICT_IMPL, retired #1071, #519)
//   - crates/tool-exchange toolExchangeCheck/toolExchangeError = tool-exchange.cjs's pre-run checks,
//                          dedupe key and failed-call text; the exchange stays in the JS (was TOOL_EXCHANGE_IMPL, retired #1071)
//   - crates/mcp-servers   mcpServersParse/mcpToolboxes/mcpToolboxOffered = mcp-servers.cjs
//                          parseMcpServers, parseEnabledToolboxes, toolboxOffered (was MCP_SERVERS_IMPL, retired #1071)
//   - crates/decision      decisionInvalidRequest/decisionInvalidResult/decisionCauseOf =
//                          decision/index.cjs's pure checks over a projection (was DECISION_IMPL, retired #1071)
//   - crates/code-net-guard codeNetSpec/codeNetResolved/codeNetRefuses = code-net-guard.cjs
//                          parseCodeNetSpec, resolveOnce's address filter and refuses (was CODE_NET_GUARD_IMPL, retired #1071)
//   - crates/role-context  roleContextProject/roleContextDossier = role-context.cjs
//                          projectRoleContext/projectSharedDossier, a secret call (ROLE_CONTEXT_IMPL)
//   - crates/completeness-report completenessReport = completeness-report.cjs
//                          buildCompletenessReport and reportHash (was COMPLETENESS_REPORT_IMPL, retired #1071)
//   - crates/task-lifecycle taskLifecycleCanTransition/Transition/StageMove/Fold/Derive =
//                          task-lifecycle.cjs's table, stage moves and journal fold (was TASK_LIFECYCLE_IMPL, retired #1071)
//   - crates/llamacpp-autoconfig llamacppAutoconfig = llamacpp-autoconfig.cjs suggest,
//                          estimateInputs, estimateFootprint and helpers (was LLAMACPP_AUTOCONFIG_IMPL, retired #1071)
//   - crates/code-actions  codeActionsClassify/Decide/Pick = code-actions.cjs classify, decide and
//                          pickOption over the host's projection (CODE_ACTIONS_IMPL)
//   - crates/project-file-names projectFileNames = project-file-names.cjs resolveProjectFile over
//                          the project's file names (PROJECT_FILE_NAMES_IMPL)
//   - crates/provider-egress providerEgress* = provider-egress.cjs isExternalProvider,
//                          isTrialTermsHost, egressRefusal, stripPrivateToolboxes, toolRefusal,
//                          canonicalPath and diaryFolderFor over the host's projections (PROVIDER_EGRESS_IMPL)
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
const net = require('node:net');
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
const EXPORTS = ['memory', 'dav_input', 'dav_list', 's3_list', 'storage_path', 'upload_validate', 'upload_classify', 'upload_decode', 'secret_open', 'secret_seal', 'mcp_rpc_body', 'mcp_schema_refs', 'template_caps', 'provider_error', 'serving_verdict', 'autotune_plan', 'preset_reload', 'load_verdict', 'tune_contention', 'frame_untrusted', 'escape_closing', 'provenance', 'task_packet', 'long_profile', 's3_sign', 's3_region', 'ssrf_policy', 'stream_guard', 'gguf_summary', 'auth_tokens', 'tool_policy', 'review_verdict', 'tool_exchange', 'mcp_servers', 'decision', 'code_net_guard', 'role_context', 'completeness_report', 'task_lifecycle', 'llamacpp_autoconfig', 'code_actions', 'project_file_names', 'provider_egress', 'dav_output_ptr', 'dav_output_len'];

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

/** tests/server/oracle/upload-sniff.cjs validateJs (#977), through the module: null when accepted, else
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

/** tests/server/oracle/upload-sniff.cjs classifyJs (#977), through the module. */
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

/** tests/server/oracle/upload-sniff.cjs decodeTextJs (#977), through the module: null (not text) or
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

// ssrf_policy (#795): the outbound-URL guard's decisions. ssrf_policy::MAX_INPUT_BYTES / MAX_ADDRESSES.
const MAX_SSRF_BYTES = 128 * 1024;
const MAX_SSRF_ADDRESSES = 512;
const SSRF_REASONS = new Set(['unparseable', 'scheme', 'credentials', 'private_address', 'blocked_name', 'trailing_dot', 'idn']);

function ssrfCall(request) {
  const bytes = encoder.encode(JSON.stringify(request));
  if (bytes.length > MAX_SSRF_BYTES) throw new DavParseError('ssrf policy request is too large', 'too_large');
  const r = invokeRaw(bytes, (e) => e.ssrf_policy());
  let reply;
  try { reply = JSON.parse(utf8(r.bytes)); } catch { throw new DavParseError('ssrf policy reply is not JSON', 'reply'); }
  if (r.status !== 0) {
    const code = reply && typeof reply.error === 'string' && ['input', 'too_large', 'input_not_utf8'].includes(reply.error) ? reply.error : 'unknown';
    throw new DavParseError(`ssrf policy request refused (${code})`, code);
  }
  return reply;
}

const exactKeys = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** The Rust decision for an outbound URL (#795): `{ ok: true, kind: 'ip'|'name', host }` or
 *  `{ ok: false, reason }`. mode 'check' is ssrf.cjs isPublicUrl before its DNS step, 'fetch'
 *  public-fetch.cjs before the socket (`loopback`: its QA allowLoopbackLiteral). An accepted host
 *  must equal Node's own `new URL(url).hostname` (brackets stripped): the socket uses Node's parse,
 *  so a parser difference is a refusal (`host_mismatch`), never a request to another host. */
function ssrfUrl(url, { mode, loopback = false } = {}) {
  if (typeof url !== 'string' || (mode !== 'check' && mode !== 'fetch') || typeof loopback !== 'boolean') throw new DavParseError('ssrf url input has the wrong type', 'input');
  // A lone surrogate cannot cross as JSON text that Rust accepts; refuse it here instead.
  if (!url.isWellFormed()) return { ok: false, reason: 'unparseable' };
  return ssrfUrlReply(ssrfCall({ op: 'url', url, mode, loopback }), url);
}

/** Check one `url` reply against its shape and against Node's parse of `url` (exported for tests). */
function ssrfUrlReply(r, url) {
  if (exactKeys(r, ['ok', 'reason']) && r.ok === false && SSRF_REASONS.has(r.reason)) return { ok: false, reason: r.reason };
  if (!(exactKeys(r, ['ok', 'kind', 'host']) && r.ok === true && (r.kind === 'ip' || r.kind === 'name') && typeof r.host === 'string' && r.host)) {
    throw new DavParseError('ssrf url reply has an unexpected shape', 'reply');
  }
  let nodeHost;
  try { nodeHost = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return { ok: false, reason: 'unparseable' }; }
  // A name must not be an IP literal to Node (it would never be looked up) and vice versa.
  if (nodeHost !== r.host || (r.kind === 'ip') !== (net.isIP(nodeHost) !== 0)) return { ok: false, reason: 'host_mismatch' };
  return { ok: true, kind: r.kind, host: r.host };
}

/** True when `addresses` is non-empty and every entry is a public IP literal (isPrivateIp false
 *  for all), decided by the Rust port (#795). */
function ssrfAddressesPublic(addresses) {
  if (!Array.isArray(addresses) || !addresses.every((a) => typeof a === 'string')) throw new DavParseError('ssrf addresses must be an array of text', 'input');
  if (addresses.length > MAX_SSRF_ADDRESSES) throw new DavParseError('too many addresses to check', 'too_large');
  // A lone surrogate is never part of an IP literal.
  if (!addresses.every((a) => a.isWellFormed())) return false;
  return ssrfAddressesReply(ssrfCall({ op: 'addresses', addresses }));
}

/** Check one `addresses` reply's shape (exported for tests). */
function ssrfAddressesReply(r) {
  if (!exactKeys(r, ['public']) || typeof r.public !== 'boolean') throw new DavParseError('ssrf addresses reply has an unexpected shape', 'reply');
  return r.public;
}

// stream_guard (#516, #704): stream-guard.cjs's IncrementalValidator and buildCorrectionRequest.
// stream_guard::{DEFAULT_MAX_DEPTH, DEFAULT_MAX_BYTES, MAX_GUARD_BYTES, MAX_DEPTH_CAP,
// MAX_SCHEMA_BYTES, MAX_STATE_BYTES, MAX_CORRECTION_UNITS, MAX_INPUT_BYTES}.
const STREAM_GUARD_DEFAULT_DEPTH = 64;
const STREAM_GUARD_DEFAULT_BYTES = 2 * 1024 * 1024;
const MAX_GUARD_BYTES = 2 * 1024 * 1024;
const MAX_GUARD_DEPTH = 1024;
const MAX_GUARD_SCHEMA_BYTES = 256 * 1024;
const MAX_GUARD_STATE_BYTES = 20 * 1024 * 1024;
// A message past this is cut to it first when a clip at most this applies (the cut cannot reach
// the reply); a path past it (only a key of over a million units can make one) is refused as
// too_large, and code-tool-schemas.cjs then answers with its fixed UNCHECKED correction instead.
const MAX_CORRECTION_UNITS = 1024 * 1024;
const MAX_GUARD_INPUT_BYTES = MAX_GUARD_STATE_BYTES + MAX_GUARD_SCHEMA_BYTES + 2 * MAX_GUARD_BYTES + 64;
const GUARD_REASONS = new Set(['max_bytes', 'unexpected_char', 'type_mismatch', 'max_depth', 'expected_key', 'expected_colon',
  'expected_comma_or_brace', 'expected_comma_or_bracket', 'unknown_property', 'missing_required', 'max_items',
  'invalid_unicode_escape', 'invalid_escape', 'max_length', 'enum_prefix', 'enum_string', 'invalid_number', 'not_integer',
  'enum_number', 'invalid_literal', 'enum_literal', 'unterminated_string', 'unterminated_literal', 'unterminated_container', 'no_value']);
const GUARD_REFUSALS = new Set(['too_large', 'input_shape', 'schema', 'state', 'options']);
const GUARD_STATE_MAGIC = [0x53, 0x47, 0x31, 0x00];

/** Plain JSON data only (what JSON.stringify writes back exactly): no undefined, functions,
 *  symbols, holes, accessors, class instances or non-finite numbers, at most 64 levels. */
function plainJson(v, depth = 0) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || depth >= 64) return false;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) if (!Object.hasOwn(v, i) || !plainJson(v[i], depth + 1)) return false;
    return Object.getOwnPropertyNames(v).length === v.length + 1;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(v).length) return false;
  for (const k of Object.getOwnPropertyNames(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d.enumerable || !('value' in d) || !plainJson(d.value, depth + 1)) return false;
  }
  return true;
}

/** A schema as the module reads it: `schema || {}` as UTF-8 JSON. Throws for anything else. */
function streamGuardSchema(schema) {
  const root = schema || null;
  if (!plainJson(root)) throw new DavParseError('stream-guard schema must be plain JSON data', 'input');
  const bytes = encoder.encode(JSON.stringify(root));
  if (bytes.length > MAX_GUARD_SCHEMA_BYTES) throw new DavParseError('stream-guard schema is too large', 'too_large');
  return bytes;
}

/** IncrementalValidator's option rule (`typeof x === 'number' ? x : default`), then the port's
 *  caps: an integer within ±1024 (maxDepth) / ±2 MiB (maxBytes). */
function streamGuardOptions(options = {}) {
  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : STREAM_GUARD_DEFAULT_DEPTH;
  const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : STREAM_GUARD_DEFAULT_BYTES;
  if (!Number.isInteger(maxDepth) || Math.abs(maxDepth) > MAX_GUARD_DEPTH || !Number.isInteger(maxBytes) || Math.abs(maxBytes) > MAX_GUARD_BYTES) {
    throw new DavParseError('stream-guard options are outside what the port takes', 'options');
  }
  return { maxDepth, maxBytes };
}

function guardRequest(parts) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  if (size > MAX_GUARD_INPUT_BYTES) throw new DavParseError('stream-guard request is too large', 'too_large');
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const u8 = (n) => Uint8Array.of(n);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const f64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, true); return b; };
const block = (b) => [u32(b.length), b];
/** The chunk after its oversize flag: a chunk longer than MAX_GUARD_BYTES units is at least that
 *  many UTF-8 bytes, so it exceeds every accepted maxBytes unread; only the flag crosses. */
function guardChunk(text) {
  if (text.length > MAX_GUARD_BYTES) return [u8(1)];
  const b = Buffer.from(text, 'utf16le');
  return [u8(0), new Uint8Array(b.buffer, b.byteOffset, b.length)];
}

function guardCall(parts) {
  const r = invokeRaw(guardRequest(parts), (e) => e.stream_guard(), MAX_GUARD_INPUT_BYTES);
  if (r.status !== 0) {
    let code = 'unknown';
    try { const e = JSON.parse(utf8(r.bytes)); if (exactKeys(e, ['error']) && GUARD_REFUSALS.has(e.error)) code = e.error; } catch { /* unknown */ }
    throw new DavParseError(`stream-guard request refused (${code})`, code);
  }
  return r.bytes;
}

/** Check a validator reply (`u32 n`, ASCII JSON, state) and return `{ violation, done, state }`;
 *  `withState` false for the one-shot check (exported for tests). */
function streamGuardReply(bytes, withState) {
  const bad = () => new DavParseError('stream-guard reply has an unexpected shape', 'reply');
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) throw bad();
  const n = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (4 + n > bytes.length) throw bad();
  const json = bytes.subarray(4, 4 + n);
  if (json.some((c) => c < 0x20 || c > 0x7e)) throw bad();
  let r;
  try { r = JSON.parse(utf8(json)); } catch { throw bad(); }
  if (!exactKeys(r, ['violation', 'done']) || typeof r.done !== 'boolean') throw bad();
  const v = r.violation;
  if (v !== null && !(exactKeys(v, ['message', 'path', 'reason']) && typeof v.message === 'string' && v.message
    && typeof v.path === 'string' && v.path.startsWith('$') && GUARD_REASONS.has(v.reason))) throw bad();
  if (v !== null && r.done && v.reason !== 'max_bytes') throw bad(); // only the cap can follow a finished document
  const state = bytes.slice(4 + n);
  if (withState ? (state.length < 4 || state.length > MAX_GUARD_STATE_BYTES || GUARD_STATE_MAGIC.some((c, i) => state[i] !== c)) : state.length) throw bad();
  return { violation: v && { message: v.message, path: v.path, reason: v.reason }, done: r.done, state: withState ? state : null };
}

/** A fresh validator state for `schema` (the bytes from streamGuardSchema) and its options. */
function streamGuardNew(schemaBytes, { maxDepth, maxBytes }) {
  const r = streamGuardReply(guardCall([u8(0), f64(maxDepth), f64(maxBytes), ...block(schemaBytes)]), true);
  if (r.violation || r.done) throw new DavParseError('stream-guard reply has an unexpected shape', 'reply');
  return r.state;
}

/** feed(text) on a held state: `{ violation, done, state }`. */
function streamGuardFeed(schemaBytes, state, text) {
  if (typeof text !== 'string' || !(state instanceof Uint8Array)) throw new DavParseError('stream-guard feed input has the wrong type', 'input');
  return streamGuardReply(guardCall([u8(1), ...block(schemaBytes), ...block(state), ...guardChunk(text)]), true);
}

/** end() on a held state: `{ violation, done, state }`. */
function streamGuardEnd(schemaBytes, state) {
  if (!(state instanceof Uint8Array)) throw new DavParseError('stream-guard end input has the wrong type', 'input');
  return streamGuardReply(guardCall([u8(2), ...block(schemaBytes), ...block(state)]), true);
}

/** `feed(text) || end()` on a fresh validator, in one call: `{ violation, done }`. */
function streamGuardCheck(schemaBytes, { maxDepth, maxBytes }, text) {
  if (typeof text !== 'string') throw new DavParseError('stream-guard check input has the wrong type', 'input');
  return streamGuardCheckReply(guardCall([u8(3), f64(maxDepth), f64(maxBytes), ...block(schemaBytes), ...guardChunk(text)]));
}

/** A one-shot check reply: it ran end(), so it holds a violation or a finished document; neither
 *  is a module fault (exported for tests). */
function streamGuardCheckReply(bytes) {
  const r = streamGuardReply(bytes, false);
  if (!r.violation && !r.done) throw new DavParseError('stream-guard check reply has neither a violation nor a document', 'reply');
  return { violation: r.violation, done: r.done };
}

/** stream-guard.cjs buildCorrectionRequest({ message: message.slice(0, clip), path: path || null })
 *  through the module; `clip` null for none. */
function streamGuardCorrection(message, path, clip = null) {
  if (typeof message !== 'string' || !(path === null || typeof path === 'string') || !(clip === null || (Number.isInteger(clip) && clip >= 0 && clip < 0xffffffff))) {
    throw new DavParseError('stream-guard correction input has the wrong type', 'input');
  }
  // Units past the clip cannot reach the reply, so a long message may be cut at the cap first.
  const m = clip !== null && clip <= MAX_CORRECTION_UNITS ? message.slice(0, MAX_CORRECTION_UNITS) : message;
  if (m.length > MAX_CORRECTION_UNITS || (path && path.length > MAX_CORRECTION_UNITS)) throw new DavParseError('stream-guard correction is too large', 'too_large');
  const units = (s) => { const b = Buffer.from(s, 'utf16le'); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
  const bytes = guardCall([u32(clip === null ? 0xffffffff : clip), u8(path === null ? 0 : 1), u32(m.length), units(m), units(path || '')].flatMap((p, i) => (i === 0 ? [u8(4), p] : [p])));
  let r;
  try { r = JSON.parse(utf8(bytes)); } catch { throw new DavParseError('stream-guard correction reply is not JSON', 'reply'); }
  const expected = clip === null ? message : message.slice(0, clip);
  if (!exactKeys(r, ['type', 'violation']) || r.type !== 'schema_violation_correction' || !exactKeys(r.violation, ['message', 'path'])
    || r.violation.message !== expected || r.violation.path !== (path || null)) {
    throw new DavParseError('stream-guard correction reply has an unexpected shape', 'reply');
  }
  return { type: r.type, violation: { message: r.violation.message, path: r.violation.path } };
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

/** tests/server/oracle/s3-sign.cjs signS3RequestJs, through the module (always, #1071). Same arguments and the
 *  same headers object (same keys, same order). `url` is what the JS reads: a string `host` and
 *  `pathname` and a URLSearchParams `searchParams` (a URL). The method, secret and payload are
 *  passed as UTF-8 (a lone surrogate as U+FFFD, exactly what the JS hashes). Text echoed in the
 *  headers (access key, region, token, date) must be well-formed: the JS would send a lone
 *  surrogate the module cannot express, so that is refused. The input (with the secret key) is
 *  zeroed and the instance's memory wiped after the call; errors carry a reason, never input. */
function s3Sign(method, url, payload, accessKey, secretKey, opts = {}) {
  if (!url || typeof url.host !== 'string' || typeof url.pathname !== 'string' || !(url.searchParams instanceof URLSearchParams)) throw s3Input('url');
  if (typeof method !== 'string' || typeof accessKey !== 'string' || typeof secretKey !== 'string') throw s3Input('type');
  // The JS reads opts.region etc. and throws on null; a non-object is refused the same way.
  if (opts === null || typeof opts !== 'object') throw s3Input('opts');
  const o = opts;
  const region = o.region || '';
  const sessionToken = o.sessionToken || '';
  const amzDate = o.amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  if (typeof region !== 'string' || typeof sessionToken !== 'string' || typeof amzDate !== 'string') throw s3Input('type');
  // The pathname too: the JS's encodeURIComponent throws on a lone surrogate there.
  if (![url.pathname, accessKey, region, sessionToken, amzDate].every((x) => x.isWellFormed())) throw s3Input('text');
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

// --- gguf-meta (GGUF_META_IMPL) ---------------------------------------------------------------
// gguf::node::MAX_WINDOW_BYTES / MAX_SEGMENTS: the file bytes one call takes, in how many ranges.
const MAX_GGUF_WINDOW_BYTES = 24 * 1024 * 1024;
const MAX_GGUF_SEGMENTS = 512;
const GGUF_FAILS = new Set(['not_gguf', 'limit', 'eof', 'range', 'nested']);
const GGUF_SUMMARY_KEYS = ['arch', 'name', 'contextLength', 'embeddingLength', 'blockCount', 'headCount', 'headCountKv', 'keyLength', 'valueLength', 'keyLengthSwa', 'valueLengthSwa', 'slidingWindow', 'slidingWindowPattern', 'sharedKvLayers', 'fullAttentionInterval', 'ssmStateSize', 'expertCount', 'nextnPredictLayers', 'hasChatTemplate'];
const GGUF_RAW_KEYS = new Set(['headCountKv', 'slidingWindowPattern']);
const NUM_TAGS = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };

/** One number of a summary reply: a JSON number or `{"$num":…}` for what JSON cannot carry. */
function ggufNumber(v) {
  if (typeof v === 'number') return v;
  if (exactKeys(v, ['$num']) && Object.hasOwn(NUM_TAGS, v.$num)) return NUM_TAGS[v.$num];
  return undefined;
}
/** A raw kv value: number, boolean, string, null, a list of values, or `{array: true, count}`. */
function ggufValue(v, depth = 0) {
  if (depth > 64) throw new DavParseError('gguf reply nests too deeply', 'reply');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  const n = ggufNumber(v);
  if (n !== undefined) return n;
  if (Array.isArray(v)) return v.map((x) => ggufValue(x, depth + 1));
  if (exactKeys(v, ['array', 'count']) && v.array === true && Number.isSafeInteger(v.count) && v.count > 1024) return { array: true, count: v.count };
  throw new DavParseError('gguf reply has an unexpected value', 'reply');
}
/** Check a summary reply's shape and revive its numbers (exported for tests). */
function ggufSummaryReply(s) {
  if (!exactKeys(s, GGUF_SUMMARY_KEYS)) throw new DavParseError('gguf summary has unexpected keys', 'reply');
  if (typeof s.arch !== 'string' || typeof s.name !== 'string' || typeof s.hasChatTemplate !== 'boolean') throw new DavParseError('gguf summary has unexpected types', 'reply');
  const out = {};
  for (const k of GGUF_SUMMARY_KEYS) {
    if (k === 'arch' || k === 'name' || k === 'hasChatTemplate') out[k] = s[k];
    else if (GGUF_RAW_KEYS.has(k)) out[k] = ggufValue(s[k]);
    else if (s[k] === null) out[k] = null;
    else {
      const n = ggufNumber(s[k]);
      if (n === undefined) throw new DavParseError('gguf summary has an unexpected number', 'reply');
      out[k] = n;
    }
  }
  return out;
}

/** gguf-meta.cjs summarize(readGguf(file)) over `segments` ([{ off, bytes }], sorted, disjoint,
 *  non-empty byte ranges of a file of `size` bytes). Returns `{ summary }`, `{ need: { at, end } }`
 *  (read the file from `at` to at least `end`, as one range, and ask again) or `{ fail, value? }`
 *  (the error the JS throws). A refusal or a bad reply throws. */
function ggufSummary(size, segments) {
  if (!Number.isSafeInteger(size) || size < 0 || !Array.isArray(segments)) throw new DavParseError('gguf input has the wrong type', 'input');
  if (segments.length > MAX_GGUF_SEGMENTS) throw new DavParseError('gguf input has too many ranges', 'too_large');
  let floor = 0, total = 0;
  for (const s of segments) {
    if (!s || !Number.isSafeInteger(s.off) || !(s.bytes instanceof Uint8Array) || !s.bytes.length || s.off < floor || s.off + s.bytes.length > size) throw new DavParseError('gguf input ranges are not sorted, disjoint and inside the file', 'input');
    floor = s.off + s.bytes.length;
    total += s.bytes.length;
  }
  if (total > MAX_GGUF_WINDOW_BYTES) throw new DavParseError('gguf input is too large', 'too_large');
  const input = new Uint8Array(12 + 12 * segments.length + total);
  const view = new DataView(input.buffer);
  view.setBigUint64(0, BigInt(size), true);
  view.setUint32(8, segments.length, true);
  let at = 12 + 12 * segments.length;
  segments.forEach((s, i) => {
    view.setBigUint64(12 + 12 * i, BigInt(s.off), true);
    view.setUint32(20 + 12 * i, s.bytes.length, true);
    input.set(s.bytes, at);
    at += s.bytes.length;
  });
  // Up to 24 MiB of header: the module-wide cap (MAX_DECODE_BYTES), not the 16 MiB listing one.
  const r = invoke(input, (e) => e.gguf_summary(), MAX_DECODE_BYTES);
  if (exactKeys(r, ['summary'])) return { summary: ggufSummaryReply(r.summary) };
  if (exactKeys(r, ['need']) && exactKeys(r.need, ['at', 'end'])) {
    const { at: from, end } = r.need;
    const held = segments.some((s) => s.off <= from && end <= s.off + s.bytes.length);
    if (Number.isSafeInteger(from) && Number.isSafeInteger(end) && from >= 0 && from < end && end <= size && !held) return { need: { at: from, end } };
  }
  if (exactKeys(r, ['fail']) && GGUF_FAILS.has(r.fail)) return { fail: r.fail };
  if (exactKeys(r, ['fail', 'value']) && (r.fail === 'version' || r.fail === 'type') && Number.isInteger(r.value) && r.value >= 0 && r.value <= 0xffffffff) return { fail: r.fail, value: r.value };
  throw new DavParseError('gguf reply has an unexpected shape', 'reply');
}

// --- policy leaves (POLICY_LEAVES_IMPL) -------------------------------------------------------
// policy_leaves::MAX_UNITS / MAX_TOOLS.
const MAX_POLICY_UNITS = 65536;
const MAX_POLICY_TOOLS = 65536;
const AUTH_WARNINGS = new Set([
  'WARNING: Set DIARY_AUTH_TOKEN to protect the internal diary connection. Browser accounts remain authenticated.',
  'WARNING: LEGACY_AUTH_COMPAT is true but UI_AUTH_TOKEN is empty; the legacy bearer sign-in has no token to check requests against.',
]);
const POLICY_MODES = new Set(['allow', 'ask', 'block']);
const POLICY_REASONS = new Set(['mode', 'empty', 'write']);

/** `u8(0)` for a non-string, `u8(1) u32le(n) units` for a string. */
function policyString(v) {
  if (typeof v !== 'string') return new Uint8Array([0]);
  if (v.length > MAX_POLICY_UNITS) throw new DavParseError('policy input is too large', 'too_large');
  const u = utf16le(v), out = new Uint8Array(5 + u.length);
  out[0] = 1; new DataView(out.buffer).setUint32(1, v.length, true); out.set(u, 5);
  u.fill(0);
  return out;
}
const concatBytes = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; p.fill(0); }
  return out;
};

/** auth-tokens.cjs resolveAuthTokens through the Rust port: `diary` and `ui` are the coerced
 *  strings, `compat` LEGACY_AUTH_COMPAT as given. A secret call: nothing of the input or reply
 *  outlives it in the module, and no error carries any of it. */
function authTokens(diary, ui, compat) {
  if (typeof diary !== 'string' || typeof ui !== 'string') throw new DavParseError('auth tokens input has the wrong type', 'input');
  const { status, bytes } = invokeSecret(concatBytes([policyString(diary), policyString(ui), policyString(compat)]), (e) => e.auth_tokens());
  if (status !== 0) {
    let code = 'unknown';
    try { const r = JSON.parse(utf8(bytes)); if (r && (r.error === 'input' || r.error === 'too_large')) code = r.error; } catch { /* keep unknown */ }
    bytes.fill(0);
    throw new DavParseError(`auth tokens refused by dav-parse (${code})`, code);
  }
  let r;
  try { r = JSON.parse(utf8(bytes)); } catch { r = null; } finally { bytes.fill(0); }
  if (!(exactKeys(r, ['diaryToken', 'uiAuthToken', 'legacyCompat', 'warnings']) && typeof r.diaryToken === 'string' && typeof r.uiAuthToken === 'string'
    && typeof r.legacyCompat === 'boolean' && Array.isArray(r.warnings) && r.warnings.length <= 2 && r.warnings.every((w) => AUTH_WARNINGS.has(w)))) {
    throw new DavParseError('auth tokens reply has an unexpected shape', 'reply');
  }
  return { diaryToken: r.diaryToken, uiAuthToken: r.uiAuthToken, legacyCompat: r.legacyCompat, warnings: [...r.warnings] };
}

/** tool-policy.cjs mode() through the Rust port: `stored` the row's mode (undefined/null: none). */
function toolPolicyMode(stored, isWrite) {
  if (typeof isWrite !== 'boolean') throw new DavParseError('tool policy input has the wrong type', 'input');
  const input = concatBytes([new Uint8Array([1]), policyString(stored), new Uint8Array([isWrite ? 1 : 0])]);
  const r = invoke(input, (e) => e.tool_policy());
  if (exactKeys(r, ['mode']) && POLICY_MODES.has(r.mode)) return r.mode;
  throw new DavParseError('tool policy reply has an unexpected shape', 'reply');
}

/** tool-policy.cjs set()'s checks through the Rust port: `{ ok: true, mode }` or `{ ok: false, reason }`. */
function toolPolicySet(value, writes) {
  if (!Array.isArray(writes) || !writes.every((w) => typeof w === 'boolean')) throw new DavParseError('tool policy input has the wrong type', 'input');
  if (writes.length > MAX_POLICY_TOOLS) throw new DavParseError('too many tools to check', 'too_large');
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, writes.length, true);
  const input = concatBytes([new Uint8Array([2]), policyString(value), count, Uint8Array.from(writes, (w) => (w ? 1 : 0))]);
  const r = invoke(input, (e) => e.tool_policy());
  if (exactKeys(r, ['ok', 'mode']) && r.ok === true && POLICY_MODES.has(r.mode)) return { ok: true, mode: r.mode };
  if (exactKeys(r, ['ok', 'reason']) && r.ok === false && POLICY_REASONS.has(r.reason)) return { ok: false, reason: r.reason };
  throw new DavParseError('tool policy reply has an unexpected shape', 'reply');
}

// --- review verdict (CODE_REVIEW_VERDICT_IMPL) -------------------------------------------------
// review_verdict::MAX_INPUT_BYTES (the op byte and the tagged JSON).
const MAX_REVIEW_BYTES = 4 * 1024 * 1024 + 1;
// Containers deeper than this, and arrays or objects with more entries, cross as ['x']: the port
// never looks inside them (readVerdict only looks three levels down).
const REVIEW_TAG_DEPTH = 3;
const REVIEW_TAG_ENTRIES = 65536;
const REVIEW_VERDICTS = new Set(['approve', 'request_changes']);
const REVIEW_SEVERITIES = new Set(['blocker', 'major', 'minor', 'note']);
const REVIEW_INVALID = new Set(['fields', 'verdict', 'missing', 'too_many', 'malformed', 'no_message', 'no_summary', 'unspecified', 'blocked']);
const REVIEW_SHA = /^[0-9a-f]{7,64}$/;

/** A JS value in review-verdict's tagged JSON form (see that crate's docs): what JSON.stringify
 *  would lose (undefined, -0, NaN, functions, keys holding undefined) crosses explicitly, and any
 *  object that is not a plain object or a dense plain array crosses as ['x']. */
function reviewTag(v, depth = 0) {
  if (v === undefined) return ['u'];
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return ['n', '-0'];
    if (Number.isNaN(v)) return ['n', 'NaN'];
    if (!Number.isFinite(v)) return ['n', v > 0 ? 'Infinity' : '-Infinity'];
    return v;
  }
  if (typeof v !== 'object') return ['f'];
  if (depth >= REVIEW_TAG_DEPTH) return ['x'];
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype || v.length > REVIEW_TAG_ENTRIES) return ['x'];
    const items = [];
    for (let i = 0; i < v.length; i++) {
      if (!Object.hasOwn(v, i)) return ['x'];
      items.push(reviewTag(v[i], depth + 1));
    }
    return ['a', items];
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return ['x'];
  const keys = Object.keys(v);
  if (keys.length > REVIEW_TAG_ENTRIES) return ['x'];
  return ['o', keys.map((k) => [k, reviewTag(v[k], depth + 1)])];
}

function reviewRequest(op, value) {
  const body = encoder.encode(JSON.stringify(value));
  if (body.length + 1 > MAX_REVIEW_BYTES) throw new DavParseError('review verdict input is too large', 'too_large');
  const input = new Uint8Array(body.length + 1);
  input[0] = op; input.set(body, 1);
  return invoke(input, (e) => e.review_verdict(), MAX_REVIEW_BYTES);
}

const codePoints = (s) => Array.from(s).length;
const cleanText = (s, max) => typeof s === 'string' && s.length > 0 && codePoints(s) <= max;

/** A verdict reply as readVerdict returns it, checked: the schema's fields only, cleaned text
 *  within its limits, and consistent (request_changes lists something, approve has no blocker). */
function reviewVerdictReply(v) {
  if (!exactKeys(v, ['verdict', 'summary', 'findings']) || !REVIEW_VERDICTS.has(v.verdict) || !cleanText(v.summary, 600)
    || !Array.isArray(v.findings) || v.findings.length > 12) throw new DavParseError('review verdict reply has an unexpected shape', 'reply');
  const findings = v.findings.map((f) => {
    const withFile = exactKeys(f, ['severity', 'file', 'message']);
    if (!(withFile || exactKeys(f, ['severity', 'message'])) || !REVIEW_SEVERITIES.has(f.severity) || !cleanText(f.message, 600)
      || (withFile && !cleanText(f.file, 240))) throw new DavParseError('review verdict reply has an unexpected finding', 'reply');
    return withFile ? { severity: f.severity, file: f.file, message: f.message } : { severity: f.severity, message: f.message };
  });
  if ((v.verdict === 'request_changes' && !findings.length) || (v.verdict === 'approve' && findings.some((f) => f.severity === 'blocker'))) {
    throw new DavParseError('review verdict reply is inconsistent', 'reply');
  }
  return { verdict: v.verdict, summary: v.summary, findings };
}

/** code-review-verdict.cjs readVerdict(raw) through the Rust port: `{ verdict }` (the cleaned
 *  verdict) or `{ invalid: code }` (which ReviewVerdictError the JS throws). A refusal (including
 *  'opaque': the JS would look inside an object the port is not shown) or a bad reply throws. */
function reviewVerdictRead(raw) {
  const r = reviewRequest(1, reviewTag(raw));
  if (exactKeys(r, ['verdict'])) return { verdict: reviewVerdictReply(r.verdict) };
  if (exactKeys(r, ['invalid']) && REVIEW_INVALID.has(r.invalid)) return { invalid: r.invalid };
  throw new DavParseError('review verdict reply has an unexpected shape', 'reply');
}

const reviewSha = (v) => v === null || (typeof v === 'string' && REVIEW_SHA.test(v));

/** code-review-verdict.cjs boundReviewEvent(type, data) through the Rust port (`data` after the
 *  JS's `= {}` default). Returns the event, checked; a refusal or bad reply throws. */
function reviewEventBound(type, data) {
  const r = reviewRequest(2, [reviewTag(type), reviewTag(data)]);
  const e = exactKeys(r, ['event']) ? r.event : null;
  const base = (x) => x.reviewer === 'planner' && reviewSha(x.baseSha) && reviewSha(x.headSha);
  if (e && e.status === 'pending' && exactKeys(e, ['status', 'reviewer', 'baseSha', 'headSha', 'files']) && base(e)
    && (e.files === null || (Number.isInteger(e.files) && e.files >= 0 && e.files <= 100000))) {
    return { status: 'pending', reviewer: 'planner', baseSha: e.baseSha, headSha: e.headSha, files: e.files };
  }
  if (e && e.status === 'failed' && exactKeys(e, ['status', 'reviewer', 'baseSha', 'headSha', 'code', 'reason']) && base(e)
    && cleanText(e.code, 40) && cleanText(e.reason, 300)) {
    return { status: 'failed', reviewer: 'planner', baseSha: e.baseSha, headSha: e.headSha, code: e.code, reason: e.reason };
  }
  if (e && e.status === 'completed' && exactKeys(e, ['status', 'reviewer', 'baseSha', 'headSha', 'verdict', 'summary', 'findings', 'corrected'])
    && base(e) && typeof e.corrected === 'boolean') {
    const v = reviewVerdictReply({ verdict: e.verdict, summary: e.summary, findings: e.findings });
    return { status: 'completed', reviewer: 'planner', baseSha: e.baseSha, headSha: e.headSha, ...v, corrected: e.corrected };
  }
  throw new DavParseError('review event reply has an unexpected shape', 'reply');
}

// --- tool exchange (TOOL_EXCHANGE_IMPL) ---------------------------------------------------------
// tool_exchange::MAX_ARGS_UNITS / MAX_NAME_UNITS / MAX_INPUT_BYTES.
const MAX_EXCHANGE_ARGS_UNITS = 4 * 1024 * 1024;
const MAX_EXCHANGE_NAME_UNITS = 65536;
const MAX_EXCHANGE_BYTES = 1 + 2 + 4 + 2 * MAX_EXCHANGE_NAME_UNITS + 1 + 2 * MAX_EXCHANGE_ARGS_UNITS;

const exchangeString = (s) => {
  const out = new Uint8Array(4 + 2 * s.length);
  new DataView(out.buffer).setUint32(0, s.length, true);
  out.set(utf16le(s), 4);
  return out;
};

function exchangeInvoke(parts) {
  const input = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { input.set(p, at); at += p.length; }
  const { status, bytes } = invokeRaw(input, (e) => e.tool_exchange(), MAX_EXCHANGE_BYTES);
  if (status !== 0) {
    let code = 'unknown';
    try { const r = JSON.parse(utf8(bytes)); if (r && typeof r.error === 'string') code = r.error; } catch { /* keep unknown */ }
    throw new DavParseError(`tool exchange refused by dav-parse (${code})`, code);
  }
  if (!bytes.length || bytes[0] > 1) throw new DavParseError('tool exchange reply has an unexpected tag', 'reply');
  return { tag: bytes[0], text: fromUtf16le(bytes.subarray(1)) };
}

/** tool-exchange.cjs's checks before a tool runs, through the Rust port. `args` is null for the
 *  JS's falsy `call.args`, else `String(call.args)`. Returns `{ key }` (run it, deduplicated on
 *  key) or `{ answer }` (the tool result; do not run it). A refusal or bad reply throws. */
function toolExchangeCheck(aborted, allowed, name, args) {
  if (typeof aborted !== 'boolean' || typeof allowed !== 'boolean' || typeof name !== 'string' || (args !== null && typeof args !== 'string')) {
    throw new DavParseError('tool exchange input has the wrong type', 'input');
  }
  if (name.length > MAX_EXCHANGE_NAME_UNITS || (args !== null && args.length > MAX_EXCHANGE_ARGS_UNITS)) throw new DavParseError('tool exchange input is too large', 'too_large');
  const parts = [Uint8Array.of(1, aborted ? 1 : 0, allowed ? 1 : 0), exchangeString(name), Uint8Array.of(args === null ? 0 : 1)];
  if (args !== null) parts.push(utf16le(args));
  const { tag, text } = exchangeInvoke(parts);
  if (tag === 1) {
    if (!text.startsWith('ERROR: ')) throw new DavParseError('tool exchange answer has an unexpected shape', 'reply');
    return { answer: text };
  }
  // The key is JSON.stringify([name, canonical]): check it is exactly that shape for this name.
  let k;
  try { k = JSON.parse(text); } catch { k = null; }
  if (!(Array.isArray(k) && k.length === 2 && k[0] === name && typeof k[1] === 'string' && k[1].startsWith('{') && k[1].endsWith('}'))) {
    throw new DavParseError('tool exchange key has an unexpected shape', 'reply');
  }
  return { key: text };
}

/** `ERROR calling <name>: <message, first 300 units>` through the Rust port; `message` is the
 *  coerced text (only its first MAX_EXCHANGE_NAME_UNITS units cross). */
function toolExchangeError(name, message) {
  if (typeof name !== 'string' || typeof message !== 'string') throw new DavParseError('tool exchange input has the wrong type', 'input');
  if (name.length > MAX_EXCHANGE_NAME_UNITS) throw new DavParseError('tool exchange input is too large', 'too_large');
  const { tag, text } = exchangeInvoke([Uint8Array.of(2), exchangeString(name), exchangeString(message.slice(0, MAX_EXCHANGE_NAME_UNITS))]);
  if (tag !== 1 || !text.startsWith(`ERROR calling ${name}: `)) throw new DavParseError('tool exchange error text has an unexpected shape', 'reply');
  return text;
}

// --- mcp servers (MCP_SERVERS_IMPL) -------------------------------------------------------------
// mcp_servers::MAX_INPUT_BYTES (the op byte and the JSON).
const MAX_MCP_SERVERS_BYTES = 1024 * 1024 + 1;
const MCP_AUTHS = new Set(['none', 'nextcloud', 'internal', 'bearer']);

function opJson(op, value, max, call, what) {
  const body = encoder.encode(JSON.stringify(value));
  if (body.length + 1 > max) throw new DavParseError(`${what} input is too large`, 'too_large');
  const input = new Uint8Array(body.length + 1);
  input[0] = op; input.set(body, 1);
  return invoke(input, call, max);
}
const mcpRequest = (op, value) => opJson(op, value, MAX_MCP_SERVERS_BYTES, (e) => e.mcp_servers(), 'mcp servers');
const nullOrString = (v) => v === null || typeof v === 'string';

/** mcp-servers.cjs parseMcpServers through the Rust port, given MCP_SERVERS and MCP_SERVER_URL
 *  (string or null). Returns `{ servers, warnings }`, shape-checked: a warning is its text or
 *  `{ bearer, id }` (print only when that variable is unset). mcp-servers.cjs checks the servers
 *  against the JS's rules again. A refusal or bad reply throws. */
function mcpServersParse(list, single) {
  if (!nullOrString(list) || !nullOrString(single)) throw new DavParseError('mcp servers input has the wrong type', 'input');
  const r = mcpRequest(1, [list, single]);
  if (!exactKeys(r, ['servers', 'warnings']) || !Array.isArray(r.servers) || !Array.isArray(r.warnings)) throw new DavParseError('mcp servers reply has an unexpected shape', 'reply');
  for (const sv of r.servers) {
    const bearer = sv?.auth === 'bearer';
    if (!exactKeys(sv, bearer ? ['id', 'url', 'auth', 'tokenEnv'] : ['id', 'url', 'auth']) || typeof sv.id !== 'string' || typeof sv.url !== 'string'
      || !MCP_AUTHS.has(sv.auth) || (bearer && typeof sv.tokenEnv !== 'string')) throw new DavParseError('mcp servers reply has an unexpected server', 'reply');
  }
  for (const w of r.warnings) {
    if (typeof w !== 'string' && !(exactKeys(w, ['bearer', 'id']) && /^[A-Z0-9_]+$/.test(w.bearer) && typeof w.id === 'string')) {
      throw new DavParseError('mcp servers reply has an unexpected warning', 'reply');
    }
  }
  return { servers: r.servers, warnings: r.warnings };
}

/** mcp-servers.cjs parseEnabledToolboxes through the Rust port: null (offer everything) or the
 *  distinct non-empty ids. A refusal or bad reply throws. */
function mcpToolboxes(raw) {
  if (!nullOrString(raw)) throw new DavParseError('mcp toolboxes input has the wrong type', 'input');
  const r = mcpRequest(2, raw);
  const ids = exactKeys(r, ['enabled']) ? r.enabled : undefined;
  if (ids === null) return null;
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string' && x.length > 0) || new Set(ids).size !== ids.length) {
    throw new DavParseError('mcp toolboxes reply has an unexpected shape', 'reply');
  }
  return ids;
}

/** toolboxOffered(id) through the Rust port, `enabled` null or the ids. */
function mcpToolboxOffered(enabled, id) {
  if (typeof id !== 'string' || !(enabled === null || (Array.isArray(enabled) && enabled.every((x) => typeof x === 'string')))) {
    throw new DavParseError('mcp toolbox input has the wrong type', 'input');
  }
  const r = mcpRequest(3, [enabled, id]);
  if (!exactKeys(r, ['offered']) || typeof r.offered !== 'boolean') throw new DavParseError('mcp toolbox reply has an unexpected shape', 'reply');
  return r.offered;
}

// --- decision (DECISION_IMPL) -------------------------------------------------------------------
// decision::MAX_INPUT_BYTES (the op byte and the tagged JSON).
const MAX_DECISION_BYTES = 4 * 1024 * 1024 + 1;
// Arrays longer than this, sparse ones and ones with another prototype cross as ['h', length]; an
// object with more keys as ['x'].
const DECISION_ENTRIES = 65536;
// A TypeError message longer than this is not read (causeOf answers 'exception').
const MAX_DECISION_MESSAGE_UNITS = 1024 * 1024;
const REQUEST_INVALID = new Set(['not an object', 'unknown kind', 'purpose required', 'fallback required', 'deadlineMs required', 'rank needs items', 'options required']);
const RESULT_INVALID = new Set(['no scores', 'score for an id that was not offered', 'non-numeric score', 'ranking outside the items', 'duplicate in ranking', 'choice outside the options']);
const DECISION_CAUSE = /^[a-z][a-z0-9-]{0,39}$/;

/** A value the port never looks inside (decision crate docs): scalars as review-verdict's tagged
 *  form, every object ['x'], functions, symbols and bigints ['f']. */
function decisionLeaf(v) {
  if (v === undefined) return ['u'];
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return ['n', '-0'];
    if (Number.isNaN(v)) return ['n', 'NaN'];
    if (!Number.isFinite(v)) return ['n', v > 0 ? 'Infinity' : '-Infinity'];
    return v;
  }
  return typeof v === 'object' ? ['x'] : ['f'];
}
const isObjectLike = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');
function decisionList(x, each) {
  if (!Array.isArray(x)) return decisionLeaf(x);
  if (Object.getPrototypeOf(x) !== Array.prototype || x.length > DECISION_ENTRIES) return ['h', x.length];
  const out = [];
  for (let i = 0; i < x.length; i++) {
    if (!Object.hasOwn(x, i)) return ['h', x.length];
    out.push(each(x[i]));
  }
  return ['a', out];
}
// An option or item: only its id is read (`.id` of a primitive is undefined; of null it throws).
const decisionItem = (o) => (isObjectLike(o) ? ['o', [['id', decisionLeaf(o.id)]]] : decisionLeaf(o));

/** The request as invalidRequest / invalidResult read it. */
function decisionRequestTag(r) {
  if (r === null || typeof r !== 'object') return decisionLeaf(r);
  const c = r.constraints;
  return ['o', [
    ['kind', decisionLeaf(r.kind)], ['purpose', decisionLeaf(r.purpose)], ['fallback', decisionLeaf(r.fallback)],
    ['constraints', isObjectLike(c) ? ['o', [['deadlineMs', decisionLeaf(c.deadlineMs)]]] : decisionLeaf(c)],
    ['items', decisionList(r.items, decisionItem)], ['options', decisionList(r.options, decisionItem)],
  ]];
}

/** A backend's answer as invalidResult reads it: scores' own keys and values, selected. */
function decisionResultTag(result) {
  if (result === null || typeof result !== 'object') return decisionLeaf(result);
  const s = result.scores;
  let scores = decisionLeaf(s);
  if (s !== null && typeof s === 'object') {
    const keys = Object.keys(s);
    scores = keys.length > DECISION_ENTRIES ? ['x'] : ['o', keys.map((k) => [k, decisionLeaf(s[k])])];
  }
  return ['o', [['scores', scores], ['selected', decisionList(result.selected, decisionLeaf)]]];
}

/** The raw decision call (op, tagged value) and its reply; the fixture tests use it directly. */
const decisionRequest = (op, value) => opJson(op, value, MAX_DECISION_BYTES, (e) => e.decision(), 'decision');

function decisionInvalid(r, allowed) {
  if (exactKeys(r, ['invalid']) && (r.invalid === null || allowed.has(r.invalid))) return r.invalid;
  throw new DavParseError('decision reply has an unexpected shape', 'reply');
}

/** decision/index.cjs invalidRequest(r) through the Rust port: the problem or null. A refusal
 *  ('throws', 'opaque', 'too_large') or a bad reply throws. */
function decisionInvalidRequest(r) {
  return decisionInvalid(decisionRequest(1, decisionRequestTag(r)), REQUEST_INVALID);
}

/** decision/index.cjs invalidResult(r, result) through the Rust port. */
function decisionInvalidResult(r, result) {
  return decisionInvalid(decisionRequest(2, [decisionRequestTag(r), decisionResultTag(result)]), RESULT_INVALID);
}

/** What causeOf reads off an error, as the decision crate takes it. */
function decisionErrorFacts(error) {
  const text = (v) => (typeof v === 'string' ? v : null);
  let message = null;
  if (error instanceof TypeError) {
    try { message = String(error.message); } catch { message = null; }
    if (message !== null && message.length > MAX_DECISION_MESSAGE_UNITS) throw new DavParseError('decision error message is too large', 'too_large');
  }
  return { deadline: !!error?.deadline, reason: text(error?.reason), name: text(error?.name), syntax: error instanceof SyntaxError, typeError: error instanceof TypeError, message };
}

/** decision/index.cjs causeOf(error) through the Rust port, over what it reads off the error. */
function decisionCauseOf(error) {
  const r = decisionRequest(3, decisionErrorFacts(error));
  if (!exactKeys(r, ['cause']) || typeof r.cause !== 'string' || !DECISION_CAUSE.test(r.cause)) throw new DavParseError('decision reply has an unexpected cause', 'reply');
  return r.cause;
}

/** Test hook: the cached instance's linear memory in bytes (0 when there is none). */
function memoryBytes() { return cached?.instance ? cached.instance.exports.memory.buffer.byteLength : 0; }

// --- code net guard (CODE_NET_GUARD_IMPL) ------------------------------------------------------
// code_net_guard::MAX_INPUT_BYTES (the op byte and the JSON) and MAX_ENTRIES.
const MAX_CODE_NET_BYTES = 64 * 1024 + 1;
const MAX_CODE_NET_ENTRIES = 1024;
const CODE_NET_HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const codeNetRequest = (op, value) => opJson(op, value, MAX_CODE_NET_BYTES, (e) => e.code_net_guard(), 'code net guard');
const ipText = (s) => typeof s === 'string' && net.isIP(s) !== 0;
const codeNetList = (xs) => Array.isArray(xs) && xs.length <= MAX_CODE_NET_ENTRIES;

/** code-net-guard.cjs parseCodeNetSpec through the Rust port: `{ literals, hosts }` (literals IP
 *  addresses, hosts lower-case names) or `{ malformed }` (the entry the JS throws on). A refusal
 *  ('ambiguous': see the crate docs) or a bad reply throws. */
function codeNetSpec(raw) {
  if (typeof raw !== 'string') throw new DavParseError('code net guard input has the wrong type', 'input');
  const r = codeNetRequest(1, raw);
  if (exactKeys(r, ['malformed']) && typeof r.malformed === 'string' && r.malformed) return { malformed: r.malformed };
  if (!exactKeys(r, ['literals', 'hosts']) || !codeNetList(r.literals) || !Array.isArray(r.hosts)
    || !r.literals.every(ipText) || new Set(r.literals).size !== r.literals.length
    || !r.hosts.every((h) => typeof h === 'string' && CODE_NET_HOST_RE.test(h))) {
    throw new DavParseError('code net guard reply has an unexpected shape', 'reply');
  }
  return { literals: r.literals, hosts: r.hosts };
}

/** The addresses resolveOnce keeps from one lookup's answers (each a string, or null for anything
 *  else), through the Rust port. A refusal or bad reply throws. */
function codeNetResolved(answers) {
  if (!codeNetList(answers) || !answers.every((a) => a === null || typeof a === 'string')) throw new DavParseError('code net guard input has the wrong type', 'input');
  const r = codeNetRequest(2, answers);
  if (!exactKeys(r, ['addresses']) || !codeNetList(r.addresses) || r.addresses.length > answers.length || !r.addresses.every(ipText)) {
    throw new DavParseError('code net guard reply has an unexpected shape', 'reply');
  }
  return r.addresses;
}

/** Whether a request whose socket's local address is `local` (a string, or null) arrived on one of
 *  `addresses`, through the Rust port. A refusal or bad reply throws. */
function codeNetRefuses(addresses, local) {
  if (!codeNetList(addresses) || !addresses.every(ipText) || !(local === null || typeof local === 'string')) {
    throw new DavParseError('code net guard input has the wrong type', 'input');
  }
  const r = codeNetRequest(3, [addresses, local]);
  if (!exactKeys(r, ['refuses']) || typeof r.refuses !== 'boolean') throw new DavParseError('code net guard reply has an unexpected shape', 'reply');
  return r.refuses;
}

// --- role context (ROLE_CONTEXT_IMPL) ----------------------------------------------------------
// role_context::MAX_INPUT_BYTES (the op byte and the JSON). The state carries credentials and grant
// tokens, so this is a secret call: the input, the reply bytes and the whole linear memory are
// wiped and the instance dropped after every call.
const MAX_ROLE_CONTEXT_BYTES = 8 * 1024 * 1024 + 1;
const ROLE_CONTEXT_REFUSALS = new Set(['input', 'too_large', 'ambiguous']);
const ROLE_CONTEXT_CODES = new Set(['unknown_role', 'invalid_state', 'missing_tenant', 'invalid_tenant', 'too_large']);
const ROLE_CONTEXT_CLASSES = new Set(['approval_internals', 'credentials', 'diary', 'orchestrator', 'other_role_prompts', 'other_tenant_ids', 'other_tenants', 'credential_pattern']);

function roleContextCall(op, a, state, key) {
  let text;
  try { text = JSON.stringify([a, state]); } catch { throw new DavParseError('role context input cannot be serialised', 'input'); }
  if (typeof text !== 'string') throw new DavParseError('role context input cannot be serialised', 'input');
  const body = encoder.encode(text);
  if (body.length + 1 > MAX_ROLE_CONTEXT_BYTES) { body.fill(0); throw new DavParseError('role context input is too large', 'too_large'); }
  const input = new Uint8Array(body.length + 1);
  input[0] = op; input.set(body, 1); body.fill(0);
  const { status, bytes } = invokeSecret(input, (e) => e.role_context());
  let r;
  try { r = JSON.parse(utf8(bytes)); } catch { r = undefined; } finally { bytes.fill(0); }
  if (status !== 0) {
    const code = r && ROLE_CONTEXT_REFUSALS.has(r.error) ? r.error : 'unknown';
    throw new DavParseError(`role context refused by dav-parse (${code})`, code);
  }
  return roleContextReply(r, key);
}

/** Check one role_context reply's shape: `{ value, redactions }`, `{ refused }` or `{ leak }`. */
function roleContextReply(r, key) {
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (exactKeys(r, [key, 'redactions']) && plain(r[key]) && Number.isSafeInteger(r.redactions) && r.redactions >= 0) return { value: r[key], redactions: r.redactions };
  if (exactKeys(r, ['refused']) && ROLE_CONTEXT_CODES.has(r.refused)) return { refused: r.refused };
  if (exactKeys(r, ['leak']) && Array.isArray(r.leak) && r.leak.length > 0 && r.leak.length <= ROLE_CONTEXT_CLASSES.size
    && r.leak.every((c) => ROLE_CONTEXT_CLASSES.has(c)) && new Set(r.leak).size === r.leak.length) return { leak: r.leak };
  throw new DavParseError('role context reply has an unexpected shape', 'reply');
}

/** role-context.cjs projectRoleContext(role, state) through the Rust port: `{ value, redactions }`
 *  (the canonical projection), `{ refused: code }` or `{ leak: [class, …] }`. A refusal or bad
 *  reply throws. */
function roleContextProject(role, state) { return roleContextCall(1, role, state, 'projection'); }

/** role-context.cjs projectSharedDossier(state, { roles }) through the Rust port, as above. */
function roleContextDossier(roles, state) { return roleContextCall(2, roles, state, 'dossier'); }

// --- completeness report (COMPLETENESS_REPORT_IMPL) --------------------------------------------
// completeness_report::MAX_INPUT_BYTES (the op byte and the JSON).
const MAX_COMPLETENESS_BYTES = 8 * 1024 * 1024 + 1;
const COMPLETENESS_STATUSES = new Set(['pass', 'fail', 'unknown']);
const COMPLETENESS_UNHASHABLE = new Set(['deep', 'large']);

/** Check one completeness_report reply's shape: `{ hash, report }` (a sha256 hex digest and the
 *  report object) or `{ unhashable, overall, statuses }`. */
function completenessReply(r) {
  if (exactKeys(r, ['hash', 'report']) && typeof r.hash === 'string' && /^[0-9a-f]{64}$/.test(r.hash)
    && r.report && typeof r.report === 'object' && !Array.isArray(r.report)) return { hash: r.hash, report: r.report };
  if (exactKeys(r, ['unhashable', 'overall', 'statuses']) && COMPLETENESS_UNHASHABLE.has(r.unhashable) && COMPLETENESS_STATUSES.has(r.overall)
    && Array.isArray(r.statuses) && r.statuses.length === 5 && r.statuses.every((s) => COMPLETENESS_STATUSES.has(s))) {
    return { unhashable: r.unhashable, overall: r.overall, statuses: r.statuses };
  }
  throw new DavParseError('completeness report reply has an unexpected shape', 'reply');
}

/** completeness-report.cjs buildCompletenessReport({ job, expectedArtifacts }) and reportHash
 *  through the Rust port. A refusal ('input', 'too_large', 'ambiguous': see the crate docs), a job
 *  JSON.stringify cannot write or a bad reply throws. */
function completenessReport(job, expectedArtifacts) {
  let body;
  try { body = JSON.stringify([job, expectedArtifacts ?? null]); } catch { body = undefined; }
  if (typeof body !== 'string') throw new DavParseError('completeness report input cannot be serialised', 'input');
  const bytes = encoder.encode(body);
  if (bytes.length + 1 > MAX_COMPLETENESS_BYTES) throw new DavParseError('completeness report input is too large', 'too_large');
  const input = new Uint8Array(bytes.length + 1);
  input[0] = 1; input.set(bytes, 1);
  return completenessReply(invoke(input, (e) => e.completeness_report(), MAX_COMPLETENESS_BYTES));
}

// --- task lifecycle (TASK_LIFECYCLE_IMPL) ------------------------------------------------------
// task_lifecycle::MAX_INPUT_BYTES (the op byte and the JSON). A journal holds tenant job content but
// no credentials, and the reply is a state name: an ordinary call.
const MAX_TASK_LIFECYCLE_BYTES = 8 * 1024 * 1024 + 1;
const TASK_LIFECYCLE_STATES = new Set(['planned', 'implementing', 'verifying', 'reviewing', 'changes_requested', 'merged', 'blocked']);
const TASK_LIFECYCLE_THROWS = new Set(['unknown_state', 'illegal', 'stale', 'report_hash', 'merge_from_reviewing']);

function taskLifecycleCall(op, value, key) {
  let r;
  try { r = opJson(op, value, MAX_TASK_LIFECYCLE_BYTES, (e) => e.task_lifecycle(), 'task lifecycle'); }
  catch (err) { if (err instanceof DavParseError) throw err; throw new DavParseError('task lifecycle input cannot be serialised', 'input'); }
  return taskLifecycleReply(r, key);
}

/** Check one task_lifecycle reply's shape: `{ allowed }` / `{ state }` (as `key` says) or `{ throws }`. */
function taskLifecycleReply(r, key) {
  if (key === 'allowed' && exactKeys(r, ['allowed']) && typeof r.allowed === 'boolean') return { allowed: r.allowed };
  if (key === 'state' && exactKeys(r, ['state']) && TASK_LIFECYCLE_STATES.has(r.state)) return { state: r.state };
  if (exactKeys(r, ['throws']) && TASK_LIFECYCLE_THROWS.has(r.throws)) return { throws: r.throws };
  throw new DavParseError('task lifecycle reply has an unexpected shape', 'reply');
}

const taskLifecycleEvents = (events) => {
  if (events !== null && !Array.isArray(events)) throw new DavParseError('task lifecycle events must be an array', 'input');
  return events;
};

/** task-lifecycle.cjs canTransition(from, to) through the Rust port: `{ allowed }` or `{ throws }`. */
function taskLifecycleCanTransition(from, to) { return taskLifecycleCall(1, [from, to], 'allowed'); }
/** transition(from, to): `{ state }` or `{ throws }`. */
function taskLifecycleTransition(from, to) { return taskLifecycleCall(2, [from, to], 'state'); }
/** assertStageMove(from, to): `{ state }` or `{ throws }`. */
function taskLifecycleStageMove(from, to) { return taskLifecycleCall(3, [from, to], 'state'); }
/** foldEvents(events, fromState, { authoritative }): `{ state }` or `{ throws }`. */
function taskLifecycleFold(events, fromState, authoritative) {
  if (typeof authoritative !== 'boolean') throw new DavParseError('task lifecycle authoritative must be a boolean', 'input');
  return taskLifecycleCall(4, [taskLifecycleEvents(events), fromState, authoritative], 'state');
}
/** deriveLifecycle(events): `{ state }` or `{ throws }`. A refusal or bad reply throws. */
function taskLifecycleDerive(events) { return taskLifecycleCall(5, [taskLifecycleEvents(events)], 'state'); }

// --- llama.cpp autoconfig (LLAMACPP_AUTOCONFIG_IMPL) --------------------------------------------
// llamacpp_autoconfig::MAX_INPUT_BYTES (the op byte and the JSON).
const MAX_AUTOCONFIG_BYTES = 4 * 1024 * 1024 + 1;
const AUTOCONFIG_OPS = new Set([1, 2, 3, 4, 5, 6]);

/** Check one llamacpp_autoconfig reply's shape for `op`: an object for 1-3 (the JS's answer as
 *  JSON.stringify writes it), `{ mib }`/`{ unbounded: true }` for 4, `{ free }` for 5 and
 *  `{ gib }` (number, null or "Infinity") for 6. */
function autoconfigReply(op, r) {
  const ok = op <= 3 ? !!r && typeof r === 'object' && !Array.isArray(r)
    : op === 4 ? (exactKeys(r, ['mib']) && typeof r.mib === 'number') || (exactKeys(r, ['unbounded']) && r.unbounded === true)
      : op === 5 ? exactKeys(r, ['free']) && typeof r.free === 'boolean'
        : exactKeys(r, ['gib']) && (r.gib === null || r.gib === 'Infinity' || typeof r.gib === 'number');
  if (!ok) throw new DavParseError('llama.cpp autoconfig reply has an unexpected shape', 'reply');
  return r;
}

/** llamacpp-autoconfig.cjs through the Rust port: op 1 suggest, 2 estimateInputs, 3
 *  estimateFootprint (`args` the parameter object), 4 cacheRamMibOf ({ value }), 5
 *  isPromptCacheFree ({ model, options }), 6 parseMemoryLimit ({ value }). Returns `{ text, reply }`
 *  (the reply text, byte-comparable with JSON.stringify of the JS answer, and its parse). A refusal
 *  ('input', 'too_large', 'ambiguous': see the crate docs), args JSON.stringify cannot write or a
 *  bad reply throws. */
function llamacppAutoconfig(op, args) {
  if (!AUTOCONFIG_OPS.has(op)) throw new DavParseError('llama.cpp autoconfig op is unknown', 'input');
  let body;
  try { body = JSON.stringify(args); } catch { body = undefined; }
  if (typeof body !== 'string') throw new DavParseError('llama.cpp autoconfig input cannot be serialised', 'input');
  const bytes = encoder.encode(body);
  if (bytes.length + 1 > MAX_AUTOCONFIG_BYTES) throw new DavParseError('llama.cpp autoconfig input is too large', 'too_large');
  const input = new Uint8Array(bytes.length + 1);
  input[0] = op; input.set(bytes, 1);
  const { status, bytes: out } = invokeRaw(input, (e) => e.llamacpp_autoconfig(), MAX_AUTOCONFIG_BYTES);
  const text = utf8(out);
  let reply;
  try { reply = JSON.parse(text); } catch { throw new DavParseError('dav-parse reply is not JSON', 'reply'); }
  if (status !== 0) {
    const code = reply && typeof reply.error === 'string' ? reply.error : 'unknown';
    throw new DavParseError(`llama.cpp autoconfig input refused by dav-parse (${code})`, code);
  }
  return { text, reply: autoconfigReply(op, reply) };
}

// --- code actions (CODE_ACTIONS_IMPL) and project file names (PROJECT_FILE_NAMES_IMPL) ----------
// code_actions::MAX_INPUT_BYTES and project_file_names::MAX_INPUT_BYTES (the op byte and the JSON).
// A tool call's command text and a project's file names carry no credentials: ordinary calls.
const MAX_CODE_ACTIONS_BYTES = 2 * 1024 * 1024 + 1;
const MAX_PROJECT_FILE_NAMES_BYTES = 8 * 1024 * 1024 + 1;
const CODE_ACTION_NAMES = new Set(['read_repository', 'edit_file', 'execute_command', 'install_dependency', 'network',
  'delete', 'git_push', 'open_browser', 'external_account', 'none']);
const APPROVALS = new Set(['never', 'always', 'capability']);
const DECISIONS = new Set(['allow', 'ask', 'deny']);
const FILE_NAME_REASONS = new Set(['a file name is required', 'that file name is too long', 'a file name cannot contain control characters',
  'a file name cannot contain backslashes', 'a file name cannot contain encoded dots or separators',
  'a file name cannot be an absolute path', 'a file name cannot contain empty, "." or ".." parts']);
const allStrings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

/** `u8(op)` and JSON.stringify(args) through `call`: `{ text, reply }` on status 0; a refusal,
 *  args JSON.stringify cannot write or a reply that is not JSON throws a DavParseError. */
function jsonOpCall(op, args, max, call, what) {
  let body;
  try { body = JSON.stringify(args); } catch { body = undefined; }
  if (typeof body !== 'string') throw new DavParseError(`${what} input cannot be serialised`, 'input');
  const bytes = encoder.encode(body);
  if (bytes.length + 1 > max) throw new DavParseError(`${what} input is too large`, 'too_large');
  const input = new Uint8Array(bytes.length + 1);
  input[0] = op; input.set(bytes, 1);
  const { status, bytes: out } = invokeRaw(input, call, max);
  const text = utf8(out);
  let reply;
  try { reply = JSON.parse(text); } catch { throw new DavParseError('dav-parse reply is not JSON', 'reply'); }
  if (status !== 0) {
    const code = reply && typeof reply.error === 'string' ? reply.error : 'unknown';
    throw new DavParseError(`${what} input refused by dav-parse (${code})`, code);
  }
  return { text, reply };
}
const codeActionsCall = (op, args) => jsonOpCall(op, args, MAX_CODE_ACTIONS_BYTES, (e) => e.code_actions(), 'code actions');
const badReply = (what) => { throw new DavParseError(`${what} reply has an unexpected shape`, 'reply'); };

/** code-actions.cjs classify over classifyInput(call): `{ text, reply }`, the reply shaped like
 *  classify()'s answer (known classes and approvals only). */
function codeActionsClassify(projection) {
  const r = codeActionsCall(1, [projection]);
  const c = r.reply;
  if (!exactKeys(c, ['action', 'approval', 'command', 'paths', 'readable', 'actions', 'simple', 'standable'])
    || !CODE_ACTION_NAMES.has(c.action) || !APPROVALS.has(c.approval) || typeof c.command !== 'string' || !allStrings(c.paths)
    || typeof c.readable !== 'boolean' || !allStrings(c.actions) || !c.actions.length || !c.actions.every((a) => CODE_ACTION_NAMES.has(a))
    || typeof c.simple !== 'boolean' || typeof c.standable !== 'boolean') badReply('code actions classify');
  return r;
}

/** code-actions.cjs decide over decideInput(): `{ text, reply: { decision, reason } }`. */
function codeActionsDecide(classified, capabilities, domains, inWorkspace) {
  const r = codeActionsCall(2, [classified, capabilities, domains, inWorkspace]);
  if (!exactKeys(r.reply, ['decision', 'reason']) || !DECISIONS.has(r.reply.decision) || typeof r.reply.reason !== 'string') badReply('code actions decide');
  return r;
}

/** code-actions.cjs pickOption over pickInput(options): `{ text, reply }`, selected or cancelled. */
function codeActionsPick(options, wanted) {
  if (typeof wanted !== 'string') throw new DavParseError('code actions option wanted must be a string', 'input');
  const r = codeActionsCall(3, [options, wanted]);
  const o = r.reply;
  if (!(exactKeys(o, ['outcome']) && o.outcome === 'cancelled')
    && !(exactKeys(o, ['outcome', 'optionId']) && o.outcome === 'selected' && typeof o.optionId === 'string')) badReply('code actions pick');
  return r;
}

/** project-file-names.cjs resolveProjectFile over the project's file names (strings, in order) and
 *  the raw argument: `{ file }` (an index into `names`), `{ code: 'invalid', reason }`,
 *  `{ code: 'missing' }` or `{ code: 'ambiguous', candidates }`. A refusal or bad reply throws. */
function projectFileNames(names, raw) {
  if (!allStrings(names)) throw new DavParseError('project file names must be strings', 'input');
  const { reply: r } = jsonOpCall(1, [names, raw === undefined ? null : raw], MAX_PROJECT_FILE_NAMES_BYTES, (e) => e.project_file_names(), 'project file names');
  const index = (i) => Number.isSafeInteger(i) && i >= 0 && i < names.length;
  if (exactKeys(r, ['file']) && index(r.file)) return r;
  if (exactKeys(r, ['code']) && r.code === 'missing') return r;
  if (exactKeys(r, ['code', 'reason']) && r.code === 'invalid' && FILE_NAME_REASONS.has(r.reason)) return r;
  if (exactKeys(r, ['code', 'candidates']) && r.code === 'ambiguous' && Array.isArray(r.candidates) && r.candidates.length > 1 && r.candidates.every(index)) return r;
  return badReply('project file names');
}

// --- provider egress (PROVIDER_EGRESS_IMPL) ------------------------------------------------------
// provider_egress::MAX_INPUT_BYTES (the op byte and the JSON). The host sends its projections of a
// provider row ({kind, external, baseUrl, label}), a storage connection ({kind, corpusRoot,
// baseUrl}: no credentials) and a tool call's name and arguments. Every reply is checked for shape;
// a refusal or bad reply throws a DavParseError, which provider-egress.cjs answers strictly.
const MAX_PROVIDER_EGRESS_BYTES = 8 * 1024 * 1024 + 1;
const egressCall = (op, args) => jsonOpCall(op, args, MAX_PROVIDER_EGRESS_BYTES, (e) => e.provider_egress(), 'provider egress').reply;
const boolOrNull = (v) => v === true || v === false || v === null;
const refusalOf = (r, what) => (exactKeys(r, ['refusal']) && (r.refusal === null || (typeof r.refusal === 'string' && r.refusal !== '')) ? r : badReply(what));

/** isExternalProvider / isTrialTermsHost: `{ external, trial }`, each true, false or null (unknown). */
function providerEgressExternal(provider) {
  const r = egressCall(1, [provider]);
  if (!exactKeys(r, ['external', 'trial']) || !boolOrNull(r.external) || !boolOrNull(r.trial)) badReply('provider egress external');
  return r;
}

/** egressRefusal: `{ refusal }` (null or the text). */
function providerEgressRefusal(provider, spaceId, projectId, diaryProjectId) {
  return refusalOf(egressCall(2, [provider, spaceId, projectId, diaryProjectId]), 'provider egress refusal');
}

/** stripPrivateToolboxes: `{ removed }`, ascending indices into `selected`. */
function providerEgressStrip(provider, selected) {
  if (!Array.isArray(selected)) throw new DavParseError('provider egress selection must be an array', 'input');
  const r = egressCall(3, [provider, selected]);
  const ok = exactKeys(r, ['removed']) && Array.isArray(r.removed)
    && r.removed.every((i, k) => Number.isSafeInteger(i) && i >= 0 && i < selected.length && (k === 0 || i > r.removed[k - 1]));
  if (!ok) badReply('provider egress strip');
  return r;
}

/** toolRefusal: `{ refusal }` (null or the text). `rawArgs` is the string or the value itself. */
function providerEgressToolRefusal(provider, toolName, rawArgs, storage) {
  if (typeof toolName !== 'string') throw new DavParseError('provider egress tool name must be a string', 'input');
  return refusalOf(egressCall(4, [provider, toolName, rawArgs, storage]), 'provider egress tool refusal');
}

/** canonicalPath over each path: `{ canonical }`, a string or null (unknown to the port) each. */
function providerEgressCanonical(paths) {
  if (!allStrings(paths)) throw new DavParseError('provider egress paths must be strings', 'input');
  const r = egressCall(5, [paths]);
  if (!exactKeys(r, ['canonical']) || !Array.isArray(r.canonical) || r.canonical.length !== paths.length
    || !r.canonical.every((c) => c === null || typeof c === 'string')) badReply('provider egress canonical');
  return r;
}

/** diaryFolderFor: `{ folder, known }` (folder null and known true: the JS's null too). */
function providerEgressFolder(storage) {
  const r = egressCall(6, [storage]);
  if (!exactKeys(r, ['folder', 'known']) || typeof r.known !== 'boolean' || !(r.folder === null || (typeof r.folder === 'string' && r.folder !== ''))
    || (!r.known && r.folder !== null)) badReply('provider egress folder');
  return r;
}

// Every switch that runs this module (#996). Each reads its value as trim().toLowerCase().
// Retired switches (#1071) are not listed: the Rust path they selected is always on, and
// verifyAtStartup() always loads this module for it.
const IMPL_FLAGS = ['STORAGE_PATH_IMPL', 'SECRET_ENVELOPE_IMPL', 'STREAM_GUARD_IMPL', 'GGUF_META_IMPL', 'ROLE_CONTEXT_IMPL', 'CODE_ACTIONS_IMPL', 'PROJECT_FILE_NAMES_IMPL', 'PROVIDER_EGRESS_IMPL'];

/** Switches whose JS path was deleted once Rust had run in production (#1071). The old value that
 *  selected Rust ('wasm', or 'on' for the advisor) is accepted silently; anything else is ignored
 *  with one warning, because Rust is always used. */
const RETIRED_FLAGS = { CHAT_TEMPLATE_CAPS_IMPL: 'wasm', AUTOTUNE_PLAN_IMPL: 'wasm', PRESET_RELOAD_IMPL: 'wasm', LAYA_LOAD_ADVISOR: 'on', DAV_PARSE_IMPL: 'wasm', S3_PARSE_IMPL: 'wasm', MCP_FRAME_IMPL: 'wasm', UPLOAD_SNIFF_IMPL: 'wasm', S3_SIGN_IMPL: 'wasm', PROMPT_FRAMING_IMPL: 'wasm', SSRF_IMPL: 'wasm',
  POLICY_LEAVES_IMPL: 'wasm', CODE_REVIEW_VERDICT_IMPL: 'wasm', TOOL_EXCHANGE_IMPL: 'wasm', DECISION_IMPL: 'wasm', COMPLETENESS_REPORT_IMPL: 'wasm', TASK_LIFECYCLE_IMPL: 'wasm', MCP_SERVERS_IMPL: 'wasm', CODE_NET_GUARD_IMPL: 'wasm', LLAMACPP_AUTOCONFIG_IMPL: 'wasm' };

/** Log one warning per retired switch that `env` still sets to something other than its old
 *  Rust-selecting value (for example =js). Returns the names warned about. Never throws. */
function warnRetiredFlags(env = process.env, log = console) {
  const warned = [];
  for (const [flag, rust] of Object.entries(RETIRED_FLAGS)) {
    const value = String(env[flag] ?? '').trim().toLowerCase();
    if (value === '' || value === rust) continue;
    warned.push(flag);
    log.warn(`${flag} is retired; Rust is always used`);
  }
  return warned;
}

/** The *_IMPL switches set to wasm in `env`. */
function wasmFlags(env = process.env) {
  return IMPL_FLAGS.filter((k) => String(env[k] ?? '').trim().toLowerCase() === 'wasm');
}

/** Startup check (#996, #1071): load and verify the module now (lock, sha256, no imports, the
 *  full ABI) instead of failing on the first request. Always required, since the retired
 *  switches' Rust paths have no JS fallback. Returns the *_IMPL flags set to wasm; throws an
 *  Error with the reason (naming those flags, if any) when the module is unusable. */
/** The runtime URL behaviour prompt-framing's port was pinned against (Node 22's ada maps U+1E9E
 *  to "ss" in hosts; noevia-rs crates/prompt-framing idna_compat does the same). A runtime that
 *  disagrees would make the port and the runtime's own URL parser differ, so startup refuses
 *  (always, since #1071; it was PROMPT_FRAMING_IMPL=wasm). */
function framingRuntimeMatches(hostname = (h) => new URL(h).hostname) {
  try { return hostname('http://\u1e9e.io') === 'ss.io'; } catch { return false; }
}

function verifyAtStartup(env = process.env, { hostname } = {}) {
  const flags = wasmFlags(env);
  if (!framingRuntimeMatches(hostname)) {
    cached = null;
    throw Object.assign(new Error(`prompt framing is always Rust, but this runtime's URL parser (Node ${process.version}) does not map U+1E9E to "ss" as the pinned port does (runtime)`), { reason: 'runtime', flags });
  }
  cached = null;
  try {
    cached = load({ file: env.DAV_PARSE_WASM || DEFAULT_WASM });
  } catch (err) {
    cached = null;
    const reason = err instanceof DavParseError ? err.reason : 'unexpected';
    // Without a switch the module is still required (the retired switches' Rust paths, #1071).
    const who = flags.length ? `${flags.join(', ')} set to wasm, but dav-parse.wasm` : 'dav-parse.wasm (always required)';
    throw Object.assign(new Error(`${who} failed verification (${reason}): ${err?.message || err}`), { reason, flags });
  }
  return flags;
}

/** Test hook: forget the cached module (and its failure). */
function reset() { cached = null; }

module.exports = { providerEgressExternal, providerEgressRefusal, providerEgressStrip, providerEgressToolRefusal, providerEgressCanonical, providerEgressFolder, MAX_PROVIDER_EGRESS_BYTES, codeActionsClassify, codeActionsDecide, codeActionsPick, MAX_CODE_ACTIONS_BYTES, projectFileNames, MAX_PROJECT_FILE_NAMES_BYTES, llamacppAutoconfig, autoconfigReply, MAX_AUTOCONFIG_BYTES, taskLifecycleCanTransition, taskLifecycleTransition, taskLifecycleStageMove, taskLifecycleFold, taskLifecycleDerive, taskLifecycleReply, MAX_TASK_LIFECYCLE_BYTES, completenessReport, completenessReply, MAX_COMPLETENESS_BYTES, roleContextProject, roleContextDossier, roleContextReply, MAX_ROLE_CONTEXT_BYTES, codeNetSpec, codeNetResolved, codeNetRefuses, MAX_CODE_NET_BYTES, MAX_CODE_NET_ENTRIES, mcpServersParse, mcpToolboxes, mcpToolboxOffered, MAX_MCP_SERVERS_BYTES, decisionRequestTag, decisionResultTag, decisionInvalidRequest, decisionInvalidResult, decisionCauseOf, decisionErrorFacts, decisionRequest, MAX_DECISION_MESSAGE_UNITS, MAX_DECISION_BYTES, DECISION_ENTRIES, reviewTag, reviewVerdictRead, reviewEventBound, reviewVerdictReply, MAX_REVIEW_BYTES, toolExchangeCheck, toolExchangeError, MAX_EXCHANGE_ARGS_UNITS, MAX_EXCHANGE_NAME_UNITS, ggufSummary, ggufSummaryReply, MAX_GGUF_WINDOW_BYTES, MAX_GGUF_SEGMENTS, authTokens, toolPolicyMode, toolPolicySet, MAX_POLICY_UNITS, MAX_POLICY_TOOLS, streamGuardSchema, streamGuardOptions, streamGuardNew, streamGuardFeed, streamGuardEnd, streamGuardCheck, streamGuardCheckReply, streamGuardCorrection, streamGuardReply, plainJson, MAX_GUARD_BYTES, MAX_GUARD_DEPTH, MAX_GUARD_SCHEMA_BYTES, MAX_GUARD_STATE_BYTES, MAX_GUARD_INPUT_BYTES, MAX_CORRECTION_UNITS, s3Sign, s3Region, MAX_S3_FIELD_BYTES, MAX_S3_QUERY_PAIRS, MAX_S3_PAYLOAD_BYTES, wasmFlags, RETIRED_FLAGS, warnRetiredFlags, verifyAtStartup, framingRuntimeMatches, IMPL_FLAGS, ssrfUrl, ssrfAddressesPublic, ssrfUrlReply, ssrfAddressesReply, MAX_SSRF_BYTES, MAX_SSRF_ADDRESSES, frameUntrusted, escapeClosing, provenanceNew, provenanceIngest, provenanceAdd, provenanceSource, provenanceCheck, provenanceProbe, packetParse, packetValidate, packetRender, FRAME_TEXT_UNITS, FRAME_LABEL_UNITS, MAX_PROVENANCE_BYTES, MAX_PACKET_BYTES, listRecords, s3ListPage, storagePath, uploadValidate, uploadClassify, uploadDecode, secretOpen, secretSeal, mcpRpcBody, mcpSchemaRefs, templateCaps, providerErrorKind, servingVerdict, autotunePlan, autotunePlanText, MAX_PLAN_BYTES, presetReload, MAX_RELOAD_BYTES, loadVerdict, loadVerdictText, MAX_VERDICT_BYTES, tuneContention, tuneContentionText, MAX_CONTENTION_BYTES, longProfilePairs, longProfileSection, longProfilePick, longProfileText, MAX_LONG_PROFILE_BYTES, MAX_TEMPLATE_BYTES, MCP_BODY_UNITS, MCP_SCHEMA_UNITS, MAX_SECRET_PLAIN_BYTES, MAX_SECRET_UNITS, MAX_SECRET_USER_BYTES, load, readLock, reset, memoryBytes, DavParseError, DEFAULT_WASM, MAX_INPUT_BYTES, MAX_DECODE_BYTES, SNIFF_BYTES, RESET_AFTER_BYTES };
