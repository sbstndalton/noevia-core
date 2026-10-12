'use strict';
// #1507: a reply's partial text survives a reload and a server restart. While a reply streams, its
// partial (text, thinking, tool steps) is written every few seconds to one small file per chat in
// the requesting account's workspace. The file is not the transcript: the client saves the transcript
// with revision checks, and a server write into it would make those saves conflict. So the partial
// is exposed beside the history (GET /api/chats/:id/history -> `partial`) and the web shows it as an
// interrupted turn with Retry and Continue.
//
// Lifecycle: startPartialSaves() supersedes any earlier partial and marks the chat active; every
// interval rewrites the same file (bounded, overwritten in place); finish() clears it, whether the
// reply completed, failed or was left by its client. A client that leaves has its partial kept in the
// transcript by the #679 path (chat-interrupted-turn.cjs), so this file is never the only copy then.
// A partial is only exposed while no reply runs for that chat in this process.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PARTIAL_SAVE_MS = 4000;
const PARTIAL_CAP_CHARS = 64 * 1024; // per text field, the newest characters are kept
const DIR = 'chat-partials';
const active = new Set();

function fileFor(dir, chatId) {
  return path.join(dir, DIR, crypto.createHash('sha256').update(String(chatId)).digest('hex') + '.json');
}

function bounded(entry) {
  const trim = (text) => (typeof text === 'string' && text.length > PARTIAL_CAP_CHARS ? text.slice(-PARTIAL_CAP_CHARS) : text);
  const out = { ...entry, content: trim(entry.content ?? ''), savedAt: Date.now() };
  if (typeof entry.reasoning === 'string') out.reasoning = trim(entry.reasoning);
  if (entry.content && entry.content.length > PARTIAL_CAP_CHARS) out.truncated = true;
  return out;
}

function writePartial(dir, chatId, entry) {
  const file = fileFor(dir, chatId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...bounded(entry), interrupted: true }));
  fs.renameSync(tmp, file);
}

/** The saved partial of a chat, or null. Only meaningful when no reply is running for it. */
function readPartial(dir, chatId) {
  try {
    const value = JSON.parse(fs.readFileSync(fileFor(dir, chatId), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function clearPartial(dir, chatId) {
  fs.rmSync(fileFor(dir, chatId), { force: true });
}

/** What the history route adds: the saved partial, unless a reply for the chat is still running. */
function partialFor(dir, chatId) {
  if (active.has(String(chatId))) return null;
  return readPartial(dir, chatId);
}

/**
 * Starts saving `record`'s partial every `everyMs` for the chat in `dir` (the request's own workspace).
 * Returns { finish() }, which stops the saves and clears the file; call it once the reply has ended.
 */
function startPartialSaves({ dir, chatId, record, everyMs = PARTIAL_SAVE_MS }) {
  const id = String(chatId);
  clearPartial(dir, id);
  active.add(id);
  let done = false;
  const save = () => {
    if (done) return;
    const entry = record.partialEntry();
    if (entry) {
      try { writePartial(dir, id, entry); } catch (error) { console.warn('[chat] could not save the partial reply:', error?.message || error); }
    }
  };
  const timer = setInterval(save, everyMs);
  timer.unref?.();
  return {
    finish() {
      if (done) return;
      done = true;
      clearInterval(timer);
      active.delete(id);
      try { clearPartial(dir, id); } catch { /* best effort: a stale partial is only shown until the next reply or save */ }
    },
  };
}

/** A transcript save that is not from a running reply supersedes a stored partial. */
function supersedePartial(dir, chatId) {
  if (active.has(String(chatId))) return;
  try { clearPartial(dir, chatId); } catch { /* best effort */ }
}

module.exports = { PARTIAL_SAVE_MS, PARTIAL_CAP_CHARS, startPartialSaves, readPartial, partialFor, supersedePartial, fileFor };
