'use strict';
// Task packet, schema 1 (#740; docs/spec-task-packet.md). The hand-off contract between the
// gatherer (the role that touches tool output, web pages, files) and the answer model. It is a
// FRAMEWORK interface: any model, in-house or not, that emits this JSON can fill the reasoner role.
//
//   { packet_schema: 1, goal, facts: [{ text, source: { kind, ref }, quote? }], constraints[], open_questions[] }
//
// Rules:
//   - Strict: unknown keys anywhere, a wrong type, an empty goal, a control character or any bound
//     exceeded rejects the whole packet. There is no repair; the caller falls back to the raw tool
//     result. A packet is all or nothing.
//   - Everything in a packet derives from untrusted outside content, so a rendered packet is DATA:
//     renderPacket wraps the whole of it in frameUntrusted (prompt-framing.cjs). Nothing in a packet
//     is ever an instruction, an approval or a capability; the tool layer ignores it (see
//     framing-reasoner.cjs for the write guard).
//   - A new schema version is a new number; validators reject numbers they do not know.
const { frameUntrustedJs, framingImpl, framingWasm } = require('./prompt-framing.cjs');

const PACKET_SCHEMA = 1;
const SOURCE_KINDS = Object.freeze(['tool', 'web', 'file', 'project', 'chat']);
const LIMITS = Object.freeze({
  goalChars: 400,
  facts: 24,
  factChars: 600,
  quoteChars: 400,
  refChars: 300,
  constraints: 12,
  open_questions: 12,
  itemChars: 300,
  packetBytes: 16384, // the serialized packet, UTF-8
  inputChars: 32768,  // the raw model output parsePacket will look at
});

const str = (max, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
/** JSON Schema for engines that support constrained output (response_format json_schema). */
const PACKET_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['packet_schema', 'goal', 'facts', 'constraints', 'open_questions'],
  properties: {
    packet_schema: { type: 'integer', enum: [PACKET_SCHEMA] },
    goal: str(LIMITS.goalChars, 1),
    facts: { type: 'array', maxItems: LIMITS.facts, items: {
      type: 'object', additionalProperties: false, required: ['text', 'source'],
      properties: {
        text: str(LIMITS.factChars, 1),
        source: { type: 'object', additionalProperties: false, required: ['kind', 'ref'],
          properties: { kind: { type: 'string', enum: [...SOURCE_KINDS] }, ref: str(LIMITS.refChars, 1) } },
        quote: str(LIMITS.quoteChars),
      } } },
    constraints: { type: 'array', maxItems: LIMITS.constraints, items: str(LIMITS.itemChars, 1) },
    open_questions: { type: 'array', maxItems: LIMITS.open_questions, items: str(LIMITS.itemChars, 1) },
  },
});

// C0 controls except tab and newline, DEL, C1, bidi overrides/isolates, zero-width joiners/BOM.
const BAD_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

class PacketError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.path = path; }
}

function text(value, path, max, { required = true } = {}) {
  if (typeof value !== 'string') throw new PacketError(path, 'must be a string');
  const v = value.trim();
  if (required && !v) throw new PacketError(path, 'must not be empty');
  if (v.length > max) throw new PacketError(path, `longer than ${max} characters`);
  if (BAD_CHARS.test(v)) throw new PacketError(path, 'contains a control or formatting character');
  return v;
}

function onlyKeys(obj, allowed, path) {
  if (!isPlain(obj)) throw new PacketError(path, 'must be an object');
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new PacketError(`${path}.${k}`, 'is not part of the schema');
}

function list(value, path, max, each) {
  if (!Array.isArray(value)) throw new PacketError(path, 'must be an array');
  if (value.length > max) throw new PacketError(path, `has more than ${max} items`);
  return Array.from(value, (v, i) => each(v, `${path}[${i}]`)); // holes read as undefined and fail
}

/**
 * Validate a decoded packet. Returns { ok: true, packet } (a fresh, trimmed, frozen copy) or
 * { ok: false, error } with a short, text-free reason (a path and a rule, never packet content).
 */
function validatePacketJs(raw) {
  try {
    onlyKeys(raw, ['packet_schema', 'goal', 'facts', 'constraints', 'open_questions'], '$');
    if (raw.packet_schema !== PACKET_SCHEMA) throw new PacketError('$.packet_schema', `must be ${PACKET_SCHEMA}`);
    for (const k of ['goal', 'facts', 'constraints', 'open_questions']) if (!(k in raw)) throw new PacketError(`$.${k}`, 'is required');
    const packet = {
      packet_schema: PACKET_SCHEMA,
      goal: text(raw.goal, '$.goal', LIMITS.goalChars),
      facts: list(raw.facts, '$.facts', LIMITS.facts, (f, p) => {
        onlyKeys(f, ['text', 'source', 'quote'], p);
        onlyKeys(f.source, ['kind', 'ref'], `${p}.source`);
        if (!SOURCE_KINDS.includes(f.source.kind)) throw new PacketError(`${p}.source.kind`, `must be one of ${SOURCE_KINDS.join(', ')}`);
        const fact = { text: text(f.text, `${p}.text`, LIMITS.factChars),
          source: { kind: f.source.kind, ref: text(f.source.ref, `${p}.source.ref`, LIMITS.refChars) } };
        if ('quote' in f) { const q = text(f.quote, `${p}.quote`, LIMITS.quoteChars, { required: false }); if (q) fact.quote = q; }
        return fact;
      }),
      constraints: list(raw.constraints, '$.constraints', LIMITS.constraints, (c, p) => text(c, p, LIMITS.itemChars)),
      open_questions: list(raw.open_questions, '$.open_questions', LIMITS.open_questions, (q, p) => text(q, p, LIMITS.itemChars)),
    };
    if (Buffer.byteLength(JSON.stringify(packet)) > LIMITS.packetBytes) throw new PacketError('$', `larger than ${LIMITS.packetBytes} bytes`);
    return { ok: true, packet: deepFreeze(packet) };
  } catch (error) {
    if (error instanceof PacketError) return { ok: false, error: error.message };
    return { ok: false, error: '$: unreadable' };
  }
}

