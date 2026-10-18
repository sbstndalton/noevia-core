'use strict';
// CodeHarness contract v0: turn one ACP tool call into noevia's own action model and say
// whether a human has to answer for it (spec-agent-execution §3, and the measured behaviour in
// experiments/acp-spike, removed in #846; see git history at cc1bc4a9).
//
// Two rules decide everything here:
//  * Fail closed. An unfamiliar kind, an unreadable command or a missing permission option is
//    treated as the most consequential thing it could be, exactly as `isWriteTool` treats an
//    unknown tool as a write.
//  * ACP permission is evidence of intent, not the boundary. The spike showed an agent writing
//    and running commands in its own process without asking; the OS sandbox and the workspace
//    root are what actually contain it. Nothing here may be read as making that unnecessary.
//
// The rules themselves (the shell reader, the command classes, decide and pickOption) are
// noevia-rs's code-actions crate (dav-parse.wasm code_actions), always: CODE_ACTIONS_IMPL was
// retired in #1071 and the JS classifier (lex, analyzeCommand, classifyJs, decideJs, pickOptionJs)
// deleted. This module sends the crate only what each function reads (classifyInput, decideInput,
// pickInput) and applies its answer alone. When the crate refuses, faults or replies badly (logged
// once per reason, command-text free) the result is the strict one:
//   - classify returns an unverified classification: an unreadable command is treated as the riskiest
//     kind, the most consequential class (external_account), approval 'always', unreadable, simple and
//     standable false, `unverified: true`, why it could not be checked, and only the paths the call
//     stated itself (its command's paths are unknown);
//   - decide treats that class like any other, without asking the crate: a task whose grants do not
//     include external_account is denied, naming the missing permission (the live behaviour for a
//     class the task was not granted); a path known to be outside the workspace is denied; otherwise
//     the call goes to a person ('ask'), never allowed and never standing, and the reason says why it
//     could not be checked and that its workspace limits could not be checked either (its paths are
//     unknown) or that it reaches outside the workspace. A command that cannot be checked is never
//     denied for being unreadable alone: with the grant it always becomes an approval card;
//   - decide asks a person too when it cannot get an answer for a classified call (a fault, a bad reply;
//     live kept a JS deny, if there was one, which nothing here can recompute). When the crate refused a
//     network call whose URL host it cannot read exactly (outside its plain-ASCII, non-IP-shorthand
//     subset), it is asked again without the command; whatever it does not deny is put to a person, never
//     allowed;
//   - pickOption answers { outcome: 'cancelled' } (a refusal).
// Faults are logged (command-text free) on the first occurrence of each reason and again at the 10th,
// 100th, 1000th and so on, so a persistent runtime fault is not silent.
// Stricter than the former JS (the crate docs): a command array element that is not a string,
// boolean, null or safe integer; in the network branch of decide, a URL host outside the
// plain-ASCII, non-IP-shorthand subset; more than 256 Ki-units of reading work (noevia#1212: every
// refusal in well under 10 ms); input over 2 MiB. A missing or tampered module stops startup.

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

/** The keys an ACP agent may put its command text under in `rawInput`, in the order they are read. */
const COMMAND_KEYS = Object.freeze(['command', 'cmd', 'script', 'shell', 'commandLine']);

/** The command text an ACP agent puts in `rawInput`, whatever key it chose. */
function commandOf(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') return '';
  for (const key of COMMAND_KEYS) {
    const value = rawInput[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.map(String).join(' ').trim();
  }
  if (Array.isArray(rawInput.args) && rawInput.args.length) return rawInput.args.map(String).join(' ').trim();
  return '';
}

const defaultLoader = () => require('./dav-parse-wasm.cjs');

const seenPort = new Map();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (!seenPort.has(key) && seenPort.size >= 200) return; // bounded
  const n = (seenPort.get(key) || 0) + 1;
  seenPort.set(key, n);
  if (n === 1 || (n >= 10 && /^10*$/.test(String(n)))) console.warn(`[code-actions] ${event} (${reason}); the call was handled as unverified${n > 1 ? ` (${n} times so far)` : ''}`);
}

/** `{ port }` with the crate's `{ text, reply }`, or `{ fault }` with the reason after a refusal or fault (logged). */
function askPort(what, ask) {
  try {
    return { port: ask() };
  } catch (err) {
    const fault = String(err?.reason || 'unexpected').slice(0, 40);
    portWarn(`code_actions.${what}.wasm_fault`, fault);
    return { fault };
  }
}

