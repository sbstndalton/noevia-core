'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS references of the checks before a tool runs, the canonical-JSON dedupe key
// and a failed call's text, kept only so tools/gen-tool-exchange-fixtures.cjs can regenerate
// tests/fixtures/tool-exchange.v1.json and the differential tests can compare them with
// dav-parse.wasm (sbstndalton/noevia-rs crates/tool-exchange). Production decides through the Rust
// module alone (server/tool-exchange.cjs).
// Moved here unchanged from server/tool-exchange.cjs canonical, checkCallJs and callErrorJs (createToolExchangeJs
// is the old exchange loop with the JS checks, kept for the whole-session comparisons).

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

/** The whole exchange as it ran with the JS checks (TOOL_EXCHANGE_IMPL=js), for the differential tests
 *  that compare complete sessions with server/tool-exchange.cjs. Same loop as the production one. */
function createToolExchangeJs({ allowed, isWrite, signal }) {
  const results = new Map();
  return async function run(call, execute) {
    const checked = checkCallJs(call, allowed, signal);
    if (checked.answer !== undefined) return checked.answer;
    const { key } = checked;
    if (results.has(key)) return results.get(key).result;
    const write = isWrite(call.name);
    const markWriteAttempt = () => {
      if (write) for (const [key, entry] of results) if (!entry.write) results.delete(key);
    };
    let result;
    try {
      result = await execute(markWriteAttempt);
    } catch (err) {
      result = callErrorJs(call.name, err);
    }
    results.set(key, { result, write });
    return result;
  };
}

module.exports = { canonical, checkCallJs, callErrorJs, createToolExchangeJs };
