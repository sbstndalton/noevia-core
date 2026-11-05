'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('code service refuses a second project task before invoking any executor', async () => {
  const module = { exports: {} };
  let starts = 0;
  const stubs = {
    './jobs.cjs': { createJobs: () => ({ recover() {}, list: () => [{ id: 'active-task', status: 'running' }] }) },
    './code-workspace.cjs': { createCodeWorkspaces: () => ({ recover() {} }) },
    './code-harness.cjs': { createCodeHarness: () => ({ start() { starts++; throw Error('must not start'); } }) },
    './code-actions.cjs': { ACTIONS: { READ: 'read_repository', EDIT: 'edit_file', EXECUTE: 'execute_command', INSTALL: 'install_dependency', NETWORK: 'network', DELETE: 'delete', GIT_PUSH: 'git_push' } },
    './auditor-report.cjs': { pipelineView: () => null },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../code-service.cjs'), 'utf8'), {
    module, exports: module.exports, process: { env: {} },
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : name.startsWith('node:') ? require(name) : (() => { throw Error(`Unexpected dependency ${name}`); })(),
    Date, Buffer, setTimeout, clearTimeout,
  }, { timeout: 2000 });
  const service = module.exports.createCodeService({ repos: [{ id: 'repo', path: '/synthetic/repo' }], connect() {} });
  await assert.rejects(service.start({ dir: '/synthetic/account' }, { id: 'project' }, { repository: 'repo', prompt: 'synthetic task' }), {
    status: 409, publicMessage: 'This project already has a task running.',
  });
  assert.equal(starts, 0);
});
