'use strict';
// What may leave the server through an EXTERNAL provider (#447).
//
// An external provider is one the server marks as sending chats to a third-party service on a
// person's own account: today only "Sign in with ChatGPT" rows (kind chatgpt-oauth, or a row the
// server flagged external:true; neither can be set through POST /api/providers). Custom
// OpenAI-compatible endpoints keep their existing behaviour.
//
// The rules, enforced in code by chat.cjs rather than by instructions to the model:
//   1. Diary text never goes to an external provider. The Diary space itself always talks to the
//      Diary sidecar; Diary extras (the preparation step that runs on a chat model, with the Diary
//      message as its prompt) are refused on an external provider.
//   2. Private tools are not offered through an external provider: the `diary` toolbox would read
//      the private journal into a request bound for a third party.
//   3. Project images are not attached automatically (spec-document-understanding: "Do not
//      automatically send sources to a new cloud provider").
//   4. Storage tools cannot reach the Diary folder (#452). Nextcloud Files reads run without an
//      approval card, so `nc_webdav_read_file` on a journal entry would hand it to the provider.
//      Every path-like argument of a storage tool is normalised (URL-decoding, backslashes, ./..,
//      duplicate and trailing slashes, a full DAV URL, case, Unicode form) and refused when it is
//      the Diary folder or inside it. The folder is the storage connection's corpusRoot, the
//      same setting the Diary and storage-client.cjs use, placed under the connection's DAV root.
//      If the folder cannot be worked out, storage tools are refused outright (fail closed).
// Every write still goes through the approval card; nothing here widens what a chat may do.
//
// Separately (#516), `evaluateToolCall`/`validateToolArguments` validate a tool call's arguments
// against an optional registered JSON-schema subset for EVERY provider, not just external ones —
// local models are the primary target. It is off by default (a code flag, not a live preference)
// and a no-op with no registered schema, so it never changes today's behaviour on its own.
//
// The rules themselves are noevia-rs's provider-egress crate (dav-parse.wasm provider_egress), always:
// PROVIDER_EGRESS_IMPL was retired in #1071 and the JS rules (and their copy of the path
// canonicalisation) deleted. This module sends the crate the host's projections of the provider,
// the storage connection and the tool call, and applies its answers. The crate carries no Unicode
// tables, so for a path outside its NFC-inert set (it may be in the Diary), or a provider URL with
// non-ASCII text, '%' or an xn-- label (it may be a trial-terms host), it answers "unknown", and a
// refusal, a fault or a bad reply is no answer at all; every one of those gives the strict result:
// external, refused, private toolbox removed. Warnings are logged once per event and reason and
// carry no input. A missing or tampered module stops startup.

const { createValidator } = require('./stream-guard.cjs');

// Only the fail-closed fallback when the port cannot answer; which toolboxes are private is the crate's rule.
const PRIVATE_TOOLBOXES = new Set(['diary']);

// ── Stream-guard integration (#516) ─────────────────────────────────────────
// An optional, additive check, independent of isExternalProvider: when
// enabled, tool-call arguments for EVERY provider — local/default included,
// which is the common case a local-model harness needs — are validated
// against a restricted JSON-schema subset registered per tool name, using the
// same incremental validator the streaming path uses (stream-guard.cjs). It is
// fed the arguments in one chunk here because by the time a tool call reaches
// this seam its arguments have already fully arrived off the SSE stream; the
// validator itself is what is incremental, not this call site.
//
// OFF by default: this is a code flag, never a live/user preference, and no
// tool has a registered schema yet, so enabling it with no registrations is
// still a no-op. Flipping it on and registering schemas does not touch any
// of the external-provider-only rules in `toolRefusal` below.
// `__setStreamGuardEnabledForTests` only works under the test runner (guarded
// by NODE_TEST_CONTEXT/NODE_ENV=test); production code cannot flip the flag.
let STREAM_GUARD_ENABLED = false;
const TOOL_ARGUMENT_SCHEMAS = Object.create(null);

