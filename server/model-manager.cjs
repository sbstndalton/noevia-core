'use strict';

function createModelManager({ kind, baseUrl, apiKey, fetchJson }) {
  const normalizedKind = String(kind || 'none').toLowerCase();
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
    if (!enabled) throw new Error('model management is disabled; set MODEL_MANAGER_KIND=lemonade to enable it');
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
    baseUrl: base,
    headers,
    requireEnabled,
    request,
    listModels: () => get('/api/v1/models', 8000),
    health: () => get('/api/v1/health', 8000),
    stats: () => get('/v1/stats', 6000),
    systemStats: () => get('/v1/system-stats', 6000),
    variants: (checkpoint) => get(`/api/v1/pull/variants?checkpoint=${encodeURIComponent(checkpoint)}`, 20000),
    pull: (checkpoint) => post('/api/v1/pull', { checkpoint }, 600000),
    deleteModel: (modelName) => post('/api/v1/delete', { model_name: modelName }, 60000),
    load: (modelName) => post('/api/v1/load', { model_name: modelName }, 120000),
    unload: (modelName) => post('/api/v1/unload', { model_name: modelName }, 120000),
    downloads: () => get('/api/v1/downloads', 8000),
  };
}

module.exports = { createModelManager };
