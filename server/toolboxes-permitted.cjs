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
// The rules are noevia-rs's toolboxes-permitted crate (dav-parse.wasm toolboxes_permitted); since
// #1071 they are the only implementation (the JS rules and the TOOLBOXES_PERMITTED_IMPL switch that
// compared the two were deleted). This file reads what the crate needs from the request (the
// project's mode and list, id lists, and from the caller's callbacks each tool's write flag and
// policy mode and each sign-in box's readiness, each asked once, in the order the crate reads
// them), asks it, and builds the answer: the crate says which box ids are carried, whether each box
// is available or active, and each tool's permission; this file adds only the presentation (labels,
// descriptions, the reason text for a reason code), and retains the host limits below.
//
// The floor, for a boundary that decides which tools a turn may offer: a fault, a refusal, a reply
// of another shape than the request carries no box id and shows every box and tool unavailable
// (reasonCode 'unchecked'), as before. Under the crate the host keeps the account's own limits: a
// tool the account set to Block is never more than unavailable, a write or an Ask tool is never
// allowed, and a box missing its connection, sign-in or Diary add-on stays unavailable even if
// the crate says it is available. Configured but undiscovered boxes also stay notConnected.
// The crate can only make the answer stricter than these host limits. Warnings are
// logged once, and again at the 10th, 100th, 1000th and so on, per event and reason, and carry no
// input.

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

/**
 * A TTL cache that also empties itself when `fingerprint()` changes between two lookups. For data a
 * process other than this one writes (tool_policies, whose only writer is the Rust front since
 * sbstndalton/noevia#2190 round 7): no Node code path sees such a write to call clear(). The fingerprint is
 * compared through shared-reread.cjs, so a failing fingerprint empties the cache and is retried at the
 * next lookup rather than serving what was cached before it.
 */
function createFingerprintedCache({ fingerprint, ...options }) {
  const { createReread } = require('./shared-reread.cjs');
  const cache = createTtlCache(options);
  const watch = createReread({
    signal: fingerprint,
    load: () => { cache.clear(); return true; },
    fallback: () => { cache.clear(); return false; },
  });
  return { ...cache, get(key) { watch.current(); return cache.get(key); }, watch };
}

