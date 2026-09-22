'use strict';
// One registry for optional capabilities (master-prompt § Decisions). Every feature is off
// unless an operator env var or an admin setting turns it on. An env var, when set, is
// authoritative and locks the admin toggle, so a deployment can pin a feature either way.
// Values are read once at creation and cached; admin changes update the cache. Features marked
// `restart` are wired into tool catalogues at startup: a change is saved and reported as pending,
// and enabled() keeps answering with the value the running server actually uses.

const REGISTRY = Object.freeze({
  stepSupervision: { env: 'NOEVIA_FEATURE_STEP_SUPERVISION', experimental: true, unavailable: () => 'No decision provider is connected. This experiment is available for synthetic testing only.', label: 'Step supervision', description: 'Let a decision provider advise whether to continue, verify tool results or pause for review between chat steps. Keeps existing behavior if unavailable. Approvals and execution limits still apply.' },
  systemOneRouting: { env: 'NOEVIA_FEATURE_SYSTEM_ONE_ROUTING', experimental: true, unavailable: env => require('./system-one-router.cjs').configuration(env).reason, label: 'System-One routing', description: 'Use the experimental option-logit baseline to choose Fast, Smart or Code for new Auto-routed messages. Falls back to the current router when unavailable. Manual model choices are unchanged.' },
  previews: { env: 'NOEVIA_FEATURE_PREVIEWS', label: 'Preview surfaces', description: 'Show the unbuilt Scheduled, Plugins, Explore and Code previews.' },
  diaryMcpWrite: { env: 'NOEVIA_FEATURE_DIARY_MCP_WRITE', restart: true, label: 'Diary append tool', description: 'Offer an approval-gated, append-only Diary tool through the in-app MCP server.' },
  deepResearch: { env: 'NOEVIA_FEATURE_DEEP_RESEARCH', label: 'Deep research', description: 'Administrators can run bounded research jobs that save a cited report to a project.' },
  offsiteBackup: { env: 'NOEVIA_FEATURE_OFFSITE_BACKUP', label: 'Backups', description: 'Nightly encrypted copies of the whole server, to a folder mirrored to Google Drive or to an S3-compatible target.' },
  toolRouter: { env: 'NOEVIA_FEATURE_TOOL_ROUTER', label: 'Tool routing', description: "Send only the project's toolboxes that match each message (needs an embedding model); falls back to all of them." },
  codeHarness: { env: 'NOEVIA_FEATURE_CODE_HARNESS', label: 'Code mode', description: 'Administrators can run a coding harness in a per-task git worktree, with every write through the approval card.' },
  kiwix: { env: 'NOEVIA_FEATURE_KIWIX', restart: true, label: 'Offline Wikipedia', description: 'A read-only lookup tool backed by an internal kiwix-serve.' },
});

const SETTING_PREFIX = 'feature:';

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
function createFeatures({ env = process.env, store = null, audit = () => {}, registry = REGISTRY } = {}) {
  const state = new Map();
  for (const [name, spec] of Object.entries(registry)) {
    const fromEnv = parseEnv(env[spec.env]);
    let value = spec.default === true;
    let source = 'default';
    if (fromEnv !== undefined) { value = fromEnv; source = 'env'; }
    else {
      const saved = store?.get(SETTING_PREFIX + name);
      if (saved === 'true' || saved === 'false') { value = saved === 'true'; source = 'admin'; }
    }
    state.set(name, { value, source, boot: value, unavailable: spec.unavailable?.(env) || null });
  }
  const known = name => state.has(name);
  return {
    names: () => [...state.keys()],
    enabled(name) {
      if (!known(name)) throw new Error(`Unknown feature: ${name}`);
      const s = state.get(name);
      return !s.unavailable && (registry[name].restart ? s.boot : s.value);
    },
    /** Booleans only: safe to send to any signed-in user. */
    flags: () => Object.fromEntries([...state].map(([name, s]) => [name, !s.unavailable && (registry[name].restart ? s.boot : s.value)])),
    describe: () => [...state].map(([name, s]) => ({ name, label: registry[name].label, description: registry[name].description,
      enabled: s.value, source: s.source, locked: s.source === 'env', env: registry[name].env,
      ...(registry[name].experimental ? { experimental: true, unavailable: s.unavailable } : {}),
      pendingRestart: !!registry[name].restart && s.value !== s.boot })),
    set(name, enabled, actorId) {
      if (!known(name)) throw Object.assign(new Error('Unknown feature'), { status: 404 });
      if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false'), { status: 400 });
      if (state.get(name).source === 'env') throw Object.assign(new Error(`Set by the operator (${registry[name].env}); change it in the deployment configuration.`), { status: 409 });
      if (enabled && state.get(name).unavailable) throw Object.assign(new Error(state.get(name).unavailable), { status: 409 });
      if (!store) throw Object.assign(new Error('Feature settings are not persistent here'), { status: 409 });
      store.set(SETTING_PREFIX + name, String(enabled));
      state.set(name, { ...state.get(name), value: enabled, source: 'admin' });
      audit('feature.set', actorId, { name, enabled });
      return enabled;
    },
  };
}

/** The auth database's key/value settings table as a feature store. */
function settingsStore(db) {
  return {
    get: key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,
    set: (key, value) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value),
  };
}

module.exports = { REGISTRY, createFeatures, settingsStore, parseEnv };
