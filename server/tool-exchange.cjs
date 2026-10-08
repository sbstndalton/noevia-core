'use strict';

// TOOL_EXCHANGE_IMPL=js|wasm (default js; any other value means js, with one warning), read when an
// exchange is created: wasm decides the checks before a tool runs (cancelled, enabled, arguments a
// JSON object), the dedupe key and a failed call's text in noevia-rs's tool-exchange crate (in
// dav-parse.wasm). The exchange itself (the per-turn result cache, serial execution, write
// invalidation) stays here. Fails closed: the flag is in dav-parse-wasm.cjs IMPL_FLAGS (a missing or
// tampered module stops startup); a fault in the checks answers with an error and never runs the
// tool, and a fault reading a failed call's error records a fixed error text (never a retry).

// Canonical JSON, without rebuilding objects (including "__proto__" keys).
// Arrays remain ordered; object keys are sorted recursively.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** The checks before a tool runs: `{ answer }` (the result; the tool is not run) or `{ key }`. */
function checkCallJs(call, allowed, signal) {
  if (signal.aborted) return { answer: 'ERROR: exchange cancelled; tool was not run.' };
  if (!allowed.has(call.name)) return { answer: `ERROR: tool "${call.name}" is not enabled for this project` };
  let args;
  try {
    args = call.args ? JSON.parse(call.args) : {};
  } catch {
    return { answer: `ERROR: tool arguments were not valid JSON: ${String(call.args).slice(0, 200)}` };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { answer: 'ERROR: tool arguments must be a JSON object.' };
  }
  return { key: JSON.stringify([call.name, canonical(args)]) };
}

/** The result a failed call leaves. An uncertain failure must not cause an automatic side-effect retry. */
function callErrorJs(name, err) {
  return `ERROR calling ${name}: ${String(err?.message || err).slice(0, 300)}`;
}

const CHECK_FAULT = 'ERROR: the tool call could not be checked; tool was not run.';
const ERROR_FAULT = 'ERROR: the tool failed and its error could not be read.';

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** TOOL_EXCHANGE_IMPL: 'js' (default) or 'wasm'. */
function toolExchangeImpl(env = process.env) {
  const raw = env.TOOL_EXCHANGE_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[tool-exchange] TOOL_EXCHANGE_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
let warnedFault = '';
function warnFault(err) {
  const reason = String(err?.reason || 'unexpected');
  if (warnedFault !== reason) { warnedFault = reason; console.warn(`[tool-exchange] the Rust port failed (${reason}); failing closed`); }
}

/** The checks through the Rust port; any fault answers CHECK_FAULT (the tool is not run). A name
 *  that is not a string is a fault: the JS would coerce it, and two names could share a key. */
function checkCallWasm(call, allowed, signal, wasm) {
  try {
    if (typeof call.name !== 'string') throw Object.assign(new Error('tool name is not a string'), { reason: 'input' });
    const aborted = !!signal.aborted;
    const enabled = !aborted && allowed.has(call.name);
    // Coerced only where the JS would parse it (after both checks pass).
    const args = !enabled ? null : (call.args ? String(call.args) : null);
    return wasm().toolExchangeCheck(aborted, enabled, call.name, args);
  } catch (err) {
    warnFault(err);
    return { answer: CHECK_FAULT };
  }
}

function callErrorWasm(name, err, wasm) {
  const message = String(err?.message || err);
  try { return wasm().toolExchangeError(name, message); } catch (fault) {
    warnFault(fault);
    return ERROR_FAULT;
  }
}

// One instance per handleChat invocation, never a module/global or chat cache.
// The caller executes serially and owns approval/audit and wire-result pairing.
// `impl`: 'js' or 'wasm' to pin one (tests); default TOOL_EXCHANGE_IMPL.
function createToolExchange({ allowed, isWrite, signal, impl, wasmLoader = () => require('./dav-parse-wasm.cjs') }) {
  const useWasm = (impl || toolExchangeImpl()) === 'wasm';
  const results = new Map();
  return async function run(call, execute) {
    const checked = useWasm ? checkCallWasm(call, allowed, signal, wasmLoader) : checkCallJs(call, allowed, signal);
    if (checked.answer !== undefined) return checked.answer;
    const { key } = checked;
    if (results.has(key)) return results.get(key).result;
    const write = isWrite(call.name);
    const markWriteAttempt = () => {
      // Even a failed write may have mutated state. Denials never get here.
      if (write) for (const [key, entry] of results) if (!entry.write) results.delete(key);
    };
    let result;
    try {
      result = await execute(markWriteAttempt);
    } catch (err) {
      // An uncertain failure must not cause an automatic side-effect retry.
      result = useWasm ? callErrorWasm(call.name, err, wasmLoader) : callErrorJs(call.name, err);
    }
    results.set(key, { result, write });
    return result;
  };
}

module.exports = { createToolExchange, canonical, checkCallJs, callErrorJs, toolExchangeImpl, CHECK_FAULT, ERROR_FAULT };
