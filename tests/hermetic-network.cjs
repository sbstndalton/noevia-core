'use strict';

// Loaded before every test worker. Fail closed if a test accidentally tries to
// reach the machine's model server, a LAN service, or the public Internet.
// Disposable HTTP fixtures bind to 127.0.0.1 on an OS-assigned port.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

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
const fixturePorts = new Map(); // port -> exact live owners (not a global port exemption)
const nodeServers = new WeakMap();
const spawnedNative = new WeakMap();
const liveNative = new Set();
const nativeBinary = process.env.NOEVIA_EGRESS_CONTROL_BINARY;
const nativeDigest = process.env.NOEVIA_EGRESS_CONTROL_BINARY_SHA256;
const directory = fs.realpathSync(state);
const allow = (port, owner) => { const owners = fixturePorts.get(port) || new Set(); owners.add(owner); fixturePorts.set(port, owners); };
const revoke = (port, owner) => { const owners = fixturePorts.get(port); if (!owners) return; owners.delete(owner); if (!owners.size) fixturePorts.delete(port); };
const refusal = () => Error('Hermetic native fixture ownership refused');
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const record = { port: null, owner: {}, closed: false };
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object' && address.address === '127.0.0.1') {
      record.port = address.port; nodeServers.set(this, record); allow(record.port, record.owner);
    }
  });
  this.once('close', () => { record.closed = true; if (record.port) revoke(record.port, record.owner); });
  return originalListen.apply(this, args);
};
// Capture only real, current-process spawns of the explicitly configured reviewed
// binary. Tests cannot register an arbitrary ChildProcess-shaped object or port.
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (file, args, ...rest) {
  let candidate = false;
  if (typeof file === 'string' && file === nativeBinary) {
    if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || !/^[0-9a-f]{64}$/.test(nativeDigest || '') || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== nativeDigest) throw refusal();
    candidate = true;
  }
  const child = originalSpawn.call(this, file, args, ...rest);
  if (candidate) spawnedNative.set(child, { args: Array.isArray(args) ? [...args] : [], pid: child.pid });
  return child;
};
Object.defineProperty(globalThis, Symbol.for('noevia.hermetic.nativeFixture.v1'), { value: Object.freeze({
  directory,
  reserve(server) {
    const record = nodeServers.get(server);
    if (!record || record.closed || !server.listening || !fixturePorts.get(record.port)?.has(record.owner)) throw refusal();
    let used = false;
    return Object.freeze({ adopt(child) {
      const spawned = spawnedNative.get(child), args = spawned?.args;
      if (used || !record.closed || server.listening || nodeServers.get(server) !== record || fixturePorts.has(record.port) || !spawned || !Number.isInteger(spawned.pid) || spawned.pid <= 0 || child.pid !== spawned.pid || child.exitCode !== null || child.signalCode !== null || child.killed) throw refusal();
      if (args.length !== 9 || args[0] !== '--native-control-v1' || args[1] !== '--control-key-file' || args[3] !== '--control-key-uid' || args[5] !== '--control-key-gid' || args[7] !== '--listen' || args[8] !== `127.0.0.1:${record.port}`) throw refusal();
      const keyFile = args[2], relative = typeof keyFile === 'string' ? path.relative(directory, keyFile) : '..';
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || fs.realpathSync(keyFile) !== keyFile) throw refusal();
      const key = fs.lstatSync(keyFile), parent = fs.lstatSync(path.dirname(keyFile));
      if (!key.isFile() || key.nlink !== 1 || (key.mode & 0o7777) !== 0o440 || key.uid !== process.getuid?.() || String(key.uid) !== args[4] || key.gid <= 0 || String(key.gid) !== args[6] || !parent.isDirectory() || parent.uid !== key.uid || parent.gid !== key.gid || (parent.mode & 0o7777) !== 0o750) throw refusal();
      used = true;
      const owner = {}, entry = { child, release: null };
      let released = false;
      const release = () => { if (released) return; released = true; revoke(record.port, owner); liveNative.delete(entry); };
      entry.release = release; allow(record.port, owner); liveNative.add(entry);
      child.once('exit', release); child.once('error', release); child.once('close', release);
      return release;
    } });
  },
}) });
process.on('exit', () => {
  for (const entry of liveNative) { entry.release(); if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL'); }
});
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
