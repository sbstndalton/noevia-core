'use strict';
// #1853: the Code pipeline and the Code sandbox follow the Code role to its Inference machine (#1840).
//
// Which machine: the Code role's, else (when no Code model is chosen here) the Smart role's, the same
// fallback `autoRoles().code || autoRoles().smart` gives a Code task on this machine. Nothing assigned:
// target() is null and every Code path does exactly what it did before.
//
// ALL stages of one task use that machine's model (the role engine's one-model-per-task rule): the Planner,
// review and Auditor through role-engine.cjs (machine pin: chat-machines.cjs ready() + served-model check, no
// admission lock, no residency read, no budget), and the sandbox Executor through the relay below.
//
// The relay. The sandbox runs on the internal `code` network; its only other member is web (and, on the
// live box, the engine). It must never reach a LAN machine itself: that would mean opening the internal
// network's egress, and it would bypass serviceFetch (connect-time on-this-network check, link-local and
// redirect refusal). Instead web listens on one more port on its OWN code-network address (the address the
// egress proxy binds, `CODE_EGRESS_HOST`, default `egress`; `CODE_ENGINE_RELAY_BIND` overrides it) and
// forwards exactly two things for a running task:
//   GET  /v1/models            answered here: the one model the task runs on
//   POST /v1/chat/completions  forwarded to the machine through chatMachines.fetch (serviceFetch, no
//                              redirects, link-local refused), `model` forced to the task's, no API key
// A request needs the task's relay token (Bearer), minted when the Executor starts and revoked when it
// ends, so nothing else on the code network (and nothing after the task) can use it. The harness config
// carries that token as its API key and the relay URL as its engine. Every request re-checks that the
// role is still on the same machine with the same model, and the machine's health and served model.
// The compose networks are unchanged: the sandbox already reaches web's code-network address (that is how
// it reaches the egress proxy); this is a new port on it, not a new route out.
const crypto = require('node:crypto');
const http = require('node:http');
const dns = require('node:dns');

const BODY_CAP = 16 * 1024 * 1024;
const MAX_CONCURRENT_PER_TASK = 4;
const REQUEST_TIMEOUT_MS = 30 * 60_000;

/** The machine a Code task runs on, or null (this machine). */
function codeTargetFrom(chatMachines, autoRoles) {
  if (!chatMachines || typeof chatMachines.target !== 'function') return null;
  const code = chatMachines.target('code');
  if (code) return code;
  let localCode = null;
  try { localCode = autoRoles?.()?.code || null; } catch { localCode = null; }
  return localCode ? null : chatMachines.target('smart');
}

/** A stable identity for "this role on this machine serving this model". */
const targetKey = (t) => (t ? `${t.machine.id}|${t.baseUrl}|${t.model}` : null);

