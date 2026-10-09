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
// Always on (#1071; it was CHAT_TEMPLATE_CAPS_IMPL=wasm, the default since #1002): before a local
// (native engine) chat sends tools, the model's template is read from the engine's /props
// (`chat_template`, per model, autoload=false so it never loads a model) and analysed; when it
// cannot take tools, they are not sent and the user sees a small notice. When the engine still
// answers with the template/tools error, the round is retried once without tools, with a notice.
// The answer is cached per model. Autotune's final check also sends one realistic chat request
// (#1003). A provider failure shows the upstream's own (sanitised, capped) reason instead of one
// fixed sentence (failureText).
//
// A missing or tampered dav-parse.wasm stops the server at startup (dav-parse-wasm.cjs
// verifyAtStartup). An old CHAT_TEMPLATE_CAPS_IMPL value in the environment is ignored with one
// warning (warnRetiredFlags); the template check and the error text are Rust's alone.

const davParseWasm = require('./dav-parse-wasm.cjs');

const TOOLS_OFF_NOTICE = "This model's chat template can't use tools, so it answers without them.";
const TOOLS_RETRY_NOTICE = "The model's chat template can't use tools; retrying without tools.";

/** `{ kind, reason }` from the Rust classifier, or null when this call could not run it (a trap,
 *  say; startup already proved the module loads). */
function classify(status, text) {
  try { return davParseWasm.providerErrorKind(status, String(text ?? '')); } catch { return null; }
}

// #1016: only these say the tools themselves were refused. A template that raises on the system role
// or on role order without the parser wording is not fixed by dropping tools, so no retry.
const TOOL_SPECIFIC = /unable to generate parser|tools param requires --jinja|does not support tools?\b/i;

/** Whether a failed reply is worth one retry without tools: classified as a template/tools failure
 *  (Rust) and worded as a tool-specific one. */
function toolsRefused(status, text) {
  const detail = String(text ?? '');
  return TOOL_SPECIFIC.test(detail) && classify(status, detail)?.kind === 'template_or_tools_unsupported';
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
  // #1018: one /props lookup per model at a time; concurrent misses share it.
  const inflight = new Map();
  const remember = (model, sendTools, ttl) => {
    cache.delete(model);
    cache.set(model, { sendTools, until: now() + ttl });
    while (cache.size > max) cache.delete(cache.keys().next().value);
  };
  async function lookup(manager, model) {
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
  /** `signal` (the chat's) ends this caller's wait, as unknown (tools allowed); a shared lookup
   *  keeps running for the others. */
  async function allowsTools(manager, model, signal) {
    const hit = cache.get(model);
    if (hit && now() < hit.until) return hit.sendTools;
    let p = inflight.get(model);
    if (!p) {
      p = lookup(manager, model).finally(() => inflight.delete(model));
      inflight.set(model, p);
    }
    if (!signal) return p;
    if (signal.aborted) return true;
    let onAbort;
    const aborted = new Promise((resolve) => { onAbort = () => resolve(true); signal.addEventListener('abort', onAbort, { once: true }); });
    try { return await Promise.race([p, aborted]); } finally { signal.removeEventListener('abort', onAbort); }
  }
  return {
    allowsTools,
    markUnsupported: (model) => remember(model, false, ttlMs),
    forget: (model) => cache.delete(model),
    size: () => cache.size,
  };
}

const toolsGate = createToolsGate();

module.exports = { classify, toolsRefused, failureText, createToolsGate, toolsGate, TOOLS_OFF_NOTICE, TOOLS_RETRY_NOTICE };
