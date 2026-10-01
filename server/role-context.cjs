'use strict';
// role-context.cjs — per-role context projection for the vision multi-agent pipeline (#511/#515).
//
// Builds the bounded, model-facing context each sub-role receives from a task/orchestrator state
// object: planner, executor and auditor. Modelled on PromptArchitect's
// allowlisted outbound payload builder (docs/spec-agent-execution.md §2, reference implementation
// `outbound_payload`/`audit_outbound` in experiments/prompt-preparation/run.py — Python, so it is
// mirrored here rather than imported).
//
// Rules this module enforces in code, not by instructing a model:
//   * Strict per-role ALLOWLISTS. A projection is constructed field by field from the spec in
//     ROLE_SPECS; nothing is copied by spreading, so an unknown or newly added state field is
//     dropped by construction. There is no denylist of fields anywhere.
//   * Never in a projection: the orchestrator's meta-prompt or routing, another role's system
//     prompt, credentials/tokens/cookies, other tenants' ids or data, Diary content, raw
//     approval internals (ids, cards, arguments, tokens). The auditor only sees counts of the
//     three write-approval decisions (approve / deny / approve_all), never the approvals.
//   * Snippets are admitted only from allowlisted source classes and only when they belong to
//     the task's own tenant; a task without a tenant id is refused.
//   * Per-field size caps (code-point safe) and a total cap; deterministic serialisation.
//   * Credentials the user typed into their own free text (request, project instructions) are
//     redacted to "[redacted credential]" and counted in `meta.redactions` (projectRoleContext).
//   * Fail closed for everything else: after building, the projection is scanned for sensitive
//     values taken from the state itself (meta-prompt, other roles' prompts, credential, Diary,
//     other-tenant and approval leaves) — whole values and any copied excerpt of ≥ 63 folded code
//     points, so a field cap truncating a quoted meta-prompt does not hide it — and for credential
//     patterns. Any hit throws RoleContextLeakError, matching "any hit invalidates the run" in the
//     PromptArchitect outbound audit; it is also the backstop if redaction missed something.
//     Short single-token values (paths, enums, ids) from prose classes and this module's own
//     vocabulary are not matched whole, and windows shared with the role's own prompt are
//     trusted, so ordinary runs do not throw.
//
// Pure: no model calls, no I/O, no HTTP. NOT wired into any live chat path — no multi-role
// runner exists yet. A future runner prepends nothing but this projection (plus the original
// request, which the projection already carries as authoritative intent).

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

// Code-point safe truncation so a cap never splits a surrogate pair.
function capText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC');
  const points = Array.from(text);
  if (points.length <= max) return text;
  const keep = Math.max(0, max - Array.from(TRUNCATION_MARK).length);
  return points.slice(0, keep).join('') + TRUNCATION_MARK;
}

function capIdentifier(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return capText(value, CAPS.identifier);
}

/** @param {unknown} value @param {number} [maxItems] @param {number} [maxChars] */
function capList(value, maxItems = CAPS.listItems, maxChars = CAPS.listItem) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value) {
    if (out.length >= maxItems) break;
    const text = capText(item, maxChars);
    if (text !== undefined) out.push(text);
  }
  return out;
}

function capInt(value, { min = 0, max = 1e9 } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function capSteps(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const step of value) {
    if (out.length >= CAPS.steps) break;
    if (!isPlainObject(step)) continue;
    const doText = capText(step.do, CAPS.shortText);
    if (doText === undefined) continue;
    const entry = { n: out.length + 1, do: doText };
    const doneWhen = capText(step.done_when, CAPS.shortText);
    if (doneWhen !== undefined) entry.done_when = doneWhen;
    out.push(entry);
  }
  return out;
}

