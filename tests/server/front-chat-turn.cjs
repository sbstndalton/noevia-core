'use strict';
// Chat port S5: POST /api/chat reaches Node only as the Rust front's relay (server/rust-chat-turn.cjs). Tests that
// drive index.cjs's handleRequest in-process send their turn the way the front does: to /internal/chat/turn from a
// loopback peer, with the per-start secret (the one installProjectStore handed index.cjs) and the user
// the front authenticated. The client's own credentials and headers ride along unchanged.
const { TURN_PATH, TOKEN_HEADER, USER_HEADER } = require('../../server/rust-chat-turn.cjs');

/** `[url, init]` for a test's request(url, init) helper; the helper gives the fake request `init.peer`. */
function frontTurn(init, userId) {
  return [TURN_PATH, { ...init, peer: '127.0.0.1', headers: { ...(init.headers || {}), [TOKEN_HEADER]: require('./project-store-server.cjs').installedToken(), [USER_HEADER]: userId } }];
}

module.exports = { frontTurn };
