'use strict';
// A synthetic stand-in for the Rust front's approval registry ops (noevia-rs approval_registry.rs,
// POST /v1/approvals/{open,wait,cancel,granted,revoke}) on a real loopback HTTP server, for the
// Node side's tests. It keeps the front's rules that Node's client relies on: a question belongs to
// one user, a wait is a long-poll, dropping the wait withdraws the question (#679), and an answer is
// consumed once. The front's own tests (noevia-rs tests/tool_approvals.rs) pin the rest.
const http = require('node:http');

async function startFakeApprovalStore({ token = 'synthetic-store-token-0123456789abcdef' } = {}) {
  const questions = new Map(); // id -> { user, kind, chat, scope, binding, answer, waiter }
  const grants = new Map(); // `${user}\n${chat}` -> scope
  const seen = []; // { op, body }
  const dropped = []; // ids whose wait Node dropped
  const tickets = Object.assign(new Map(), { count: 0 });
  const down = new Set(); // ops answered by dropping the connection, as a front that is down
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const reply = (status, body) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-noevia-store-token'] !== token) return reply(401, { error: 'unauthorised' });
      const op = String(req.url).replace(/^\/v1\/approvals\//, '');
      if (down.has(op)) { seen.push({ op, down: true }); req.socket.destroy(); return undefined; }
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400, { error: 'invalid JSON' }); }
      seen.push({ op, body });
      const q = questions.get(body.id);
      const mine = q && q.user === body.user;
      switch (op) {
        case 'open':
          if (questions.has(body.id)) return reply(409, { error: 'approval already open', code: 'APPROVAL_EXISTS' });
          questions.set(body.id, { ...body, answer: null, waiter: null });
          return reply(200, { opened: true });
        case 'wait':
          if (!mine || q.waiter) return reply(404, { error: 'no such pending approval' });
          if (q.answer) { questions.delete(body.id); return reply(200, q.answer); }
          q.waiter = (answer) => { questions.delete(body.id); reply(200, answer); };
          res.on('close', () => {
            if (res.writableEnded) return;
            questions.delete(body.id);
            dropped.push(body.id);
          });
          return undefined;
        case 'cancel':
          if (mine && !q.waiter) questions.delete(body.id);
          return reply(200, { cancelled: !!mine });
        case 'granted': {
          const granted = grants.get(`${body.user}\n${body.chat}`) === body.scope && !!body.binding;
          if (!granted) return reply(200, { granted: false });
          const ticket = `ticket-${++tickets.count}`;
          tickets.set(ticket, `${body.user}\n${body.chat}\n${body.scope}`);
          return reply(200, { granted: true, ticket });
        }
        case 'redeem': {
          // Single use; refused once the grant is gone (a revoke ordered before the redeem).
          const want = tickets.get(body.ticket);
          tickets.delete(body.ticket);
          return reply(200, { redeemed: want === `${body.user}\n${body.chat}\n${body.scope}` && grants.get(`${body.user}\n${body.chat}`) === body.scope });
        }
        case 'revoke':
          return reply(200, { revoked: grants.delete(`${body.user}\n${body.chat}`) });
        default:
          return reply(404, { error: 'not found' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  /** The person's answer through the public route: false when there is nothing to answer. */
  function answer(user, id, outcome) {
    const q = questions.get(id);
    if (!q || q.user !== user || q.answer) return false;
    if (q.waiter) q.waiter(outcome); else q.answer = outcome;
    return true;
  }
  const close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return { port, token, seen, dropped, down, questions, grants, answer, close };
}

module.exports = { startFakeApprovalStore };
