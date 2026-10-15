'use strict';
// #1638: Settings → Inference machines, for administrators only (every method; the session and CSRF
// checks run before routes are mounted).
//
//   GET  /api/models/machines            { machines, services }
//   GET  /api/models/machines?health=1   the same, with { health: { services, machines } } (cached probes, machine-health.cjs)
//   POST /api/models/machines            { action: 'add', name, address }
//                                        { action: 'update', id, name?, address? }
//                                        { action: 'remove', id }
//                                        { action: 'assign', service, machine, port?, protocol? }
// An embeddings move answers 409 { code: 'reindexRequired', target } and changes nothing: the client
// then runs the #1636 re-index (POST /api/embedding set-next → switch → finish) to that target.
//
// The effective address of each service (what it reaches now, from this registry, the service's own
// saved setting or the deployment's environment) goes to administrators only.

const { machineState } = require('../machine-health.cjs');

const PASS = Symbol('unhandled');
const PATH = '/api/models/machines';
const ACTIONS = new Set(['add', 'update', 'remove', 'assign']);

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<any>} deps.readJson
 * @param {object} deps.machines            inference-machines.cjs instance
 * @param {object} deps.health              machine-health.cjs instance
 * @param {Record<string, () => (string|null)>} [deps.effective]  where decision, embedding and reranker reach now
 */
function createInferenceMachineRoutes({ json, readJson, machines, health, effective = {} }) {
  const effectiveUrl = (service) => { try { return effective[service] ? effective[service]() || null : null; } catch { return null; } };

  async function healthOf(view) {
    // #1841/#1844: OCR, Docling and the sensitivity check are probed the same way (GET /health at their origin); the sensitivity
    // check, like the workers, is reached with link-local refused, so it does not use the decision service's link-local probe.
    const targets = ['decision', 'sensitivity', 'embedding', 'reranker', 'ocr', 'documents'].map((service) => ({ service, url: effectiveUrl(service), decision: service === 'decision' }));
    const services = await health.check(targets);
    const out = {};
    for (const m of view.machines) out[m.id] = machineState(m.services.map((s) => services[s]));
    return { services, machines: out };
  }

  function withUrls(view) {
    return { ...view, services: view.services.map((s) => (effective[s.id] ? { ...s, url: effectiveUrl(s.id) } : s)) };
  }

  async function handle(req, res, { path: p, authn, url }) {
    if (p !== PATH) return PASS;
    res.setHeader?.('Cache-Control', 'no-store');
    if (!authn?.user) return json(res, 401, { error: 'Sign in required' });
    if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' });
    if (req.method === 'GET') {
      const view = machines.view();
      const wantHealth = url?.searchParams?.get?.('health') === '1';
      return json(res, 200, { ...withUrls(view), ...(wantHealth ? { health: await healthOf(view) } : {}) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'A JSON object is required' });
    const action = String(body.action || '');
    if (!ACTIONS.has(action)) return json(res, 400, { error: `action must be one of ${[...ACTIONS].join(', ')}`, code: 'invalidAction' });
    try {
      const actor = authn.user.id;
      const out = action === 'add' ? await machines.add(body, actor)
        : action === 'update' ? await machines.update(body, actor)
          : action === 'remove' ? machines.remove(body, actor)
            : machines.assign(body, actor);
      return json(res, action === 'add' ? 201 : 200, withUrls(out));
    } catch (err) {
      if (!err?.status) {
        console.error('[machines]', String(err?.message || err).slice(0, 200));
        return json(res, 500, { error: 'The inference machines could not be changed.' });
      }
      return json(res, err.status, { error: err.message, code: err.code, ...(err.target ? { target: err.target } : {}), ...(err.services ? { services: err.services } : {}) });
    }
  }

  return async function inferenceMachineRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createInferenceMachineRoutes, PATH };
