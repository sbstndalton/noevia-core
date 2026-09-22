'use strict';
// pi as an ACP agent, with its approvals routed to noevia.
//
// pi (github.com/earendil-works/pi) has no permission prompts by design and speaks its own JSONL
// RPC (`pi --mode rpc`), not ACP. Community `pi-acp` adapters bridge the protocol but do not
// document forwarding pi's extension dialogs, so with them noevia's gate could only fail closed.
// This bridge is small on purpose: it is an ACP agent on stdio (the supervisor spawns it like any
// harness), it runs one `pi --mode rpc` per session, and it translates:
//
//   ACP initialize / session/new / session/prompt / session/cancel  ->  pi prompt / abort
//   pi message_update text deltas                                    ->  agent_message_chunk
//   pi tool_execution_start / _end                                   ->  tool_call / tool_call_update
//   pi extension_ui_request "confirm" from noevia's gate             ->  session/request_permission
//
// The gate (server/code-harness-config.cjs, written into pi's agent dir by noevia) puts the real
// tool name and full input in the confirm message, so noevia classifies the actual command. Any
// other dialog, a malformed payload, a closed client or an unknown answer is a refusal: this
// bridge can only ever turn a question into "no" by itself, never into "yes".

const { spawn } = require('node:child_process');
const nodePath = require('node:path');

const PROTOCOL_VERSION = 1;
const KIND = { bash: 'execute', write: 'edit', edit: 'edit', read: 'read', grep: 'search', find: 'search', ls: 'search' };
const DIALOGS = new Set(['confirm', 'select', 'input', 'editor']);

/**
 * Pin pi's noninteractive surface as tightly as its v0.87 CLI permits. Discovered extensions can
 * execute before a tool call, so discovery is off and only noevia's managed gate is loaded.
 * Project resources are never trusted, sessions are not persisted, and the model sees only the
 * fixed tool set whose mutating members the gate intercepts.
 */
function piArgsFor(env = process.env) {
  const home = typeof env?.HOME === 'string' ? env.HOME : '';
  if (!nodePath.isAbsolute(home)) throw Error('The pi bridge needs the task private HOME.');
  return ['--mode', 'rpc', '--offline', '--no-session', '--no-approve', '--no-context-files', '--no-extensions',
    '--extension', nodePath.join(home, '.pi/agent/extensions/noevia-gate.js'),
    '--no-skills', '--no-prompt-templates', '--no-themes',
    '--tools', 'read,bash,edit,write,grep,find,ls'];
}

/** Strict LF framing (pi's RPC rule): split on \n only, strip one trailing \r. */
function lines(onLine, limit = 16 * 1024 * 1024) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    if (buffer.length > limit) { buffer = ''; return; }
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      onLine(message);
    }
  };
}

function toolCallFor(payload) {
  const name = String(payload.toolName || '');
  const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
  const path = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : null;
  return {
    toolCallId: String(payload.toolCallId || `pi-${name}`),
    title: name === 'bash' && typeof input.command === 'string' ? input.command : name,
    kind: KIND[name] || 'other',
    rawInput: input,
    ...(path ? { locations: [{ path }] } : {}),
  };
}

/**
 * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream, piCommand?: string, piArgs?: string[],
 *          spawnFn?: typeof spawn, env?: object}} deps
 */
