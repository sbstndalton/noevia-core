'use strict';
// Shared by tools/gen-gguf-meta-fixtures.cjs and tests/server/gguf-meta-differential.test.cjs
// (here, not in tools/, so the runtime-image job that mounts only tests/ can run the test): the
// synthetic GGUF builder, the canonical summary text and the fixture byte packing.

// --- canonical summary text ------------------------------------------------------------------
function encNum(v) {
  if (Number.isNaN(v)) return '{"$num":"NaN"}';
  if (v === Infinity) return '{"$num":"Infinity"}';
  if (v === -Infinity) return '{"$num":"-Infinity"}';
  if (Object.is(v, -0)) return '{"$num":"-0"}';
  return String(v);
}
function encStr(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u === 0x22) out += '\\"';
    else if (u === 0x5c) out += '\\\\';
    else if (u === 0x08) out += '\\b';
    else if (u === 0x0c) out += '\\f';
    else if (u === 0x0a) out += '\\n';
    else if (u === 0x0d) out += '\\r';
    else if (u === 0x09) out += '\\t';
    else if (u >= 0x20 && u <= 0x7e) out += s[i];
    else out += `\\u${u.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}
function encVal(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return encNum(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return encStr(v);
  if (Array.isArray(v)) return `[${v.map(encVal).join(',')}]`;
  if (v && v.array === true && Object.keys(v).length === 2) return `{"array":true,"count":${encNum(v.count)}}`;
  throw Error(`unexpected value ${typeof v}`);
}
function encodeSummary(s) {
  return `{${Object.entries(s).map(([k, v]) => `${encStr(k)}:${encVal(v)}`).join(',')}}`;
}

// --- GGUF builder ----------------------------------------------------------------------------
const T = { u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6, bool: 7, str: 8, arr: 9, u64: 10, i64: 11, f64: 12 };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const raw = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
const str = (s) => { const b = raw(s); return Buffer.concat([u64(b.length), b]); };
function scalar(type, v) {
  const b = Buffer.alloc({ 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }[type]);
  switch (type) {
    case 0: b.writeUInt8(v); break;
    case 1: b.writeInt8(v); break;
    case 2: b.writeUInt16LE(v); break;
    case 3: b.writeInt16LE(v); break;
    case 4: b.writeUInt32LE(v); break;
    case 5: b.writeInt32LE(v); break;
    case 6: b.writeFloatLE(v); break;
    case 7: b.writeUInt8(v ? 1 : 0); break;
    case 10: b.writeBigUInt64LE(BigInt(v)); break;
    case 11: b.writeBigInt64LE(BigInt(v)); break;
    default: b.writeDoubleLE(v);
  }
  return b;
}
// A typed value: [type, payload-bytes].
const S = (type, v) => [type, scalar(type, v)];
const STR = (s) => [T.str, str(s)];
const ARR = (sub, items, count = items.length) => [T.arr, Buffer.concat([u32(sub), u64(count), ...items.map((x) => (Array.isArray(x) ? x[1] : x))])];
const kv = (key, [type, payload]) => Buffer.concat([str(key), u32(type), payload]);
function gguf(kvs, { version = 3, tensors = 0, kvCount = kvs.length, magic = 'GGUF' } = {}) {
  return Buffer.concat([Buffer.from(magic, 'latin1'), u32(version), u64(tensors), u64(kvCount), ...kvs]);
}
const arch = (a) => kv('general.architecture', STR(a));

function packBytes(buf) {
  const parts = [];
  let lit = '';
  for (let i = 0; i < buf.length;) {
    let j = i;
    while (j < buf.length && buf[j] === buf[i]) j++;
    if (j - i >= 16) {
      if (lit) { parts.push(lit); lit = ''; }
      parts.push([buf.subarray(i, i + 1).toString('hex'), j - i]);
    } else lit += buf.subarray(i, j).toString('hex');
    i = j;
  }
  if (lit) parts.push(lit);
  return parts;
}
function unpackBytes(parts) {
  return Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'hex') : Buffer.alloc(p[1], Buffer.from(p[0], 'hex')))));
}

module.exports = { encodeSummary, packBytes, unpackBytes, T, u32, u64, raw, str, scalar, S, STR, ARR, kv, gguf, arch };
