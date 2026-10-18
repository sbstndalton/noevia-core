'use strict';
// GGUF v2/v3 metadata reader (key/value header only, never tensor data), adapted from
// scratchhax/model-loader (MIT, e11a6ec, app/gguf_meta.py).
//
// The header is always parsed by noevia-rs's gguf crate (gguf::node, in dav-parse.wasm; the
// GGUF_META_IMPL switch was retired in #1071, the JS parser deleted). The file I/O stays here: the
// module gets the file's size and the byte ranges read so far (the first 4 KiB, then each range it
// names: as much again as the range it continues (a skip of at most 4 KiB past a range continues
// it), 4 KiB after a jump; at most 24 MiB in 512 ranges, 64 rounds and 8 x 24 MiB handed over in
// all); bytes the module skips are not read. Fails closed: a missing or tampered module stops
// startup (dav-parse-wasm.cjs verifyAtStartup), and a refusal, a trap or a reply of the wrong
// shape throws. Limits of the Rust reader: more than 24 MiB of header bytes read (not skipped),
// arrays nested more than 64 deep, more than 262,144 values kept. tests/fixtures/gguf-meta.v1.json
// holds the frozen answers of the former JS reader (byte-identical to noevia-rs's copy).
const fs = require('node:fs');

// The first read, and the read after a jump past skipped bytes; reading on from a held range
// doubles that range, so a contiguous header takes a few rounds and a jump wastes little.
const READ_CHUNK = 4 * 1024;
// Limits on one readSummaryWasm call: rounds, and bytes handed over, in windows (#1106).
const MAX_ROUNDS = 64;
const MAX_SENT_WINDOWS = 8;
const FAIL_MESSAGES = {
  not_gguf: () => 'Not a GGUF file',
  version: (v) => `Unsupported GGUF version ${v}`,
  limit: () => 'GGUF header exceeds the metadata limit',
  eof: () => 'Unexpected end of GGUF header',
  range: () => 'GGUF length out of range',
  type: (v) => `Unknown GGUF value type ${v}`,
  nested: () => 'Unsupported nested GGUF array',
};

/** The bytes [from, to) of fd, or an "Unexpected end" when the file is shorter than it was. */
function readRange(fd, from, to) {
  const out = Buffer.alloc(to - from);
  let at = 0;
  while (at < out.length) {
    const n = fs.readSync(fd, out, at, out.length - at, from + at);
    if (!n) throw Error('Unexpected end of GGUF header');
    at += n;
  }
  return out;
}

/** The summary of a GGUF file's metadata, decided by the Rust port. */
function readSummaryWasm(file, { wasm = require('./dav-parse-wasm.cjs'), maxWindow = wasm.MAX_GGUF_WINDOW_BYTES } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const first = Math.min(size, READ_CHUNK, maxWindow);
    let segs = first ? [{ off: 0, bytes: readRange(fd, 0, first) }] : [];
    const tooLarge = () => Error('GGUF header could not be checked (too_large)');
    // Every round grows what is held (doubling a run, or a new range), so a real header takes a
    // few dozen; a crafted one that keeps asking for scraps stops here instead of reparsing ~24
    // MiB thousands of times on the event loop.
    // Real files take at most ~13 rounds. Both limits bound the work a crafted header can cause
    // (sbstndalton/noevia#1106): the round count, and the bytes handed to the module in all
    // rounds together (a held ~20 MiB window asking for jumped scraps would otherwise be copied
    // and reparsed hundreds of times).
    const byteBudget = MAX_SENT_WINDOWS * maxWindow;
    let sent = 0;
    for (let round = 0; ; round++) {
      // MAX_ROUNDS calls in all: round 0 is the first, so the (MAX_ROUNDS+1)th never goes out (#1107).
      if (round >= MAX_ROUNDS) throw tooLarge();
      sent += segs.reduce((n, x) => n + x.bytes.length, 0);
      if (sent > byteBudget) throw tooLarge();
      let reply;
      try { reply = wasm.ggufSummary(size, segs); } catch (err) {
        throw Error(`GGUF header could not be checked (${err?.reason || 'unexpected'})`);
      }
      if (reply.summary) return reply.summary;
      if (reply.fail) throw Error(Object.hasOwn(FAIL_MESSAGES, reply.fail) ? FAIL_MESSAGES[reply.fail](reply.value) : 'GGUF header could not be checked (reply)');
      const { at, end } = reply.need || {};
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(end) || at >= end || end > size) throw Error('GGUF header could not be checked (reply)');
      // The range this continues: one holding `at`, or ending at most a chunk before it (a short
      // skip past a held range's end, as in a vocabulary's skipped strings, extends that range
      // instead of starting a new one).
      const run = segs.find((x) => x.off <= at && at <= x.off + x.bytes.length + READ_CHUNK);
      const start = run ? Math.min(at, run.off + run.bytes.length) : at;
      // Merge every range [start, hi) touches into one.
      const merge = (hi) => {
        let lo = start;
        const keep = [];
        for (const x of segs) {
          if (x.off <= hi && x.off + x.bytes.length >= lo) { lo = Math.min(lo, x.off); hi = Math.max(hi, x.off + x.bytes.length); } else keep.push(x);
        }
        return { lo, hi, keep, total: keep.reduce((n, x) => n + x.bytes.length, 0) + (hi - lo) };
      };
      const generous = Math.min(size, Math.max(end, at + Math.max(run ? run.bytes.length : 0, READ_CHUNK)));
      const least = merge(end);
      if (least.total > maxWindow || least.keep.length >= wasm.MAX_GGUF_SEGMENTS) throw tooLarge();
      // Read on generously; near the cap, read up to it, so the next request over it fails fast.
      let m = merge(Math.min(generous, least.hi + (maxWindow - least.total)));
      if (m.total > maxWindow) m = least;
      segs = [...m.keep, { off: m.lo, bytes: readRange(fd, m.lo, m.hi) }].sort((x, y) => x.off - y.off);
    }
  } finally { fs.closeSync(fd); }
}

/** The summary of a GGUF file's metadata (always through the Rust reader). */
function readSummary(file) {
  return readSummaryWasm(file);
}

module.exports = { readSummary, readSummaryWasm, MAX_ROUNDS, MAX_SENT_WINDOWS };
