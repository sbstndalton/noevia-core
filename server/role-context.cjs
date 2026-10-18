'use strict';
// #1071: Rust owns role projections, credential redaction and dossier leak policy.
// The host retains public metadata, serialization and the standalone audit helpers.

const ROLES = Object.freeze(['planner', 'executor', 'auditor']);
const ROLE_NAMES = Object.freeze({ planner: 'Planner', executor: 'Executor', auditor: 'Auditor', reviewer: 'Planner' });
// The planner's second persona (#519): the reviewer of a finished Code change. Deliberately not in ROLES,
// which stays the three #515 sub-roles `buildAllRoleContexts` projects; code-review.cjs builds this
// one on demand through the same allowlist, caps and leak guard.
const REVIEW_ROLE = 'reviewer';

// The three write-approval decisions (approvals.cjs `decide`). Counts only.
const APPROVAL_DECISIONS = Object.freeze(['approve', 'deny', 'approve_all']);

// Snippet source classes a sub-role may see. Diary, private collections and anything unknown are
// excluded by not being listed.
const SNIPPET_SOURCES = Object.freeze(['project', 'selected', 'repo-public']);

const TRUNCATION_MARK = '…[truncated]';

const CAPS = Object.freeze({
  request: 4000,
  roleInstructions: 4000,
  projectInstructions: 3000,
  shortText: 600,
  listItem: 400,
  listItems: 12,
  steps: 12,
  snippetText: 1000,
  snippets: 3,
  capabilities: 24,
  capabilityDescription: 300,
  identifier: 120,
  changedFiles: 50,
  testResults: 20,
  stepResults: 12,
  changeFiles: 20,
  changePatch: 4000,
  changeTotal: 24000,
  total: 40000,
});

class RoleContextError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RoleContextError';
    this.code = code;
  }
}

class RoleContextLeakError extends RoleContextError {
  constructor(classes) {
    // Names the leaked classes only — never echoes the leaked value itself.
    super(`role context would leak forbidden content: ${classes.join(', ')}`, 'leak');
    this.name = 'RoleContextLeakError';
    this.classes = classes;
  }
}

// ── field sanitisers ────────────────────────────────────────────────────────
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const ROLE_FIELDS = Object.freeze({"planner": ["capabilities", "constraints", "context_limit", "project_instructions", "request", "revision", "role", "role_instructions", "role_name", "snippets", "task_id"], "executor": ["capabilities", "feedback", "plan", "project_instructions", "request", "revision", "role", "role_instructions", "role_name", "snippets", "task_id"], "auditor": ["approval_outcomes", "execution", "lifecycle_state", "plan", "request", "revision", "role", "role_instructions", "role_name", "task_id"], "reviewer": ["capabilities", "change", "execution", "plan", "request", "revision", "role", "role_instructions", "role_name", "task_id"]});
function allowedFields(role) {
  if (!Object.hasOwn(ROLE_FIELDS, role)) throw new RoleContextError(`unknown role: ${String(role).slice(0,40)}`, "unknown_role");
  return [...ROLE_FIELDS[role]];
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

// Sorted keys, no whitespace, arrays in order. Same projection -> byte-identical string.
function serializeProjection(projection) {
  return JSON.stringify(canonicalize(projection));
}

// ── leak detection ──────────────────────────────────────────────────────────

// Zero-width and other format characters (\p{Cf}: U+200B/C/D, U+2060, U+FEFF, …) and the soft
// hyphen are invisible and would otherwise split a canary or a key so nothing matches. They are
// removed before every comparison (haystacks, needles, excerpt folding, credential redaction).
const FORMAT_CHARS = /[\p{Cf}\u00AD]/gu;
function stripFormat(text) {
  return text.replace(FORMAT_CHARS, '');
}

function escapeNonAscii(text) {
  return text.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Decode literal "\uXXXX" sequences written into string content, so an escaped canary is caught.
function decodeLiteralEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      out.push(key);
      collectStrings(value[key], out);
    }
  }
  return out;
}

// Every representation of the projection a leak could hide in: the canonical serialisation, its
// ASCII-escaped form, each decoded string and key (nested), those with literal \u escapes decoded,
// NFKC variants (case preserved, for case-sensitive patterns) and NFKC+lower-cased variants of all
// of it (catches full-width lookalikes and case changes).
function haystacks(projection) {
  const serialized = serializeProjection(projection);
  const base = [serialized, escapeNonAscii(serialized), ...collectStrings(projection)];
  const expanded = [];
  for (const h of base) {
    expanded.push(h);
    const decoded = decodeLiteralEscapes(h);
    if (decoded !== h) expanded.push(decoded);
  }
  const stripped = expanded.map(stripFormat).filter((h, i) => h !== expanded[i]);
  const all = expanded.concat(stripped);
  const nfkc = all.map((h) => stripFormat(h.normalize('NFKC')));
  const folded = nfkc.map((h) => h.toLowerCase());
  return all.concat(nfkc, folded);
}

