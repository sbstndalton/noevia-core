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
// client, and that is what makes it containable. There are two ways to reach that subprocess,
// and which one a deployment uses is a security decision, not a detail:
//
//   * `spawn` — the agent is a child of the web process. Simple, and fine for a workstation,
//     but it puts a coding agent inside the container that holds noevia's state and
//     credentials. The spike's escape probes passed because that container was stripped; the
//     web container is not.
//   * `socket` — the agent runs in `services/code-sandbox`, a container with a read-only root,
//     no credentials and no route out except the egress proxy, and noevia speaks the same
//     JSONL over a TCP connection on an internal network. Driving it through the Docker socket
//     instead would hand a socket holder to the web container, which is the single
//     highest-severity finding `research-master-container.md` recorded. So: a sidecar, not a
//     socket.
//
// Both use the identical framing and the identical rules; only how the process is started and
// stopped differs.
//
// noevia is the CLIENT. It answers four things the agent calls: permission requests, file
// reads, file writes and session updates. Every one of those is handled by `code-harness.cjs`,
// which is where the rules live; nothing in this file decides anything.
//
// The one thing this file does decide is how the subprocess dies: cancel sends
// `session/cancel`, then SIGTERM to the process GROUP after a grace period, then SIGKILL. A
// harness that ignores cancellation is not left running with a worktree checked out.
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs'), nodePath = require('node:path');
const { readAgent } = require('./code-meta.cjs');

const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: 'noevia', version: '1' };
const GRACE_MS = 5000;
// A harness that never answers the handshake would otherwise hold a task open forever, with
// no session id to cancel and no reply to wait on.
const HANDSHAKE_MS = 30000;
// JSON-RPC error codes we answer with; anything a handler throws without one is "internal".
const INVALID_PARAMS = -32602, INTERNAL = -32603;

/**
 * Harness-specific session controls that cannot be expressed in ACP itself. Claude's adapter
 * deliberately accepts Agent SDK options in this namespaced metadata. Supplying no filesystem
 * sources keeps a repository's hooks, MCP servers, plugins and instructions out of the query;
 * noevia's complete inline settings remain the highest user-controlled permission pin.
 */
function sessionMetadata({ permission = null, harness = null, settings = null } = {}) {
  const meta = {};
  if (permission) meta.noevia = { permission };
  if (harness === 'claude-code') {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw Object.assign(Error('Claude Code needs noevia’s pinned session settings.'), { status: 409 });
    }
    meta.claudeCode = { options: {
      // The complete noevia-owned settings object is supplied inline, so no user, project or
      // local source is needed by the SDK query. This also excludes CLAUDE.md and plugins from a
      // hostile checkout. The physical local file remains for the adapter's separate initial-
      // mode lookup, which happens before it constructs that query.
      settingSources: [],
      strictMcpConfig: true,
      allowDangerouslySkipPermissions: false,
      plugins: [],
      tools: ['Read', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      extraArgs: { 'disable-slash-commands': null },
      settings,
    } };
  }
  return Object.keys(meta).length ? meta : null;
}

function readClaudeSettings(home) {
  if (!home || !nodePath.isAbsolute(home)) {
    throw Object.assign(Error('Claude Code needs the task private HOME for its pinned settings.'), { status: 409 });
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(nodePath.join(home, '.claude/settings.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('not an object');
    return parsed;
  } catch {
    throw Object.assign(Error('Claude Code’s pinned settings are missing or invalid.'), { status: 409 });
  }
}

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
 *          signal?: AbortSignal, permission?: object, harness?: string|null, proxy?: {url: string}|null,
 *          model?: string|null, onLog?: (line: string) => void, spawnFn?: Function,
 *          graceMs?: number}} options
 */
