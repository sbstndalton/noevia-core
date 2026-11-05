'use strict';
// Row A oracle (model load/unload port, 2026-11-05). Records what Core's own POST /api/models/load and
// /api/models/unload answered at Core 088d880 (before the move), over the real routes/models.cjs and the real
// llama.cpp adapter, with a synthetic router (fetchJson) and a synthetic inference gate. No engine, no model.
//
// For each scenario it also records what Core's inference-admission lease route answers for the same gate or
// budget step, so the Rust front's replay can stand a fake Node in for the step and must still answer the
// public response recorded here.
//
//   node tests/fixtures/model-load-node-oracle.cjs > tests/fixtures/model-load-node.v1.json
const path = require('node:path');
// Diagnostics never reach the recorded JSON.
console.log = (...a) => console.error(...a);
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const server = path.join(__dirname, '..', '..', 'server');
const { createModelRoutes } = require(path.join(server, 'routes', 'models.cjs'));
const { createLlamaCppManager } = require(path.join(server, 'llamacpp-manager.cjs'));
const { createGateClient, GateError } = require(path.join(server, 'inference-gate-client.cjs'));

const realGate = createGateClient({ baseUrl: 'http://127.0.0.1:9', adminToken: null });

/** A thrown step: what prepareLoad or the gate's queue throws. */
function thrown(spec) {
  if (spec.gate) return new GateError(spec.gate);
  return Object.assign(Error(spec.message), { status: spec.status, publicMessage: spec.message, ...(spec.code ? { code: spec.code } : {}) });
}

function rowsOf(state) { return { ok: true, status: 200, body: { data: [{ id: 'm', status: { value: state } }] } }; }

