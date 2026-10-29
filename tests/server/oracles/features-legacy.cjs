'use strict';
// TEST-ONLY original writer oracle, retained from pre-retirement Core fb73fdb.
// Production must never import this module. Native differential fixtures remain frozen.
const current = require('../../../server/features.cjs');
const { REGISTRY, parseEnv, unavailableId } = current;
const SETTING_PREFIX = 'feature:';
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


module.exports = { ...current, createFeatures, migrateLegacySetting };
