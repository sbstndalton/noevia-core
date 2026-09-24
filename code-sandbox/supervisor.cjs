'use strict';
// The coding sandbox's supervisor (spec-agent-execution §3).
//
// It exists so that a coding agent never runs inside the container that holds noevia's state,
// sessions and credentials — and so that noevia never needs a Docker socket to start one, which
// is the highest-severity finding `research-master-container.md` recorded.
//
// What it does is deliberately almost nothing: accept one connection, read one noevia line
// saying which worktree to run in, spawn the agent, and pipe. Everything after that first line
// is the ACP stream, byte for byte, in both directions. It makes no decisions about
// permissions, paths or tools — noevia does, at the other end of the pipe.
//
// What it does decide is what it will be told:
//   * `cwd` must resolve (realpath, so a symlink cannot point out) inside WORKSPACE_ROOT.
//   * Only an allowlisted set of environment variables is accepted, and nothing of this
//     process's own environment is passed on.
//   * One agent per connection; closing the connection kills that agent's process group.
//   * Its own limits (#115), not only the container's: at most `maxConnections` live connections
//     (CODE_SANDBOX_MAX_CONNECTIONS, default 4; more are refused with a JSON-RPC error), and an
//     agent running longer than `maxWallMs` (CODE_SANDBOX_MAX_WALL_MS, default 2 h) is stopped
//     — SIGTERM to its group, SIGKILL after the grace period.
//
// It listens on an internal network only. There is no authentication here on purpose: a
// deployment that lets anything but noevia reach this port has already lost, and a shared
// secret in an env var would suggest otherwise. The compose override is the control.
const net = require('node:net'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_START_LINE = 64 * 1024;
const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_WALL_MS = 2 * 60 * 60 * 1000;
const positive = (value, fallback) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback; };
// Passed through when noevia sends them; everything else is dropped without comment.
const ALLOWED_ENV = new Set(['HOME', 'PATH', 'LANG', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'CURL_HOME', 'WGETRC']);

function insideRoot(root, candidate) {
  let resolvedRoot, resolved;
  try { resolvedRoot = fs.realpathSync(root); } catch { return null; }
  try { resolved = fs.realpathSync(String(candidate || '')); } catch { return null; }
  const rel = path.relative(resolvedRoot, resolved);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return null;
  return resolved;
}

function cleanEnv(env, fallbackHome = process.env.HOME) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (ALLOWED_ENV.has(key) && typeof value === 'string' && value.length < 4096) out[key] = value;
  }
  // A harness with no HOME misbehaves in its own ways, so fall back to this container's own —
  // which is a tmpfs, inside the sandbox, and not the task's repository.
  if (!out.HOME && fallbackHome) out.HOME = fallbackHome;
  return out;
}

/**
 * @param {{command: string, args?: string[], root: string, spawnFn?: Function,
 *          log?: (line: string) => void, graceMs?: number}} deps
 */
