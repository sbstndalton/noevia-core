'use strict';
// sbstndalton/noevia#2153 follow-up (chat port S3): who is active, as the Rust front sees it.
//
// The change journal reader (chat-change-journal.cjs) reads the journals of the users active within
// ACTIVE_MS. It learned that from the requests reaching this process (its `touch` at every request
// start). Once the front answers a route itself (the history save already, the chat turn next), a user
// who only uses such routes never reaches this process, and their mirror and brain would wait for some
// other request. The front sees every request, so it records the authenticated ones:
//
//   UI_DATA_DIR/chat-activity.json   {version: 1, seen: {<userId>: <epoch ms of their latest request>}}
//
// noevia-rs bins/noevia-server chat_activity.rs is its only writer (an atomic rename). It records the
// user of every request whose session (or device token) its upkeep authenticates, writes at once the
// first time it sees a user and otherwise at most every 30 s, with the latest time, so the file holds
// each user's last request within 30 s and the 15-minute stop condition is unchanged. It drops users
// not seen for 15 minutes.
//
// The reader merges each entry into its own last-seen times on every tick: an entry newer than its own
// time is the user's last request. This is additive: the reader's own touch still runs on every request
// here, and a front that writes no file (an older one) leaves the reader as it was.
const path = require('node:path');

/** Grep marker for noevia deploy/tools/assemble-release.sh: this core reads the front's activity file. */
const CHAT_ACTIVITY_READER_MARKER = 'noevia-chat-activity-reader/1';
const ACTIVITY_FILE = 'chat-activity.json';

/** `{ [userId]: epochMs }`; `{}` when the file is missing. Throws when it exists and cannot be read. */
function readActivity(file, fsImpl = require('node:fs')) {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch (error) { if (error && error.code === 'ENOENT') return {}; throw error; }
  const doc = JSON.parse(text);
  const seen = doc && typeof doc === 'object' && doc.version === 1 && doc.seen && typeof doc.seen === 'object' && !Array.isArray(doc.seen) ? doc.seen : {};
  const out = Object.create(null);
  for (const [userId, at] of Object.entries(seen)) if (userId && Number.isFinite(at)) out[userId] = at;
  return out;
}

/**
 * The activity the reader merges: a function answering `{ [userId]: epochMs }`, re-read only when the
 * file's signal changed; `null` while it cannot be read (logged once per run of failures).
 */
function createActivitySource({ dataDir, reread = require('./shared-reread.cjs'), log = (...a) => console.warn(...a) }) {
  const file = path.join(dataDir, ACTIVITY_FILE);
  let failed = false;
  const current = reread.createReread({
    signal: () => reread.fileSignal(file),
    load: () => { const value = readActivity(file); failed = false; return value; },
    fallback: () => { if (!failed) { failed = true; log('chat-activity: the front\'s activity file could not be read'); } return null; },
  });
  return () => current.current();
}

module.exports = { ACTIVITY_FILE, CHAT_ACTIVITY_READER_MARKER, createActivitySource, readActivity };
