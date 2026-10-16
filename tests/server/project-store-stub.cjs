'use strict';
// Test support for sbstndalton/noevia#1264: an in-process stand-in for the Rust front's project
// store (noevia-rs src/project_store.rs), with its protocol (read: version + text; write: a
// compare-and-swap that answers a conflict with the current file) over real files under `root`.
// `writes` lists what it wrote. Synthetic data only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createQueue } = require('../../server/project-store-client.cjs');

const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

/** A client for files `<root>/users/<user>/<file>`; with `flat`, `<root>/<file>` (a bare dir). */
function createStubStore(root, { flat = false } = {}) {
  const writes = [];
  const fileOf = (user, file) => (flat ? path.join(root, file) : path.join(root, 'users', user, file));
  const now = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  return {
    writes,
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
  };
}

/** The `remote` option of rust-projects.cjs createProjectsFile / createFreeChatsFile for a file in a bare dir. */
const remoteFor = (dir) => ({ client: createStubStore(dir, { flat: true }), user: 'stub', queue: createQueue() });

module.exports = { createStubStore, remoteFor };
