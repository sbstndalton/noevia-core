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
// EXECUTE ranks above NETWORK: `curl … | sh` runs code, and must never be read as "just a fetch"
// that a domain allow-list can wave through.
const SEVERITY = [ACTIONS.EXTERNAL, ACTIONS.GIT_PUSH, ACTIONS.DELETE, ACTIONS.BROWSER, ACTIONS.INSTALL,
  ACTIONS.EXECUTE, ACTIONS.NETWORK, ACTIONS.EDIT, ACTIONS.READ, ACTIONS.NONE];
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
// Wrappers that only prefix a real command. The value lists the options that take an argument,
// so `nice -n 10 rm x` reaches `rm`, not `10`.
const WRAPPERS = new Map(Object.entries({
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'], doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'], nohup: [], setsid: [], time: ['-f', '-o'],
  nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p'], command: [], builtin: [], exec: ['-a'],
  stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k', '--signal', '--kill-after'], chronic: [], unbuffer: [],
  xargs: ['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-s', '-E', '-e', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace'],
}));
// Wrappers whose inner command is built at run time (stdin, a string): never a standing approval.
const DYNAMIC_WRAPPERS = new Set(['xargs']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'perl', 'ruby', 'php', 'deno', 'bun', 'lua', 'osascript', 'pwsh', 'powershell']);
// git options that come before the subcommand, and whether they take a separate argument.
const GIT_GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds', '--attr-source']);
const MAX_DEPTH = 6;

/**
 * A small POSIX-shell reader: enough to see what a command line runs, never enough to run it.
 * Returns the simple commands (unquoted words), the text of every `$(…)`/backtick/process
 * substitution, the targets of output redirects, and whether anything beyond one plain command
 * was present (`compound`). Anything it cannot read closes (`broken`).
 */
function lex(text) {
  const segments = [];
  const nested = [];
  const redirects = [];
  let words = [];
  let word = null; // null = no word in progress; '' = an (empty) quoted word
  let compound = false;
  let broken = false;
  let dynamic = false; // `$VAR` in command position etc.
  let pendingRedirect = false;
  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect) { redirects.push(word); pendingRedirect = false; } else words.push(word);
    word = null;
  };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  const readBalanced = (i) => { // text[i] is just past `(`; returns [inner, index after `)`]
    let depth = 1; let j = i; let q = null;
    for (; j < text.length; j++) {
      const c = text[j];
      if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') j++; continue; }
      if (c === '\\') { j++; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return [text.slice(i, j), j + 1];
    }
    broken = true; return [text.slice(i), text.length];
  };
  const readBacktick = (i) => {
    const end = text.indexOf('`', i);
    if (end === -1) { broken = true; return [text.slice(i), text.length]; }
    return [text.slice(i, end), end + 1];
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue; }
      word = (word || '') + (text[i + 1] || ''); i += 2; continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) { broken = true; word = (word || '') + text.slice(i + 1); break; }
      word = (word || '') + text.slice(i + 1, end); i = end + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let buf = '';
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length) { buf += text[++j]; continue; }
        if (text[j] === '`') { compound = true; const [inner, next] = readBacktick(j + 1); nested.push(inner); j = next - 1; continue; }
        if (text[j] === '$' && text[j + 1] === '(') { compound = true; const [inner, next] = readBalanced(j + 2); nested.push(inner); j = next - 1; continue; }
        buf += text[j];
      }
      if (j >= text.length) broken = true;
      word = (word || '') + buf; i = j + 1; continue;
    }
    if (c === '`') { compound = true; const [inner, next] = readBacktick(i + 1); nested.push(inner); word = (word || '') + '$SUB'; i = next; continue; }
    if (c === '$' && text[i + 1] === '(') { compound = true; const [inner, next] = readBalanced(i + 2); nested.push(inner); word = (word || '') + '$SUB'; i = next; continue; }
    if ((c === '<' || c === '>') && text[i + 1] === '(') { // process substitution
      compound = true; endWord(); const [inner, next] = readBalanced(i + 2); nested.push(inner); i = next; continue;
    }
    if (c === '>' || c === '<' || (c === '&' && text[i + 1] === '>')) {
      compound = true;
      // `2>` / `2>&1`: the fd number belongs to the redirect, not to the command.
      if (word !== null && /^\d+$/.test(word)) word = null; else endWord();
      let j = i + (c === '&' ? 1 : 0);
      const output = text[j] === '>';
      j++;
      if (text[j] === '>' || text[j] === '|') j++;
      if (text[j] === '<' && c === '<') { j++; if (text[j] === '<') j++; } // heredoc / herestring
      if (text[j] === '&') { j++; while (/[\d-]/.test(text[j] || '')) j++; i = j; continue; } // dup an fd
      while (text[j] === ' ' || text[j] === '\t') j++;
      if (output) pendingRedirect = true; else pendingRedirect = false;
      if (!output) { // input: read and discard the source word
        let k = j; while (k < text.length && !/[\s;&|<>()]/.test(text[k])) k++; i = k; continue;
      }
      i = j; continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') {
      compound = true; endSegment(); i++; continue;
    }
    if (c === '(' || c === ')' || ((c === '{' || c === '}') && word === null && /[\s;]|$/.test(text[i + 1] || ''))) {
      compound = true; endSegment(); i++; continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '$' && word === null && words.length === 0) dynamic = true;
    word = (word || '') + c; i++;
  }
  endSegment();
  if (pendingRedirect) broken = true;
  return { segments, nested, redirects, compound, broken, dynamic };
}

