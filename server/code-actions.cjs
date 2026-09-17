'use strict';
// CodeHarness contract v0: turn one ACP tool call into noevia's own action model and say
// whether a human has to answer for it (spec-agent-execution §3, and the measured behaviour in
// experiments/acp-spike).
//
// Two rules decide everything here:
//  * Fail closed. An unfamiliar kind, an unreadable command or a missing permission option is
//    treated as the most consequential thing it could be, exactly as `isWriteTool` treats an
//    unknown tool as a write.
//  * ACP permission is evidence of intent, not the boundary. The spike showed an agent writing
//    and running commands in its own process without asking; the OS sandbox and the workspace
//    root are what actually contain it. Nothing here may be read as making that unnecessary.

/** noevia's action classes (spec §3 "Permissions"). */
const ACTIONS = Object.freeze({
  READ: 'read_repository',
  EDIT: 'edit_file',
  EXECUTE: 'execute_command',
  INSTALL: 'install_dependency',
  NETWORK: 'network',
  DELETE: 'delete',
  GIT_PUSH: 'git_push',
  BROWSER: 'open_browser',
  EXTERNAL: 'external_account',
  NONE: 'none',
});

// Most consequential first: a compound command takes the worst class among its parts.
const SEVERITY = [ACTIONS.EXTERNAL, ACTIONS.GIT_PUSH, ACTIONS.DELETE, ACTIONS.BROWSER, ACTIONS.INSTALL,
  ACTIONS.NETWORK, ACTIONS.EXECUTE, ACTIONS.EDIT, ACTIONS.READ, ACTIONS.NONE];
const rank = (action) => { const i = SEVERITY.indexOf(action); return i === -1 ? 0 : i; };
const worst = (a, b) => (rank(a) <= rank(b) ? a : b);

// How the ACP `kind` maps, before the command text is read (spec §3 table).
const KIND_ACTIONS = Object.freeze({
  read: ACTIONS.READ, search: ACTIONS.READ,
  edit: ACTIONS.EDIT, move: ACTIONS.EDIT,
  delete: ACTIONS.DELETE,
  fetch: ACTIONS.NETWORK,
  execute: ACTIONS.EXECUTE,
  think: ACTIONS.NONE,
  other: ACTIONS.EXECUTE, // unknown effect: gated like a command, never waved through
});

const INSTALLERS = new Map(Object.entries({
  npm: ['install', 'i', 'add', 'ci', 'update', 'exec'], pnpm: ['install', 'i', 'add', 'update', 'dlx'],
  yarn: ['install', 'add', 'up'], bun: ['install', 'i', 'add', 'x'],
  pip: ['install'], pip3: ['install'], uv: ['pip', 'add', 'sync', 'tool'], pipx: ['install', 'run'],
  cargo: ['install', 'add', 'fetch'], gem: ['install'], go: ['get', 'install'],
  composer: ['install', 'require', 'update'], bundle: ['install'],
  apt: ['install'], 'apt-get': ['install'], apk: ['add'], brew: ['install'], dnf: ['install'], yum: ['install'],
}));
// Fetches code or data over the network whatever the subcommand.
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync',
  'telnet', 'ftp', 'npx', 'http', 'https']);
const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'srm']);
const BROWSER_COMMANDS = new Set(['open', 'xdg-open', 'chromium', 'chrome', 'google-chrome', 'firefox', 'safari']);
// `git` decides by subcommand; anything not listed stays an ordinary command.
const GIT_SUBCOMMANDS = new Map(Object.entries({
  push: ACTIONS.GIT_PUSH, fetch: ACTIONS.NETWORK, clone: ACTIONS.NETWORK, pull: ACTIONS.NETWORK,
  remote: ACTIONS.NETWORK, submodule: ACTIONS.NETWORK, 'ls-remote': ACTIONS.NETWORK,
  clean: ACTIONS.DELETE,
}));
// Wrappers that only prefix a real command.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'setsid', 'time', 'nice', 'command', 'exec', 'xargs']);
const SEPARATORS = /\|\||&&|;|\||\n/;

/** Split off `FOO=bar` prefixes and wrappers to reach the command that actually runs. */
function head(words) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  return words.slice(i);
}

/**
 * Classify one shell command. Compound commands take their worst part, so
 * `echo hi && rm -rf build` is a delete, not an ordinary command.
 * @param {string} command
 */
function classifyCommand(command) {
  const text = String(command || '').trim();
  if (!text) return ACTIONS.EXECUTE; // an empty command we cannot read is not a safe one
  // Command substitution hides a second command inside the first; read those too.
  const parts = [...text.split(SEPARATORS), ...(text.match(/\$\(([^)]*)\)/g) || []).map((m) => m.slice(2, -1))];
  let action = ACTIONS.NONE;
  for (const part of parts) {
    const words = head(part.trim().split(/\s+/).filter(Boolean));
    if (!words.length) continue;
    action = worst(action, classifySingle(words));
  }
  return action === ACTIONS.NONE ? ACTIONS.EXECUTE : action;
}

function classifySingle(words) {
  const name = (words[0] || '').split('/').pop();
  const args = words.slice(1).filter((w) => !w.startsWith('-'));
  if (name === 'git') {
    const sub = args[0];
    return GIT_SUBCOMMANDS.get(sub) || ACTIONS.EXECUTE;
  }
  if (INSTALLERS.has(name)) return INSTALLERS.get(name).includes(args[0]) ? ACTIONS.INSTALL : ACTIONS.EXECUTE;
  if (NETWORK_COMMANDS.has(name)) return ACTIONS.NETWORK;
  if (DELETE_COMMANDS.has(name)) return ACTIONS.DELETE;
  if (BROWSER_COMMANDS.has(name)) return ACTIONS.BROWSER;
  return ACTIONS.EXECUTE;
}

