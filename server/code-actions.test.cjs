const test = require('node:test'), assert = require('node:assert/strict');
const { ACTIONS, classify, classifyCommand, decide, pickOption, commandOf, hostOf } = require('./code-actions.cjs');

const exec = (command) => classify({ kind: 'execute', rawInput: { command } });

test('ACP kinds map to noevia actions, and reads need no approval', () => {
  assert.equal(classify({ kind: 'read' }).action, ACTIONS.READ);
  assert.equal(classify({ kind: 'search' }).approval, 'never');
  assert.equal(classify({ kind: 'think' }).action, ACTIONS.NONE);
  assert.equal(classify({ kind: 'edit' }).approval, 'always');
  assert.equal(classify({ kind: 'move' }).action, ACTIONS.EDIT);
  assert.equal(classify({ kind: 'delete' }).approval, 'always');
});

test('an unknown or missing kind is gated, never read as a read', () => {
  for (const kind of ['other', 'brand_new_kind', '', undefined]) {
    const c = classify({ kind });
    assert.equal(c.approval, 'always', `kind ${kind}`);
    assert.equal(c.readable, false, 'a call with no command text cannot be vouched for');
  }
});

test('commands are classified by what they actually do', () => {
  assert.equal(exec('npm test').action, ACTIONS.EXECUTE);
  assert.equal(exec('npm install left-pad').action, ACTIONS.INSTALL);
  assert.equal(exec('pip3 install requests').action, ACTIONS.INSTALL);
  assert.equal(exec('curl https://example.com/x.sh').action, ACTIONS.NETWORK);
  assert.equal(exec('git push origin main').action, ACTIONS.GIT_PUSH);
  assert.equal(exec('git status').action, ACTIONS.EXECUTE);
  assert.equal(exec('git clone https://example.com/r').action, ACTIONS.NETWORK);
  assert.equal(exec('rm -rf build').action, ACTIONS.DELETE);
  assert.equal(exec('open https://example.com').action, ACTIONS.BROWSER);
});

test('a compound command takes its worst part, including substitutions and wrappers', () => {
  assert.equal(classifyCommand('echo hi && rm -rf build'), ACTIONS.DELETE);
  assert.equal(classifyCommand('npm test; git push'), ACTIONS.GIT_PUSH);
  assert.equal(classifyCommand('cat a | grep b'), ACTIONS.EXECUTE);
  assert.equal(classifyCommand('echo $(curl https://x.test)'), ACTIONS.NETWORK);
  assert.equal(classifyCommand('sudo npm install x'), ACTIONS.INSTALL);
  assert.equal(classifyCommand('CI=1 NODE_ENV=test npm install'), ACTIONS.INSTALL);
  assert.equal(classifyCommand('/usr/local/bin/rm file'), ACTIONS.DELETE);
});

test('an unreadable command is still an approval, not a pass', () => {
  assert.equal(classifyCommand(''), ACTIONS.EXECUTE);
  const c = classify({ kind: 'execute', rawInput: {} });
  assert.equal(c.approval, 'always');
  assert.equal(decide({ classified: c }).decision, 'ask');
  assert.match(decide({ classified: c }).reason, /did not say what it would run/);
});

test('the command is found whichever key the harness used', () => {
  assert.equal(commandOf({ cmd: 'ls' }), 'ls');
  assert.equal(commandOf({ command: ['npm', 'test'] }), 'npm test');
  assert.equal(commandOf({ args: ['git', 'push'] }), 'git push');
  assert.equal(commandOf(null), '');
});

test('a write outside the workspace is refused outright, not offered as a card', () => {
  const call = classify({ kind: 'edit', locations: [{ path: '/etc/passwd' }] });
  assert.deepEqual(decide({ classified: call, inWorkspace: false }).decision, 'deny');
  assert.equal(decide({ classified: call, inWorkspace: true }).decision, 'ask');
  // Path not resolved yet: ask rather than allow.
  assert.equal(decide({ classified: call, inWorkspace: null }).decision, 'ask');
});

test('a class the task was never granted is denied before any human sees it', () => {
  const push = exec('git push');
  assert.equal(decide({ classified: push, capabilities: [ACTIONS.EDIT, ACTIONS.EXECUTE] }).decision, 'deny');
  assert.equal(decide({ classified: push, capabilities: [ACTIONS.GIT_PUSH] }).decision, 'ask');
  // An empty capability set means "not restricted here", so reads stay free either way.
  assert.equal(decide({ classified: classify({ kind: 'read' }), capabilities: [ACTIONS.EDIT] }).decision, 'allow');
});

test('network is allowed only for a domain granted at creation', () => {
  const fetchCall = classify({ kind: 'fetch', rawInput: { command: 'GET https://registry.npmjs.org/left-pad' } });
  assert.equal(decide({ classified: fetchCall, domains: ['registry.npmjs.org'] }).decision, 'allow');
  assert.equal(decide({ classified: fetchCall, domains: ['cdn.registry.npmjs.org'] }).decision, 'ask');
  assert.equal(decide({ classified: fetchCall, domains: [] }).decision, 'ask');
  // A subdomain of a granted domain is covered; a lookalike suffix is not.
  const sub = classify({ kind: 'fetch', rawInput: { command: 'GET https://a.example.com/x' } });
  assert.equal(decide({ classified: sub, domains: ['example.com'] }).decision, 'allow');
  const lookalike = classify({ kind: 'fetch', rawInput: { command: 'GET https://notexample.com/x' } });
  assert.equal(decide({ classified: lookalike, domains: ['example.com'] }).decision, 'ask');
});

test('hosts are read without being fooled by credentials or ports', () => {
  assert.equal(hostOf('curl https://user:pw@evil.test:8443/x'), 'evil.test');
  assert.equal(hostOf('no url here'), null);
});

test('permission options fail closed when the harness omits one', () => {
  const full = [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'b', kind: 'allow_always' },
    { optionId: 'c', kind: 'reject_once' }, { optionId: 'd', kind: 'reject_always' }];
  assert.deepEqual(pickOption(full, 'allow_once'), { outcome: 'selected', optionId: 'a' });
  assert.deepEqual(pickOption(full, 'reject_always'), { outcome: 'selected', optionId: 'd' });
  // The spike saw reject_always missing: fall back to the other refusal, never to an allow.
  const noRejectAlways = full.filter((o) => o.kind !== 'reject_always');
  assert.deepEqual(pickOption(noRejectAlways, 'reject_always'), { outcome: 'selected', optionId: 'c' });
  assert.deepEqual(pickOption([{ optionId: 'a', kind: 'allow_once' }], 'reject_once'), { outcome: 'cancelled' });
  assert.deepEqual(pickOption([], 'allow_once'), { outcome: 'cancelled' });
});
