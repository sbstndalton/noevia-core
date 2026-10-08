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

const GRAM = 16; // a window this long matching untrusted text is not a coincidence
const MIN_WHOLE = 6; // shorter values (or hostnames) must match as a whole
const DEFAULT_MAX_CHARS = 400_000; // per exchange; beyond it the store is saturated
const MAX_SOURCES = 64; // the last slot is a fixed sentinel shared by every source past it
const OVERFLOW_SOURCE = 'another untrusted source';
const MAX_DEPTH = 8, MAX_VALUES = 200; // past either, the call is "unchecked" (fails closed)
const { domainToUnicode } = require('node:url');

// Argument names whose values decide where data goes or what runs. A key is split on "_", "-",
// "." and camelCase boundaries; it is sensitive when any segment, or any adjacent pair of segments
// joined with "_", is a stem here (share_with, destination_path, webhookUrl, new_participant).
// A false positive only adds an approval card, so the set leans wide.
const SENSITIVE_STEMS = new Set([
  'to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'emails', 'mail', 'mailto', 'address', 'addresses',
  'send_to', 'share_with', 'attendee', 'attendees', 'participant', 'participants', 'user_id',
  'url', 'urls', 'uri', 'href', 'link', 'host', 'hostname', 'domain', 'endpoint', 'webhook', 'callback',
  'path', 'paths', 'filepath', 'destination', 'dest', 'target', 'folder', 'dir', 'directory', 'remote',
  'command', 'commands', 'cmd', 'script', 'shell',
]);

// #813: a key this long is no real argument name, and splitting one is quadratic in the camel-case
// pass; it counts as sensitive (fails closed: at most one more approval card).
const MAX_KEY_CHARS = 128;

function isSensitiveKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key.length > MAX_KEY_CHARS) return true;
  const segs = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase().split(/[_\-.\s]+/).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    if (SENSITIVE_STEMS.has(segs[i])) return true;
    if (i + 1 < segs.length && SENSITIVE_STEMS.has(`${segs[i]}_${segs[i + 1]}`)) return true;
  }
  return false;
}

