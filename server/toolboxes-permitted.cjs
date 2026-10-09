'use strict';
// Which tools would be available THIS turn (#237), for one account, one project (or a free
// chat) and one session mode. Read-only: computing this never enables a box, grants a
// credential or changes a permission. The chat loop remains the authority at call time
// (resolveTools, the OAuth filter, toolPolicy and the approval gate); this is the view of it.
//
// Per tool:  allowed         a read that runs without asking
//            needs-approval  a write, or a read the account set to Ask: the approval card gates it
//            unavailable     blocked by the account's permissions, or its box is unavailable
// Per box:   available / unavailable (+ reason), and `active` when the project or chat already
//            selects it, so the catalogue can show what is on by default versus on for one turn.
//
// TOOLBOXES_PERMITTED_IMPL=js|wasm (default js; any other value means js, with one warning), read
// from the `env` option (process.env) on every call. wasm also asks noevia-rs's
// toolboxes-permitted crate (dav-parse.wasm toolboxes_permitted) with the host's projections (the
// project's mode and list, id lists, and for the catalogue what the JS run read from its
// callbacks: each tool's write flag and policy mode, each sign-in box's readiness; nothing is read
// twice). The JS answer is computed first and the port can only offer less: a box id is carried
// only if both carry it (projectToolboxIds, selectedToolboxIds: what chat.cjs and resolveTools
// really send), a box is available or active only if both say so, and a tool's permission is the
// stricter of the two (unavailable over needs-approval over allowed). A fault or a reply of another
// shape carries no box and shows every box and tool unavailable (reasonCode 'unchecked'). Warnings
// are logged once per event and reason and carry no input. The flag is in dav-parse-wasm.cjs
// IMPL_FLAGS (a missing or tampered module stops startup).

const { isInAppBox, isManifestBoxInApp } = require('./toolbox-flags.cjs');

const CODE_BOX_ID = 'code';

/** English fallbacks. `reasonCode` names each one so the client can word it from its catalogue
 *  (`tools.reason.<code>`); a client that does not know a code shows this text. */
const REASONS = {
  connect: 'Connect this account in Settings → Connected apps first.',
  signIn: 'Sign in to this service in Settings → Connected apps first.',
  diaryOff: 'The Diary add-on is off for this account.',
  blocked: 'Blocked in your tool permissions.',
  notConnected: 'Not connected on this server right now.',
  codeNeedsCowork: 'Switch this session to Cowork to use the coding harness.',
  codeAdminOnly: 'The coding harness is limited to administrators.',
  codeOff: 'The coding harness is off on this server.',
  codeNeedsProject: 'Open a project chat to run a Cowork task.',
  codeNoRepository: 'No repository is registered on this server.',
  unchecked: "This tool's permission couldn't be checked, so it's unavailable for now.",
};

/**
 * @param {object} input
 * @param {{ id:string, role:string }} input.user
 * @param {object|null} input.project           already tenant-scoped by the caller (getProject)
 * @param {'chat'|'cowork'} input.mode
 * @param {object[]} input.boxes                allToolboxes(): offered, discovered boxes
 * @param {object[]} [input.manifest]           configured MCP boxes, to report the undiscovered ones
 * @param {string[]} input.defaultToolboxes
 * @param {Set<string>} input.connectorBoxes
 * @param {string[]} input.connected            connectedBoxes(user)
 * @param {Set<string>} input.oauthServerIds
 * @param {(userId, serverId) => boolean} input.accountReady
 * @param {(userId, tool, isWrite) => 'allow'|'ask'|'block'} input.policyMode
 * @param {(name) => boolean} input.isWriteTool
 * @param {boolean} input.diaryEnabled
 * @param {boolean} input.harnessEnabled
 * @param {string[]} [input.repositories]
 */
/** A project's own toolbox list. Tools: Automatic (#1006, toolsMode 'auto') is the operator
 *  default, which tool routing then narrows per message; Manual (or no mode, as before) is the
 *  hand-picked list, falling back to the default for a project predating toolboxes. Never more
 *  than one of those two lists, so Automatic cannot add a write the default does not offer. */
function projectToolboxIdsJs(project, defaultToolboxes) {
  if (project && project.toolsMode === 'auto') {
    // The Project documents box (read-only) that project-docs-default.cjs added on the first upload
    // stays in Automatic too, or an Automatic project could not read its own uploads.
    const docs = require('./project-docs-default.cjs').BOX;
    const keepDocs = project.docsToolboxDefaulted === true && Array.isArray(project.toolboxes) && project.toolboxes.includes(docs) && !defaultToolboxes.includes(docs);
    return keepDocs ? [...defaultToolboxes, docs] : [...defaultToolboxes];
  }
  return Array.isArray(project && project.toolboxes) ? project.toolboxes : defaultToolboxes;
}