function capCapabilities(value) {
  if (!Array.isArray(value)) return undefined;
  const byName = new Map();
  for (const cap of value) {
    const name = capIdentifier(isPlainObject(cap) ? cap.name : cap);
    if (!name || byName.has(name)) continue;
    const entry = { name };
    const description = isPlainObject(cap) ? capText(cap.description, CAPS.capabilityDescription) : undefined;
    if (description !== undefined) entry.description = description;
    byName.set(name, entry);
  }
  return [...byName.keys()].sort().slice(0, CAPS.capabilities).map((k) => byName.get(k));
}

// Only snippets from allowlisted source classes (exact, case-sensitive match) that carry the
// task's own tenant id. Fail closed: a snippet with no tenant id, or a differently typed one (7 vs
// '7'), is dropped. The tenant id is used for the check and is never copied into the projection.
function capSnippets(value, tenantId) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const snip of value) {
    if (out.length >= CAPS.snippets) break;
    if (!isPlainObject(snip)) continue;
    if (!SNIPPET_SOURCES.includes(snip.source)) continue;
    if (snip.tenantId !== tenantId) continue;
    const text = capText(snip.text, CAPS.snippetText);
    if (text === undefined) continue;
    const entry = { source: snip.source, text };
    const label = capText(snip.label, CAPS.identifier);
    if (label !== undefined) entry.label = label;
    out.push(entry);
  }
  return out;
}

function capPlan(plan, keys) {
  if (!isPlainObject(plan)) return undefined;
  const out = {};
  for (const key of keys) {
    let v;
    if (key === 'goal' || key === 'completion') v = capText(plan[key], CAPS.shortText);
    else if (key === 'steps') v = capSteps(plan.steps);
    else if (key === 'capabilities') v = capList(plan.capabilities, CAPS.capabilities, CAPS.identifier);
    else v = capList(plan[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function capTestResults(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const t of value) {
    if (out.length >= CAPS.testResults) break;
    if (!isPlainObject(t)) continue;
    const name = capText(t.name, CAPS.identifier);
    if (name === undefined || typeof t.passed !== 'boolean') continue;
    out.push({ name, passed: t.passed });
  }
  return out;
}

function capStepResults(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const s of value) {
    if (out.length >= CAPS.stepResults) break;
    if (!isPlainObject(s)) continue;
    const n = capInt(s.n, { min: 1, max: CAPS.steps });
    const status = ['done', 'skipped', 'failed'].includes(s.status) ? s.status : undefined;
    if (n === undefined || status === undefined) continue;
    const entry = { n, status };
    const note = capText(s.note, CAPS.shortText);
    if (note !== undefined) entry.note = note;
    out.push(entry);
  }
  return out;
}

function capExecution(execution) {
  if (!isPlainObject(execution)) return undefined;
  const out = {};
  const summary = capText(execution.summary, CAPS.shortText);
  if (summary !== undefined) out.summary = summary;
  const headSha = typeof execution.headSha === 'string' && /^[0-9a-f]{7,64}$/.test(execution.headSha) ? execution.headSha : undefined;
  if (headSha !== undefined) out.head_sha = headSha;
  const files = capList(execution.changedFiles, CAPS.changedFiles, CAPS.identifier * 2);
  if (files !== undefined) out.changed_files = files;
  const tests = capTestResults(execution.testResults);
  if (tests !== undefined) out.test_results = tests;
  const steps = capStepResults(execution.stepResults);
  if (steps !== undefined) out.step_results = steps;
  return out;
}

// The change under review (#519): a bounded diff read by noevia from the source repository, never
// from the harness. Per-file and total caps; anything cut is marked, never silently dropped.
//
// Budgets are counted in SERIALISED code points — what `projectRoleContext` measures against
// CAPS.total — not raw ones: a tab, quote or control character costs 2-6 once JSON-escaped, and
// a diff full of them must be cut here rather than tip the whole projection over the total.
const serialisedCost = (text) => Array.from(JSON.stringify(text)).length - 2;
const CHANGE_ENTRY_OVERHEAD = serialisedCost('{"path":"","patch":""},');
function fitSerialised(value, max) {
  const text = value.normalize('NFC');
  if (serialisedCost(text) <= max) return text;
  const room = max - serialisedCost(TRUNCATION_MARK);
  let kept = '', used = 0;
  for (const point of text) {
    const cost = serialisedCost(point);
    if (used + cost > room) break;
    kept += point; used += cost;
  }
  return kept + TRUNCATION_MARK;
}
function capChange(change) {
  if (!isPlainObject(change)) return undefined;
  const out = { files: [], truncated: change.truncated === true };
  const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v) ? v : undefined);
  if (sha(change.baseSha)) out.base_sha = sha(change.baseSha);
  if (sha(change.headSha)) out.head_sha = sha(change.headSha);
  let budget = CAPS.changeTotal;
  for (const file of Array.isArray(change.files) ? change.files : []) {
    if (out.files.length >= CAPS.changeFiles) { out.truncated = true; break; }
    if (!isPlainObject(file) || typeof file.path !== 'string') continue;
    const filePath = fitSerialised(file.path, CAPS.identifier * 2);
    const pathCost = serialisedCost(filePath) + CHANGE_ENTRY_OVERHEAD;
    if (pathCost > budget) { out.truncated = true; break; }
    budget -= pathCost;
    const entry = { path: filePath };
    const room = Math.min(CAPS.changePatch, budget);
    if (typeof file.patch === 'string' && room > serialisedCost(TRUNCATION_MARK)) {
      const patch = fitSerialised(file.patch, room);
      if (patch !== file.patch.normalize('NFC')) out.truncated = true;
      entry.patch = patch;
      budget -= serialisedCost(patch);
    } else if (typeof file.patch === 'string') out.truncated = true;
    out.files.push(entry);
  }
  if (Array.isArray(change.files) && change.files.length > CAPS.changeFiles) out.truncated = true;
  return out;
}

