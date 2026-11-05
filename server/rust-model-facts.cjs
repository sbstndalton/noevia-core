'use strict';
// Paired authority: Rust writes model-facts.json; Node never derives an enforcement budget.
const fs = require('node:fs');
const path = require('node:path');
const MODEL_FACTS_OWNER = 'rust-model-facts-v1';
function unavailable() { return Object.assign(Error('Model facts are unavailable.'), { status: 503, code: 'MODEL_FACTS_UNAVAILABLE' }); }
function createNativeFacts({ dataDir, start, storeClient, now = Date.now, configRevision = null, audit = () => {} }) {
  let generation = -1;
  function snapshot() {
    try {
      const bytes = fs.readFileSync(path.join(dataDir, 'model-facts.json'));
      if (bytes.length > 1024 * 1024) throw unavailable();
      const s = JSON.parse(bytes);
      if (s.protocol !== 'model-facts/1' || !start || s.start !== start || !Number.isSafeInteger(s.generation) || s.generation < 0 || s.generation < generation || !Number.isFinite(s.at) || s.at > now() || now() - s.at > 15000) throw unavailable();
      generation = s.generation;
      return s;
    } catch { throw unavailable(); }
  }
  function get() {
    const b = snapshot().budget;
    if (!b || !Number.isFinite(b.budgetGib) || b.budgetGib < 2) throw unavailable();
    return b;
  }
  return { get, budgetGib: () => get().budgetGib, range: () => { const { minGib, maxGib, hostRamGib } = get(); return { minGib, maxGib, hostRamGib }; },
    sidecarNames: () => { const s=snapshot(); if(configRevision && s.configRevision!==configRevision()) throw unavailable(); const names = s.sidecarNames; if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) throw unavailable(); return new Set(names); },
    async save(body, actor) { const result = await storeClient.modelBudget(body); audit('inference.budget', actor, { budgetGib: result.budgetGib }); return result; },
    installed: () => storeClient.modelInstalled(),
    scanRead: () => storeClient.modelScanRead(),
    scanInvalidate: () => storeClient.modelScanInvalidate(),
  };
}
let current = null;
function install(value) { current = value; return value; }
module.exports = { MODEL_FACTS_OWNER, createNativeFacts, install, current: () => current };
