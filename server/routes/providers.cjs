'use strict';
// The provider registry's HTTP surface (providers.cjs holds the registry):
//   GET    /api/providers        list, with keys masked
//   POST   /api/providers        connect one (shared rows are admin-only)
//   POST   /api/providers/test   probe an endpoint's /v1/models before saving it
//   DELETE /api/providers/:id    remove one; projects on it fall back to the default
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// The SSRF guard (endpointApproved) is the same policy the storage routes apply.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<string>} deps.readBody
 * @param {(req) => Promise<any>} deps.readJson
 * @param {(url:string, init:object, timeoutMs:number) => Promise<{ok:boolean,status:number,body:any}>} deps.fetchJson
 * @param {(authn, url:string) => boolean} deps.endpointApproved
 * @param {object[]} deps.PROVIDERS
 * @param {object[]} deps.PROJECTS
 * @param {string} deps.DEFAULT_PROVIDER_ID
 * @param {{ enabled:boolean }} deps.modelManager
 * @param {() => object} deps.currentWorkspace
 * @param {(projects:object[]) => void} deps.saveProjects
 * @param {object} deps.registry   providers.cjs
 */
function createProviderRoutes({ json, readBody, readJson, fetchJson, endpointApproved, PROVIDERS, PROJECTS, DEFAULT_PROVIDER_ID, modelManager, currentWorkspace, saveProjects, registry }) {
  const { saveProviders, saveSharedProviders, maskKey } = registry;

  async function handle(req, res, { path: p, authn }) {
    // ── Provider registry (step 9): list / connect / remove. GET never returns
    // a saved apiKey in plaintext — masked, e.g. sk-…last4.
    if (p === '/api/providers' && req.method === 'GET') {
      return json(res, 200, {
        providers: PROVIDERS.map((pr) => ({
          id: pr.id,
          label: pr.label,
          baseUrl: pr.baseUrl,
          apiKeyMasked: maskKey(pr.apiKey),
          isDefault: pr.id === DEFAULT_PROVIDER_ID,
          managed: pr.id === DEFAULT_PROVIDER_ID && modelManager.enabled,
          shared: !!pr.shared,
          defaultModel: pr.defaultModel || undefined,
        })),
      });
    }
    if (p === '/api/providers' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      const label = String(body.label || '').trim().slice(0, 80);
      let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      const apiKey = String(body.apiKey || '').trim();
      const defaultModel = String(body.defaultModel || '').trim().slice(0, 200);
      const shared = body.shared === true;
      if (shared && authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required for shared providers' });
      if (!label) return json(res, 400, { error: 'label required' });
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
      // SSRF guard: a member must not register an endpoint the server can
      // only reach from its own internal network (RFC1918, metadata, etc.).
      // Admins are exempt — local-inference setups legitimately do this.
      if (!endpointApproved(authn, baseUrl)) {
        return json(res, 400, { error: 'Provider origin is not approved for member connections; contact an administrator.' });
      }
      const id = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      PROVIDERS.push({ id, label, baseUrl, apiKey, defaultModel, shared });
      if (shared) saveSharedProviders(); else saveProviders();
      return json(res, 200, { id, label, baseUrl, defaultModel, apiKeyMasked: maskKey(apiKey) });
    }
    if (p === '/api/providers/test' && req.method === 'POST') {
      const body = await readJson(req);
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'valid baseUrl required' });
      // Same SSRF guard as registration: the test route must not become a
      // prober for internal addresses on behalf of a member.
      if (!endpointApproved(authn, baseUrl)) {
        return json(res, 400, { error: 'Provider origin is not approved for member connections; contact an administrator.' });
      }
      const headers = { 'Content-Type': 'application/json' };
      if (body.apiKey) headers.Authorization = `Bearer ${String(body.apiKey)}`;
      try {
        // redirect:'error' — same rationale as the storage client: a member-
        // registered endpoint must not bounce the request inward.
        const result = await fetchJson(`${baseUrl.replace(/\/v1$/, '')}/v1/models`, { headers, redirect: 'error' }, 8000);
        const models = Array.isArray(result.body?.data) ? result.body.data.map(m => m.id).filter(Boolean).slice(0, 100) : [];
        return json(res, result.ok ? 200 : 502, result.ok ? { ok: true, models } : { error: `provider returned ${result.status}` });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    const provDel = p.match(/^\/api\/providers\/([^/]+)$/);
    if (provDel && req.method === 'DELETE') {
      const id = decodeURIComponent(provDel[1]);
      if (id === DEFAULT_PROVIDER_ID || id === 'lemonade') return json(res, 400, { error: 'the default provider cannot be removed' });
      const selectedProvider = Array.from(PROVIDERS).find(p => p.id === id);
      if (selectedProvider?.shared && authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required' });
      if (!currentWorkspace().removeProvider(id)) return json(res, 404, { error: 'no such provider' });
      // Projects pointing at the removed provider fall back to the configured default.
      for (const pr of PROJECTS) {
        if (pr.provider === id) {
          delete pr.provider;
        }
      }
      saveProjects(PROJECTS);
      return json(res, 200, { ok: true });
    }
    return PASS;
  }

  return async function providerRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createProviderRoutes };