function createBridge({ input, output, piCommand = 'pi', piArgs = null, spawnFn = spawn, env = process.env }) {
  let nextId = 1;
  const waiting = new Map(); // our requests to the ACP client, by id
  let pi = null, sessionId = null, turn = null, piSeq = 0;
  const piPending = new Map();

  const send = (message) => { try { output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); } catch { /* client gone */ } };
  const notify = (update) => send({ method: 'session/update', params: { sessionId, update } });
  const ask = (method, params) => new Promise((resolve) => {
    const id = `b${nextId++}`; waiting.set(id, resolve); send({ id, method, params });
  });
  const toPi = (command) => { if (pi?.stdin.writable) pi.stdin.write(JSON.stringify(command) + '\n'); };
  const piCommandWithId = (command) => new Promise((resolve) => { const id = `p${++piSeq}`; piPending.set(id, resolve); toPi({ id, ...command }); });

  async function onUiRequest(request) {
    if (!DIALOGS.has(request.method)) return; // notify/setStatus/…: fire and forget
    const refuse = () => toPi({ type: 'extension_ui_response', id: request.id, ...(request.method === 'confirm' ? { confirmed: false } : { cancelled: true }) });
    if (request.method !== 'confirm') return refuse();
    let payload; try { payload = JSON.parse(String(request.message ?? '')); } catch { return refuse(); }
    if (!payload || payload.noevia !== 'tool_call' || !payload.toolName) return refuse();
    const toolCall = toolCallFor(payload);
    const answer = await ask('session/request_permission', { sessionId, toolCall, options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
    ] }).catch(() => null);
    const outcome = answer?.outcome;
    const confirmed = outcome?.outcome === 'selected' && outcome.optionId === 'allow_once';
    toPi({ type: 'extension_ui_response', id: request.id, confirmed });
  }

  function onPiEvent(event) {
    if (event.type === 'response' && event.id && piPending.has(event.id)) { piPending.get(event.id)(event); piPending.delete(event.id); return; }
    if (event.type === 'extension_ui_request') { void onUiRequest(event); return; }
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(event.assistantMessageEvent.delta ?? '') } });
    } else if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta') {
      notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: String(event.assistantMessageEvent.delta ?? '') } });
    } else if (event.type === 'tool_execution_start') {
      notify({ sessionUpdate: 'tool_call', ...toolCallFor({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.args }), status: 'in_progress' });
    } else if (event.type === 'tool_execution_end') {
      notify({ sessionUpdate: 'tool_call_update', toolCallId: String(event.toolCallId || ''), status: event.isError ? 'failed' : 'completed' });
    } else if (event.type === 'agent_settled' && turn) {
      // `agent_end` finishes only one low-level run; retry, compaction or continuation may
      // follow. `agent_settled` is pi 0.87's promise that the whole user turn is actually done.
      const done = turn; turn = null; done({ stopReason: done.cancelled ? 'cancelled' : 'end_turn' });
    }
  }

  function startPi(cwd) {
    pi = spawnFn(piCommand, piArgs || piArgsFor(env), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    pi.stdout.setEncoding('utf8');
    pi.stdout.on('data', lines(onPiEvent));
    pi.stderr?.resume?.();
    pi.on('exit', () => { pi = null; if (turn) { const done = turn; turn = null; done({ stopReason: 'refusal' }); } });
    pi.on('error', () => { pi = null; if (turn) { const done = turn; turn = null; done({ stopReason: 'refusal' }); } });
  }

  const methods = {
    initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false },
      agentInfo: { name: 'pi (noevia bridge)', version: '1' }, authMethods: [] }),
    'session/new': async (params) => {
      if (sessionId) throw Object.assign(Error('One session per bridge'), { code: -32602 });
      startPi(typeof params?.cwd === 'string' ? params.cwd : undefined);
      sessionId = 'pi-1';
      return { sessionId };
    },
    'session/prompt': async (params) => {
      if (!pi || params?.sessionId !== sessionId) throw Object.assign(Error('No such session'), { code: -32602 });
      if (turn) throw Object.assign(Error('A prompt is already running'), { code: -32602 });
      const text = (Array.isArray(params.prompt) ? params.prompt : []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      const finished = new Promise((resolve) => { turn = resolve; });
      const accepted = await piCommandWithId({ type: 'prompt', message: text });
      if (accepted && accepted.success === false) { turn = null; return { stopReason: 'refusal' }; }
      return finished;
    },
  };

  function onClientMessage(message) {
    if (message.id !== undefined && message.method === undefined) {
      const resolve = waiting.get(message.id); waiting.delete(message.id);
      resolve?.(message.error ? null : message.result);
      return;
    }
    if (message.method === 'session/cancel') { if (turn) turn.cancelled = true; toPi({ type: 'abort' }); return; }
    const handler = methods[message.method];
    if (!handler) { if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
    handler(message.params).then((result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: error.code || -32603, message: String(error.message) } }));
  }

  input.setEncoding?.('utf8');
  input.on('data', lines(onClientMessage));
  // The client closing is the end of the task: refuse whatever is still waiting and stop pi.
  input.on('end', () => {
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
    try { pi?.kill('SIGTERM'); } catch { /* gone */ }
  });
  return { get pi() { return pi; } };
}

module.exports = { createBridge, toolCallFor, lines, piArgsFor };

if (require.main === module) {
  createBridge({ input: process.stdin, output: process.stdout,
    piCommand: process.env.PI_COMMAND || 'pi' });
}
