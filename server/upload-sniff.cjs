'use strict';

// Upload checks (#977): validate (filename rule, 25 MB cap, archive refusal), classify and
// decodeText, moved here unchanged from uploads.cjs.
//
// `upload-sniff` (sbstndalton/noevia-rs, in the dav-parse.wasm module pinned by
// server/dav-parse.lock) is the Rust port. UPLOAD_SNIFF_IMPL=js|wasm picks one (default js; any
// other value means js, with one warning). `wasm` FAILS CLOSED: a missing or tampered module, a
// trap or an unexpected reply throws 500 'upload could not be checked'; input that cannot cross
// (a non-string name, non-byte data, more than 25 MB to decode) throws 400 with the same message.
// Nothing falls back to the JS rules; the details are logged server-side.
//
// Only what decides the answer crosses: validate sends the name, the length and the first 262
// bytes; classify the name; decodeText the whole upload (it needs every byte; at most 25 MB, and
// ingest only decodes validated uploads). See dav-parse-wasm.cjs for the module's memory policy.

const path = require('node:path');
const storage = require('./storage-client.cjs');
const storagePath = require('./storage-path.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const CAP = 25 * 1024 * 1024;
function classifyJs(name) {
  const ext = path.extname(name).toLowerCase();
  if (/^\.(pdf|docx?|odt|rtf|pptx?|xlsx?|ods|odp|epub)$/.test(ext)) return 'Documents';
  if (/^\.(png|jpe?g|webp|gif|heic|heif|tiff?|bmp|svg|avif)$/.test(ext)) return 'Images';
  return storage.TEXT_EXTENSIONS.has(ext) ? 'Text' : 'Other';
}
function validateJs(name, bytes) {
  if (!storagePath.isPlainFilename(name)) throw Object.assign(new Error('Use a plain filename of at most 200 characters.'), { status: 400 });
  if (!bytes.length || bytes.length > CAP) throw Object.assign(new Error('Files must be non-empty and no larger than 25 MB.'), { status: bytes.length ? 413 : 400 });
  const ext = path.extname(name).toLowerCase();
  // Office/OpenDocument files are containers internally, but are documents, not archive bundles.
  const packagedDocument = /^\.(docx|xlsx|pptx|odt|ods|odp|epub)$/.test(ext);
  const archiveMagic = bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,3,4])) || bytes.subarray(0,2).equals(Buffer.from([0x1f,0x8b])) || /^(Rar!|7z\xbc\xaf|BZh)/.test(bytes.subarray(0,6).toString('latin1')) || bytes.subarray(257,262).toString() === 'ustar';
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|cab|iso)$/i.test(name) || (archiveMagic && !packagedDocument)) throw Object.assign(new Error('Archive bundles are not supported. Upload their individual files instead.'), { status: 400 });
}
// A text file is not always UTF-8, and a `.txt` exported from an older editor
// very often is not. This used to be one fatal UTF-8 decode inside a bare
// `catch { state = 'stored' }`: a Latin-1 or UTF-16 file was silently reduced
// to empty content, indistinguishable from an opaque binary, with nothing told
// to the user and nothing logged. That is data loss, not a limitation.
//
// So: honour a BOM, then try UTF-8 strictly, then fall back to windows-1252 —
// which is the usual answer for legacy Western European text and, being a
// total mapping, cannot itself fail. Because it cannot fail, it would happily
// turn a JPEG into mojibake, so binary is ruled out first by the one signal
// that is reliable across encodings: a NUL byte, which no text encoding here
// produces for real content.
//
// Returns null only when the bytes are genuinely not text. A non-UTF-8 read is
// reported as such rather than presented as a clean read.
function decodeTextJs(bytes) {
  const decode = (encoding, from = 0) => new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(from));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try { return { text: decode('utf-8', 3), encoding: 'utf-8' }; } catch { /* a lying BOM; fall through */ }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try { return { text: decode('utf-16le', 2), encoding: 'utf-16le' }; } catch { /* fall through */ }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try { return { text: decode('utf-16be', 2), encoding: 'utf-16be' }; } catch { /* fall through */ }
  }
  // No BOM: a NUL byte means binary. NUL is valid UTF-8, so this must precede the UTF-8 attempt or a
  // file of NULs and ASCII would be read as "text" (#586).
  if (bytes.includes(0)) return null;
  try { return { text: decode('utf-8'), encoding: 'utf-8' }; } catch { /* not UTF-8; keep going */ }
  try { return { text: decode('windows-1252'), encoding: 'windows-1252' }; } catch { return null; }
}

const PUBLIC_FAILURE = 'upload could not be checked';
const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';

/** UPLOAD_SNIFF_IMPL, read per call so a test (or an owner flip plus restart) takes effect. */
function uploadSniffImpl(env = process.env) {
  const raw = env.UPLOAD_SNIFF_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[uploads] UPLOAD_SNIFF_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}

function viaWasm(op, fn) {
  try { return fn(); } catch (err) {
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[uploads] upload-sniff ${op} failed (${reason}): ${err?.message || err}`);
    throw Object.assign(new Error(PUBLIC_FAILURE), { status: reason === 'too_large' || reason === 'input' ? 400 : 500, code: 'upload_sniff_failed', reason });
  }
}

// The messages validateJs throws, by the refusal code the module answers.
const REFUSAL_MESSAGES = {
  filename: 'Use a plain filename of at most 200 characters.',
  empty: 'Files must be non-empty and no larger than 25 MB.',
  too_big: 'Files must be non-empty and no larger than 25 MB.',
  archive: 'Archive bundles are not supported. Upload their individual files instead.',
};

function validate(name, bytes, { impl = uploadSniffImpl() } = {}) {
  if (impl !== 'wasm') return validateJs(name, bytes);
  // As storage-path's wasm filename rule: a non-string (or empty) name is not a plain filename.
  if (!name || typeof name !== 'string') throw Object.assign(new Error(REFUSAL_MESSAGES.filename), { status: 400 });
  const refused = viaWasm('validate', () => davParseWasm.uploadValidate(name, bytes));
  if (refused) throw Object.assign(new Error(REFUSAL_MESSAGES[refused.refusal]), { status: refused.status });
}

function classify(name, { impl = uploadSniffImpl() } = {}) {
  return impl === 'wasm' ? viaWasm('classify', () => davParseWasm.uploadClassify(name)) : classifyJs(name);
}

function decodeText(bytes, { impl = uploadSniffImpl() } = {}) {
  return impl === 'wasm' ? viaWasm('decodeText', () => davParseWasm.uploadDecode(bytes)) : decodeTextJs(bytes);
}

module.exports = { CAP, classify, validate, decodeText, uploadSniffImpl, PUBLIC_FAILURE, classifyJs, validateJs, decodeTextJs };
