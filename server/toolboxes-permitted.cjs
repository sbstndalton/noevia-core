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

const CODE_BOX_ID = 'code';

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
function computePermittedTools(input) {
  const { user, project, mode, boxes, manifest = [], defaultToolboxes, connectorBoxes, connected, oauthServerIds,
    accountReady, policyMode, isWriteTool, diaryEnabled, harnessEnabled, repositories = [] } = input;
  const isAdmin = user.role === 'admin';
  const selected = new Set([
    ...(Array.isArray(project && project.toolboxes) ? project.toolboxes : defaultToolboxes).filter((id) => !connectorBoxes.has(id)),
    ...connected,
  ]);
  const out = [];
  for (const box of boxes) {
    let reason = null;
    if (connectorBoxes.has(box.id) && !connected.includes(box.id)) reason = 'Connect this account in Settings → Connectors first.';
    else if (oauthServerIds.has(box.id) && !accountReady(user.id, box.id)) reason = 'Sign in to this service in Settings → Connectors first.';
    else if (box.id === 'diary' && !diaryEnabled) reason = 'The Diary add-on is off for this account.';
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
        reason: reason ? reason : policy === 'block' ? 'Blocked in your tool permissions.' : null,
      };
    }).filter(Boolean);
    out.push({
      id: box.id, label: box.label, description: box.description, source: box.source,
      state: reason ? 'unavailable' : 'available', reason, active: !reason && selected.has(box.id), tools,
    });
  }
  // Configured but not discovered (the server is down, or its credentials are missing): shown so
  // the person sees the boundary, never offered.
  const present = new Set(out.map((b) => b.id));
  for (const entry of manifest) {
    if (!entry || present.has(entry.id)) continue;
    if (entry.id === 'diary' && !diaryEnabled) continue;
    out.push({ id: entry.id, label: entry.label || entry.id, description: entry.description || '', source: 'mcp',
      state: 'unavailable', reason: 'Not connected on this server right now.', active: false, tools: [] });
  }
  // The coding harness: only in a Cowork session, only for administrators, only when it is on.
  const codeReason = mode !== 'cowork' ? 'Switch this session to Cowork to use the coding harness.'
    : !isAdmin ? 'The coding harness is limited to administrators.'
    : !harnessEnabled ? 'The coding harness is off on this server.'
    : !project ? 'Open a project chat to run a Cowork task.'
    : !repositories.length ? 'No repository is registered on this server.'
    : null;
  out.push({
    id: CODE_BOX_ID, label: 'Coding harness', source: 'code', active: !codeReason,
    description: 'Read, edit and run commands in a registered repository. Every edit and command asks first.',
    state: codeReason ? 'unavailable' : 'available', reason: codeReason,
    tools: [
      { name: 'read_repository', description: 'Read files in the chosen repository.', write: false },
      { name: 'edit_file', description: 'Change files on a task branch.', write: true },
      { name: 'execute_command', description: 'Run a command in the sandbox.', write: true },
    ].map((t) => ({ ...t, permission: codeReason ? 'unavailable' : t.write ? 'needs-approval' : 'allowed', reason: codeReason })),
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

module.exports = { computePermittedTools, createTtlCache, CODE_BOX_ID };
