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
//   * Claude Code — code.claude.com/docs/en/{settings,permissions,env-vars}: project-local
//     `.claude/settings.local.json` outranks user and shared-project settings (only managed
//     policy and CLI flags sit above it); `ask` rules cover Edit (every built-in file edit),
//     Write, NotebookEdit, Bash, WebFetch and WebSearch; bypass and auto modes can be disabled;
//     `env` in settings is honoured, which is how the endpoint and model are given.
//   * Codex — refused; measured with the real adapter, see pinFilesFor below.
//   * pi — github.com/badlogic/pi-mono (coding-agent README, docs/extensions.md, docs/models.md):
//     no permission prompts by design; global extensions in `~/.pi/agent/extensions/` load
//     without a trust prompt and a `tool_call` handler returning `{ block: true }` stops a call.
//     noevia's gate asks for every tool that is not a plain read, with the full input, and
//     blocks whenever there is no channel to ask on — fail closed, never fail open.

const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']);
const PI_READ_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls']);

function endpointFor({ model, engine }) {
  const name = String(model || '').trim();
  const baseURL = String(engine || '').trim().replace(/\/+$/, '');
  if (!name) throw Object.assign(Error('A coding task needs a model; none is loaded or chosen.'), { status: 409 });
  if (!/^https?:\/\//.test(baseURL)) throw Object.assign(Error('This server has no model endpoint for coding tasks.'), { status: 409 });
  return { name, baseURL: /\/v1$/.test(baseURL) ? baseURL : `${baseURL}/v1` };
}

function claudeSettings({ name, baseURL, apiKey }) {
  return {
    permissions: {
      defaultMode: 'default', disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable',
      allow: [], deny: [], ask: [...EDIT_TOOLS],
    },
    env: {
      // Claude Code appends /v1/messages itself; llama.cpp serves the Anthropic Messages API there.
      ANTHROPIC_BASE_URL: baseURL.replace(/\/v1$/, ''),
      ANTHROPIC_API_KEY: apiKey || 'none',
      ANTHROPIC_MODEL: name,
      DISABLE_AUTOUPDATER: '1',
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
    try { ok = await ctx.ui.confirm('Allow ' + event.toolName + '?', payload); } catch { ok = false; }
    return ok === true ? undefined : { block: true, reason: 'Declined in noevia.' };
  });
}
`;

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
  if (id === 'pi') {
    const e = endpointFor({ model, engine });
    const models = { providers: { noevia: { baseUrl: e.baseURL, api: 'openai-completions', apiKey: apiKey || 'none',
      models: [{ id: e.name, name: e.name, contextWindow: contextTokens, maxTokens: outputTokens, reasoning: false, input: ['text'] }] } } };
    const settings = { defaultProvider: 'noevia', defaultModel: e.name, enableInstallTelemetry: false };
    return { harness: id, files: [
      { base: 'home', path: '.pi/agent/models.json', content: json(models) },
      { base: 'home', path: '.pi/agent/settings.json', content: json(settings) },
      { base: 'home', path: '.pi/agent/extensions/noevia-gate.js', content: PI_GATE },
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
    const target = nodePath.join(root, file.path);
    if (!target.startsWith(nodePath.resolve(root) + nodePath.sep)) throw Error('Pinned file outside its root');
    const created = [];
    for (let dir = nodePath.dirname(target); dir !== root && !fs.existsSync(dir); dir = nodePath.dirname(dir)) created.unshift(dir);
    for (const dir of created) { fs.mkdirSync(dir, { mode: 0o700 }); if (owner) fs.chownSync(dir, owner.uid, owner.gid); }
    fs.writeFileSync(target, file.content, { mode: 0o600 });
    if (owner) fs.chownSync(target, owner.uid, owner.gid);
  }
  const first = pinned.files[0];
  return { file: first.path, files: pinned.files.map((f) => `${f.base === 'home' ? '~' : '.'}/${f.path}`),
    permission: pinned.permission, model: pinned.model, endpoint: pinned.endpoint };
}

module.exports = { configFor, pinFilesFor, writeHarnessConfig, PERMISSION, EDIT_TOOLS, PI_READ_TOOLS };
