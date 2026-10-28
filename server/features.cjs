'use strict';
// One registry for optional capabilities (master-prompt § Decisions). Every feature is off
// unless an operator env var or an admin setting turns it on. An env var, when set, is
// authoritative and locks the admin toggle, so a deployment can pin a feature either way.
// Values are read once at creation and cached; admin changes update the cache. Features marked
// `restart` are wired into tool catalogues at startup: a change is saved and reported as pending,
// and enabled() keeps answering with the value the running server actually uses.

/**
 * Why Browser mode cannot run on this server, or null when it can (issue #550). `playwright` is an
 * operator-installed dependency (index.cjs launches it lazily), and it also needs a downloaded
 * Chromium. Probed at runtime so an image that adds both becomes usable without a code change.
 * Injectable for tests.
 */
function browserRuntimeReason({ resolve = require.resolve, load = require, exists = require('node:fs').existsSync } = {}) {
  try { resolve('playwright'); }
  catch { return 'Needs Playwright installed on this server; it is not in this image.'; }
  try {
    const executable = load('playwright').chromium.executablePath();
    if (executable && exists(executable)) return null;
  } catch { /* fall through to the same message */ }
  return 'Needs a Chromium browser installed for Playwright on this server.';
}

/** Why the Code pipeline cannot run here, or null: it needs the code sandbox (#705). */
function codeSandboxReason(env = process.env) {
  return String(env.CODE_HARNESS_ENDPOINT || '').trim() ? null : 'Needs Code mode running in the code sandbox (CODE_HARNESS_ENDPOINT).';
}

// Static metadata is generated from the canonical Rust contract. Runtime
// availability remains with the services that own those facts.
const FEATURE_CATALOG = require('./feature-catalog.cjs').loadCatalog();
const UNAVAILABLE = Object.freeze({
  stepSupervision: env => require('./decision-endpoint.cjs').configuration(env).reason,
  systemOneRouting: env => require('./system-one-router.cjs').configuration(env).reason,
  toolGate: env => require('./decision-endpoint.cjs').configuration(env).reason,
  browserExecutor: () => browserRuntimeReason(),
  codePipeline: env => codeSandboxReason(env),
  codeMerge: env => codeSandboxReason(env),
  chatFraming: env => require('./decision-endpoint.cjs').configuration(env).reason,
  framingReasoner: env => require('./decision-endpoint.cjs').configuration(env).reason,
  nativeClientAuth: env => (env.TRUST_PROXY === 'true' ? null : 'Needs TRUST_PROXY on so sign-in limits can tell clients apart.'),
});
const REGISTRY = Object.freeze(Object.fromEntries(FEATURE_CATALOG.features.map((row) => {
  const { id, env, experimental, restart, legacy, label, description, availability } = row;
  const unavailable = UNAVAILABLE[id];
  if ((availability === 'none') === !!unavailable) {
    throw new Error(`Generated feature availability does not match runtime: ${id}`);
  }
  const spec = { env };
  if (row.default === true) spec.default = true;
  if (experimental) spec.experimental = true;
  if (restart) spec.restart = true;
  if (legacy) spec.legacy = { name: legacy };
  spec.label = label;
  spec.description = description;
  if (unavailable) spec.unavailable = unavailable;
  return [id, spec];
})));


/**
 * Stable ids for the reasons a feature can be unavailable, so the client can translate them (#618).
 * The reason text stays English on the wire as the fallback; anything not matched has no id.
 */
function unavailableId(name, reason) {
  if (!reason) return null;
  if (name === 'browserExecutor') return /Playwright installed/.test(reason) ? 'browserPlaywright' : /Chromium/.test(reason) ? 'browserChromium' : null;
  if (name === 'constrainedPlanDecoding') return /Not used yet/.test(reason) ? 'notUsed' : null;
  if (name === 'nativeClientAuth') return /TRUST_PROXY/.test(reason) ? 'trustProxy' : null;
  if (name === 'codePipeline' || name === 'codeMerge') return /CODE_HARNESS_ENDPOINT/.test(reason) ? 'codeSandbox' : null;
  // The decision-service experiments (#624): unset URL, not yet set up in Settings, or System-One's own URL.
  if (name === 'stepSupervision' || name === 'toolGate' || name === 'systemOneRouting') {
    // #1489/#1499: the reasons no longer name the COWORK_* variables, so they are matched by their words.
    if (/^Connect a private decision service\b/.test(reason)) return 'decisionUrl';
    if (/Set up the decision service/.test(reason)) return 'decisionSetup';
    if (/does not support choice decisions/.test(reason)) return 'decisionUnsupported';
    if (/dedicated local decision-model endpoint/.test(reason)) return 'systemOneUrl';
  }
  return null;
}

