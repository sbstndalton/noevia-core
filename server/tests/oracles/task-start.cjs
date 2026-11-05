'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
async function capture(input) {
  const module = { exports: {} };
  let execution = null;
  const start = async task => { execution = task; return { taskId: 'synthetic-task', branch: 'synthetic-branch', workspace: '/synthetic/tree' }; };
  const stubs = {
    './jobs.cjs': { createJobs: () => ({ recover() {}, list: () => input.active ? [{ id: 'active' }] : [] }) },
    './code-workspace.cjs': { createCodeWorkspaces: () => ({ recover() {} }) },
    './code-harness.cjs': { createCodeHarness: () => ({ start }) },
    './code-actions.cjs': { ACTIONS: { READ: 'read_repository', EDIT: 'edit_file', EXECUTE: 'execute_command', INSTALL: 'install_dependency', NETWORK: 'network', DELETE: 'delete', GIT_PUSH: 'git_push' } },
    './auditor-report.cjs': { pipelineView: () => null },
    './shared-context.cjs': { read: () => ({ code: true }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../code-service.cjs'), 'utf8'), {
    module, exports: module.exports, process: { env: {} },
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : name.startsWith('node:') ? require(name) : (() => { throw Error(`Unexpected dependency ${name}`); })(),
    Date, Buffer, setTimeout, clearTimeout,
  }, { timeout: 2000 });
  const service = module.exports.createCodeService({ repos: [{ id: 'repo', path: '/synthetic/repo' }], connect() {},
    egress: input.network === 'unconfigured' ? null : { available: () => input.network === 'ready' },
    sandboxKind: 'sandbox', pipeline: { enabled: () => input.pipeline, create: () => ({ start }) },
    inference: { paused: () => input.paused === true },
  });
  try {
    const result = await service.start({ dir: '/synthetic/account', userId: 'synthetic-user' }, { id: 'project' }, input.body);
    return JSON.parse(JSON.stringify({ status: 202, result, execution }));
  } catch (error) { return { status: error.status || 500, error: error.publicMessage || 'Internal server error' }; }
}
async function fixture() {
  const cases = [];
  const bodies = [
    {}, { repository: 'repo' }, { repository: 'repo', prompt: '  task  ' },
    { repository: 'repo', prompt: 'task', harness: 'other' },
    { repository: 'repo', prompt: 'task', promptPreparation: 'other' },
    { repository: 'repo', prompt: 'task', promptPreparation: 'local' },
    { repository: 'repo', prompt: 'task', promptPreparation: 'planner', approvePlan: true },
    { repository: 'repo', prompt: 'task', capabilities: ['network', 'install_dependency', 'edit_file', 'edit_file', 'other'], domains: [' Example.COM ', 'bad', '.com', 'a..com', 'a.x', 'a.co', 42, null] },
    { repository: 'repo', prompt: ['task', 'data'], capabilities: [], model: 42 },
    { repository: 'repo', prompt: { toString: 42 } },
  ];
  for (const network of ['unconfigured', 'ready']) for (const pipeline of [false, true]) for (const body of bodies) {
    const input = { network, pipeline, body }; cases.push({ input, expected: await capture(input) });
  }
  return { cases };
}
module.exports = { capture, fixture };
if (require.main === module) fixture().then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n'));