// Counts of the three write-approval decisions only. Ids, cards, arguments, tokens, timestamps
// and any unknown decision value are never read into the projection.
function approvalOutcomes(approvals) {
  const counts = { approve: 0, deny: 0, approve_all: 0 };
  if (!Array.isArray(approvals)) return counts;
  for (const a of approvals) {
    if (isPlainObject(a) && APPROVAL_DECISIONS.includes(a.decision)) counts[a.decision] += 1;
  }
  return counts;
}

// ── per-role allowlists ─────────────────────────────────────────────────────
// Each entry: output key -> function(state, ctx) returning the capped value or undefined.
// This table IS the allowlist; a field that is not listed cannot reach a projection.

const PLAN_KEYS_EXECUTOR = Object.freeze(['goal', 'steps', 'constraints', 'capabilities', 'approval_boundaries', 'verification', 'completion', 'non_goals']);
const PLAN_KEYS_AUDITOR = Object.freeze(['goal', 'steps', 'constraints', 'approval_boundaries', 'verification', 'completion', 'non_goals']);

const common = {
  role: (_s, ctx) => ctx.role,
  role_name: (_s, ctx) => ROLE_NAMES[ctx.role],
  task_id: (s) => capIdentifier(s.taskId),
  revision: (s) => capIdentifier(s.revision),
  request: (s, ctx) => capText(ctx.redact(s.request), CAPS.request),
  role_instructions: (s, ctx) => (isPlainObject(s.roleSystemPrompts) ? capText(s.roleSystemPrompts[ctx.role], CAPS.roleInstructions) : undefined),
};

