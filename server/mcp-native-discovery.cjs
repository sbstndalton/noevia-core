'use strict';
// This process's client of MCP discovery, which is the Rust front's (sbstndalton/noevia row T,
// noevia-rs bins/noevia-server mcp_discovery_actor.rs): connecting to every configured server, listing
// and converting its tools, binding the curated boxes, the refresh cadence, failure backoff and the
// coalescing of callers all happen there. This asks over the internal store (PROJECT_STORE,
// `POST /v1/mcp/discovery`) and checks what comes back before mcp-wiring.cjs lets it stand in for
// `mcpState`.
//
// Fails closed. A front that cannot answer (store unreachable, 503, a reply of another shape) throws,
// and the wiring then offers no tools and no boxes: a tool is never called on the strength of a list
// the front no longer stands behind, and a malformed reply never partly applies.
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isTool = (t, name) => isObject(t) && t.type === 'function' && isObject(t.function) && t.function.name === name
  && typeof t.function.description === 'string' && isObject(t.function.parameters);

/** Throws unless `snap` is a snapshot of the shape the front writes. */
function validate(snap) {
  const bad = (why) => { throw Object.assign(new Error(`MCP discovery answered something unexpected (${why}).`), { status: 502, code: 'MCP_DISCOVERY_SHAPE' }); };
  if (!isObject(snap)) bad('not an object');
  if (snap.unchanged === true) {
    if (!Number.isSafeInteger(snap.generation)) bad('generation');
    return snap;
  }
  if (snap.version !== 1 || !Number.isSafeInteger(snap.generation) || snap.generation < 0) bad('version or generation');
  if (typeof snap.enabled !== 'boolean') bad('enabled');
  if (snap.error !== null && typeof snap.error !== 'string') bad('error');
  for (const k of ['discoveredAt', 'failedAt', 'remoteFailStreak']) if (!Number.isFinite(snap[k])) bad(k);
  if (!Array.isArray(snap.servers) || !Array.isArray(snap.offers) || !Array.isArray(snap.boxes)) bad('lists');
  const ids = new Set();
  for (const s of snap.servers) {
    if (!isObject(s) || typeof s.id !== 'string' || typeof s.url !== 'string' || typeof s.auth !== 'string' || ids.has(s.id)) bad('server');
    ids.add(s.id);
    if (s.error !== null && typeof s.error !== 'string') bad('server error');
    if (!Number.isFinite(s.discoveredAt) || !Number.isFinite(s.toolCount)) bad('server counts');
  }
  for (const o of snap.offers) {
    if (!isObject(o) || typeof o.name !== 'string' || !NAME.test(o.name) || typeof o.server !== 'string' || !ids.has(o.server)) bad('offer');
    if (o.readOnly !== null && typeof o.readOnly !== 'boolean') bad('offer readOnly');
    if (!isTool(o.tool, o.name)) bad('offer tool');
  }
  for (const b of snap.boxes) {
    if (!isObject(b) || typeof b.id !== 'string' || typeof b.server !== 'string' || !Array.isArray(b.tools)) bad('box');
    if (b.tools.some((t) => !isTool(t, t && t.function && t.function.name))) bad('box tool');
  }
  return snap;
}

/**
 * @param {{ mcpDiscovery(opts: { force: boolean, generation: number|null }): Promise<object> }} broker  project-store-client.cjs
 */
function createNativeDiscovery({ broker }) {
  if (!broker || typeof broker.mcpDiscovery !== 'function') throw new TypeError('the Rust front\'s MCP discovery is required');
  return Object.freeze({
    async discover({ force = false, generation = null } = {}) {
      return validate(await broker.mcpDiscovery({ force: !!force, generation }));
    },
  });
}

module.exports = { createNativeDiscovery, validate };
