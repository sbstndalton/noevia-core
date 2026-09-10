'use strict';

// Canonical JSON, without rebuilding objects (including "__proto__" keys).
// Arrays remain ordered; object keys are sorted recursively.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// One instance per handleChat invocation, never a module/global or chat cache.
// The caller executes serially and owns approval/audit and wire-result pairing.
function createToolExchange({ allowed, isWrite, signal }) {
  const results = new Map();
  return async function run(call, execute) {
    if (signal.aborted) return 'ERROR: exchange cancelled; tool was not run.';
    if (!allowed.has(call.name)) return `ERROR: tool "${call.name}" is not enabled for this project`;
    let args;
    try {
      args = call.args ? JSON.parse(call.args) : {};
    } catch {
      return `ERROR: tool arguments were not valid JSON: ${String(call.args).slice(0, 200)}`;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return 'ERROR: tool arguments must be a JSON object.';
    }
    const key = JSON.stringify([call.name, canonical(args)]);
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
      result = `ERROR calling ${call.name}: ${String(err?.message || err).slice(0, 300)}`;
    }
    results.set(key, { result, write });
    return result;
  };
}

module.exports = { createToolExchange };
