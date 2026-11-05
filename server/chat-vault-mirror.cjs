'use strict';
// Chat framing, phase 5 (#741): mirror chats into the person's own Diary as Obsidian notes.
//
// The mirror is the Rust front's, schedule and work (noevia-rs crates/chat-mirror-sched and crates/chat-mirror-exec,
// capabilities rust-chat-mirror-v1 and rust-chat-mirror-exec-v1): it renders `Chats/<Project|Inbox>/<title>.md`,
// keeps the per-user index (chat-vault-mirror-index.json), moves renamed notes, sends tombstoned chats' notes to the
// Diary's Trash and never overwrites a note it did not write, through the Diary files client as the chat's own user.
// The per-user preference (chat-vault-mirror.json) is the front's too (server-account vault_mirror.rs).
//
// What stays here is the trigger below: which finished requests this process answers make the account's mirror look
// again (rust-chat-mirror.cjs sends the nudge to the front).

/** Should a finished request make this user's mirror look again? Writes to chat lists, moves,
 *  project changes (a renamed project moves its notes) and imports. A transcript save is the Rust
 *  front's (POST /api/chats/{id}/history, sbstndalton/noevia#1071 slice 5): Node never answers it,
 *  and the Rust front's chat mirror schedule (rust-chat-mirror-v1) schedules the mirror (and the brain)
 *  from the store's journal. */
function mirrorTrigger(method, path) {
  if (!method || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  const move = /^\/api\/chats\/([^/]+)\/move$/.exec(path || '');
  if (move) return null; // Rust's move journal is the notification authority.
  return /^\/api\/(freechats(\/|$)|projects(\/|$)|import(\/|$))/.test(path || '') ? { chatId: null } : null;
}

module.exports = { mirrorTrigger };
