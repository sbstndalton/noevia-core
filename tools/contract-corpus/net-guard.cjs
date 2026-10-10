'use strict';
// Loaded with --require into the server the corpus generator boots. The server may connect only
// to loopback ports named in NOEVIA_CORPUS_ALLOWED_PORTS (the mock inference and Diary servers)
// and to its own listeners; anything else (a LAN service, the Internet, a real model server)
// throws, so a corpus run can never reach real data or load a model.
const net = require('node:net');

const allowed = new Set(String(process.env.NOEVIA_CORPUS_ALLOWED_PORTS || '').split(',').map(Number).filter(Boolean));
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => { const a = this.address(); if (a && typeof a === 'object') allowed.add(a.port); });
  return originalListen.apply(this, args);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof target === 'object' && target !== null ? target : { port: target, host: typeof args[1] === 'string' ? args[1] : undefined };
  const host = options.host || options.hostname || 'localhost';
  const port = Number(options.port);
  if (options.path || !['127.0.0.1', 'localhost', '::1'].includes(host) || !allowed.has(port)) {
    throw new Error(`contract corpus run refused outbound connection to ${host}:${port}`);
  }
  return originalConnect.apply(this, args);
};
