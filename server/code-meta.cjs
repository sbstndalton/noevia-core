'use strict';
// What a coding run can say about itself (spec-agent-execution §3 "Gaps to fill via `_meta`",
// feeding §1's identity tuple).
//
// ACP's `_meta` is free-form: the protocol says a field may be there, not what shape it takes,
// and the spike never exercised it. So this reads defensively — several plausible spellings,
// anything unreadable treated as absent — and **says what was missing** rather than defaulting
// it to zero. Evidence that quietly invents a number is worse than evidence that admits a gap,
// which is the whole point of §1's "no universal score; show evidence".
const { identityHash } = require('./evidence.cjs');

const num = (value) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };
const firstNum = (source, keys) => {
  for (const key of keys) { const n = num(source?.[key]); if (n !== null) return n; }
  return null;
};

/** Anywhere a harness might reasonably hang token counts. */
function readUsage(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const holder = [meta.usage, meta.tokenUsage, meta.tokens, meta.noevia?.usage, meta]
    .find((c) => c && typeof c === 'object' && (firstNum(c, INPUT) !== null || firstNum(c, OUTPUT) !== null));
  if (!holder) return null;
  const input = firstNum(holder, INPUT);
  const output = firstNum(holder, OUTPUT);
  const total = firstNum(holder, ['totalTokens', 'total_tokens', 'total']) ?? (input !== null && output !== null ? input + output : null);
  return { input, output, total };
}
const INPUT = ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'input', 'prompt'];
const OUTPUT = ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'output', 'completion'];

/**
 * Context occupancy, which is NOT token usage and must not be recorded as it.
 *
 * OpenCode's `usage_update` carries `{used, size, cost}` — how full the window is right now, not
 * how many tokens the task has spent. Observed on DaServer, 2026-09-17:
 *   {"sessionUpdate":"usage_update","used":8012,"size":24576,"cost":{"amount":0,"currency":"USD"}}
 * Reporting `used` as input tokens would be a plausible-looking lie, so it is kept as its own
 * measurement and the token-usage limitation stands.
 */
function readContext(source) {
  if (!source || typeof source !== 'object') return null;
  for (const holder of [source, source.usage, source._meta, source.context]) {
    if (!holder || typeof holder !== 'object') continue;
    const used = firstNum(holder, ['used', 'usedTokens', 'used_tokens', 'contextUsed', 'context_used']);
    const size = firstNum(holder, ['size', 'contextSize', 'context_size', 'limit', 'window']);
    if (used !== null && size !== null && size > 0) return { used, size, percent: Math.round((used / size) * 100) };
  }
  return null;
}

/** A command's exit status, wherever the harness put it. Zero is a real answer, not absence. */
function readExitCode(source) {
  if (!source || typeof source !== 'object') return null;
  for (const holder of [source, source._meta, source.meta, source.rawOutput, source._meta?.noevia]) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of ['exitCode', 'exit_code', 'exitStatus', 'status_code', 'code']) {
      const n = Number(holder[key]);
      if (Number.isInteger(n)) return n;
    }
  }
  return null;
}

/** Whatever the agent said about itself at `initialize`. */
function readAgent(result) {
  const info = result?.agentInfo || result?.serverInfo || result?._meta?.agentInfo || null;
  return {
    name: typeof info?.name === 'string' ? info.name.slice(0, 80) : null,
    version: typeof info?.version === 'string' ? info.version.slice(0, 40) : null,
    protocolVersion: num(result?.protocolVersion),
  };
}

/**
 * The identity a coding result is scoped to (§1). Everything here changes what "it worked"
 * means, so a change in any of it makes earlier evidence stale rather than comparable.
 */
function codingIdentity({ harness, harnessVersion = null, model = null, provider = null,
  protocolVersion = null, capabilities = [], promptPreparation = 'direct', sandbox = null } = {}) {
  const identity = {
    backend: 'acp',
    harness: harness || 'unknown',
    harnessVersion,
    model,
    provider,
    protocolVersion,
    // The capability set changes what a task is even allowed to attempt, so a run with `git
    // push` off is not evidence about one with it on.
    capabilities: [...capabilities].sort(),
    promptPreparation,
    // Spawned beside noevia or inside the sandbox is a different machine for these purposes.
    sandbox: sandbox || 'spawn',
  };
  return { identity, identityHash: identityHash(identity) };
}

/**
 * Fold what a run reported into one summary, naming what the harness did not say.
 * `limitations` is the honest part: it is what stops this being read as a measurement.
 */
function summarize(input = {}) {
  // Defaults only fill in `undefined`, and every caller here is handling values that came from
  // somewhere else. A module whose whole job is reading unknown shapes must not crash on `null`.
  const source = input && typeof input === 'object' ? input : {};
  const agent = source.agent && typeof source.agent === 'object' ? source.agent : {};
  const usage = source.usage && typeof source.usage === 'object' ? source.usage : null;
  const exits = Array.isArray(source.exits) ? source.exits.filter((e) => e && typeof e === 'object') : [];
  // Streaming text arrives as many small chunks; calling them turns would overstate the work.
  const messageChunks = Number.isFinite(source.messageChunks) ? source.messageChunks : 0;
  const context = source.context && typeof source.context === 'object'
    && Number.isFinite(source.context.used) && Number.isFinite(source.context.size) ? source.context : null;

  const limitations = [];
  if (!agent.version) limitations.push('The harness did not report its version, so this cannot be scoped to one.');
  // Context occupancy is not token usage: a harness can report one and not the other, and this
  // one does exactly that.
  if (!usage || usage.total === null || usage.total === undefined) limitations.push('The harness did not report token usage.');
  if (!exits.length) limitations.push('No command exit codes were reported.');
  return {
    harness: typeof agent.name === 'string' ? agent.name : null,
    harnessVersion: typeof agent.version === 'string' ? agent.version : null,
    protocolVersion: Number.isFinite(agent.protocolVersion) ? agent.protocolVersion : null,
    usage: usage && usage.total !== null && usage.total !== undefined ? usage : null,
    context,
    commands: exits.length,
    failedCommands: exits.filter((e) => Number.isInteger(e.exitCode) && e.exitCode !== 0).length,
    exitCodes: exits.slice(0, 50),
    messageChunks,
    limitations,
  };
}

module.exports = { readUsage, readContext, readExitCode, readAgent, codingIdentity, summarize };