// What classify() reads of a call, each value as commandOf reads it: a string as is, an array's
// elements as String() reads them when that is fixed (strings, booleans, null, finite numbers; any
// other element becomes {} and the port refuses), anything else null (not a command).
const projectElement = (e) => (typeof e === 'string' || typeof e === 'boolean' || e === null
  || (typeof e === 'number' && Number.isFinite(e)) ? e : {});
const projectValue = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? Array.from(v, projectElement) : null);
function classifyInput(call) {
  const raw = call.rawInput;
  let rawInput = null;
  if (raw && typeof raw === 'object') {
    rawInput = {};
    for (const key of [...COMMAND_KEYS, 'args']) {
      const value = raw[key];
      if (value !== undefined) rawInput[key] = projectValue(value);
    }
    rawInput.noeviaOutsideWorkspace = raw.noeviaOutsideWorkspace === true;
  }
  return {
    kind: typeof call.kind === 'string' ? call.kind : null,
    rawInput,
    locations: Array.isArray(call.locations) ? Array.from(call.locations, (l) => (l && typeof l.path === 'string' ? l.path : null)) : [],
  };
}


/** Why the crate could not check a call, in words for the approval card. */
const WHY = { too_large: 'too large or complex to check', input: 'its arguments have a form that cannot be checked', ambiguous: 'it names a host that cannot be read exactly' };
const whyOf = (fault) => WHY[fault] || 'the checker did not answer';

/** What a call the crate could not classify is treated as: the most consequential class, never allowed or stood behind. */
function unverifiedClassification(call, fault) {
  let command = '', paths = [], outsideWorkspace = false;
  try { command = commandOf(call?.rawInput); } catch { command = ''; }
  // Only the paths the call states itself: the paths a command would name or write are unknown.
  try { paths = [...new Set((Array.isArray(call?.locations) ? call.locations : []).map((l) => (l && typeof l.path === 'string' ? l.path : null)).filter(Boolean))]; } catch { paths = []; }
  try { outsideWorkspace = !!call?.rawInput && typeof call.rawInput === 'object' && call.rawInput.noeviaOutsideWorkspace === true; } catch { outsideWorkspace = false; }
  return { action: ACTIONS.EXTERNAL, approval: 'always', command, paths, readable: false, actions: [ACTIONS.EXTERNAL], simple: false, standable: false,
    unverified: true, unverifiedWhy: whyOf(fault), ...(outsideWorkspace ? { outsideWorkspace: true } : {}) };
}

/**
 * Classify one ACP tool call, by the Rust port. Option: `wasmLoader` (tests).
 * @param {{kind?: string, title?: string, rawInput?: object, locations?: Array<{path?: string}>}} call
 * @returns {{action: string, approval: 'never'|'always'|'capability', command: string, paths: string[], readable: boolean,
 *            actions: string[], simple: boolean, standable: boolean, unverified?: true}}
 */
function classify(call = {}, { wasmLoader = defaultLoader } = {}) {
  const { port, fault } = askPort('classify', () => wasmLoader().codeActionsClassify(classifyInput(call)));
  return port ? port.reply : unverifiedClassification(call, fault);
}

const isStrings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
/** What decide() reads, shape-checked (a classification from classify() always passes). */
function decideInput({ classified: c, capabilities = [], domains = [], inWorkspace = null }) {
  const actions = Array.isArray(c?.actions) ? c.actions : [];
  if (!c || typeof c !== 'object' || typeof c.action !== 'string' || typeof c.approval !== 'string'
    || typeof c.command !== 'string' || typeof c.readable !== 'boolean' || typeof c.simple !== 'boolean'
    || !isStrings(c.paths) || !isStrings(actions) || !isStrings(capabilities) || !isStrings(domains)
    || !(inWorkspace === true || inWorkspace === false || inWorkspace === null)) {
    throw Object.assign(new Error('decide input has an unexpected shape'), { reason: 'input' });
  }
  return [{ action: c.action, approval: c.approval, command: c.command, readable: c.readable, paths: c.paths,
    actions, simple: c.simple }, capabilities, domains, inWorkspace];
}

