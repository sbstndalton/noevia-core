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
// Only curl, wget and httpie stay plain network, and only with read-only flags (see networkWords).
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'http', 'https']);
// Remote shells and raw sockets run whatever they are told on the far end (or locally via -e / -o
// ProxyCommand): never waved through by the domain list.
const REMOTE_EXEC_COMMANDS = new Set(['nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp']);
// Downloads and runs a package.
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
// curl/wget flags that neither write a file nor read config/upload data. Anything else is not.
const CURL_SAFE_BARE = new Set(['-q', '--disable', '--silent', '--show-error', '--location', '--head', '--fail', '--compressed']);
const CURL_SAFE_SHORT = /^-[sSLIf]+$/;
const CURL_SAFE_WITH_ARG = new Set(['-H', '--header', '-A', '--user-agent', '-m', '--max-time', '--retry']);
const CURL_WRITE_FLAGS = /^(-[a-zA-Z]*[oOJDc]|--output|--output-dir|--remote-name|--remote-name-all|--remote-header-name|--dump-header|--cookie-jar|--create-dirs|--trace|--trace-ascii|--stderr|--libcurl|--etag-save|--hsts|--alt-svc)/;
const WGET_SAFE_BARE = new Set(['-q', '--quiet', '--spider', '-qO-', '-O-']);
const WGET_SAFE_WITH_ARG = new Set(['--timeout', '--tries', '--header', '-U', '--user-agent', '-T', '-t']);
const WGET_WRITE_FLAGS = /^(-[a-zA-Z]*[OoaPx]|--output-document|--output-file|--append-output|--directory-prefix|--mirror|--recursive|-r|-m|--save-headers|--save-cookies|--force-directories|--backups|--warc-file)/;
// git config keys that run a command or reroute traffic; any of them on the command line.
const GIT_DANGEROUS_KEY = /^(core\.sshcommand|core\.gitproxy|core\.fsmonitor|core\.hookspath|core\.pager|core\.editor|credential\.|http\.proxy|https\.proxy|http\..*\.proxy|protocol\.|url\.|remote\..*\.(uploadpack|receivepack|proxy)|uploadpack\.|include\.|includeif\.|diff\.|filter\.|merge\.|gpg\.|ssh\.)/i;
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
  let complex = false;
  const writes = [];
  const add = (r) => {
    for (const a of r.actions) found.add(a);
    if (!r.standable) standable = false;
    if (r.complex || r.simple === false) complex = true;
    if (Array.isArray(r.writes)) writes.push(...r.writes);
  };
  for (const words of lexed.segments) add(classifyWords(words, depth));
  for (const inner of lexed.nested) add(analyzeCommand(inner, depth + 1));
  // Writing a file through `>` is an edit, whatever the command was — and whatever else the
  // command is, the target is a write the containment check must see (#225).
  const written = lexed.redirects.filter((t) => !/^\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(t));
  if (written.length) found.add(ACTIONS.EDIT);
  writes.push(...written);
  // A target the shell expands (`~`, `$VAR`, `$SUB`) or resolves after a `cd` cannot be judged
  // here, so no standing approval may carry the call past a human.
  const moves = lexed.segments.some((w) => ['cd', 'pushd', 'popd'].includes(String(w[0] || '').split('/').pop()));
  if (writes.some((t) => /^~|\$/.test(t) || (moves && !t.startsWith('/')))) standable = false;
  if (lexed.broken || lexed.dynamic) found.add(ACTIONS.EXECUTE);
  if (!found.size) found.add(ACTIONS.EXECUTE);
  let action = ACTIONS.NONE;
  for (const a of found) action = worst(action, a);
  if (action === ACTIONS.NONE) action = ACTIONS.EXECUTE;
  const simple = !complex && !lexed.compound && !lexed.broken && !lexed.dynamic && lexed.segments.length === 1 && found.size === 1;
  return { action, actions: [...found], simple, standable, writes: [...new Set(writes)] };
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
  let prefixed = false; // an env prefix or wrapper ran before the real command
  // Peel `FOO=bar` prefixes and wrappers until the command that actually runs.
  for (;;) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words = words.slice(1); prefixed = true; }
    if (!words.length) return one(ACTIONS.NONE);
    const name = words[0].split('/').pop();
    if (!WRAPPERS.has(name)) break;
    if (DYNAMIC_WRAPPERS.has(name)) standable = false;
    prefixed = true;
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
  // Inline code (`-c`, `-e`, `node -p`, `php -r`) or a preload (`node -r`, `ruby -r`, `perl -M`,
  // `lua -l`), in any cluster or with the value attached (`-eprint 1`), is never a standing
  // approval (#182).
  if (INTERPRETERS.has(name) && rest.some((w) => /^-[A-Za-z]*[ceEprlM]/.test(w)
    || /^--(eval|command|print|require|import|loader|experimental-loader|preload)(=|$)/.test(w))) {
    return one(ACTIONS.EXECUTE, false);
  }
  if (name === 'find') {
    const actions = new Set([ACTIONS.EXECUTE]);
    const writes = [];
    let own = true;
    rest.forEach((w, k) => {
      if (w === '-delete') actions.add(ACTIONS.DELETE);
      // `-fprint FILE` and friends write the listing to a file: an edit whose target must pass
      // the containment check (#182).
      if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(w)) {
        actions.add(ACTIONS.EDIT);
        if (k + 1 < rest.length) writes.push(rest[k + 1]);
        own = false;
      }
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(w)) {
        own = false;
        const end = rest.findIndex((x, m) => m > k && (x === ';' || x === '+' || x === '\;'));
        const r = classifyWords(rest.slice(k + 1, end === -1 ? undefined : end), depth + 1);
        r.actions.forEach((a) => actions.add(a));
      }
    });
    return { actions: [...actions], standable: own && standable, writes };
  }
  if (name === 'git' || name.startsWith('git-')) {
    const g = gitAction(name, rest);
    return one(g.action, standable && g.standable);
  }
  const args = rest.filter((w) => !w.startsWith('-'));
  if (name === 'gh' || publishes(name, args)) return one(ACTIONS.EXTERNAL, false);
  if (INSTALLERS.has(name)) return one(INSTALLERS.get(name).includes(args[0]) ? ACTIONS.INSTALL : ACTIONS.EXECUTE, standable);
  if (PACKAGE_RUNNERS.has(name)) return one(ACTIONS.INSTALL, standable);
  if (REMOTE_EXEC_COMMANDS.has(name)) return one(ACTIONS.EXECUTE, false);
  if (NETWORK_COMMANDS.has(name)) {
    // `LD_PRELOAD=… curl`, `https_proxy=… curl`, `env -S … curl`, `time -o f curl`: the prefix can
    // reroute or hijack the call, so it is never a plain, auto-allowed or standing network read.
    if (prefixed) return { actions: [...new Set([...networkWords(name, rest), ACTIONS.EXECUTE])], standable: false };
    return { actions: networkWords(name, rest), standable, complex: !plainNetwork(name, rest) };
  }
  if (DELETE_COMMANDS.has(name)) return one(ACTIONS.DELETE, standable);
  if (BROWSER_COMMANDS.has(name)) return one(ACTIONS.BROWSER, standable);
  return one(ACTIONS.EXECUTE, standable);
}

