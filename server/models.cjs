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
const { isSidecarModel, isSystemModel, modelPathFromArgs } = require('./model-system.cjs');

function createModelService({ fetchJson, env, modelManager, currentWorkspace, listWorkspaces }) {
  // One call to the model management service, with its token. Same path the proxy route uses.
  function managerFetch(rest, method = 'GET') {
    return fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/${rest}`,
      { method, headers: { 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) }, 120000).catch(() => null);
  }

  // Model files that appear in the models folder get safe defaults on their own (roadmap C3).
  // Needs the model management service; the engine's own preset file is edited through it.
  // Last model-folder scan, served instantly by the model-manager proxy (see there).
  // Every clear() starts a new generation. A scan that was requested before a clear (a delete,
  // a preset write...) and resolves after it describes files that may no longer exist, so its
  // result is discarded instead of resurrecting a deleted model in the cached list (#796).
  const modelScanCache = (() => {
    const entries = new Map();
    let generation = 0;
    return {
      get: (key) => entries.get(key),
      // `scanGeneration` is the generation read before the request was sent; omit it for a write
      // that has no request in flight.
      set(key, value, scanGeneration = generation) { if (scanGeneration === generation) entries.set(key, value); return this; },
      clear() { generation++; entries.clear(); },
      generation: () => generation,
    };
  })();
  let modelScanInflight = null;
  function refreshModelScan() {
    if (modelScanInflight || !env.MODEL_LOADER_URL) return;
    const generation = modelScanCache.generation();
    modelScanInflight = fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/models`, { method: 'GET', headers: { 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) } })
      .then((r) => { if (r?.ok && r.body && typeof r.body === 'object') modelScanCache.set('models', { at: Date.now(), body: r.body }, generation); })
      .catch(() => undefined).finally(() => { modelScanInflight = null; });
  }

  // ── Optional model manager ─────────────────────────────────────────────────

  // The last model the manager reported as loaded — the non-hardcoded default for
  // projects that have not picked a model yet (replaces the old DEFAULT_MODEL
  // literal per feature doc Item 0 / step 9).
  let LAST_LOADED_MODEL = null;
  const lastLoadedModel = () => LAST_LOADED_MODEL;
  // Called after a delete: a deleted model must never keep being handed out as the
  // no-model-selected default. Only clears it when it is still the same name (a load
  // that happened in between is left alone).
  function clearLastLoadedModel(name) {
    if (LAST_LOADED_MODEL === name) LAST_LOADED_MODEL = null;
  }

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

  // Deleting a model must not leave a role pointing at nothing that used to exist. `fast`/`smart`
  // fall back to whichever of the other required role's model is still configured (and not
  // itself the model being deleted); when there is no candidate left, or the role is the
  // optional vision/code, it becomes 'none' — an empty string, same as never having been set.
  // When BOTH required roles would end up empty, the whole config is unset (null) rather than
  // saved as { fast: '', smart: '' }: autoRoles() then reads as "not configured", which is what
  // sends the chat route down its existing `!roles` path ("pick Fast and Smart models first")
  // instead of trying to route to an empty model name.
  // Returns { cleared, roles } — `roles` is the value to persist (an object, or null to unset)
  // — or null when nothing in `roles` pointed at `name`.
  function clearedRoles(roles, name) {
    if (!roles) return null;
    const next = { ...roles };
    const cleared = [];
    for (const role of ['fast', 'smart', 'vision', 'code']) {
      if (next[role] !== name) continue;
      cleared.push(role);
      if (role === 'vision' || role === 'code') { delete next[role]; continue; }
      const fallback = role === 'fast' ? 'smart' : 'fast';
      next[role] = next[fallback] && next[fallback] !== name ? next[fallback] : '';
    }
    if (!cleared.length) return null;
    return { cleared, roles: next.fast === '' && next.smart === '' ? null : next };
  }

  // Called by the /api/models/delete and /api/model-manager/models/delete routes right after a
  // successful delete. Auto-roles are saved per workspace (workspace.cjs, auto-roles.json under
  // each user's data dir) — a role in ANY workspace can reference the deleted model, not just
  // whoever ran the delete — so every workspace `listWorkspaces` can see is checked and, if
  // affected, resaved through its own `saveAutoRoles()`. The return value is only the roles
  // cleared in the *current* (requesting) workspace: that is what the response body and the
  // client's status line describe; other workspaces are fixed silently, the same way a role
  // whose model vanished from under it already degraded silently before this existed.
  function clearRoleReferences(name) {
    const current = currentWorkspace();
    const currentResult = clearedRoles(current.autoRoles, name);
    if (currentResult) { current.autoRoles = currentResult.roles; current.saveAutoRoles(); }
    if (typeof listWorkspaces === 'function') {
      for (const ws of listWorkspaces()) {
        if (!ws || ws === current) continue;
        const result = clearedRoles(ws.autoRoles, name);
        if (!result) continue;
        ws.autoRoles = result.roles;
        ws.saveAutoRoles();
      }
    }
    return currentResult ? currentResult.cleared : [];
  }

  async function ensureModelLoaded(name) {
    const installed = await modelsInstalled();
    const m = installed.find((x) => x.name === name);
    if (!m) throw new Error(`model not installed: ${name}`);
    if (m.missingFile) throw new Error(`model file missing: ${name}`);
    if (m.servedElsewhere) throw new Error(`model runs in its own service: ${name}`);
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

  // #545: the folder scan's list of model files, or null when it cannot be trusted. The cached scan
  // is used when there is one (it is refreshed behind the proxy route); otherwise one bounded scan
  // is read. An unreadable scan, or an empty one (the manager also reports an unmounted models
  // volume as zero files), must never make every preset look missing.
  async function folderScanFiles() {
    let files = modelScanCache.get('models')?.body?.models;
    if (!Array.isArray(files) && env.MODEL_LOADER_URL) {
      const generation = modelScanCache.generation(); // a delete while this scan is in flight must win
      const fresh = await fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/models`, { method: 'GET', headers: { 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) } }, 8000).catch(() => null);
      if (fresh?.ok && fresh.body && typeof fresh.body === 'object') {
        modelScanCache.set('models', { at: Date.now(), body: fresh.body }, generation);
        files = fresh.body.models;
      }
    }
    return Array.isArray(files) && files.length ? files : null;
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
    // Only a router entry that comes from a models.ini preset has a file in the models folder;
    // download-cache models legitimately have none. Laya's preset points at a GGUF that only exists
    // inside its own sidecar; it is marked servedElsewhere (#1084) rather than missing.
    const rows = list.value.body?.data || [];
    // #580: the embedding (and reranking) sidecar is its own fixed llama-server, so the router's
    // status for its model ("unloaded") says nothing about it. The model manager probes each
    // backend; a sidecar model counts as loaded when some backend reports it as loaded.
    const sidecarLoaded = new Set();
    if (env.MODEL_LOADER_URL && rows.some((m) => isSidecarModel(m.id || m.model_name, env))) {
      const res = await fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/backends`, { method: 'GET', headers: { 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) } }, 4000).catch(() => null);
      for (const b of res?.ok && Array.isArray(res.body?.backends) ? res.body.backends : []) {
        if (b?.status !== 'running' || typeof b.loaded_model !== 'string') continue;
        for (const id of b.loaded_model.split(',').map((x) => x.trim()).filter(Boolean)) sidecarLoaded.add(id);
      }
    }
    const sidecarUp = (m) => isSidecarModel(m.id || m.model_name, env) && sidecarLoaded.has(m.id || m.model_name);
    const scan = rows.some((m) => m.source === 'preset') ? await folderScanFiles().catch(() => null) : null;
    // The loader's file for a row, joined by the section name or model id the scan reports (never by
    // guessing from file names). The router's /v1/models carries no size and meta only for the loaded
    // model, so the scan is where an unloaded model's size and shape come from.
    const fileFor = (id) => (scan ? scan.find((f) => f.modelId === id || (Array.isArray(f.sections) && f.sections.includes(id))) : undefined);
    const hasFile = (id) => !!fileFor(id);
    const noLocalFile = (m) => !!scan && m.source === 'preset' && !hasFile(m.id || m.model_name);
    // A sidecar model that a live backend reports as loaded is running, whatever the folder scan says.
    // A preset with no local file that belongs to a sidecar (Laya, or the configured embedding /
    // reranking model) is served by that service, so it is not a fault even when the sidecar is down.
    // Laya (the system routing model) never has a file the engine can load from the models folder, so
    // it reads as served elsewhere even when no folder scan could be read (loader slow or down): it must
    // never fall through to a plain "Unloaded" card with a Load button. Sidecar models need the scan,
    // since a configured embedding/reranking model may legitimately have a local file.
    const isSystem = (m) => isSystemModel(m.id || m.model_name, modelPathFromArgs(m.status?.args));
    const servedElsewhere = (m) => !sidecarUp(m) && m.source === 'preset'
      && ((isSystem(m) && (!scan || noLocalFile(m))) || (noLocalFile(m) && isSidecarModel(m.id || m.model_name, env)));
    const missingFile = (m) => !sidecarUp(m) && noLocalFile(m) && !servedElsewhere(m);
    // Decimal GB, as the router's own number is. The loader's byte count wins; the router's size is
    // the fallback for a row the scan does not cover.
    const sizeGBFor = (m) => {
      const bytes = fileFor(m.id || m.model_name)?.bytes;
      if (typeof bytes === 'number' && bytes > 0) return Math.round((bytes / 1e9) * 10) / 10;
      return typeof m.size === 'number' ? Math.round(m.size * 10) / 10 : null;
    };
    // #1079: a model's `<model>-long` profile is not a model of its own here: it rides on its model
    // as longVariant (the chat's Context: High), so roles and pickers keep naming the model.
    const longLoaded = new Set(rows.filter((m) => m.long_of && loadedNames.has(m.id)).map((m) => m.long_of));
    const installed = rows
      // Some managers register cosmetic hash-ID duplicates; hide bare hash names.
      .filter((m) => !/^[0-9a-f]{32,40}$/i.test(m.id || m.model_name || ''))
      .filter((m) => !m.long_of)
      .map((m) => ({
        ...(m.long_variant ? { longVariant: m.long_variant, longLoaded: longLoaded.has(m.id || m.model_name) } : {}),
        name: m.id || m.model_name,
        sizeGB: sizeGBFor(m),
        shape: fileFor(m.id || m.model_name)?.shape || null,
        loaded: loadedNames.has(m.id || m.model_name) || sidecarUp(m),
        labels: Array.isArray(m.labels) ? m.labels : [],
        mtp: require('./mtp.cjs').capability(m),
        maxContext: m.max_context_window || null,
        suggested: !!m.suggested,
        status: missingFile(m) ? 'missing' : servedElsewhere(m) ? 'served-elsewhere' : sidecarUp(m) ? 'loaded' : m.status?.value || (loadedNames.has(m.id || m.model_name) ? 'loaded' : 'unloaded'),
        failed: !sidecarUp(m) && (m.status?.failed === true || missingFile(m)),
        // #545: a preset whose GGUF is not in the models folder. Never offered for chat, loading or tuning.
        missingFile: missingFile(m),
        // A preset with no file here because its own service (Laya, an embedding/reranking sidecar) runs it.
        servedElsewhere: servedElsewhere(m),
        canDelete: m.can_remove !== false,
        // #336: distinct from canDelete (which the client falls back to a different delete path
        // for, when false — see routes/models.cjs). A model can_remove reports removable is still
        // the one EMBEDDING_MODEL/RERANK_MODEL names, and deleting that file crash-loops its
        // sidecar with nothing to fall back to; sidecarProtected is the client's own signal to
        // hide Delete entirely rather than trying the fallback path.
        sidecarProtected: isSidecarModel(m.id || m.model_name, env),
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
    managerFetch, modelScanCache, refreshModelScan, lastLoadedModel, clearLastLoadedModel,
    autoRoles, setAutoRoles, clearRoleReferences, ensureModelLoaded, ensureRolesLoaded,
    servedCatalogue, modelsInstalled, deriveUserModelName,
  };
}

module.exports = { createModelService };
