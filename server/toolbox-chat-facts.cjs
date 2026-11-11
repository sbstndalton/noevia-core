'use strict';
// What only the chat process knows about the toolboxes, published for the Rust front (sbstndalton/noevia
// row T / O): the built-in boxes this deployment offers (with their tool definitions and which of them
// read), the two facts of this process that decide the coding harness (it is switched on; a repository
// is registered), the connector boxes and the default selection, and the prefill measurements the
// token estimates of the picker are built from.
//
// MCP discovery is NOT here: the front owns it (mcp_discovery_actor.rs). The front composes
//   - GET /api/toolboxes/permitted, GET /api/connectors and the admin directory listing (mcp_discovery.rs), and
//   - GET /api/toolboxes (the picker, toolbox_picker.rs; it used to ask this process over
//     `/internal/toolbox-picker/facts`, a bridge that is gone)
// from this file plus its own discovery, and everything per account at the time of the request.
//
// The file is `toolbox-chat-facts.json`, written by published-snapshot.cjs: atomically, mode 0600, as
// `{ version: 1, kind: 'toolbox-chat-facts', writtenAt, everyMs, ...facts }`, only while the front asks (the
// demand marker), and never trusted by the front once it is older than two intervals - a front that cannot
// prove the file current answers "being prepared", never an old catalogue.
const path = require('node:path');
const published = require('./published-snapshot.cjs');

const SNAPSHOT_FILE = 'toolbox-chat-facts.json';
const SNAPSHOT_KIND = 'toolbox-chat-facts';
/** The publishing interval; the front calls the file stale after two of them. */
const EVERY_MS = 3000;
/** The front reads at most 4 MiB (noevia-rs snapshot.rs MAX_BYTES). */
const MAX_BYTES = 3 * 1024 * 1024;

/** Every string and key well formed: a lone surrogate would be written as `\ud83d`, which the front's JSON reader refuses for the whole file. */
function wellFormed(v) {
  if (typeof v === 'string') return v.toWellFormed();
  if (Array.isArray(v)) return v.map(wellFormed);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toWellFormed(), wellFormed(x)]));
  return v;
}

/**
 * The facts document (no header): pure, from the live objects.
 * @param {object} o
 * @param {() => object[]} o.builtin            toolboxes.cjs builtinToolboxes()
 * @param {string[]} o.defaultToolboxes
 * @param {Iterable<string>} o.connectorBoxes
 * @param {() => boolean} o.harnessEnabled
 * @param {() => boolean} o.hasRepositories
 * @param {{ targetMs: number, stats: () => object[] }} o.prefill
 */
function buildFacts({ builtin, defaultToolboxes, connectorBoxes, harnessEnabled, hasRepositories, prefill }) {
  const doc = {
    builtin: builtin().map((b) => ({
      id: String(b.id), label: b.label, description: b.description, source: b.source,
      ...(b.inApp === undefined ? {} : { inApp: b.inApp }),
      reads: [...(b.reads || [])],
      tools: b.tools || [],
    })),
    defaults: [...defaultToolboxes],
    connectorBoxes: [...connectorBoxes],
    harnessEnabled: !!harnessEnabled(),
    hasRepositories: !!hasRepositories(),
    prefill: { targetMs: prefill.targetMs, models: prefill.stats() },
  };
  const text = JSON.stringify(wellFormed(JSON.parse(JSON.stringify(doc))));
  if (Buffer.byteLength(text) > MAX_BYTES) throw Object.assign(new Error('toolbox facts over cap'), { code: 'FACTS_TOO_LARGE' });
  return JSON.parse(text);
}

/**
 * The demand-driven publisher of the facts.
 * @param {object} o
 * @param {string} o.dataDir
 * @param {() => object} o.facts      buildFacts over the live objects
 * @param {object} [o.demand]         the process's shared demand source (published-snapshot.cjs createDemand)
 */
function createChatFactsPublisher({ dataDir, facts, demand: shared = null, onError = (err) => console.warn(`[toolbox-chat-facts] not published: ${err && err.message}`), everyMs = EVERY_MS, now = Date.now }) {
  const demand = shared || published.createDemand({ dir: dataDir, now });
  const publisher = published.createPublisher({
    file: path.join(dataDir, SNAPSHOT_FILE), kind: SNAPSHOT_KIND, everyMs, demand, onError, now,
    build: () => facts(),
  });
  return Object.freeze({
    start() { if (!shared) demand.start(); publisher.start(); },
    stop() { publisher.stop(); if (!shared) demand.stop(); },
    publish: () => publisher.publish(),
    demand,
  });
}

module.exports = { SNAPSHOT_FILE, SNAPSHOT_KIND, EVERY_MS, MAX_BYTES, buildFacts, createChatFactsPublisher };
