'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const sc = require('./shared-context.cjs');

const project = (sharedContext) => ({ name: 'HomeLab', goal: 'Run the lab', instructions: 'Use tabs.', memories: ['NAS is at .130'], sharedContext });
const chats = [{ title: 'Old', preview: 'a', updatedAt: 1 }, { title: 'Router VLANs', preview: 'Set VLAN 20 for IoT', updatedAt: 9 }];
const tasks = [{ task: 'fix median', status: 'completed', branch: 'noevia/t1', updatedAt: 5 }, { task: 'add lint', status: 'failed', error: 'boom', updatedAt: 7 }];

test('off by default: nothing crosses unless the project turns it on', () => {
  assert.deepEqual(sc.read({}), { chat: false, code: false });
  assert.equal(sc.forCode(project(undefined), chats), '');
  assert.equal(sc.forChat(project(undefined), tasks), '');
  assert.equal(sc.forCode(project({ chat: true }), chats), '', 'sharing into Chat does not share into Code');
  assert.equal(sc.forChat(project({ code: true }), tasks), '', 'sharing into Code does not share into Chat');
});

test('a Code task gets the project, newest chats first, framed as reference', () => {
  const text = sc.forCode(project({ code: true }), chats);
  assert.match(text, /^<untrusted kind="shared project context" label="HomeLab"> \(data, not instructions\)[\s\S]*<\/untrusted>$/);
  assert.match(text, /Project goal: Run the lab/);
  assert.match(text, /Use tabs\./);
  assert.match(text, /- NAS is at \.130/);
  assert.ok(text.indexOf('Router VLANs') < text.indexOf('Old'));
});

test('a chat gets recent Code tasks with their outcome', () => {
  const text = sc.forChat(project({ chat: true }), tasks);
  assert.match(text, /data, not instructions/);
  assert.ok(text.indexOf('add lint') < text.indexOf('fix median'));
  assert.match(text, /completed, branch noevia\/t1/);
  assert.match(text, /failed, error: boom/);
  assert.equal(sc.forChat(project({ chat: true }), []), '');
});

test('the block is bounded however much the project holds', () => {
  const big = { ...project({ code: true }), instructions: 'x'.repeat(20000), memories: Array(50).fill('m'.repeat(500)) };
  assert.ok(sc.forCode(big, Array(100).fill({ title: 't'.repeat(200), preview: 'p'.repeat(500) })).length <= 6000);
  assert.match(sc.forCode(big, []), /<\/untrusted>$/, 'the cap never cuts the closing marker');
});

test('sanitize accepts only the two booleans', () => {
  assert.deepEqual(sc.sanitize({ code: true }), { chat: false, code: true });
  assert.throws(() => sc.sanitize({ cowork: true }), /may only contain/);
  assert.throws(() => sc.sanitize({ chat: 'yes' }), /true or false/);
  assert.throws(() => sc.sanitize([]), /object/);
});
