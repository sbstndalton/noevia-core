'use strict';
// #1071: Rust owns incremental schema validation and correction projection.
// The original JS parser is retained only as a frozen test oracle.

class SchemaViolation extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'SchemaViolation';
    this.path = path;
  }
}

class GuardAbortError extends Error {
  constructor(message) {
    super(message || 'stream-guard: aborted');
    this.name = 'GuardAbortError';
  }
}

class CorrectionFailedError extends Error {
  constructor(message, violation) {
    super(message);
    this.name = 'CorrectionFailedError';
    this.violation = violation;
  }
}

function streamGuardImpl() { return 'wasm'; }

let davParseWasm = null;
const guardWasm = () => davParseWasm || (davParseWasm = require('./dav-parse-wasm.cjs'));

/**
 * IncrementalValidator decided by the Rust port. Same methods and results; the first violation is
 * a SchemaViolation and, as in the JS, the same object on every later call. Throws a
 * DavParseError when the module cannot answer (the validator is then unusable).
 */
class WasmValidator {
  constructor(schema, options = {}) {
    const wasm = guardWasm();
    this.schemaBytes = wasm.streamGuardSchema(schema);
    this.state = wasm.streamGuardNew(this.schemaBytes, wasm.streamGuardOptions(options));
    this.violation = null;
    this.done = false;
  }

  getViolation() { return this.violation; }

  isDone() { return this.done; }

  _apply(r) {
    this.state = r.state;
    this.done = r.done;
    if (r.violation && !this.violation) this.violation = new SchemaViolation(r.violation.message, r.violation.path);
    return this.violation;
  }

  feed(text) {
    if (this.violation) return this.violation;
    // The JS takes text (a non-string is a TypeError there, or nonsense for a Buffer).
    if (typeof text !== 'string') throw new TypeError('stream-guard feed() takes text');
    return this._apply(guardWasm().streamGuardFeed(this.schemaBytes, this.state, text));
  }

  end() {
    if (this.violation) return this.violation;
    return this._apply(guardWasm().streamGuardEnd(this.schemaBytes, this.state));
  }
}

function createValidatorWasm(schema, options) {
  return new WasmValidator(schema, options);
}

/** `feed(text) || end()` on a fresh validator in one module call: a SchemaViolation or null. */
function checkTextWasm(schema, text, options) {
  const wasm = guardWasm();
  const r = wasm.streamGuardCheck(wasm.streamGuardSchema(schema), wasm.streamGuardOptions(options), text);
  return r.violation ? new SchemaViolation(r.violation.message, r.violation.path) : null;
}

/** buildCorrectionRequest({ message: message.slice(0, clip), path }) by the Rust port. */
function buildCorrectionRequestWasm(violation, clip = null) {
  return guardWasm().streamGuardCorrection(String(violation.message), violation.path || null, clip);
}

// Compatibility names retain the public API while selecting only the Rust implementation.
const IncrementalValidator = WasmValidator;
const createValidator = createValidatorWasm;
const buildCorrectionRequest = buildCorrectionRequestWasm;

/**
 * Run a stream producer under schema validation with abort support and a
 * single bounded correction retry.
 *
 * `createStream(context)` must return an (async) iterable of text chunks
 * (or a promise of one). `context` is `{ attempt, correction, signal }`
 * where `correction` is null on the first attempt and the result of
 * `buildCorrection(violation)` on the retry, and `signal` is a per-attempt
 * AbortSignal already wired to the caller's `signal`.
 *
 * Resolves `{ ok: true, text, attempts, corrected }` on success. Rejects
 * with `GuardAbortError` if the caller's signal aborts, or
 * `CorrectionFailedError` if both the original attempt and the one
 * correction attempt fail validation.
 */
async function runGuardedStream({ schema, createStream, signal, buildCorrection = buildCorrectionRequest, maxDepth, maxBytes } = {}) {
  if (typeof createStream !== 'function') throw new TypeError('runGuardedStream requires createStream(context)');

  async function attempt(attemptNumber, correction) {
    if (signal && signal.aborted) throw new GuardAbortError();
    const validator = createValidator(schema, { maxDepth, maxBytes });
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let text = '';
    try {
      const produced = await createStream({ attempt: attemptNumber, correction, signal: controller.signal });
      for await (const chunk of produced) {
        if (signal && signal.aborted) throw new GuardAbortError();
        text += chunk;
        const violation = validator.feed(chunk);
        if (violation) {
          controller.abort();
          return { ok: false, violation, text };
        }
      }
      if (signal && signal.aborted) throw new GuardAbortError();
      const endViolation = validator.end();
      if (endViolation) return { ok: false, violation: endViolation, text };
      return { ok: true, text };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  const first = await attempt(1, null);
  if (first.ok) return { ok: true, text: first.text, attempts: 1, corrected: false };

  if (signal && signal.aborted) throw new GuardAbortError();

  const correction = buildCorrection(first.violation);
  const second = await attempt(2, correction);
  if (second.ok) return { ok: true, text: second.text, attempts: 2, corrected: true };

  throw new CorrectionFailedError(
    `Schema validation failed after one bounded correction attempt: ${second.violation.message}`,
    second.violation,
  );
}

module.exports = {
  SchemaViolation,
  GuardAbortError,
  CorrectionFailedError,
  IncrementalValidator,
  createValidator,
  buildCorrectionRequest,
  runGuardedStream,
  streamGuardImpl,
  WasmValidator,
  createValidatorWasm,
  checkTextWasm,
  buildCorrectionRequestWasm,
};
