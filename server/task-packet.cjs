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
const { framingWasm } = require('./prompt-framing.cjs');

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

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function deepFreeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
}

// ── The Rust port (prompt-framing.cjs), always (since #1071; it was PROMPT_FRAMING_IMPL=wasm) ──
// The Rust port (noevia-rs crates/prompt-framing) parses, validates and renders; the replies are
// the JS reference's (tests/server/oracle/task-packet.cjs), message for message. Failures throw (a
// DavParseError); nothing falls back to JS.
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

/** Validate a decoded packet. Returns { ok: true, packet } (a fresh, trimmed, frozen copy) or
 *  { ok: false, error } with a short, text-free reason (a path and a rule, never packet content). */
function validatePacket(raw) { return validatePacketWasm(raw); }
/** Model output text -> { ok, packet } | { ok: false, reason: 'invalid-json'|'schema', error }. Accepts
 *  the bare JSON object, or that object inside ONE ```json fence. Nothing else is stripped or repaired. */
function parsePacket(output) { return parsePacketWasm(output); }
/** The packet as the answer model sees it: one untrusted-data block, labelled with its tool. */
function renderPacket(packet, label = '') { return renderPacketWasm(packet, label); }

module.exports = { PACKET_SCHEMA, PACKET_JSON_SCHEMA, SOURCE_KINDS, LIMITS, validatePacket, parsePacket, renderPacket };
