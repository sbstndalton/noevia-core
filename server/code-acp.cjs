'use strict';
// ── Minimal ACP client (JSON-RPC 2.0 over a subprocess's stdio) ──────────
//
// noevia speaks the Agent Client Protocol so that OpenCode, Claude Code, Codex and the rest
// adapt to noevia's contract rather than noevia adapting to each of them
// (docs/spec-agent-execution.md §3, "adopt ACP as the harness adapter protocol"). As with
// `mcp.cjs`, this is a few hundred lines rather than the SDK: the surface is small and the
// repo stays a zero-dependency proxy. "Do not vendor an agent framework" applies here too.
//
// Transport is stdio, not http — unlike MCP: an ACP agent IS a subprocess, started by its
// client, and that is what makes it containable.
//
// noevia is the CLIENT. It answers four things the agent calls: permission requests, file
// reads, file writes and session updates. Every one of those is handled by `code-harness.cjs`,
// which is where the rules live; nothing in this file decides anything.
//
// The one thing this file does decide is how the subprocess dies: cancel sends
// `session/cancel`, then SIGTERM to the process GROUP after a grace period, then SIGKILL. A
// harness that ignores cancellation is not left running with a worktree checked out.
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: 'noevia', version: '1' };
const GRACE_MS = 5000;
// A harness that never answers the handshake would otherwise hold a task open forever, with
// no session id to cancel and no reply to wait on.
const HANDSHAKE_MS = 30000;
// JSON-RPC error codes we answer with; anything a handler throws without one is "internal".
const INVALID_PARAMS = -32602, INTERNAL = -32603;

/** One line of JSON per message, as ACP frames it over stdio. */
function createLineReader(onMessage, onBad) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    // A single enormous line from a misbehaving agent must not grow without bound.
    if (buffer.length > 16 * 1024 * 1024) { buffer = ''; onBad(new Error('The harness sent an oversized message.')); return; }
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { onBad(new Error('The harness sent something that is not JSON-RPC.')); continue; }
      onMessage(message);
    }
  };
}

/**
 * Connect to an ACP agent and return what `code-harness.cjs` asks of a transport:
 * `prompt(text)` and nothing else it has to know about.
 *
 * @param {{command: string, args?: string[], cwd: string, env?: object, handlers: object,
 *          signal?: AbortSignal, permission?: object, proxy?: {url: string}|null,
 *          model?: string|null, onLog?: (line: string) => void, spawnFn?: Function,
 *          graceMs?: number}} options
 */
async function connectAcp({ command, args = [], cwd, env = {}, handlers, signal, permission = null,
  proxy = null, model = null, onLog = () => {}, spawnFn = spawn, graceMs = GRACE_MS,
  handshakeMs = HANDSHAKE_MS }) {
  if (!command) throw Object.assign(Error('No coding harness is configured on this server.'), { status: 409 });

  // The agent inherits nothing by default: no credentials, no tokens, no ambient proxy. What
  // it gets is what this object says, and the egress proxy is the only way out.
  const childEnv = {
    PATH: process.env.PATH, HOME: cwd, TMPDIR: env.TMPDIR || undefined, LANG: process.env.LANG,
    ...(proxy ? { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url, NO_PROXY: '' } : {}),
    ...env,
  };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];

  const child = spawnFn(command, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });

  const pending = new Map();
  let nextId = 1, closed = null;

  const fail = (error) => {
    if (closed) return;
    closed = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const send = (message) => {
    if (closed) throw closed;
    try { child.stdin.write(JSON.stringify(message) + '\n'); }
    catch (error) { fail(error); throw error; }
  };
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { send({ jsonrpc: '2.0', id, method, params }); } catch (error) { pending.delete(id); reject(error); }
    });
  }
  const notify = (method, params) => { try { send({ jsonrpc: '2.0', method, params }); } catch { /* already gone */ } };

  // Incoming: either a reply to something we asked, or a call we must answer.
  const CLIENT_METHODS = {
    'session/request_permission': (p) => handlers.requestPermission(p),
    'fs/read_text_file': (p) => handlers.readTextFile(p),
    'fs/write_text_file': (p) => handlers.writeTextFile(p),
  };
  async function handleIncoming(message) {
    if (message.id !== undefined && message.method === undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(Object.assign(Error(String(message.error.message || 'The harness reported an error.')), { code: message.error.code }));
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') { try { handlers.sessionUpdate(message.params?.update || message.params); } catch { /* an update is not worth failing a task over */ } return; }
    const handler = CLIENT_METHODS[message.method];
    // A request we do not implement is answered as unimplemented — never ignored, which would
    // hang the agent, and never answered with a default, which could be read as consent.
    if (message.id === undefined) return;
    if (!handler) return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported by this client' } });
    try { send({ jsonrpc: '2.0', id: message.id, result: (await handler(message.params || {})) ?? null }); }
    catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: error.code === -32602 ? INVALID_PARAMS : INTERNAL, message: String(error.message || 'refused') } });
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', createLineReader((m) => { handleIncoming(m); }, (e) => onLog(String(e.message))));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => onLog(String(chunk).slice(0, 2000)));
  child.on('error', (error) => fail(error));
  child.on('exit', (code, sig) => fail(Object.assign(Error(`The harness exited (${sig || code}).`), { publicMessage: 'The coding harness stopped unexpectedly.' })));

  /** SIGTERM the process GROUP, then SIGKILL: an agent spawns children of its own. */
  function stop() {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, graceMs);
    timer.unref?.();
  }

  // Cancellation is wired BEFORE the handshake: an agent that never answers `initialize` has
  // no session to cancel, and without this there would be nothing to stop it with.
  let sessionId = null;
  const onAbort = () => { if (sessionId) notify('session/cancel', { sessionId }); stop(); fail(Object.assign(Error('Cancelled'), { publicMessage: 'The task was cancelled.' })); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { onAbort(); throw closed; }

  const handshake = async () => {
    await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: CLIENT_INFO,
    });
    // `mcpServers: []` on purpose: a coding task's tools are the harness's own, gated here.
    // Anything noevia offers through MCP would arrive outside this gate.
    return request('session/new', { cwd, mcpServers: [], ...(permission ? { _meta: { noevia: { permission } } } : {}) });
  };
  let session;
  try {
    session = await Promise.race([handshake(), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Object.assign(Error('The coding harness did not answer.'), { publicMessage: 'The coding harness did not answer.' })), handshakeMs);
      timer.unref?.();
    })]);
  } catch (error) { signal?.removeEventListener('abort', onAbort); stop(); throw error; }
  sessionId = session?.sessionId || null;
  if (!sessionId) { signal?.removeEventListener('abort', onAbort); stop(); throw Object.assign(Error('The harness did not open a session.'), { publicMessage: 'The coding harness did not open a session.' }); }

  return {
    sessionId,
    async prompt(text) {
      try {
        return await request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: String(text) }],
          ...(model ? { _meta: { noevia: { model } } } : {}),
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
        stop();
      }
    },
    stop,
  };
}

/** The transport `code-service.cjs` injects, configured by the deployment. */
function createAcpTransport({ command = process.env.CODE_HARNESS_COMMAND,
  args = String(process.env.CODE_HARNESS_ARGS || '').split(' ').filter(Boolean), log = () => {}, spawnFn } = {}) {
  return async function connect({ cwd, handlers, signal, permission, proxy, model }) {
    return connectAcp({ command, args, cwd, handlers, signal, permission, proxy, model,
      onLog: (line) => log({ event: 'code.harness', line }), spawnFn });
  };
}

module.exports = { connectAcp, createAcpTransport, createLineReader, PROTOCOL_VERSION };
