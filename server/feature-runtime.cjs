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
  }, assertSources(sources) {
    try {
      for (const [key, owner] of owners) {
        const expected = key === DECISION ? sources?.decision : sources?.machines;
        if (!/^[0-9a-f]{64}$/.test(expected || '') || owner.runtimeContextSource() !== expected || store.readFact(key).source !== expected) throw unavailable();
      }
    } catch { throw unavailable(); }
  } });
}

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPOCH = /^(?!0{32}$)[0-9a-f]{32}$/;
const LEASE_MS = 15000;
function exact(object, keys) {
  return object && !Array.isArray(object) && typeof object === 'object'
    && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
}
function immutableFacts(input) {
  if (!exact(input, ['env', 'restart', 'browser', 'code', 'trustProxy'])
    || !Array.isArray(input.env) || input.env.length !== 23 || ![...input.env].every(v => v === null || typeof v === 'boolean')
    || !Array.isArray(input.restart) || input.restart.length !== 2 || ![...input.restart].every(v => typeof v === 'boolean')
    || !['available', 'playwright', 'chromium'].includes(input.browser)
    || typeof input.code !== 'boolean' || typeof input.trustProxy !== 'boolean') throw unavailable();
  return Object.freeze({ env: Object.freeze([...input.env]), restart: Object.freeze([...input.restart]),
    browser: input.browser, code: input.code, trustProxy: input.trustProxy });
}
function decodeReply(text, payload) {
  // Feature acknowledgments have a closed, flat ASCII schema. Compact JSON equality also
  // rejects duplicate/escaped duplicate keys rather than accepting JSON.parse's last key.
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2048) throw unavailable();
  let body;
  try { body = JSON.parse(text); } catch { throw unavailable(); }
  const hello = payload.op === 'hello', released = payload.op === 'release';
  const keys = hello ? ['op', 'request', 'start', 'incarnation']
    : ['op', 'request', 'start', 'incarnation', 'boot', 'session', 'sequence', 'status', ...(released ? [] : ['leaseMs'])];
  if (!exact(body, keys) || text !== JSON.stringify(body) || body.op !== payload.op
    || body.request !== payload.request || body.start !== payload.start || !EPOCH.test(body.incarnation)) throw unavailable();
  if (!hello && (body.incarnation !== payload.incarnation || body.boot !== payload.boot
    || body.session !== payload.session || body.sequence !== payload.sequence
    || body.status !== (released ? 'released' : 'ready') || (!released && body.leaseMs !== LEASE_MS))) throw unavailable();
  return body;
}

/** Existing guarded auth DB, existing private store client, and actual owner collector ONLY.
 * No listener/secret/launcher is introduced. Index must wire these SAME instances. */
