'use strict';
// sbstndalton/noevia#2153 (#1071 slice 5a, decision D9): Node reads the per-user chat change
// journal that the Rust store writes (noevia-rs crates/server-projects journal.rs,
// `chat-changes.jsonl`, one entry per transcript mutation under the transcript lock). Once Rust
// answers POST /api/chats/{id}/history (noevia-rs#291), Node never sees that request, so its
// mirrorTrigger nudge (chat-vault-mirror.cjs) cannot fire. This reader replaces that nudge for
// transcript changes: for each new entry it schedules the chat's Diary mirror. The chat's brain
// (a model call) is scheduled only for a history save, as mirrorTrigger did: an entry with
// `op: "write"` and `origin: "history"` read in order. Imports, interrupted-turn appends,
// removals, entries without an `origin` (an older store) and every rescan schedule the mirror
// only (owner decision: no brain builds on import or restart).
//
// - The cursor is kept per user, in memory. The store answers `{ entries, oldestSeq, latestSeq,
//   more, start }` (POST /v1/changes/read, behind the per-start secret and bound to the user).
// - Rescan: this process has not read the user's journal yet (Node restarted, so its debounced
//   nudges were lost), the store's `start` changed (it restarted), the cursor fell behind a
//   rotation (`after < oldestSeq - 1`) or is past the end (the journal was reset). A rescan
//   schedules every chat still in the journal once. Both subsystems are idempotent, so this is
//   safe: the mirror keeps one dirty set per user and rewrites a note from the current transcript;
//   the brain keeps one timer per chat and skips a chat whose stored brain matches the chat's
//   updatedAt ('current').
// - Which users are read: those seen by an authenticated request in this process within
//   ACTIVE_MS, on a short timer (INTERVAL_MS), plus the requesting user at every request start.
//   A history save comes from a signed-in browser that keeps calling Node (chat turns, lists,
//   framing). A user who goes quiet is caught up when they come back: the journal keeps the
//   entries, and a rotation in between is detected and rescanned. Reading every account's
//   journal every 2 s would cost a store call per account with nothing to gain. The timer calls the
//   store only when the journal file's stamp (size, mtime, inode: `stamp`, a local stat) changed
//   since the last read, so an idle user costs one stat per tick and no socket is kept busy.
// - Dedupe: an entry whose chat and revision were already scheduled is skipped. While this reader
//   works (the store answers the op), index.cjs leaves a Node-served history POST to the journal
//   and does not nudge it as well (see `active()`). Against a store without the op (404), the
//   reader stays inactive and mirrorTrigger keeps nudging. Either deploy order is safe; only
//   "Rust owns POST history, Node lacks this reader" is not, and assemble-release refuses it.
// - Failures are logged once per run of failures and retried on the next tick. They never throw
//   into a request or crash the process.

/** Grep marker for noevia deploy/tools/assemble-release.sh: this core tails the chat change journal. */
const JOURNAL_READER_MARKER = 'noevia-chat-change-journal-reader/1';
const INTERVAL_MS = 2000;
const ACTIVE_MS = 15 * 60 * 1000;
/** The most reads in one poll (1,000 entries each) before the next tick goes on. */
const MAX_PAGES = 20;
const RECENT_CAP = 5000;

/**
 * @param {object} deps
 * @param {(user:string, after:number) => Promise<object>} deps.read  the store's changes read: its
 *   body, or `{ unsupported: true }` when the store has no such op (404)
 * @param {(user:string, chatId:string) => void} deps.onChange  schedules the chat's mirror and brain
 * @param {(user:string) => string|null} [deps.stamp]  the journal file's stamp (null: unknown, read)
 */
