'use strict';

// #1431: the Nextcloud Login Flow v2 state that is waiting for the person to approve sign-in in
// their browser. It used to live in a process-local Map, so a web restart mid sign-in answered
// "sign-in expired". It is now kept on disk, with the parts that let someone act on the flow (the
// poll token, the poll endpoint and the origin sign-in started at) sealed with the credential key,
// bound to the owning account the same way a saved storage secret is (secrets.encrypt, enc:v2).
//
// Only what the poll needs is kept: { flowId, userId, expires } in clear (to find and expire the
// entry) and one sealed box with { endpoint, token, origin, nonce }. A flow lives for its TTL (10 minutes
// by default) and no longer; expired and undecryptable entries are dropped on load and on every
// write. A flow that no key can open is treated as missing, so the person starts again cleanly.
//
// The object behaves like the Map the routes used before: get, set, delete, size, iteration.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const SEALED_FIELDS = ['endpoint', 'token', 'origin'];

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {object} opts
 * @param {string} [opts.file]      JSON file to persist to; omitted = memory only (tests)
 * @param {object} [opts.secrets]   the credential store (createSecretStore): encrypt/decrypt. Required with a file.
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs]
 * @param {(msg: string) => void} [opts.warn]
 */
function createNextcloudFlowStore({ file = null, secrets = null, now = Date.now, ttlMs = DEFAULT_TTL_MS, warn = console.warn } = {}) {
  if (file && !secrets) throw new Error('a persisted Nextcloud flow store needs the credential store to seal the poll token');
  // flowId -> { userId, expires, sealed } (persisted form) or { userId, expires, ...fields } (memory only)
  const records = new Map();

  const seal = (userId, fields) => (secrets ? secrets.encrypt(JSON.stringify(fields), userId) : null);
  function open(record) {
    if (!secrets) return record.fields;
    try { return JSON.parse(secrets.decrypt(record.sealed, record.userId)); } catch { return null; }
  }
  function toView(flowId, record) {
    const fields = open(record);
    if (!fields || [...SEALED_FIELDS, 'nonce'].some((k) => typeof fields[k] !== 'string')) return null;
    return { flowId, userId: record.userId, expires: record.expires, ...fields };
  }

  function persist() {
    if (!file) return;
    const out = {};
    for (const [flowId, r] of records) out[flowId] = { userId: r.userId, expires: r.expires, sealed: r.sealed };
    writeAtomic(file, { version: 1, flows: out });
  }

  function load() {
    if (!file) return;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e && e.code !== 'ENOENT') warn(`[nextcloud] pending sign-ins could not be read; they are dropped (${e.code || e.name})`);
      return;
    }
    const flows = raw && typeof raw === 'object' && raw.flows && typeof raw.flows === 'object' ? raw.flows : {};
    for (const [flowId, r] of Object.entries(flows)) {
      if (!r || typeof r.userId !== 'string' || typeof r.expires !== 'number' || typeof r.sealed !== 'string') continue;
      records.set(flowId, { userId: r.userId, expires: r.expires, sealed: r.sealed });
    }
    prune();
  }

  /** Drops expired flows and any that no key can open. Returns true when something was removed. */
  function prune() {
    let removed = false;
    const at = now();
    for (const [flowId, r] of records) {
      if (r.expires < at || (secrets && !open(r))) { records.delete(flowId); removed = true; }
    }
    return removed;
  }

  // Each set() gets its own nonce: a poll that was on its way when the flow was cancelled (or
  // replaced) can tell that the flow it holds is no longer the stored one (see the routes).
  function sealedRecord(flow) {
    const userId = String(flow.userId);
    const nonce = crypto.randomBytes(16).toString('hex');
    const fields = { endpoint: flow.endpoint, token: flow.token, origin: flow.origin, nonce };
    if (secrets) return { userId, expires: flow.expires, sealed: seal(userId, fields) };
    return { userId, expires: flow.expires, fields };
  }

  load();

  return {
    ttlMs,
    get size() { prune(); return records.size; },
    get(flowId) {
      const r = records.get(String(flowId));
      if (!r) return undefined;
      if (r.expires < now()) { records.delete(String(flowId)); persist(); return undefined; }
      return toView(String(flowId), r) || undefined;
    },
    set(flowId, flow) {
      records.set(String(flowId), sealedRecord(flow));
      persist();
      return this;
    },
    delete(flowId) {
      const existed = records.delete(String(flowId));
      if (existed) persist();
      return existed;
    },
    /** Drops every flow that is expired or owned by `userId` (a new sign-in replaces the old one). */
    dropExpiredOr(userId) {
      const at = now();
      let removed = false;
      for (const [flowId, r] of records) {
        if (r.expires < at || r.userId === userId || (secrets && !open(r))) { records.delete(flowId); removed = true; }
      }
      if (removed) persist();
    },
    [Symbol.iterator]() {
      const views = [];
      for (const [flowId, r] of records) {
        if (r.expires < now()) continue;
        const view = toView(flowId, r);
        if (view) views.push([flowId, view]);
      }
      return views[Symbol.iterator]();
    },
  };
}

module.exports = { createNextcloudFlowStore, DEFAULT_TTL_MS };