async function connectAcp({ command, args = [], endpoint = null, cwd, env = {}, home = null, handlers, signal,
  permission = null, harness = null, proxy = null, model = null, onLog = () => {}, spawnFn = spawn,
  connectFn = net.connect, graceMs = GRACE_MS, handshakeMs = HANDSHAKE_MS }) {
  if (!command && !endpoint) throw Object.assign(Error('No coding harness is configured on this server.'), { status: 409 });
  // Read this before starting the agent. A missing pin is a refusal, not a chance for Claude's
  // adapter to fall back to whatever the checkout or its defaults say.
  const harnessSettings = harness === 'claude-code' ? readClaudeSettings(home) : null;

  // The agent inherits nothing by default: no credentials, no tokens, no ambient proxy. What
  // it gets is what this object says, and the egress proxy is the only way out.
  const childEnv = agentEnv({ cwd, env, proxy, home });

  const pending = new Map();
  let nextId = 1, closed = null;

  const fail = (error) => {
    if (closed) return;
    closed = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  // Answering after the connection closed is not an error worth a crash: the agent is gone,
  // so there is nobody to answer. Requests still need to know, so they check `closed` first.
  const send = (message) => {
    if (closed) return false;
    try { channel.write(JSON.stringify(message) + '\n'); return true; }
    catch (error) { fail(error); return false; }
  };
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (closed) { reject(closed); return; }
      pending.set(id, { resolve, reject });
      if (!send({ jsonrpc: '2.0', id, method, params })) { pending.delete(id); reject(closed || Error('The coding harness stopped.')); }
    });
  }
  const notify = (method, params) => { send({ jsonrpc: '2.0', method, params }); };

  // Incoming: either a reply to something we asked, or a call we must answer.
  const CLIENT_METHODS = {
    // ACP nests the outcome: `{ outcome: { outcome: 'selected', optionId } }`. Sending the inner
    // object directly is read by the agent as a rejection — so noevia would answer "allow", the
    // harness would hear "the user rejected permission", and Code mode could never do anything.
    // Fail-safe, and invisible to every test until a real harness was on the other end.
    // The shape belongs here, in the protocol layer; `pickOption` keeps returning the decision.
    'session/request_permission': async (p) => ({ outcome: await handlers.requestPermission(p) }),
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

  const onMessage = createLineReader((m) => {
    handleIncoming(m).catch((error) => onLog(`ACP message handling failed: ${error?.stack || error}`));
  }, (e) => onLog(String(e.message)));
  const channelOptions = {
    cwd, env: childEnv, graceMs,
    onMessage, onLog: (text) => onLog(String(text).slice(0, 2000)),
    onClose: (reason) => fail(Object.assign(Error(reason), { publicMessage: 'The coding harness stopped unexpectedly.' })),
  };
  const channel = endpoint
    ? socketChannel({ ...channelOptions, endpoint, connectFn })
    : spawnChannel({ ...channelOptions, command, args, spawnFn });
  const stop = () => channel.stop();

  // Cancellation is wired BEFORE the handshake: an agent that never answers `initialize` has
  // no session to cancel, and without this there would be nothing to stop it with.
  let sessionId = null;
  const onAbort = () => { if (sessionId) notify('session/cancel', { sessionId }); stop(); fail(Object.assign(Error('Cancelled'), { publicMessage: 'The task was cancelled.' })); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { onAbort(); throw closed; }

  let agentInfo = { name: null, version: null, protocolVersion: null };
  const handshake = async () => {
    // Whatever the agent says about itself here is the only version noevia ever learns, and §1
    // needs it to scope coding evidence to a configuration.
    agentInfo = readAgent(await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: CLIENT_INFO,
    }));
    // `mcpServers: []` on purpose: a coding task's tools are the harness's own, gated here.
    // Anything noevia offers through MCP would arrive outside this gate.
    const meta = sessionMetadata({ permission, harness, settings: harnessSettings });
    return request('session/new', { cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) });
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
    get agent() { return agentInfo; },
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

/**
 * The environment an agent runs with. Nothing is inherited: no credentials, no tokens, no
 * ambient proxy. `HOME` is the worktree, so the agent's own state lands inside the sandbox.
 */
