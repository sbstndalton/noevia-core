'use strict';
// #1517 owner decisions: a turn keeps its last 10 variants (older ones drop off, the chosen one is
// never dropped), and exports carry only the chosen reply (the zip export is the Rust front's since #1071). Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_VARIANTS, capVariants, capEntry } = require('./chat-variants.cjs');
const { sanitizeHistory } = require('./chat-sources.cjs');
const { chatMarkdown } = require('./chat-export.cjs');

const answers = (n) => Array.from({ length: n }, (_, i) => ({ content: `answer ${i}` }));
const texts = (list) => list.map((v) => v.content);

test('the limit is 10 variants per message', () => assert.equal(MAX_VARIANTS, 10));

test('an 11th variant drops the oldest and keeps the chosen one pointing at the same answer', () => {
  const [turn] = sanitizeHistory([{ role: 'user', content: 'q', answers: answers(11), answer: 10 }]);
  assert.equal(turn.answers.length, 10);
  assert.deepEqual(texts(turn.answers), Array.from({ length: 10 }, (_, i) => `answer ${i + 1}`));
  assert.equal(turn.answers[turn.answer].content, 'answer 10');
});

test('ten or fewer variants are left as they are, the same object', () => {
  const entry = { role: 'user', content: 'q', answers: answers(10), answer: 3 };
  assert.equal(sanitizeHistory([entry])[0], entry);
});

test('the chosen variant survives even when it is the oldest', () => {
  const [turn] = sanitizeHistory([{ role: 'user', content: 'q', answers: answers(11), answer: 0 }]);
  assert.equal(turn.answers.length, 10);
  assert.equal(turn.answers[turn.answer].content, 'answer 0');
  assert.equal(turn.answer, 0);
  // The oldest of the others went instead: answer 1 is the one that dropped.
  assert.deepEqual(texts(turn.answers), ['answer 0', ...Array.from({ length: 9 }, (_, i) => `answer ${i + 2}`)]);
});

test('a chosen variant in the middle survives a longer list, and the index follows it', () => {
  const { list, chosen } = capVariants(answers(14), 2);
  assert.equal(list.length, 10);
  assert.equal(list[chosen].content, 'answer 2');
  assert.deepEqual(texts(list), ['answer 2', ...Array.from({ length: 9 }, (_, i) => `answer ${i + 5}`)].sort((a, b) => Number(a.slice(7)) - Number(b.slice(7))));
});

test('the slot reserved for a reply still being made counts toward the limit', () => {
  // Regenerate saves the answers so far with `answer` pointing at the next slot.
  const { list, chosen } = capVariants(answers(10), 10);
  assert.equal(list.length, 9, 'nine stored answers plus the one being made is ten');
  assert.equal(chosen, 9);
  assert.equal(list[0].content, 'answer 1');
});

test('Edit & re-run versions are capped the same way, with their own answers and the chat after them', () => {
  const versions = Array.from({ length: 12 }, (_, i) => ({ content: `version ${i}`, answers: answers(11), answer: 0, tail: [{ role: 'user', content: 't', answers: answers(12), answer: 11 }] }));
  const [turn] = sanitizeHistory([{ role: 'user', content: 'version 3', branches: versions, branch: 3 }]);
  assert.equal(turn.branches.length, 10);
  assert.equal(turn.branches[turn.branch].content, 'version 3');
  assert.equal(turn.branches[0].content, 'version 2', 'the two oldest of the others dropped');
  for (const v of turn.branches) {
    assert.equal(v.answers.length, 10);
    assert.equal(v.answers[v.answer].content, 'answer 0');
    assert.equal(v.tail[0].answers.length, 10);
    assert.equal(v.tail[0].answers[v.tail[0].answer].content, 'answer 11');
  }
});

test('a chosen version that is the oldest survives', () => {
  const versions = Array.from({ length: 11 }, (_, i) => ({ content: `version ${i}`, tail: [] }));
  const next = capEntry({ role: 'user', content: 'version 0', branches: versions, branch: 0 });
  assert.equal(next.branches.length, 10);
  assert.equal(next.branches[next.branch].content, 'version 0');
});

test('malformed variant fields are left alone, never thrown on', () => {
  for (const entry of [{ role: 'user', answers: 'x' }, { role: 'user', branches: [null, 3], branch: 'a' }, { role: 'user', answers: null }, null, 7]) assert.doesNotThrow(() => sanitizeHistory([entry]));
});

// --- exports -----------------------------------------------------------------------------------

const variantHistory = () => [
  { role: 'user', content: 'chosen question', answers: [{ content: 'ALTERNATIVE-ANSWER-A' }, { content: 'chosen reply' }, { content: 'ALTERNATIVE-ANSWER-B' }], answer: 1,
    branches: [{ content: 'ALTERNATIVE-EDIT', tail: [{ role: 'assistant', content: 'ALTERNATIVE-TAIL' }] }, { content: 'chosen question', tail: [] }], branch: 1 },
  { role: 'assistant', content: 'chosen reply', reasoning: 'scratch' },
];

test('the single-chat Markdown export is the chosen reply only', () => {
  const md = chatMarkdown({ title: 'Variants' }, variantHistory());
  assert.doesNotMatch(md, /ALTERNATIVE/);
  assert.match(md, /chosen question/);
  assert.match(md, /chosen reply/);
});