/**
 * Everything a command line does: the worst class, every class present (so capability checks see
 * the `sh` behind a `curl |`), whether it is one plain command, and whether a standing approval
 * may ever cover it.
 * @returns {{action: string, actions: string[], simple: boolean, standable: boolean}}
 */
function analyzeCommand(command, depth = 0) {
  const text = String(command || '').trim();
  if (!text) return { action: ACTIONS.EXECUTE, actions: [ACTIONS.EXECUTE], simple: false, standable: false };
  if (depth > MAX_DEPTH) return { action: ACTIONS.EXECUTE, actions: [ACTIONS.EXECUTE], simple: false, standable: false };
  const lexed = lex(text);
  const found = new Set();
  let standable = !lexed.broken && !lexed.dynamic;
  const add = (r) => { for (const a of r.actions) found.add(a); if (!r.standable) standable = false; };
  for (const words of lexed.segments) add(classifyWords(words, depth));
  for (const inner of lexed.nested) add(analyzeCommand(inner, depth + 1));
  // Writing a file through `>` is an edit, whatever the command was.
  if (lexed.redirects.some((t) => !/^\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(t))) found.add(ACTIONS.EDIT);
  if (lexed.broken || lexed.dynamic) found.add(ACTIONS.EXECUTE);
  if (!found.size) found.add(ACTIONS.EXECUTE);
  let action = ACTIONS.NONE;
  for (const a of found) action = worst(action, a);
  if (action === ACTIONS.NONE) action = ACTIONS.EXECUTE;
  const simple = !lexed.compound && !lexed.broken && !lexed.dynamic && lexed.segments.length === 1 && found.size === 1;
  return { action, actions: [...found], simple, standable };
}

/**
 * Classify one shell command. Compound commands take their worst part, so
 * `echo hi && rm -rf build` is a delete, not an ordinary command.
 * @param {string} command
 */
function classifyCommand(command) { return analyzeCommand(command).action; }

const one = (action, standable = true) => ({ actions: [action], standable });

/** Classify one simple command (already unquoted words). */
function classifyWords(input, depth) {
  let words = input.slice();
  let standable = true;
  // Peel `FOO=bar` prefixes and wrappers until the command that actually runs.
  for (;;) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    if (!words.length) return one(ACTIONS.NONE);
    const name = words[0].split('/').pop();
    if (!WRAPPERS.has(name)) break;
    if (DYNAMIC_WRAPPERS.has(name)) standable = false;
    const withArg = WRAPPERS.get(name);
    let k = 1;
    while (k < words.length) {
      const w = words[k];
      if (w === '--') { k++; break; }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { k++; continue; }
      if (!w.startsWith('-') || w === '-') break;
      if (withArg.includes(w)) k += 2; else k++;
    }
    if (name === 'timeout' && k < words.length) k++; // the duration
    words = words.slice(k);
    if (!words.length) return one(ACTIONS.EXECUTE, standable);
  }
  const name = words[0].split('/').pop();
  if (!name || name.includes('$')) return one(ACTIONS.EXECUTE, false);
  const rest = words.slice(1);

  // A shell given a string runs that string: classify the string, and never let it stand.
  if (SHELLS.has(name) || name === 'eval' || name === 'source' || name === '.') {
    let inner = null;
    if (name === 'eval') inner = rest.join(' ');
    else {
      const idx = rest.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (idx !== -1) inner = rest.slice(idx + 1).find((w) => !w.startsWith('-')) ?? '';
    }
    if (inner === null) return one(ACTIONS.EXECUTE, false);
    const r = analyzeCommand(inner, depth + 1);
    return { actions: r.actions.includes(ACTIONS.EXECUTE) ? r.actions : [...r.actions, ACTIONS.EXECUTE], standable: false };
  }
  if (INTERPRETERS.has(name) && rest.some((w) => /^-[A-Za-z]*[ceE]$/.test(w) || w === '--eval' || w === '--command')) {
    return one(ACTIONS.EXECUTE, false);
  }
  if (name === 'find') {
    const actions = new Set([ACTIONS.EXECUTE]);
    let own = true;
    rest.forEach((w, k) => {
      if (w === '-delete') actions.add(ACTIONS.DELETE);
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(w)) {
        own = false;
        const end = rest.findIndex((x, m) => m > k && (x === ';' || x === '+' || x === '\;'));
        const r = classifyWords(rest.slice(k + 1, end === -1 ? undefined : end), depth + 1);
        r.actions.forEach((a) => actions.add(a));
      }
    });
    return { actions: [...actions], standable: own && standable };
  }
  if (name === 'git' || name.startsWith('git-')) return one(gitAction(name, rest), standable);
  const args = rest.filter((w) => !w.startsWith('-'));
  if (INSTALLERS.has(name)) return one(INSTALLERS.get(name).includes(args[0]) ? ACTIONS.INSTALL : ACTIONS.EXECUTE, standable);
  if (NETWORK_COMMANDS.has(name)) return one(ACTIONS.NETWORK, standable);
  if (DELETE_COMMANDS.has(name)) return one(ACTIONS.DELETE, standable);
  if (BROWSER_COMMANDS.has(name)) return one(ACTIONS.BROWSER, standable);
  return one(ACTIONS.EXECUTE, standable);
}

