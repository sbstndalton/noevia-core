'use strict';

function createModelManager({ kind, baseUrl, apiKey, fetchJson, presetPath, downloadStatePath, fetchStream, autoconfig, calibrationStatePath, calibrationOptions, publicCalibrator, evidenceDir, autotuneStatePath, autotuneOptions, presetWriter, inferenceBudget = null, reloadStatePath = null, presetBaselineClient = null, gateAdminToken = null, gate = null, budgetWatchDir = null }) {
  const normalizedKind = String(kind || 'none').toLowerCase();
  if (normalizedKind === 'llamacpp') return require('./llamacpp-manager.cjs').createLlamaCppManager({ baseUrl, apiKey, fetchJson, presetPath, downloadStatePath, fetchStream, autoconfig, calibrationStatePath, calibrationOptions, publicCalibrator, evidenceDir, autotuneStatePath, autotuneOptions, presetWriter, inferenceBudget, reloadStatePath, presetBaselineClient, gateAdminToken, gate, budgetWatchDir });
  const enabled = normalizedKind === 'lemonade';
  if (!enabled && normalizedKind !== 'none') {
    throw new Error(`unsupported MODEL_MANAGER_KIND: ${normalizedKind}`);
  }
  const base = String(baseUrl || '').replace(/\/+$/, '');
  function headers(extra) {
    const value = { 'Content-Type': 'application/json', ...(extra || {}) };
    if (apiKey && apiKey !== 'local') value.Authorization = `Bearer ${apiKey}`;
    return value;
  }
  function requireEnabled() {
    if (!enabled) throw new Error('model management is disabled; configure MODEL_MANAGER_KIND to enable it');
  }
  async function request(path, options, timeout) {
    requireEnabled();
    return fetchJson(`${base}${path}`, { ...(options || {}), headers: headers(options?.headers) }, timeout);
  }
  const get = (path, timeout) => request(path, {}, timeout);
  const post = (path, body, timeout) => request(path, { method: 'POST', body: JSON.stringify(body) }, timeout);
  return {
    kind: normalizedKind,
    enabled,
    capabilities: { routing: false, load: enabled, unload: enabled, download: enabled, deleteCached: enabled, runtimeOptions: enabled, hardware: enabled, presets: false },
    baseUrl: base,
    headers,
    requireEnabled,
    request,
    listModels: () => get('/api/v1/models', 8000),
    health: () => get('/api/v1/health', 8000),
    stats: () => get('/v1/stats', 6000),
    systemStats: () => get('/v1/system-stats', 6000),
    variants: (checkpoint) => get(`/api/v1/pull/variants?checkpoint=${encodeURIComponent(checkpoint)}`, 20000),
    load: (modelName, options = {}) => post('/api/v1/load', { ...options, model_name: modelName }, 120000),
    metrics: () => get('/metrics', 6000),
    unload: (modelName) => post('/api/v1/unload', { model_name: modelName }, 120000),
    downloads: () => get('/api/v1/downloads', 8000),
  };
}

module.exports = { createModelManager };
