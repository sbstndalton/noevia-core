'use strict';
// The Executor guard (#704, part of #511): the Laya stream-guard validator (stream-guard.cjs, #516)
// applied to the coding agent's tool calls at the ACP boundary, behind `features.executorGuard`.
//
// What it is for: a small local model often gets a tool call's SHAPE wrong — a command with no
// command, an edit that names no file, a read of a path outside its own tree. Without the guard
// such a call reaches a human as a card nobody can judge (or fails deep inside the harness with an
// error the model cannot act on). With it, the call is refused at once and the agent is told
// exactly which argument was wrong, as the tool's own error, so it can correct itself locally.
//
// What it is NOT: an approval, and not a containment check. The guard only ever ADDS automatic
// refusals of malformed calls — the SHAPE of a call: wrong types, a missing or empty required
// field, NUL or control characters in a path, an unknown kind, oversize content. WHERE a call
// points is left entirely to the existing policy, unchanged: a write, move or delete outside the
// workspace is refused by decide() (without a strike), a read or command elsewhere goes to the
// card as before (#113), and fs/* outside the worktree is refused by the harness's own check.
// A call that passes is handed, unchanged, to classify(), decide() and the approval card with
// its three answers. Nothing here returns "allow", and nothing here can make a card disappear.
//
// A malformed permission request is answered with the protocol's own reject outcome (so every
// harness adapter treats it as an ordinary refusal), with the violation in the outcome's `_meta`
// and in the job journal. A malformed fs/* call is answered with a JSON-RPC Invalid-params error
// carrying the same structured violation — there is no reject outcome for those.
//
// After MAX_VIOLATIONS refusals in one task the guard halts the task: every later call is refused
// without counting, the harness stops the agent, and the job fails with `result.blocked` set (the
// task lifecycle reads a failed job as `blocked`). #701 later records that as a formal
// `task.stage` transition; this module does not depend on it.
const { createValidator, buildCorrectionRequest } = require('./stream-guard.cjs');
const { classify, COMMAND_KEYS } = require('./code-actions.cjs');

const MAX_VIOLATIONS = 3;
const PATH_MAX = 4096;
const COMMAND_MAX = 64 * 1024;
const TITLE_MAX = 64 * 1024;
const URL_MAX = 8192;
const MAX_LOCATIONS = 64;
const MESSAGE_MAX = 300;

