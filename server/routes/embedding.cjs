'use strict';
// #1636 / #1638: the embedding model of retrieval, for administrators. This is the seam the
// Settings page (and the later "Inference machines" page) calls; it never changes anything except
// through embedding-migration.cjs (projects) and the Diary sidecar's own re-index endpoint.
//
//   GET  /api/embedding   { projects: status, diary: status | { error } }
//   POST /api/embedding   { action, target?, force?, scope? }
//        action  'set-next' (target required) | 'clear-next' | 'switch' | 'rollback' | 'finish'
//        target  { baseUrl, model, profile }  (baseUrl empty = the inference engine)
//        scope   'all' (default) | 'projects' | 'diary'
//
// Administrators only; the session and CSRF checks run before routes are mounted. The Diary half
// goes to the sidecar with the service token only (no tenant header): the Diary re-embeds every
// tenant's index with its own code, and no tenant's data passes through here.
//
// Local-first: a re-index sends every account's project text (and the Diary its entries) to the
// target address, so a target must be on this network. The address is accepted only when it parses
// and every address it resolves to is private (embedding-address.cjs); anything else, including a
// name that does not resolve, is refused. Cloud models are reached as chat providers, never as the
// embedding server.

const { checkServed } = require('../embedding-served.cjs');

const { sameTarget } = require('../embedding-config.cjs');

const PASS = Symbol('unhandled');
const ACTIONS = new Set(['set-next', 'clear-next', 'switch', 'rollback', 'finish', 'service-switch', 'service-off']);
const SERVICE_ACTIONS = new Set(['service-switch', 'service-off']);
const SCOPES = new Set(['all', 'projects', 'diary']);

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<any>} deps.readJson
 * @param {object} deps.migration     embedding-migration.cjs instance
 * @param {object} deps.authService   audit()
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<{ok:boolean,status:number,body:any}>} deps.fetchJson
 * @param {string} [deps.DIARY_BASE]
 * @param {() => object} [deps.diaryServiceHeaders]
 * @param {(url:string) => Promise<{ok:boolean,reason?:string}>} [deps.checkAddress]
 */
