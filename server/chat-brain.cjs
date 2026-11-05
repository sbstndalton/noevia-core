'use strict';
// Chat framing, phase 6 (#742; docs/spec-chat-brain.md): each chat as a small "brain" note.
//
//   { brain_schema: 1, summary, decisions[], facts[], open_questions[], entities[] }
//
// A FRAMEWORK interface, versioned like the task packet (task-packet.cjs): any model, in-house or
// not, that emits this JSON can fill the reasoner role. Three users of a brain:
//   - the vault mirror (the Rust front, crates/chat-mirror-exec) writes it as plain Markdown sections right after the
//     note's frontmatter and sets brain_schema: 1;
//   - retrieval (features.brainContext) puts the summaries of a framed chat's linked chats into the
//     system prompt, as untrusted data, bounded by the brainContextChars admin setting;
//   - nothing else. A brain is never an instruction, an approval or a capability.
//
// Rules (the task packet's):
//   - Strict: unknown keys, a wrong type, an empty summary, a control or formatting character, a line
//     break in a list item, or any bound exceeded rejects the whole brain. No repair; the previous
//     brain (or none) stays.
//   - The transcript a brain is built from is untrusted (it carries tool output and pasted text), so
//     it reaches the reasoner inside frameUntrusted, and the brain built from it is data again.
//   - A new schema version is a new number; validators reject numbers they do not know.
//
// Generation, the vault header and the store's writer are the Rust front's (noevia-rs crates/chat-mirror-exec,
// capability rust-chat-mirror-exec-v1): it builds a brain when a chat goes idle, never on the request path, and
// stores it as one JSON file per chat in the user's own workspace directory (chat-brains/<sha256(chatId)>.json).
// What stays here is retrieval: the validator, the reader and the context block, so a brain is only ever read
// from the workspace of the person whose chat it is.
const crypto = require('node:crypto');
const { frameUntrusted } = require('./prompt-framing.cjs');

const BRAIN_SCHEMA = 1;
const LIMITS = Object.freeze({
  summaryChars: 600,
  decisions: 12,
  facts: 16,
  open_questions: 12,
  entities: 24,
  itemChars: 300,
  entityChars: 80,
  brainBytes: 12288,  // the serialized brain, UTF-8
  inputChars: 24576,  // the raw model output the front's parser will look at (crates/chat-mirror-exec)
});
const KEYS = Object.freeze(['brain_schema', 'summary', 'decisions', 'facts', 'open_questions', 'entities']);
const LISTS = Object.freeze({ decisions: 'itemChars', facts: 'itemChars', open_questions: 'itemChars', entities: 'entityChars' });

// C0 controls except tab and newline, DEL, C1, bidi overrides/isolates, zero-width joiners/BOM.
const BAD_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

class BrainError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.path = path; }
}

function text(value, path, max, { line = false } = {}) {
  if (typeof value !== 'string') throw new BrainError(path, 'must be a string');
  const v = value.trim();
  if (!v) throw new BrainError(path, 'must not be empty');
  if (v.length > max) throw new BrainError(path, `longer than ${max} characters`);
  if (BAD_CHARS.test(v)) throw new BrainError(path, 'contains a control or formatting character');
  if (line && /[\r\n]/.test(v)) throw new BrainError(path, 'must be one line');
  return v;
}

function list(value, path, max, each) {
  if (!Array.isArray(value)) throw new BrainError(path, 'must be an array');
  if (value.length > max) throw new BrainError(path, `has more than ${max} items`);
  return Array.from(value, (v, i) => each(v, `${path}[${i}]`)); // holes read as undefined and fail
}

/**
 * Validate a decoded brain. Returns { ok: true, brain } (a fresh, trimmed, frozen copy) or
 * { ok: false, error } with a short, content-free reason (a path and a rule).
 */