function agentEnv({ cwd, env = {}, proxy = null, home = null }) {
  const out = {
    // HOME is deliberately NOT the workspace: a harness keeps caches, a database and even a
    // nested git repository under it, and with HOME inside the repository a real run committed
    // all of it onto the task's branch. It gets its own directory beside the workspace.
    PATH: process.env.PATH, HOME: home || env.HOME || undefined, TMPDIR: env.TMPDIR || undefined, LANG: process.env.LANG,
    ...(proxy ? { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url, NO_PROXY: proxy.noProxy || '' } : {}),
    ...env,
    // curl and wget read rc files that can upload, proxy or save (#224). The agent can write its
    // own HOME, so neither tool may read config from it: WGETRC replaces ~/.wgetrc outright, and
    // CURL_HOME is looked up first (the classifier additionally wants `curl -q` to auto-allow,
    // since curl still falls back to HOME when CURL_HOME has no .curlrc). Pinned after `env`.
    CURL_HOME: '/nonexistent', WGETRC: '/dev/null',
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/** The agent as a child of this process. */
function spawnChannel({ command, args, cwd, env, spawnFn, graceMs, onMessage, onLog, onClose }) {
  const child = spawnFn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onMessage);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', onLog);
  child.on('error', (error) => onClose(String(error.message)));
  child.on('exit', (code, sig) => onClose(`The harness exited (${sig || code}).`));
  return {
    write: (line) => child.stdin.write(line),
    /** SIGTERM the process GROUP, then SIGKILL: an agent spawns children of its own. */
    stop() {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, graceMs);
      timer.unref?.();
    },
  };
}

/**
 * The agent in the sandbox container, reached over an internal network.
 *
 * One noevia line goes first — `{"noevia":"start", cwd, env}` — and everything after it is the
 * ACP stream, byte for byte. The supervisor at the other end spawns the agent and pipes; it
 * decides nothing, and it constrains what it is told (see services/code-sandbox). Closing the
 * connection is what stops the agent, so there is no kill to get wrong across a container
 * boundary: the supervisor owns the process group it started.
 */
function socketChannel({ endpoint, cwd, env, connectFn, onMessage, onLog, onClose }) {
  const [host, port] = splitEndpoint(endpoint);
  const socket = connectFn(port, host);
  socket.setEncoding('utf8');
  let connected = false;
  // Queued immediately, not from the 'connect' handler: writes made before the socket opens are
  // buffered and flushed in call order, so a handshake sent by the caller in the meantime would
  // otherwise reach the supervisor first and be refused as "not a start message".
  socket.write(JSON.stringify({ noevia: 'start', cwd, env }) + '\n');
  socket.on('connect', () => { connected = true; });
  socket.on('data', onMessage);
  socket.on('error', (error) => onClose(`The coding sandbox is unreachable (${error.message}).`));
  socket.on('close', () => onClose(connected ? 'The coding sandbox closed the connection.' : 'The coding sandbox refused the connection.'));
  return {
    write: (line) => socket.write(line),
    stop: () => socket.destroy(),
    _log: onLog,
  };
}

function splitEndpoint(endpoint) {
  const text = String(endpoint);
  const match = text.startsWith('[') ? text.match(/^\[([^\]]+)\]:(\d+)$/) : text.match(/^([^:]+):(\d+)$/);
  if (!match) throw Object.assign(Error(`CODE_HARNESS_ENDPOINT should be host:port, not "${text}"`), { status: 500 });
  return [match[1], Number(match[2])];
}

/** The transport `code-service.cjs` injects, configured by the deployment. */
function createAcpTransport({ command = process.env.CODE_HARNESS_COMMAND,
  args = String(process.env.CODE_HARNESS_ARGS || '').split(' ').filter(Boolean),
  endpoint = process.env.CODE_HARNESS_ENDPOINT || null, log = () => {}, spawnFn, connectFn } = {}) {
  // The sandbox wins when both are set: a deployment that has one should not fall back to
  // running the agent beside noevia's own state because of a stale variable.
  return async function connect({ cwd, home, handlers, signal, permission, harness, proxy, model }) {
    return connectAcp({ command: endpoint ? null : command, args, endpoint, cwd, home, handlers, signal,
      permission, harness, proxy, model, onLog: (line) => log({ event: 'code.harness', line }), spawnFn, connectFn });
  };
}

module.exports = { connectAcp, createAcpTransport, createLineReader, agentEnv, splitEndpoint,
  sessionMetadata, readClaudeSettings, PROTOCOL_VERSION };