const SETTING_PREFIX = 'feature:';

// sbstndalton/noevia#1071: the ChatGPT status GET, the connected-storage metadata GET and the
// storage list/read belong to the Rust front permanently. Node refuses them unconditionally with
// these bodies (routes/providers.cjs, routes/storage.cjs, refuseRustStorageRead below).
const RUST_STORAGE_BROWSE_REFUSAL = Object.freeze({
  error: 'Storage browsing is owned by the Rust front.',
  code: 'RUST_STORAGE_BROWSE_OWNED',
});

const RUST_CHATGPT_STATUS_REFUSAL = Object.freeze({
  error: 'ChatGPT status is owned by the Rust front.',
  code: 'RUST_CHATGPT_STATUS_OWNED',
});

const RUST_STORAGE_READS_REFUSAL = Object.freeze({
  error: 'Storage metadata reads are owned by the Rust front.',
  code: 'RUST_STORAGE_READS_OWNED',
});

// Called before request authentication or workspace construction. Other requests keep their
// original parse/order; the exact GET (the Rust front's) cannot reach Node's reseal.
function refuseRustStorageRead(req, res, { parseRequestUrl, badRequestUrl, json }) {
  if (req.method !== 'GET') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url) {
    badRequestUrl(res);
    return true;
  }
  if (url.pathname !== '/api/integrations/storage') return false;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  // #1480: HSTS for six months, no includeSubDomains (nothing else on this host is known to need HTTP).
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  // #1480: the browser features this app never calls are switched off for every page and API reply.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=()');
  json(res, 503, RUST_STORAGE_READS_REFUSAL);
  return true;
}

function parseEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  throw new Error(`Invalid boolean in feature env var: expected true/false`);
}

/**
 * @param {{ env?: Record<string,string|undefined>, store?: { get(key:string): string|undefined, set(key:string, value:string): void },
 *           audit?: (action:string, actor:string, detail:object)=>void, registry?: object }} deps
 */
/**
 * A renamed feature's stored setting, carried over once (back-compat): when the new
 * key has no valid value and the legacy key has one, the legacy value is copied to the new key.
 * The legacy row is left in place so a rollback to the previous release still reads it. A store
 * that cannot be written still answers with the legacy value for this boot.
 */
function migrateLegacySetting(store, name, legacyName, log) {
  const valid = v => v === 'true' || v === 'false';
  const current = store.get(SETTING_PREFIX + name);
  if (valid(current)) return current;
  const legacy = store.get(SETTING_PREFIX + legacyName);
  if (!valid(legacy)) return current;
  try {
    store.set(SETTING_PREFIX + name, legacy);
    log(`[features] migrated the stored ${legacyName} setting to ${name}`);
  } catch (error) {
    log(`[features] could not migrate the stored ${legacyName} setting to ${name}: ${error.message}`);
  }
  return legacy;
}