/** Registers (or clears, with schema=null/undefined) a restricted JSON-schema
 *  for a tool's arguments. Only consulted when STREAM_GUARD_ENABLED is true. */
function setToolArgumentSchema(toolName, schema) {
  if (schema) TOOL_ARGUMENT_SCHEMAS[toolName] = schema;
  else delete TOOL_ARGUMENT_SCHEMAS[toolName];
}

/** Test-only: flips the code-level enable flag. Throws outside a test run
 *  (no NODE_TEST_CONTEXT and NODE_ENV !== 'test') so production code cannot
 *  use this as a back door to a live toggle. */
function __setStreamGuardEnabledForTests(enabled) {
  if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
    throw new Error('__setStreamGuardEnabledForTests is test-only; flip STREAM_GUARD_ENABLED in code instead.');
  }
  STREAM_GUARD_ENABLED = !!enabled;
}

/** First schema violation in a tool's arguments against its registered schema,
 *  or null when the flag is off, no schema is registered, or they validate.
 *  Runs for every provider — this is not one of the external-provider-only
 *  rules below. */
function validateToolArguments(toolName, rawArgs) {
  if (!STREAM_GUARD_ENABLED) return null;
  const schema = TOOL_ARGUMENT_SCHEMAS[toolName];
  if (!schema) return null;
  const validator = createValidator(schema);
  const text = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
  return validator.feed(text) || validator.end();
}

// The only tools the crate ever refuses: Diary tools by name and storage tools by path (rule 4).
// Every other tool is allowed without asking, so a large argument of an unrelated tool cannot trip the
// crate's input bound; tests/server/provider-egress-differential.test.cjs pins this scope against the crate.
const STORAGE_TOOL = /^nc_webdav_/;
const DIARY_TOOL = /^diary_/;

/** The combined tool-call check chat.cjs's `egressToolRefusal` wrapper uses: the stream-guard
 *  schema check first (#516, every provider), then the external-provider-only rules in
 *  `toolRefusal` (Diary/storage, unchanged). Returns the reason the call may not run, or null. */
function evaluateToolCall({ provider, toolName, rawArgs, storage }, opts = {}) {
  const name = String(toolName || '');
  const guardViolation = validateToolArguments(name, rawArgs);
  if (guardViolation) return `ERROR: ${name} arguments failed schema validation (${guardViolation.message}), so it was not run.`;
  return toolRefusal({ provider, toolName: name, rawArgs, storage }, opts);
}

// ── The Rust port ───────────────────────────────────────────────────────────

const defaultLoader = () => require('./dav-parse-wasm.cjs');

