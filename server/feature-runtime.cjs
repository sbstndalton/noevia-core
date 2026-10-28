'use strict';
// Node publishes facts about its actual execution owners; Rust owns selected feature values.
// Session/transport and the read-only feature facade are integrated separately in this pair.
const { configuration: systemOneConfiguration } = require('./system-one-router.cjs');
const DECISION = 'decision:configuration';
const MACHINES = 'inference:machines';
const REASONS = new Map([
  ['Set up the decision service below before enabling this experiment.', 'decision-service-unconfigured'],
  ['The configured decision service does not support choice decisions, so this experiment cannot run.', 'choice-unsupported'],
  ['Not configured. The operator needs to point it at a dedicated local decision-model endpoint, then restart noevia.', 'system-one-unconfigured'],
]);
function unavailable() {
  return Object.assign(new Error('Feature runtime context is unavailable.'), { status: 503, code: 'FEATURE_RUNTIME_CONTEXT_UNAVAILABLE' });
}
function reasonId(value) {
  if (value === null) return null;
  const id = REASONS.get(value);
  if (!id) throw unavailable(); // No freeform URLs, credentials or new reason strings on the wire.
  return id;
}
function createContextCollector({ db, store, decisionSettings, inferenceMachines, env = process.env }) {
  const owners = [[MACHINES, inferenceMachines], [DECISION, decisionSettings]];
  const collect = db.transaction(() => {
    const current = new Map(owners.map(([key]) => [key, store.readFact(key).source]));
    // A refreshed fingerprint alone is insufficient: the ORIGINAL owner must reparse the bytes.
    for (const [key, owner] of owners) {
      if (owner.runtimeContextSource() !== current.get(key)) owner.refreshRuntimeContextSource();
      if (owner.runtimeContextSource() !== current.get(key)) throw unavailable();
    }
    const choice = reasonId(decisionSettings.unavailable('choice'));
    // Preserve the actual index callback's AND truth table; configured decision => null even
    // when the legacy system-one endpoint is absent. This is not an OR/fallback expression.
    const systemOne = reasonId(decisionSettings.unavailable() && systemOneConfiguration(env).reason);
    for (const [key, owner] of owners) {
      if (owner.runtimeContextSource() !== current.get(key) || store.readFact(key).source !== current.get(key)) throw unavailable();
    }
    return Object.freeze({
      sources: Object.freeze({ decision: current.get(DECISION), machines: current.get(MACHINES) }),
      availability: Object.freeze({ stepSupervision: choice, toolGate: choice,
        chatFraming: choice, framingReasoner: choice, systemOneRouting: systemOne }),
    });
  });
  return Object.freeze({ collect() {
    try { return collect(); } catch { throw unavailable(); }
  } });
}
module.exports = Object.freeze({ createContextCollector });
