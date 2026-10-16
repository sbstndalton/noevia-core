'use strict';
// #1856/#1894: what Settings → Inference machines asks of "This machine"'s own inference engine.
// With a model loader: its /api/v1/health (30 ms, same token header). Its /api/v1/models enumerates and probes the
// models and takes seconds, longer than the health-probe deadline, so it must not be the liveness check.
// Without a loader: the default provider's /v1/models (its key) is the only thing to ask.

function localEngineTarget({ env = process.env, getProvider, providerHeaders, defaultProviderId }) {
  const loader = String(env.MODEL_LOADER_URL || '').trim();
  if (loader) {
    try {
      const u = new URL(loader);
      return { url: u.origin, path: `${u.pathname.replace(/\/+$/, '')}/api/v1/health`, headers: env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : null };
    } catch { return null; }
  }
  const p = getProvider(defaultProviderId);
  if (!p?.baseUrl) return null;
  try {
    const u = new URL(String(p.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, ''));
    const h = providerHeaders(p);
    const auth = h?.Authorization ? { Authorization: h.Authorization } : null;
    return { url: u.origin, path: `${u.pathname.replace(/\/+$/, '')}/v1/models`, headers: auth };
  } catch { return null; }
}

module.exports = { localEngineTarget };