/**
 * Model output text -> { ok, packet } | { ok: false, reason: 'invalid-json'|'schema', error }.
 * Accepts the bare JSON object, or that object inside ONE ```json fence (unconstrained engines add
 * it). Nothing else is stripped or repaired.
 */
function parsePacketJs(output) {
  if (typeof output !== 'string' || !output.trim() || output.length > LIMITS.inputChars) return { ok: false, reason: 'invalid-json', error: '$: no JSON' };
  let s = output.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(s);
  if (fenced) s = fenced[1].trim();
  let raw;
  try { raw = JSON.parse(s); } catch { return { ok: false, reason: 'invalid-json', error: '$: not JSON' }; }
  const checked = validatePacketJs(raw);
  return checked.ok ? checked : { ok: false, reason: 'schema', error: checked.error };
}

/**
 * The packet as the answer model sees it: one untrusted-data block (prompt-framing.cjs), labelled
 * with the tool it came from. Facts keep their source refs so the answer can cite them.
 */
function renderPacketJs(packet, label = '') {
  const lines = [`Task packet (schema ${PACKET_SCHEMA}), condensed from the tool result.`, `Goal: ${packet.goal}`];
  if (packet.facts.length) {
    lines.push('Facts:');
    packet.facts.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.text} [${f.source.kind}: ${f.source.ref}]`);
      if (f.quote) lines.push(`   Quote: "${f.quote}"`);
    });
  } else lines.push('Facts: none found.');
  if (packet.constraints.length) lines.push('Constraints:', ...packet.constraints.map((c) => `- ${c}`));
  if (packet.open_questions.length) lines.push('Open questions:', ...packet.open_questions.map((q) => `- ${q}`));
  return frameUntrustedJs('task packet', label, lines.join('\n'));
}

function deepFreeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
}

// ── PROMPT_FRAMING_IMPL=wasm (prompt-framing.cjs) ─────────────────────────────────────────────
// The Rust port (noevia-rs crates/prompt-framing) parses, validates and renders; the replies are
// the JS's, message for message. Failures throw (a DavParseError); nothing falls back to the JS.
// validatePacket under wasm takes a JSON tree only (plain objects, dense arrays, strings, finite
// numbers, booleans, null): any other value is '$: unreadable' (the JS also rejects every such
// packet, with its own message). parsePacket sends at most LIMITS.inputChars + 1 units of the
// output (anything longer is '$: no JSON' either way).

/** Whether `v` is a value JSON.parse could have produced (what crosses into the module). */
function jsonTree(v, depth = 0) {
  if (depth > 64) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!(i in v) || !jsonTree(v[i], depth + 1)) return false;
    return true;
  }
  if (!isPlain(v) || typeof v.toJSON === 'function') return false;
  return Object.values(v).every((x) => jsonTree(x, depth + 1));
}

function validatePacketWasm(raw) {
  if (!jsonTree(raw)) return { ok: false, error: '$: unreadable' };
  const r = framingWasm().packetValidate(raw);
  return r.ok ? { ok: true, packet: deepFreeze(r.packet) } : r;
}

function parsePacketWasm(output) {
  if (typeof output !== 'string') return { ok: false, reason: 'invalid-json', error: '$: no JSON' };
  const r = framingWasm().packetParse(output.length > LIMITS.inputChars ? output.slice(0, LIMITS.inputChars + 1) : output);
  return r.ok ? { ok: true, packet: deepFreeze(r.packet) } : r;
}

function renderPacketWasm(packet, label = '') {
  return framingWasm().packetRender(packet, String(label == null ? '' : label));
}

/** validatePacketJs or its Rust port, by PROMPT_FRAMING_IMPL. */
function validatePacket(raw) { return framingImpl() === 'wasm' ? validatePacketWasm(raw) : validatePacketJs(raw); }
/** parsePacketJs or its Rust port, by PROMPT_FRAMING_IMPL. */
function parsePacket(output) { return framingImpl() === 'wasm' ? parsePacketWasm(output) : parsePacketJs(output); }
/** renderPacketJs or its Rust port, by PROMPT_FRAMING_IMPL. */
function renderPacket(packet, label = '') { return framingImpl() === 'wasm' ? renderPacketWasm(packet, label) : renderPacketJs(packet, label); }

module.exports = { PACKET_SCHEMA, PACKET_JSON_SCHEMA, SOURCE_KINDS, LIMITS, validatePacket, parsePacket, renderPacket, validatePacketJs, parsePacketJs, renderPacketJs };