function createFeatures({ env = process.env, store = null, audit = () => {}, registry = REGISTRY, availability = {}, onChange = () => {}, log = (line) => console.warn(line) } = {}) {
  const state = new Map();
  // Old flag names still accepted on input (the admin API, enabled()) for one release.
  const aliases = new Map();
  for (const [name, spec] of Object.entries(registry)) {
    const fromEnv = parseEnv(env[spec.env]);
    if (spec.legacy?.name) aliases.set(spec.legacy.name, name);
    let value = spec.default === true;
    let source = 'default';
    if (fromEnv !== undefined) { value = fromEnv; source = 'env'; }
    else if (store) {
      const saved = spec.legacy?.name ? migrateLegacySetting(store, name, spec.legacy.name, log) : store.get(SETTING_PREFIX + name);
      if (saved === 'true' || saved === 'false') { value = saved === 'true'; source = 'admin'; }
    }
    state.set(name, { value, source, boot: value, unavailable: spec.unavailable?.(env) || null });
  }
  const resolve = name => (state.has(name) ? name : aliases.get(name) || name);
  // The native routing configuration (the Rust front's, #1071) reads this one product flag
  // independently. Keep Node's chat/read surfaces consistent with its SQLite truth, including a
  // failed audit after a committed admin save. Node remains the sole feature:routingModes writer.
  const refreshRoutingModes = () => {
    if (!store || !state.has('routingModes')) return;
    const s = state.get('routingModes');
    if (s.source === 'env') return;
    const saved = store.get(SETTING_PREFIX + 'routingModes');
    const valid = saved === 'true' || saved === 'false';
    state.set('routingModes', { ...s, value: valid ? saved === 'true' : false, source: valid ? 'admin' : 'default' });
  };
  const known = name => state.has(name);
  // Native status reads only typed SQLite truth for this product flag. Keep the
  // Node writers synchronized even when a committed save reports a later error.
  const refreshChatgptOAuth = () => {
    if (!store || !state.has('chatgptOAuth')) return;
    const s = state.get('chatgptOAuth');
    if (s.source === 'env') return;
    let saved;
    try { saved = store.get(SETTING_PREFIX + 'chatgptOAuth'); }
    catch { throw Object.assign(new Error('ChatGPT feature settings are unavailable.'), { status: 503 }); }
    const valid = saved === 'true' || saved === 'false';
    state.set('chatgptOAuth', { ...s, value: valid ? saved === 'true' : false, source: valid ? 'admin' : 'default' });
  };
  const unavailable = name => availability[name] ? availability[name]() : state.get(name).unavailable;
  return {
    names: () => [...state.keys()],
    /** The current name for a flag, mapping a legacy alias (e.g. astraReview) to its new name. */
    resolve,
    enabled(name) {
      refreshRoutingModes();
      refreshChatgptOAuth();
      name = resolve(name);
      if (!known(name)) throw new Error(`Unknown feature: ${name}`);
      const s = state.get(name);
      return !unavailable(name) && (registry[name].restart ? s.boot : s.value);
    },
    /** Booleans only: safe to send to any signed-in user. */
    flags: () => { refreshRoutingModes(); refreshChatgptOAuth(); return Object.fromEntries([...state].map(([name, s]) => [name, !unavailable(name) && (registry[name].restart ? s.boot : s.value)])); },
    // `id` is the flag name: the stable key the client translates the label and description by
    // (features.item.<id>.*, #618). `label` and `description` remain the English fallback.
    describe: () => { refreshRoutingModes(); refreshChatgptOAuth(); return [...state].map(([name, s]) => ({ id: name, name, label: registry[name].label, description: registry[name].description,
      enabled: s.value, source: s.source, locked: s.source === 'env', env: registry[name].env,
      ...(registry[name].experimental ? { experimental: true, unavailable: unavailable(name), unavailableId: unavailableId(name, unavailable(name)) }
        : registry[name].unavailable ? { unavailable: unavailable(name), unavailableId: unavailableId(name, unavailable(name)) } : {}),
      pendingRestart: !!registry[name].restart && s.value !== s.boot })); },
    set(name, enabled, actorId) {
      name = resolve(name);
      if (!known(name)) throw Object.assign(new Error('Unknown feature'), { status: 404 });
      if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false'), { status: 400 });
      if (state.get(name).source === 'env') throw Object.assign(new Error(`Set by the operator (${registry[name].env}); change it in the deployment configuration.`), { status: 409 });
      if (enabled && unavailable(name)) throw Object.assign(new Error(unavailable(name)), { status: 409 });
      if (!store) throw Object.assign(new Error('Feature settings are not persistent here'), { status: 409 });
      store.set(SETTING_PREFIX + name, String(enabled));
      state.set(name, { ...state.get(name), value: enabled, source: 'admin' });
      audit('feature.set', actorId, { name, enabled });
      // Side effects a change must have (e.g. nativeClientAuth off revokes every device, #555 F4).
      onChange(name, enabled, actorId);
      return enabled;
    },
  };
}

/** Native-owner adapter. Index switches to this factory only as part of the complete pair;
 * the existing writer factory is not a fallback for a failed native context. */