/** The toolbox ids one request will actually carry: the project's own list (or the operator
 *  default, for a project-less chat) with any connector id stripped, unioned with this account's
 *  actually-connected connectors. Every reader of "what tools are enabled" — the chat loop itself,
 *  this catalogue, and the model picker / composer menu (#354) — must compute this the same way,
 *  or one of them under-reports what the next message really sends. */
function selectedToolboxIdsJs({ project, defaultToolboxes, connectorBoxes, connected }) {
  return [
    ...projectToolboxIdsJs(project, defaultToolboxes).filter((id) => !connectorBoxes.has(id)),
    ...connected,
  ];
}

function computePermittedToolsJs(input) {
  const { user, project, mode, boxes, manifest = [], defaultToolboxes, connectorBoxes, connected, oauthServerIds,
    accountReady, policyMode, isWriteTool, diaryEnabled, harnessEnabled, repositories = [] } = input;
  const isAdmin = user.role === 'admin';
  const selected = new Set(selectedToolboxIdsJs({ project, defaultToolboxes, connectorBoxes, connected }));
  const out = [];
  for (const box of boxes) {
    let reason = null, reasonCode = null;
    if (connectorBoxes.has(box.id) && !connected.includes(box.id)) [reason, reasonCode] = [REASONS.connect, 'connect'];
    else if (oauthServerIds.has(box.id) && !accountReady(user.id, box.id)) [reason, reasonCode] = [REASONS.signIn, 'signIn'];
    else if (box.id === 'diary' && !diaryEnabled) [reason, reasonCode] = [REASONS.diaryOff, 'diaryOff'];
    const tools = (box.tools || []).map((tool) => {
      const name = tool && tool.function && tool.function.name;
      if (!name) return null;
      const write = isWriteTool(name);
      const policy = policyMode(user.id, name, write);
      const permission = reason ? 'unavailable' : policy === 'block' ? 'unavailable' : policy === 'ask' || write ? 'needs-approval' : 'allowed';
      return {
        name,
        description: String((tool.function && tool.function.description) || '').slice(0, 240),
        write,
        permission,
        reason: reason ? reason : policy === 'block' ? REASONS.blocked : null,
        reasonCode: reason ? reasonCode : policy === 'block' ? 'blocked' : null,
      };
    }).filter(Boolean);
    out.push({
      id: box.id, label: box.label, description: box.description, source: box.source, inApp: isInAppBox(box),
      state: reason ? 'unavailable' : 'available', reason, reasonCode, active: !reason && selected.has(box.id), tools,
    });
  }
  // Configured but not discovered (the server is down, or its credentials are missing): shown so
  // the person sees the boundary, never offered.
  const present = new Set(out.map((b) => b.id));
  for (const entry of manifest) {
    if (!entry || present.has(entry.id)) continue;
    if (entry.id === 'diary' && !diaryEnabled) continue;
    out.push({ id: entry.id, label: entry.label || entry.id, description: entry.description || '', source: 'mcp',
      inApp: isManifestBoxInApp(entry), state: 'unavailable', reason: REASONS.notConnected, reasonCode: 'notConnected', active: false, tools: [] });
  }
  // The coding harness: only in a Cowork session, only for administrators, only when it is on.
  const codeCode = mode !== 'cowork' ? 'codeNeedsCowork'
    : !isAdmin ? 'codeAdminOnly'
    : !harnessEnabled ? 'codeOff'
    : !project ? 'codeNeedsProject'
    : !repositories.length ? 'codeNoRepository'
    : null;
  const codeReason = codeCode ? REASONS[codeCode] : null;
  out.push({
    id: CODE_BOX_ID, label: 'Coding harness', source: 'code', inApp: true, active: !codeReason, reasonCode: codeCode,
    description: 'Read, edit and run commands in a registered repository. Every edit and command asks first.',
    state: codeReason ? 'unavailable' : 'available', reason: codeReason,
    tools: [
      { name: 'read_repository', description: 'Read files in the chosen repository.', write: false },
      { name: 'edit_file', description: 'Change files on a task branch.', write: true },
      { name: 'execute_command', description: 'Run a command in the sandbox.', write: true },
    ].map((t) => ({ ...t, permission: codeReason ? 'unavailable' : t.write ? 'needs-approval' : 'allowed', reason: codeReason, reasonCode: codeCode })),
  });
  return out;
}

