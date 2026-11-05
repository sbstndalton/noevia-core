'use strict';
// The tune actor's client of the Rust front's auto-tune state owner (noevia-rs
// bins/noevia-server src/autotune_state.rs; crates/server-projects autotune_state.rs). The front is
// the only writer of the state file. This process keeps a working replica of the job and history
// while it runs a tune, and every change reaches the file through here:
//
//   attach  - binds to the state file (named, never a path) and receives the writer token, the
//             current state and the run epoch. Every earlier writer is void from this point.
//   commit  - replaces the job and the history (never the settings), if the writer token and the
//             job revision are current. `register` marks a new job (a new run).
//   begin/end - the start hold: while it is held no other tune, resume or clear starts.
//   sync    - re-reads the owner's state.
//
// Fail closed: an unreachable owner, a refused writer token or a job revision this process has not
// adopted is a `fenced` outcome, never a retry that continues old work. The actor stops its run on
// one (llamacpp-full-autotune.cjs fenceLost) and attaches again only after that run has settled.
// Everything is async and bounded; commits are ordered and coalesced: only the newest state is ever
// sent, one request at a time.

// Release pairing (noevia deploy/tools/assemble-release.sh autotune_state_pairing): this core keeps no
// auto-tune state of its own and writes it only through the front's owner. Keep the quoted literal: the
// release check reads it from this file, and pairs it with a front that serves the same store.
const AUTOTUNE_STATE_CLIENT_MARKER = 'noevia-autotune-state-client/1';
const WRITER = /^[0-9a-f]{32}$/;

class Fenced extends Error {
  constructor(why, state = null) {
    super('Auto-tune state is no longer owned by this process (' + why + ').');
    this.name = 'Fenced';
    this.fenced = true;
    this.why = why;
    this.state = state;
  }
}

/** `call(op, payload)` -> { status, body } (project-store-client autotuneState); `base`: the state file's name. */
function createAutotuneStateClient({ call, base, available = true }) {
  if (typeof call !== 'function' || typeof base !== 'string' || !base) throw new Error('autotune state client needs call and base');
  let writer = null, jobRev = 0, epoch = 0;
  const unreachable = why => new Fenced(why);
  const exchange = async (op, payload) => {
    let r;
    try { r = await call(op, payload); } catch { throw unreachable('unreachable'); }
    return r || { status: 0, body: null };
  };
  const adopt = body => {
    if (Number.isFinite(body?.jobRev)) jobRev = body.jobRev;
    if (Number.isFinite(body?.epoch)) epoch = body.epoch;
  };
  return {
    get writer() { return writer; },
    get jobRev() { return jobRev; },
    get epoch() { return epoch; },
    async attach() {
      const r = await exchange('attach', { base, available });
      if (r.status !== 200 || !WRITER.test(r.body?.writer || '') || !r.body.state || typeof r.body.state !== 'object') throw unreachable('attach refused');
      writer = r.body.writer; adopt(r.body);
      return r.body;
    },
    /** { job, history, register } -> { rev, jobRev, epoch, settings }; throws Fenced (with the owner's state when it sent one). */
    async commit({ job, history, register = false }) {
      if (!writer) throw unreachable('not attached');
      const payload = { writer, jobRev, history, ...(register ? { register: true } : {}) };
      if (job !== undefined) payload.job = job;
      const r = await exchange('commit', payload);
      if (r.status === 409 && r.body?.fenced) throw new Fenced(String(r.body.fenced), r.body.state || null);
      if (r.status !== 200 || !r.body) throw unreachable('commit refused');
      adopt(r.body);
      return r.body;
    },
    /** false: another start, a preparation or a running job holds it. */
    async begin() {
      if (!writer) throw unreachable('not attached');
      const r = await exchange('start', { writer, op: 'begin' });
      if (r.status === 409 && r.body?.busy) return false;
      if (r.status === 409 && r.body?.fenced) throw new Fenced(String(r.body.fenced));
      if (r.status !== 200) throw unreachable('start refused');
      return true;
    },
    async end() {
      if (!writer) return;
      try { await exchange('start', { writer, op: 'end' }); } catch { /* the next attach voids the hold */ }
    },
    /** `settingsOnly`: just the settings map (a cheap read for a scan that checks each row). */
    async sync({ settingsOnly = false } = {}) {
      if (!writer) throw unreachable('not attached');
      const r = await exchange('sync', { writer, ...(settingsOnly ? { settingsOnly: true } : {}) });
      if (r.status === 409 && r.body?.fenced) throw new Fenced(String(r.body.fenced));
      if (r.status !== 200 || !r.body?.state) throw unreachable('sync refused');
      adopt(r.body);
      return r.body;
    },
    /** The job revision and epoch the owner reported last (for the actor's launch). */
    setRun({ jobRev: rev, epoch: e }) { if (Number.isFinite(rev)) jobRev = rev; if (Number.isFinite(e)) epoch = e; },
  };
}

module.exports = { createAutotuneStateClient, Fenced, AUTOTUNE_STATE_CLIENT_MARKER };
