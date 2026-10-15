'use strict';
// #1840: a chat role (Fast, Smart, Code, Creative) or Vision served by another machine's OpenAI-compatible
// server (llama.cpp's llama-server) instead of this machine's engine. Settings → Inference machines saves
// the machine, the port and the model the machine serves for the role (inference-machines.cjs chatTarget).
//
// The backend is a provider-shaped row the chat handler uses like the local one: the same
// /v1/chat/completions request, streaming and tool calls. What differs, on purpose:
//  - its id is `machine:<id>`, never the default provider's, so nothing that manages this machine's engine
//    runs for it: no makeRoomFor (load/unload), no inference memory budget, no model-manager props,
//    evidence or prefill measurements (#697); a role on a machine is not resident here;
//  - it carries `machine`, which chat.cjs reads as "still on this network": the turn is not off-box
//    (#815/#1703), since the owner put the role on one of their own machines;
//  - no API key: the local provider's key is never sent to another host (apiKey '');
//  - every request goes through service-endpoint.cjs serviceFetch: the address must be on this network
//    (LAN, Tailscale; link-local refused, #1845), checked again at connect time so a name re-pointed at a
//    public address is refused, and a redirect is never followed.
//  - health is the #1638 probe cache (machine-health.cjs): a role whose machine is not answering fails the
//    turn with "<Role> model’s machine (<name>) is unreachable" instead of quietly answering with another
//    model. A machine that answers but no longer serves the assigned model (a llama-server restarted with another
//    GGUF ignores `model` and would answer with it) fails the turn too, `machineWrongModel` (#1851): /v1/models and
//    /props are read beside the health result, in the same ~30 s cache. Only the optional Creative role falls back, as #1816 does for a missing Creative model.
//
// #1849: the same machine, under the same rules, also answers a Manual pick of the model it serves (manualTarget;
// a name this machine's catalogue lists stays here), the auto-router classifier when Fast is on a machine
// (auto-router.cjs) and Deep Research when Smart is (research-model.cjs). The Code pipeline and its sandbox harness
// stay on this machine's engine (the role engine's residency lock and the sandbox network are this machine's).
// #1850: the template tools gate reads a machine model's chat template from that machine's /props (propsSource) and
// keeps its verdict per machine + model; a tools refusal is retried without tools, as on this machine.
//
// With nothing assigned, target() is null for every role and the chat handler does exactly what it did before.

const { serviceFetch: defaultServiceFetch } = require('./service-endpoint.cjs');

const ROLE_LABEL = Object.freeze({ fast: 'Fast', smart: 'Smart', code: 'Code', creative: 'Creative', vision: 'Vision' });
const CHAT_ROLES = Object.freeze(Object.keys(ROLE_LABEL));
const MODELS_TIMEOUT_MS = 5000;
const PROPS_TIMEOUT_MS = 2500;
const MODELS_BODY_CAP = 256 * 1024;
// A /props answer carries the whole chat template (#1850 reads it for the tools gate).
const PROPS_BODY_CAP = 1024 * 1024;
const MAX_MODELS = 200;
const CONTEXT_MIN = 2048, CONTEXT_MAX = 2000000;
// A llama-server that does not say its context gets the local engine's conservative floor, not the hosted default.
const CONTEXT_FALLBACK = 8192;

const fail = (status, code, message, extra = {}) => Object.assign(Error(message), { status, code, ...extra });

