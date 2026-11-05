'use strict';
// #1638: Settings → Inference machines, for administrators only (every method; the session and CSRF
// checks run before routes are mounted).
//
//   GET  /api/models/machines            { machines, services }
//   GET  /api/models/machines?health=1   the same, with { health: { services, machines } } (cached probes, machine-health.cjs)
//   GET  /api/models/machines?models=<machine id>&port=N   { models }: what that machine's OpenAI-compatible server
//                                        lists at /v1/models, for a chat role's model (#1840; on-this-network fetch)
//   POST /api/models/machines            { action: 'add', name, address }
//                                        { action: 'update', id, name?, address? }
//                                        { action: 'remove', id }
//                                        { action: 'assign', service, machine, port?, protocol?, model? }
//                                        a chat role (chatFast, chatSmart, chatCode, chatCreative, vision) on a machine
//                                        names the model; it must be one the machine lists (#1840)
//                                        { action: 'tune', service, confirm: true }   #1880: measure that chat role's model on its
//                                        machine (machine-tune.cjs); 202 { tune }. 409 tuneRunning / machineBusy (a chat turn there)
//                                        { action: 'tuneAbort' }   stop the measurement in progress; 200 { tune }
//   GET  /api/models/machines?tune=1     { tune }: the measurement in progress or the last one (null: none since start)
// An embeddings move answers 409 { code: 'reindexRequired', target } and changes nothing: the client
// then runs the #1636 re-index (POST /api/embedding set-next → switch → finish) to that target.
//
// The effective address of each service (what it reaches now, from this registry, the service's own
// saved setting or the deployment's environment) goes to administrators only.

const { machineState, machineReason, machineFailing } = require('../machine-health.cjs');
const { SERVICES } = require('../inference-machines.cjs');

const PATH = '/api/models/machines';

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<any>} deps.readJson
 * @param {object} deps.machines            inference-machines.cjs instance
 * @param {object} deps.health              machine-health.cjs instance
 * @param {Record<string, () => (string|null)>} [deps.effective]  where decision, embedding and reranker reach now
 * @param {Record<string, (url:string) => (object|null)>} [deps.authHeaders]  #1856: the headers the real client sends to that same address (decision, sensitivity); null/{} when none
 * @param {() => ({url:string, path:string, headers?:object}|null)} [deps.engine]  #1856: what to ask of this machine's own inference engine / model loader
 */
function createInferenceMachineRoutes({ json, readJson, machines, health, effective = {}, chatMachines = null, authHeaders = {}, engine = null, machineTune = null, secret }) {
  // #1840: a chat role on a machine reaches that machine's server; on this machine it has no address of its own here.
  const chatUrl = (service) => { const role = SERVICES[service]?.mode === 'chat' ? SERVICES[service].role : null; const t = role && machines.chatTarget ? machines.chatTarget(role) : null; return t ? t.baseUrl : null; };
  const effectiveUrl = (service) => { if (SERVICES[service]?.mode === 'chat') return chatUrl(service); try { return effective[service] ? effective[service]() || null : null; } catch { return null; } };

  async function healthOf(view) {
    // #1841/#1844: OCR, Docling and the sensitivity check are probed the same way (GET /health at their origin); the sensitivity
    // check, like the workers, is reached with link-local refused, so it does not use the decision service's link-local probe.
    const chat = Object.keys(SERVICES).filter((id) => SERVICES[id].mode === 'chat' && chatUrl(id));
    const headersFor = (service, url) => { try { return url && authHeaders[service] ? authHeaders[service](url) || null : null; } catch { return null; } };
    const targets = ['decision', 'sensitivity', 'embedding', 'reranker', 'ocr', 'documents', ...chat].map((service) => { const url = effectiveUrl(service); return { service, url, decision: service === 'decision', headers: headersFor(service, url), ...(service === 'decision' || service === 'sensitivity' ? { fallbackPath: '/v1/models' } : {}) }; });
    // #1856: this machine's own engine is probed where the app really reaches it (the model loader, else the default provider), not at a guessed /health.
    let local = null;
    try { local = engine ? engine() : null; } catch { local = null; }
    if (local?.url) targets.push({ service: 'engine', url: local.url, path: local.path, headers: local.headers || null });
    const services = await health.check(targets);
    const out = {}, reasons = {}, failing = {};
    for (const m of view.machines) {
      const list = m.services.map((s) => services[s]);
      if (m.id === 'local' && services.engine) list.push(services.engine);
      out[m.id] = machineState(list);
      const why = machineReason(list);
      if (why) {
        reasons[m.id] = why;
        const names = m.services.map((id) => ({ service: id, result: services[id] }));
        if (m.id === 'local' && services.engine) names.push({ service: 'engine', result: services.engine });
        const bad = machineFailing(names);
        if (bad) failing[m.id] = bad;
      }
    }
    // #1854: what each chat role's machine measured for its model (context, thinking switch, image input), from the
    // same cached /props read the turns use; only for a role whose machine answers. Nothing on a machine: no key.
    const measured = {};
    if (chatMachines && typeof chatMachines.measurements === 'function') {
      await Promise.all(chat.filter((id) => services[id]?.state === 'up').map(async (id) => {
        const t = machines.chatTarget(SERVICES[id].role);
        if (!t) return;
        try {
          measured[id] = await chatMachines.measurements(t);
          // #1880: the last administrator-started measurement of this model on this machine, when there is one.
          const tuned = machineTune ? machineTune.resultFor(t.machine.id, t.model) : null;
          if (tuned) measured[id] = { ...measured[id], tune: tuned, notMeasured: (measured[id].notMeasured || []).filter((k) => k !== 'autotune' && !(k === 'speculativeDecoding' && tuned.speculative?.measured)) };
        } catch { /* not shown */ }
      }));
    }
    return { services, machines: out, reasons, failing, ...(Object.keys(measured).length ? { measured } : {}) };
  }

  function withUrls(view) {
    return { ...view, services: view.services.map((s) => (effective[s.id] || chatUrl(s.id) ? { ...s, url: effectiveUrl(s.id) } : s)) };
  }

  return async function inferenceMachineRoutes(req, res) {
    if (req.url === '/internal/inference-machines/probes' || req.url === '/internal/inference-machines/ready') {
      if (req.method !== 'POST' || !require('../trusted-front.cjs').trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, {error:'Not found'}); return true; }
      try {
        const body = await readJson(req, 1024 * 1024);
        if (req.url.endsWith('/ready')) { if (!body?.target?.machine?.id) { json(res,400,{error:'Invalid machine readiness request.'}); return true; } json(res,200,await chatMachines.ready(body.target)); return true; }
        if (!body || typeof body.health !== 'boolean' || !Array.isArray(body.view?.machines) || !Array.isArray(body.view?.services)) { json(res,400,{error:'Invalid machine probes request.'}); return true; }
        if (Array.isArray(body.changed) && body.changed.every(service => Object.hasOwn(SERVICES, service))) machines.notifyChanges?.(body.changed);
        const view = withUrls(body.view);
        json(res,200,{...view,...(body.health ? {health:await healthOf(body.view)} : {})});
      } catch { json(res,503,{error:'Inference machine probes are unavailable.'}); }
      return true;
    }
    if (new URL(req.url, 'http://localhost').pathname !== PATH) return false;
    json(res,503,require('../rust-inference-machines.cjs').ROUTE_REFUSAL);
    return true;
  };
}
module.exports = { createInferenceMachineRoutes, PATH };
