'use strict';
// Test support for sbstndalton/noevia#1264: an in-process stand-in for the Rust front's project
// store (noevia-rs src/project_store.rs), with its protocol (read: version + text; write: a
// compare-and-swap that answers a conflict with the current file) over real files under `root`.
// `writes` lists what it wrote. Synthetic data only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createQueue } = require('../../server/project-store-client.cjs');

const sourceOwners = new Map();
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

/** A client for files `<root>/users/<user>/<file>`; with `flat`, `<root>/<file>` (a bare dir). */
function createStubStore(root, { flat = false } = {}) {
  const writes = [];
  const fileOf = (user, file) => (flat ? path.join(root, file) : path.join(root, 'users', user, file));
  const now = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const transcripts = (user) => require('./project-store-server.cjs').localTranscripts(flat ? root : path.join(root, 'users', user));
  return {
    writes,
    // Source-job stand-in for Node route tests. Production has no local journal fallback;
    // Rust integration tests verify the actual writer and Node-readable JSONL format.
    sourceJobsFor(user) {
      const dir = flat ? root : path.join(root, 'users', user);
      const jobs = require('../../server/jobs.cjs').createJobs({ dir, kinds: ['source'], retainMs: 15 * 60000, maxJobs: 16 });
      const requests = new Map();
      return {
        async recover(owner) {
          const previous = sourceOwners.get(dir);
          if (previous !== owner.owner) { sourceOwners.set(dir, owner.owner); jobs.recover(); }
          return { count: 0 };
        },
        async start(_owner, projectId, request) {
          if (requests.has(request)) return requests.get(request);
          if (jobs.list({ kind: 'source', active: true }).length >= 2) throw Object.assign(Error('busy'), { status: 429 });
          const id = jobs.create({ kind: 'source', projectId, capabilities: ['project.sources.write'] });
          jobs.append(id, 'job.started');
          const started = { id, run: crypto.randomUUID() };
          requests.set(request, started);
          return started;
        },
        async abandon(_owner, request) {
          const started = requests.get(request), job = started && jobs.get(started.id);
          if (job && !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) jobs.append(started.id, 'job.interrupted', { reason: 'Source processing was not confirmed.' });
          return { ok: true };
        },
        async progress(_owner, id, _run, stage, n) { jobs.append(id, 'progress', { stage, n }); return { ok: true }; },
        async finish(_owner, id, _run, ok, result, error) {
          jobs.append(id, ok ? 'job.completed' : 'job.failed', ok ? { result } : { error, result });
          return { ok: true };
        },
        async read(projectId, id) {
          let job; try { job = jobs.get(id); } catch { return null; }
          return job?.kind === 'source' && job.projectId === projectId ? job : null;
        },
      };
    },
    async read(user, file) {
      if (!fs.existsSync(path.dirname(fileOf(user, file)))) throw Object.assign(new Error('account no longer exists'), { status: 410 });
      const text = now(fileOf(user, file)); return { version: text === null ? '' : sha(text), text };
    },
    async write(user, file, version, text) {
      const f = fileOf(user, file);
      const cur = now(f);
      const v = cur === null ? '' : sha(cur);
      if (v !== version) return { conflict: true, version: v, text: cur };
      // As the Rust store (store_api.rs): the user's directory is never created; a missing one is
      // a removed account (the client's 410).
      if (!fs.existsSync(path.dirname(f))) throw Object.assign(new Error('account no longer exists'), { status: 410 });
      fs.writeFileSync(`${f}.stub.tmp`, text); fs.renameSync(`${f}.stub.tmp`, f);
      writes.push(file);
      return { ok: true, version: sha(text) };
    },
    async grantContext(user, chat) {
      const [status,body]=require('./project-store-server.cjs').chatMoveOp({chat},path.dirname(fileOf(user,'projects.json')),false);
      if(status!==200)throw Object.assign(Error(body.error),{status,code:body.code});
      return body;
    },
    async chatMove(user, chat, projectId, patch={}) {
      const [status,body]=require('./project-store-server.cjs').chatMoveOp({chat,projectId,...patch},path.dirname(fileOf(user,'projects.json')));
      if(status!==200)throw Object.assign(Error(body.error),{status,code:body.code});
      return{status:200,from:body.from.kind==='free'?null:body.from.id,generation:body.generation};
    },
    // sbstndalton/noevia#1071 slice 4: the transcript ops, as tests/server/project-store-server.cjs
    // answers them (the account's directory; flat: `root`).
    historyRead: (user, chat) => transcripts(user).read(chat),
    historyWrite: (user, chat, history, options) => transcripts(user).write(chat, history, options),
    historyAppendIfLast: (user, chat, message, entry, options) => transcripts(user).appendIfLast(chat, message, entry, options),
    historyRemoveIf: (user, chat, history, options) => transcripts(user).removeIf(chat, history, options),
    // #1071 slice 6: a chat's whole delete, as the stand-in answers it.
    chatDelete: (user, chat, options) => transcripts(user).deleteChat(chat, options),
  };
}

/** The `remote` option of rust-projects.cjs createProjectsFile / createFreeChatsFile for a file in a bare dir. */
const remoteFor = (dir) => ({ client: createStubStore(dir, { flat: true }), user: 'stub', queue: createQueue() });

module.exports = { createStubStore, remoteFor };
