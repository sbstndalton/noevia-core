'use strict';
// #1636 / #1638: the one path that changes the embedding model, profile or endpoint of project
// retrieval. Nothing else writes the embedding configuration.
//
//   setNext(target)  start building `target`'s vectors beside the active ones. Search keeps
//                    using the active model the whole time.
//   status()         active / next / previous, and how far each one's vectors cover the indexes.
//   switchToNext()   make next active, atomically for this process (one config write; every later
//                    query and index run reads the new target). Refused until next covers every
//                    index unless forced, and, when only the endpoint changes, until the new
//                    endpoint gives the same vectors as the old one. The old target stays as
//                    `previous` with its vectors, for rollback; a `previous` it displaces (one
//                    never finished) loses its vectors. The switch is for the `next` that was
//                    checked: if next changed meanwhile, nothing switches (nextChanged).
//   rollback()       previous becomes active again (its slot is still there; vectors for files
//                    indexed since the switch are filled in by the background pass). A next that
//                    was still being built is abandoned and loses its partial vectors.
//   finish()         drop previous and its vectors.
//   clearNext()      abandon a re-index (its partial vectors are dropped).
//
// The background pass fills, index file by index file, the chunks that have no current vector for
// the active and the next target. It reads only text already stored in each index and writes only
// into that same file. It is paced so it cannot starve chat of the embeddings server: one batch at a
// time and, after each batch, a pause so that the pass is busy at most `duty` of the wall time
// (EMBEDDING_REINDEX_DUTY, default 0.5; the embed sidecar also serves queries in parallel slots).

const { sameIdentity, sameTarget } = require('./embedding-config.cjs');

// Fixed synthetic strings for the same-model endpoint check: never user content.
const PARITY_SAMPLE = [
  'The quick brown fox jumps over the lazy dog.',
  'Quarterly budget review moved to Tuesday afternoon.',
  'function add(a, b) { return a + b; }',
  'Heute regnet es, morgen soll die Sonne scheinen.',
];
const PARITY_MIN_COSINE = 0.995;

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return Number.NaN;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function clamp(v, dflt, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }

/**
 * @param {object} deps
 * @param {object} deps.config   embedding-config.cjs instance
 * @param {object} deps.rag      rag.cjs: listIndexes, indexCoverage, fillMissing, dropIndexSlot, embed
 * @param {object} [deps.env]
 * @param {(ms:number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {(line:string) => void} [deps.log]
 */
