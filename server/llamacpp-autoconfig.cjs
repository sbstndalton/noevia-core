'use strict';
// Rust contains the complete sizing program, including historical ECMAScript access order
// and strict/conservative confirmation. The host transports opaque references and renders API errors.
const { invoke, AutoconfigProtocolError } = require('./llamacpp-autoconfig-host.cjs');
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
function policy(name, args, what, { wasmLoader = defaultLoader } = {}) {
  let reply;
  try { reply = invoke(name, [args], wasmLoader); }
  catch (err) {
    // Raw getter/coercion/iterator exceptions preserve the historical API.
    if (!(err instanceof AutoconfigProtocolError)) throw err;
    reply = { decision: 'refuse', reason: 'impl_refused' };
  }
  if (reply?.decision === 'answer') return reply.value;
  if (name === 'nativeSuggest') return { error: IMPL_SUGGEST_ERROR, code: 'autoconfig_impl', unverified: reply?.reason || 'impl_refused' };
  throw new AutoconfigImplError(what);
}
function suggest(args, options) { return policy('nativeSuggest', args, 'suggestion', options); }
function estimateInputs(args, options) { return policy('nativeInputs', args, 'Will it fit?', options); }
function estimateFootprint(args, options) { return policy('nativeFootprint', args, 'load footprint', options); }
function estimateFootprintForAutotune(args, { wasmLoader = defaultLoader } = {}) {
  try { return invoke('estimateFootprintJs', [args], wasmLoader); }
  catch (err) {
    if (!(err instanceof AutoconfigProtocolError)) throw err;
    throw new AutoconfigImplError('autotune KV ceiling');
  }
}
function isPromptCacheFree(model, options) { return invoke('isPromptCacheFree', [model, options], defaultLoader); }
function cacheRamMibOf(value) { return invoke('cacheRamMibOf', [value], defaultLoader); }
function parseMemoryLimit(value) { return invoke('parseMemoryLimit', [value], defaultLoader); }

module.exports = { isPromptCacheFree, suggest, estimateInputs, estimateFootprint, estimateFootprintForAutotune,
  AutoconfigImplError, cacheRamMibOf, parseMemoryLimit };
// Public compatibility constants come from the same Rust program as the estimators.
for (const name of ['CTX_CANDIDATES', 'LLAMA_CACHE_RAM_DEFAULT_MIB', 'IMAGE_MAX_TOKENS']) {
  let cached;
  Object.defineProperty(module.exports, name, { enumerable: true, configurable: true, set(value) {
    Object.defineProperty(module.exports, name, { value, writable: true, enumerable: true, configurable: true });
  }, get() {
    if (cached === undefined) cached = invoke(name, undefined, defaultLoader);
    return cached;
  } });
}
