'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS reference of the task-packet validator, parser and renderer, kept only so
// tools/gen-prompt-framing-fixtures.cjs can regenerate tests/fixtures/prompt-framing.v1.json and the
// differential tests can compare it with dav-parse.wasm (sbstndalton/noevia-rs crates/prompt-framing).
// Production uses the Rust module alone (server/task-packet.cjs).
// Moved here unchanged from server/task-packet.cjs validatePacketJs, parsePacketJs, renderPacketJs.

const { PACKET_SCHEMA, SOURCE_KINDS, LIMITS } = require('../../../server/task-packet.cjs');
const { frameUntrustedJs } = require('./prompt-framing.cjs');

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

module.exports = { validatePacketJs, parsePacketJs, renderPacketJs };
