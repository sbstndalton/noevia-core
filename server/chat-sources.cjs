'use strict';
// The sources a project reply was grounded in (#552): what retrieval actually placed in the prompt,
// shaped for the browser. Only names of files the caller passes in (the tenant-scoped project's own
// sources) can appear, snippets are short, and nothing here carries a whole document.

const MAX_SOURCES = 12;
const SNIPPET_MAX = 200;
const NAME_MAX = 300;

function snippetOf(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX - 1).trimEnd() + '…' : flat;
}

// #1866: a document chunk starts with the "[Page N]" marker the extractor wrote (rag.chunkText keeps it on
// every chunk, so chunks already indexed carry it too). It is the one page fact retrieval has; report it as a
// number so a citation can say "page 4" without the browser parsing the snippet. Only a leading marker counts.
const PAGE_MAX = 100000;
function pageOf(body) {
  const m = /^\s*\[Page (\d{1,6})\](?:\n|$)/.exec(String(body || '').slice(0, 40));
  return m ? validPage(Number(m[1])) : undefined;
}
function validPage(n) { return Number.isInteger(n) && n >= 1 && n <= PAGE_MAX ? n : undefined; }

function shape(id, file, body, kind, score, page) {
  const item = { id: String(id || file).slice(0, NAME_MAX), file: String(file).slice(0, NAME_MAX), snippet: snippetOf(body), kind: kind === 'excerpt' ? 'excerpt' : 'file' };
  if (kind === 'excerpt' && validPage(page) !== undefined) item.page = page;
  if (typeof score === 'number' && Number.isFinite(score)) item.score = Math.round(score * 1000) / 1000;
  return item;
}

// entries: [{ file, body, score?, kind: 'excerpt' | 'file' }] in prompt order.
// files: the project files this chat may read (already tenant-scoped and skill-filtered).
function buildSources(entries, files) {
  const byName = new Map(require('./source-readability.cjs').readable(files).filter((f) => f && typeof f.name === 'string').map((f) => [f.name, f]));
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (out.length >= MAX_SOURCES) break;
    const f = e && byName.get(e.file);
    if (!f) continue;
    out.push(shape(f.attachment && f.attachment.id, f.name, e.body, e.kind, e.score, e.kind === 'excerpt' ? pageOf(e.body) : undefined));
  }
  return out;
}

// #1793: a whole file injected into the prompt (every small file is, whatever the question) is reported
// only when the question names it (#1457), so an answer that quoted an unnamed knowledge file showed no
// source at all. After the reply, such a file counts as used when the answer carries something
// distinctive from it that the question did not: a token with a digit ("ORCHID-42", "INV-2042", "34.95")
// or a run of four words. A reply that merely shares common words ("red, orange, yellow") adds nothing,
// so #1457 (every project file listed under every answer) stays fixed. Bounded: a capped slice of each text.
const ATTRIBUTE_MAX = 24000;
const words = (text) => String(text || '').slice(0, ATTRIBUTE_MAX).toLowerCase().match(/[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*/gu) || [];
function marks(text) {
  const list = words(text);
  const tokens = new Set(list.filter((w) => w.length >= 4 && /\p{N}/u.test(w) && (/\p{L}/u.test(w) || w.length >= 5)));
  const runs = new Set();
  for (let i = 0; i + 4 <= list.length; i++) runs.add(list.slice(i, i + 4).join(' '));
  return { tokens, runs };
}
/** The injected whole-file entries (not already in `placed`) the answer drew on, in prompt order. */
function usedInjected(injected, placed, answer, question) {
  if (!String(answer || '').trim()) return [];
  const already = new Set((Array.isArray(placed) ? placed : []).map((e) => e && e.file));
  const said = marks(answer), asked = marks(question);
  const out = [];
  for (const e of Array.isArray(injected) ? injected : []) {
    if (!e || e.kind !== 'file' || already.has(e.file)) continue;
    const from = marks(e.body);
    const hit = [...from.tokens].some((t) => said.tokens.has(t) && !asked.tokens.has(t))
      || [...from.runs].some((r) => said.runs.has(r) && !asked.runs.has(r));
    if (hit) { out.push(e); already.add(e.file); }
  }
  return out;
}

// A transcript save may carry `sources` on an assistant turn. It is client-supplied, so it is
// re-bounded here; anything that is not the exact shape is dropped rather than stored.
function sanitizeStored(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const s of list) {
    if (out.length >= MAX_SOURCES) break;
    if (!s || typeof s.file !== 'string' || !s.file) continue;
    out.push(shape(typeof s.id === 'string' ? s.id : '', s.file, s.snippet, s.kind, s.score, s.page));
  }
  return out.length ? out : undefined;
}

// The Skill pin a user turn was sent with (#571), kept so Retry can resend it after a reload. It is
// client-supplied, so only the exact `skill_<32 hex>@<sha256>` string survives; anything else
// (objects, labels, other lengths, extra text) is dropped, and it is never kept on assistant turns.
const STORED_PIN = /^skill_[a-f0-9]{32}@[a-f0-9]{64}$/;
function sanitizePin(value) {
  return typeof value === 'string' && STORED_PIN.test(value) ? value : undefined;
}

// #2116: the failure sentence of an assistant turn whose reply failed. It is saved so a reload still shows the failure
// and Retry. Client-supplied text shown as plain text: kept only as a non-empty string on an assistant turn, bounded.
const STORED_FAILURE_MAX = 1000;
/** An assistant history entry that records a failed reply (#2116): it carries the sentence the person was shown. */
function isFailedTurn(entry) {
  return !!entry && typeof entry === 'object' && entry.role === 'assistant' && sanitizeFailure(entry.failure) !== undefined;
}

function sanitizeFailure(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().slice(0, STORED_FAILURE_MAX);
  return text || undefined;
}

// One history item with its client-supplied `sources`, `skill` and `failure` bounded by its role: sources and a failure
// survive on an assistant turn only, a skill pin on a user turn only. The same object when it carries none of them.
function cleanItem(m, role) {
  if (!m || typeof m !== 'object' || !('sources' in m || 'skill' in m || 'failure' in m)) return m;
  if (!('sources' in m) && !('failure' in m) && role === 'user' && sanitizePin(m.skill) === m.skill) return m; // an exact pin on a user turn: nothing to remove
  const { sources, skill, failure, ...rest } = m;
  const cleanSources = role === 'assistant' ? sanitizeStored(sources) : undefined;
  const cleanSkill = role === 'user' ? sanitizePin(skill) : undefined;
  const cleanFailure = role === 'assistant' ? sanitizeFailure(failure) : undefined;
  return { ...rest, ...(cleanSources ? { sources: cleanSources } : {}), ...(cleanSkill ? { skill: cleanSkill } : {}), ...(cleanFailure ? { failure: cleanFailure } : {}) };
}

function sanitizeHistory(history) {
  const { capEntry } = require('./chat-variants.cjs');
  // #1517: the stored alternatives of a turn are bounded here; #1616: and every alternative, edited version and
  // follow-up turn inside them is cleaned by the same rules as the turn itself.
  return history.map((entry) => {
    const m = capEntry(entry, 0, cleanItem);
    return m && typeof m === 'object' ? cleanItem(m, m.role) : m;
  });
}

module.exports = { MAX_SOURCES, SNIPPET_MAX, STORED_PIN, STORED_FAILURE_MAX, buildSources, usedInjected, sanitizeStored, sanitizePin, sanitizeFailure, isFailedTurn, sanitizeHistory };