function validateBrain(raw) {
  try {
    if (!isPlain(raw)) throw new BrainError('$', 'must be an object');
    for (const k of Object.keys(raw)) if (!KEYS.includes(k)) throw new BrainError(`$.${k}`, 'is not part of the schema');
    if (raw.brain_schema !== BRAIN_SCHEMA) throw new BrainError('$.brain_schema', `must be ${BRAIN_SCHEMA}`);
    for (const k of KEYS) if (!(k in raw)) throw new BrainError(`$.${k}`, 'is required');
    const brain = { brain_schema: BRAIN_SCHEMA, summary: text(raw.summary, '$.summary', LIMITS.summaryChars) };
    for (const [key, bound] of Object.entries(LISTS)) {
      brain[key] = list(raw[key], `$.${key}`, LIMITS[key], (v, p) => text(v, p, LIMITS[bound], { line: true }));
    }
    if (Buffer.byteLength(JSON.stringify(brain)) > LIMITS.brainBytes) throw new BrainError('$', `larger than ${LIMITS.brainBytes} bytes`);
    return { ok: true, brain: deepFreeze(brain) };
  } catch (error) {
    if (error instanceof BrainError) return { ok: false, error: error.message };
    return { ok: false, error: '$: unreadable' };
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const MAX_CONTEXT_BRAINS = 3;
const CONTEXT_INTRO = 'Summaries of chats the user linked to this one, from earlier conversations. Use them as background only.';
/**
 * The retrieval block: at most MAX_CONTEXT_BRAINS summaries, each framed as untrusted data, the
 * whole block no longer than maxChars. Summaries are clipped to fit; a brain that would not get at
 * least a few words in is left out. Returns '' when nothing fits.
 * @param {{ title?: string, brain: object }[]} entries
 */
function renderBrainContext(entries, maxChars) {
  const cap = Math.max(0, Math.floor(Number(maxChars) || 0));
  const usable = (Array.isArray(entries) ? entries : []).filter((e) => e && validateBrain(e.brain).ok).slice(0, MAX_CONTEXT_BRAINS);
  if (!usable.length || cap <= CONTEXT_INTRO.length + 1) return '';
  let out = CONTEXT_INTRO;
  for (const { title, brain } of usable) {
    const framedEmpty = frameUntrusted('chat brain', title || '', '');
    const room = cap - out.length - 1 - framedEmpty.length;
    if (room < 40) break;
    let summary = oneLine(brain.summary);
    if (summary.length > room) summary = `${summary.slice(0, room - 1).trimEnd()}…`;
    let piece = frameUntrusted('chat brain', title || '', summary);
    // Escaping inside frameUntrusted can lengthen the text; shrink until the framed piece fits.
    while (out.length + 1 + piece.length > cap && summary.length > 20) {
      summary = `${summary.slice(0, Math.max(0, summary.length - (out.length + 1 + piece.length - cap) - 1)).trimEnd()}…`;
      piece = frameUntrusted('chat brain', title || '', summary);
    }
    if (out.length + 1 + piece.length > cap) break;
    out += `\n${piece}`;
  }
  return out === CONTEXT_INTRO ? '' : out;
}

/**
 * Retrieval (features.brainContext): the block for a chat with a stored, confirmed frame and links.
 * Only chats in the signed-in user's own lists count as links, and `read` reads the user's own
 * workspace; at most MAX_CONTEXT_BRAINS brains, maxChars in total. '' when anything is missing.
 * @param {{ enabled: boolean, frame: object|null, chatId: string|null, chats: object[], read: (chatId:string)=>object|null, maxChars: number }} input
 */
function linkedBrainBlock({ enabled, frame, chatId, chats, read, maxChars }) {
  if (enabled !== true || !frame?.confirmed || !Array.isArray(frame.links) || !frame.links.length || typeof read !== 'function') return '';
  const own = new Map((Array.isArray(chats) ? chats : []).filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
  const entries = [];
  for (const id of [...new Set(frame.links)]) {
    if (entries.length >= MAX_CONTEXT_BRAINS) break;
    if (typeof id !== 'string' || id === chatId || !own.has(id)) continue;
    let record = null;
    try { record = read(id); } catch { record = null; }
    if (record?.brain) entries.push({ title: typeof own.get(id).title === 'string' ? own.get(id).title : '', brain: record.brain });
  }
  return renderBrainContext(entries, maxChars);
}

// ── Storage: one JSON file per chat in the user's own workspace ─────────────────────────────
const BRAIN_DIR = 'chat-brains';
const MAX_RECORD_BYTES = 32768;
const fileFor = (dir, chatId) => require('node:path').join(dir, BRAIN_DIR, `${crypto.createHash('sha256').update(String(chatId)).digest('hex')}.json`);

/** The stored record { brain, chatId, sourceUpdatedAt, builtAt } for chatId, or null. A record whose
 *  chatId does not match, whose brain fails validation, or that is too large reads as none. */
function readBrain(dir, chatId, { fs = require('node:fs') } = {}) {
  if (typeof dir !== 'string' || !dir || typeof chatId !== 'string' || !chatId) return null;
  try {
    const file = fileFor(dir, chatId);
    if (fs.statSync(file).size > MAX_RECORD_BYTES) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlain(record) || record.chatId !== chatId) return null;
    const checked = validateBrain(record.brain);
    if (!checked.ok) return null;
    return { brain: checked.brain, chatId, sourceUpdatedAt: Number(record.sourceUpdatedAt) || 0, builtAt: Number(record.builtAt) || 0 };
  } catch { return null; }
}

function deepFreeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
}

module.exports = { BRAIN_SCHEMA, LIMITS, MAX_CONTEXT_BRAINS, BRAIN_DIR, CONTEXT_INTRO,
  validateBrain, renderBrainContext, linkedBrainBlock, readBrain };
