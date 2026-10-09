'use strict';
// Tool-layer provenance policy (#769, features.provenancePolicy, off by default): the hard
// injection boundary. Prompt framing (prompt-framing.cjs) labels untrusted text but cannot stop a
// model from acting on it. This decides from where a WRITE call's arguments came, never from
// anything the model says: when a sensitive argument (a recipient, URL or host, path or command)
// contains text that entered this exchange from an untrusted source, the call may not run under
// "Allow for this chat" and always gets its own approval card, naming the source.
//
// Untrusted text is exactly what the chat loop framed with frameUntrusted(): tool and connector
// results, documents and RAG excerpts, Diary excerpts, brains, task packets, vision descriptions.
// The loop hands this module each model request before it is sent; the framed blocks in it are
// the taint. It can only add friction: an error anywhere here asks per call (fails closed).
//
// The Rust port (noevia-rs crates/prompt-framing in dav-parse.wasm) decides, always (since #1071; it
// was PROMPT_FRAMING_IMPL=wasm). The JS reference is a test oracle only
// (tests/server/oracle/provenance-policy.cjs).

const DEFAULT_MAX_CHARS = 400_000; // per exchange; beyond it the store is saturated

// The Rust port (noevia-rs crates/prompt-framing) decides everything above: block parsing,
// normalisation, grams, key stems, candidate forms and the check. The store is plain data the
// module hands back after each ingest (its gram map is rebuilt per check), so it holds what the JS
// closure holds: the normalised blocks, their sources and the counters. A wasm store that failed
// once stays failed: checkWrite on it is unchecked (asks per call), like any error here. A custom
// `hash` is a JS test hook and is refused; `maxChars` must be an integer from 0 to 4,000,000.
const WASM_STORE = Symbol('provenance wasm store');
const UNCHECKED = () => [{ field: null, source: null, unchecked: true }];

/** The text parts ingestMessages reads, exactly as the JS reference reads them (it throws where the JS does). */
function contentParts(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const parts = typeof m?.content === 'string' ? [m.content]
      : Array.isArray(m?.content) ? m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')) : [];
    for (const content of parts) if (content.includes('<untrusted ')) out.push(content);
  }
  return out;
}

function createTaintStoreWasm({ maxChars = DEFAULT_MAX_CHARS, hash } = {}) {
  const wasm = require('./prompt-framing.cjs').framingWasm();
  if (hash !== undefined) throw new TypeError('a custom hash is only for the JS taint store');
  let { state, stats } = wasm.provenanceNew(maxChars);
  let broken = false;
  const run = (fn) => {
    if (broken) throw new Error('provenance store failed earlier');
    try { return fn(); } catch (err) { broken = true; throw err; }
  };
  return {
    [WASM_STORE]: () => (broken ? null : state),
    add(source, raw) {
      run(() => ({ state, stats } = wasm.provenanceAdd(state, String(source || 'untrusted text'), String(raw == null ? '' : raw))));
    },
    ingestMessages(messages) {
      run(() => { const contents = contentParts(messages); if (contents.length) ({ state, stats } = wasm.provenanceIngest(state, contents)); });
    },
    sourceOf(raw) { return run(() => wasm.provenanceSource(state, String(raw == null ? '' : raw))); },
    stats: () => ({ ...stats }),
  };
}

function checkWriteWasm(store, rawArgs) {
  try {
    const state = store[WASM_STORE]();
    if (!state) return UNCHECKED();
    let text, object = false;
    if (typeof rawArgs === 'string') text = rawArgs;
    else if (rawArgs === null || typeof rawArgs === 'object') { text = JSON.stringify(rawArgs); object = true; }
    if (typeof text !== 'string') return UNCHECKED();
    return require('./prompt-framing.cjs').framingWasm().provenanceCheck(state, text, object);
  } catch {
    return UNCHECKED();
  }
}

/** The Rust port's taint store. */
function createTaintStore(options = {}) {
  return createTaintStoreWasm(options);
}

/** The Rust port's check. A store this module did not make is unchecked (asks per call). */
function checkWrite(store, rawArgs) {
  return store && typeof store[WASM_STORE] === 'function' ? checkWriteWasm(store, rawArgs) : UNCHECKED();
}

module.exports = { createTaintStore, checkWrite, contentParts, DEFAULT_MAX_CHARS };
