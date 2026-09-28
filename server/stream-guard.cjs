'use strict';

// stream-guard.cjs — dependency-free incremental JSON validator + bounded
// correction helper.
//
// Consumes streamed text chunks (as they arrive from an SSE/token stream),
// parses JSON one character at a time and validates against a restricted
// JSON-schema subset, reporting the first violation as early as it is
// decidable — an unknown key as soon as its closing quote is seen, a type
// mismatch as soon as the first character of a value is seen, an enum
// mismatch as soon as no enum candidate can still match the string prefix
// seen so far — rather than waiting for the whole document.
//
// Supported schema subset (anything else is ignored, not rejected):
//   type, required, properties, additionalProperties: false, enum, items,
//   maxItems, maxLength.
//
// This module makes no network calls and has no dependencies. It is not
// wired into any live request path by default; see the `enabled` flags at
// call sites that import it.

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

const WHITESPACE = /\s/;
const NUMBER_CHAR = /[0-9eE+\-.]/;
// JSON number grammar: no leading zeros ("01" is invalid; "0", "0.5", "-0" are fine).
const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const INTEGER_RE = /^-?(0|[1-9]\d*)$/;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB: generous for tool args / plan artifacts
const HEX_DIGIT = /[0-9a-fA-F]/;
const ESCAPE_MAP = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function jsonTypeName(ch) {
  if (ch === '"') return 'string';
  if (ch === '{') return 'object';
  if (ch === '[') return 'array';
  if (ch === 't' || ch === 'f') return 'boolean';
  if (ch === 'n') return 'null';
  if (ch === '-' || (ch >= '0' && ch <= '9')) return 'number';
  return null;
}

