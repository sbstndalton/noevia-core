'use strict';
// #1012: the llama.cpp router reads models.ini at start and on GET /models?reload=1. A reload keeps
// every running model whose effective preset is unchanged and UNLOADS any running model whose
// preset changed or was removed, which would cut off a client using it (Diary and other clients do
// not pass through noevia's maintenance gate). So reloadPresets used to refuse whenever anything
// was loaded, and a newly added model stayed invisible to the engine until a manual restart.
//
// Always on since #1071 (it was PRESET_RELOAD_IMPL=wasm): a reload goes ahead with models loaded
// when all of these hold, and otherwise keeps the old refusal:
//   1. noevia knows what the router last read: the models.ini text recorded right after the last
//      reload noevia made (kept in stateFile so a core restart does not forget it), and
//   2. the router's own view (every model's status.preset) is still exactly what it reported right
//      after that reload, so the router has not re-read the file since (restart, other client), and
//   3. Rust's preset-reload check (dav-parse.wasm) finds every loaded model's own section, the
//      [*] section and the preamble unchanged between that text and the file now.
// Anything unknown, unreadable or ambiguous fails closed (no reload with models loaded).

const fs = require('node:fs');
const crypto = require('node:crypto');

// Statuses the router counts as running (server-models.h is_running(): loaded, loading, sleeping);
// a reload unloads any of them whose preset changed.
const LIVE = new Set(['loaded', 'loading', 'sleeping']);
const liveIds = (rows) => (Array.isArray(rows) ? rows : []).filter((m) => LIVE.has(m?.status?.value)).map((m) => m.id);

/** The router's view: model id -> its reported preset text, as a canonical string; null (unknown)
 *  when the listing is not an array or any row lacks a string id or status.preset (#1037). */
function engineView(rows) {
  if (!Array.isArray(rows)) return null;
  const out = {};
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || typeof row.status?.preset !== 'string') return null;
    out[row.id] = row.status.preset;
  }
  return JSON.stringify(Object.keys(out).sort().map((id) => [id, out[id]]));
}

// sbstndalton/noevia#2210: the Rust front also makes reloads (POST /api/models/presets/reload,
// noevia-rs bins/noevia-server model_maint/reload.rs) and records its baseline in this same file. So
// with a state file this guard keeps nothing in memory: every use reads the file, and every write
// takes the lock file `<stateFile>.lock` (created exclusively; a lock older than LOCK_STALE_MS belongs
// to a writer that died and is taken over) and replaces the file atomically (temp file, rename). The
// front does the same, so neither side overwrites the other's half-written state, and a baseline one
// of them records is the other's next baseline. Without a state file (tests) the baseline is in memory.
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 5000;
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function readBaseline(stateFile) {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // `{}` is the tombstone forget() leaves: unknown.
    if (typeof saved?.text === 'string' && typeof saved?.view === 'string') return { text: saved.text, view: saved.view };
  } catch { /* first run, or unreadable: unknown */ }
  return null;
}

async function writeLocked(stateFile, text, { staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS } = {}) {
  const lock = `${stateFile}.lock`;
  const started = Date.now();
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > staleMs) { try { fs.unlinkSync(lock); } catch { /* another writer took it over */ } continue; }
      if (Date.now() - started > waitMs) throw e;
      await pause(20);
    }
  }
  const temporary = `${stateFile}.${process.pid}.tmp`;
  // Removed below only while it is still this writer's: a stale takeover may have made it another writer's.
  const owner = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeSync(fd, owner);
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
    try { if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock); } catch { /* gone */ }
    try { fs.rmSync(temporary, { force: true }); } catch { /* gone */ }
  }
}

