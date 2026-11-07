'use strict';
// Test support (not a test file): a synthetic maintenance lease authority over real HTTP with the Rust
// front's semantics (noevia-rs model_maint/lease.rs): one lease, generation fence, ordered server-issued
// incarnations (410 for retired ones), front leases bound to the incarnation they latched. Synthetic only.
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const SECRET = 'synthetic-store-token-0123456789abcdef';

/** A synthetic authority with the front's semantics (lease.rs): one lease, generation fence, ordered
 *  server-issued incarnations (410 for retired ones), front leases bound to the incarnation they latched. */
function createAuthority({ token = SECRET, ttlMs = 180000, renewMs = 10000, hardMs = 3600000 } = {}) {
  const calls = [];
  let holder = null, generation = 0, node = null, incarnations = 0, renew = 'ok';
  const now = () => Date.now();
  const expire = () => { if (holder && (now() >= holder.until || now() >= holder.hardAt)) holder = null; };
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      if (req.headers['x-noevia-store-token'] !== token) return send(401, { error: 'unauthorised' });
      const op = req.url.replace('/v1/maintenance-lease/', '');
      const body = JSON.parse(raw || '{}');
      calls.push({ op, body });
      expire();
      if (op === 'session') {
        if (node && node.boot === body.boot) return send(200, { incarnation: node.inc, frontHeld: holder?.origin === 'front' });
        if (node && body.startedAt <= node.started) return send(410, { code: 'incarnation_retired' });
        node = { inc: ++incarnations, boot: body.boot, started: body.startedAt };
        if (holder?.origin === 'node') holder = null;
        if (holder?.origin === 'front' && holder.bound !== node.inc) holder.fenced = true;
        return send(200, { incarnation: node.inc, frontHeld: holder?.origin === 'front' });
      }
      if (!node || body.incarnation !== node.inc) return send(410, { code: 'incarnation_retired' });
      if (op === 'acquire') {
        if (holder) return send(409, { error: 'Inference is busy. Wait for requests to finish before changing native presets.', code: 'maintenance_held', chatActive: false });
        holder = { origin: 'node', lease: crypto.randomBytes(16).toString('hex'), generation: ++generation, until: now() + ttlMs, hardAt: now() + hardMs };
        return send(201, { lease: holder.lease, generation: holder.generation, epoch: 'e', ttlMs, renewMs, hardMs });
      }
      if (op === 'renew') {
        if (renew === 'hang') return; // never answers: the client's call times out (no answer)
        if (renew === 'error') return send(500, {});
        if (holder && holder.lease === body.lease && renew === 'ok') { holder.until = now() + ttlMs; return send(200, {}); }
        return send(404, { error: 'Not found' });
      }
      if (op === 'release') { if (holder && holder.lease === body.lease) holder = null; return send(204); }
      if (op === 'held') return send(200, { held: !!holder, front: holder?.origin === 'front' });
      return send(404, { error: 'Not found' });
    });
  };
  return {
    handler, calls,
    acquires: () => calls.filter((c) => c.op === 'acquire').length,
    takeAsFront: () => { holder = { origin: 'front', lease: 'f'.repeat(32), generation: ++generation, until: Infinity, hardAt: Infinity, bound: node?.inc ?? null }; },
    releaseFront: () => { if (holder?.origin === 'front') holder = null; },
    forget: () => { holder = null; },
    setRenew: (v) => { renew = v; },
    held: () => holder,
  };
}

async function authority(t, options = {}) {
  const state = createAuthority(options);
  const server = http.createServer(state.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { ...state, port: server.address().port };
}

module.exports = { authority, createAuthority, SECRET };
