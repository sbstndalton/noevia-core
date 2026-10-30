'use strict';
// Which toolbox ids one request carries (#237): a project's own list (or the operator default), and that list
// with the account's connected connectors. The rules are noevia-rs's toolboxes-permitted crate (dav-parse.wasm
// toolboxes_permitted); since #1071 they are the only implementation.
//
// The per-turn view of which TOOLS an account could use (GET /api/toolboxes/permitted, with every box's state and
// every tool's permission) is the Rust front's since sbstndalton/noevia#2202 round 2 (rust-toolboxes-permitted.cjs):
// the front runs the same crate over what it owns at the time of the request, and over the discovery snapshot this
// process publishes (mcp-discovery-snapshot.cjs). What stays here is the chat loop's two questions - which box ids
// a project selects - asked of the crate. A fault, a refusal or a reply of another shape carries no box id, as
// before. Warnings are logged once, and again at the 10th, 100th, 1000th and so on, per event and reason, and
// carry no input.


/** The English fallbacks of the reason codes the Rust front sends (toolbox_routes.rs REASONS; a test of the front
 *  compares the two). `reasonCode` names each one so the client can word it from its catalogue
 *  (`tools.reason.<code>`); a client that does not know a code shows this text. Kept here as the list the
 *  client's catalogue is checked against. */
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

module.exports = { projectToolboxIds, REASONS, selectedToolboxIds, projectProjection, idsProjection };