function needles(item) {
  const text = String(item);
  const bare = stripFormat(text);
  const nfkc = stripFormat(bare.normalize('NFKC'));
  return [...new Set([text, bare, escapeNonAscii(text), JSON.stringify(text).slice(1, -1), nfkc.toLowerCase()])].filter(Boolean);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Token-boundary match: the needle must not be glued to a letter, digit or underscore on either
// side, so the id "sam" matches "ask sam" but not "same", and "dev" does not match "device".
function boundaryRegExp(needle) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`, 'u');
}

// Returns the forbidden entries (strings or RegExps) found anywhere in the projection. With
// `{ boundary: true }` string entries only match on token boundaries (used for tenant ids).
function findLeaks(projection, forbidden, { boundary = false } = {}) {
  const hay = haystacks(projection);
  const hits = [];
  for (const item of forbidden || []) {
    if (item instanceof RegExp) {
      const re = new RegExp(item.source, item.flags.replace('g', ''));
      if (hay.some((h) => re.test(h))) hits.push(item);
      continue;
    }
    if (typeof item !== 'string' || item.length === 0) continue;
    const ns = needles(item);
    if (boundary) {
      const res = ns.map(boundaryRegExp);
      if (hay.some((h) => res.some((re) => re.test(h)))) hits.push(item);
    } else if (hay.some((h) => ns.some((n) => h.includes(n)))) hits.push(item);
  }
  return hits;
}

// Test helper and runtime guard: throws if any forbidden string/RegExp appears in any form.
function assertNoLeak(projection, forbidden) {
  const hits = findLeaks(projection, forbidden);
  if (hits.length) throw new RoleContextLeakError(hits.map((h) => `forbidden[${forbidden.indexOf(h)}]`));
  return true;
}

// Credential shapes that must never reach any role, whatever field they arrive in. Matched against
// raw, escaped, NFKC (case preserved) and NFKC+lower-cased haystacks, so the AKIA and PEM patterns
// are case-insensitive too: the lower-cased copy would otherwise hide a full-width key.
const CREDENTIAL_PATTERNS = Object.freeze([
  /(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z])bearer\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}/i,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
]);
const REDACTED = '[redacted credential]';
const EXCERPT_WINDOW = 48;
const EXCERPT_STRIDE = 16;
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const PERSONA_FIELDS = Object.freeze(['role', 'role_name', 'role_instructions', 'revision']);
// Fields bound to one revision of the work (plan, head/base SHAs, diff, run results, state): never
// shared, whatever the role set, so the cached prefix survives a changes_requested loop.
const REVISION_FIELDS = Object.freeze(['plan', 'execution', 'change', 'lifecycle_state', 'approval_outcomes', 'feedback']);
const DOSSIER_ROLES = Object.freeze([...ROLES, REVIEW_ROLE]);

const defaultLoader = () => require('./dav-parse-wasm.cjs');
// Compatibility export: the retired selector never permits the removed JS implementation.
function roleContextImpl() { return 'wasm'; }
const REFUSALS = Object.freeze({
  unknown_role: 'unknown role', invalid_state: 'state must be an object',
  missing_tenant: 'state.tenantId is required', invalid_tenant: 'state.tenantId must be a string',
  too_large: `projection exceeds ${CAPS.total} characters`,
});
function askPort(call, key) {
  let reply;
  try { reply = call(); }
  catch { throw new RoleContextLeakError(['impl_refused']); }
  try {
    if (!isPlainObject(reply)) throw Error('reply');
    const keys = Object.keys(reply).sort().join(',');
    if (keys === 'refused' && Object.hasOwn(REFUSALS, reply.refused)) {
      throw new RoleContextError(REFUSALS[reply.refused], reply.refused);
    }
    if (keys === 'leak') {
      const checked = require('./dav-parse-wasm.cjs').roleContextReply(reply, key);
      throw new RoleContextLeakError(checked.leak);
    }
    if (keys !== 'redactions,value') throw Error('reply');
    return require('./dav-parse-wasm.cjs').roleContextReply({ [key]: reply.value, redactions: reply.redactions }, key);
  } catch (err) {
    if (err instanceof RoleContextError) throw err;
    throw new RoleContextLeakError(['impl_refused']);
  }
}
function projectRoleContext(role, state, { wasmLoader = defaultLoader } = {}) {
  const result = askPort(() => wasmLoader().roleContextProject(role, state), 'projection');
  return { projection: deepFreeze(result.value), meta: Object.freeze({ role, redactions: result.redactions }) };
}
function projectSharedDossier(state, { roles = DOSSIER_ROLES, wasmLoader = defaultLoader } = {}) {
  const result = askPort(() => wasmLoader().roleContextDossier(roles, state), 'dossier');
  return { dossier: deepFreeze(result.value), meta: Object.freeze({ roles: Object.freeze([...roles]), fields: Object.freeze(Object.keys(result.value)), redactions: result.redactions }) };
}
function buildRoleContext(role, state) {
  return projectRoleContext(role, state).projection;
}

function buildAllRoleContexts(state) {
  const out = {};
  for (const role of ROLES) out[role] = buildRoleContext(role, state);
  return out;
}

module.exports = {
  ROLES,
  ROLE_NAMES,
  REVIEW_ROLE,
  APPROVAL_DECISIONS,
  SNIPPET_SOURCES,
  CAPS,
  CREDENTIAL_PATTERNS,
  TRUNCATION_MARK,
  REDACTED,
  EXCERPT_WINDOW,
  EXCERPT_STRIDE,
  RoleContextError,
  RoleContextLeakError,
  allowedFields,
  buildRoleContext,
  projectRoleContext,
  buildAllRoleContexts,
  projectSharedDossier,
  roleContextImpl,
  PERSONA_FIELDS,
  REVISION_FIELDS,
  DOSSIER_ROLES,
  serializeProjection,
  findLeaks,
  assertNoLeak,
};