function createSupervisor({ command, args = [], root, spawnFn = spawn, log = () => {}, graceMs = 5000,
  maxConnections = DEFAULT_MAX_CONNECTIONS, maxWallMs = DEFAULT_MAX_WALL_MS, kill = process.kill.bind(process) }) {
  const cap = positive(maxConnections, DEFAULT_MAX_CONNECTIONS);
  const wall = positive(maxWallMs, DEFAULT_MAX_WALL_MS);
  let live = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    if (live >= cap) {
      log(`refused: ${live} agents already running (limit ${cap})`);
      socket.on('error', () => {});
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: null,
        error: { code: -32000, message: `The sandbox is already running ${cap} agents; try again when one finishes.` } }) + '\n');
      return;
    }
    live++;
    let counted = true;
    const release = () => { if (counted) { counted = false; live--; } };
    let wallTimer = null;
    // `pid` outlives `agent`: the agent exiting does not end its process group, and anything it
    // left running in the background must still be stopped when the connection goes.
    // `done` is set once this connection has been refused or its agent has gone; after that no
    // byte on the socket is read, buffered or allowed to start a second agent.
    let buffer = '', agent = null, pid = null, done = false, stopped = false;

    const refuse = (reason) => {
      done = true;
      buffer = '';
      log(`refused: ${reason}`);
      // Answered in the agent's own language so the failure reaches the task as a message
      // rather than as a dead socket.
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: reason } }) + '\n');
    };

    const stopAgent = () => {
      done = true;
      agent = null;
      if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
      if (!pid || stopped) return;
      stopped = true;
      const group = -pid;
      try { kill(group, 'SIGTERM'); } catch { /* ESRCH: the whole group is already gone */ }
      const timer = setTimeout(() => { try { kill(group, 'SIGKILL'); } catch { /* gone */ } }, graceMs);
      timer.unref?.();
    };

    socket.on('data', (chunk) => {
      if (done) return;
      if (agent) return agent.stdin.write(chunk);   // the ACP stream, untouched
      buffer += chunk;
      if (buffer.length > MAX_START_LINE) return refuse('start line too long');
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const line = buffer.slice(0, end);
      const rest = buffer.slice(end + 1);
      buffer = '';
      let start;
      try { start = JSON.parse(line); } catch { return refuse('the first line must be noevia’s start message'); }
      if (!start || start.noevia !== 'start') return refuse('the first line must be noevia’s start message');
      const cwd = insideRoot(root, start.cwd);
      if (!cwd) return refuse('that workspace is not inside this sandbox');

      const child = spawnFn(command, args, { cwd, env: cleanEnv(start.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      agent = child;
      pid = child.pid || null;
      log(`started ${command} in ${cwd}`);
      wallTimer = setTimeout(() => {
        wallTimer = null;
        log(`agent ran past its ${wall} ms limit; stopping it`);
        stopAgent();
        if (!socket.destroyed) {
          socket.end(JSON.stringify({ jsonrpc: '2.0', id: null,
            error: { code: -32000, message: 'The agent ran past the sandbox time limit and was stopped.' } }) + '\n');
        }
      }, wall);
      wallTimer.unref?.();
      child.stdin.on('error', () => { /* the agent closed its stdin; exit/close handles the rest */ });
      child.stdout.on('data', (out) => socket.write(out));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (out) => log(`agent: ${String(out).slice(0, 2000).trimEnd()}`));
      child.on('error', (error) => { log(`agent failed: ${error.message}`); stopAgent(); socket.destroy(); });
      child.on('exit', (code, sig) => {
        log(`agent exited (${sig || code})`);
        // Its children may still be running in its group; stop them now, not only at close.
        stopAgent();
        socket.end();
      });
      if (rest) child.stdin.write(rest);
    });

    // The connection IS the lifetime. noevia hanging up, the task being cancelled and the web
    // container restarting all look the same from here, and all mean: stop the agent.
    socket.on('close', () => { release(); stopAgent(); });
    socket.on('error', () => { stopAgent(); socket.destroy(); });
  });

  return { server, live: () => live, listen: (port, host = '0.0.0.0') => new Promise((r) => server.listen(port, host, () => r(server.address()))),
    // net.Server has no closeAllConnections: every socket is tracked and destroyed here, so
    // close() cannot wait forever on a connection whose agent never exits.
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

module.exports = { createSupervisor, insideRoot, cleanEnv, ALLOWED_ENV, DEFAULT_MAX_CONNECTIONS, DEFAULT_MAX_WALL_MS };

if (require.main === module) {
  const command = process.env.CODE_HARNESS_COMMAND;
  const root = process.env.WORKSPACE_ROOT;
  if (!command || !root) {
    console.error('code-sandbox: CODE_HARNESS_COMMAND and WORKSPACE_ROOT are required');
    process.exit(2);
  }
  const { listen } = createSupervisor({ command, args: String(process.env.CODE_HARNESS_ARGS || '').split(' ').filter(Boolean),
    root, log: (line) => console.log(`[code-sandbox] ${line}`),
    maxConnections: positive(process.env.CODE_SANDBOX_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS),
    maxWallMs: positive(process.env.CODE_SANDBOX_MAX_WALL_MS, DEFAULT_MAX_WALL_MS) });
  listen(Number(process.env.PORT || 8030)).then((address) => {
    console.log(`[code-sandbox] listening on ${address.address}:${address.port}, workspaces under ${root}`);
  });
}