const UNVERIFIED_ASK = 'This action could not be verified, so a person has to approve it.';
const unverifiedAsk = (c) => {
  const where = c.outsideWorkspace === true ? ' It reaches outside the task\u2019s workspace.'
    : ' The paths its command would touch are unknown, so the task\u2019s workspace limits could not be checked either.';
  return `This action could not be checked (${String(c.unverifiedWhy || whyOf())}), so a person has to approve it.${where}`;
};
const UNVERIFIED_NOT_GRANTED = 'This command could not be checked, so it is treated as the most consequential kind of action (external account), which this task was not granted.';
/** An unverified classification is decided as the class it is treated as: the grants, then the workspace, then a person. */
function decideUnverified({ classified: c, capabilities = [], inWorkspace = null }) {
  if (Array.isArray(capabilities) && capabilities.length && !capabilities.includes(ACTIONS.EXTERNAL)) return { decision: 'deny', reason: UNVERIFIED_NOT_GRANTED };
  if (inWorkspace === false && Array.isArray(c.paths) && c.paths.length) return { decision: 'deny', reason: 'The path is outside this task\u2019s workspace.' };
  return { decision: 'ask', reason: unverifiedAsk(c) };
}

/**
 * What noevia does with one classified call, by the Rust port: `allow` is only ever reached by a read, a no-op, or a
 * network call to a domain the job was granted when it was created; an edit or delete outside the workspace root, or a
 * class the job was never granted, is `deny`; everything else asks. An unverified classification is decided as the
 * most consequential class with unknown paths (see the header): denied without the grant, otherwise a person is asked.
 * A refusal or a fault on a classified call asks a person. Option: `wasmLoader` (tests).
 * @param {{classified: ReturnType<typeof classify>, capabilities?: string[], domains?: string[], inWorkspace?: boolean|null}} input
 * @returns {{decision: 'allow'|'ask'|'deny', reason: string}}
 */
function decide(input = {}, { wasmLoader = defaultLoader } = {}) {
  if (input?.classified?.unverified === true) return decideUnverified(input);
  const { port, fault } = askPort('decide', () => wasmLoader().codeActionsDecide(...decideInput(input)));
  if (port) return port.reply;
  if (fault === 'ambiguous' && input.classified.approval === 'capability') {
    // The crate could not read a URL host exactly. What it denies without the command (the workspace, the granted
    // classes) stays denied; anything else is put to a person, never allowed. In practice this branch is defence:
    // the crate decides those denials before it reads a host, so a refusal here means none applied and the second
    // answer is an ask. It is kept so a change in the crate's order cannot turn a deny into an ask unnoticed.
    const [classified, capabilities, domains, inWorkspace] = decideInput(input);
    const again = askPort('decide.again', () => wasmLoader().codeActionsDecide({ ...classified, command: '' }, capabilities, domains, inWorkspace));
    if (again.port) return again.port.reply.decision === 'deny' ? again.port.reply : { decision: 'ask', reason: UNVERIFIED_ASK };
  }
  return { decision: 'ask', reason: UNVERIFIED_ASK };
}

/** What pickOption() reads of the offered options. */
const pickInput = (options) => (Array.isArray(options) ? Array.from(options, (o) => (o && typeof o.optionId === 'string'
  ? { optionId: o.optionId, kind: typeof o.kind === 'string' ? o.kind : null } : null)) : []);

/**
 * The ACP permission option for a human decision, by the Rust port: `allow_always` is deliberately mapped from noevia's
 * "Allow for this chat" (the caller scopes it to the running job and this action class only); when the option noevia
 * needs was not offered, the strictest one that exists, and a cancel when nothing safe is on offer. Any doubt (a refusal,
 * a fault) cancels. Option: `wasmLoader` (tests).
 * @param {Array<{optionId: string, kind?: string}>} options
 * @param {'allow_once'|'allow_always'|'reject_once'|'reject_always'} wanted
 */
function pickOption(options, wanted, { wasmLoader = defaultLoader } = {}) {
  const { port } = askPort('pick', () => wasmLoader().codeActionsPick(pickInput(options), wanted));
  return port ? port.reply : { outcome: 'cancelled' };
}

module.exports = { ACTIONS, COMMAND_KEYS, classify, commandOf, decide, pickOption, classifyInput, decideInput, pickInput, UNVERIFIED_ASK };