const defaultLoader = () => require('./dav-parse-wasm.cjs');
const seenPort = new Map();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (!seenPort.has(key) && seenPort.size >= 200) return; // bounded
  const n = (seenPort.get(key) || 0) + 1;
  seenPort.set(key, n);
  if (n === 1 || (n >= 10 && /^10*$/.test(String(n)))) console.warn(`[toolboxes-permitted] ${event} (${reason}); nothing was carried or permitted${n > 1 ? ` (${n} times so far)` : ''}`);
}
/** Asks the port; undefined (after a counted warning) when it throws or a projection cannot be built. */
function ask(wasmLoader, fn) {
  try { return fn(wasmLoader()); } catch (err) {
    portWarn('toolboxes_permitted.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
    return undefined;
  }
}

const docsBox = () => require('./project-docs-default.cjs').BOX;
const idOf = (x) => (typeof x === 'string' ? x : null);
/** A list as the host reads it (holes are undefined); a non-list cannot be projected. */
function idsProjection(list) {
  if (!Array.isArray(list)) throw Object.assign(Error('not a list'), { reason: 'list' });
  return Array.from(list, idOf);
}
function stringsProjection(iterable) {
  const out = [...iterable];
  if (!out.every((x) => typeof x === 'string')) throw Object.assign(Error('a non-string id'), { reason: 'ids' });
  return out;
}
/** The project as the crate reads it; null for a falsy project. */
function projectProjection(project) {
  if (!project) return null;
  return { auto: project.toolsMode === 'auto', docsDefaulted: project.docsToolboxDefaulted === true,
    toolboxes: Array.isArray(project.toolboxes) ? idsProjection(project.toolboxes) : null };
}
/** The box ids the crate carries. A fault carries none. An id that is not a string matches no box and is not carried. */
const carried = (port) => (port === undefined ? [] : port.ids.filter((id) => typeof id === 'string'));

/** A project's own toolbox list, by the crate: Tools: Automatic (#1006, toolsMode 'auto') is the operator
 *  default, which tool routing then narrows per message; Manual (or no mode, as before) is the hand-picked
 *  list, falling back to the default for a project predating toolboxes. Never more than one of those two lists.
 *  This is the BASE of a turn only: in Automatic, chat.cjs then adds the boxes a message plainly needs (#1550,
 *  tools-mode.cjs automaticAdditions: offered boxes with a read tool, user-data boxes only for a local model),
 *  so an Automatic turn can carry writes the default does not offer. Each such write stops at the approval
 *  card per call, even under "Allow for this chat". */
function projectToolboxIds(project, defaultToolboxes, { wasmLoader = defaultLoader } = {}) {
  return carried(ask(wasmLoader, (m) => m.toolboxesProjectIds(projectProjection(project), idsProjection(defaultToolboxes), docsBox())));
}

/** The toolbox ids one request will actually carry: the project's own list (or the operator
 *  default, for a project-less chat) with any connector id stripped, unioned with this account's
 *  actually-connected connectors. Every reader of "what tools are enabled" — the chat loop itself,
 *  this catalogue, and the model picker / composer menu (#354) — must compute this the same way,
 *  or one of them under-reports what the next message really sends. */
function selectedToolboxIds(input, { wasmLoader = defaultLoader } = {}) {
  const { project, defaultToolboxes, connectorBoxes, connected } = input;
  return carried(ask(wasmLoader, (m) => m.toolboxesSelectedIds(projectProjection(project), idsProjection(defaultToolboxes), docsBox(),
    stringsProjection(connectorBoxes), idsProjection(connected))));
}

const RANK = { allowed: 0, 'needs-approval': 1, unavailable: 2 };
const reasonFor = (code) => (code && Object.hasOwn(REASONS, code) ? [REASONS[code], code] : [REASONS.unchecked, 'unchecked']);
const stricter = (a, b) => (RANK[a] >= RANK[b] ? a : b);

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
function computePermittedTools(input, { wasmLoader = defaultLoader } = {}) {
  const { user, project, mode, boxes, manifest = [], defaultToolboxes, connectorBoxes, connected, oauthServerIds,
    accountReady, policyMode, isWriteTool, diaryEnabled, harnessEnabled, repositories = [] } = input;
  // What the crate reads: the callbacks are called here once each, in this order, and what they said is what is sent.
  const calls = { ready: [], write: [], policy: [] };
  // The host's own limits (the floor), and the presentation: the boxes as listed, the tools as shown.
  const listed = [];
  for (const box of boxes) {
    let limit = null;
    if (connectorBoxes.has(box.id) && !connected.includes(box.id)) limit = 'connect';
    else if (oauthServerIds.has(box.id)) {
      calls.ready.push(accountReady(user.id, box.id));
      if (!calls.ready[calls.ready.length - 1]) limit = 'signIn';
    }
    if (!limit && box.id === 'diary' && !diaryEnabled) limit = 'diaryOff';
    const tools = (box.tools || []).map((tool) => {
      const name = tool && tool.function && tool.function.name;
      if (!name) return null;
      const write = isWriteTool(name);
      const policy = policyMode(user.id, name, write);
      calls.write.push(write);
      calls.policy.push(policy);
      return { name, description: String((tool.function && tool.function.description) || '').slice(0, 240), write,
        floor: policy === 'block' ? 'unavailable' : policy === 'ask' || write ? 'needs-approval' : 'allowed', blocked: policy === 'block' };
    }).filter(Boolean);
    listed.push({ box: { id: box.id, label: box.label, description: box.description, source: box.source, inApp: isInAppBox(box) }, limit, tools });
  }
  // Configured but not discovered (the server is down, or its credentials are missing): shown so
  // the person sees the boundary, never offered.
  const present = new Set(boxes.map((b) => b.id));
  for (const entry of manifest) {
    if (!entry || present.has(entry.id)) continue;
    if (entry.id === 'diary' && !diaryEnabled) continue;
    listed.push({ box: { id: entry.id, label: entry.label || entry.id, description: entry.description || '', source: 'mcp', inApp: isManifestBoxInApp(entry) },
      limit: 'notConnected', tools: [], manifest: true });
  }
  listed.push({ box: { id: CODE_BOX_ID, label: 'Coding harness', source: 'code', inApp: true,
    description: 'Read, edit and run commands in a registered repository. Every edit and command asks first.' }, limit: null, code: true,
  tools: [
    { name: 'read_repository', description: 'Read files in the chosen repository.', write: false },
    { name: 'edit_file', description: 'Change files on a task branch.', write: true },
    { name: 'execute_command', description: 'Run a command in the sandbox.', write: true },
  ] });

  const unchecked = () => {
    const [reason, reasonCode] = reasonFor('unchecked');
    return listed.map(({ box, tools }) => ({ ...box, state: 'unavailable', reason, reasonCode, active: false,
      tools: tools.map((t) => ({ name: t.name, description: t.description, write: t.write, permission: 'unavailable', reason, reasonCode })) }));
  };
  const port = ask(wasmLoader, (m) => m.toolboxesPermitted(permittedProjection(input, calls)));
  if (port === undefined) return unchecked();
  if (port.boxes.length !== listed.length || !port.boxes.every((p, i) => p.id === idOf(listed[i].box.id) && p.tools.length === listed[i].tools.length)) {
    portWarn('toolboxes_permitted.shape', 'catalogue');
    return unchecked();
  }
  return listed.map((l, i) => {
    const p = port.boxes[i];
    // The box: the crate's answer, never less limited than the host's own limits.
    let state = p.state, [reason, reasonCode] = p.state === 'available' ? [null, null] : reasonFor(p.reasonCode);
    if (state === 'available' && l.limit && !l.code) { state = 'unavailable'; [reason, reasonCode] = reasonFor(l.limit); }
    const active = p.active && state === 'available';
    const tools = l.tools.map((t, k) => {
      const q = p.tools[k];
      if (l.code) {
        const [codeReason, codeReasonCode] = q.reasonCode ? reasonFor(q.reasonCode) : [null, null];
        return { name: t.name, description: t.description, write: t.write, permission: q.permission, reason: codeReason, reasonCode: codeReasonCode };
      }
      let permission = q.permission;
      let [tReason, tReasonCode] = q.reasonCode === 'blocked' ? [REASONS.blocked, 'blocked'] : q.reasonCode ? reasonFor(q.reasonCode) : [null, null];
      if (state === 'unavailable' && permission !== 'unavailable') { permission = 'unavailable'; [tReason, tReasonCode] = [reason, reasonCode]; }
      const floor = state === 'unavailable' ? 'unavailable' : t.floor;
      if (stricter(permission, floor) !== permission) {
        permission = floor;
        [tReason, tReasonCode] = floor === 'unavailable' && t.blocked ? [REASONS.blocked, 'blocked'] : [null, null];
      }
      return { name: t.name, description: t.description, write: t.write, permission, reason: tReason, reasonCode: tReasonCode };
    });
    return { ...l.box, state, reason, reasonCode, active, tools };
  });
}

/** What the crate reads of the request, in its order: the recorded callback answers per box and tool. */
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

module.exports = { projectToolboxIds, REASONS, computePermittedTools, createTtlCache, createFingerprintedCache, CODE_BOX_ID, selectedToolboxIds, projectProjection, permittedProjection, idsProjection };
