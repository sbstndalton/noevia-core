'use strict';
// Minimal GGUF v2/v3 metadata reader, adapted from scratchhax/model-loader (MIT,
// e11a6ec, app/gguf_meta.py). Reads only the key/value header, never tensor data.
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

module.exports = { readGguf, summarize, MAX_ARRAY_KEPT };
