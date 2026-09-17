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
//
// It listens on an internal network only. There is no authentication here on purpose: a
// deployment that lets anything but noevia reach this port has already lost, and a shared
// secret in an env var would suggest otherwise. The compose override is the control.
const net = require('node:net'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_START_LINE = 64 * 1024;
// Passed through when noevia sends them; everything else is dropped without comment.
const ALLOWED_ENV = new Set(['HOME', 'PATH', 'LANG', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY']);

function insideRoot(root, candidate) {
  let resolvedRoot, resolved;
  try { resolvedRoot = fs.realpathSync(root); } catch { return null; }
  try { resolved = fs.realpathSync(String(candidate || '')); } catch { return null; }
  const rel = path.relative(resolvedRoot, resolved);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return null;
  return resolved;
}

function cleanEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (ALLOWED_ENV.has(key) && typeof value === 'string' && value.length < 4096) out[key] = value;
  }
  return out;
}

/**
 * @param {{command: string, args?: string[], root: string, spawnFn?: Function,
 *          log?: (line: string) => void, graceMs?: number}} deps
 */
function createSupervisor({ command, args = [], root, spawnFn = spawn, log = () => {}, graceMs = 5000 }) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '', agent = null;

    const refuse = (reason) => {
      log(`refused: ${reason}`);
      // Answered in the agent's own language so the failure reaches the task as a message
      // rather than as a dead socket.
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: reason } }) + '\n');
    };

    const stopAgent = () => {
      if (!agent || !agent.pid) return;
      const pid = agent.pid;
      agent = null;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      const timer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, graceMs);
      timer.unref?.();
    };

    socket.on('data', (chunk) => {
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

      agent = spawnFn(command, args, { cwd, env: cleanEnv(start.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      log(`started ${command} in ${cwd}`);
      agent.stdout.on('data', (out) => socket.write(out));
      agent.stderr.setEncoding('utf8');
      agent.stderr.on('data', (out) => log(`agent: ${String(out).slice(0, 2000).trimEnd()}`));
      agent.on('error', (error) => { log(`agent failed: ${error.message}`); socket.destroy(); });
      agent.on('exit', (code, sig) => { log(`agent exited (${sig || code})`); agent = null; socket.end(); });
      if (rest) agent.stdin.write(rest);
    });

    // The connection IS the lifetime. noevia hanging up, the task being cancelled and the web
    // container restarting all look the same from here, and all mean: stop the agent.
    socket.on('close', stopAgent);
    socket.on('error', () => { stopAgent(); socket.destroy(); });
  });

  return { server, listen: (port, host = '0.0.0.0') => new Promise((r) => server.listen(port, host, () => r(server.address()))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

module.exports = { createSupervisor, insideRoot, cleanEnv, ALLOWED_ENV };

if (require.main === module) {
  const command = process.env.CODE_HARNESS_COMMAND;
  const root = process.env.WORKSPACE_ROOT;
  if (!command || !root) {
    console.error('code-sandbox: CODE_HARNESS_COMMAND and WORKSPACE_ROOT are required');
    process.exit(2);
  }
  const { listen } = createSupervisor({ command, args: String(process.env.CODE_HARNESS_ARGS || '').split(' ').filter(Boolean),
    root, log: (line) => console.log(`[code-sandbox] ${line}`) });
  listen(Number(process.env.PORT || 8030)).then((address) => {
    console.log(`[code-sandbox] listening on ${address.address}:${address.port}, workspaces under ${root}`);
  });
}