// Tools that publish or push to a remote registry/service: EXTERNAL, like `gh`, never standing.
const PUBLISH_SUBCOMMANDS = new Map(Object.entries({
  npm: ['publish'], pnpm: ['publish'], yarn: ['publish', 'npm'], docker: ['push'], podman: ['push'],
  buildah: ['push'], twine: ['upload'], hub: ['push', 'release', 'pull-request'], gem: ['push'],
  cargo: ['publish'], helm: ['push'], poetry: ['publish'], flit: ['publish'],
}));
function publishes(name, args) {
  if (PUBLISH_SUBCOMMANDS.has(name)) return PUBLISH_SUBCOMMANDS.get(name).includes(args[0]);
  if (name === 'glab') return args[0] === 'api' || (['mr', 'release', 'issue'].includes(args[0]) && ['create', 'merge', 'update', 'delete', 'upload', 'close', 'note'].includes(args[1]));
  if (name === 'gcloud') return args.includes('deploy');
  if (name === 'aws') return args[0] === 's3' && ['cp', 'sync', 'mv', 'rm', 'rb', 'mb'].includes(args[1]);
  return false;
}

const isUrl = (w) => /^https?:\/\/\S+$/i.test(w);

/**
 * A curl/wget/httpie call is plain NETWORK only when every word is a URL or a read-only flag.
 * A flag that writes a file adds EDIT; any other flag (config, upload, post-file, unknown) or a
 * bare non-URL word adds EXECUTE. Either makes the call non-simple, so it is never auto-allowed.
 */