function createEmbeddingRoutes({ json, readJson, migration, authService, fetchJson, DIARY_BASE = '', diaryServiceHeaders = () => ({ 'Content-Type': 'application/json' }), checkAddress = require('../embedding-address.cjs').checkEmbeddingAddress, servedModels = (target) => require('../rag.cjs').servedModels(target), service = null, resolveFile = null, waitTimeoutMs = 180000 }) {
  const diaryUrl = DIARY_BASE ? `${String(DIARY_BASE).replace(/\/+$/, '')}/api/internal/embedding` : '';

  async function diary(method, body) {
    if (!diaryUrl) return { error: 'The Diary sidecar is not configured.', code: 'notConfigured' };
    try {
      const r = await fetchJson(diaryUrl, { method, headers: diaryServiceHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) }, 15000);
      if (r.ok) return r.body;
      return { error: String(r.body?.error || r.body?.detail || `The Diary answered HTTP ${r.status}.`).slice(0, 300), status: r.status, ...(r.body?.code ? { code: r.body.code } : {}) };
    } catch (err) {
      return { error: `The Diary could not be reached (${String(err?.message || err).slice(0, 120)}).` };
    }
  }

  async function projects(action, body) {
    try {
      if (action === 'set-next') return await migration.setNext(body.target);
      if (action === 'clear-next') return migration.clearNext();
      if (action === 'switch') return await migration.switchToNext({ force: body.force === true });
      if (action === 'rollback') return migration.rollback();
      return migration.finish();
    } catch (err) {
      return { error: String(err?.message || err).slice(0, 300), status: err?.status || 500, ...(err?.code ? { code: err.code } : {}), ...(err?.coverage ? { coverage: err.coverage } : {}), ...(err?.parity ? { parity: err.parity } : {}), ...(err?.served ? { served: err.served } : {}) };
    }
  }

  async function handle(req, res, { path: p, authn }) {
    if (p !== '/api/embedding') return PASS;
    res.setHeader('Cache-Control', 'no-store');
    if (!authn?.user) return json(res, 401, { error: 'Sign in required' });
    if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' });
    if (req.method === 'GET') {
      if (service) await service.refresh();
      return json(res, 200, { projects: migration.status(), diary: await diary('GET'), ...(service?.managed() ? { service: service.status() } : {}) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'A JSON object is required' });
    const action = String(body.action || '');
    if (!ACTIONS.has(action)) return json(res, 400, { error: `action must be one of ${[...ACTIONS].join(', ')}` });
    const r = await apply(body, authn);
    return json(res, r.status, r.body);
  }

  const reply = (status, body) => ({ status, body });

  // #1668: which models the embedding service must serve for the projects' configuration `c` and
  // the Diary's `d` (its status: targets carry base_url): every target that lives on the service,
  // each with its file. Active and next models of either side come first; a rollback model only if
  // there is room. A target whose file is not known (not installed any more) is left out; the
  // service then cannot serve it, which the served-model check reports. null when the models in
  // use do not fit the service: the caller must not shrink it then.
  const addressOf = (t) => (t ? (t.baseUrl !== undefined ? t.baseUrl : t.base_url) : undefined);
  // #1683: a Diary target without an address (base_url '' or null) uses the Diary's own default
  // server, which web cannot see (the Diary's environment, e.g. LLM_EMBED_BASE_URL or its chat
  // engine, is not web's). It may be the embedding service, so keep its model (the safe direction:
  // dropping it could stop the Diary's search).
  const diaryDefault = (t) => !String(addressOf(t) ?? '').trim();
  function servedSet(c, d = null, { diaryDefaults = true } = {}) {
    const out = [];
    const diarySide = new Set([d?.active, d?.next, d?.previous].filter(Boolean));
    const onService = (t) => service.isAt(addressOf(t)) || (diaryDefaults && diarySide.has(t) && diaryDefault(t));
    const add = (t) => {
      if (!t || !t.model || !onService(t) || out.some((e) => e.model === t.model)) return true;
      const file = service.fileOf(t.model);
      if (!file) return true;
      out.push({ model: t.model, file });
      return out.length <= 2;
    };
    for (const t of [c.active, d?.active, c.next, d?.next]) if (!add(t)) return null;
    for (const t of [c.previous, d?.previous]) if (out.length < 2) add(t);
    return out;
  }

  // #1687: the Diary's GET always reports an active target (its configuration falls back to the
  // environment's, or an 'unavailable' one when its saved file is damaged), so a reply without
  // one is not a Diary this code knows: it stays unknown.
  // The Diary's targets, or null when they cannot be known (not reachable, unexpected answer): a
  // shrink then could drop a model the Diary still searches with. { active: null } when no Diary
  // is configured here.
  async function diaryTargets() {
    if (!diaryUrl) return { active: null, next: null, previous: null };
    const d = await diary('GET');
    return d && !d.error && d.active && typeof d.active === 'object' ? d : null;
  }

  // #1668 review: service changes (switch, off, and the sync after finish/cancel/rollback) run one
  // at a time; each re-reads the configuration once it holds the turn.
  let turn = Promise.resolve();
  function serialized(fn) {
    const run = turn.then(fn, fn);
    turn = run.catch(() => {});
    return run;
  }

  async function syncService() {
    return serialized(async () => {
      if (!service?.managed() || !service.enabled()) return;
      const d = await diaryTargets();
      if (!d) return; // the Diary may still use a model: keep serving what is served
      const want = servedSet(migration.status(), d);
      try { if (want && want.length) await service.serve(want); } catch { /* the next sync retries; delete stays guarded */ }
    });
  }

  function serviceAction(action, body, authn) {
    return serialized(() => serviceActionHeld(action, body, authn));
  }

  async function serviceActionHeld(action, body, authn) {
    if (!service?.managed()) return reply(409, { error: 'The embedding service is not managed by noevia on this server (see docs/deployment.md, #1668).', code: 'notManaged' });
    const c = migration.status();
    if (action === 'service-off') {
      if (c.next) return reply(409, { error: 'A re-index is under way. Cancel it before turning embedding off.', code: 'reindexUnderway' });
      // #1676: the last switch's rollback model is still served and its vectors kept.
      if (c.previous) return reply(409, { error: 'Finish the last embedding switch (or roll it back) before turning embedding off.', code: 'finishFirst' });
      // #1681: the Diary's half of a switch counts too: off would stop its re-index or drop the
      // model its rollback needs. Unknown Diary state (configured but not answering) refuses.
      const d = await diaryTargets();
      if (!d) return reply(409, { error: 'The Diary\'s embedding settings could not be read, so turning embedding off could stop a switch it has under way. Try again when the Diary answers.', code: 'diaryUnknown' });
      if (d.next || d.previous) return reply(409, { error: 'The Diary has not finished its embedding switch. Finish it (or roll it back) before turning embedding off.', code: 'finishFirst' });
      try { await service.serve([]); } catch (err) { return reply(err.status || 502, { error: err.message, code: err.code }); }
      authService.audit?.('embedding.service-off', authn.user.id, null, {});
      return reply(200, { service: service.status() });
    }
    // service-switch: { model, profile }
    const model = String(body.model || '').trim();
    if (!model) return reply(400, { error: 'service-switch needs a model' });
    if (c.next) return reply(409, { error: 'A re-index is already under way. Finish or cancel it first.', code: 'reindexUnderway' });
    // The rollback model of the last switch is still served; a new switch would drop it.
    if (c.previous) return reply(409, { error: 'Finish the last embedding switch (or roll it back) before switching again.', code: 'finishFirst' });
    const file = resolveFile ? await resolveFile(model).catch(() => null) : null;
    if (!file) return reply(404, { error: `${model} is not an installed model file.`, code: 'modelNotInstalled' });
    // Keep the address spelled as the active target has it (with or without /v1): the endpoint is
    // part of the saved target, and the same server must not look like a move.
    const address = c.active && service.isAt(c.active.baseUrl) ? c.active.baseUrl : service.baseUrl;
    const target = { baseUrl: address, model, profile: body.profile };
    const fromOff = !service.enabled();
    const activeOnService = c.active && service.isAt(c.active.baseUrl) && !fromOff;
    // #1675: keep everything either side (projects and the Diary) still uses on the service. If the
    // Diary's targets cannot be read, a shrink could drop the model it searches with: refuse.
    let keep = [];
    if (activeOnService) {
      const d = await diaryTargets();
      if (!d) return reply(409, { error: 'The Diary\'s embedding settings could not be read, so the switch could drop a model it still uses. Try again when the Diary answers.', code: 'diaryUnknown' });
      keep = servedSet(c, d);
      // #1686: when only a Diary target on its default server (no address) pushes the set past
      // two, finishing a switch would not help: the Diary needs an explicit address.
      const known = servedSet(c, d, { diaryDefaults: false });
      const overflows = (set) => !set || set.length + (set.some((e) => e.model === model) ? 0 : 1) > 2;
      if (overflows(keep) && !overflows(known)) return reply(409, { error: 'The Diary uses its default embedding server, so noevia cannot tell whether it shares the embedding service. Give the Diary an explicit embeddings address in Settings, then switch again.', code: 'diaryAddressUnknown' });
      if (!keep) return reply(409, { error: 'The embedding service already serves two models in use. Finish or cancel the switch under way first.', code: 'tooManyModels' });
    }
    if (keep.some((e) => e.model === model)) return reply(409, { error: `${model} is already the embedding model.`, code: 'alreadyActive' });
    if (keep.length + 1 > 2) return reply(409, { error: `Projects and the Diary use ${keep.map((e) => e.model).join(' and ')}; the embedding service serves at most two models. Finish or roll back the other switch first.`, code: 'tooManyModels' });
    const before = fromOff ? [] : (service.status()?.models || []).filter((e) => e && e.model && e.file).map((e) => ({ model: e.model, file: e.file }));
    try { await service.serve([...keep, { model, file }]); } catch (err) { return reply(err.status || 502, { error: err.message, code: err.code }); }
    const loaded = await service.waitLoaded([model], { timeoutMs: waitTimeoutMs });
    if (!loaded) {
      // Back to what was served (nothing, when embedding was off), so a model nothing uses is not
      // left loaded, nor embedding left on.
      try { await service.serve(before); } catch { /* status shows it; delete stays guarded */ }
      return reply(504, { error: `The embedding service did not load ${model} in time. Nothing was re-indexed; try again or pick another model.`, code: 'serviceNotLoaded', service: service.status() });
    }
    // Turning embedding back on with the model the stored vectors already belong to: nothing to re-index.
    if (fromOff && c.active && sameTarget(c.active, { ...target, profile: target.profile || c.active.profile })) {
      return reply(200, { service: service.status(), projects: migration.status() });
    }
    const r = await apply({ action: 'set-next', scope: 'all', target: { ...target, diaryBaseUrl: address } }, authn);
    return { status: r.status, body: { ...r.body, service: service.status() } };
  }

  async function apply(body, authn) {
    const action = String(body.action || '');
    const scope = String(body.scope || 'all');
    if (!ACTIONS.has(action)) return reply(400, { error: `action must be one of ${[...ACTIONS].join(', ')}` });
    if (SERVICE_ACTIONS.has(action)) return serviceAction(action, body, authn);
    if (!SCOPES.has(scope)) return reply(400, { error: 'scope must be all, projects or diary' });
    if (action === 'set-next' && (!body.target || typeof body.target !== 'object')) return reply(400, { error: 'set-next needs a target { baseUrl, model, profile }' });
    if (action === 'set-next') {
      for (const address of [body.target.baseUrl, body.target.diaryBaseUrl]) {
        if (address == null || !String(address).trim()) continue; // empty: the inference engine
        const verdict = await checkAddress(String(address).trim());
        if (!verdict.ok) {
          return reply(400, { error: `The embeddings server must be on this network: it receives the text of every project and the Diary (${verdict.reason}).`, code: 'publicEndpoint' });
        }
      }
    }
    // #1660 review: every embeddings server this choice reaches must really serve the target model.
    // A single-model server embeds any name with its own model, so vectors would be stored under the
    // wrong identity; refuse unless its /v1/models lists the target (no override: that is corrupt
    // data). The projects use target.baseUrl, the Diary target.diaryBaseUrl ?? target.baseUrl (as
    // sent below); each different address is asked, before anything changes on either side. The
    // migration layer checks the projects' side again (it also guards switch and start-up).
    if (action === 'set-next') {
      const model = String(body.target.model || '').trim();
      const addr = (v) => String(v ?? '').trim() || null;
      const addresses = new Set();
      if (scope !== 'diary') addresses.add(addr(body.target.baseUrl));
      if (scope !== 'projects') {
        const diaryAddress = addr(body.target.diaryBaseUrl ?? body.target.baseUrl);
        // With no address the Diary is sent base_url '' and resolves its own default server, which
        // this check cannot see: probing web's engine instead could approve a model the Diary's
        // server does not serve. Fail closed; the admin names the Diary's server explicitly.
        if (!diaryAddress) return reply(409, { error: 'Name the Diary\'s embeddings server so noevia can check it serves this model.', code: 'diaryEndpointRequired' });
        addresses.add(diaryAddress);
      }
      for (const baseUrl of addresses) {
        const r = await checkServed(servedModels, { baseUrl, model });
        if (!r.ok) return reply(409, { error: r.error, code: r.code, ...(r.served ? { served: r.served } : {}) });
      }
    }
    const out = {};
    if (scope !== 'diary') out.projects = await projects(action, body);
    if (scope !== 'projects') {
      const target = body.target && typeof body.target === 'object' ? { model: body.target.model, profile: body.target.profile, base_url: body.target.diaryBaseUrl ?? body.target.baseUrl ?? '' } : undefined;
      out.diary = await diary('POST', { action, ...(target ? { target } : {}), ...(body.force === true ? { force: true } : {}) });
    }
    authService.audit?.('embedding.' + action, authn.user.id, null, {
      scope, model: body.target?.model || null, profile: body.target?.profile || null, force: body.force === true,
      projects: out.projects ? (out.projects.error ? 'refused' : 'ok') : 'skipped', diary: out.diary ? (out.diary.error ? 'refused' : 'ok') : 'skipped',
    });
    // #1668: after a finish, cancel or rollback the service serves only what is still configured,
    // so the model that left becomes deletable once the router has dropped it.
    // #1679: either side's change counts (a scope=diary finish frees a model too).
    if (['finish', 'clear-next', 'rollback', 'switch'].includes(action) && [out.projects, out.diary].some((r) => r && !r.error)) await syncService();
    const failed = [out.projects, out.diary].filter(Boolean).filter((r) => r.error);
    const status = failed.length === 0 ? 200 : failed.length === [out.projects, out.diary].filter(Boolean).length ? (failed[0].status && failed[0].status >= 400 && failed[0].status < 600 ? failed[0].status : 502) : 207;
    return { status, body: out };
  }

  return async function embeddingRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createEmbeddingRoutes };
