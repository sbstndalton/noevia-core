'use strict';
// Rust contains the complete sizing program, including historical ECMAScript access order
// and strict/conservative confirmation. The host transports opaque references and renders API errors.
const { invokeOutcome } = require('./llamacpp-autoconfig-host.cjs');
const defaultLoader = () => require('./dav-parse-wasm.cjs');

class AutoconfigImplError extends Error {
  constructor(what) {
    super('the memory estimate (' + what + ') could not be confirmed by the Rust sizing port, and the JS estimate is not the larger one.');
    this.name = 'AutoconfigImplError';
    this.code = 'autoconfig_impl';
    this.status = 503;
  }
}
const IMPL_SUGGEST_ERROR = 'No settings suggested: the Rust sizing port did not confirm this suggestion and the JS one is not the smaller. Size the context manually and load-test it.';
function raw(name, args, wasmLoader = defaultLoader, what = name) {
  const outcome = invokeOutcome(name, args, wasmLoader);
  if (outcome.fault) throw new AutoconfigImplError(what);
  return outcome.value;
}
function policy(name, args, what, { wasmLoader = defaultLoader } = {}) {
  const outcome = invokeOutcome(name, [args], wasmLoader);
  const reply = outcome.fault ? { decision: 'refuse', reason: 'impl_refused' } : outcome.value;
  if (reply?.decision === 'answer') return reply.value;
  if (name === 'nativeSuggest') return { error: IMPL_SUGGEST_ERROR, code: 'autoconfig_impl', unverified: reply?.reason || 'impl_refused' };
  throw new AutoconfigImplError(what);
}
function suggest(args, options = undefined) { return policy('nativeSuggest', args, 'suggestion', options); }
function estimateInputs(args, options = undefined) { return policy('nativeInputs', args, 'Will it fit?', options); }
function estimateFootprint(args, options = undefined) { return policy('nativeFootprint', args, 'load footprint', options); }
function estimateFootprintForAutotune(args, { wasmLoader = defaultLoader } = {}) {
  return raw('estimateFootprintJs', [args], wasmLoader, 'autotune KV ceiling');
}
function isPromptCacheFree(model, options = undefined) { return raw('isPromptCacheFree', [model, options], defaultLoader); }
function cacheRamMibOf(value) { return raw('cacheRamMibOf', [value], defaultLoader); }
function parseMemoryLimit(value) { return raw('parseMemoryLimit', [value], defaultLoader); }

function suggestJs(args) { return raw('suggestJs', [args], defaultLoader); }
function estimateInputsJs(args) { return raw('estimateInputsJs', [args], defaultLoader); }
function estimateFootprintJs(args) { return raw('estimateFootprintJs', [args], defaultLoader); }
function kvCacheBytes(meta, ctx) { return raw('kvCacheBytes', [meta, ctx], defaultLoader); }
function suggestionIsConservative(js, port) { return raw('suggestionIsConservative', [js, port], defaultLoader); }
function footprintIsConservative(js, port) { return raw('footprintIsConservative', [js, port], defaultLoader); }
function inputsAreConservative(js, port) { return raw('inputsAreConservative', [js, port], defaultLoader); }
module.exports = { isPromptCacheFree, suggest, suggestJs, estimateInputs, estimateInputsJs,
  estimateFootprint, estimateFootprintJs, AutoconfigImplError, suggestionIsConservative,
  footprintIsConservative, inputsAreConservative, cacheRamMibOf, kvCacheBytes, parseMemoryLimit };
// Public compatibility constants come from the same Rust program as the estimators.
for (const name of ['CTX_CANDIDATES', 'KV_TYPE_BYTES', 'LLAMA_CACHE_RAM_DEFAULT_MIB', 'IMAGE_MAX_TOKENS']) {
  let cached;
  Object.defineProperty(module.exports, name, { enumerable: true, configurable: true, set(value) {
    Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true });
  }, get() {
    if (cached === undefined) cached = raw(name, undefined, defaultLoader);
    return cached;
  } });
}
module.exports.estimateFootprintForAutotune = estimateFootprintForAutotune;
