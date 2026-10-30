'use strict';
// sbstndalton/noevia#2190 close-out: the Rust front answers GET /api/auto-roles (noevia-rs
// bins/noevia-server auto_roles_routes.rs, capability rust-auto-roles) from the account's
// auto-roles.json (which this process still writes) and from what only this process knows, published
// here as auto-roles-snapshot.json (published-snapshot.cjs): the served model catalogue (each
// model's name and missingFile, or null when the engine cannot be read), the chat roles other
// machines serve and the models those machines serve that this catalogue does not list (#1840,
// #1849, #1855). The front reads it on every request; a file older than two intervals reads as an
// engine that cannot be reached (nothing reported missing, no machine models). Like the health
// snapshot it is published only while a signed-in page has asked in the last minute (the front's
// demand marker, published-snapshot.cjs), so an idle installation does not read the engines.
//
// The PUT stays here: a save warms the roles in the engine (ensureRolesLoaded), which is chat-live.
// Only the GET is refused, before authentication, so a stale route table cannot make two processes
// answer it.
const path = require('node:path');
const { createPublisher, intervalFrom } = require('./published-snapshot.cjs');

const ROUTE_REFUSAL = Object.freeze({ error: 'The auto-roles read is owned by the Rust front.', code: 'RUST_AUTO_ROLES_OWNED' });
const SNAPSHOT_FILE = 'auto-roles-snapshot.json';
const KIND = 'auto-roles';
/** The timer; a model or role write republishes at once (models.cjs invalidateModelReads). */
const DEFAULT_EVERY_MS = 15000;

const owned = (method, pathname) => method === 'GET' && pathname === '/api/auto-roles';

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/**
 * The state: `catalogue` is null (unknown) or `[{ name, missingFile }]`; `machineRoles` the chat roles
 * another machine serves; `machineModels` the rows of those machines' models this catalogue lacks.
 * @param {{ servedCatalogue: () => Promise<object[]|null>, remoteRoles: () => object, machineModels: () => object[] }} o
 */
async function autoRolesState({ servedCatalogue, remoteRoles, machineModels }) {
  const rows = await servedCatalogue();
  const catalogue = Array.isArray(rows)
    ? rows.filter((m) => m && typeof m.name === 'string').map((m) => ({ name: m.name, missingFile: !!m.missingFile }))
    : null;
  let machineRoles = [];
  try { machineRoles = Object.keys(remoteRoles() || {}); } catch { machineRoles = []; }
  let onMachines = [];
  try { onMachines = machineModels() || []; } catch { onMachines = []; }
  if (onMachines.length) {
    // #1855: a name this machine's served catalogue lists is answered here, so it is left out of the list.
    const served = new Set((Array.isArray(rows) ? rows : []).map((m) => m?.name));
    onMachines = onMachines.filter((r) => !served.has(r?.model));
  }
  return { catalogue, machineRoles, machineModels: onMachines };
}

/** The publisher of auto-roles-snapshot.json. `watch(service)` republishes whenever model reads are invalidated. */
function createAutoRolesPublisher({ dataDir, servedCatalogue, remoteRoles, machineModels, demand = null, env = process.env, onError = (err) => console.warn('[auto-roles] could not publish the snapshot:', err?.message || err) }) {
  const everyMs = intervalFrom(env.AUTO_ROLES_PUBLISH_MS, DEFAULT_EVERY_MS);
  const file = path.join(dataDir, SNAPSHOT_FILE);
  const publisher = createPublisher({ file, kind: KIND, everyMs, build: () => autoRolesState({ servedCatalogue, remoteRoles, machineModels }), onError, demand });
  return {
    ...publisher,
    everyMs,
    file,
    /** A write that can change the catalogue (a load, a delete, a role save) drops the shared read: publish again. */
    watch(service) {
      if (!service || typeof service.invalidateModelReads !== 'function') return;
      const invalidate = service.invalidateModelReads.bind(service);
      service.invalidateModelReads = (...args) => { try { return invalidate(...args); } finally { publisher.changed(); } };
    },
  };
}

module.exports = { ROUTE_REFUSAL, SNAPSHOT_FILE, KIND, owned, refuseOwned, autoRolesState, createAutoRolesPublisher };