function createFeatureRuntime({ db, storeClient, collector, bootFacts, start,
  now = () => performance.now(), newId = randomUUID,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  if (!/^[0-9a-f]{32}$/.test(start || '') || typeof storeClient?.featureContext !== 'function') throw unavailable();
  const facts = immutableFacts(bootFacts), boot = newId();
  if (!UUID.test(boot)) throw unavailable();
  const epochQuery = db.prepare("SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=32 THEN value ELSE NULL END AS incarnation FROM settings WHERE key='native:feature-runtime:incarnation'");
  let active = null, candidate = null, pending = null, generation = 0, timer = null;
  let highest = -Infinity, clockFault = false, sessions = 0;
  function clock() {
    const value = now();
    if (clockFault || !Number.isFinite(value) || value < highest) { clockFault = true; active = null; generation++; throw unavailable(); }
    highest = value; return value;
  }
  function retire() { active = null; generation++; }
  function checkEpoch(incarnation) {
    const current = epochQuery.get()?.incarnation;
    if (!EPOCH.test(current || '') || current !== incarnation) { retire(); throw unavailable(); }
  }
  function current() {
    if (!active || clock() >= active.expires) { retire(); throw unavailable(); }
    checkEpoch(active.incarnation);
    return active;
  }
  const readTransaction = db.transaction(fn => {
    const state = current();
    collector.assertSources(state.snapshot.sources);
    const result = fn(db);
    if (result && typeof result.then === 'function') throw unavailable(); // SQLite view cannot span await.
    collector.assertSources(state.snapshot.sources);
    if (clock() >= state.expires || active !== state) { retire(); throw unavailable(); }
    return result;
  });
  function read(fn) { try { return readTransaction(fn); } catch { throw unavailable(); } }
  function uuid() { const id = newId(); if (!UUID.test(id)) throw unavailable(); return id; }
  async function logical(payload) {
    const first = clock(), deadline = first + 2500;
    const wire = JSON.stringify(payload); // Freeze exact bytes AND earliest anchor across every retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - clock();
      if (remaining <= 0) throw unavailable();
      try {
        const text = await storeClient.featureContext(wire, { timeoutMs: Math.min(2500, remaining) });
        if (clock() >= deadline) throw unavailable();
        return { reply: decodeReply(text, payload), expires: first + LEASE_MS };
      } catch { if (attempt === 1 || clock() >= deadline) throw unavailable(); }
    }
    throw unavailable();
  }
  function maintain() {
    if (timer) return;
    timer = setIntervalImpl(() => {
      if (pending) return;
      (active ? renew() : ready()).catch(() => {}); // Failure confers no authority; next tick may recover.
    }, 5000);
    timer?.unref?.();
  }
  function run(kind, action) {
    if (pending) return pending.kind === kind ? pending.promise : Promise.reject(unavailable());
    const operation = { kind, promise: null };
    operation.promise = Promise.resolve().then(action).finally(() => { if (pending === operation) pending = null; });
    pending = operation;
    return operation.promise;
  }
  function ready() {
    if (active) {
      try { return Promise.resolve(read(() => true)); }
      catch { if (active) return renew(); }
    }
    if (pending) return pending.kind === 'ready' ? pending.promise : Promise.reject(unavailable());
    const stamp = ++generation;
    return run('ready', async () => {
      if (stamp !== generation) throw unavailable();
      const hello = await logical({ op: 'hello', request: uuid(), start });
      if (stamp !== generation) throw unavailable();
      const incarnation = hello.reply.incarnation;
      checkEpoch(incarnation);
      if (sessions >= 1024) throw unavailable();
      const session = uuid(); sessions++;
      const snapshot = collector.collect();
      candidate = Object.freeze({ incarnation, boot, session });
      const payload = { op: 'register', request: uuid(), start, ...candidate, sequence: 0, facts, snapshot };
      try {
        const acknowledged = await logical(payload);
        if (stamp !== generation || clock() >= acknowledged.expires) throw unavailable();
        checkEpoch(incarnation);
        active = Object.freeze({ ...candidate, sequence: 0, snapshot, expires: acknowledged.expires });
        maintain();
        return read(() => true);
      } catch {
        // A correlated ACK may have installed a lease whose source snapshot has already
        // changed. Reads still refuse, but keep its identity so ready/maintenance can RENEW
        // that same session instead of conflicting with its known native owner until expiry.
        throw unavailable();
      }
    });
  }
  function renew() {
    return run('renew', async () => {
      const stamp = generation;
      let state = active;
      try {
        state = current();
        const snapshot = collector.collect();
        if (!Number.isSafeInteger(state.sequence + 1)) throw unavailable();
        const payload = { op: 'renew', request: uuid(), start, incarnation: state.incarnation,
          boot, session: state.session, sequence: state.sequence + 1, snapshot };
        const acknowledged = await logical(payload);
        if (generation !== stamp || active !== state || clock() >= state.expires || clock() >= acknowledged.expires) throw unavailable();
        checkEpoch(state.incarnation);
        active = Object.freeze({ ...state, sequence: payload.sequence, snapshot, expires: acknowledged.expires });
        return read(() => true);
      } catch {
        // Failure before a correlated ACK retires the old lease. A newly acknowledged but
        // already stale source snapshot remains non-admissible and can be renewed again.
        if (generation === stamp && active === state) retire();
        throw unavailable();
      }
    });
  }
  async function release() {
    const target = candidate, waiting = pending?.promise;
    retire(); // BEFORE awaiting either outstanding transport or release RPC.
    if (timer) { clearIntervalImpl(timer); timer = null; }
    if (waiting) await waiting.catch(() => {});
    if (!target) return true; // No registration was ever sent; hello alone grants no session.
    const payload = { op: 'release', request: uuid(), start, ...target, sequence: 0 };
    await logical(payload);
    if (candidate === target) candidate = null;
    return true;
  }
  return Object.freeze({ ready, renew, release, read });
}
// No write API and no exported identity or secret. Immutable boot facts stay in this closure.
module.exports = Object.freeze({ createContextCollector, createFeatureRuntime });