function gitAction(name, rest) {
  if (name !== 'git') return GIT_SUBCOMMANDS.get(name.slice(4)) || ACTIONS.EXECUTE; // `git-push`
  let k = 0;
  let aliased = false;
  while (k < rest.length && rest[k].startsWith('-')) {
    const w = rest[k];
    if (w === '--') { k++; break; }
    if (GIT_GLOBAL_WITH_ARG.has(w)) {
      if ((w === '-c' || w === '--config-env') && /^alias\./i.test(rest[k + 1] || '')) aliased = true;
      k += 2; continue;
    }
    if (/^-c.+/.test(w) && /^-calias\./i.test(w)) aliased = true;
    k++; // `--git-dir=x`, `-p`, `--no-pager`, `--bare`, `-Cpath` …
  }
  // An alias defined on the command line can be anything, including a push.
  if (aliased) return ACTIONS.GIT_PUSH;
  const sub = rest[k];
  if (sub === 'send-pack' || sub === 'http-push') return ACTIONS.GIT_PUSH;
  return GIT_SUBCOMMANDS.get(sub) || ACTIONS.EXECUTE;
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
 * @returns {{action: string, approval: 'never'|'always'|'capability', command: string, paths: string[], readable: boolean,
 *            actions: string[], simple: boolean, standable: boolean}}
 */
function classify(call = {}) {
  const kind = typeof call.kind === 'string' ? call.kind : '';
  // An unknown kind is not a read. Treat it like `other`.
  let action = Object.prototype.hasOwnProperty.call(KIND_ACTIONS, kind) ? KIND_ACTIONS[kind] : ACTIONS.EXECUTE;
  const command = commandOf(call.rawInput);
  let readable = true;
  let actions = [action];
  let simple = true;
  let standable = true;
  if (action === ACTIONS.EXECUTE) {
    if (command) ({ action, actions, simple, standable } = analyzeCommand(command));
    else readable = false; // a command we cannot see is a command we cannot vouch for
  }
  const paths = (Array.isArray(call.locations) ? call.locations : [])
    .map((l) => (l && typeof l.path === 'string' ? l.path : null)).filter(Boolean);
  return { action, approval: approvalFor(action), command, paths, readable, actions, simple, standable };
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
  // Every part of a compound command needs its own grant: `curl … | sh` executes.
  const all = Array.isArray(classified.actions) && classified.actions.length ? classified.actions : [action];
  const missing = all.find((a) => a !== ACTIONS.NONE && a !== ACTIONS.READ && capabilities.length && !capabilities.includes(a));
  if (missing) {
    return { decision: 'deny', reason: `This task was not granted ${missing.replace(/_/g, ' ')}.` };
  }
  if (approval === 'never') return { decision: 'allow', reason: 'Read-only.' };
  if (approval === 'capability') {
    const host = hostOf(command);
    // Only ONE plain network command is waved through, and only when every URL it names is on
    // the list. A pipe, a `;`, a redirect or a substitution always goes to a human.
    const hosts = hostsOf(command);
    const listed = (h) => domains.some((d) => h === d || h.endsWith('.' + d));
    if (classified.simple !== false && hosts.length && hosts.every(listed)) {
      return { decision: 'allow', reason: `${host} is on this task\u2019s allowed list.` };
    }
    return { decision: 'ask', reason: host ? `Network request to ${host}.` : 'Network request.' };
  }
  return { decision: 'ask', reason: readable ? '' : 'The harness did not say what it would run.' };
}

function hostsOf(command) {
  return [...String(command || '').matchAll(/https?:\/\/([^\s/'"`)?#]+)/gi)]
    .map((m) => m[1].split('@').pop().split(':')[0].toLowerCase()).filter(Boolean);
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

module.exports = { ACTIONS, KIND_ACTIONS, classify, classifyCommand, analyzeCommand, commandOf, approvalFor, worst, decide, pickOption, hostOf };
