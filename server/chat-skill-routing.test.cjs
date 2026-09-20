'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatSkillRouter, skillBlock } = require('./chat-skill-routing.cjs');

const skill = (name, description, body = 'Do the thing.') => ({ file: `${name}/SKILL.md`, name, description, valid: true, content: `---\nname: ${name}\ndescription: ${description}\n---\n${body}` });
const vec = (t) => (/pdf/i.test(t) ? [1, 0, 0] : /spreadsheet|excel/i.test(t) ? [0, 1, 0] : [0, 0, 1]);
const router = (over = {}) => createChatSkillRouter({ enabled: () => true, embed: async (texts) => texts.map(vec), ...over });

test('loads the one skill whose description matches the message', async () => {
  const r = await router().select([skill('pdf', 'Fill and read PDF forms'), skill('xlsx', 'Clean up Excel spreadsheets')], 'Please fill in this PDF');
  assert.deepEqual(r.loaded.map((s) => s.name), ['pdf']);
});

test('loads nothing when no skill matches, when off, or when embeddings fail', async () => {
  const skills = [skill('pdf', 'Fill and read PDF forms')];
  assert.deepEqual((await router().select(skills, 'What is the weather?')).loaded, []);
  assert.deepEqual((await router({ enabled: () => false }).select(skills, 'a pdf')).loaded, []);
  const failing = await router({ embed: async () => { throw new Error('down'); } }).select(skills, 'a pdf');
  assert.deepEqual(failing.loaded, []);
  assert.match(failing.reason, /embeddings unavailable/);
});

test('a near tie is left to the model', async () => {
  const r = await router({ embed: async (texts) => texts.map(() => [1, 1, 0]) }).select([skill('a', 'one'), skill('b', 'two')], 'x');
  assert.deepEqual(r.loaded, []);
  assert.equal(r.reason, 'ambiguous match');
});

test('the prompt block drops frontmatter and bounds a long body', () => {
  const block = skillBlock([skill('pdf', 'PDF', 'x'.repeat(20000))]);
  assert.ok(!block.includes('description:'));
  assert.match(block, /Truncated; read pdf\/SKILL.md/);
  assert.ok(block.length < 12500);
});
