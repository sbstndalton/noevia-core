'use strict';
// Minimal GGUF v2/v3 metadata reader, adapted from scratchhax/model-loader (MIT,
// e11a6ec, app/gguf_meta.py). Reads only the key/value header, never tensor data.
//
// GGUF_META_IMPL=js|wasm (default js; any other value means js, with one warning), read on every
// readSummary: wasm parses the header in noevia-rs's gguf crate (gguf::node, in dav-parse.wasm)
// and returns exactly summarize(readGguf(file)). The file I/O stays here: the module gets the
// file's size and the byte ranges read so far (the first 4 KiB, then each range it names: as
// much again as the range it continues (a skip of at most 4 KiB past a range continues it), 4 KiB
// after a jump; at most 24 MiB in 512 ranges and 1088 rounds);
// bytes the JS skips are not read. Fails closed: the flag is in dav-parse-wasm.cjs IMPL_FLAGS (a
// missing or tampered module stops startup), and a refusal, a trap or a reply of the wrong shape
// throws, never falls back to the JS. Stricter than the JS, as that refusal: more than 24 MiB of
// header bytes read (not skipped), arrays nested more than 64 deep, more than 262,144 values kept.
const fs = require('node:fs');

const SCALAR = { 0: [1, 'readUInt8'], 1: [1, 'readInt8'], 2: [2, 'readUInt16LE'], 3: [2, 'readInt16LE'], 4: [4, 'readUInt32LE'], 5: [4, 'readInt32LE'], 6: [4, 'readFloatLE'], 7: [1, 'readUInt8'], 10: [8, 'readBigUInt64LE'], 11: [8, 'readBigInt64LE'], 12: [8, 'readDoubleLE'] };
const STRING = 8, ARRAY = 9, BOOL = 7;
// Per-layer arrays (Gemma's sliding-window pattern, per-layer KV heads) must be kept
// whole; vocabularies and merges are skipped.
const MAX_ARRAY_KEPT = 1024;
const MAX_STRING_KEPT = 256 * 1024;
const MAX_HEADER_BYTES = 128 * 1024 * 1024;
const CHUNK = 1024 * 1024;

class Reader {
  constructor(fd) { this.fd = fd; this.buf = Buffer.alloc(0); this.base = 0; this.pos = 0; }
  ensure(n) {
    const end = this.pos + n;
    if (end > MAX_HEADER_BYTES) throw Error('GGUF header exceeds the metadata limit');
    while (this.base + this.buf.length < end) {
      // Drop consumed bytes so skipped vocabularies do not accumulate in memory. A skip
      // can move past everything buffered, so reading resumes at the later offset.
      const from = Math.max(this.pos, this.base + this.buf.length);
      const keep = this.pos < this.base + this.buf.length ? this.buf.subarray(this.pos - this.base) : Buffer.alloc(0);
      const chunk = Buffer.alloc(Math.max(CHUNK, end - from));
      const read = fs.readSync(this.fd, chunk, 0, chunk.length, from);
      if (!read) throw Error('Unexpected end of GGUF header');
      this.base = this.pos;
      this.buf = Buffer.concat([keep, chunk.subarray(0, read)]);
    }
  }
  take(n) { this.ensure(n); const at = this.pos - this.base; this.pos += n; return this.buf.subarray(at, at + n); }
  skip(n) { if (this.pos + n > MAX_HEADER_BYTES) throw Error('GGUF header exceeds the metadata limit'); this.pos += n; }
  u32() { return this.take(4).readUInt32LE(0); }
  u64() { const v = this.take(8).readBigUInt64LE(0); if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('GGUF length out of range'); return Number(v); }
  string() { const n = this.u64(); if (n > MAX_STRING_KEPT) { this.skip(n); return null; } return this.take(n).toString('utf8'); }
  scalar(type) {
    const [size, method] = SCALAR[type];
    const v = this.take(size)[method](0);
    if (type === BOOL) return v !== 0;
    return typeof v === 'bigint' ? Number(v) : v;
  }
  value(type) {
    if (SCALAR[type]) return this.scalar(type);
    if (type === STRING) return this.string();
    if (type !== ARRAY) throw Error(`Unknown GGUF value type ${type}`);
    const sub = this.u32(), count = this.u64();
    if (count > MAX_ARRAY_KEPT) {
      if (sub === STRING) for (let i = 0; i < count; i++) this.skip(this.u64());
      else if (SCALAR[sub]) this.skip(SCALAR[sub][0] * count);
      else throw Error('Unsupported nested GGUF array');
      return { array: true, count };
    }
    const out = [];
    for (let i = 0; i < count; i++) out.push(this.value(sub));
    return out;
  }
}