const ROLE_SPECS = Object.freeze({
  planner: Object.freeze({
    ...common,
    project_instructions: (s, ctx) => capText(ctx.redact(s.projectInstructions), CAPS.projectInstructions),
    snippets: (s, ctx) => capSnippets(s.snippets, ctx.tenantId),
    capabilities: (s) => capCapabilities(s.capabilities),
    constraints: (s) => capList(s.constraints),
    context_limit: (s) => capInt(s.contextLimit, { min: 0, max: 10_000_000 }),
  }),
  executor: Object.freeze({
    ...common,
    project_instructions: (s, ctx) => capText(ctx.redact(s.projectInstructions), CAPS.projectInstructions),
    plan: (s) => capPlan(s.plan, PLAN_KEYS_EXECUTOR),
    snippets: (s, ctx) => capSnippets(s.snippets, ctx.tenantId),
    capabilities: (s) => capCapabilities(s.capabilities),
  }),
  auditor: Object.freeze({
    ...common,
    plan: (s) => capPlan(s.plan, PLAN_KEYS_AUDITOR),
    lifecycle_state: (s) => capIdentifier(s.lifecycleState),
    execution: (s) => capExecution(s.execution),
    approval_outcomes: (s) => approvalOutcomes(s.approvals),
  }),
  // What the Planner needs to judge a finished change, and nothing else: the request (authoritative
  // intent), what the task was allowed to do, the plan it reported, a server-side summary and the
  // bounded diff. No approval cards, ids, arguments or grants — the reviewer cannot answer or
  // widen anything, and has nothing that names one.
  reviewer: Object.freeze({
    ...common,
    plan: (s) => capPlan(s.plan, PLAN_KEYS_AUDITOR),
    capabilities: (s) => capCapabilities(s.capabilities),
    execution: (s) => capExecution(s.execution),
    change: (s) => capChange(s.change),
  }),
});

function allowedFields(role) {
  return Object.keys(resolveSpec(role)).sort();
}

// ── deterministic serialisation ─────────────────────────────────────────────

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
const MIN_SENSITIVE_LENGTH = 8;
// Excerpt matching: sensitive values are compared as sliding windows of EXCERPT_WINDOW folded code
// points taken every EXCERPT_STRIDE, against every window of the projection. Any copied excerpt of
// at least EXCERPT_WINDOW + EXCERPT_STRIDE - 1 (= 63) folded code points therefore contains one
// whole stride-aligned window and is caught, even after a field cap truncated it.
const EXCERPT_WINDOW = 48;
const EXCERPT_STRIDE = 16;
const ORCHESTRATOR_SENSITIVE_KEYS = Object.freeze(['metaPrompt', 'systemPrompt', 'routing', 'notes', 'scratchpad']);
// Approval ids and tokens are random secrets. Arguments are NOT listed: they legitimately repeat
// structured values (a file path, a note title) that the auditor sees in execution results.
const APPROVAL_SENSITIVE_KEYS = Object.freeze(['id', 'token', 'userId', 'chatId']);

// Fixed vocabulary this module itself writes into projections (role values and names, field names,
// decision and source enums). A state value equal to one of these is never a leak.
const VOCABULARY = new Set([
  ...ROLES, ...Object.values(ROLE_NAMES), ...APPROVAL_DECISIONS, ...SNIPPET_SOURCES,
  ...Object.values(ROLE_SPECS).flatMap((spec) => Object.keys(spec)),
  ...PLAN_KEYS_EXECUTOR, 'done_when', 'head_sha', 'changed_files', 'test_results', 'step_results', 'summary',
  'base_sha', 'files', 'patch', 'path', 'truncated',
  'done', 'skipped', 'failed', 'label', 'source', 'text', 'name', 'description', 'passed', 'note',
].map((w) => fold(w)));

// A short single token (no whitespace, ≤ 64 chars) — a path, enum or identifier. Only for the
// orchestrator's text and other roles' prompts are such values not matched whole (routing names a
// tool or a role the projection legitimately contains). Diary and other-tenant values are always
// matched whole, however short: a single-token email, key, filename or URL is still private.
function isStructuredToken(value) {
  return /^\S{1,64}$/.test(value);
}

