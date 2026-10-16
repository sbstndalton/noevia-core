'use strict';
// /api/sampling-settings belongs to the Rust front (sbstndalton/noevia#1071; noevia-rs
// crates/server-sampling-settings): it reads and writes the 'auto_sampling_presets_enabled'
// settings key. Node no longer answers it; a request that reaches Node is a bypass of the front
// and is refused, whatever the method. chat.cjs still reads the key, and the preset selection
// lives in sampling-presets.cjs.

const REFUSAL = Object.freeze({ error: 'Sampling settings are owned by the Rust front.' });

function createSamplingSettingsRoutes({ json }) {
  return async function samplingSettingsRoutes(req, res, { path: p }) {
    if (p !== '/api/sampling-settings') return false;
    json(res, 503, REFUSAL);
    return true;
  };
}

module.exports = { createSamplingSettingsRoutes, REFUSAL };
