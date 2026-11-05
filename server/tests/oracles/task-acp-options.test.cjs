'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { agentEnv, sessionMetadata } = require('../../code-acp.cjs');
test('ACP launch options retain only explicit environment and pinned session settings', () => {
  const cases = [];
  for (const env of [{}, { HOME: '/override', CURL_HOME: '/hostile', WGETRC: '/hostile', CUSTOM: 'synthetic' }]) {
    for (const proxy of [null, { url: 'http://synthetic.invalid:3128' }, { url: 'http://synthetic.invalid:3128', noProxy: 'localhost' }]) {
      const input = { cwd: '/repo', home: '/private', env, proxy };
      const output = agentEnv(input);
      assert.equal(output.HOME, env.HOME || '/private');
      assert.equal(output.CURL_HOME, '/nonexistent');assert.equal(output.WGETRC, '/dev/null');
      delete output.PATH;delete output.LANG;
      cases.push({ input, output });
    }
  }
  const sessions = [];
  for (const permission of [null, { mode: 'approve', capabilities: ['read'] }]) {
    for (const harness of [null, 'opencode', 'claude-code']) {
      const input = { permission, harness, settings: { permissions: { defaultMode: 'default' } } };
      sessions.push({ input, output: sessionMetadata(input) });
    }
  }
  assert.throws(() => sessionMetadata({ harness: 'claude-code' }), { status: 409 });
  if (process.env.TASK_ACP_OPTIONS_EVIDENCE) fs.writeFileSync(path.join(process.env.TASK_ACP_OPTIONS_EVIDENCE, 'task-acp-options-node.json'), JSON.stringify({ cases, sessions }, null, 2) + '\n');
});
