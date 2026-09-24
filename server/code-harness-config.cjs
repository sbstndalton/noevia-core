'use strict';
// The harness's own configuration file (spec-agent-execution §3).
//
// ACP carries nothing that pins an agent's permissions or tells it which model to use: the
// contract-v1 run against real OpenCode established that its behaviour comes from an
// `opencode.json` in its working directory, and that `_meta` cannot substitute. noevia has to
// own that file, because a harness whose effective permission config we cannot pin is one we
// refuse to run — which is exactly what `configFor` does for a harness it does not know.
//
// Two things go in it, and nothing else:
//   * the gate — every edit, command and fetch asks, so approvals reach the human through
//     noevia rather than being decided by the agent's defaults (which write silently);
//   * where the model lives — the sandbox has no ambient provider configuration and no
//     credentials of its own, so the endpoint and the model name are stated here or the agent
//     has nothing to run on.
const fs = require('node:fs'), nodePath = require('node:path');

/** Every action class asks. There is no "never ask" here either. */
const PERMISSION = Object.freeze({ edit: 'ask', bash: 'ask', webfetch: 'ask' });

/**
 * @param {{harness: string, model: string, engine: string, contextTokens?: number,
 *          outputTokens?: number, apiKey?: string|null}} options
 * @returns {{name: string, json: object}}
 */