function createChangeJournalReader({ read, onChange, stamp = () => null, log = (...a) => console.warn(...a), intervalMs = INTERVAL_MS, activeMs = ACTIVE_MS,
  now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  const cursors = new Map(); // user -> { seq, start }
  const seen = new Map(); // user -> last request time
  const running = new Map(); // user -> promise
  const again = new Set(); // users asked for again while a poll ran (it may have read too early)
  const failing = new Set(); // users whose last poll failed (logged once)
  const stamps = new Map(); // user -> the journal stamp at their last good timer read
  const recent = new Map(); // `${user}\n${chatId}` -> revision last scheduled
  let supported = null; // null: not known yet; true: the store journals; false: it has no op
  let timer = null;

  function schedule(user, chatId, revision, brain = false) {
    if (typeof chatId !== 'string' || !chatId) return false;
    const key = `${user}\n${chatId}`;
    if (typeof revision === 'string' && recent.get(key) === revision) return false;
    recent.delete(key);
    recent.set(key, typeof revision === 'string' ? revision : null);
    if (recent.size > RECENT_CAP) recent.delete(recent.keys().next().value);
    try { onChange(user, chatId, { brain: brain === true }); } catch (error) { log('chat-change-journal: scheduling failed', error?.message || String(error)); }
    return true;
  }

  function needsRescan(cursor, body) {
    if (!cursor) return true;
    if (body.start !== cursor.start) return true;
    const oldest = Number.isInteger(body.oldestSeq) ? body.oldestSeq : null;
    const latest = Number.isInteger(body.latestSeq) ? body.latestSeq : null;
    if (oldest !== null && cursor.seq < oldest - 1) return true;
    if (latest === null ? cursor.seq > 0 : cursor.seq > latest) return true;
    return false;
  }

  /** Every chat still in the journal, once each; the cursor moves to the end. */
  async function rescan(user, first) {
    let body = first, after = 0, pages = 0;
    const chats = new Map();
    for (;;) {
      for (const e of body.entries || []) { if (e && typeof e.chatId === 'string') { chats.delete(e.chatId); chats.set(e.chatId, e.revision); } after = Math.max(after, Number(e?.seq) || 0); }
      if (!body.more || ++pages >= MAX_PAGES) break;
      body = await read(user, after);
      if (!body || body.unsupported) return;
    }
    // A rescan schedules even a revision already scheduled: what was pending may have been lost.
    for (const [chatId, revision] of chats) { recent.delete(`${user}\n${chatId}`); schedule(user, chatId, revision); }
    cursors.set(user, { seq: after, start: first.start });
  }

  async function pollOnce(user) {
    const cursor = cursors.get(user);
    let body = await read(user, cursor ? cursor.seq : 0);
    if (!body || body.unsupported) { supported = false; return; }
    supported = true;
    if (needsRescan(cursor, body)) {
      // Read from the start of what is kept (the first read may have begun past it).
      if (cursor) body = await read(user, 0);
      if (!body || body.unsupported) return;
      return rescan(user, body);
    }
    let seq = cursor.seq;
    for (let pages = 0; ; pages++) {
      for (const e of body.entries || []) {
        const s = Number(e?.seq) || 0;
        if (s <= seq) continue;
        seq = s;
        schedule(user, e.chatId, e.revision, isHistorySave(e));
      }
      cursors.set(user, { seq, start: cursor.start });
      if (!body.more || pages + 1 >= MAX_PAGES) break;
      body = await read(user, seq);
      if (!body || body.unsupported) break;
    }
  }

  /** Reads `user`'s new entries now (one poll at a time per user; asked again meanwhile, it reads
   *  once more after). Never rejects. */
  function poll(user) {
    if (typeof user !== 'string' || !user) return Promise.resolve();
    if (running.has(user)) { again.add(user); return running.get(user).then(() => running.get(user)); }
    const p = (async () => {
      try {
        await pollOnce(user);
        if (failing.delete(user)) log('chat-change-journal: reading again for', user);
      } catch (error) {
        stamps.delete(user); // the next tick reads again whatever the stamp says
        if (!failing.has(user)) { failing.add(user); log('chat-change-journal: read failed, retrying', user, error?.message || String(error)); }
      } finally {
        running.delete(user);
        if (again.delete(user)) poll(user);
      }
    })();
    running.set(user, p);
    return p;
  }

  /** A request from `user` started: they are active, and their journal is read now unless its
   *  stamp shows nothing changed since the last good read (a stat, not a store call). */
  function touch(user) {
    if (typeof user !== 'string' || !user) return;
    seen.set(user, now());
    let st = null;
    try { st = stamp(user); } catch { st = null; }
    if (st !== null && cursors.has(user) && stamps.get(user) === st && !failing.has(user)) return;
    if (st !== null) stamps.set(user, st); else stamps.delete(user);
    poll(user);
  }

  function tick() {
    // A store without the op (an older front): nothing to tail; request starts still probe it.
    if (supported === false) return Promise.resolve([]);
    const cutoff = now() - activeMs;
    const polls = [];
    for (const [user, at] of seen) {
      if (at < cutoff) { seen.delete(user); continue; }
      let now = null;
      try { now = stamp(user); } catch { now = null; }
      if (now !== null && cursors.has(user) && stamps.get(user) === now && !failing.has(user)) continue;
      if (now !== null) stamps.set(user, now); else stamps.delete(user);
      polls.push(poll(user));
    }
    return Promise.all(polls);
  }

  return {
    touch, poll, tick,
    /** Whether the store journals transcript changes (its op answered): a history POST that Node
     *  serves is then left to the journal instead of nudged a second time. */
    active: () => supported === true,
    start() { if (!timer) { timer = setTimer(() => { tick(); }, intervalMs); timer?.unref?.(); } return this; },
    stop() { if (timer) { clearTimer(timer); timer = null; } },
    cursor: (user) => cursors.get(user) || null,
  };
}

/** A history POST's save: the only entry that schedules the chat's brain. The Rust store sets
 *  `origin` from the op's caller; without it (an older store) the entry is mirror-only. */
function isHistorySave(e) {
  return !!e && e.op === 'write' && e.origin === 'history';
}

/** The stamp of `<dataDir>/users/<user>/chat-changes.jsonl` (null: no such file yet, or not a
 *  user id), from one stat: size, mtime and inode (a rotation renames a new file in). */
function fileStamp(dataDir, user, fs = require('node:fs'), path = require('node:path')) {
  if (typeof user !== 'string' || !/^[0-9a-f-]{36}$/i.test(user)) return null;
  try {
    const st = fs.statSync(path.join(dataDir, 'users', user, 'chat-changes.jsonl'));
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch { return 'absent'; }
}

/** The change handler index.cjs wires: the mirror always; the brain only for a history save. */
function scheduleMirrorAndBrain({ chatVaultMirror, chatBrains }) {
  return (user, chatId, { brain = false } = {}) => { chatVaultMirror.schedule(user, chatId); if (brain) chatBrains.schedule(user, chatId); };
}

/** Whether a nudge from mirrorTrigger is a transcript save the journal already covers. */
function journalCovers(reader, method, path) {
  return method === 'POST' && /^\/api\/chats\/[^/]+\/history$/.test(path || '') && reader.active();
}

module.exports = { createChangeJournalReader, isHistorySave, scheduleMirrorAndBrain, journalCovers, fileStamp, JOURNAL_READER_MARKER, INTERVAL_MS, ACTIVE_MS };
