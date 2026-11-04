'use strict';
// Chat port S6: the chat edge is the Rust front's (noevia-rs bins/noevia-server chat_edge.rs, capability
// rust-chat-edge). The front answers what routes/chat.cjs answered before a turn reached the loop:
//
//   the `llm:<user>` budget (LLM_RATE_LIMIT a minute, default 60), 429 before the body is read;
//   the body cap (STORED_HISTORY_BYTES), 413, or 400 for a failed read;
//   400 invalid JSON, 400 not an object, chat-mode.cjs requestShapeError;
//   Cowork: 403 not an administrator, 409 the harness off, 409 outside a project;
//   404 `spaceId: 'diary'` with the add-on off.
//
// The budget is the one POST /api/diary/local-exchange shares: the front counts that call too (after this process's
// add-on and method checks would have passed) and answers its 429. So this process keeps no `llm:` limiter at all
// (index.cjs; routes/chat.cjs and routes/diary.cjs take none); counting here too would charge each call twice.
//
// Node's order is the inference gate first, then the budget: a call is counted only once the gate let it in, and in
// the order the gate let calls in. So the front takes the gate before it counts anything, and keeps it:
//
//   POST /internal/chat/gate?hold=1[&route=diary-local-exchange]
//       -> the gate's refusal (as POST /api/chat or the local exchange meets it), or 200 with LEASE_HEADER: the gate
//          entered for this call and held while this response stays open. Closing it gives the gate back.
//
// The front then counts the call, answers its refusals while holding the gate (as Node held it through them), and
// sends a call that passes with LEASE_HEADER: the relayed turn or Cowork start (rust-chat-turn.cjs), or the proxied
// local exchange. That request adopts the hold instead of entering the gate again (one gate count per call, as
// before), and gives it back when it ends. A lease is single-use, bound to its route, and unknown once its hold
// response closed; a request whose lease is not live meets the gate as any request does. Nothing is ever given back
// to the budget: the front only counts calls the gate let in.
//
// A Cowork start that passes is sent to POST /internal/chat/cowork (rust-chat-turn.cjs accepts it as a relayed turn,
// so authentication as the front's user and routes/chat.cjs run unchanged and answer the 202). The rest of
// routes/chat.cjs's checks stay here: a request the front passed passes them too, and a front that could not read a
// fact (the code harness flag) leaves the answer to them.
const crypto = require('node:crypto');

// The front capability this module pairs with, for the launch supervisor and assemble-release.
const FRONT_CAPABILITY = 'rust-chat-edge';
const COWORK_PATH = '/internal/chat/cowork';
const LEASE_HEADER = 'x-noevia-gate-lease';
const DIARY_GATE_ROUTE = 'diary-local-exchange';
const LOCAL_EXCHANGE = '/api/diary/local-exchange';

/** The front's gate holds, by lease id. */
function createLeases({ newId = () => crypto.randomBytes(24).toString('hex') } = {}) {
  const live = new Map();
  return {
    /** Answers the hold: 200 with the lease, kept open; the gate is given back when it closes, unless adopted. */
    hold(res, route, leave) {
      const id = newId();
      const lease = { route, leave: typeof leave === 'function' ? leave : () => {}, adopted: false };
      live.set(id, lease);
      res.once('close', () => { live.delete(id); if (!lease.adopted) lease.leave(); });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', [LEASE_HEADER]: id });
      res.write('held\n');
    },
    /** The hold `req` names for `route` (its leave), taken once; the header is always removed. Else null. */
    adopt(req, route) {
      const id = req.headers[LEASE_HEADER];
      delete req.headers[LEASE_HEADER];
      const lease = typeof id === 'string' ? live.get(id) : undefined;
      if (!lease || lease.route !== route || lease.adopted) return null;
      lease.adopted = true;
      live.delete(id);
      return lease.leave;
    },
    size: () => live.size,
  };
}

const leases = createLeases();

module.exports = { FRONT_CAPABILITY, COWORK_PATH, LEASE_HEADER, DIARY_GATE_ROUTE, LOCAL_EXCHANGE, createLeases, leases };
