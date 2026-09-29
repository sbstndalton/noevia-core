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
/** The toolbox ids one request will actually carry: the project's own list (or the operator
 *  default, for a project-less chat) with any connector id stripped, unioned with this account's
 *  actually-connected connectors. Every reader of "what tools are enabled" — the chat loop itself,
 *  this catalogue, and the model picker / composer menu (#354) — must compute this the same way,
 *  or one of them under-reports what the next message really sends. */
function selectedToolboxIds({ project, defaultToolboxes, connectorBoxes, connected }) {
  return [
    ...(Array.isArray(project && project.toolboxes) ? project.toolboxes : defaultToolboxes).filter((id) => !connectorBoxes.has(id)),
    ...connected,
  ];
}

function computePermittedTools(input) {
  const { user, project, mode, boxes, manifest = [], defaultToolboxes, connectorBoxes, connected, oauthServerIds,
    accountReady, policyMode, isWriteTool, diaryEnabled, harnessEnabled, repositories = [] } = input;
  const isAdmin = user.role === 'admin';
  const selected = new Set(selectedToolboxIds({ project, defaultToolboxes, connectorBoxes, connected }));
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

module.exports = { REASONS, computePermittedTools, createTtlCache, CODE_BOX_ID, selectedToolboxIds };