function createReloadGuard({ stateFile = null, check = (req) => require('./dav-parse-wasm.cjs').presetReload(req), log = () => {}, lock = {} } = {}) {
  let memory = null; // { text, view }, used only without a state file
  // A write that failed (the lock timed out) may have left an old baseline on disk: unknown until a write succeeds.
  let unsaved = false;
  const current = () => (stateFile ? (unsaved ? null : readBaseline(stateFile)) : memory);
  let pending = Promise.resolve(), generation = 0;
  const persist = (next) => {
    if (!stateFile) { memory = next; return Promise.resolve(true); }
    // Do not trust an older on-disk baseline while this write (or a later queued one) waits.
    unsaved = true;
    const writing = ++generation;
    // Resolves true when this write reached the file, false when it failed (logged).
    pending = pending.catch(() => {}).then(async () => {
      try {
        // Forgetting writes a tombstone: a failed delete cannot expose an old baseline on restart.
        await writeLocked(stateFile, JSON.stringify(next || {}), lock);
        if (writing === generation) unsaved = false;
        return true;
      } catch (e) { unsaved = true; log(`[models] could not save the preset reload baseline; it is treated as unknown: ${e?.message || e}`); return false; }
    });
    return pending;
  };
  /** After a reload noevia made: the text it read just before and the router's rows just after.
   *  `textAfter` is the file re-read after the rows; if it moved, the router may have read either. */
  const record = (textBefore, rows, textAfter) => {
    const view = engineView(rows);
    return persist(typeof textBefore === 'string' && textBefore === textAfter && view !== null ? { text: textBefore, view } : null);
  };
  return {
    record,
    forget() { return persist(null); },
    // The bridge guard's surface (createBridgeReloadGuard), kept by this one so the manager calls
    // one shape: a local reload ticket, its settle as record/forget, and invalidate as forget.
    async begin() { return { ticket: null, local: true }; },
    async settle(_ticket, outcome, { before = null, rows = null, after = null } = {}) {
      return { saved: (await (outcome === 'record' ? record(before, rows, after) : persist(null))) === true };
    },
    /** Before a raw router re-read (calibration, auto-tune): the baseline is unknown from now on.
     *  `saved: false` (the tombstone could not be written; the old baseline may still be on disk
     *  for a restart or the front): the caller must not re-read. */
    async invalidate() { return { saved: (await persist(null)) === true }; },
    known: () => !!current(),
    /** noevia#1863: the models.ini text the router last read, when that is still knowable: the
     *  baseline of noevia's last reload, while the router's own view is unchanged since. A router
     *  that re-read on its own (restart, another client) makes it unknown (null). */
    routerText(rows) {
      const baseline = current();
      if (!baseline) return null;
      const view = engineView(rows);
      return view !== null && view === baseline.view ? baseline.text : null;
    },
    /** May the router reload `currentText` now without unloading any of `loadedIds`? */
    verdict(currentText, rows, loadedIds) {
      const baseline = current();
      if (!baseline) return { safe: false, reason: 'unknown' };
      const view = engineView(rows);
      if (view === null) return { safe: false, reason: 'unknown' };
      if (view !== baseline.view) return { safe: false, reason: 'engine_moved' };
      if (typeof currentText !== 'string') return { safe: false, reason: 'unreadable' };
      try {
        const r = check({ baseline: baseline.text, current: currentText, loaded: loadedIds });
        return r?.safe === true ? { safe: true, reason: 'unchanged' } : { safe: false, reason: r?.reason || 'changed', changed: r?.changed || [] };
      } catch (e) {
        log(`[models] preset reload check failed closed: ${e?.message || e}`);
        return { safe: false, reason: 'check_failed' };
      }
    },
  };
}

// noevia-rs model_maint/reload.rs BaselineAuthority: the Rust front holds the one baseline (the
// state file, its generations, failed writes, open reload tickets) and serves it on its internal
// store listener (127.0.0.1:NOEVIA_PROJECT_STORE_PORT, x-noevia-store-token; never the public
// router) as POST /v1/preset-baseline/{session,begin,settle,invalidate,verdict,router-text}. At boot
// this guard sends `session`; an answer of protocol 1 is bridge mode, where every read and write goes
// to the front and this process never opens the state file. Anything else (an older front's 404, a
// refusal, no answer) keeps the legacy local guard (createReloadGuard on the same file, which the
// front still reads and locks the same way) for this process's life, logged once.
// The web supervisor (noevia build/web-supervisor.sh) reads this marker: a Core that asks the front for
// the baseline needs a front with the rust-preset-baseline capability.
const PRESET_BASELINE_BRIDGE = 'noevia-preset-baseline-bridge/1';
const NODE_BOOT = crypto.randomUUID();
const BRIDGE_TIMEOUT_MS = 5000;
const BRIDGE_PROTOCOL = 1;
const SESSION_TRIES = 3;
const ORIGIN = /^[a-z0-9_-]{1,64}$/;