function fold(text) {
  return stripFormat(stripFormat(String(text)).normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ');
}

function leafStrings(value, out = [], depth = 0) {
  if (depth > 32) return out;
  if (typeof value === 'string') { if (value.length >= MIN_SENSITIVE_LENGTH) out.push(value); }
  else if (Array.isArray(value)) for (const v of value) leafStrings(v, out, depth + 1);
  else if (isPlainObject(value)) for (const k of Object.keys(value)) leafStrings(value[k], out, depth + 1);
  return out;
}

function credentialValues(state) {
  return leafStrings([state.credentials, state.secrets, state.tokens]);
}

// Redacts credentials the user typed into free text (request, project instructions): pattern
// matches and verbatim copies of the state's own credential values. If only the normalised form
// (format characters stripped, then NFKC) reveals a credential — full-width characters, a zero-width
// space inside a key — that normalised form is what gets redacted and kept. Otherwise the user's
// text is left exactly as typed (so emoji ZWJ sequences survive).
function redactCredentials(text, known, counter) {
  if (typeof text !== 'string') return text;
  const redactOnce = (input) => {
    let n = 0;
    let out = input;
    for (const value of known) {
      if (out.includes(value)) { n += out.split(value).length - 1; out = out.split(value).join(REDACTED); }
    }
    for (const re of CREDENTIAL_PATTERNS) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      out = out.replace(g, () => { n += 1; return REDACTED; });
    }
    return { out, n };
  };
  let { out, n } = redactOnce(text);
  const nfkc = stripFormat(stripFormat(out).normalize('NFKC'));
  if (nfkc !== out) {
    const second = redactOnce(nfkc);
    if (second.n > 0) { out = second.out; n += second.n; }
  }
  counter.redactions += n;
  return out;
}

// Sensitive values drawn from the state itself, grouped by class, so a projection that copied one
// (or a long enough excerpt of one) through an allowlisted field is refused.
function sensitiveClasses(state, role) {
  const prose = (values) => values.filter((v) => !isStructuredToken(v));
  const classes = {};
  // The orchestrator's own text: its meta-prompt, system prompt, routing and notes. Its other
  // fields (e.g. a status word) are not treated as secrets, to avoid refusing on common words.
  const o = isPlainObject(state.orchestrator) ? state.orchestrator : {};
  classes.orchestrator = prose(leafStrings(ORCHESTRATOR_SENSITIVE_KEYS.map((k) => o[k])));
  const prompts = isPlainObject(state.roleSystemPrompts) ? state.roleSystemPrompts : {};
  classes.other_role_prompts = prose(leafStrings(Object.keys(prompts).filter((r) => r !== role).map((r) => prompts[r])));
  classes.credentials = credentialValues(state);
  classes.diary = leafStrings(state.diary);
  classes.other_tenants = leafStrings(state.otherTenants);
  if (Array.isArray(state.snippets)) {
    classes.other_tenants.push(...leafStrings(state.snippets.filter((s) => isPlainObject(s) && s.tenantId !== undefined && s.tenantId !== state.tenantId).map((s) => s.text)));
    classes.diary.push(...leafStrings(state.snippets.filter((s) => isPlainObject(s) && typeof s.source === 'string' && fold(s.source).trim() === 'diary').map((s) => s.text)));
  }
  classes.approval_internals = leafStrings((Array.isArray(state.approvals) ? state.approvals : []).map((a) => (isPlainObject(a) ? [...APPROVAL_SENSITIVE_KEYS.map((k) => a[k]), ...(isPlainObject(a.card) ? APPROVAL_SENSITIVE_KEYS.map((k) => a.card[k]) : [])] : undefined)));
  // Other tenants' ids are forbidden too, even when short.
  const otherIds = [];
  if (isPlainObject(state.otherTenants)) otherIds.push(...Object.keys(state.otherTenants));
  if (Array.isArray(state.snippets)) for (const s of state.snippets) if (isPlainObject(s) && (typeof s.tenantId === 'string' || typeof s.tenantId === 'number') && s.tenantId !== state.tenantId) otherIds.push(String(s.tenantId));
  classes.other_tenant_ids = otherIds.filter((id) => id.length >= 3);
  for (const name of Object.keys(classes)) {
    if (name !== 'credentials') classes[name] = classes[name].filter((v) => !VOCABULARY.has(fold(v)));
  }
  return classes;
}

