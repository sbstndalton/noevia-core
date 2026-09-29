'use strict';
// #658: the writes that already succeeded in one chat.
//
// Two uses, both advisory. Neither approves, refuses or skips anything; the approval gate
// stays the only thing that lets a write run.
//  - A write proposed again with the same tool, the same resolved target and the same
//    arguments, right after one that succeeded, is flagged on its approval card
//    ("This looks like the change you just approved").
//  - Completed writes are written into the history the model sees on the next turn
//    (see chat.cjs normalizeReplayHistory), so it does not redo a step it already did.
//
// In memory, per account and chat, bounded and short-lived. The chat's own history carries
// the same facts across a restart (applied tool entries), so losing this map only loses the
// flag for writes whose record the client no longer sends.
const crypto = require('node:crypto');

const TTL_MS = 6 * 60 * 60 * 1000;
const PER_CHAT = 20;
const MAX_CHATS = 500;

/** JSON with object keys sorted, so `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same call. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** One write, as the approval card shows it: tool, resolved target (or none), arguments. */
function fingerprint(name, target, rawArgs) {
  let args;
  try { args = canonical(JSON.parse(typeof rawArgs === 'string' && rawArgs ? rawArgs : '{}')); }
  catch { args = String(rawArgs || ''); }
  const where = typeof target === 'string' && target ? target : null;
  return crypto.createHash('sha256').update(JSON.stringify([String(name || ''), where, args])).digest('hex');
}

function createRecentWrites({ now = Date.now, ttlMs = TTL_MS, perChat = PER_CHAT, maxChats = MAX_CHATS } = {}) {
  const chats = new Map(); // key -> [{ fp, at }], oldest first
  const keyOf = (userId, chatId) => (userId && chatId ? `${userId}\u0000${chatId}` : null);
  const live = (key) => {
    const list = (chats.get(key) || []).filter((w) => now() - w.at <= ttlMs);
    if (list.length) chats.set(key, list); else chats.delete(key);
    return list;
  };
  return {
    record(userId, chatId, fp) {
      const key = keyOf(userId, chatId);
      if (!key || typeof fp !== 'string') return;
      const list = [...live(key), { fp, at: now() }].slice(-perChat);
      chats.delete(key); // re-insert, so the map's order is least recently written first
      chats.set(key, list);
      while (chats.size > maxChats) chats.delete(chats.keys().next().value);
    },
    has(userId, chatId, fp) {
      const key = keyOf(userId, chatId);
      return !!key && live(key).some((w) => w.fp === fp);
    },
  };
}

module.exports = { createRecentWrites, fingerprint, canonical };