function createEmbeddingMigration({ config, rag, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = (line) => console.info(line) }) {
  const duty = clamp(env.EMBEDDING_REINDEX_DUTY, 0.5, 0.05, 1);
  const batch = Math.round(clamp(env.EMBEDDING_REINDEX_BATCH, 4, 1, 16));
  const minPauseMs = Math.round(clamp(env.EMBEDDING_REINDEX_MIN_PAUSE_MS, 50, 0, 60000));
  let running = null; // promise of the pass under way
  let again = false; // a kick arrived while a pass was running
  let lastPass = null; // { at, embedded, failed, error }
  let stopped = false;
  let retryTimer = null;
  const retryMs = Math.round(clamp(env.EMBEDDING_REINDEX_RETRY_MS, 60000, 1000, 3600000));

  const targets = () => { const c = config.get(); return [c.active, c.next].filter(Boolean); };

  async function fillTarget(entry, target, version) {
    let embedded = 0;
    const refused = new Set(); // chunks the server would not embed, skipped for the rest of this pass
    for (;;) {
      if (stopped || config.version() !== version) return { embedded, aborted: true };
      const started = now();
      const r = await rag.fillMissing(entry, target, { limit: batch, exclude: refused, isCurrent: () => !stopped && config.version() === version });
      if (!r) return { embedded, unavailable: true };
      embedded += r.embedded;
      for (const id of r.refused || []) refused.add(id);
      if (!r.attempted || r.remaining === 0) return { embedded, refused: refused.size };
      // Nothing stored and nothing newly refused (e.g. the server returned the wrong width): do not spin.
      if (!r.embedded && !(r.refused || []).length) return { embedded, stuck: true };
      const busy = now() - started;
      await sleep(Math.max(minPauseMs, Math.round(busy * (1 - duty) / duty)));
    }
  }

  async function pass() {
    const version = config.version();
    let embedded = 0, failed = 0, refused = 0, error = null;
    for (const entry of rag.listIndexes()) {
      for (const target of targets()) {
        try {
          const r = await fillTarget(entry, target, version);
          embedded += r.embedded;
          // Refused chunks are reported, not retried in a loop: they stay without a vector, as before.
          refused += r.refused || 0;
          if (r.stuck || r.unavailable) failed += 1;
          if (r.aborted) return { embedded, failed, refused, error, aborted: true };
        } catch (err) {
          // One unreachable server or locked file does not stop the others; the next kick retries.
          failed += 1;
          error = String(err?.message || err).slice(0, 200);
        }
      }
    }
    return { embedded, failed, refused, error };
  }

  /** Starts a background pass (or queues one after the pass under way). Never throws. */
  function kick() {
    if (stopped) return running;
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        const r = await pass().catch((err) => ({ embedded: 0, failed: 1, error: String(err?.message || err) }));
        lastPass = { at: now(), ...r };
        if (r.embedded || r.failed) log(`[embedding] re-index pass: ${r.embedded} vectors stored, ${r.failed} index file(s) incomplete${r.error ? ` (${r.error})` : ''}`);
        // While a re-index is under way, an incomplete pass (server restarting, file locked) is
        // retried later rather than left waiting for the next upload.
        if (r.failed && config.next() && !stopped && !retryTimer) {
          retryTimer = setTimeout(() => { retryTimer = null; kick(); }, retryMs);
          retryTimer.unref?.();
        }
      } while (again && !stopped);
    })().finally(() => { running = null; });
    return running;
  }

  // `ready`: every index has at least as many vectors for `target` as for the active model, so a
  // switch loses nothing (a chunk the server cannot embed stays without a vector under either).
  function coverageOf(target) {
    if (!target) return null;
    const active = config.active();
    let chunks = 0, vectors = 0, unavailable = 0, behind = 0;
    const indexes = rag.listIndexes();
    for (const entry of indexes) {
      const c = rag.indexCoverage(entry, target);
      if (!c) { unavailable += 1; continue; }
      chunks += c.chunks; vectors += c.vectors;
      if (!sameIdentity(target, active)) {
        const a = rag.indexCoverage(entry, active);
        if (a && c.vectors < a.vectors) behind += 1;
      }
    }
    return { indexes: indexes.length, chunks, vectors, unavailable, complete: unavailable === 0 && vectors >= chunks, ready: unavailable === 0 && behind === 0 };
  }

  function status() {
    const c = config.get();
    return {
      active: c.active, next: c.next, previous: c.previous, source: c.source,
      coverage: { active: coverageOf(c.active), next: coverageOf(c.next) },
      running: !!running, lastPass, duty, batch, ...(config.damaged ? { damaged: config.damaged } : {}),
    };
  }

  async function endpointsAgree(a, b) {
    const [va, vb] = [await rag.embed(PARITY_SAMPLE, { kind: 'document', target: a }), await rag.embed(PARITY_SAMPLE, { kind: 'document', target: b })];
    const sims = va.map((v, i) => cosine(v, vb[i]));
    const min = Math.min(...sims);
    return { ok: sims.every(Number.isFinite) && min >= PARITY_MIN_COSINE, minCosine: Number.isFinite(min) ? Math.round(min * 1e5) / 1e5 : null };
  }

  return {
    status,
    kick,
    setNext(target) {
      const before = config.get();
      const c = config.setNext(target);
      // A different next replaces an abandoned one: its partial vectors go.
      if (before.next && !sameIdentity(before.next, c.next) && !sameIdentity(before.next, c.active) && !sameIdentity(before.next, c.previous)) dropEverywhere(before.next);
      kick();
      return status();
    },
    clearNext() {
      const before = config.get();
      config.clearNext();
      if (before.next && !sameIdentity(before.next, before.active) && !sameIdentity(before.next, before.previous)) dropEverywhere(before.next);
      return status();
    },
    async switchToNext({ force = false } = {}) {
      const c = config.get();
      if (!c.next) throw Object.assign(Error('No re-index is under way.'), { status: 409, code: 'noNext' });
      const checked = c.next; // what the checks below are about; the parity check awaits the network
      if (sameIdentity(c.next, c.active)) {
        // Same model and profile on another endpoint: the stored vectors stay valid only if the
        // new endpoint really gives the same vectors.
        const parity = await endpointsAgree(c.active, c.next).catch((err) => ({ ok: false, error: String(err?.message || err) }));
        if (!parity.ok && !force) throw Object.assign(Error('The new embeddings address does not give the same vectors as the current one.'), { status: 409, code: 'parityFailed', parity });
      } else if (!force) {
        const cov = coverageOf(c.next);
        if (!cov.ready) throw Object.assign(Error('The new model has not finished indexing every project yet.'), { status: 409, code: 'notReady', coverage: cov });
      }
      const displaced = config.previous();
      const after = config.switchToNext(checked);
      // An older rollback target is displaced by the new one: its vectors would never be read again.
      dropIfOrphaned(displaced, after);
      log(`[embedding] switched to ${c.next.profile}/${c.next.model}${force ? ' (forced)' : ''}; previous ${c.active.profile}/${c.active.model} kept for rollback`);
      kick();
      return status();
    },
    rollback() {
      const before = config.get();
      const c = config.rollback();
      // The re-index that was under way is abandoned by a rollback: no partly built slot stays behind.
      dropIfOrphaned(before.next, c);
      log(`[embedding] rolled back to ${c.active.profile}/${c.active.model}`);
      kick();
      return status();
    },
    finish() {
      const c = config.get();
      if (!c.previous) throw Object.assign(Error('There is no previous embedding model to remove.'), { status: 409, code: 'noPrevious' });
      const old = c.previous;
      config.finish();
      if (!sameIdentity(old, c.active) && !sameIdentity(old, c.next)) dropEverywhere(old);
      log(`[embedding] removed ${old.profile}/${old.model} and its vectors`);
      return status();
    },
    stop() { stopped = true; if (retryTimer) clearTimeout(retryTimer); retryTimer = null; return running; },
  };

  // Drops `target`'s vectors unless the configuration `now` still holds that model and profile.
  function dropIfOrphaned(target, now) {
    if (target && ![now.active, now.next, now.previous].some((t) => sameIdentity(t, target))) dropEverywhere(target);
  }

  function dropEverywhere(target) {
    for (const entry of rag.listIndexes()) {
      try { rag.dropIndexSlot(entry, target); } catch (err) { log(`[embedding] could not drop ${target.model} from an index (${err.message})`); }
    }
  }
}

module.exports = { createEmbeddingMigration, cosine, PARITY_SAMPLE, PARITY_MIN_COSINE, sameTarget };