async function readCapped(response, cap) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* closed */ } throw fail(502, 'tooLarge', 'The machine’s answer was too large.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The model ids an OpenAI-compatible /v1/models answer lists (llama-server: `data[].id`; older: `models[].name|model`). */
function modelIds(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const out = [];
  for (const r of rows) {
    const id = typeof r === 'string' ? r : r?.id ?? r?.model ?? r?.name;
    if (typeof id === 'string' && id.trim() && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/**
 * @param {object} o
 * @param {{ chatTarget:(role:string)=>object|null, machine:(id:string)=>object|null }} o.machines  inference-machines.cjs
 * @param {{ probe:(base:string)=>Promise<{state:string,reason?:string}> }} [o.health]  machine-health.cjs (the shared cache)
 * @param {Function} [o.fetchImpl]   the on-this-network fetch (tests inject one with a stubbed resolver)
 * @param {Function} [o.createVisionProbe]  vision.cjs createVisionProbe
 */
function createChatMachines({ machines, health = null, fetchImpl = defaultServiceFetch, createVisionProbe = null } = {}) {
  const machineFetch = (input, init = {}) => fetchImpl(input, { ...init, redirect: 'error' });

  /** The role's machine, or null when it runs here. Never throws. */
  function target(role) {
    if (!machines || !ROLE_LABEL[role]) return null;
    try { return machines.chatTarget(role) || null; } catch { return null; }
  }

  /** The roles on another machine: { fast: target, ... } (empty: all here). */
  function remoteRoles() {
    const out = {};
    for (const role of CHAT_ROLES) { const t = target(role); if (t) out[role] = t; }
    return out;
  }

  /** The Automatic roles as a turn sees them: a role on a machine names the model that machine serves. */
  function effectiveRoles(roles) {
    if (!roles) return roles;
    const remote = remoteRoles();
    if (!Object.keys(remote).length) return roles;
    const out = { ...roles };
    for (const [role, t] of Object.entries(remote)) out[role] = t.model;
    return out;
  }

  /** The roles this machine's engine serves (a role on a machine is not checked against the local catalogue). */
  function localRoles(roles) {
    if (!roles) return roles;
    const remote = remoteRoles();
    if (!Object.keys(remote).length) return roles;
    const out = { ...roles };
    for (const role of Object.keys(remote)) delete out[role];
    return out;
  }

  /**
   * #1851: what the machine's server says about itself, kept beside its health result (the shared ~30 s cache):
   * the models it serves (/v1/models) and the context it runs the model with (/props). A read that fails keeps the
   * last known value; `models` / `contextTokens` are null only when nothing has ever been read.
   */
  async function facts(t) {
    const load = async (prev) => {
      const out = { models: prev?.models ?? null, contextTokens: prev?.contextTokens ?? null };
      await Promise.all([
        modelsAt(t.machine.address, t.port).then((ids) => { out.models = ids; }, () => {}),
        propsContext(t).then((n) => { if (n) out.contextTokens = n; }, () => {}),
      ]);
      return out;
    };
    if (!health || typeof health.remember !== 'function') return load(null);
    return (await health.remember(`${t.baseUrl}#facts#${t.model}`, load)) || { models: null, contextTokens: null };
  }

  const unreachableText = (t, detail) => `${ROLE_LABEL[t.role]} model’s machine (${t.machine.name}) is unreachable${detail ? `: ${detail}` : ''}. Check that it is on and serving ${t.model} on port ${t.port}, or move the ${ROLE_LABEL[t.role]} role back to this machine in Settings → Inference machines.`;
  const wrongModelText = (t, served) => `The ${ROLE_LABEL[t.role]} machine (${t.machine.name}) serves ${served.slice(0, 3).join(', ') || 'no model'}${served.length > 3 ? ' and more' : ''}, not ${t.model}. Start ${t.model} on port ${t.port}, or choose the model it serves for the ${ROLE_LABEL[t.role]} role in Settings → Inference machines.`;

  /**
   * Whether the role's machine can take the turn: it answers its health check AND serves the assigned model (both
   * through the shared, cached probe, so a busy chat makes no extra request inside the TTL). A server whose models
   * cannot be read at all is not blamed for the wrong one; the request itself then says what is wrong.
   * { ok:true } | { ok:false, state, code:'machineUnreachable'|'machineWrongModel', error }
   */
  async function ready(t) {
    if (!t) return { ok: true };
    if (!health || typeof health.probe !== 'function') return { ok: true };
    let r;
    try { r = await health.probe(t.baseUrl); } catch { r = { state: 'unreachable', reason: 'network' }; }
    if (r?.state !== 'up') {
      const detail = r?.reason === 'not-on-this-network' ? 'its address is not on this network'
        : r?.state === 'down' ? `it answered ${String(r.reason || '').replace(/^http-/, 'HTTP ')}`.trim() : r?.reason === 'timeout' ? 'no answer in time' : '';
      return { ok: false, state: r?.state || 'unreachable', code: 'machineUnreachable', error: unreachableText(t, detail) };
    }
    const f = await facts(t);
    if (Array.isArray(f.models) && !f.models.includes(t.model)) return { ok: false, state: 'wrongModel', code: 'machineWrongModel', error: wrongModelText(t, f.models) };
    return { ok: true };
  }

  /** The context the machine's server runs the model with (llama-server /props): cached, the last known on failure, else the floor. */
  async function contextTokens(t) {
    return (await facts(t)).contextTokens || CONTEXT_FALLBACK;
  }

  async function propsContext(t) {
    const r = await machineFetch(`${t.baseUrl}/props?model=${encodeURIComponent(t.model)}`, { method: 'GET', signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) });
    if (!r.ok) { try { await r.body?.cancel?.(); } catch { /* nothing */ } return null; }
    const n = Number(JSON.parse(await readCapped(r, MODELS_BODY_CAP))?.default_generation_settings?.n_ctx);
    return Number.isInteger(n) && n >= CONTEXT_MIN && n <= CONTEXT_MAX ? n : null;
  }

  /** The provider row a turn uses for the role on its machine. */
  function provider(t, { contextTokens: ctx } = {}) {
    return {
      id: `machine:${t.machine.id}`,
      label: `${ROLE_LABEL[t.role]} model’s machine (${t.machine.name})`,
      baseUrl: `${t.baseUrl}/v1`,
      apiKey: '',
      shared: true,
      ...(ctx ? { contextTokens: ctx } : {}),
      machine: { id: t.machine.id, name: t.machine.name, role: t.role, port: t.port, model: t.model },
    };
  }

  /** "The machine did not answer" for a request that failed at the socket. */
  function connectError(t, err) {
    const why = err?.code === 'EPUBLICADDR' ? 'its address is not on this network'
      : /redirect/i.test(String(err?.message || '')) ? 'it answered with a redirect, which is never followed'
        : err?.name === 'TimeoutError' ? 'no answer in time' : '';
    return unreachableText(t, why);
  }

  /** The models the server at `address`:`port` lists (/v1/models). Throws a status error the Settings route shows. */
  async function modelsAt(address, port, name = address) {
    let r;
    try {
      r = await machineFetch(`${address}:${port}/v1/models`, { method: 'GET', signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
    } catch (err) {
      throw fail(502, err?.code === 'EPUBLICADDR' ? 'publicAddress' : 'machineUnreachable',
        err?.code === 'EPUBLICADDR' ? 'Machines must be on this network (a LAN or Tailscale address).' : `${name} did not answer on port ${port}.`);
    }
    if (!r.ok) { try { await r.body?.cancel?.(); } catch { /* nothing */ } throw fail(502, 'machineUnreachable', `${name} answered HTTP ${r.status} on port ${port}; it does not look like an OpenAI-compatible server.`); }
    let body;
    try { body = JSON.parse(await readCapped(r, MODELS_BODY_CAP)); } catch { throw fail(502, 'machineUnreachable', `${name} did not list its models on port ${port}.`); }
    return modelIds(body);
  }

  /** The models a machine's server lists at `port` (its /v1/models), for the Settings picker and the assign check. */
  async function listModels(machineId, port) {
    const m = machines?.machine?.(String(machineId || ''));
    if (!m) throw fail(404, 'unknownMachine', 'That machine is not on the list.');
    const n = typeof port === 'string' && /^\d+$/.test(port.trim()) ? Number(port) : port;
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw fail(400, 'invalidPort', 'Enter the service’s port, a number from 1 to 65535.');
    return modelsAt(m.address, n, m.name);
  }

  /**
   * #1849: a Manual pick names a model. When a chat role's machine serves exactly that name and this machine's
   * catalogue does not list it, the pick runs on that machine (the same request rules as an Automatic turn). A name
   * this machine lists stays here: the Manual list shows one row per name, and that row is this machine's.
   * `catalogue` is a thunk, read only when some role is on a machine (nothing assigned: no read, no change).
   */
  async function manualTarget(model, catalogue) {
    if (typeof model !== 'string' || !model) return null;
    const remote = remoteRoles();
    const match = CHAT_ROLES.map((role) => remote[role]).find((t) => t && t.model === model);
    if (!match) return null;
    let rows = null;
    try { rows = typeof catalogue === 'function' ? await catalogue() : catalogue; } catch { rows = null; }
    if (Array.isArray(rows) && rows.some((m) => m && m.name === model)) return null;
    return match;
  }

  /** #1849: the models chat roles' machines serve, one row per machine and model, for the Manual list. */
  function machineModels() {
    const out = [];
    for (const [role, t] of Object.entries(remoteRoles())) {
      const row = out.find((r) => r.model === t.model && r.machine.id === t.machine.id);
      if (row) row.roles.push(role);
      else out.push({ model: t.model, machine: { id: t.machine.id, name: t.machine.name }, roles: [role] });
    }
    return out;
  }

  /**
   * #1850: the template tools gate's source for a model on a machine: that machine's llama-server /props (its
   * `chat_template`), read through the on-this-network fetch, shaped like the model manager's props() answer.
   */
  function propsSource(t) {
    return {
      props: async (model) => {
        const r = await machineFetch(`${t.baseUrl}/props?model=${encodeURIComponent(model)}`, { method: 'GET', signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) });
        if (!r.ok) { try { await r.body?.cancel?.(); } catch { /* nothing */ } return { ok: false, status: r.status }; }
        return { ok: true, status: r.status, body: JSON.parse(await readCapped(r, PROPS_BODY_CAP)) };
      },
    };
  }

  /** #1849: a small JSON request to a machine (the router classifier): { ok, status, body } like http.cjs fetchJson. */
  async function fetchJson(url, init = {}, timeoutMs = 15000) {
    const r = await machineFetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    let text;
    try { text = await readCapped(r, MODELS_BODY_CAP); } catch { return { ok: false, status: r.status, error: 'response too large' }; }
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: r.ok, status: r.status, body };
  }

  let probe = null;
  /** The image probe for a model on a machine, through the same on-this-network fetch. */
  function visionProbe(baseUrl, headers, model) {
    if (!probe) {
      const make = createVisionProbe || require('./vision.cjs').createVisionProbe;
      probe = make({ fetchImpl: machineFetch });
    }
    return probe(baseUrl, headers, model);
  }

  return { target, remoteRoles, effectiveRoles, localRoles, ready, provider, contextTokens, connectError, listModels, modelsAt, visionProbe, manualTarget, machineModels, propsSource, fetchJson, fetch: machineFetch, label: (role) => ROLE_LABEL[role] || role };
}

module.exports = { createChatMachines, modelIds, ROLE_LABEL, CHAT_ROLES };