/** Every ACP ToolKind (ACP schema `ToolKind`). Anything else is a malformed call. */
const ACP_KINDS = Object.freeze(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
/** Where harnesses put the file a call is about: OpenCode `filePath`/`filepath`, pi `path`/`file_path`. */
const PATH_KEYS = Object.freeze(['path', 'file_path', 'filePath', 'filepath']);

const pathSchema = { type: 'string', maxLength: PATH_MAX };
// NUL and the other C0 controls (and DEL): no real file name the agent means contains them.
const CONTROL = /[\u0000-\u001f\u007f]/;
const pathProperties = Object.freeze(Object.fromEntries(PATH_KEYS.map((key) => [key, pathSchema])));
const commandSchema = { type: ['string', 'array'], maxLength: COMMAND_MAX, maxItems: 4096, items: { type: 'string', maxLength: COMMAND_MAX } };

/**
 * `rawInput` per ACP kind, in the stream-guard subset. Only the keys named here are read (an
 * agent's other arguments are its own business and stay untouched); a `rawInput` that is not an
 * object at all is refused for every kind.
 */
const RAW_INPUT_SCHEMAS = Object.freeze({
  execute: { type: 'object', properties: { ...Object.fromEntries(COMMAND_KEYS.map((key) => [key, commandSchema])), args: commandSchema, cwd: pathSchema } },
  edit: { type: 'object', properties: pathProperties },
  delete: { type: 'object', properties: pathProperties },
  move: { type: 'object', properties: pathProperties },
  read: { type: 'object', properties: pathProperties },
  search: { type: 'object', properties: pathProperties },
  fetch: { type: 'object', properties: { url: { type: 'string', maxLength: URL_MAX }, ...Object.fromEntries(COMMAND_KEYS.map((key) => [key, commandSchema])) } },
  other: { type: 'object', properties: pathProperties },
  think: { type: 'object' },
  switch_mode: { type: 'object' },
});

/** The ACP ToolCall a permission request carries, as noevia merged it with the earlier announcement. */
function toolCallSchema(kind) {
  return {
    type: 'object',
    properties: {
      toolCallId: { type: 'string', maxLength: 256 },
      kind: { type: 'string', enum: ACP_KINDS },
      title: { type: 'string', maxLength: TITLE_MAX },
      status: { type: 'string', maxLength: 64 },
      locations: { type: 'array', maxItems: MAX_LOCATIONS, items: { type: 'object', required: ['path'], properties: { path: pathSchema, line: { type: ['integer', 'null'] } } } },
      rawInput: RAW_INPUT_SCHEMAS[kind] || RAW_INPUT_SCHEMAS.other,
      content: { type: 'array' },
    },
  };
}

/** ACP `fs/read_text_file` and `fs/write_text_file` params. */
const FS_SCHEMAS = Object.freeze({
  'fs/read_text_file': { type: 'object', required: ['path'], properties: { sessionId: { type: 'string' }, path: pathSchema, line: { type: ['integer', 'null'] }, limit: { type: ['integer', 'null'] } } },
  'fs/write_text_file': { type: 'object', required: ['path', 'content'], properties: { sessionId: { type: 'string' }, path: pathSchema, content: { type: 'string' } } },
});

const HINTS = Object.freeze({
  execute: 'Send the shell command as one non-empty string in rawInput.command.',
  edit: 'Name the file to change as a non-empty string in locations[].path (or rawInput.path).',
  delete: 'Name the file to delete as a non-empty string in locations[].path (or rawInput.path).',
  move: 'Name the file to move as a non-empty string in locations[].path (or rawInput.path).',
  read: 'Send each path as a plain non-empty string.',
  search: 'Send each path as a plain non-empty string.',
  fetch: 'Send the address as a string in rawInput.url.',
  other: 'Send rawInput as a JSON object and each path as a plain non-empty string.',
  think: 'Send rawInput as a JSON object.',
  switch_mode: 'Send rawInput as a JSON object.',
  kind: `Use one of the ACP tool kinds: ${ACP_KINDS.join(', ')}.`,
  'fs/read_text_file': 'Send { path } as a plain non-empty string; line and limit, when given, are whole numbers from 1.',
  'fs/write_text_file': 'Send { path, content } with a plain non-empty path and the whole file as a string.',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (text, max = MESSAGE_MAX) => String(text ?? '').slice(0, max);

/** Run the Laya validator over a value; returns `{message, path}` or null. */
function validate(schema, value) {
  let text;
  try { text = JSON.stringify(value); } catch { return { message: 'Arguments are not valid JSON.', path: '$' }; }
  if (text === undefined) return { message: 'Arguments are missing.', path: '$' };
  const validator = createValidator(schema);
  const violation = validator.feed(text) || validator.end();
  return violation ? { message: violation.message, path: violation.path || '$' } : null;
}

/**
 * Keep only what the schema reads, so a write's whole content or a long diff is never re-parsed
 * here: the harness already bounds those itself, and a string the schema does not name says
 * nothing about whether the call is well formed.
 */
function project(value, schema) {
  if (!isObject(value) || !isObject(schema?.properties)) return value;
  const out = {};
  for (const key of Object.keys(schema.properties)) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

function projectToolCall(toolCall, kind) {
  const out = {};
  for (const key of ['toolCallId', 'kind', 'title', 'status', 'locations']) if (toolCall[key] !== undefined && toolCall[key] !== null) out[key] = toolCall[key];
  if (toolCall.rawInput !== undefined && toolCall.rawInput !== null) out.rawInput = project(toolCall.rawInput, RAW_INPUT_SCHEMAS[kind] || RAW_INPUT_SCHEMAS.other);
  if (toolCall.content !== undefined && toolCall.content !== null) out.content = Array.isArray(toolCall.content) ? [] : toolCall.content;
  return out;
}

/** Every path a tool call names, with where it was found. */
function pathsOf(toolCall, kind) {
  const found = [];
  (Array.isArray(toolCall.locations) ? toolCall.locations : []).forEach((location, i) => {
    if (isObject(location) && typeof location.path === 'string') found.push({ path: location.path, at: `$.locations[${i}].path` });
  });
  const raw = isObject(toolCall.rawInput) ? toolCall.rawInput : {};
  for (const key of PATH_KEYS) if (typeof raw[key] === 'string') found.push({ path: raw[key], at: `$.rawInput.${key}` });
  if (kind === 'execute' && typeof raw.cwd === 'string') found.push({ path: raw.cwd, at: '$.rawInput.cwd' });
  return found;
}

/**
 * One path's shape: a non-empty string with no NUL or control characters. Where it points is not
 * judged here (see the header).
 */
function checkPath(path, at) {
  if (typeof path !== 'string' || !path.trim()) return { message: `Empty path at ${at}`, path: at };
  if (CONTROL.test(path)) return { message: `Path at ${at} contains a NUL or control character`, path: at };
  return null;
}

/**
 * The schema check for one ACP permission request (the merged ToolCall). Returns null for a
 * well-formed call, or `{message, path, kind, hint}`. Pure: counting and recording are the guard's.
 */
function checkToolCall(toolCall) {
  if (!isObject(toolCall)) return { message: 'Type mismatch at $: expected object', path: '$', kind: null, hint: HINTS.kind };
  if (toolCall.kind !== undefined && toolCall.kind !== null && !ACP_KINDS.includes(toolCall.kind)) {
    return { message: `Unknown tool kind ${JSON.stringify(clip(String(toolCall.kind), 40))} at $.kind`, path: '$.kind', kind: null, hint: HINTS.kind };
  }
  // ACP's default kind is `other`.
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other';
  const hint = HINTS[kind] || HINTS.other;
  const shape = validate(toolCallSchema(kind), projectToolCall(toolCall, kind));
  if (shape) return { ...shape, kind, hint };
  for (const { path, at } of pathsOf(toolCall, kind)) {
    const bad = checkPath(path, at);
    if (bad) return { ...bad, kind, hint };
  }
  const raw = isObject(toolCall.rawInput) ? toolCall.rawInput : null;
  if (kind === 'execute') {
    const command = classify(toolCall).command;
    if (!command) return { message: 'Missing command at $.rawInput.command', path: '$.rawInput.command', kind, hint };
    if (command.includes('\0')) return { message: 'Command at $.rawInput.command contains a NUL byte', path: '$.rawInput.command', kind, hint };
  }
  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    if (!pathsOf(toolCall, kind).length) return { message: `A ${kind} names no file: missing $.locations[].path`, path: '$.locations', kind, hint };
  }
  // A fetch needs something to fetch. Which address it names is the policy's question: an
  // unlisted host or an odd scheme goes to the card exactly as before.
  if (kind === 'fetch') {
    const url = raw && typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url && !classify(toolCall).command) return { message: 'Missing URL at $.rawInput.url', path: '$.rawInput.url', kind, hint };
  }
  return null;
}

/** The schema check for `fs/read_text_file` / `fs/write_text_file` params. */
function checkFsCall(method, params, { maxBytes = Infinity } = {}) {
  const hint = HINTS[method];
  const schema = FS_SCHEMAS[method];
  if (!schema) return { message: `Unknown file method ${method}`, path: '$', kind: method, hint: '' };
  const shape = validate(schema, isObject(params) && typeof params.content === 'string' ? { ...params, content: '' } : project(params, schema));
  if (shape) return { ...shape, kind: method, hint };
  const bad = checkPath(params.path, '$.path');
  if (bad) return { ...bad, kind: method, hint };
  for (const key of ['line', 'limit']) {
    if (params[key] !== undefined && params[key] !== null && params[key] < 1) return { message: `${key} at $.${key} must be 1 or more`, path: `$.${key}`, kind: method, hint };
  }
  if (method === 'fs/write_text_file' && Buffer.byteLength(params.content) > maxBytes) {
    return { message: `Content at $.content is larger than ${maxBytes} bytes`, path: '$.content', kind: method, hint };
  }
  return null;
}

/**
 * The structured violation the agent receives: the Laya correction shape (`buildCorrectionRequest`,
 * only the violation, no restated schema), plus which tool, how many strikes, and how to fix it.
 */
function structuredViolation(found, { tool, count, limit, blocked }) {
  return {
    ...buildCorrectionRequest({ message: clip(found.message), path: found.path || null }),
    tool, kind: found.kind || null, hint: found.hint || '',
    count, limit, blocked,
  };
}

/** The JSON-RPC error a violation is returned as: Invalid params, the violation in message and data. */
function violationError(violation) {
  const message = `${violationText(violation)}\n${JSON.stringify({ noeviaViolation: violation })}`;
  return Object.assign(Error(message), { code: -32602, data: { noeviaViolation: violation } });
}

/** The text a refusal gives the agent: what was wrong, how to fix it, and how many strikes are left. */
function violationText(violation) {
  const lead = violation.blocked
    ? `noevia refused this malformed tool call and stopped the task (violation ${violation.count} of ${violation.limit}).`
    : `noevia refused this malformed tool call (violation ${violation.count} of ${violation.limit}). Correct the arguments and call the tool again.`;
  return `${lead} ${violation.violation.message}. ${violation.hint}`;
}

/**
 * The answer to a malformed permission request: the protocol's own reject outcome (what a person's
 * Decline sends), with the violation in `_meta` for a bridge that can pass it on (pi, #704).
 */
function rejectOutcome(selected, violation) {
  return { ...selected, _meta: { noevia: { reason: violationText(violation), violation } } };
}

/**
 * One guard per Code task session. `event(type, data)` appends to the job journal; `log(entry)`
 * is the server log; `onBlocked()` is called once, when the limit is reached, and must stop the
 * agent.
 *
 * `permission()` returns null (go on, unchanged) or the structured violation to answer with as a
 * rejection; the fs checks return null or an Error to throw back to the agent. After the limit
 * every call is refused with the same blocked violation, without counting further.
 */
function createExecutorGuard({ event = () => {}, log = () => {}, onBlocked = () => {}, limit = MAX_VIOLATIONS, maxBytes = Infinity } = {}) {
  let count = 0, blocked = null;
  const history = [];

  function refuse(found, tool, recordEvent) {
    if (blocked) {
      const again = { ...blocked, tool, kind: found?.kind ?? blocked.kind };
      try { recordEvent(again); } catch { /* the task is ending; the refusal stands either way */ }
      return again;
    }
    count++;
    const violation = structuredViolation(found, { tool, count, limit, blocked: count >= limit });
    history.push({ tool, kind: violation.kind, path: violation.violation.path, message: violation.violation.message });
    log({ event: 'code.guard_violation', tool, kind: violation.kind, path: violation.violation.path, count, limit });
    try { recordEvent(violation); } catch (error) { log({ event: 'code.guard_record_failed', error: clip(error?.message || error) }); }
    if (violation.blocked) {
      blocked = violation;
      try {
        event('step.started', { id: 'executor.guard', title: 'Tool-call guard' });
        event('step.completed', { id: 'executor.guard', failed: true, blocked: true, violations: count, error: `Stopped after ${count} malformed tool calls.` });
      } catch (error) { log({ event: 'code.guard_record_failed', error: clip(error?.message || error) }); }
      try { onBlocked(); } catch (error) { log({ event: 'code.guard_halt_failed', error: clip(error?.message || error) }); }
    }
    return violation;
  }

  return {
    /** A permission request's merged ToolCall. `action` is the class code-actions gave it, for the record. */
    permission(toolCall, action = null) {
      const found = blocked ? { kind: null } : checkToolCall(toolCall);
      if (!found) return null;
      return refuse(found, 'session/request_permission', (v) => event('approval.decided', {
        decision: 'denied', action, automatic: true, reason: violationText(v), violation: v,
      }));
    },
    /** `fs/read_text_file` params. */
    readTextFile(params) {
      const found = blocked ? { kind: null } : checkFsCall('fs/read_text_file', params);
      if (!found) return null;
      return violationError(refuse(found, 'fs/read_text_file', (v) => event('tool.completed', { name: 'read_file', failed: true, violation: v })));
    },
    /** `fs/write_text_file` params. */
    writeTextFile(params) {
      const found = blocked ? { kind: null } : checkFsCall('fs/write_text_file', params, { maxBytes });
      if (!found) return null;
      return violationError(refuse(found, 'fs/write_text_file', (v) => event('tool.completed', { name: 'write_file', failed: true, violation: v })));
    },
    get violations() { return count; },
    get blocked() { return !!blocked; },
    /** The error the task ends with once blocked: the job fails with `result.blocked`. */
    blockedError() {
      if (!blocked) return null;
      const message = `Blocked: the coding agent sent ${count} malformed tool calls, so the task was stopped.`;
      return Object.assign(Error(message), { code: 'blocked', publicMessage: message,
        result: { blocked: true, reason: 'executor_guard', violations: history.slice() } });
    },
  };
}

// The deployment's flag, installed once by index.cjs (`useExecutorGuard`), so the harness reads it
// without every layer between them having to pass it along. Off until installed, and off unless
// the installed check answers exactly true.
let installed = () => false;
const executorGuardFlag = Object.freeze({ enabled: () => { try { return installed() === true; } catch { return false; } } });
function useExecutorGuard(enabled) {
  if (typeof enabled !== 'function') throw TypeError('useExecutorGuard needs a function');
  installed = enabled;
}

module.exports = {
  MAX_VIOLATIONS, ACP_KINDS, PATH_KEYS, RAW_INPUT_SCHEMAS, FS_SCHEMAS, toolCallSchema,
  checkToolCall, checkFsCall, violationError, violationText, rejectOutcome, createExecutorGuard, executorGuardFlag, useExecutorGuard,
};