function createReadOnlyFeatures({ db, runtime, env = process.env, availability }) {
  const unavailable = () => Object.assign(new Error('Feature runtime context is unavailable.'), { status: 503, code: 'FEATURE_RUNTIME_CONTEXT_UNAVAILABLE' });
  const dynamic = ['stepSupervision', 'toolGate', 'systemOneRouting', 'chatFraming', 'framingReasoner'];
  if (typeof runtime !== 'function' || !availability || !dynamic.every(name => typeof availability[name] === 'function')
    || Object.keys(availability).some(name => !dynamic.includes(name))) throw unavailable();
  const names = Object.keys(REGISTRY), aliases = new Map();
  const read = db.prepare("SELECT CASE WHEN typeof(value)='text' AND value IN ('true','false') THEN value ELSE NULL END AS value FROM settings WHERE key=?");
  const state = new Map();
  function selected(name) {
    const spec = REGISTRY[name], fixed = state.get(name);
    if (fixed.env !== undefined) return { value: fixed.env, source: 'env' };
    let saved = read.get(SETTING_PREFIX + name)?.value;
    if (saved !== 'true' && saved !== 'false' && spec.legacy?.name) saved = read.get(SETTING_PREFIX + spec.legacy.name)?.value;
    return saved === 'true' || saved === 'false' ? { value: saved === 'true', source: 'admin' }
      : { value: spec.default === true, source: 'default' };
  }
  // Capture actual construction facts once, without writing/migrating any setting. Ordinary
  // execution queries below NEVER use a construction bypass, including before runtime Ready.
  for (const name of names) {
    const spec = REGISTRY[name];
    if (spec.legacy?.name) aliases.set(spec.legacy.name, name);
    state.set(name, { env: parseEnv(env[spec.env]), unavailable: spec.unavailable?.(env) || null });
    state.get(name).boot = selected(name).value;
  }
  const resolve = name => names.includes(name) ? name : aliases.get(name) || name;
  const reason = name => availability[name] ? availability[name]() : state.get(name).unavailable;
  function live(action) {
    const owner = runtime();
    if (!owner || typeof owner.read !== 'function') throw unavailable();
    return owner.read(view => {
      if (view !== db) throw unavailable(); // Never mix this factory's rows with another context DB.
      return action();
    });
  }
  const features = Object.freeze({
    names: () => [...names], resolve,
    enabled(name) {
      name = resolve(name);
      if (!names.includes(name)) throw new Error(`Unknown feature: ${name}`);
      return live(() => !reason(name) && (REGISTRY[name].restart ? state.get(name).boot : selected(name).value));
    },
    flags: () => live(() => Object.fromEntries(names.map(name => [name,
      !reason(name) && (REGISTRY[name].restart ? state.get(name).boot : selected(name).value)]))),
    describe: () => live(() => names.map(name => {
      const spec = REGISTRY[name], current = selected(name), unavailableReason = reason(name);
      return { id: name, name, label: spec.label, description: spec.description,
        enabled: current.value, source: current.source, locked: current.source === 'env', env: spec.env,
        ...(spec.experimental ? { experimental: true, unavailable: unavailableReason, unavailableId: unavailableId(name, unavailableReason) }
          : spec.unavailable ? { unavailable: unavailableReason, unavailableId: unavailableId(name, unavailableReason) } : {}),
        pendingRestart: !!spec.restart && current.value !== state.get(name).boot };
    })),
  });
  const staticNames = ['browserExecutor', 'codePipeline', 'codeMerge', 'nativeClientAuth'];
  const startupWarnings = Object.freeze(staticNames.filter(name => selected(name).value && state.get(name).unavailable)
    .map(name => Object.freeze({ name, env: REGISTRY[name].env, reason: state.get(name).unavailable })));
  const construction = Object.freeze({ diaryMcpWrite: state.get('diaryMcpWrite').boot,
    kiwix: state.get('kiwix').boot, startupWarnings });
  const browserReason = state.get('browserExecutor').unavailable;
  const browser = browserReason === null ? 'available' : browserReason === 'Needs Playwright installed on this server; it is not in this image.'
    ? 'playwright' : browserReason === 'Needs a Chromium browser installed for Playwright on this server.' ? 'chromium' : null;
  if (!browser) throw unavailable();
  const bootFacts = Object.freeze({ env: Object.freeze(names.map(name => state.get(name).env ?? null)),
    restart: Object.freeze([construction.diaryMcpWrite, construction.kiwix]), browser,
    code: state.get('codePipeline').unavailable === null, trustProxy: state.get('nativeClientAuth').unavailable === null });
  return Object.freeze({ features, construction, bootFacts });
}

/** The auth database's key/value settings table as a feature store. */
function settingsStore(db) {
  return {
    get: key => key === 'feature:routingModes' || key === 'feature:chatgptOAuth'
      ? db.prepare("SELECT CASE WHEN typeof(value)='text' AND value IN ('true','false') THEN value ELSE NULL END AS value FROM settings WHERE key=?").get(key)?.value
      : db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,
    set: (key, value) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value),
    delete: (key) => db.prepare('DELETE FROM settings WHERE key=?').run(key),
  };
}

module.exports = { browserRuntimeReason, codeSandboxReason, unavailableId, REGISTRY, createFeatures, createReadOnlyFeatures, settingsStore, parseEnv, migrateLegacySetting, refuseRustStorageRead, RUST_STORAGE_READS_REFUSAL, RUST_STORAGE_BROWSE_REFUSAL, RUST_CHATGPT_STATUS_REFUSAL };