/** The command text an ACP agent puts in `rawInput`, whatever key it chose. */
function commandOf(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') return '';
  for (const key of ['command', 'cmd', 'script', 'shell', 'commandLine']) {
    const value = rawInput[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.map(String).join(' ').trim();
  }
  if (Array.isArray(rawInput.args) && rawInput.args.length) return rawInput.args.map(String).join(' ').trim();
  return '';
}

/**
 * Classify one ACP tool call.
 * @param {{kind?: string, title?: string, rawInput?: object, locations?: Array<{path?: string}>}} call
 * @returns {{action: string, approval: 'never'|'always'|'capability', command: string, paths: string[], readable: boolean}}
 */
function classify(call = {}) {
  const kind = typeof call.kind === 'string' ? call.kind : '';
  // An unknown kind is not a read. Treat it like `other`.
  let action = Object.prototype.hasOwnProperty.call(KIND_ACTIONS, kind) ? KIND_ACTIONS[kind] : ACTIONS.EXECUTE;
  const command = commandOf(call.rawInput);
  let readable = true;
  if (action === ACTIONS.EXECUTE) {
    if (command) action = classifyCommand(command);
    else readable = false; // a command we cannot see is a command we cannot vouch for
  }
  const paths = (Array.isArray(call.locations) ? call.locations : [])
    .map((l) => (l && typeof l.path === 'string' ? l.path : null)).filter(Boolean);
  return { action, approval: approvalFor(action), command, paths, readable };
}

/** `capability` means: allowed without a card only if the job was granted that domain up front. */
function approvalFor(action) {
  if (action === ACTIONS.NONE || action === ACTIONS.READ) return 'never';
  if (action === ACTIONS.NETWORK) return 'capability';
  return 'always';
}

/**
 * What noevia does with one classified call, before any human sees it.
 *
 * `allow` is only ever reached by a read, a no-op, or a network call to a domain the job was
 * granted when it was created — capability sets are fixed at creation (§4) so this can never
 * widen mid-run. Everything else asks. `deny` is for what the job may not do at all: a write
 * outside the workspace root, or a class the job was never granted.
 *
 * @param {{classified: ReturnType<typeof classify>, capabilities?: string[], domains?: string[],
 *          inWorkspace?: boolean|null}} input
 * @returns {{decision: 'allow'|'ask'|'deny', reason: string}}
 */
function decide({ classified, capabilities = [], domains = [], inWorkspace = null } = {}) {
  const { action, approval, command, readable, paths } = classified;
  // Containment first: an edit or delete outside the worktree is refused, never offered.
  // `null` means the path is not known yet, which is itself a reason to ask rather than allow.
  if ((action === ACTIONS.EDIT || action === ACTIONS.DELETE) && paths.length && inWorkspace === false) {
    return { decision: 'deny', reason: 'The path is outside this task\u2019s workspace.' };
  }
  if (action !== ACTIONS.NONE && action !== ACTIONS.READ && capabilities.length && !capabilities.includes(action)) {
    return { decision: 'deny', reason: `This task was not granted ${action.replace(/_/g, ' ')}.` };
  }
  if (approval === 'never') return { decision: 'allow', reason: 'Read-only.' };
  if (approval === 'capability') {
    const host = hostOf(command);
    if (host && domains.some((d) => host === d || host.endsWith('.' + d))) {
      return { decision: 'allow', reason: `${host} is on this task\u2019s allowed list.` };
    }
    return { decision: 'ask', reason: host ? `Network request to ${host}.` : 'Network request.' };
  }
  return { decision: 'ask', reason: readable ? '' : 'The harness did not say what it would run.' };
}

function hostOf(command) {
  const match = String(command || '').match(/https?:\/\/([^\s/'"`)]+)/i);
  if (!match) return null;
  return match[1].split('@').pop().split(':')[0].toLowerCase() || null;
}

/**
 * Turn a human decision into the ACP permission option to send back.
 *
 * `allow_always` is deliberately mapped from noevia's "Allow for this chat", and the caller
 * scopes it to the running job and this action class only \u2014 there is no global never-ask, and
 * nothing here persists past the job. When the option noevia needs was not offered (the spike
 * saw `reject_always` missing), fall back to the strictest option that exists, and cancel if
 * nothing safe is on offer.
 *
 * @param {Array<{optionId: string, kind?: string}>} options
 * @param {'allow_once'|'allow_always'|'reject_once'|'reject_always'} wanted
 */
function pickOption(options, wanted) {
  const list = (Array.isArray(options) ? options : []).filter((o) => o && typeof o.optionId === 'string');
  const byKind = (kind) => list.find((o) => o.kind === kind || o.optionId === kind);
  const order = wanted.startsWith('allow')
    ? [wanted, wanted === 'allow_always' ? 'allow_once' : 'allow_always']
    // Refusing: never silently downgrade to an allow. A missing reject means cancel.
    : [wanted, wanted === 'reject_always' ? 'reject_once' : 'reject_always'];
  for (const kind of order) { const found = byKind(kind); if (found) return { outcome: 'selected', optionId: found.optionId }; }
  return { outcome: 'cancelled' };
}

module.exports = { ACTIONS, KIND_ACTIONS, classify, classifyCommand, commandOf, approvalFor, worst, decide, pickOption, hostOf };
