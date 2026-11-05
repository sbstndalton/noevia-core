'use strict';
// Execute the unchanged service factory with synthetic stores and no engine or filesystem work.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ACTIONS = { READ: 'read_repository', EDIT: 'edit_file', EXECUTE: 'execute_command', INSTALL: 'install_dependency', NETWORK: 'network', DELETE: 'delete', GIT_PUSH: 'git_push' };
function capture(input) {
  const module = { exports: {} };
  const stubs = {
    './jobs.cjs': { createJobs: () => ({ recover() {}, get: () => null }) },
    './code-workspace.cjs': { createCodeWorkspaces: () => ({ recover() {} }) },
    './code-harness.cjs': { createCodeHarness: () => ({}) },
    './code-actions.cjs': { ACTIONS },
    './auditor-report.cjs': { pipelineView: () => null },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../code-service.cjs'), 'utf8'), {
    module, exports: module.exports, process: { env: input.env },
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : name.startsWith('node:') ? require(name) : (() => { throw Error(`Unexpected service dependency ${name}`); })(),
    Date, Buffer, setTimeout, clearTimeout,
  }, { timeout: 2000 });
  const egress = input.network === 'unconfigured' ? null : { available: () => input.network === 'ready' };
  const service = module.exports.createCodeService({ repos: input.repositories,
    connect: async () => { throw Error('The facts oracle must never start an agent'); }, egress,
    sandboxKind: input.sandboxed ? 'sandbox' : 'spawn', harnesses: module.exports.defaultHarnesses(input.env),
    pipeline: { enabled: () => input.pipeline, create: () => ({}) } });
  return service.facts({ dir: '/synthetic/account' });
}
function fixture() {
  const cases = [];
  for (const sandboxed of [false, true]) for (const pipeline of [false, true]) for (const network of ['unconfigured', 'unavailable', 'ready']) {
    const input = { sandboxed, pipeline, network, env: {}, repositories: [{ id: 'repo', path: '/synthetic/repository' }] };
    cases.push({ input, expected: capture(input) });
  }
  for (const env of [{ CODE_HARNESS_NAME: 'custom', CODE_HARNESS_VERSION: ' 2 ' }, { CODE_HARNESS_NAME: '   ', CODE_HARNESS_VERSION: '' }, { CODE_HARNESS_NAME: '__proto__' }, { CODE_HARNESS_NAME: 'constructor' }]) {
    const input = { sandboxed: true, pipeline: true, network: 'ready', env, repositories: [] };
    cases.push({ input, expected: capture(input) });
  }
  return { cases };
}
if (require.main === module) process.stdout.write(JSON.stringify(fixture(), null, 2) + '\n');
module.exports = { capture, fixture };
