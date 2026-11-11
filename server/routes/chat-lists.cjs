'use strict';
// The chat lists and transcripts (the store is projects.cjs):
//   (GET /api/workspace is the Rust front's, #2191 close-out: rust-workspace.cjs. It runs the delete-old-chats
//   sweep and the removal of orphaned chat-attachment projects that this route used to run.)
//   (GET /api/chats/search?q=, #1450, and GET /api/chats/:id/export, #1471, are the Rust front's:
//   rust-chat-search.cjs and rust-chat-export.cjs refuse them before authentication.)
//   (GET/POST /api/freechats and DELETE /api/freechats/:id are the Rust front's, #1071)
//   POST /api/chats/:id/move               { projectId: string|null, frame? } moves the meta between
//                                          the caller's own lists (#738); the transcript stays put
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Blocks keep their original order and an unmatched method falls through as it did inline.

const PASS = Symbol('unhandled');

/**
 * Every route this mount answered is now the Rust front's; it stays mounted (answering nothing) so a
 * request that reaches it falls through as before. index.cjs still passes the old dependencies.
 */
function createChatListRoutes() {
  async function handle() {
    // GET /api/chats/search (#1450) is the Rust front's (noevia-rs crates/server-projects workspace.rs `search`):
    // index.cjs refuses it before this mount (rust-chat-search.cjs).
    // GET /api/chats/:id/context-window (a chat's last context meter) is the Rust front's
    // (sbstndalton/noevia#1071): index.cjs refuses it before this mount (rust-projects.cjs refuseOwnedRoute).

    // GET /api/chats/:id/export (#1471) is the Rust front's (noevia-rs crates/server-export markdown.rs, the same
    // Markdown writer as chat-export.cjs chatMarkdown): index.cjs refuses it before this mount (rust-chat-export.cjs).
    // Other methods were never answered here and still fall through.

    // GET and POST /api/freechats and DELETE /api/freechats/{id} are the Rust front's
    // (sbstndalton/noevia#1071; the delete is slice 6, one store operation): index.cjs refuses them
    // before this mount (rust-projects.cjs refuseOwnedRoute).

    // POST /api/chats/{chatId}/move is Rust-owned; index.cjs refuses it before this mount.

    // GET and POST /api/chats/:id/history are the Rust front's (sbstndalton/noevia#1071 slices 4
    // and 5): index.cjs refuses both before this mount (rust-projects.cjs refuseOwnedRoute). The
    // Rust store journals each save and the front's chat mirror schedule (rust-chat-mirror-v1) schedules the mirror and brain.
    return PASS;
  }

  return async function chatListRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createChatListRoutes };