const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[provider-egress] ${event} (${reason}); the stricter answer was used`);
}

/** Asks the port; undefined (after a warning) when it throws. Projections are built inside, so a
 *  value that cannot be projected is a fault too. */
function ask(wasmLoader, fn) {
  try {
    return fn(wasmLoader());
  } catch (err) {
    portWarn('provider_egress.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
    return undefined;
  }
}

/** `url` without a user name or password (defence in depth: the port never needs them). Removing
 *  them changes neither the host nor the path the rules read. */
function withoutUserinfo(url) {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.href;
  } catch { return url; }
}

/** What the rules read of a provider row: kind, the external flag, String(baseUrl) and the label
 *  as the messages print it. */
function providerProjection(provider) {
  if (!provider) return null;
  let baseUrl = '';
  try { baseUrl = withoutUserinfo(String(provider.baseUrl)); } catch { baseUrl = ''; } // a throw reads as ''
  return {
    kind: typeof provider.kind === 'string' ? provider.kind : null,
    external: provider.external === true,
    baseUrl,
    label: provider.label ? String(provider.label) : '',
  };
}

/** What the Diary-folder rule reads of a storage connection (no credentials). */
function storageProjection(storage) {
  if (!storage) return null;
  return {
    kind: typeof storage.kind === 'string' ? storage.kind : null,
    corpusRoot: String(storage.corpusRoot || ''),
    baseUrl: withoutUserinfo(String(storage.baseUrl || '')),
  };
}

// projectId and diaryProjectId are compared with ===: JSON-able primitives go as they are, anything
// else as null.
const primitive = (v) => (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : null);

/** True unless the port says the provider's endpoint is not a trial-terms host (unknown: true). */
function isTrialTermsHost(provider, { wasmLoader = defaultLoader } = {}) {
  const port = ask(wasmLoader, (m) => m.providerEgressExternal(providerProjection(provider)));
  if (port && port.trial === false) return false;
  if (port && port.trial === null) portWarn('provider_egress.unknown', 'trial_unknown');
  return true;
}

/** True unless the port says the provider is not external (unknown, a fault: external). */
function isExternalProvider(provider, { wasmLoader = defaultLoader } = {}) {
  const port = ask(wasmLoader, (m) => m.providerEgressExternal(providerProjection(provider)));
  if (port && port.external === false) return false;
  if (port && port.external === null) portWarn('provider_egress.unknown', 'external_unknown');
  return true;
}

/** Why this request may not use this provider (the port's text), or null. A fault refuses. */
function egressRefusal(args, { wasmLoader = defaultLoader } = {}) {
  const { provider, spaceId, projectId, diaryProjectId } = args;
  const port = ask(wasmLoader, (m) => m.providerEgressRefusal(providerProjection(provider),
    typeof spaceId === 'string' ? spaceId : null, primitive(projectId), primitive(diaryProjectId)));
  if (port) return port.refusal;
  return 'This request could not be checked against the external-provider rules, so nothing was sent. Choose a local model, or try again.';
}

/** Removes private toolboxes from the selection, in place, as the port says (indices into the
 *  selection); returns the ids removed, in order. A fault removes every private toolbox. */
function stripPrivateToolboxes(selected, provider, { wasmLoader = defaultLoader } = {}) {
  const port = ask(wasmLoader, (m) => m.providerEgressStrip(providerProjection(provider),
    selected.map((id) => (typeof id === 'string' ? id : null))));
  const indices = port ? port.removed : selected.flatMap((id, k) => (PRIVATE_TOOLBOXES.has(id) ? [k] : []));
  const removed = [];
  for (let k = indices.length - 1; k >= 0; k--) removed.unshift(...selected.splice(indices[k], 1));
  return removed;
}

/** Why this tool call may not run for an external provider (the port's text), or null. `storage` is
 *  the account's storage connection (authService.getStorage). A local provider always gets null; a
 *  fault refuses. External-provider-only: use `evaluateToolCall` for the combined check. */
function toolRefusal(args, { wasmLoader = defaultLoader } = {}) {
  const { provider, toolName, rawArgs, storage } = args;
  const name = String(toolName || '');
  if (!DIARY_TOOL.test(name) && !STORAGE_TOOL.test(name)) return null;
  const projected = providerProjection(provider);
  // A local provider is never refused here, and its (possibly large) arguments are not sent.
  const kind = ask(wasmLoader, (m) => m.providerEgressExternal(projected));
  if (kind && kind.external === false) return null;
  const port = ask(wasmLoader, (m) => m.providerEgressToolRefusal(projected, name,
    typeof rawArgs === 'string' ? rawArgs : rawArgs || {}, storageProjection(storage)));
  if (port) return port.refusal;
  return `ERROR: ${name} was not run: it could not be checked against the external-provider rules, so nothing was sent. Do not retry; tell the user to use a local model for this.`;
}

module.exports = {
  isExternalProvider,
  isTrialTermsHost,
  egressRefusal,
  stripPrivateToolboxes,
  toolRefusal,
  evaluateToolCall,
  providerProjection,
  storageProjection,
  setToolArgumentSchema,
  validateToolArguments,
  __setStreamGuardEnabledForTests,
};
