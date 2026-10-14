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

const PASS = Symbol('unhandled');
const ACTIONS = new Set(['set-next', 'clear-next', 'switch', 'rollback', 'finish']);
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
function createEmbeddingRoutes({ json, readJson, migration, authService, fetchJson, DIARY_BASE = '', diaryServiceHeaders = () => ({ 'Content-Type': 'application/json' }), checkAddress = require('../embedding-address.cjs').checkEmbeddingAddress, servedModels = (target) => require('../rag.cjs').servedModels(target) }) {
  const diaryUrl = DIARY_BASE ? `${String(DIARY_BASE).replace(/\/+$/, '')}/api/internal/embedding` : '';

  async function diary(method, body) {
    if (!diaryUrl) return { error: 'The Diary sidecar is not configured.' };
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
      return json(res, 200, { projects: migration.status(), diary: await diary('GET') });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'A JSON object is required' });
    const action = String(body.action || '');
    const scope = String(body.scope || 'all');
    if (!ACTIONS.has(action)) return json(res, 400, { error: `action must be one of ${[...ACTIONS].join(', ')}` });
    if (!SCOPES.has(scope)) return json(res, 400, { error: 'scope must be all, projects or diary' });
    if (action === 'set-next' && (!body.target || typeof body.target !== 'object')) return json(res, 400, { error: 'set-next needs a target { baseUrl, model, profile }' });
    if (action === 'set-next') {
      for (const address of [body.target.baseUrl, body.target.diaryBaseUrl]) {
        if (address == null || !String(address).trim()) continue; // empty: the inference engine
        const verdict = await checkAddress(String(address).trim());
        if (!verdict.ok) {
          return json(res, 400, { error: `The embeddings server must be on this network: it receives the text of every project and the Diary (${verdict.reason}).`, code: 'publicEndpoint' });
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
        if (!diaryAddress) return json(res, 409, { error: 'Name the Diary\'s embeddings server so noevia can check it serves this model.', code: 'diaryEndpointRequired' });
        addresses.add(diaryAddress);
      }
      for (const baseUrl of addresses) {
        const r = await checkServed(servedModels, { baseUrl, model });
        if (!r.ok) return json(res, 409, { error: r.error, code: r.code, ...(r.served ? { served: r.served } : {}) });
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
    const failed = [out.projects, out.diary].filter(Boolean).filter((r) => r.error);
    const status = failed.length === 0 ? 200 : failed.length === [out.projects, out.diary].filter(Boolean).length ? (failed[0].status && failed[0].status >= 400 && failed[0].status < 600 ? failed[0].status : 502) : 207;
    return json(res, status, out);
  }

  return async function embeddingRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createEmbeddingRoutes };
