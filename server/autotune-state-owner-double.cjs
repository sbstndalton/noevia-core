'use strict';
// TEST SUPPORT ONLY (never required by production code): an in-process stand-in for the Rust front's
// auto-tune state owner (noevia-rs crates/server-projects autotune_state.rs), so the tune actor's
// tests can run without a front. It implements the same client surface and the same fences
// (writer token, job revision, start hold, run epoch) and persists the state file with the bytes the
// owner writes (JSON.stringify, mode 0600, temporary file and rename), so tests can read and write
// the file as the truth. The real owner is tested in Rust; autotune-state-protocol.test.cjs holds
// both to one recorded conversation.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Fenced } = require('./autotune-state-client.cjs');

function createOwnerDouble(stateFile, { available = true } = {}) {
  let doc = null, writer = null, jobRev = 1, epoch = 1, hold = null, rev = 1;
  const ensure = () => { if (!doc) doc = available ? load() : {}; return doc; };
  const load = () => {
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
    state.history ||= {}; state.settings ||= {};
    return state;
  };
  const persist = () => {
    const tmp = stateFile + '.' + crypto.randomUUID();
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
    rev++;
  };
  const snapshot = () => ({ rev, jobRev, epoch, state: JSON.parse(JSON.stringify(doc)) });
  const double = {
    log: [],
    refuse: null, // a function (op, payload) -> fence reason | null, to inject a refusal
    get writer() { return writer; },
    get jobRev() { return jobRev; },
    get epoch() { return epoch; },
    get state() { return ensure(); },
    async attach() {
      const injected = double.refuse?.('attach', {});
      if (injected) throw new Fenced(injected);
      ensure();
      writer = crypto.randomBytes(16).toString('hex'); hold = null; epoch++; rev++;
      double.log.push(['attach']);
      return { ...snapshot(), writer };
    },
    async commit({ job, history, register = false }) {
      double.log.push(['commit', register]);
      const injected = double.refuse?.('commit', { job, history, register });
      if (injected) throw new Fenced(injected);
      if (!writer) throw new Fenced('not attached');
      doc.history = JSON.parse(JSON.stringify(history));
      if (job === undefined) delete doc.job; else doc.job = JSON.parse(JSON.stringify(job));
      persist();
      if (register) { epoch++; jobRev++; }
      return { rev, jobRev, epoch, settings: doc.settings };
    },
    async begin() {
      double.log.push(['begin']);
      if (!writer) throw new Fenced('not attached');
      if (hold || doc.job?.status === 'running') return false;
      hold = writer; return true;
    },
    async end() { double.log.push(['end']); if (hold === writer) hold = null; },
    async sync({ settingsOnly = false } = {}) {
      double.log.push(['sync']);
      const injected = double.refuse?.('sync', {});
      if (injected) throw new Fenced(injected);
      if (!writer) throw new Fenced('not attached');
      return settingsOnly ? { ...snapshot(), state: { settings: JSON.parse(JSON.stringify(doc.settings)) } } : snapshot();
    },
    setRun({ jobRev: r, epoch: e }) { if (Number.isFinite(r)) jobRev = r; if (Number.isFinite(e)) epoch = e; },
    // ---- what the front does on its own, for tests ----
    /** The owner's settings change (the public settings route). */
    setSettings(model, allowQ5Kv) {
      ensure();
      if (allowQ5Kv) doc.settings[model] = { allowQ5Kv: true }; else delete doc.settings[model];
      persist();
    },
    /** The owner's clear of a finished job. */
    clearJob() { delete doc.job; persist(); jobRev++; },
    /** The owner's resume 'launch' patch over every unfinished item; returns the actor's launch body. */
    launchPatch(reset) {
      const j = doc.job;
      j.status = 'running'; delete j.error; delete j.finishedAt; delete j.failedPhase; delete j.failedStep;
      for (const item of reset) {
        const row = j.models[item.index]; row.status = 'pending'; delete row.error; delete row._foreignYields;
        for (const patch of item.phases) {
          const p = row.phases[patch.index]; p.status = 'pending'; delete p.reason; delete p.restored;
          p.steps = patch.keepSteps === null ? p.steps.map(s => { const { reason, ...rest } = s; return { ...rest, status: 'pending' }; }) : patch.keepSteps.map(i => p.steps[i]);
        }
      }
      persist(); jobRev++; epoch++;
      return JSON.parse(JSON.stringify({ epoch, jobRev, job: doc.job, history: doc.history }));
    },
  };
  return double;
}

module.exports = { createOwnerDouble };
