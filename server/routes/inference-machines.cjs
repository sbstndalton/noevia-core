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

const PASS = Symbol('unhandled');
const PATH = '/api/models/machines';
const ACTIONS = new Set(['add', 'update', 'remove', 'assign']);
const TUNE_ACTIONS = new Set(['tune', 'tuneAbort']);

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
function createInferenceMachineRoutes({ json, readJson, machines, health, effective = {}, chatMachines = null, authHeaders = {}, engine = null, machineTune = null }) {
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

  /** #1840: a chat role moves to a machine only with a model that machine lists now. */
  async function assignChecked(body, actor) {
    const service = String(body?.service || '');
    if (SERVICES[service]?.mode === 'chat' && body.machine && body.machine !== 'local' && chatMachines) {
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!model) throw Object.assign(Error('Choose the model this machine serves for the role.'), { status: 400, code: 'invalidModel' });
      const served = await chatMachines.listModels(body.machine, body.port);
      if (!served.includes(model)) throw Object.assign(Error(`That machine does not serve ${model} on port ${body.port}.`), { status: 400, code: 'unknownModel', models: served });
    }
    return machines.assign(body, actor);
  }

  async function handle(req, res, { path: p, authn, url }) {
    if (p !== PATH) return PASS;
    res.setHeader?.('Cache-Control', 'no-store');
    if (!authn?.user) return json(res, 401, { error: 'Sign in required' });
    if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' });
    if (req.method === 'GET') {
      const modelsOf = url?.searchParams?.get?.('models');
      if (modelsOf !== null && modelsOf !== undefined) {
        if (!chatMachines) return json(res, 404, { error: 'Not available' });
        try { return json(res, 200, { models: await chatMachines.listModels(modelsOf, url.searchParams.get('port')) }); }
        catch (err) { return json(res, err?.status || 502, { error: err?.status ? err.message : 'The machine could not be asked for its models.', code: err?.code }); }
      }
      if (url?.searchParams?.get?.('tune') === '1') {
        if (!machineTune) return json(res, 404, { error: 'Not available' });
        return json(res, 200, { tune: machineTune.status() });
      }
      const view = machines.view();
      const wantHealth = url?.searchParams?.get?.('health') === '1';
      return json(res, 200, { ...withUrls(view), ...(wantHealth ? { health: await healthOf(view) } : {}) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'A JSON object is required' });
    const action = String(body.action || '');
    if (TUNE_ACTIONS.has(action)) {
      if (!machineTune) return json(res, 404, { error: 'Not available' });
      if (action === 'tuneAbort') return json(res, 200, { tune: machineTune.abort(authn.user.id) });
      try { return json(res, 202, { tune: await machineTune.start({ service: body.service, confirm: body.confirm, actor: authn.user.id }) }); }
      catch (err) {
        if (!err?.status) { console.error('[machines] tune', String(err?.message || err).slice(0, 200)); return json(res, 500, { error: 'The measurement could not be started.' }); }
        return json(res, err.status, { error: err.message, code: err.code });
      }
    }
    if (!ACTIONS.has(action)) return json(res, 400, { error: `action must be one of ${[...ACTIONS, ...(machineTune ? TUNE_ACTIONS : [])].join(', ')}`, code: 'invalidAction' });
    try {
      const actor = authn.user.id;
      const out = action === 'add' ? await machines.add(body, actor)
        : action === 'update' ? await machines.update(body, actor)
          : action === 'remove' ? machines.remove(body, actor)
            : await assignChecked(body, actor);
      return json(res, action === 'add' ? 201 : 200, withUrls(out));
    } catch (err) {
      if (!err?.status) {
        console.error('[machines]', String(err?.message || err).slice(0, 200));
        return json(res, 500, { error: 'The inference machines could not be changed.' });
      }
      return json(res, err.status, { error: err.message, code: err.code, ...(err.target ? { target: err.target } : {}), ...(err.services ? { services: err.services } : {}), ...(err.models ? { models: err.models } : {}) });
    }
  }

  return async function inferenceMachineRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createInferenceMachineRoutes, PATH };