async function run(s) {
  const seen = [];
  const replies = JSON.parse(JSON.stringify(s.router || {}));
  const fetchJson = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${String(init.method || 'GET').toUpperCase()} ${u.pathname}`;
    let body = null; try { body = init.body ? JSON.parse(init.body) : null; } catch {}
    const lower = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ call: key, body, lease: lower['x-noevia-lease'] || null, admin: lower['x-noevia-gate-admin'] ? true : false });
    const queue = replies[key];
    const next = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : null;
    if (!next) return { ok: true, status: 200, body: { data: [{ id: 'm', status: { value: 'loaded' } }] } };
    if (next.throw) throw Error('synthetic transport failure');
    if (next.rows) return rowsOf(next.rows);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, body: next.body };
  };
  const gate = {
    acquire: async () => {
      if (s.acquire) throw thrown(s.acquire);
      return { headers: () => ({ 'x-noevia-lease': 'syntheticLease1' }), release: async () => {} };
    },
    refusal: realGate.refusal,
    hasAdmin: () => s.admin === true,
    adminHeaders: () => (s.admin === true ? { 'x-noevia-gate-admin': 'synthetic-admin' } : null),
    waiting: () => 0,
    releaseAll: async () => 0,
  };
  const manager = createLlamaCppManager({ baseUrl: 'http://127.0.0.1:9', apiKey: 'local', fetchJson, gate });
  if (s.kind === 'none') { manager.enabled = false; }
  const sent = [];
  const routes = createModelRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let t = ''; for await (const c of req) t += c; return t; },
    readJson: async (req) => { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {}; },
    fetchJson: async () => ({ ok: false, status: 500 }),
    env: { EMBEDDING_MODEL: 'embed-sidecar' }, modelManager: manager,
    currentWorkspace: () => ({ userId: 'u1' }),
    service: {
      modelScanCache: new Map(), refreshModelScan: () => {}, autoRoles: () => null, setAutoRoles: () => {}, ensureRolesLoaded: () => {},
      servedCatalogue: async () => [], invalidateModelReads: () => {},
      modelsInstalled: async () => (s.installedThrows ? Promise.reject(Error('x')) : [{ name: 'm', missingFile: s.missingFile === true }]),
      deriveUserModelName: (c) => c, lastLoadedModel: () => null, clearLastLoadedModel: () => {}, clearRoleReferences: async () => [],
    },
    servedEmbeddingModels: async () => [],
  });
  const req = Readable.from([Buffer.from(s.raw)]);
  req.method = 'POST'; req.url = s.path; req.headers = {};
  const res = new EventEmitter(); res.writableEnded = false;
  let status = null, body = null;
  try {
    await routes(req, res, { path: s.path, authn: { user: { id: 'u1', role: s.role || 'admin' } }, url: new URL('http://x' + s.path) });
    if (sent.length) ({ status, body } = sent[0]);
  } catch (err) {
    // index.cjs: errorResponse(err) for what the route threw.
    const st = Number(err && err.status);
    if (Number.isInteger(st) && st >= 400 && st < 500) { status = st; body = { error: String(err.message || 'Request failed') }; }
    else { status = Number.isInteger(st) && st >= 500 && st < 600 ? st : 500; body = { error: 'Internal error' }; }
  }
  manager.close?.();
  return { status, body, router: seen };
}

/** What Core's admission lease route answers when the engine step throws `spec`. */
async function leaseAnswer(spec) {
  const { createAdmissionRoutes } = require(path.join(server, 'inference-admission-lease.cjs'));
  const sent = [];
  const routes = createAdmissionRoutes({
    secret: 'synthetic-secret',
    modelManager: { enterInference: () => () => {}, acquireLease: async () => { throw thrown(spec); } },
    json: (res, status, body) => { sent.push({ status, body }); },
    readJson: async () => ({ model: 'm' }),
  });
  const req = new EventEmitter(); req.method = 'POST'; req.url = '/internal/inference-admission/lease';
  req.headers = { 'x-noevia-store-token': 'synthetic-secret' }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = new EventEmitter(); res.writableEnded = false; res.destroy = () => {};
  await routes.handle(req, res);
  return sent[0] || null;
}

const L = '/api/models/load', U = '/api/models/unload';
const gateBody = (code, status, retryable) => ({ error: { type: 'gate_error', code, message: `Synthetic ${code}.`, retryable } });
const SCENARIOS = [
  { name: 'invalid JSON', path: L, raw: '{' },
  { name: 'empty body', path: L, raw: '' },
  { name: 'no name', path: L, raw: '{}' },
  { name: 'empty name', path: U, raw: '{"name":""}' },
  { name: 'null body', path: L, raw: 'null' },
  { name: 'member', path: L, raw: '{"name":"m"}', role: 'user' },
  { name: 'disabled', path: L, raw: '{"name":"m"}', kind: 'none' },
  { name: 'system model load', path: L, raw: '{"name":"laya-router"}' },
  { name: 'system model unload', path: U, raw: '{"name":"laya"}' },
  { name: 'sidecar load', path: L, raw: '{"name":"embed-sidecar"}' },
  { name: 'sidecar unload', path: U, raw: '{"name":"embed-sidecar"}' },
  { name: 'missing file', path: L, raw: '{"name":"m"}', missingFile: true },
  { name: 'missing file unload allowed', path: U, raw: '{"name":"m"}', missingFile: true },
  { name: 'installed read fails, load goes on', path: L, raw: '{"name":"m"}', installedThrows: true },
  { name: 'mtp refused', path: L, raw: '{"name":"m","mtp":true}' },
  { name: 'load ready', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }, { rows: 'loading' }, { rows: 'loaded' }], 'POST /models/load': [{ status: 200, body: { success: true } }] } },
  { name: 'load sleeping', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'sleeping' }] } },
  { name: 'load already running', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }, { rows: 'loaded' }], 'POST /models/load': [{ status: 400, body: { error: { message: 'model is already running' } } }] } },
  { name: 'load router 500', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }], 'POST /models/load': [{ status: 500, body: { error: 'boom' } }] } },
  { name: 'load gate refusal on load', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }], 'POST /models/load': [{ status: 409, body: gateBody('engine_busy', 409, true) }] } },
  { name: 'load gate refusal unknown code', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }], 'POST /models/load': [{ status: 409, body: gateBody('something_else', 409, false) }] } },
  { name: 'load raw code refusal', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }], 'POST /models/load': [{ status: 503, body: { code: 'engine_unavailable', error: 'Synthetic raw.', retryable: true } }] } },
  { name: 'load failed to become ready', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }, { status: 200, body: { data: [{ id: 'm', status: { value: 'loading', failed: true } }] } }], 'POST /models/load': [{ status: 200, body: { success: true } }] } },
  { name: 'load vanished', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }, { status: 200, body: { data: [] } }], 'POST /models/load': [{ status: 200, body: {} }] } },
  { name: 'load listing fails while waiting', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ rows: 'unloaded' }, { status: 503, body: { error: 'down' } }], 'POST /models/load': [{ status: 200, body: {} }] } },
  { name: 'load transport fault', path: L, raw: '{"name":"m"}', router: { 'GET /models': [{ throw: true }] } },
  { name: 'queue full', path: L, raw: '{"name":"m"}', acquire: { gate: { code: 'inference_queue_full', status: 503, retryable: true, message: 'Synthetic queue full.' } } },
  { name: 'queue gate unknown code', path: L, raw: '{"name":"m"}', acquire: { gate: { code: 'gate_error', status: 503, retryable: false, message: 'Synthetic gate error.' } } },
  { name: 'budget refusal', path: L, raw: '{"name":"m"}', acquire: { status: 409, code: 'inference_budget', message: 'm needs about 99 GiB to load, above the budget.' } },
  { name: 'invalid size refusal', path: L, raw: '{"name":"m"}', acquire: { status: 409, code: 'invalid_size', message: 'm was not loaded: ctx-size must be a whole number' } },
  { name: 'unload ok', path: U, raw: '{"name":"m"}', router: { 'POST /models/unload': [{ status: 200, body: { success: true } }] } },
  { name: 'unload in use, no admin', path: U, raw: '{"name":"m"}', router: { 'POST /models/unload': [{ status: 409, body: gateBody('model_in_use', 409, false) }] } },
  { name: 'unload in use, admin', path: U, raw: '{"name":"m"}', admin: true, router: { 'POST /models/unload': [{ status: 409, body: gateBody('model_in_use', 409, false) }] } },
  { name: 'unload other refusal', path: U, raw: '{"name":"m"}', admin: true, router: { 'POST /models/unload': [{ status: 503, body: gateBody('engine_switch_stuck', 503, true) }] } },
  { name: 'unload router 500', path: U, raw: '{"name":"m"}', router: { 'POST /models/unload': [{ status: 500, body: 'text' }] } },
  { name: 'unload transport fault', path: U, raw: '{"name":"m"}', router: { 'POST /models/unload': [{ throw: true }] } },
  { name: 'force without admin', path: U, raw: '{"name":"m","force":true}' },
  { name: 'force ok', path: U, raw: '{"name":"m","force":true}', admin: true, router: { 'POST /models/unload': [{ status: 200, body: { success: true } }] } },
  { name: 'force refused', path: U, raw: '{"name":"m","force":true}', admin: true, router: { 'POST /models/unload': [{ status: 404, body: gateBody('model_not_found', 404, false) }] } },
  { name: 'force router 500', path: U, raw: '{"name":"m","force":true}', admin: true, router: { 'POST /models/unload': [{ status: 500, body: {} }] } },
  { name: 'force not exactly true', path: U, raw: '{"name":"m","force":"yes"}', router: { 'POST /models/unload': [{ status: 200, body: {} }] } },
];

(async () => {
  const out = [];
  for (const s of SCENARIOS) {
    const answer = await run(s);
    out.push({ ...s, expect: { status: answer.status, body: answer.body }, routerCalls: answer.router, ...(s.acquire ? { lease: await leaseAnswer(s.acquire) } : {}) });
  }
  process.stdout.write(JSON.stringify({ version: 1, core: process.env.ORACLE_CORE || 'unknown', node: process.version, scenarios: out }, null, 1) + '\n');
})().catch((e) => { console.error(e); process.exit(1); });
