'use strict';
// How this harness boots Core the way production does. Core saves projects only through the Rust
// front's project store and is not ready until its feature runtime has registered through that
// store's /v1/features/context under the start id both processes share (server/feature-runtime.cjs).
// The store here is the loopback stand-in (tests/server/project-store-server.cjs); there is no switch
// that skips the readiness barrier. Returns the start id the front must be given as well.
const crypto = require('node:crypto');

function bindProjectStore(env, store) {
  const startId = crypto.randomBytes(16).toString('hex');
  Object.assign(env, {
    NOEVIA_PROJECT_STORE_PORT: String(store.port),
    NOEVIA_PROJECT_STORE_TOKEN: store.token,
    NOEVIA_START_ID: startId,
  });
  env.NOEVIA_CORPUS_ALLOWED_PORTS += `,${store.port}`;
  return startId;
}

module.exports = { bindProjectStore };
