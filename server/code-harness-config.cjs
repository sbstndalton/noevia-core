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

/**
 * Write the file into the task's own working directory and hand it to the user the harness runs
 * as, the same way the worktree is handed over. Returns what the job event records.
 */
function writeHarnessConfig({ cwd, owner = null, ...options }) {
  const { name, json } = configFor(options);
  const file = nodePath.join(cwd, name);
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  if (owner) fs.chownSync(file, owner.uid, owner.gid);
  return { file: name, permission: { ...PERMISSION }, model: json.model, endpoint: json.provider.local.options.baseURL };
}

module.exports = { configFor, writeHarnessConfig, PERMISSION };