function createBridgeReloadGuard({ client, legacy = () => createReloadGuard(), log = () => {}, nodeBoot = NODE_BOOT, timeoutMs = BRIDGE_TIMEOUT_MS, retryMs = 500 } = {}) {
  let local = null;
  const legacyGuard = () => (local ||= legacy());
  const call = async (op, body) => {
    if (!client || typeof client.presetBaseline !== 'function') throw new Error('no preset reload baseline client');
    return client.presetBaseline(op, body, { timeoutMs });
  };
  // The authority's start (its epoch) that last saw this process's session. A front restarted on
  // its own forgets the session; a begin or a stale settle that shows another epoch sends it again.
  let epoch = null;
  const decided = (async () => {
    let why = 'no client';
    for (let attempt = 1; client && attempt <= SESSION_TRIES; attempt += 1) {
      try {
        const { status, body } = await call('session', { nodeBoot, protocol: BRIDGE_PROTOCOL });
        if (status === 200 && body?.protocol === BRIDGE_PROTOCOL) { epoch = typeof body.epoch === 'string' ? body.epoch : null; return 'bridge'; }
        why = `the front answered ${status}`;
        break; // an answer (404 from an older front, a refusal) is final; only no answer is retried
      } catch (e) {
        why = `the front did not answer: ${e?.message || e}`;
        if (attempt < SESSION_TRIES) await pause(retryMs);
      }
    }
    log(`[models] the front does not hold the preset reload baseline (${why}); this process keeps its own guard`);
    return 'legacy';
  })();
  // Resolves true once the front answered the session again (epoch updated), false otherwise.
  let resending = null;
  const resession = () => (resending ||= (async () => {
    try {
      const { status, body } = await call('session', { nodeBoot, protocol: BRIDGE_PROTOCOL });
      if (status === 200 && body?.protocol === BRIDGE_PROTOCOL && typeof body.epoch === 'string') {
        if (body.epoch !== epoch) log(`[models] the front restarted (preset reload baseline ${epoch} -> ${body.epoch}); this process's session was sent again`);
        epoch = body.epoch;
        return true;
      }
      failed('session', `answered ${status}`);
    } catch (e) { failed('session', e?.message || e); }
    finally { resending = null; }
    return false;
  })());
  const failed = (op, detail) => log(`[models] the preset reload baseline ${op} did not reach the front; it is treated as unknown: ${detail}`);
  // A write op's answer: { gen, saved } on 200; anything else is logged and read as not saved.
  const write = async (op, body) => {
    try {
      const { status, body: answer } = await call(op, body);
      if (status === 200) return { saved: answer?.saved === true };
      if (status === 409 && answer?.code === 'stale_ticket') {
        // The authority forgot instead (fail closed): settled as unknown, never retried.
        log('[models] the preset reload ticket was stale; the baseline is treated as unknown');
        // Possibly a front that restarted since this process's session: tell the new one.
        await resession();
        return { saved: answer?.saved === true, stale: true };
      }
      failed(op, `answered ${status}`);
    } catch (e) { failed(op, e?.message || e); }
    return { saved: false };
  };
  const originOf = (origin) => (typeof origin === 'string' && ORIGIN.test(origin) && !['rust', 'expired', 'stale'].includes(origin) ? origin : 'node');
  const guard = {
    /** 'bridge' or 'legacy', once the boot session has answered. */
    mode: () => decided,
    /** The authority's epoch this process's session was last sent to (null before or without one). */
    epoch: () => epoch,
    /** A reload ticket: readers see unknown until it is settled (or expires). Throws when the
     *  front gives none: the caller must not reload then. */
    async begin(origin = 'node') {
      if ((await decided) === 'legacy') return legacyGuard().begin(origin);
      const unavailable = (cause) => Object.assign(new Error('The preset reload baseline is unavailable.'), cause ? { cause } : {});
      const once = async () => {
        let status, body;
        try { ({ status, body } = await call('begin', { origin: originOf(origin) })); }
        catch (e) { failed('begin', e?.message || e); throw unavailable(e); }
        if (status !== 200 || typeof body?.ticket !== 'string') { failed('begin', `answered ${status}`); throw unavailable(); }
        return body;
      };
      let body = await once();
      if (typeof body.epoch === 'string' && body.epoch !== epoch) {
        // A front that restarted on its own: the session goes out again, and that session ends
        // every ticket from before it (this one included), so a fresh ticket is taken. Once only:
        // a front whose epoch moves again is not trusted with this reload.
        if (!(await resession())) throw unavailable();
        body = await once();
        if (body.epoch !== epoch) {
          failed('begin', `the front restarted again (${epoch} -> ${body.epoch})`);
          throw unavailable();
        }
      }
      return { ticket: body.ticket, gen: body.gen, epoch: body.epoch, deadlineMs: body.deadlineMs };
    },
    /** After the reload: `record` with the text before, the router's raw rows after and the text
     *  after (the front computes the view and decides), or `forget`. Answers once the write was tried. */
    async settle(ticket, outcome, { before = null, rows = null, after = null } = {}) {
      if ((await decided) === 'legacy' || ticket?.local) return legacyGuard().settle(ticket, outcome, { before, rows, after });
      if (typeof ticket?.ticket !== 'string') return { saved: false };
      const record = outcome === 'record';
      return write('settle', { ticket: ticket.ticket, outcome: record ? 'record' : 'forget', ...(record ? { before: typeof before === 'string' ? before : null, rows: Array.isArray(rows) ? rows : null, after: typeof after === 'string' ? after : null } : {}) });
    },
    async record(before, rows, after) {
      if ((await decided) === 'legacy') return legacyGuard().record(before, rows, after);
      let ticket;
      try { ticket = await guard.begin('node'); } catch { return guard.invalidate('node'); }
      return guard.settle(ticket, 'record', { before, rows, after });
    },
    async forget() { return guard.invalidate('node'); },
    /** Before a raw router re-read: the baseline is unknown from now on. Never throws. */
    async invalidate(origin = 'node') {
      if ((await decided) === 'legacy') return legacyGuard().invalidate(origin);
      return write('invalidate', { origin: originOf(origin) });
    },
    /** Whether a baseline is held at all (the front's verdict says unknown only without one). */
    async known() {
      if ((await decided) === 'legacy') return legacyGuard().known();
      return (await guard.verdict(null, [], [])).reason !== 'unknown';
    },
    async routerText(rows) {
      if ((await decided) === 'legacy') return legacyGuard().routerText(rows);
      try {
        const { status, body } = await call('router-text', { rows: Array.isArray(rows) ? rows : null });
        return status === 200 && typeof body?.text === 'string' ? body.text : null;
      } catch { return null; }
    },
    async verdict(currentText, rows, loadedIds) {
      if ((await decided) === 'legacy') return legacyGuard().verdict(currentText, rows, loadedIds);
      try {
        const { status, body } = await call('verdict', { current: typeof currentText === 'string' ? currentText : null, rows: Array.isArray(rows) ? rows : null, loaded: Array.isArray(loadedIds) ? loadedIds.filter((id) => typeof id === 'string') : [] });
        if (status === 200 && typeof body?.safe === 'boolean' && typeof body?.reason === 'string') {
          if (body.safe === true) return { safe: true, reason: 'unchanged' };
          return Array.isArray(body.changed) ? { safe: false, reason: body.reason, changed: body.changed } : { safe: false, reason: body.reason };
        }
        failed('verdict', `answered ${status}`);
      } catch (e) { failed('verdict', e?.message || e); }
      return { safe: false, reason: 'unknown' };
    },
  };
  return guard;
}

module.exports = { createReloadGuard, createBridgeReloadGuard, engineView, liveIds, LIVE, LOCK_STALE_MS, BRIDGE_TIMEOUT_MS, NODE_BOOT, PRESET_BASELINE_BRIDGE };
