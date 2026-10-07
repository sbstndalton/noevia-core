'use strict';

// #1002: chat-template capabilities and upstream error text, decided by the Rust crates
// chat-template-caps and provider-error (noevia-rs) through dav-parse.wasm.
//
// llama.cpp (router mode) builds a tool-call parser from the model's chat template whenever a
// request carries `tools`. A template with no tool support that raises on unexpected role order
// (the model's chat template in #1002) makes that generation fail, and every chat request with
// tools gets HTTP 400 ("Unable to generate parser for this template… Conversation roles must
// alternate…"). Only the template text decides; model and file names never do.
//
// CHAT_TEMPLATE_CAPS_IMPL=off|wasm (default wasm, the owner's decision for #1002):
//   wasm  Before a local (native engine) chat sends tools, the model's template is read from the
//         engine's /props (`chat_template`, per model, autoload=false so it never loads a model)
//         and analysed; when it cannot take tools, they are not sent and the user sees a small
//         notice. When the engine still answers with the template/tools error, the round is
//         retried once without tools, with a notice. The answer is cached per model.
//         Autotune's final check also sends one realistic chat request (#1003).
//   off   Requests are sent as before.
// Either way, a provider failure shows the upstream's own (sanitised, capped) reason instead of
// one fixed sentence (failureText); when the module cannot run, the old sentences stay.
//
// Unset means wasm. An explicit `wasm` with an unusable module stops the server at startup (#996,
// dav-parse-wasm.cjs IMPL_FLAGS); the default instead logs a warning and runs as `off`, so a
// build without the module behaves as before this change. Any other value is off.

const davParseWasm = require('./dav-parse-wasm.cjs');

const FLAG = 'CHAT_TEMPLATE_CAPS_IMPL';
const TOOLS_OFF_NOTICE = "This model's chat template can't use tools, so it answers without them.";
const TOOLS_RETRY_NOTICE = "The model's chat template can't use tools; retrying without tools.";

let defaultDisabled = false;

const raw = (env) => String(env[FLAG] ?? '').trim().toLowerCase();

/** 'wasm' or 'off'. */
function mode(env = process.env) {
  const value = raw(env);
  if (value === 'wasm') return 'wasm';
  if (value === '') return defaultDisabled ? 'off' : 'wasm';
  return 'off';
}

/** Startup (index.cjs, after dav-parse-wasm verifyAtStartup): when the switch is left at its
 *  default, check the module now; if it is unusable, warn and run as off. Returns the mode. */
function startup(env = process.env, log = console) {
  defaultDisabled = false;
  if (raw(env) !== '') return mode(env);
  try {
    davParseWasm.verifyAtStartup({ DAV_PARSE_WASM: env.DAV_PARSE_WASM, [FLAG]: 'wasm' });
  } catch (err) {
    defaultDisabled = true;
    log.warn(`[chat-template-caps] ${FLAG} defaults to wasm, but dav-parse.wasm is unusable (${err?.reason || 'unexpected'}); running with it off.`);
  }
  return mode(env);
}

/** `{ kind, reason }` from the Rust classifier, or null when the module cannot run. */
function classify(status, text) {
  try { return davParseWasm.providerErrorKind(status, String(text ?? '')); } catch { return null; }
}

/** The chat text for a failed provider reply, or null (the caller keeps its fixed sentences). */
function failureText(status, text) {
  const c = classify(status, text);
  if (!c) return null;
  const { CONTEXT_FULL_TEXT, STREAM_FAILED_TEXT } = require('./chat-context.cjs');
  const r = c.reason;
  switch (c.kind) {
    case 'context_full': return CONTEXT_FULL_TEXT;
    case 'template_or_tools_unsupported': return `The model's chat template cannot handle this request${r ? `: ${r}` : ''}. Try another model, or ask without tools.`;
    case 'backend_down': return `The model backend is not responding${r ? ` (${r})` : ''}. Check that the engine is running, then retry.`;
    case 'bad_request': return `The model provider refused the request${r ? `: ${r}` : ''}. Partial output was preserved.`;
    default: return r ? `The model stream failed: ${r}. Partial output was preserved; check the backend before retrying.` : STREAM_FAILED_TEXT;
  }
}

/** Per-model "may this request carry tools" answers from the engine's /props. Unknown (props
 *  unreachable, no template, module failure) means yes: the behaviour before this change, with
 *  the reactive retry as the safety net. */
function createToolsGate({ ttlMs = 10 * 60 * 1000, unknownTtlMs = 30 * 1000, max = 64, now = Date.now } = {}) {
  const cache = new Map();
  const remember = (model, sendTools, ttl) => {
    cache.delete(model);
    cache.set(model, { sendTools, until: now() + ttl });
    while (cache.size > max) cache.delete(cache.keys().next().value);
  };
  async function allowsTools(manager, model) {
    const hit = cache.get(model);
    if (hit && now() < hit.until) return hit.sendTools;
    let template = null;
    try {
      const r = await manager.props(model);
      if (r?.ok && typeof r.body?.chat_template === 'string') template = r.body.chat_template;
    } catch { /* unknown */ }
    if (template === null) { remember(model, true, unknownTtlMs); return true; }
    let sendTools = true;
    try { sendTools = davParseWasm.templateCaps(template).sendTools; } catch { remember(model, true, unknownTtlMs); return true; }
    remember(model, sendTools, ttlMs);
    return sendTools;
  }
  return {
    allowsTools,
    markUnsupported: (model) => remember(model, false, ttlMs),
    forget: (model) => cache.delete(model),
    size: () => cache.size,
  };
}

const toolsGate = createToolsGate();

module.exports = { FLAG, mode, startup, classify, failureText, createToolsGate, toolsGate, TOOLS_OFF_NOTICE, TOOLS_RETRY_NOTICE };
