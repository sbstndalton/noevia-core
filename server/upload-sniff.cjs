'use strict';

// Upload checks (#977): validate (filename rule, 25 MB cap, archive refusal), classify and
// decodeText, moved here unchanged from uploads.cjs.
//
// `upload-sniff` (sbstndalton/noevia-rs, in the dav-parse.wasm module pinned by
// server/dav-parse.lock) decides, always (since #1071; it was UPLOAD_SNIFF_IMPL=wasm). It FAILS CLOSED: a missing or tampered module, a
// trap or an unexpected reply throws 500 'upload could not be checked'; input that cannot cross
// (a non-string name, non-byte data, more than 25 MB to decode) throws 400 with the same message.
// Nothing falls back to JS rules (they are a test oracle: tests/server/oracle/upload-sniff.cjs);
// the details are logged server-side.
//
// Only what decides the answer crosses: validate sends the name, the length and the first 262
// bytes; classify the name; decodeText the whole upload (it needs every byte; at most 25 MB, and
// ingest only decodes validated uploads). See dav-parse-wasm.cjs for the module's memory policy.

const davParseWasm = require('./dav-parse-wasm.cjs');

const CAP = 25 * 1024 * 1024;
const PUBLIC_FAILURE = 'upload could not be checked';

function viaWasm(op, fn) {
  try { return fn(); } catch (err) {
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[uploads] upload-sniff ${op} failed (${reason}): ${err?.message || err}`);
    throw Object.assign(new Error(PUBLIC_FAILURE), { status: reason === 'too_large' || reason === 'input' ? 400 : 500, code: 'upload_sniff_failed', reason });
  }
}

// The messages the filename, size and archive refusals carry, by the refusal code the module answers.
const REFUSAL_MESSAGES = {
  filename: 'Use a plain filename of at most 200 characters.',
  empty: 'Files must be non-empty and no larger than 25 MB.',
  too_big: 'Files must be non-empty and no larger than 25 MB.',
  archive: 'Archive bundles are not supported. Upload their individual files instead.',
};

function validate(name, bytes) {
  // As storage-path's wasm filename rule: a non-string (or empty) name is not a plain filename.
  if (!name || typeof name !== 'string') throw Object.assign(new Error(REFUSAL_MESSAGES.filename), { status: 400 });
  const refused = viaWasm('validate', () => davParseWasm.uploadValidate(name, bytes));
  if (refused) throw Object.assign(new Error(REFUSAL_MESSAGES[refused.refusal]), { status: refused.status });
}

function classify(name) {
  return viaWasm('classify', () => davParseWasm.uploadClassify(name));
}

function decodeText(bytes) {
  return viaWasm('decodeText', () => davParseWasm.uploadDecode(bytes));
}

module.exports = { CAP, classify, validate, decodeText, PUBLIC_FAILURE };