function networkWords(name, rest) {
  const actions = new Set([ACTIONS.NETWORK]);
  const other = (w, writes) => actions.add(writes.test(w) ? ACTIONS.EDIT : ACTIONS.EXECUTE);
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    if (isUrl(w)) continue;
    if (name === 'curl') {
      if (CURL_SAFE_BARE.has(w) || CURL_SAFE_SHORT.test(w)) continue;
      // `-H @file` reads headers from a file: not read-only with respect to local secrets.
      if (CURL_SAFE_WITH_ARG.has(w) && k + 1 < rest.length && !rest[k + 1].startsWith('@')) { k++; continue; }
      if (/^--(header|user-agent|max-time|retry)=/.test(w)) continue;
      if ((w === '-X' || w === '--request') && /^GET$/i.test(rest[k + 1] || '')) { k++; continue; }
      if (/^(-XGET|--request=GET)$/i.test(w)) continue;
      other(w, CURL_WRITE_FLAGS);
    } else if (name === 'wget') {
      if (WGET_SAFE_BARE.has(w)) continue;
      if ((w === '-O' || w === '-qO' || w === '--output-document') && rest[k + 1] === '-') { k++; continue; }
      if (w === '--output-document=-') continue;
      if (WGET_SAFE_WITH_ARG.has(w) && k + 1 < rest.length) { k++; continue; }
      if (/^--(timeout|tries|header|user-agent)=/.test(w)) continue;
      other(w, WGET_WRITE_FLAGS);
    } else {
      // httpie: `key=value` sends data, `--download`/`-o` write, anything else is not read-only.
      other(w, /^(-[a-zA-Z]*[od]|--download|--output)/);
    }
  }
  return [...actions];
}

/**
 * Whether a read-only network call is also plain enough to wave through on the domain list.
 * Not when a header re-targets it (`-H 'Host: …'`), and not a curl that may read `.curlrc`
 * (which the agent can write in its HOME and which can upload, proxy or save): only `-q` /
 * `--disable` as the FIRST argument stops that (#224, #148). WGETRC is pinned in the agent env.
 */
function plainNetwork(name, rest) {
  const headerValues = [];
  rest.forEach((w, k) => {
    if (['-H', '--header'].includes(w) && k + 1 < rest.length) headerValues.push(rest[k + 1]);
    const eq = /^--header=(.*)$/s.exec(w); if (eq) headerValues.push(eq[1]);
  });
  if (headerValues.some((h) => /^\s*(host|:authority)\s*:/i.test(h))) return false;
  if (name === 'curl' && !['-q', '--disable'].includes(rest[0])) return false;
  return true;
}

