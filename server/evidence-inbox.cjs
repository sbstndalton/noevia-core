'use strict';
// sbstndalton/noevia#2210: how this process's evidence producers reach the evidence store's one writer, the
// Rust front (noevia-rs bins/noevia-server model_maint/evidence_live.rs `drain_inbox`). A record (a chat's
// vision probe or MTP acceptance, a benchmark run, an auto-tune result, the recheck route) or an import request
// (a finished download) is one file in `evidence-inbox-<hash>/`, written whole under a `.tmp` name and renamed to
// `.json`, so the front never reads half an entry. The front applies entries oldest first and deletes each; the
// names sort by time. The inbox is bounded (a front that is not running does not let it grow without end) and an
// entry is small. Producers are best effort, as they were: a full inbox drops the record. A failed apply is tried
// again a bounded number of times, then discarded with a log line (the front's side).
//
//   { "kind": "record", "model": "<name>", "record": { category, result, value, suite, source, limitations, ... } }
//     A non-reported record also carries "identityHash" and "at", computed when it was recorded: the front files it
//     only under that identity, and discards one with no hash (left by a rollback) or a hash no longer live.
//   { "kind": "import", "model": "<name>", "checkpoint": "<org/repo[:quant]>" | null }
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_ENTRIES = 200;
const MAX_BYTES = 64 * 1024;
const MAX_MODEL = 200;

/** `evidence-<hash>` -> `evidence-inbox-<hash>`, beside it. */
const inboxDirFor = (evidenceDir) => path.join(path.dirname(evidenceDir), path.basename(evidenceDir).replace(/^evidence-/, 'evidence-inbox-'));

function createInbox({ dir, maxEntries = MAX_ENTRIES, log = (m) => console.warn(m), now = () => Date.now() }) {
  /** Queues one entry; the file name (a handle for wait), or null when it was not queued. */
  function put(entry) {
    try {
      if (typeof entry?.model !== 'string' || !entry.model || entry.model.length > MAX_MODEL) return null;
      const text = JSON.stringify(entry);
      if (Buffer.byteLength(text) > MAX_BYTES) return null;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length >= maxEntries) { log('[evidence] the inbox is full; a record was dropped (is the front running?)'); return null; }
      const name = `${String(now()).padStart(15, '0')}-${crypto.randomBytes(4).toString('hex')}.json`;
      const temporary = path.join(dir, name.replace(/\.json$/, '.tmp'));
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, path.join(dir, name));
      return name;
    } catch (e) { log(`[evidence] could not queue a record: ${e?.message || e}`); return null; }
  }
  const pending = (name) => !!name && fs.existsSync(path.join(dir, name));
  /** Waits (bounded) until the front has applied the entry. true: applied; false: still queued. */
  async function applied(name, { timeoutMs = 3000, stepMs = 50 } = {}) {
    const until = Date.now() + timeoutMs;
    while (pending(name)) {
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    return true;
  }
  return { put, pending, applied, dir };
}

module.exports = { createInbox, inboxDirFor, MAX_ENTRIES, MAX_BYTES };
