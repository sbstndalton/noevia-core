'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const RERANKER_SETTINGS_OWNER = 'reranker-settings-v1';
const context = new AsyncLocalStorage();
const unavailable = () => Object.assign(Error('Reranker settings are unavailable.'), {
  status: 503, code: 'RERANKER_SETTINGS_UNAVAILABLE',
});

// The native owner supplies a fresh snapshot before an operation starts. AsyncLocalStorage
// keeps synchronous model-protection helpers on that operation's snapshot across its awaits.
// A helper outside a verified operation refuses; there is no last-good or deployment fallback.
function createClient({ env = process.env, fetchImpl = globalThis.fetch, onChange = () => {} } = {}) {
  let fingerprint = null;
  async function read(installed = null) {
    const port = Number(env.NOEVIA_PROJECT_STORE_PORT);
    const token = env.NOEVIA_PROJECT_STORE_TOKEN;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 32) throw unavailable();
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/reranker/settings`, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-noevia-store-token': token },
        body: JSON.stringify({ installed }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw unavailable();
      const value = await require('./http.cjs').readCappedJson(response, 8 * 1024 * 1024);
      if (!value || !value.env || typeof value.env !== 'object' || Array.isArray(value.env)
        || Object.values(value.env).some(v => typeof v !== 'string') || !value.view
        || typeof value.revision !== 'string' || !/^[a-f0-9]{32}:\d+$/.test(value.revision)
        || typeof value.view.enabled !== 'boolean' || !Array.isArray(value.view.options)) throw unavailable();
      const next = require('node:crypto').createHash('sha256')
        .update(JSON.stringify([value.revision, value.env, value.view.choice, value.view.source])).digest('hex');
      if (next !== fingerprint) { onChange(); fingerprint = next; }
      return value;
    } catch { throw unavailable(); }
  }
  return {
    read,
    async run(fn) { return context.run(await read(), fn); },
    effectiveEnv() {
      const value = context.getStore();
      if (!value) throw unavailable();
      return value.env;
    },
    async get(installed) { return (await read(installed)).view; },
  };
}
let installed = null;
function install(settings) { installed = settings; return settings; }
function current() { return installed; }
function withSettings(fn) { return installed?.run ? installed.run(fn) : fn(); }
module.exports = { RERANKER_SETTINGS_OWNER, createClient, install, current, withSettings };