const jsonError = (res, status, message, code) => {
  if (res.headersSent) { try { res.destroy(); } catch { /* gone */ } return; }
  const body = JSON.stringify({ error: { message, type: 'relay_error', ...(code ? { code } : {}) } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};

/**
 * @param {object} o
 * @param {{ ready: Function, fetch: Function, connectError: Function, contextTokens?: Function }} o.chatMachines
 * @param {() => object|null} o.target  the Code task's machine (codeTargetFrom)
 * @param {string|null} [o.url]  the relay as the sandbox reaches it, e.g. http://egress:8095/v1 (null: no relay)
 */
function createEngineRelay({ chatMachines, target, url = null, log = () => {}, bodyCap = BODY_CAP, maxConcurrent = MAX_CONCURRENT_PER_TASK, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  const leases = new Map(); // sha256(token) -> lease
  const record = (entry) => { try { log(entry); } catch { /* never changes the outcome */ } };
  const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
  const current = () => { try { return target() || null; } catch { return null; } };

  /**
   * Open the relay for one Executor run. Refuses (throws a publicMessage error) when there is no relay,
   * the role moved, the task names another model, or the machine is unreachable or serves another model.
   */
  async function open({ taskId, model = null, expect = undefined }) {
    const refuse = (code, text) => Object.assign(Error(text), { code, publicMessage: text });
    const t = current();
    if (!t) throw refuse('model_mismatch', 'The Code role moved back to this machine while the task was starting, and one task runs on one model. Start the task again.');
    if (!url) throw refuse('machineRelayOff', `The Code role runs on ${t.machine.name}, but the sandbox has no route to it: web needs CODE_ENGINE_RELAY_PORT (see the code-sandbox override). The task was not started.`);
    if (expect !== undefined && expect !== targetKey(t)) throw refuse('model_mismatch', 'The Code role moved to another machine or model during this task, and one task runs on one model. Start the task again.');
    if (model && model !== t.model) throw refuse('model_mismatch', `This task names ${model}, but the Code role runs ${t.model} on ${t.machine.name}. One task runs on one model.`);
    const ready = await chatMachines.ready(t);
    if (!ready.ok) throw refuse(ready.code || 'machineUnreachable', ready.error);
    let contextTokens = null;
    try { contextTokens = typeof chatMachines.contextTokens === 'function' ? await chatMachines.contextTokens(t) : null; } catch { contextTokens = null; }
    const token = `ncr_${crypto.randomBytes(24).toString('base64url')}`;
    const key = hash(token);
    leases.set(key, { taskId, target: t, key: targetKey(t), active: 0 });
    record({ event: 'relay.opened', taskId, machine: t.machine.id });
    let closed = false;
    return { baseUrl: url, token, model: t.model, contextTokens, target: t,
      close: () => { if (closed) return; closed = true; leases.delete(key); record({ event: 'relay.closed', taskId }); } };
  }

  function leaseOf(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    return m ? leases.get(hash(m[1])) || null : null;
  }

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > bodyCap) throw Object.assign(Error('too large'), { status: 413 }); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** The relay's request handler (exported for tests; the listener below uses it). */
  async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    const lease = leaseOf(req);
    if (!lease) { req.resume(); return jsonError(res, 401, 'No running Code task holds this token.'); }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      req.resume();
      const body = JSON.stringify({ object: 'list', data: [{ id: lease.target.model, object: 'model', owned_by: 'noevia' }] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (req.method !== 'POST' || (path !== '/v1/chat/completions' && path !== '/chat/completions')) { req.resume(); return jsonError(res, 404, 'Only chat completions are relayed.'); }
    if (lease.active >= maxConcurrent) { req.resume(); return jsonError(res, 429, 'Too many model requests from this task at once.'); }
    lease.active += 1;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      let payload;
      try { payload = JSON.parse(await readBody(req)); }
      catch (e) { return jsonError(res, e?.status === 413 ? 413 : 400, e?.status === 413 ? 'The request is too large.' : 'The request is not JSON.'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return jsonError(res, 400, 'The request is not a JSON object.');
      const t = current();
      if (!t || targetKey(t) !== lease.key) {
        record({ event: 'relay.refused', taskId: lease.taskId, code: 'model_mismatch' });
        return jsonError(res, 409, 'The Code role moved to another machine or model during this task; one task runs on one model.', 'model_mismatch');
      }
      const ready = await chatMachines.ready(t);
      if (!ready.ok) { record({ event: 'relay.refused', taskId: lease.taskId, code: ready.code }); return jsonError(res, 502, ready.error, ready.code); }
      // One task, one model: whatever the harness asked for, the machine's model is what is sent.
      const body = JSON.stringify({ ...payload, model: t.model });
      let upstream;
      try {
        upstream = await chatMachines.fetch(`${t.baseUrl}/v1/chat/completions`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: String(req.headers.accept || 'application/json').slice(0, 200) },
          body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeoutMs)]) });
      } catch (err) {
        if (controller.signal.aborted) return undefined;
        record({ event: 'relay.unreachable', taskId: lease.taskId });
        return jsonError(res, 502, chatMachines.connectError(t, err), 'machineUnreachable');
      }
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
            if (res.destroyed) break;
          }
        } catch { /* the machine or the sandbox hung up */ }
        finally { try { await reader.cancel(); } catch { /* closed */ } }
      }
      res.end();
      return undefined;
    } finally {
      lease.active -= 1;
      res.off('close', onClose);
    }
  }

  return { open, handle, active: () => leases.size };
}

/**
 * The relay as a deployment runs it: `CODE_ENGINE_RELAY_PORT` on web's own code-network address. Unset:
 * no relay (and a task whose Code role is on a machine refuses to start with a clear reason). Returns
 * `{ relay, url, server }`.
 */
function startEngineRelayFromEnv(env, { chatMachines, target, log = () => {}, lookup = (h) => dns.promises.lookup(h), listen = true } = {}) {
  const port = Number(env.CODE_ENGINE_RELAY_PORT);
  const on = Number.isInteger(port) && port > 0 && port <= 65535;
  const host = String(env.CODE_ENGINE_RELAY_HOST || env.CODE_EGRESS_HOST || 'egress').trim();
  if (on && !/^[a-z0-9.-]+$/i.test(host)) throw Error(`CODE_ENGINE_RELAY_HOST should be a host name, not "${host}"`);
  const url = on ? `http://${host}:${port}/v1` : null;
  const relay = createEngineRelay({ chatMachines, target, url, log });
  if (!on || !listen) return { relay, url, server: null };
  const server = http.createServer((req, res) => { relay.handle(req, res).catch(() => jsonError(res, 500, 'The relay failed.')); });
  server.on('error', (err) => { log({ event: 'relay.bind_failed', error: String(err?.message || err) }); throw err; });
  // Only web's code-network address: never all interfaces. A name that does not resolve binds loopback,
  // which the sandbox cannot reach (fail closed), as the egress proxy does.
  Promise.resolve(env.CODE_ENGINE_RELAY_BIND ? { address: String(env.CODE_ENGINE_RELAY_BIND).trim() } : lookup(host))
    .catch((err) => { log({ event: 'relay.bind_fallback_loopback', host, reason: String(err?.message || err) }); return { address: '127.0.0.1' }; })
    .then(({ address }) => server.listen(port, address, () => log({ event: 'relay.listening', bind: address, port })));
  return { relay, url, server };
}

module.exports = { codeTargetFrom, targetKey, createEngineRelay, startEngineRelayFromEnv, BODY_CAP };