function configFor({ harness, model, engine, contextTokens = 32768, outputTokens = 4096, apiKey = null }) {
  const id = String(harness || '').trim();
  if (id !== 'opencode') {
    throw Object.assign(Error(`noevia cannot pin the permissions of the ${id || 'unnamed'} harness, so it will not run it.`), { status: 409 });
  }
  const name = String(model || '').trim();
  const baseURL = String(engine || '').trim();
  if (!name) throw Object.assign(Error('A coding task needs a model; none is loaded or chosen.'), { status: 409 });
  if (!/^https?:\/\//.test(baseURL)) throw Object.assign(Error('This server has no model endpoint for coding tasks.'), { status: 409 });
  return {
    name: 'opencode.json',
    json: {
      $schema: 'https://opencode.ai/config.json',
      // An agent that updates itself is an unreviewed supply-chain change in the one container
      // allowed to run arbitrary commands.
      autoupdate: false,
      // Nothing about a task leaves this box by way of the harness's own sharing feature.
      share: 'disabled',
      provider: {
        local: {
          npm: '@ai-sdk/openai-compatible',
          name: 'noevia engine',
          options: { baseURL, apiKey: apiKey || 'none' },
          models: { [name]: { name, tool_call: true, limit: { context: contextTokens, output: outputTokens } } },
        },
      },
      model: `local/${name}`,
      small_model: `local/${name}`,
      permission: { ...PERMISSION },
    },
  };
}

// ── Other harnesses (roadmap: "Other harnesses") ─────────────────────────────────────────
// Each is pinned through the files that harness itself treats as authoritative, written by noevia
// before the agent exists: into the task's working directory (`cwd`) or the private HOME noevia
// gives every task (`home`, code-workspace.cjs). Primary sources, checked 2026-09-22:
//   * Claude Code — code.claude.com/docs/en/{settings,permissions,env-vars,sandboxing}:
//     `ask` rules cover Edit (every built-in file edit), Write, NotebookEdit, Bash, WebFetch and
//     WebSearch; bypass and auto modes can be disabled; sandboxed Bash auto-approval must also
//     be disabled; `env` in settings is honoured, which is how the endpoint and model are given.
//   * Codex — refused; measured with the real adapter, see pinFilesFor below.
//   * Qwen Code — github.com/QwenLM/qwen-code docs/users/configuration/{settings,model-providers}.md:
//     project `.qwen/settings.json` outranks the user file; `tools.approvalMode` now DEFAULTS to
//     `auto` (an LLM classifier approves "safe" actions unasked), so `default` is pinned
//     explicitly; credentials come from `process.env[envKey]`, and the settings file's own `env`
//     section is honoured, which is how the endpoint key is given; `--acp` is the stable flag.
//   * pi — github.com/earendil-works/pi (coding-agent docs/extensions.md, docs/models.md):
//     no permission prompts by design; global extensions in `~/.pi/agent/extensions/` load
//     without a trust prompt and a `tool_call` handler returning `{ block: true }` stops a call.
//     noevia's gate asks for every tool that is not a plain read, with the full input, and
//     blocks whenever there is no channel to ask on — fail closed, never fail open.
//   * DeepSeek Harness — @deepseek-ai/dsh 0.1.7-alpha.2, read at source and run (qa/deepseek-e2e.cjs):
//     `dsh --profile acp` composes `$DSH_HOME/profiles/acp/cordis.patch.yml` (DSH_HOME defaults to
//     `~/.dsh`, the task's private HOME) over its shipped bundles. Measured 2026-09-23: shipped, its
//     approval seam is consulted only for sandbox escalations, so a plain `echo > file` ran unasked
//     (the Codex shape). Its tools pipeline, though, runs a `tools/pre-execute` waterfall whose
//     `ask` verdict goes through that fail-closed seam to ACP `session/request_permission`; noevia
//     inserts its own gate there. Also turned off: OTel upload (on by default toward DeepSeek), the
//     DeepSeek session log, web search, the direct DeepSeek route and account, the plugin manager
//     and settings/config editors, repository instruction files and filesystem skills.

const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']);
const PI_READ_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls']);

function endpointFor({ model, engine }) {
  const name = String(model || '').trim();
  const baseURL = String(engine || '').trim().replace(/\/+$/, '');
  if (!name) throw Object.assign(Error('A coding task needs a model; none is loaded or chosen.'), { status: 409 });
  if (!/^https?:\/\//.test(baseURL)) throw Object.assign(Error('This server has no model endpoint for coding tasks.'), { status: 409 });
  return { name, baseURL: /\/v1$/.test(baseURL) ? baseURL : `${baseURL}/v1` };
}

function claudeSecuritySettings() {
  return {
    permissions: {
      defaultMode: 'default', disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable',
      blockReadsOutsideWorkingDirectories: true,
      allow: [], deny: ['mcp__*'], ask: [...EDIT_TOOLS],
    },
    // Claude's own sandbox defaults to auto-approving a sandboxed Bash call, even in Manual
    // mode. The outer noevia container remains the security boundary, but D14 still requires
    // every command to reach noevia's approval card.
    sandbox: { autoAllowBashIfSandboxed: false },
    // A checked-out repository must not gain pre-approval execution through a hook or a hosted
    // connector. The ACP session also excludes project/local setting sources and filesystem MCPs.
    disableAllHooks: true,
    disableClaudeAiConnectors: true,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
  };
}

function claudeSettings({ name, baseURL, apiKey }) {
  return {
    ...claudeSecuritySettings(),
    env: {
      // Claude Code appends /v1/messages itself; llama.cpp serves the Anthropic Messages API there.
      ANTHROPIC_BASE_URL: baseURL.replace(/\/v1$/, ''),
      ANTHROPIC_API_KEY: apiKey || 'none',
      ANTHROPIC_MODEL: name,
      DISABLE_AUTOUPDATER: '1',
      DISABLE_UPDATES: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
    },
  };
}

const PI_GATE = `// Written by noevia for this task: every tool that is not a plain read asks, with its full
// input, and is blocked when nothing can ask. Unknown and future tools ask too.
const READ = new Set(${JSON.stringify(PI_READ_TOOLS)});
export default function (pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (READ.has(event.toolName)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: 'noevia has no approval channel for this call, so it is blocked.' };
    let ok = false;
    // The message is machine-readable on purpose: noevia's pi bridge (services/code-sandbox/
    // pi-acp-bridge.cjs) turns it into an ACP permission request with the real tool and input.
    const payload = JSON.stringify({ noevia: 'tool_call', toolCallId: event.toolCallId ?? null, toolName: event.toolName, input: event.input ?? {} });
    try { ok = await ctx.ui.confirm('Allow ' + event.toolName + '?', payload, { timeout: 300000 }); } catch { ok = false; }
    return ok === true ? undefined : { block: true, reason: 'Declined in noevia.' };
  });
}
`;

// Plain reads, plus the harness's own to-do/goal bookkeeping, which touches nothing outside it.
const DSH_NO_ASK_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep', 'todo_write', 'get_goal']);

const DSH_GATE = `// Written by noevia for this task: every DeepSeek Harness tool that is not a plain read asks
// through the harness's fail-closed approval seam (no answer, an error or anything but
// "allowed-once" refuses). Unknown and future tools ask too.
const NO_ASK = new Set(${JSON.stringify(DSH_NO_ASK_TOOLS)});
export const name = 'noevia-gate';
export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (NO_ASK.has(exec.name)) return next();
    return { kind: 'ask', reason: 'noevia asks before every tool that is not a plain read.' };
  }, { prepend: true });
}
`;

// Shipped entries that call DeepSeek's services, edit the harness's own configuration, or read
// what a checked-out repository supplies (instructions and skills are untrusted input here).
const DSH_DISABLED = Object.freeze(['session-telemetry-otel', 'session-log-deepseek', 'web-search-deepseek',
  'llm-deepseek', 'deepseek-account', 'plugin-manager', 'config-editor', 'settings',
  'agent-instructions', 'skill-filesystem', 'tool-skill', 'skill']);

/** The profile patch, as YAML. Every string goes through JSON, which YAML reads as a quoted scalar. */
function dshPatch({ name, baseURL, apiKey, contextTokens, outputTokens }) {
  const q = (v) => JSON.stringify(String(v));
  const lines = [
    '# Written by noevia for this task. Replaces nothing but the entries it names.',
    '- id: llm-pi-ai', '  config:', '    providers:', '      noevia:',
    '        displayName: "noevia engine"', '        api: openai-completions',
    `        baseURL: ${q(baseURL)}`,
    ...(apiKey ? ['        headers:', `          Authorization: ${q('Bearer ' + apiKey)}`] : []),
    '        models:', `          - id: ${q(name)}`, `            name: ${q(name)}`,
    `            contextWindow: ${Number(contextTokens) | 0}`, `            maxTokens: ${Number(outputTokens) | 0}`,
    '            reasoningEfforts: false',
    '- id: agent-default-model', '  config:', '    provider: noevia', `    model: ${q(name)}`,
    '- id: acp', '  config:', '    provider: noevia', `    model: ${q(name)}`,
    // Not read from the environment (the shipped default reads DSH_PERMISSION_MODE).
    '- id: approval', '  config:', '    policy: ask',
    '- id: sandbox-policy', '  config:', '    mode: workspace-write', '    workspaceRoot: !!js process.cwd()',
    ...DSH_DISABLED.flatMap((id) => [`- id: ${id}`, '  disabled: true']),
    '- insert:', '    - id: noevia-gate', '      name: ./noevia-gate.mjs',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Every file a harness needs pinned, relative to `cwd` or `home`. Unknown harnesses are refused.
 * @returns {{harness: string, files: {base: 'cwd'|'home', path: string, content: string}[], permission: object, model: string, endpoint: string}}
 */
function pinFilesFor({ harness, model, engine, contextTokens = 32768, outputTokens = 4096, apiKey = null, cwd = null }) {
  const id = String(harness || '').trim();
  const json = (value) => JSON.stringify(value, null, 2) + '\n';
  if (id === 'opencode') {
    const { name, json: config } = configFor({ harness: id, model, engine, contextTokens, outputTokens, apiKey });
    return { harness: id, files: [{ base: 'cwd', path: name, content: json(config) }], permission: { ...PERMISSION }, model: config.model, endpoint: config.provider.local.options.baseURL };
  }
  if (id === 'claude-code') {
    const e = endpointFor({ model, engine });
    const settings = json(claudeSettings({ ...e, apiKey }));
    return { harness: id, files: [
      { base: 'cwd', path: '.claude/settings.local.json', content: settings },
      { base: 'home', path: '.claude/settings.json', content: settings },
    ], permission: { ...PERMISSION }, model: e.name, endpoint: e.baseURL };
  }
  if (id === 'codex') {
    // Measured 2026-09-22 with real codex-acp 1.12.0 / Codex 0.155 and noevia's config.toml: the
    // adapter starts in its own "agent" mode (workspace writes, no asking) whatever config.toml
    // says, and even in its read-only mode a plain `echo > file` ran without an approval — only
    // commands the model itself escalates ever ask. Its gate is its OS sandbox, not a prompt, so
    // "every command asks" (D14) cannot be pinned. Refused until that changes (config tried: docs/spec-agent-execution.md).
    throw Object.assign(Error('noevia cannot pin the permissions of the codex harness (its commands run without asking inside its own sandbox), so it will not run it.'), { status: 409 });
  }
  if (id === 'qwen-code') {
    const e = endpointFor({ model, engine });
    const settings = json({
      tools: { approvalMode: 'default' },
      security: { auth: { selectedType: 'openai' } },
      model: { name: e.name, generationConfig: { contextWindowSize: contextTokens } },
      modelProviders: { openai: [{ id: e.name, name: e.name, baseUrl: e.baseURL, envKey: 'NOEVIA_ENGINE_KEY' }] },
      env: { NOEVIA_ENGINE_KEY: apiKey || 'none' },
      general: { enableAutoUpdate: false },
      privacy: { usageStatisticsEnabled: false },
    });
    return { harness: id, files: [
      { base: 'cwd', path: '.qwen/settings.json', content: settings },
      { base: 'home', path: '.qwen/settings.json', content: settings },
    ], permission: { ...PERMISSION }, model: e.name, endpoint: e.baseURL };
  }
  if (id === 'pi') {
    const e = endpointFor({ model, engine });
    const models = { providers: { noevia: { baseUrl: e.baseURL, api: 'openai-completions', apiKey: apiKey || 'none',
      models: [{ id: e.name, name: e.name, contextWindow: contextTokens, maxTokens: outputTokens, reasoning: false, input: ['text'] }] } } };
    const settings = { defaultProvider: 'noevia', defaultModel: e.name, defaultProjectTrust: 'never', enableInstallTelemetry: false };
    return { harness: id, files: [
      { base: 'home', path: '.pi/agent/models.json', content: json(models) },
      { base: 'home', path: '.pi/agent/settings.json', content: json(settings) },
      { base: 'home', path: '.pi/agent/extensions/noevia-gate.js', content: PI_GATE },
    ], permission: { ...PERMISSION }, model: e.name, endpoint: e.baseURL };
  }
  if (id === 'deepseek') {
    const e = endpointFor({ model, engine });
    return { harness: id, files: [
      { base: 'home', path: '.dsh/profiles/acp/cordis.patch.yml', content: dshPatch({ ...e, apiKey, contextTokens, outputTokens }) },
      { base: 'home', path: '.dsh/profiles/acp/noevia-gate.mjs', content: DSH_GATE },
    ], permission: { ...PERMISSION }, model: e.name, endpoint: e.baseURL };
  }
  throw Object.assign(Error(`noevia cannot pin the permissions of the ${id || 'unnamed'} harness, so it will not run it.`), { status: 409 });
}

/**
 * Write the pinned files into the task's working directory and private HOME, handed to the user
 * the harness runs as, the same way the worktree is handed over. Returns what the job event records.
 */
function writeHarnessConfig({ cwd, home = null, owner = null, ...options }) {
  const pinned = pinFilesFor({ ...options, cwd });
  const roots = { cwd, home };
  for (const file of pinned.files) {
    const root = roots[file.base];
    if (!root) throw Object.assign(Error(`The ${pinned.harness} harness needs a private home directory for its configuration.`), { status: 409 });
    writePinned(root, file.path, file.content, owner);
  }
  const first = pinned.files[0];
  return { file: first.path, files: pinned.files.map((f) => `${f.base === 'home' ? '~' : '.'}/${f.path}`),
    permission: pinned.permission, model: pinned.model, endpoint: pinned.endpoint };
}

// The repository is not noevia's: a checkout can carry a symlink named `.claude` or
// `opencode.json`, and noevia runs as root. Written through such a link, the engine key would
// land wherever the repository pointed and then be handed to the harness uid. So nothing on the
// way down may be a link, the target is replaced rather than written in place, and the final
// open refuses to follow one even if it appeared in between.
const refuse = (why) => Object.assign(Error(`Refused to pin the harness configuration: ${why}.`), { status: 409 });
function writePinned(root, relative, content, owner) {
  const base = nodePath.resolve(root);
  const target = nodePath.join(base, relative);
  if (!target.startsWith(base + nodePath.sep)) throw Error('Pinned file outside its root');
  const parts = nodePath.relative(base, target).split(nodePath.sep);
  let dir = base;
  for (const part of parts.slice(0, -1)) {
    dir = nodePath.join(dir, part);
    let st = null;
    try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && st.isSymbolicLink()) throw refuse(`${nodePath.relative(base, dir)} is a symbolic link`);
    if (st && !st.isDirectory()) throw refuse(`${nodePath.relative(base, dir)} is not a directory`);
    if (!st) { fs.mkdirSync(dir, { mode: 0o700 }); if (owner) fs.lchownSync(dir, owner.uid, owner.gid); }
  }
  let st = null;
  try { st = fs.lstatSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && st.isSymbolicLink()) throw refuse(`${relative} is a symbolic link`);
  if (st && st.isDirectory()) throw refuse(`${relative} is a directory`);
  if (st) fs.unlinkSync(target);
  const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_TRUNC | O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
  if (owner) fs.lchownSync(target, owner.uid, owner.gid);
}

/** The pinned files a harness writes into the working tree, which must never be committed. */
function cwdPinPaths(harness) {
  try {
    return pinFilesFor({ harness, model: 'm', engine: 'http://engine.invalid/v1' }).files
      .filter((f) => f.base === 'cwd').map((f) => f.path);
  } catch { return []; }
}

module.exports = { configFor, pinFilesFor, writeHarnessConfig, cwdPinPaths, claudeSecuritySettings,
  PERMISSION, EDIT_TOOLS, PI_READ_TOOLS, DSH_NO_ASK_TOOLS, DSH_DISABLED };