/** @returns {{action: string, standable: boolean}} */
function gitAction(name, rest) {
  if (name !== 'git') { // `git-push`, `/usr/lib/git-core/git-send-pack`
    const sub = name.slice(4);
    if (['send-pack', 'http-push', 'receive-pack'].includes(sub)) return { action: ACTIONS.GIT_PUSH, standable: false };
    return { action: GIT_SUBCOMMANDS.get(sub) || ACTIONS.EXECUTE, standable: true };
  }
  let k = 0;
  let aliased = false;
  let rerouted = false;
  const configKey = (value) => {
    const key = String(value || '').split('=')[0];
    if (/^alias\./i.test(key)) aliased = true;
    if (GIT_DANGEROUS_KEY.test(key)) rerouted = true;
  };
  while (k < rest.length && rest[k].startsWith('-')) {
    const w = rest[k];
    if (w === '--') { k++; break; }
    if (w === '--config-env' || w.startsWith('--config-env=')) {
      // The value comes from the environment, which we cannot see: never plain.
      rerouted = true;
      configKey(w === '--config-env' ? rest[k + 1] : w.slice('--config-env='.length));
      k += w === '--config-env' ? 2 : 1; continue;
    }
    if (w === '-c') { configKey(rest[k + 1]); k += 2; continue; }
    if (/^-c.+/.test(w)) { configKey(w.slice(2)); k++; continue; }
    if (GIT_GLOBAL_WITH_ARG.has(w)) { k += 2; continue; }
    k++; // `--git-dir=x`, `-p`, `--no-pager`, `--bare`, `-Cpath` …
  }
  // An alias defined on the command line can be anything, including a push.
  if (aliased) return { action: ACTIONS.GIT_PUSH, standable: false };
  const sub = rest[k];
  const args = rest.slice(k + 1);
  const has = (...flags) => args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(f + '=')));
  if (sub === 'send-pack' || sub === 'http-push' || sub === 'receive-pack') return { action: ACTIONS.GIT_PUSH, standable: false };
  // History-destroying subcommands: DELETE, which never stands.
  const destructive =
    (sub === 'update-ref' && has('-d', '--delete')) ||
    (sub === 'reset' && has('--hard', '--merge', '--keep')) ||
    (sub === 'branch' && args.some((a) => /^-[a-zA-Z]*[dD]/.test(a) || a === '--delete')) ||
    (sub === 'tag' && args.some((a) => /^-[a-zA-Z]*d/.test(a) || a === '--delete')) ||
    (sub === 'stash' && ['drop', 'clear'].includes(args[0])) ||
    (sub === 'reflog' && ['expire', 'delete'].includes(args[0])) ||
    (sub === 'gc' && args.some((a) => a === '--prune' || a.startsWith('--prune=')));
  if (destructive) return { action: ACTIONS.DELETE, standable: false };
  const action = GIT_SUBCOMMANDS.get(sub) || ACTIONS.EXECUTE;
  // A network subcommand told to run a helper, or with rerouted config, runs code.
  if (action === ACTIONS.NETWORK && (rerouted || has('--upload-pack', '-u', '--receive-pack', '--exec', '--config', '-c', '--template'))) {
    return { action: ACTIONS.EXECUTE, standable: false };
  }
  if (rerouted) return { action: action === ACTIONS.GIT_PUSH ? action : ACTIONS.EXECUTE, standable: false };
  return { action, standable: true };
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
  let writes = [];
  if (action === ACTIONS.EXECUTE) {
    if (command) ({ action, actions, simple, standable, writes } = analyzeCommand(command));
    else readable = false; // a command we cannot see is a command we cannot vouch for
  }
  // A read outside the task's tree (flagged by the pi bridge, #113) always goes to a human.
  if (call.rawInput && typeof call.rawInput === 'object' && call.rawInput.noeviaOutsideWorkspace === true) standable = false;
  const paths = [...new Set([...(Array.isArray(call.locations) ? call.locations : [])
    .map((l) => (l && typeof l.path === 'string' ? l.path : null)).filter(Boolean), ...writes])];
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
  const all = Array.isArray(classified.actions) && classified.actions.length ? classified.actions : [action];
  // Containment first: an edit or delete outside the worktree is refused, never offered — also
  // when the edit rides inside a command whose worst class is something else (`: > ~/x`, #225).
  // `null` means the path is not known yet, which is itself a reason to ask rather than allow.
  const writes = all.includes(ACTIONS.EDIT) || all.includes(ACTIONS.DELETE);
  if (writes && paths.length && inWorkspace === false) {
    return { decision: 'deny', reason: 'The path is outside this task\u2019s workspace.' };
  }
  // Every part of a compound command needs its own grant: `curl … | sh` executes.
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
    if (classified.simple !== false && hosts.length && hosts.every((h) => h && listed(h))) {
      return { decision: 'allow', reason: `${host} is on this task\u2019s allowed list.` };
    }
    return { decision: 'ask', reason: host ? `Network request to ${host}.` : 'Network request.' };
  }
  return { decision: 'ask', reason: readable ? '' : 'The harness did not say what it would run.' };
}

/**
 * Every host a command names, read from the words the shell will actually see (quotes removed),
 * so `https://ok.com'@evil.test'` is evil.test, as curl reads it (#148). Every URL counts, in
 * any argument or flag value; one that cannot be parsed yields an empty host, which no list has.
 */
function hostsOf(command) {
  const text = String(command || '');
  const { segments, nested, redirects } = lex(text);
  const words = [...segments.flat(), ...redirects, ...nested];
  const hosts = [];
  for (const word of words) {
    for (const m of String(word).matchAll(/https?:\/\//gi)) {
      const rest = String(word).slice(m.index).split(/\s/)[0];
      let host = '';
      try { host = new URL(rest).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { host = ''; }
      hosts.push(host);
    }
  }
  return hosts;
}

function hostOf(command) {
  return hostsOf(command).find(Boolean) || null;
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