function windowSet(text) {
  const points = Array.from(text);
  const set = new Set();
  for (let i = 0; i + EXCERPT_WINDOW <= points.length; i++) set.add(points.slice(i, i + EXCERPT_WINDOW).join(''));
  return set;
}

// True if a copied excerpt (≥ 63 folded code points) of `value` appears in the projection, not
// counting windows that also occur in `trusted` (the role's own capped prompt, which may
// legitimately share a preamble with other prompts or be embedded in the orchestrator's text).
// Windows are generated lazily with an early exit; the projection side is bounded by CAPS.total.
// Sensitive values are not length-capped: an excerpt from deep inside a large Diary entry must
// still be caught, and the cost is linear (one window per EXCERPT_STRIDE code points).
function excerptLeaked(value, projectionWindows, trustedWindows) {
  const points = Array.from(fold(value));
  if (points.length < EXCERPT_WINDOW) return false;
  const hit = (i) => {
    const w = points.slice(i, i + EXCERPT_WINDOW).join('');
    return projectionWindows.has(w) && !trustedWindows.has(w);
  };
  for (let i = 0; i + EXCERPT_WINDOW <= points.length; i += EXCERPT_STRIDE) if (hit(i)) return true;
  return hit(points.length - EXCERPT_WINDOW);
}

// Classes the role's own prompt can never exempt: a tenant id, an approval id/token or a credential
// is not made safe by also appearing in the prompt.
const NEVER_EXEMPT = new Set(['credentials', 'other_tenant_ids', 'approval_internals']);

function guardProjection(projection, state, role) {
  const leaked = [];
  const classes = sensitiveClasses(state, role);
  const strings = collectStrings(projection);
  const foldedProjection = strings.flatMap((h) => {
    const d = decodeLiteralEscapes(h);
    return d === h ? [fold(h)] : [fold(h), fold(d)];
  }).join('\u0000');
  const projectionWindows = windowSet(foldedProjection);
  // Trust only the capped own prompt actually sent, never text beyond the field cap.
  const foldedOwn = typeof projection.role_instructions === 'string' ? fold(projection.role_instructions) : '';
  const trustedWindows = windowSet(foldedOwn);
  const noTrust = new Set();
  for (const name of Object.keys(classes).sort()) {
    const exemptable = !NEVER_EXEMPT.has(name);
    const values = classes[name].filter((v) => !exemptable || !foldedOwn.includes(fold(v)));
    if (!values.length) continue;
    const whole = findLeaks(projection, values, { boundary: name === 'other_tenant_ids' }).length > 0;
    const excerpt = !whole && values.some((v) => excerptLeaked(v, projectionWindows, exemptable ? trustedWindows : noTrust));
    if (whole || excerpt) leaked.push(name);
  }
  if (findLeaks(projection, CREDENTIAL_PATTERNS).length) leaked.push('credential_pattern');
  if (leaked.length) throw new RoleContextLeakError(leaked);
}

// ── builder ─────────────────────────────────────────────────────────────────

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function resolveSpec(role) {
  if (typeof role !== 'string' || !Object.hasOwn(ROLE_SPECS, role)) {
    throw new RoleContextError(`unknown role: ${typeof role === 'string' ? role.slice(0, 40) : typeof role}`, 'unknown_role');
  }
  return ROLE_SPECS[role];
}

// Returns { projection, meta: { role, redactions } }. `redactions` counts credentials removed from
// the user's own free text (request, project instructions). Sensitive content from anywhere else
// in the state is never redacted: it throws RoleContextLeakError. The throw is also the backstop
// for anything the redaction missed.
function projectRoleContext(role, state) {
  const spec = resolveSpec(role);
  if (!isPlainObject(state)) throw new RoleContextError('state must be an object', 'invalid_state');
  if (state.tenantId === undefined || state.tenantId === null || state.tenantId === '') throw new RoleContextError('state.tenantId is required', 'missing_tenant');
  if (typeof state.tenantId !== 'string') throw new RoleContextError('state.tenantId must be a string', 'invalid_tenant');
  const counter = { redactions: 0 };
  const known = credentialValues(state);
  const ctx = { role, tenantId: state.tenantId, redact: (text) => redactCredentials(text, known, counter) };
  const projection = {};
  for (const key of Object.keys(spec).sort()) {
    const value = spec[key](state, ctx);
    if (value !== undefined) projection[key] = value;
  }
  const canonical = canonicalize(projection);
  const size = Array.from(serializeProjection(canonical)).length;
  if (size > CAPS.total) throw new RoleContextError(`projection exceeds ${CAPS.total} characters`, 'too_large');
  guardProjection(canonical, state, role);
  return { projection: deepFreeze(canonical), meta: Object.freeze({ role, redactions: counter.redactions }) };
}

