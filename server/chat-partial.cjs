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
//
// sbstndalton/noevia#1071 (slice 1 of moving this state to Rust): every save also records which
// container start wrote it, `running: { start }`, with the per-start id the web supervisor hands
// both processes (NOEVIA_START_ID). A reader in another process (the Rust front's history route,
// later) can then tell a reply still running (marker from this start) from one a crash or restart
// cut off (no marker, or another start's): the file is cleared when a reply ends, so a marker from
// the current start means it is still running. The marker is internal: partialFor strips it, and
// this process still decides with its own Set. Slice 2: the history GET is the Rust front's and
// decides from the marker alone, so a finished reply whose file cannot be removed has its marker
// taken out instead (endPartial, sbstndalton/noevia#2146).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PARTIAL_SAVE_MS = 4000;
const PARTIAL_CAP_CHARS = 64 * 1024; // per text field, the newest characters are kept
const DIR = 'chat-partials';
const active = new Set();
// The supervisor's id for this container start (32 lowercase hex). Without one (tests, a Node run
// by hand) this process makes its own, so its markers never match another process's start.
const START_ID_RE = /^[0-9a-f]{32}$/;
const START_ID = START_ID_RE.test(process.env.NOEVIA_START_ID || '') ? process.env.NOEVIA_START_ID : crypto.randomBytes(16).toString('hex');

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
  fs.writeFileSync(tmp, JSON.stringify({ ...bounded(entry), interrupted: true, running: { start: START_ID } }));
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

/**
 * sbstndalton/noevia#2146: a finished reply whose partial could not be removed (EACCES, EIO, ...)
 * must not leave this start's `running` marker behind, or a reader in another process (the Rust
 * front's history route) takes the reply for one still running and hides its partial until the
 * next container start. So the file is rewritten without the marker: atomically when the folder
 * allows it, else in place (a folder that refuses the unlink usually refuses the rename too). It is
 * then offered like any interrupted partial, as this process's own set already does. Every failure
 * is logged as an error; the reply itself has ended either way.
 */
function endPartial(dir, chatId) {
  const file = fileFor(dir, chatId);
  try {
    clearPartial(dir, chatId);
    return 'cleared';
  } catch (error) {
    console.error(`[chat] could not remove a finished reply's partial (${file}); rewriting it without the running marker:`, error?.message || error);
  }
  const value = readPartial(dir, chatId);
  if (!value || !('running' in value)) return 'kept';
  const { running: _running, ...ended } = value;
  return writeUnmarked(file, JSON.stringify(ended));
}

// Writes a partial without the running marker: atomically when the folder allows it, else in place.
function writeUnmarked(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* the folder refuses writes */ }
      fs.writeFileSync(file, text);
    }
    return 'unmarked';
  } catch (error) {
    console.error(`[chat] could not rewrite a finished reply's partial (${file}) either; its running marker stays until the next start, and the history hides it until then:`, error?.message || error);
    return 'stuck';
  }
}

/** What the history route adds: the saved partial, unless a reply for the chat is still running. */
function partialFor(dir, chatId) {
  if (active.has(String(chatId))) return null;
  const value = readPartial(dir, chatId);
  if (!value) return null;
  const { running: _running, ...offered } = value;
  return offered;
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
    // `keep`: the reply's final partial entry when the transcript did not take it (store failure,
    // no user message to append after). The file is then rewritten with it, without the running
    // marker, so the reply is still offered as an interrupted turn instead of lost.
    finish({ keep } = {}) {
      if (done) return;
      done = true;
      clearInterval(timer);
      active.delete(id);
      if (keep) {
        const outcome = writeUnmarked(fileFor(dir, id), JSON.stringify({ ...bounded(keep), interrupted: true }));
        if (outcome === 'unmarked') return;
      }
      endPartial(dir, id);
    },
  };
}

/** A transcript save that is not from a running reply supersedes a stored partial. */
function supersedePartial(dir, chatId) {
  if (active.has(String(chatId))) return;
  try { clearPartial(dir, chatId); } catch { /* best effort */ }
}

module.exports = { START_ID, PARTIAL_SAVE_MS, PARTIAL_CAP_CHARS, startPartialSaves, readPartial, partialFor, supersedePartial, fileFor, endPartial };
