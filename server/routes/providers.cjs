'use strict';
// The provider registry's HTTP surface (providers.cjs holds the registry):
//   GET    /api/providers        list, with keys masked
//   POST   /api/providers        connect one (shared rows are admin-only)
//   POST   /api/providers/test   probe an endpoint's /v1/models before saving it
//   PUT    /api/providers/:id    edit one in place (#535); projects on it keep their provider/model
//   DELETE /api/providers/:id    remove one; projects on it fall back to the default
//   GET    /api/providers/:id/models[?refresh=1]  that provider's model ids (#1009), fetched with
//                                the stored credential and cached per account for MODEL_LIST_TTL_MS
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
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const MODEL_LIST_MAX = 200;
const MODEL_REFRESH_GAP_MS = 10 * 1000;

/** The model ids in an OpenAI-compatible /v1/models answer (untrusted remote JSON). */
function modelIdsFrom(body, max = MODEL_LIST_MAX) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const ids = [];
  for (const m of rows) {
    const id = m && typeof m.id === 'string' ? m.id.trim() : '';
    if (id && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id) && !ids.includes(id)) ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}

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
function createProviderRoutes({ json, readBody, readJson, fetchJson, endpointApproved, PROVIDERS, PROJECTS, DEFAULT_PROVIDER_ID, modelManager, currentWorkspace, saveProjects, registry, chatgptOAuth = null, chatgptEnabled = () => false, now = () => Date.now() }) {
  const { saveProviders, saveSharedProviders, maskKey } = registry;
  const { parseContextTokens, validContextTokens, parseCapabilities, effectiveCapabilities } = require('../providers.cjs');
  const chatgpt = require('../chatgpt-oauth.cjs');
  const egress = require('../provider-egress.cjs');
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
    for (const pr of PROJECTS) if (pr.provider === chatgpt.PROVIDER_ID) {
      delete pr.provider;
      delete pr.model;
      changed = true;
    }
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

  // #1009: a stored provider's model list for the routing pickers. Keyed by account, provider id and
  // the address and key it was fetched with, so an edit or another account never reads a stale or
  // foreign list. The key is used server-side only and never returned.
  const modelLists = new Map();
  const inflight = new Map();
  const lastRefresh = new Map();
  async function providerModels(req, res, id, authn, url) {
    const userId = authn?.user?.id;
    if (!userId) return json(res, 401, { error: 'Sign in first.' });
    if (id === DEFAULT_PROVIDER_ID || id === 'lemonade') return json(res, 400, { error: 'the default provider lists its models under Settings → Models' });
    const row = Array.from(PROVIDERS).find((pr) => pr.id === id);
    if (!row) return json(res, 404, { error: 'no such provider' });
    const refresh = url?.searchParams?.get('refresh') === '1';
    if (chatgpt.isChatGptProvider(row)) {
      if (!chatgptOn() || row.shared) return json(res, 404, { error: 'Sign in with ChatGPT is turned off on this server.' });
      try { return json(res, 200, { models: await chatgptOAuth.listModels(userId), cached: false }); }
      catch (e) { return json(res, 502, { error: e.status ? e.message : 'ChatGPT did not list its models.' }); }
    }
    if (!/^https?:\/\//.test(String(row.baseUrl || ''))) return json(res, 400, { error: 'this provider has no address' });
    // A member's own row passed this guard when it was saved; checking again keeps a later policy
    // change in force. Shared rows are an administrator's and are used for chat as they are.
    if (!row.shared && !endpointApproved(authn, row.baseUrl)) return json(res, 400, { error: 'Provider origin is not approved for member connections; contact an administrator.' });
    const key = JSON.stringify([userId, row.id, row.baseUrl, hasRealKey(row.apiKey) ? row.apiKey : '']);
    const owner = JSON.stringify([userId, row.id]);
    const hit = modelLists.get(key);
    // A refresh within MODEL_REFRESH_GAP_MS of the last one for this account and provider is served
    // from the cache, so a held-down Refresh button cannot hammer the provider with the stored key.
    const throttled = refresh && hit && now() - (lastRefresh.get(owner) || 0) < MODEL_REFRESH_GAP_MS;
    if ((!refresh || throttled) && hit && hit.until > now()) return json(res, 200, { models: hit.models, cached: true, fetchedAt: hit.fetchedAt, ...(throttled ? { throttled: true } : {}) });
    if (refresh) lastRefresh.set(owner, now());
    // Concurrent requests for the same list share one upstream fetch.
    let pending = inflight.get(key);
    if (!pending) {
      const headers = { 'Content-Type': 'application/json' };
      if (hasRealKey(row.apiKey)) headers.Authorization = `Bearer ${row.apiKey}`;
      pending = (async () => {
        const result = await fetchJson(`${row.baseUrl.replace(/\/v1$/, '')}/v1/models`, { headers, redirect: 'error' }, 8000);
        if (!result.ok) return { status: result.status };
        const models = modelIdsFrom(result.body);
        const fetchedAt = now();
        for (const k of modelLists.keys()) { const [u, id] = JSON.parse(k); if (u === userId && id === row.id) modelLists.delete(k); }
        modelLists.set(key, { models, until: fetchedAt + MODEL_LIST_TTL_MS, fetchedAt });
        while (modelLists.size > 500) modelLists.delete(modelLists.keys().next().value);
        while (lastRefresh.size > 500) lastRefresh.delete(lastRefresh.keys().next().value);
        return { models, fetchedAt };
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      const out = await pending;
      if (out.status) return json(res, 502, { error: `provider returned ${out.status}` });
      return json(res, 200, { models: out.models, cached: false, fetchedAt: out.fetchedAt });
    } catch { return json(res, 502, { error: 'The provider could not be reached.' }); }
  }

  // One provider as the client sees it: never the plaintext key.
  function listRow(pr, authn) {
    const contextTokens = validContextTokens(pr.contextTokens);
    const capabilities = effectiveCapabilities(pr);
    return {
      id: pr.id,
      label: pr.label,
      baseUrl: pr.baseUrl,
      apiKeyMasked: maskKey(pr.apiKey),
      isDefault: pr.id === DEFAULT_PROVIDER_ID,
      managed: pr.id === DEFAULT_PROVIDER_ID && modelManager.enabled,
      shared: !!pr.shared,
      defaultModel: pr.defaultModel || undefined,
      ...(contextTokens ? { contextTokens } : {}),
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      // The stored key could not be decrypted on this server (#782): it needs entering again.
      ...(pr.keyUnreadable ? { keyUnreadable: true } : {}),
      ...(egress.isTrialTermsHost(pr) ? { external: true } : {}),
      ...(chatgpt.isChatGptProvider(pr) ? { kind: chatgpt.KIND, external: true, connection: chatgptOAuth.status(authn?.user?.id).state } : {}),
    };
  }

  // scheme://host:port of a URL, or null. A stored key may follow a path change, never an origin change.
  function originOf(url) {
    try { return new URL(url).origin; } catch { return null; }
  }
  const hasRealKey = (key) => !!key && key !== 'local';

  // The rows PUT may not touch: the default (and its legacy alias), and rows a sign-in owns or
  // the server flagged external (their address and credential are not the person's to set).
  function editRefusal(id, row, authn) {
    if (id === DEFAULT_PROVIDER_ID || id === 'lemonade') return [400, 'the default provider cannot be edited'];
    if (!row) return [404, 'no such provider'];
    if (chatgpt.isChatGptProvider(row) || row.external === true) return [400, 'this provider is managed by its sign-in and cannot be edited'];
    if (row.shared && authn?.user?.role !== 'admin') return [403, 'administrator required'];
    return null;
  }

  async function handle(req, res, { path: p, authn, url }) {
    const listMatch = p.match(/^\/api\/providers\/([^/]+)\/models$/);
    if (listMatch && listMatch[1] !== 'chatgpt') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      let id;
      try { id = decodeURIComponent(listMatch[1]); } catch { return json(res, 400, { error: 'no such provider' }); }
      return providerModels(req, res, id, authn, url);
    }
    if (p === '/api/providers/chatgpt' || p.startsWith('/api/providers/chatgpt/')) return handleChatGpt(req, res, p, authn);
    // ── Provider registry (step 9): list / connect / remove. GET never returns
    // a saved apiKey in plaintext — masked, e.g. sk-…last4.
    if (p === '/api/providers' && req.method === 'GET') {
      // A ChatGPT row is listed only while the flag is on, with its connection state instead of a key.
      const listed = Array.from(PROVIDERS).filter((pr) => !chatgpt.isChatGptProvider(pr) || (chatgptOn() && !pr.shared));
      return json(res, 200, { providers: listed.map((pr) => listRow(pr, authn)) });
    }
    if (p === '/api/providers' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!require('../http.cjs').isJsonObject(body)) return json(res, 400, { error: 'request body must be a JSON object' });
      const label = String(body.label || '').trim().slice(0, 80);
      let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      const apiKey = String(body.apiKey || '').trim();
      const defaultModel = String(body.defaultModel || '').trim().slice(0, 200);
      const shared = body.shared === true;
      if (shared && authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required for shared providers' });
      if (!label) return json(res, 400, { error: 'label required' });
      const context = parseContextTokens(body.contextTokens);
      if (context.error) return json(res, 400, { error: context.error });
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
      // SSRF guard: a member must not register an endpoint the server can
      // only reach from its own internal network (RFC1918, metadata, etc.).
      // Admins are exempt — local-inference setups legitimately do this.
      if (!endpointApproved(authn, baseUrl)) {
        return json(res, 400, { error: 'Provider origin is not approved for member connections; contact an administrator.' });
      }
      let capabilities;
      if (body.capabilities !== undefined && body.capabilities !== null) {
        const parsed = parseCapabilities(body.capabilities);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        capabilities = parsed.value;
      }
      const id = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      PROVIDERS.push({ id, label, baseUrl, apiKey, defaultModel, shared, ...(context.value ? { contextTokens: context.value } : {}), ...(capabilities ? { capabilities } : {}) });
      if (shared) saveSharedProviders(id); else saveProviders();
      return json(res, 200, { id, label, baseUrl, defaultModel, apiKeyMasked: maskKey(apiKey), ...(context.value ? { contextTokens: context.value } : {}) });
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
      let probeKey = String(body.apiKey || '');
      // Editing (#535): with no key typed, an existing provider's stored key may be used, but only
      // by someone allowed to edit that row and only against the same origin it is stored for.
      if (!probeKey && typeof body.providerId === 'string' && body.providerId) {
        const row = Array.from(PROVIDERS).find((pr) => pr.id === body.providerId);
        if (row && !editRefusal(body.providerId, row, authn) && hasRealKey(row.apiKey) && originOf(baseUrl) !== null && originOf(row.baseUrl) === originOf(baseUrl)) probeKey = row.apiKey;
      }
      if (probeKey) headers.Authorization = `Bearer ${probeKey}`;
      try {
        // redirect:'error' — same rationale as the storage client: a member-
        // registered endpoint must not bounce the request inward.
        const result = await fetchJson(`${baseUrl.replace(/\/v1$/, '')}/v1/models`, { headers, redirect: 'error' }, 8000);
        const models = modelIdsFrom(result.body, 100);
        return json(res, result.ok ? 200 : 502, result.ok ? { ok: true, models } : { error: `provider returned ${result.status}` });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    const provDel = p.match(/^\/api\/providers\/([^/]+)$/);
    if (provDel && req.method === 'PUT') {
      const id = decodeURIComponent(provDel[1]);
      const row = Array.from(PROVIDERS).find((pr) => pr.id === id);
      const refused = editRefusal(id, row, authn);
      if (refused) return json(res, refused[0], { error: refused[1] });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid JSON' });
      for (const field of ['label', 'baseUrl', 'apiKey', 'defaultModel']) {
        if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') return json(res, 400, { error: `${field} must be a string` });
      }
      const label = body.label === undefined ? row.label : String(body.label || '').trim().slice(0, 80);
      const baseUrl = body.baseUrl === undefined ? row.baseUrl : String(body.baseUrl || '').trim().replace(/\/+$/, '');
      const newKey = String(body.apiKey || '').trim();
      const defaultModel = body.defaultModel === undefined ? (row.defaultModel || '') : String(body.defaultModel || '').trim().slice(0, 200);
      if (!label) return json(res, 400, { error: 'label required' });
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
      // Same SSRF guard as POST whenever the address changes.
      if (baseUrl !== row.baseUrl && !endpointApproved(authn, baseUrl)) {
        return json(res, 400, { error: 'Provider origin is not approved for member connections; contact an administrator.' });
      }
      // A stored key never follows the provider to another origin: that would send it somewhere
      // the person never typed it for (and read it back out through a host they control).
      if (!newKey && hasRealKey(row.apiKey) && (originOf(baseUrl) === null || originOf(baseUrl) !== originOf(row.baseUrl))) {
        return json(res, 400, { error: 'Enter the API key again when moving a provider to a different address.' });
      }
      // Omitted keeps the stored value; null or '' clears it.
      const context = body.contextTokens === undefined ? { value: validContextTokens(row.contextTokens) } : parseContextTokens(body.contextTokens);
      if (context.error) return json(res, 400, { error: context.error });
      // Omitted keeps the stored capabilities; null returns to the preset default; an object replaces them.
      let capabilities = row.capabilities;
      if (body.capabilities === null) capabilities = undefined;
      else if (body.capabilities !== undefined) {
        const parsed = parseCapabilities(body.capabilities);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        capabilities = parsed.value;
      }
      // Validated in full before anything changes, so a refusal leaves the row as it was.
      // A key that could not be decrypted (#782) is kept for its own origin only: moving the row
      // elsewhere without a new key forgets it, so the old ciphertext never follows the address.
      if (!newKey && row.keyUnreadable && originOf(baseUrl) !== originOf(row.baseUrl)) delete row.keyUnreadable;
      row.label = label;
      row.baseUrl = baseUrl;
      if (newKey) { row.apiKey = newKey; delete row.keyUnreadable; }
      row.defaultModel = defaultModel;
      if (context.value) row.contextTokens = context.value; else delete row.contextTokens;
      if (capabilities) row.capabilities = capabilities; else delete row.capabilities;
      if (row.shared) saveSharedProviders(row.id); else saveProviders();
      return json(res, 200, listRow(row, authn));
    }
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
          delete pr.model;
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

module.exports = { createProviderRoutes, modelIdsFrom, MODEL_LIST_TTL_MS, MODEL_REFRESH_GAP_MS };
