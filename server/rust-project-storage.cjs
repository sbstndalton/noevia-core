'use strict';
// sbstndalton/noevia#2191 round 3 (group rust-project-storage): the Rust front has a storage write
// client (noevia-rs crates/server-storage-reads writes.rs: MKCOL, PUT with If-None-Match/If-Match,
// conditional DELETE, PROPFIND for a file's or folder's state; every attempt in the front's owned
// child process, storage-client.cjs semantics). With it the front finishes a project's lifecycle in
// storage itself:
//
//   - a create with files stores its text files in the project's folder (#687, projects.cjs
//     storeCreateFiles as it was: folder allocated and attached, create-only writes, a refused file
//     stays noevia's plain-named copy), then queues their index jobs under the stored names;
//   - a delete's empty-folder sweep (project-sweep.cjs sweepRemote) is a `sweep` job the front runs
//     from the user's index outbox after it answers.
//
// So this process claims, recovers and counts only CORE_KINDS in the outbox (rust-index-outbox.cjs);
// FRONT_KINDS are the front's and are never touched here, which keeps one executor per job. No route
// moves with this group (OWNED_ROUTES is empty): the pairing is the job split, which an unpaired
// release would break (an old front's sweeps would never run; an old core would run the front's).
// projects.cjs keeps storeCreateFiles and project-sweep.cjs for the paths still here (the orphan
// attachments reaper's deleteProject; the conversation import is the front's since round 4).
const OWNED_ROUTES = Object.freeze(new Set());
// `unindex` (round 3, rust-project-files.cjs): a removed source file's RAG rows.
const CORE_KINDS = Object.freeze(['index', 'unindex']);
const FRONT_KINDS = Object.freeze(['sweep']);

module.exports = { OWNED_ROUTES, CORE_KINDS, FRONT_KINDS };