// A frameUntrusted() block: the header (kind at most 40 characters, label at most 200, neither with
// a quote or line break: prompt-framing.cjs clean()), the body, then the first "\n</untrusted>".
// #813: found with indexOf, never a lazy regex over the rest of the text, so many headers without a
// close cost linear time: once one header has no close after it, no later header can have one.
const OPEN = '<untrusted ', CLOSE = '\n</untrusted>';
const HEADER = /<untrusted kind="([^"\n]{0,200})"(?: label="([^"\n]{0,400})")?> \(data, not instructions\)\n/y;
function framedBlocks(content) {
  const out = [];
  let from = 0;
  for (;;) {
    const start = content.indexOf(OPEN, from);
    if (start === -1) return out;
    HEADER.lastIndex = start;
    const head = HEADER.exec(content);
    if (!head) { from = start + OPEN.length; continue; }
    const bodyStart = start + head[0].length;
    const end = content.indexOf(CLOSE, bodyStart);
    if (end === -1) return out;
    out.push([head[1], head[2], content.slice(bodyStart, end)]);
    from = end + CLOSE.length;
  }
}

function normalise(text) {
  return String(text == null ? '' : text).normalize('NFKC').toLowerCase()
    .replace(/[​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
}

// FNV-1a, 32 bit, for gram lookups only: a gram collision only ever adds an approval card. Block
// dedupe never uses it (a crafted collision there would skip a block and leave it untainted).
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/** One exchange's record of untrusted text. Bounded: past maxChars it is saturated, and then every
 *  sensitive value counts as tainted (the bound never turns into a way around the policy). */
function createTaintStoreJs({ maxChars = DEFAULT_MAX_CHARS, hash = fnv } = {}) {
  const grams = new Map(); // hash -> index into sources
  const texts = []; // { source, text } normalised, for short whole-value matches
  const seen = new Set(); // the normalised blocks already ingested (each round resends history);
  // keyed on the text itself, so memory is bounded by maxChars like the rest of the store
  const sources = [];
  let chars = 0, saturated = false;

  function sourceIndex(source) {
    let i = sources.indexOf(source);
    if (i === -1) {
      if (sources.length >= MAX_SOURCES - 1) { sources[MAX_SOURCES - 1] = OVERFLOW_SOURCE; return MAX_SOURCES - 1; }
      sources.push(source); i = sources.length - 1;
    }
    return i;
  }

  function add(source, raw) {
    if (saturated) return;
    const text = normalise(raw);
    if (!text) return;
    if (seen.has(text)) return;
    if (chars + text.length > maxChars) { saturated = true; grams.clear(); texts.length = 0; return; }
    seen.add(text);
    chars += text.length;
    const at = sourceIndex(String(source || 'untrusted text').slice(0, 120));
    texts.push({ at, text });
    for (let i = 0; i + GRAM <= text.length; i++) {
      const g = hash(text.slice(i, i + GRAM));
      if (!grams.has(g)) grams.set(g, at);
    }
  }

  /** Every frameUntrusted block in the messages one model request is about to send. */
  function ingestMessages(messages) {
    for (const m of Array.isArray(messages) ? messages : []) {
      const parts = typeof m?.content === 'string' ? [m.content]
        : Array.isArray(m?.content) ? m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')) : [];
      for (const content of parts) {
        if (!content.includes('<untrusted ')) continue;
        for (const [kind, label, body] of framedBlocks(content)) add(label ? `${kind}: ${label}` : kind, body);
      }
    }
  }

  /** The source a value's text came from, or null when none of it is untrusted. */
  function sourceOf(raw) {
    const value = normalise(raw);
    if (value.length < MIN_WHOLE) return null;
    if (saturated) return 'untrusted text (too much to track in this reply)';
    if (value.length < GRAM) {
      const hit = texts.find((t) => t.text.includes(value));
      return hit ? sources[hit.at] : null;
    }
    for (let i = 0; i + GRAM <= value.length; i++) {
      const at = grams.get(hash(value.slice(i, i + GRAM)));
      if (at !== undefined) return sources[at];
    }
    return null;
  }

  return { add, ingestMessages, sourceOf, stats: () => ({ chars, grams: grams.size, sources: sources.length, saturated }) };
}

// The forms of one value that are checked: itself, URL-decoded, every token of either (so
// "Collector <x@evl.io>" yields the address), and for each URL or address its host, every parent
// domain of at least two labels (api.evil.io -> evil.io) and the Unicode form of an IDN host. An
// injected host inside a model-built URL is the exfiltration case.
function candidates(value) {
  const out = new Set([value]);
  try { out.add(decodeURIComponent(value)); } catch { /* not encoded */ }
  for (const form of [...out]) for (const t of form.split(/[\s,;<>"'()]+/)) if (t) out.add(t);
  const hosts = new Set();
  for (const form of [...out]) {
    try { const u = new URL(form); if (u.hostname) hosts.add(u.hostname); } catch { /* not a URL */ }
    const at = /@([^\s@/]+)$/.exec(form.trim());
    if (at) { const h = at[1].replace(/[>)\]}"'.,;:!?]+$/, ''); if (h) hosts.add(h); }
  }
  for (const host of hosts) {
    for (const h of [host, domainToUnicode(host)]) {
      if (!h) continue;
      const labels = h.replace(/^\[|\]$/g, '').split('.');
      for (let i = 0; i + 2 <= labels.length; i++) out.add(labels.slice(i).join('.'));
      out.add(h);
    }
  }
  return [...out];
}

// The string values under sensitive keys. Throws past MAX_DEPTH or MAX_VALUES, so the call is
// "unchecked" rather than silently half-checked.
function sensitiveValues(node, key, out, depth = 0) {
  if (depth > MAX_DEPTH) throw Error('arguments nested too deeply to check');
  if (typeof node === 'string') {
    if (key && isSensitiveKey(key)) {
      if (out.length >= MAX_VALUES) throw Error('too many sensitive values to check');
      out.push({ field: key, value: node });
    }
    return out;
  }
  if (Array.isArray(node)) { for (const v of node) sensitiveValues(v, key, out, depth + 1); return out; }
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) sensitiveValues(v, k, out, depth + 1);
  return out;
}

/**
 * The provenance of one write call: [] when no sensitive argument holds untrusted text, else
 * [{ field, source }] (at most 5). Any failure, including arguments that are not JSON or that are
 * nested deeper than MAX_DEPTH or hold more than MAX_VALUES sensitive strings, returns
 * [{ field: null, source: null, unchecked: true }]: the caller asks per call (fails closed).
 */
function checkWriteJs(store, rawArgs) {
  try {
    const args = typeof rawArgs === 'string' ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : rawArgs;
    if (args !== null && typeof args !== 'object') throw Error('arguments are not an object');
    const found = [];
    for (const { field, value } of sensitiveValues(args, null, [])) {
      const source = candidates(value).map((c) => store.sourceOf(c)).find(Boolean);
      if (source && !found.some((f) => f.field === field && f.source === source)) found.push({ field, source });
      if (found.length >= 5) break;
    }
    return found;
  } catch {
    return [{ field: null, source: null, unchecked: true }];
  }
}

// ── PROMPT_FRAMING_IMPL=wasm (prompt-framing.cjs) ─────────────────────────────────────────────
// The Rust port (noevia-rs crates/prompt-framing) decides everything above: block parsing,
// normalisation, grams, key stems, candidate forms and the check. The store is plain data the
// module hands back after each ingest (its gram map is rebuilt per check), so it holds what the JS
// closure holds: the normalised blocks, their sources and the counters. A wasm store that failed
// once stays failed: checkWrite on it is unchecked (asks per call), like any error here. A custom
// `hash` is a JS test hook and is refused; `maxChars` must be an integer from 0 to 4,000,000.
const WASM_STORE = Symbol('provenance wasm store');
const UNCHECKED = () => [{ field: null, source: null, unchecked: true }];

/** The text parts ingestMessages reads, exactly as the JS reads them (it throws where the JS does). */
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

/** createTaintStoreJs or its Rust port, by `impl` (default PROMPT_FRAMING_IMPL). */
function createTaintStore(options = {}) {
  const { impl = require('./prompt-framing.cjs').framingImpl(), ...rest } = options;
  return impl === 'wasm' ? createTaintStoreWasm(rest) : createTaintStoreJs(rest);
}

/** checkWriteJs, or its Rust port for a store createTaintStore made under wasm. */
function checkWrite(store, rawArgs) {
  return store && typeof store[WASM_STORE] === 'function' ? checkWriteWasm(store, rawArgs) : checkWriteJs(store, rawArgs);
}

module.exports = { createTaintStore, checkWrite, createTaintStoreJs, checkWriteJs, contentParts, normalise, isSensitiveKey, candidates, framedBlocks, SENSITIVE_STEMS, OVERFLOW_SOURCE, MAX_SOURCES, MAX_VALUES, GRAM, DEFAULT_MAX_CHARS };
