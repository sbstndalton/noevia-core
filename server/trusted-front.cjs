'use strict';
// The Rust front's own direct loopback call to this process (sbstndalton/noevia#2210, #2218): one check for every
// internal route it calls (the model maintenance lease, the inference admission lease, the research bridge), so
// they cannot drift apart. Three things together: the peer is loopback, the request is not one the front is
// proxying (a proxied request carries the client's address), and it carries the per-start secret the web supervisor
// hands both processes (NOEVIA_PROJECT_STORE_TOKEN, header x-noevia-store-token). An empty secret trusts nobody.
const crypto = require('node:crypto');

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

function sameSecret(given, secret) {
  if (typeof given !== 'string' || !secret) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function trustedFront(req, secret) {
  return LOOPBACK.test(req.socket?.remoteAddress || '')
    && !req.headers['x-noevia-client-ip'] && !req.headers['x-forwarded-for']
    && sameSecret(req.headers['x-noevia-store-token'], secret);
}

module.exports = { trustedFront, sameSecret, LOOPBACK };