/** A per-key cache with a short TTL; keys carry the user id so one account never reads another's. */
function createTtlCache({ ttlMs = 30000, now = Date.now, max = 500 } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > ttlMs) { entries.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      if (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(key, { at: now(), value });
    },
    clear() { entries.clear(); },
  };
}

// ── TOOLBOXES_PERMITTED_IMPL ────────────────────────────────────────────────

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** TOOLBOXES_PERMITTED_IMPL: 'js' (default) or 'wasm'. */
function toolboxesPermittedImpl(env = process.env) {
  const raw = env?.TOOLBOXES_PERMITTED_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const v = String(raw).trim().toLowerCase();
  if (IMPLS.has(v)) return v;
  if (warnedImpl !== v) {
    warnedImpl = v;
    console.warn(`[toolboxes-permitted] TOOLBOXES_PERMITTED_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
const defaultLoader = () => require('./dav-parse-wasm.cjs');
const implOf = ({ env = process.env, impl = toolboxesPermittedImpl(env) } = {}) => impl;
const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[toolboxes-permitted] ${event} (${reason}); the stricter answer was used`);
}
/** Asks the port; undefined (after a warning) when it throws or a projection cannot be built. */
function ask(wasmLoader, fn) {
  try { return fn(wasmLoader()); } catch (err) {
    portWarn('toolboxes_permitted.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
    return undefined;
  }
}

const docsBox = () => require('./project-docs-default.cjs').BOX;
const idOf = (x) => (typeof x === 'string' ? x : null);
/** A list as the JS reads it (holes are undefined); a non-list cannot be projected. */
function idsProjection(list) {
  if (!Array.isArray(list)) throw Object.assign(Error('not a list'), { reason: 'list' });
  return Array.from(list, idOf);
}
function stringsProjection(iterable) {
  const out = [...iterable];
  if (!out.every((x) => typeof x === 'string')) throw Object.assign(Error('a non-string id'), { reason: 'ids' });
  return out;
}
/** The project as projectToolboxIds reads it; null for a falsy project. */
function projectProjection(project) {
  if (!project) return null;
  return { auto: project.toolsMode === 'auto', docsDefaulted: project.docsToolboxDefaulted === true,
    toolboxes: Array.isArray(project.toolboxes) ? idsProjection(project.toolboxes) : null };
}
/** The JS list where the port carries the same ids; else only the string ids both carry. */
function intersectIds(js, port, what) {
  if (port === undefined) return [];
  if (port.ids.length === js.length && port.ids.every((id, i) => id === idOf(js[i]))) return js;
  portWarn('toolboxes_permitted.impl_mismatch', what);
  const carried = new Set(port.ids.filter((id) => id !== null));
  return js.filter((id) => typeof id === 'string' && carried.has(id));
}

/** projectToolboxIdsJs; under TOOLBOXES_PERMITTED_IMPL=wasm only the ids the port carries too. */
function projectToolboxIds(project, defaultToolboxes, { wasmLoader = defaultLoader, ...opts } = {}) {
  const js = projectToolboxIdsJs(project, defaultToolboxes);
  if (implOf(opts) !== 'wasm') return js;
  const port = ask(wasmLoader, (m) => m.toolboxesProjectIds(projectProjection(project), idsProjection(defaultToolboxes), docsBox()));
  return intersectIds(js, port, 'project');
}

/** selectedToolboxIdsJs; under TOOLBOXES_PERMITTED_IMPL=wasm only the ids the port carries too. */
function selectedToolboxIds(input, { wasmLoader = defaultLoader, ...opts } = {}) {
  const js = selectedToolboxIdsJs(input);
  if (implOf(opts) !== 'wasm') return js;
  const { project, defaultToolboxes, connectorBoxes, connected } = input;
  const port = ask(wasmLoader, (m) => m.toolboxesSelectedIds(projectProjection(project), idsProjection(defaultToolboxes), docsBox(),
    stringsProjection(connectorBoxes), idsProjection(connected)));
  return intersectIds(js, port, 'selected');
}

const RANK = { allowed: 0, 'needs-approval': 1, unavailable: 2 };
const reasonFor = (code) => (code && Object.hasOwn(REASONS, code) ? [REASONS[code], code] : [REASONS.unchecked, 'unchecked']);
/** Every box and tool unavailable: what a fault shows. */
function allUnavailable(boxes) {
  const [reason, reasonCode] = reasonFor('unchecked');
  return boxes.map((b) => ({ ...b, state: 'unavailable', reason, reasonCode, active: false,
    tools: b.tools.map((t) => ({ ...t, permission: 'unavailable', reason, reasonCode })) }));
}
/** One JS box with the port's answer for it: never more available, active or permitted. */
function mergeBox(b, p) {
  let changed = false;
  const out = { ...b };
  if (b.state === 'available' && p.state !== 'available') {
    changed = true;
    [out.reason, out.reasonCode] = reasonFor(p.reasonCode);
    out.state = 'unavailable';
  }
  if (out.active && !(p.active && out.state === 'available')) { changed = true; out.active = false; }
  out.tools = b.tools.map((t, i) => {
    const q = p.tools[i];
    if (RANK[q.permission] <= RANK[t.permission]) return t;
    changed = true;
    const [reason, reasonCode] = q.reasonCode === 'blocked' ? [REASONS.blocked, 'blocked'] : reasonFor(q.reasonCode);
    return { ...t, permission: q.permission, reason, reasonCode };
  });
  if (!changed && (p.state !== b.state || p.active !== b.active || p.reasonCode !== b.reasonCode
    || p.tools.some((q, i) => q.permission !== b.tools[i].permission || q.reasonCode !== b.tools[i].reasonCode))) changed = true;
  return { box: out, changed };
}

/** computePermittedToolsJs; under TOOLBOXES_PERMITTED_IMPL=wasm the port reads what the JS run read
 *  (its callbacks are recorded, not called twice) and every box and tool is the stricter answer. */
function computePermittedTools(input, { wasmLoader = defaultLoader, ...opts } = {}) {
  if (implOf(opts) !== 'wasm') return computePermittedToolsJs(input);
  const calls = { ready: [], write: [], policy: [] };
  const record = (list, fn) => (...args) => { const v = fn(...args); list.push(v); return v; };
  const js = computePermittedToolsJs({ ...input, accountReady: record(calls.ready, input.accountReady),
    isWriteTool: record(calls.write, input.isWriteTool), policyMode: record(calls.policy, input.policyMode) });
  const port = ask(wasmLoader, (m) => m.toolboxesPermitted(permittedProjection(input, calls)));
  if (port === undefined) return allUnavailable(js);
  if (port.boxes.length !== js.length || !port.boxes.every((p, i) => p.id === idOf(js[i].id) && p.tools.length === js[i].tools.length)) {
    portWarn('toolboxes_permitted.impl_mismatch', 'shape');
    return allUnavailable(js);
  }
  let changed = false;
  const out = js.map((b, i) => { const m = mergeBox(b, port.boxes[i]); changed ||= m.changed; return m.box; });
  if (changed) portWarn('toolboxes_permitted.impl_mismatch', 'catalogue');
  return out;
}

/** What computePermittedToolsJs read, in its order: the recorded callback answers per box and tool. */
function permittedProjection(input, calls) {
  const { user, project, mode, boxes, manifest = [], defaultToolboxes, connectorBoxes, connected, oauthServerIds, diaryEnabled,
    harnessEnabled, repositories = [] } = input;
  let r = 0, w = 0, q = 0;
  return {
    isAdmin: user.role === 'admin', project: projectProjection(project), cowork: mode === 'cowork', defaults: idsProjection(defaultToolboxes),
    docsBox: docsBox(), connectorBoxes: stringsProjection(connectorBoxes), connected: idsProjection(connected),
    oauthServerIds: stringsProjection(oauthServerIds), diaryEnabled: !!diaryEnabled, harnessEnabled: !!harnessEnabled,
    hasRepositories: repositories.length > 0,
    boxes: boxes.map((box) => {
      if (typeof box.id !== 'string') throw Object.assign(Error('a box id is not a string'), { reason: 'box' });
      const asked = !(connectorBoxes.has(box.id) && !connected.includes(box.id)) && oauthServerIds.has(box.id);
      const ready = asked ? !!calls.ready[r++] : null;
      const tools = (box.tools || []).filter((tool) => tool && tool.function && tool.function.name).map(() => {
        const write = calls.write[w++], policy = calls.policy[q++];
        return { write: !!write, policy: policy === 'block' ? 'block' : policy === 'ask' ? 'ask' : 'other' };
      });
      return { id: box.id, ready, tools };
    }),
    manifest: manifest.map((e) => (e ? { id: idOf(e.id) } : null)),
  };
}

module.exports = { projectToolboxIds, REASONS, computePermittedTools, createTtlCache, CODE_BOX_ID, selectedToolboxIds,
  projectToolboxIdsJs, selectedToolboxIdsJs, computePermittedToolsJs, toolboxesPermittedImpl, projectProjection, permittedProjection,
  idsProjection, mergeBox };
