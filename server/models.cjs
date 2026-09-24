'use strict';
// ── Models: what the engine serves, the auto-router roles, the manager service ──
// The model manager adapter itself is model-manager.cjs; this module is what
// index.cjs built on top of it: the installed list with its loaded state and
// the first loaded model as the non-hardcoded default, the role→model config
// (Fast/Smart/Vision/Code) with its optional warm-up, the model management
// service call and the cached folder scan the proxy route serves instantly.
//
// Everything is injected: env is read at call time (the service URL and token
// can be absent), modelManager is the adapter, currentWorkspace the tenant.

/**
 * @param {object} deps
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<{ok:boolean,status:number,body:any}>} deps.fetchJson
 * @param {object} deps.env                  process.env, read at call time
 * @param {object} deps.modelManager         model-manager.cjs adapter
 * @param {() => object} deps.currentWorkspace
 */
function createModelService({ fetchJson, env, modelManager, currentWorkspace }) {
  // One call to the model management service, with its token. Same path the proxy route uses.
  function managerFetch(rest, method = 'GET') {
    return fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/${rest}`,
      { method, headers: { 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) }, 120000).catch(() => null);
  }

  // Model files that appear in the models folder get safe defaults on their own (roadmap C3).
  // Needs the model management service; the engine's own preset file is edited through it.
  // Last model-folder scan, served instantly by the model-manager proxy (see there).
  const modelScanCache = new Map();
  let modelScanInflight = null;
  function refreshModelScan() {
    if (modelScanInflight || !env.MODEL_LOADER_URL) return;
    modelScanInflight = fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/models`, { method: 'GET', headers: { 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) } })
      .then((r) => { if (r?.ok && r.body && typeof r.body === 'object') modelScanCache.set('models', { at: Date.now(), body: r.body }); })
      .catch(() => undefined).finally(() => { modelScanInflight = null; });
  }

  // ── Optional model manager ─────────────────────────────────────────────────

  // The last model the manager reported as loaded — the non-hardcoded default for
  // projects that have not picked a model yet (replaces the old DEFAULT_MODEL
  // literal per feature doc Item 0 / step 9).
  let LAST_LOADED_MODEL = null;
  const lastLoadedModel = () => LAST_LOADED_MODEL;

  // ── Auto model router (feature doc Item 4 / master step 12) ───────────────
  // Roles are config, never hardcoded model names: role→model mapping lives in
  // ui/server/auto-roles.json (created on first use; never ships a default
  // model string). Native llama.cpp owns role-model loading and eviction.
  function autoRoles() {
    return currentWorkspace().autoRoles;
  }

  function setAutoRoles(next) {
    // `vision` and `code` are optional: a deployment with no vision-capable or
    // coding model should not be forced to name one, and an existing config
    // without them keeps working.
    const roles = { fast: String(next.fast), smart: String(next.smart) };
    if (next.vision) roles.vision = String(next.vision);
    if (next.code) roles.code = String(next.code);
    currentWorkspace().autoRoles = roles;
    currentWorkspace().saveAutoRoles();
  }

  async function ensureModelLoaded(name) {
    const installed = await modelsInstalled();
    const m = installed.find((x) => x.name === name);
    if (!m) throw new Error(`model not installed: ${name}`);
    if (!m.loaded) {
      const result = await modelManager.load(name);
      if (!result.ok) throw new Error(`model could not load: ${name}`);
    }
  }

  function ensureRolesLoaded() {
    // Native router owns on-demand loading and eviction (including models-max=1).
    if (modelManager.capabilities?.routing) return;
    const roles = autoRoles();
    if (!roles) return;
    void (async () => {
      for (const role of ['fast', 'smart', 'vision', 'code']) {
        if (!roles[role]) continue;
        try {
          await ensureModelLoaded(roles[role]);
        } catch (err) {
          console.warn(`[router] could not load ${role} model (${roles[role]}):`, err?.message || err);
        }
      }
    })();
  }

  // The served model list, or null when it cannot be read (never treat an outage as "nothing installed").
  async function servedCatalogue() {
    if (!modelManager.enabled) return null;
    try { return await modelsInstalled(); } catch { return null; }
  }

  async function modelsInstalled() {
    modelManager.requireEnabled();
    const [list, health] = await Promise.allSettled([
      modelManager.listModels(),
      modelManager.health(),
    ]);
    if (list.status !== 'fulfilled' || !list.value.ok) {
      throw new Error(`model list failed: ${list.status === 'fulfilled' ? list.value.status : 'unreachable'}`);
    }
    const loadedNames = new Set();
    if (health.status === 'fulfilled' && health.value.ok) {
      for (const m of health.value.body.all_models_loaded || []) {
        if (m.loaded && m.model_name) loadedNames.add(m.model_name);
      }
    }
    const installed = (list.value.body?.data || [])
      // Some managers register cosmetic hash-ID duplicates; hide bare hash names.
      .filter((m) => !/^[0-9a-f]{32,40}$/i.test(m.id || m.model_name || ''))
      .map((m) => ({
        name: m.id || m.model_name,
        sizeGB: typeof m.size === 'number' ? Math.round(m.size * 10) / 10 : null,
        loaded: loadedNames.has(m.id || m.model_name),
        labels: Array.isArray(m.labels) ? m.labels : [],
        mtp: require('./mtp.cjs').capability(m),
        maxContext: m.max_context_window || null,
        suggested: !!m.suggested,
        status: m.status?.value || (loadedNames.has(m.id || m.model_name) ? 'loaded' : 'unloaded'),
        failed: m.status?.failed === true,
        canDelete: m.can_remove !== false,
        source: m.source || null,
      }));
    if (!LAST_LOADED_MODEL) {
      const firstLoaded = installed.find((m) => m.loaded && !m.labels.some(label => /^(embedding|embeddings|rerank|reranking|reranker)$/i.test(label)));
      if (firstLoaded) LAST_LOADED_MODEL = firstLoaded.name;
    }
    return installed;
  }

  // Lemonade's /pull needs a namespaced model_name for any checkpoint it
  // doesn't already know about; derive one from the repo/variant the user
  // picked (variants() below always hands us `<repo>:<variant>` or a bare
  // repo). Lemonade requires the `user.` prefix to avoid colliding with its
  // built-in registry.
  function deriveUserModelName(checkpoint) {
    const [repo, variant] = String(checkpoint).split(':');
    const base = (repo.split('/').pop() || repo).replace(/[^A-Za-z0-9._-]/g, '-');
    const safeVariant = variant ? variant.replace(/[^A-Za-z0-9._-]/g, '-') : '';
    return `user.${base}${safeVariant ? `-${safeVariant}` : ''}`;
  }

  return {
    managerFetch, modelScanCache, refreshModelScan, lastLoadedModel,
    autoRoles, setAutoRoles, ensureModelLoaded, ensureRolesLoaded,
    servedCatalogue, modelsInstalled, deriveUserModelName,
  };
}

module.exports = { createModelService };
