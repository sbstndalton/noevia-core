'use strict';
// The provider registry's HTTP surface (providers.cjs holds the registry):
//   GET    /api/providers        list, with keys masked
//   POST   /api/providers        connect one (shared rows are admin-only)
//   POST   /api/providers/test   probe an endpoint's /v1/models before saving it
//   DELETE /api/providers/:id    remove one; projects on it fall back to the default
//
// Sign in with ChatGPT (#447, chatgpt-oauth.cjs), only while features.chatgptOAuth is on (404 off):
//   GET    /api/providers/chatgpt              this account's connection: state + masked account
//   POST   /api/providers/chatgpt/device       start a device-code sign-in -> { loginId, userCode, verificationUrl }
//   POST   /api/providers/chatgpt/device/poll  { loginId } -> pending | connected | expired
//   POST   /api/providers/chatgpt/device/cancel { loginId }
//   GET    /api/providers/chatgpt/models       the account's model ids
//   DELETE /api/providers/chatgpt              disconnect: tokens deleted, the provider row removed
// A connection is always the signed-in account's own private provider, never shared.
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
 * @param {object|null} [deps.chatgptOAuth]   chatgpt-oauth.cjs; null leaves Sign in with ChatGPT out entirely
 * @param {() => boolean} [deps.chatgptEnabled]   features.enabled('chatgptOAuth')
 */
function createProviderRoutes({ json, readBody, readJson, fetchJson, endpointApproved, PROVIDERS, PROJECTS, DEFAULT_PROVIDER_ID, modelManager, currentWorkspace, saveProjects, registry, chatgptOAuth = null, chatgptEnabled = () => false }) {
  const { saveProviders, saveSharedProviders, maskKey } = registry;
  const chatgpt = require('../chatgpt-oauth.cjs');
  const chatgptOn = () => !!chatgptOAuth && chatgptEnabled();

  // The provider row that points this account's chats at its ChatGPT connection (no credential in it).
  function ensureChatGptRow() {
    if (Array.from(PROVIDERS).some((pr) => pr.id === chatgpt.PROVIDER_ID && !pr.shared)) return;
    PROVIDERS.push(chatgpt.providerRow());
    saveProviders();
  }
  function removeChatGptRow() {
    const row = Array.from(PROVIDERS).find((pr) => pr.id === chatgpt.PROVIDER_ID);
    if (row && !row.shared) currentWorkspace().removeProvider(chatgpt.PROVIDER_ID);
    let changed = false;
    for (const pr of PROJECTS) if (pr.provider === chatgpt.PROVIDER_ID) { delete pr.provider; changed = true; }
    if (changed) saveProjects(PROJECTS);
  }

  async function handleChatGpt(req, res, p, authn) {
    if (!chatgptOn()) return json(res, 404, { error: 'Sign in with ChatGPT is turned off on this server.' });
    const userId = authn?.user?.id;
    if (!userId) return json(res, 401, { error: 'Sign in to noevia first.' });
    try {
      if (p === '/api/providers/chatgpt' && req.method === 'GET') {
        return json(res, 200, { ...chatgptOAuth.status(userId), providerId: chatgpt.PROVIDER_ID, external: true });
      }
      if (p === '/api/providers/chatgpt' && req.method === 'DELETE') {
        chatgptOAuth.disconnect(userId);
        removeChatGptRow();
        return json(res, 200, { ok: true, state: 'disconnected' });
      }
      if (p === '/api/providers/chatgpt/device' && req.method === 'POST') {
        return json(res, 200, await chatgptOAuth.startDeviceLogin(userId));
      }
      if (p === '/api/providers/chatgpt/device/poll' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const result = await chatgptOAuth.pollDeviceLogin(userId, String(body?.loginId || ''));
        if (result.state === 'connected') ensureChatGptRow();
        return json(res, 200, result);
      }
      if (p === '/api/providers/chatgpt/device/cancel' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        return json(res, 200, { ok: chatgptOAuth.cancelDeviceLogin(userId, String(body?.loginId || '')) });
      }
      if (p === '/api/providers/chatgpt/models' && req.method === 'GET') {
        return json(res, 200, { models: await chatgptOAuth.listModels(userId) });
      }
    } catch (e) {
      // Messages from chatgpt-oauth.cjs are written for people and carry no credential.
      return json(res, e.status && e.status < 600 ? e.status : 502, { error: e.status ? e.message : 'ChatGPT sign-in failed.' });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  async function handle(req, res, { path: p, authn }) {
    if (p === '/api/providers/chatgpt' || p.startsWith('/api/providers/chatgpt/')) return handleChatGpt(req, res, p, authn);
    // ── Provider registry (step 9): list / connect / remove. GET never returns
    // a saved apiKey in plaintext — masked, e.g. sk-…last4.
    if (p === '/api/providers' && req.method === 'GET') {
      // A ChatGPT row is listed only while the flag is on, with its connection state instead of a key.
      const listed = Array.from(PROVIDERS).filter((pr) => !chatgpt.isChatGptProvider(pr) || (chatgptOn() && !pr.shared));
      return json(res, 200, {
        providers: listed.map((pr) => ({
          id: pr.id,
          label: pr.label,
          baseUrl: pr.baseUrl,
          apiKeyMasked: maskKey(pr.apiKey),
          isDefault: pr.id === DEFAULT_PROVIDER_ID,
          managed: pr.id === DEFAULT_PROVIDER_ID && modelManager.enabled,
          shared: !!pr.shared,
          defaultModel: pr.defaultModel || undefined,
          ...(chatgpt.isChatGptProvider(pr) ? { kind: chatgpt.KIND, external: true, connection: chatgptOAuth.status(authn?.user?.id).state } : {}),
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
      // Removing the ChatGPT row is disconnecting: its tokens go too, flag on or off.
      if (chatgpt.isChatGptProvider(selectedProvider) && !selectedProvider.shared && chatgptOAuth && authn?.user?.id) chatgptOAuth.disconnect(authn.user.id);
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
