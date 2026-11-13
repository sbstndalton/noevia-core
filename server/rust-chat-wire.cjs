'use strict';
// Chat port S7: the Rust front owns the chat turn's SSE wire (noevia-rs bins/noevia-server chat_wire.rs, capability
// rust-chat-wire). A relayed turn (rust-chat-turn.cjs) that names WIRE in WIRE_HEADER is answered here as NDJSON
// under NDJSON_TYPE, with no keep-alive comments. Each line is one JSON value written by JSON.stringify:
//
//   an object   one event; the front writes `data: <the line>\n\n`
//   a string    one whole frame relayed as it came (a Diary turn passes the companion's frames on unchanged,
//               diary-stream.cjs); the front writes the string itself. It ends with its only blank line.
//
// The front writes the event stream from those lines: the headers (SSE_HEADERS), the frames, the `: keep-alive`
// comment every HEARTBEAT_MS from the moment its headers go out (with the first line), and the end. A line is only
// ever framed whole, so a break inside one reaches the client as FAILED_EVENT alone.
//
// Every other caller keeps the event stream written here, byte for byte as before: chat.cjs and diary-stream.cjs write
// their headers, heartbeat and frames through createWire, and index.cjs's failure after the headers through
// failedFrame. So the front's bytes are exactly the bytes this process would have written for the same turn.

// The front capability this module pairs with, for the launch supervisor and assemble-release.
const FRONT_CAPABILITY = 'rust-chat-wire';
// The relay's request header naming the wire the front reads (rust-chat-turn.cjs removes it before the pipeline).
const WIRE_HEADER = 'x-noevia-chat-wire';
const WIRE = 'ndjson/1';
const NDJSON_TYPE = 'application/x-ndjson';
// chat.cjs's event stream, as it has always been written (contract §1.3).
const SSE_HEADERS = Object.freeze({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
const NDJSON_HEADERS = Object.freeze({ 'Content-Type': NDJSON_TYPE, 'Cache-Control': 'no-store' });
const HEARTBEAT_MS = 5000;
const KEEP_ALIVE = ': keep-alive\n\n';
// index.cjs handleRequestScoped's answer for a handler that throws once the headers are out.
const FAILED_EVENT = Object.freeze({ type: 'error', text: 'The request could not be completed. Please retry.' });

/** One event as `kind` writes it. */
function frame(kind, obj) {
  return kind === 'ndjson' ? `${JSON.stringify(obj)}\n` : `data: ${JSON.stringify(obj)}\n\n`;
}

/** One whole event-stream frame (`text`, ending with its blank line) passed on as it came, as `kind` writes it. */
function rawFrame(kind, text) {
  return kind === 'ndjson' ? `${JSON.stringify(String(text))}\n` : String(text);
}

/** The failure after the headers, as `kind` writes it. */
function failedFrame(kind) {
  return frame(kind, FAILED_EVENT);
}

/**
 * The turn's writer on `res`. `kind` is 'ndjson' for the front's relay, else 'sse'.
 *   open()      the headers, and on the event stream the heartbeat every `heartbeatMs` (stopped on close, finish or
 *               stop())
 *   frame(obj)  one event's bytes; raw(text) one whole relayed frame's bytes
 *   stop()      stops the heartbeat
 */
function createWire(res, kind = 'sse', { heartbeatMs = HEARTBEAT_MS, setInterval: every = setInterval, clearInterval: clear = clearInterval } = {}) {
  const k = kind === 'ndjson' ? 'ndjson' : 'sse';
  let beat = null;
  const stop = () => { if (beat !== null) { clear(beat); beat = null; } };
  function open() {
    res.writeHead(200, k === 'ndjson' ? NDJSON_HEADERS : SSE_HEADERS);
    if (k === 'ndjson') return;
    beat = every(() => { if (!res.destroyed) res.write(KEEP_ALIVE); }, heartbeatMs);
    res.once('close', stop);
    res.once('finish', stop);
  }
  return { kind: k, open, stop, frame: (obj) => frame(k, obj), raw: (text) => rawFrame(k, text) };
}

/** The wire a relayed request asked for: WIRE is 'ndjson'; anything else (or nothing) is the event stream. */
function wireOf(value) {
  return value === WIRE ? 'ndjson' : 'sse';
}

module.exports = {
  FRONT_CAPABILITY, WIRE_HEADER, WIRE, NDJSON_TYPE, SSE_HEADERS, NDJSON_HEADERS, HEARTBEAT_MS, KEEP_ALIVE, FAILED_EVENT,
  frame, rawFrame, failedFrame, createWire, wireOf,
};