// ── shared dossier (#702) ───────────────────────────────────────────────────
// The task dossier every role call of one task shares as its first user message, so the engine can
// reuse the KV cache of [shared frame + dossier] across roles. It is the INTERSECTION of the given
// roles' allowlists, minus the persona fields (who the role is, its own prompt, the revision): a
// field enters only if every role may see it AND every role's own spec yields byte-identical output
// for it. So the dossier can never carry a field one of the roles is not allowed, and nothing that
// changes between revisions (revision, SHAs, plan, execution, diff) is in it. It passes the leak
// guard once per role. Refusals throw exactly like projectRoleContext.
const PERSONA_FIELDS = Object.freeze(['role', 'role_name', 'role_instructions', 'revision']);
// Fields bound to one revision of the work (plan, head/base SHAs, diff, run results, state): never
// shared, whatever the role set, so the cached prefix survives a changes_requested loop.
const REVISION_FIELDS = Object.freeze(['plan', 'execution', 'change', 'lifecycle_state', 'approval_outcomes']);
const DOSSIER_ROLES = Object.freeze([...ROLES, REVIEW_ROLE]);

function projectSharedDossier(state, { roles = DOSSIER_ROLES } = {}) {
  if (!Array.isArray(roles) || roles.length === 0) throw new RoleContextError('at least one role is required', 'unknown_role');
  const specs = roles.map((role) => [role, resolveSpec(role)]);
  if (!isPlainObject(state)) throw new RoleContextError('state must be an object', 'invalid_state');
  if (state.tenantId === undefined || state.tenantId === null || state.tenantId === '') throw new RoleContextError('state.tenantId is required', 'missing_tenant');
  if (typeof state.tenantId !== 'string') throw new RoleContextError('state.tenantId must be a string', 'invalid_tenant');
  const known = credentialValues(state);
  const counter = { redactions: 0 };
  const keys = Object.keys(specs[0][1]).filter((key) => !PERSONA_FIELDS.includes(key) && !REVISION_FIELDS.includes(key) && specs.every(([, spec]) => Object.hasOwn(spec, key))).sort();
  const dossier = {};
  for (const key of keys) {
    const outputs = specs.map(([role, spec]) => {
      const local = { redactions: 0 };
      const value = spec[key](state, { role, tenantId: state.tenantId, redact: (text) => redactCredentials(text, known, local) });
      return { value, text: value === undefined ? undefined : serializeProjection(value), redactions: local.redactions };
    });
    if (outputs[0].value === undefined || outputs.some((o) => o.text !== outputs[0].text)) continue;
    dossier[key] = outputs[0].value;
    counter.redactions += outputs[0].redactions;
  }
  const canonical = canonicalize(dossier);
  if (Array.from(serializeProjection(canonical)).length > CAPS.total) throw new RoleContextError(`projection exceeds ${CAPS.total} characters`, 'too_large');
  for (const [role] of specs) guardProjection(canonical, state, role);
  return { dossier: deepFreeze(canonical), meta: Object.freeze({ roles: Object.freeze([...roles]), fields: Object.freeze(Object.keys(canonical)), redactions: counter.redactions }) };
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
  PERSONA_FIELDS,
  REVISION_FIELDS,
  DOSSIER_ROLES,
  serializeProjection,
  findLeaks,
  assertNoLeak,
};