function readGguf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const r = new Reader(fd);
    if (r.take(4).toString('latin1') !== 'GGUF') throw Error('Not a GGUF file');
    const version = r.u32();
    if (version < 2 || version > 3) throw Error(`Unsupported GGUF version ${version}`);
    r.u64(); // tensor count
    const kvCount = r.u64(), kv = {};
    for (let i = 0; i < kvCount; i++) {
      const key = r.string(), type = r.u32();
      kv[key] = r.value(type);
    }
    return kv;
  } finally { fs.closeSync(fd); }
}

const int = v => Array.isArray(v) ? mode(v) : (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : (typeof v === 'boolean' ? Number(v) : null));
function mode(values) {
  const counts = new Map();
  for (const v of values) if (typeof v === 'number') counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

// Architecture-scoped fields the memory estimator needs.
function summarize(kv) {
  const arch = typeof kv['general.architecture'] === 'string' ? kv['general.architecture'] : '';
  const a = key => kv[`${arch}.${key}`];
  const template = typeof kv['tokenizer.chat_template'] === 'string' ? kv['tokenizer.chat_template'] : '';
  return {
    arch,
    name: typeof kv['general.name'] === 'string' ? kv['general.name'] : '',
    contextLength: int(a('context_length')),
    embeddingLength: int(a('embedding_length')),
    blockCount: int(a('block_count')),
    headCount: int(a('attention.head_count')),
    headCountKv: a('attention.head_count_kv') ?? null,
    keyLength: int(a('attention.key_length')),
    valueLength: int(a('attention.value_length')),
    keyLengthSwa: int(a('attention.key_length_swa')),
    valueLengthSwa: int(a('attention.value_length_swa')),
    slidingWindow: int(a('attention.sliding_window')),
    slidingWindowPattern: a('attention.sliding_window_pattern') ?? null,
    sharedKvLayers: int(a('attention.shared_kv_layers')),
    fullAttentionInterval: int(a('full_attention_interval')),
    ssmStateSize: int(a('ssm.state_size')),
    expertCount: int(a('expert_count')),
    nextnPredictLayers: int(a('nextn_predict_layers')),
    hasChatTemplate: !!template,
  };
}

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** GGUF_META_IMPL: 'js' (default) or 'wasm'. */
function ggufImpl(env = process.env) {
  const raw = env.GGUF_META_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[gguf-meta] GGUF_META_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}

// The first read, and the read after a jump past skipped bytes; reading on from a held range
// doubles that range, so a contiguous header takes a few rounds and a jump wastes little.
const READ_CHUNK = 4 * 1024;
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

/** summarize(readGguf(file)) decided by the Rust port. */
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
    const maxRounds = 2 * wasm.MAX_GGUF_SEGMENTS + 64;
    for (let round = 0; ; round++) {
      if (round > maxRounds) throw tooLarge();
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

/** summarize(readGguf(file)), by GGUF_META_IMPL. */
function readSummary(file) {
  return ggufImpl() === 'wasm' ? readSummaryWasm(file) : summarize(readGguf(file));
}

module.exports = { readGguf, summarize, readSummary, readSummaryWasm, ggufImpl, MAX_ARRAY_KEPT };
