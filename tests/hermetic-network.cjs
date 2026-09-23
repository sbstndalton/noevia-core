'use strict';

// Loaded before every test worker. Fail closed if a test accidentally tries to
// reach the machine's model server, a LAN service, or the public Internet.
// Disposable HTTP fixtures bind to 127.0.0.1 on an OS-assigned port.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-hermetic-'));
process.env.UI_DATA_DIR = state;
process.env.INFERENCE_BASE_URL = 'http://127.0.0.1:0';
process.env.MODEL_MANAGER_BASE_URL = 'http://127.0.0.1:0';
process.env.MODEL_MANAGER_KIND = 'none';
process.env.DIARY_BASE_URL = 'http://127.0.0.1:0';
process.env.MODEL_LOADER_URL = '';
process.env.COWORK_DECISION_URL = '';
process.env.COWORK_SYSTEM_ONE_URL = '';
process.env.MCP_SERVERS = '';
process.on('exit', () => fs.rmSync(state, { recursive: true, force: true }));

const originalConnect = net.Socket.prototype.connect;
const fixturePorts = new Set();
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object' && address.address === '127.0.0.1') fixturePorts.add(address.port);
  });
  this.once('close', () => {
    const address = this.__hermeticPort;
    if (address) fixturePorts.delete(address);
  });
  this.once('listening', () => { this.__hermeticPort = this.address()?.port; });
  return originalListen.apply(this, args);
};
net.Socket.prototype.connect = function (...args) {
  // node:net's convenience functions pass their normalized arguments as an
  // array to Socket#connect, whereas callers can pass the options directly.
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof target === 'object' && target !== null ? target :
    { port: target, host: typeof args[1] === 'string' ? args[1] : undefined };
  const host = options.host || options.hostname || 'localhost';
  const port = Number(options.port);
  if (options.path || !['127.0.0.1', 'localhost'].includes(host) || !fixturePorts.has(port)) {
    throw new Error(`Hermetic test refused outbound connection to ${host}:${port}`);
  }
  return originalConnect.apply(this, args);
};
