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

const REGISTRY = Object.freeze({
  stepSupervision: { env: 'NOEVIA_FEATURE_STEP_SUPERVISION', experimental: true, unavailable: env => require('./decision-endpoint.cjs').configuration(env).reason, label: 'Step supervision', description: 'Let a decision provider advise whether to continue, verify tool results or pause for review between chat steps. Keeps existing behavior if unavailable. Approvals and execution limits still apply.' },
  systemOneRouting: { env: 'NOEVIA_FEATURE_SYSTEM_ONE_ROUTING', experimental: true, unavailable: env => require('./system-one-router.cjs').configuration(env).reason, label: 'System-One routing', description: 'Use the configured decision service to choose Fast, Smart or Code for new Auto-routed messages. Falls back to the current router when unavailable. Manual model choices are unchanged.' },
  toolGate: { env: 'NOEVIA_FEATURE_TOOL_GATE', experimental: true, unavailable: env => require('./decision-endpoint.cjs').configuration(env).reason, label: 'Tool gate', description: 'Let the decision service decide when a message needs a tool, then pre-run read-only tools or require the model to call one. Writes still go through the approval card.' },
  previews: { env: 'NOEVIA_FEATURE_PREVIEWS', label: 'Preview surfaces', description: 'Show the unbuilt Scheduled, Plugins, Explore and Code previews.' },
  diaryMcpWrite: { env: 'NOEVIA_FEATURE_DIARY_MCP_WRITE', restart: true, label: 'Diary append tool', description: 'Offer an approval-gated, append-only Diary tool through the in-app MCP server.' },
  deepResearch: { env: 'NOEVIA_FEATURE_DEEP_RESEARCH', label: 'Deep research', description: 'Administrators can run bounded research jobs that save a cited report to a project.' },
  offsiteBackup: { env: 'NOEVIA_FEATURE_OFFSITE_BACKUP', label: 'Backups', description: 'Nightly encrypted copies of the whole server, to a folder mirrored to Google Drive or to an S3-compatible target.' },
  toolRouter: { env: 'NOEVIA_FEATURE_TOOL_ROUTER', label: 'Tool routing', description: "Send only the project's toolboxes that match each message (needs an embedding model); falls back to all of them." },
  codeHarness: { env: 'NOEVIA_FEATURE_CODE_HARNESS', label: 'Code mode', description: 'Administrators can run a coding harness in a per-task git worktree, with every write through the approval card.' },
  // Renamed from astraReview (2026-09-29). For one release the old stored setting, the old env var
  // and the old name on the admin API are still honoured (`legacy`, see createFeatures).
  plannerReview: { env: 'NOEVIA_FEATURE_PLANNER_REVIEW', legacy: { name: 'astraReview', env: 'NOEVIA_FEATURE_ASTRA_REVIEW' }, experimental: true, label: 'Planner review (Code mode)', description: 'After a Code task finishes, a reviewer model reads the change and gives an approve or request-changes verdict on a final card. It is advice only: you still accept or decline the change, and a failed or late review falls back to your own review.' },
  browserExecutor: { env: 'NOEVIA_FEATURE_BROWSER_EXECUTOR', unavailable: () => browserRuntimeReason(), label: 'Browser mode', description: 'Administrators can run a domain-scoped Chromium session as a durable job, with every consequential action through the approval card.' },
  // Available since the Code pipeline (#705) runs the Planner's plan step.
  constrainedPlanDecoding: { env: 'NOEVIA_FEATURE_CONSTRAINED_PLAN_DECODING', experimental: true, label: 'Constrained plan decoding', description: 'Ask the local llama.cpp engine to constrain the plan artifact to its JSON schema. Adds to the after-the-fact validation and falls back to unconstrained generation for reasoning models or when the engine rejects it.' },
  // The Code pipeline (#705): Planner → Executor → verification → Planner review → Auditor. It runs
  // only inside the code sandbox (and with Code mode on); without the sandbox it cannot be enabled.
  codePipeline: { env: 'NOEVIA_FEATURE_CODE_PIPELINE', experimental: true, unavailable: env => codeSandboxReason(env), label: 'Planner pipeline (Code mode)', description: 'Offer a Planner preparation for Code tasks: the Planner writes a plan, the coding agent carries it out, the operator’s tests run in a separate verifier, the Planner reviews the change (at most two rounds of changes) and the Auditor reports what evidence there is. Every write still goes through the approval card, and you accept the result yourself.' },
  codeMerge: { env: 'NOEVIA_FEATURE_CODE_MERGE', experimental: true, unavailable: env => codeSandboxReason(env), label: 'Merge reviewed changes (Code mode)', description: 'When you accept a Planner pipeline task, fast-forward the branch it started from to the reviewed commit. Nothing is merged if that branch has moved or the task branch changed after review. Off, accepting records the change without merging it.' },
  executorGuard: { env: 'NOEVIA_FEATURE_EXECUTOR_GUARD', experimental: true, label: 'Executor guard (Code mode)', description: 'Check every tool call the coding agent makes against its schema before anything else sees it. A malformed call is refused with the reason, so the agent can correct it; after three, the task stops as blocked. It only adds refusals: every write still goes through the approval card.' },
  // Chat framing phase 1 (#737): suggest a project, kind, tags and related chats for a new chat. Off by default.
  chatFraming: { env: 'NOEVIA_FEATURE_CHAT_FRAMING', experimental: true, unavailable: env => require('./decision-endpoint.cjs').configuration(env).reason, label: 'Chat framing', description: 'Suggest a frame for a new chat from its first message: one of your projects, a kind (search, action, idea, question or code), an existing tag and related chats. You accept, edit or dismiss each suggestion before it is applied; an accepted frame shapes the answers in that chat. Without the decision service, chats get no frame.' },
  // Chat framing phase 4 (#740): the reasoner role condenses a pre-run read into a task packet. Needs chatFraming.
  framingReasoner: { env: 'NOEVIA_FEATURE_FRAMING_REASONER', experimental: true, unavailable: env => require('./decision-endpoint.cjs').configuration(env).reason, label: 'Framing reasoner', description: 'In chats framed as a lookup or a request to get something done, the reasoner model (Settings, framing roles) condenses what a pre-run read-only tool returned into a short, checked task packet for the answer. Needs Chat framing and the tool gate. Whenever the reasoner is not set, does not fit the memory budget, is too slow or returns something invalid, the answer gets the full tool result as before. Writes still go through the approval card.' },
  kiwix: { env: 'NOEVIA_FEATURE_KIWIX', restart: true, label: 'Offline Wikipedia', description: 'A read-only lookup tool backed by an internal kiwix-serve.' },
  chatgptOAuth: { env: 'NOEVIA_FEATURE_CHATGPT_OAUTH', label: 'Sign in with ChatGPT', description: 'Let each person connect their own ChatGPT account as a private AI provider. Chats that use it are sent to OpenAI; Diary text, Diary tools and project images never are.' },
  // Review N3: behind a reverse proxy (the Cloudflare tunnel) without TRUST_PROXY every request
  // carries the proxy's address, so per-client sign-in limits would be one shared bucket.
  nativeClientAuth: { env: 'NOEVIA_FEATURE_NATIVE_CLIENT_AUTH', unavailable: env => (env.TRUST_PROXY === 'true' ? null : 'Needs TRUST_PROXY on so sign-in limits can tell clients apart.'), label: 'Native app sign-in', description: 'Let a native app (such as the macOS client) sign in by showing a short code that you approve in this browser. Each device gets its own token, listed with a Revoke button under Security and login. A device acts as you for chats, projects and the Diary, but never for administration or security settings. Turning this off signs every device out for good: their tokens are deleted and each device must be approved again.' },
});

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
    if (/COWORK_DECISION_URL/.test(reason)) return 'decisionUrl';
    if (/Set up the decision service/.test(reason)) return 'decisionSetup';
    if (/does not support choice decisions/.test(reason)) return 'decisionUnsupported';
    if (/COWORK_SYSTEM_ONE_URL/.test(reason)) return 'systemOneUrl';
  }
  return null;
}

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
/**
 * A renamed feature's stored setting, carried over once (one-release back-compat): when the new
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
    let fromEnv = parseEnv(env[spec.env]);
    if (fromEnv === undefined && spec.legacy?.env) {
      fromEnv = parseEnv(env[spec.legacy.env]);
      if (fromEnv !== undefined) log(`[features] ${spec.legacy.env} is deprecated and will be removed in the next release; set ${spec.env} instead.`);
    }
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
  const known = name => state.has(name);
  const unavailable = name => availability[name] ? availability[name]() : state.get(name).unavailable;
  return {
    names: () => [...state.keys()],
    /** The current name for a flag, mapping a legacy alias (e.g. astraReview) to its new name. */
    resolve,
    enabled(name) {
      name = resolve(name);
      if (!known(name)) throw new Error(`Unknown feature: ${name}`);
      const s = state.get(name);
      return !unavailable(name) && (registry[name].restart ? s.boot : s.value);
    },
    /** Booleans only: safe to send to any signed-in user. */
    flags: () => Object.fromEntries([...state].map(([name, s]) => [name, !unavailable(name) && (registry[name].restart ? s.boot : s.value)])),
    // `id` is the flag name: the stable key the client translates the label and description by
    // (features.item.<id>.*, #618). `label` and `description` remain the English fallback.
    describe: () => [...state].map(([name, s]) => ({ id: name, name, label: registry[name].label, description: registry[name].description,
      enabled: s.value, source: s.source, locked: s.source === 'env', env: registry[name].env,
      ...(registry[name].experimental ? { experimental: true, unavailable: unavailable(name), unavailableId: unavailableId(name, unavailable(name)) }
        : registry[name].unavailable ? { unavailable: unavailable(name), unavailableId: unavailableId(name, unavailable(name)) } : {}),
      pendingRestart: !!registry[name].restart && s.value !== s.boot })),
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

/** The auth database's key/value settings table as a feature store. */
function settingsStore(db) {
  return {
    get: key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,
    set: (key, value) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value),
  };
}

module.exports = { browserRuntimeReason, codeSandboxReason, unavailableId, REGISTRY, createFeatures, settingsStore, parseEnv, migrateLegacySetting };