function schemaTypes(schema) {
  if (!schema || schema.type == null) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function typeAllowed(schema, typeName) {
  const types = schemaTypes(schema);
  if (!types) return true;
  return types.some((t) => t === typeName || (t === 'integer' && typeName === 'number'));
}

function typeLabel(schema) {
  const types = schemaTypes(schema);
  return types ? types.join(' | ') : 'any';
}

/**
 * Incremental validator: feed() text chunks as they arrive, end() once the
 * stream is done. Returns a SchemaViolation the first time one is decidable
 * and never overwrites it (first violation wins). All other calls become
 * no-ops once a violation is recorded.
 */
class IncrementalValidator {
  /**
   * @param {object} schema restricted JSON-schema subset
   * @param {object} [options]
   * @param {number} [options.maxDepth] max object/array nesting depth (default 64)
   * @param {number} [options.maxBytes] max cumulative UTF-8 bytes fed before failing (default 2 MiB)
   */
  constructor(schema, options = {}) {
    this.rootSchema = schema || {};
    this.violation = null;
    this.done = false;
    this.token = null; // active string/number/literal token, at most one at a time
    this.stack = []; // open object/array containers
    this.maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : DEFAULT_MAX_DEPTH;
    this.maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : DEFAULT_MAX_BYTES;
    this.bytesSeen = 0;
  }

  getViolation() {
    return this.violation;
  }

  isDone() {
    return this.done;
  }

  fail(message, path) {
    if (!this.violation) this.violation = new SchemaViolation(message, path);
    return this.violation;
  }

  feed(text) {
    if (this.violation) return this.violation;
    this.bytesSeen += Buffer.byteLength(text, 'utf8');
    if (this.bytesSeen > this.maxBytes) {
      this.fail(`Input exceeds maxBytes ${this.maxBytes}`, '$');
      return this.violation;
    }
    for (let i = 0; i < text.length; i += 1) {
      this._step(text[i]);
      if (this.violation) return this.violation;
    }
    return this.violation;
  }

  end() {
    if (this.violation) return this.violation;
    if (this.token) {
      if (this.token.type === 'number') {
        this._closeNumber(this.token);
      } else if (this.token.type === 'string') {
        this.fail('Unterminated string at end of stream', this.token.path);
      } else if (this.token.type === 'literal') {
        this.fail(`Unterminated literal (expected '${this.token.expect}') at end of stream`, this.token.path);
      }
    }
    if (this.violation) return this.violation;
    if (this.stack.length > 0) {
      this.fail('Unexpected end of stream: unterminated object or array', this.stack[this.stack.length - 1].path);
      return this.violation;
    }
    if (!this.done) this.fail('Unexpected end of stream: no JSON value was produced', '$');
    return this.violation;
  }

  // ---- character dispatch --------------------------------------------

  _step(ch) {
    if (this.violation) return;
    if (this.token) {
      this._feedToken(ch);
      return;
    }
    if (this.stack.length === 0) {
      if (this.done) return; // trailing data after a complete document is ignored
      if (WHITESPACE.test(ch)) return;
      this._beginValue(this.rootSchema, '$', ch);
      return;
    }
    const top = this.stack[this.stack.length - 1];
    if (top.type === 'object') this._stepObject(top, ch);
    else this._stepArray(top, ch);
  }

  _beginValue(schema, path, ch) {
    const typeName = jsonTypeName(ch);
    if (!typeName) {
      this.fail(`Unexpected character '${ch}' while expecting a value at ${path}`, path);
      return;
    }
    if (!typeAllowed(schema, typeName)) {
      this.fail(`Type mismatch at ${path}: expected ${typeLabel(schema)}, got ${typeName}`, path);
      return;
    }
    if (typeName === 'string') {
      const enumCandidates = Array.isArray(schema && schema.enum)
        ? schema.enum.filter((v) => typeof v === 'string')
        : null;
      this.token = { type: 'string', role: 'value', schema, path, chars: '', escape: false, unicodeRemaining: null, unicodeBuf: null, enumCandidates };
      return;
    }
    if (typeName === 'number') {
      this.token = { type: 'number', role: 'value', schema, path, text: ch };
      return;
    }
    if (typeName === 'boolean') {
      this.token = { type: 'literal', role: 'value', schema, path, expect: ch === 't' ? 'true' : 'false', matched: ch };
      return;
    }
    if (typeName === 'null') {
      this.token = { type: 'literal', role: 'value', schema, path, expect: 'null', matched: ch };
      return;
    }
    if (typeName === 'object' || typeName === 'array') {
      if (this.stack.length + 1 > this.maxDepth) {
        this.fail(`Nesting exceeds maxDepth ${this.maxDepth} at ${path}`, path);
        return;
      }
    }
    if (typeName === 'object') {
      this.stack.push({ type: 'object', schema, path, seenKeys: new Set(), awaiting: 'key-or-close', currentKey: null });
      return;
    }
    // array
    this.stack.push({
      type: 'array',
      itemSchema: (schema && schema.items) || {},
      maxItems: schema && typeof schema.maxItems === 'number' ? schema.maxItems : null,
      path,
      count: 0,
      awaiting: 'value-or-close',
    });
  }

  _valueConsumed() {
    if (this.stack.length === 0) {
      this.done = true;
      return;
    }
    const parent = this.stack[this.stack.length - 1];
    if (parent.type === 'object') {
      parent.seenKeys.add(parent.currentKey);
      parent.currentKey = null;
      parent.awaiting = 'comma-or-close';
    } else {
      parent.count += 1;
      parent.awaiting = 'comma-or-close';
    }
  }

  // ---- object -----------------------------------------------------------

  _stepObject(top, ch) {
    switch (top.awaiting) {
      case 'key-or-close':
      case 'key':
        if (WHITESPACE.test(ch)) return;
        if (ch === '}' && top.awaiting === 'key-or-close') { this._closeObject(top); return; }
        if (ch === '"') { this._startKey(top); return; }
        this.fail(`Expected a property name${top.awaiting === 'key-or-close' ? " or '}'" : ''} at ${top.path}`, top.path);
        return;
      case 'colon':
        if (WHITESPACE.test(ch)) return;
        if (ch === ':') { top.awaiting = 'value'; return; }
        this.fail(`Expected ':' after property name at ${top.path}`, top.path);
        return;
      case 'value':
        if (WHITESPACE.test(ch)) return;
        this._beginValue(this._propertySchema(top, top.currentKey), `${top.path}.${top.currentKey}`, ch);
        return;
      case 'comma-or-close':
        if (WHITESPACE.test(ch)) return;
        if (ch === ',') { top.awaiting = 'key'; return; }
        if (ch === '}') { this._closeObject(top); return; }
        this.fail(`Expected ',' or '}' at ${top.path}`, top.path);
        return;
      default:
        this.fail(`Internal error: unknown object state at ${top.path}`, top.path);
    }
  }

  _startKey(top) {
    this.token = { type: 'string', role: 'key', ownerFrame: top, path: top.path, chars: '', escape: false, unicodeRemaining: null, unicodeBuf: null, enumCandidates: null };
  }

  _propertySchema(top, key) {
    return (top.schema && top.schema.properties && top.schema.properties[key]) || {};
  }

  _onKeyComplete(top, key) {
    const hasPropertiesSchema = !!(top.schema && top.schema.properties);
    if (hasPropertiesSchema && top.schema.additionalProperties === false && !Object.prototype.hasOwnProperty.call(top.schema.properties, key)) {
      this.fail(`Unknown property '${key}' at ${top.path}`, `${top.path}.${key}`);
      return;
    }
    top.currentKey = key;
    top.awaiting = 'colon';
  }

  _closeObject(top) {
    const schema = top.schema;
    if (schema && Array.isArray(schema.required)) {
      const missing = schema.required.filter((k) => !top.seenKeys.has(k));
      if (missing.length) {
        this.fail(`Missing required propert${missing.length > 1 ? 'ies' : 'y'} ${missing.join(', ')} at ${top.path}`, top.path);
        return;
      }
    }
    this.stack.pop();
    this._valueConsumed();
  }

  // ---- array --------------------------------------------------------------

  _stepArray(top, ch) {
    switch (top.awaiting) {
      case 'value-or-close':
        if (WHITESPACE.test(ch)) return;
        if (ch === ']') { this._closeArray(top); return; }
        this._beginArrayValue(top, ch);
        return;
      case 'value':
        if (WHITESPACE.test(ch)) return;
        this._beginArrayValue(top, ch);
        return;
      case 'comma-or-close':
        if (WHITESPACE.test(ch)) return;
        if (ch === ',') { top.awaiting = 'value'; return; }
        if (ch === ']') { this._closeArray(top); return; }
        this.fail(`Expected ',' or ']' at ${top.path}`, top.path);
        return;
      default:
        this.fail(`Internal error: unknown array state at ${top.path}`, top.path);
    }
  }

  _beginArrayValue(top, ch) {
    if (top.maxItems != null && top.count >= top.maxItems) {
      this.fail(`Array at ${top.path} exceeds maxItems ${top.maxItems}`, top.path);
      return;
    }
    this._beginValue(top.itemSchema, `${top.path}[${top.count}]`, ch);
  }

  _closeArray(top) {
    this.stack.pop();
    this._valueConsumed();
  }

  // ---- tokens: string / number / literal ---------------------------------

  _feedToken(ch) {
    const t = this.token;
    if (t.type === 'string') { this._feedString(t, ch); return; }
    if (t.type === 'number') { this._feedNumber(t, ch); return; }
    this._feedLiteral(t, ch);
  }

  _feedString(t, ch) {
    if (t.unicodeRemaining != null) {
      if (!HEX_DIGIT.test(ch)) { this.fail(`Invalid unicode escape in string at ${t.path}`, t.path); return; }
      t.unicodeBuf += ch;
      t.unicodeRemaining -= 1;
      if (t.unicodeRemaining === 0) {
        const decoded = String.fromCharCode(parseInt(t.unicodeBuf, 16));
        t.unicodeBuf = null;
        t.unicodeRemaining = null;
        this._appendStringChar(t, decoded);
      }
      return;
    }
    if (t.escape) {
      t.escape = false;
      if (ch === 'u') { t.unicodeRemaining = 4; t.unicodeBuf = ''; return; }
      if (Object.prototype.hasOwnProperty.call(ESCAPE_MAP, ch)) { this._appendStringChar(t, ESCAPE_MAP[ch]); return; }
      this.fail(`Invalid escape sequence '\\${ch}' in string at ${t.path}`, t.path);
      return;
    }
    if (ch === '\\') { t.escape = true; return; }
    if (ch === '"') { this._finishString(t); return; }
    this._appendStringChar(t, ch);
  }

  _appendStringChar(t, ch) {
    if (this.violation) return;
    t.chars += ch;
    const schema = t.schema;
    if (t.role === 'value' && schema && typeof schema.maxLength === 'number' && t.chars.length > schema.maxLength) {
      this.fail(`String at ${t.path} exceeds maxLength ${schema.maxLength}`, t.path);
      return;
    }
    if (t.role === 'value' && t.enumCandidates) {
      t.enumCandidates = t.enumCandidates.filter((v) => v.startsWith(t.chars));
      if (t.enumCandidates.length === 0) {
        this.fail(`String at ${t.path} cannot match any allowed value (prefix '${t.chars}' is impossible)`, t.path);
      }
    }
  }

  _finishString(t) {
    this.token = null;
    if (t.role === 'key') {
      this._onKeyComplete(t.ownerFrame, t.chars);
      return;
    }
    if (t.schema && Array.isArray(t.schema.enum) && !t.schema.enum.includes(t.chars)) {
      this.fail(`String '${t.chars}' at ${t.path} is not one of the allowed enum values`, t.path);
      return;
    }
    this._valueConsumed();
  }

  _feedNumber(t, ch) {
    if (NUMBER_CHAR.test(ch)) { t.text += ch; return; }
    this._closeNumber(t);
    if (!this.violation) this._step(ch); // re-dispatch the delimiter we just consumed
  }

  _closeNumber(t) {
    this.token = null;
    if (!NUMBER_RE.test(t.text)) {
      this.fail(`Invalid number literal '${t.text}' at ${t.path}`, t.path);
      return;
    }
    const types = schemaTypes(t.schema);
    if (types && types.includes('integer') && !types.includes('number') && !INTEGER_RE.test(t.text)) {
      this.fail(`Expected an integer at ${t.path}, got ${t.text}`, t.path);
      return;
    }
    if (t.schema && Array.isArray(t.schema.enum)) {
      const num = Number(t.text);
      if (!t.schema.enum.some((v) => v === num)) {
        this.fail(`Number ${t.text} at ${t.path} is not one of the allowed enum values`, t.path);
        return;
      }
    }
    this._valueConsumed();
  }

  _feedLiteral(t, ch) {
    t.matched += ch;
    if (!t.expect.startsWith(t.matched)) {
      this.fail(`Invalid literal at ${t.path}: expected '${t.expect}'`, t.path);
      return;
    }
    if (t.matched.length === t.expect.length) {
      this.token = null;
      if (t.schema && Array.isArray(t.schema.enum)) {
        const val = t.expect === 'true' ? true : t.expect === 'false' ? false : null;
        if (!t.schema.enum.some((v) => v === val)) {
          this.fail(`Literal ${t.expect} at ${t.path} is not one of the allowed enum values`, t.path);
          return;
        }
      }
      this._valueConsumed();
    }
  }
}

function createValidator(schema, options) {
  return new IncrementalValidator(schema, options);
}

/**
 * Build a correction request containing only the violation — no
 * orchestrator meta-prompt, no restated schema, no conversation history.
 */
function buildCorrectionRequest(violation) {
  return {
    type: 'schema_violation_correction',
    violation: { message: violation.message, path: violation.path || null },
  };
}

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
};
