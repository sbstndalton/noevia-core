'use strict';

// The checks before a tool runs (cancelled, enabled, arguments a JSON object), the dedupe key and a
// failed call's text are decided in noevia-rs's tool-exchange crate (in dav-parse.wasm;
// TOOL_EXCHANGE_IMPL, retired in #1071: Rust is always used). The exchange itself (the per-turn
// result cache, serial execution, write invalidation) stays here. Fails closed: a missing or
// tampered module stops startup; a fault in the checks answers with an error and never runs the
// tool, and a fault reading a failed call's error records a fixed error text (never a retry). The
// JS reference is tests/server/oracle/tool-exchange.cjs (fixtures and tests only).

const CHECK_FAULT = 'ERROR: the tool call could not be checked; tool was not run.';
const ERROR_FAULT = 'ERROR: the tool failed and its error could not be read.';

let warnedFault = '';
function warnFault(err) {
  const reason = String(err?.reason || 'unexpected');
  if (warnedFault !== reason) { warnedFault = reason; console.warn(`[tool-exchange] the Rust port failed (${reason}); failing closed`); }
}

/** The checks through the Rust port; any fault answers CHECK_FAULT (the tool is not run). A name
 *  that is not a string is a fault: the JS would coerce it, and two names could share a key. */
function checkCall(call, allowed, signal, wasm) {
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

function callError(name, err, wasm) {
  const message = String(err?.message || err);
  try { return wasm().toolExchangeError(name, message); } catch (fault) {
    warnFault(fault);
    return ERROR_FAULT;
  }
}

// One instance per handleChat invocation, never a module/global or chat cache.
// The caller executes serially and owns approval/audit and wire-result pairing.
function createToolExchange({ allowed, isWrite, signal, wasmLoader = () => require('./dav-parse-wasm.cjs') }) {
  const results = new Map();
  return async function run(call, execute) {
    const checked = checkCall(call, allowed, signal, wasmLoader);
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
      result = callError(call.name, err, wasmLoader);
    }
    results.set(key, { result, write });
    return result;
  };
}

module.exports = { createToolExchange, CHECK_FAULT, ERROR_FAULT };
