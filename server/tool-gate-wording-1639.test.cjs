'use strict';
// #1639: the tool gate's question was tuned for Kev-0.8B; its options must stay exactly what they were,
// because TOOL_GATE_IMPL=wasm (live) compares them with the Rust port, which budgets the question as
// 79 characters (noevia-rs crates/tool-gate QUESTION.len()). A mismatch would turn every Stage 2 answer
// into "none" (impl-mismatch). tests/fixtures/tool-gate.v1.json (byte-identical with the port's copy)
// covers the shaping broadly; this pins the request itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const tg = require('./tool-gate.cjs');
const { SERVICE_LIMITS } = require('./decision-settings.cjs');

const QUESTION = 'Without tools the assistant knows no current news and nothing the user wrote or saved. Which tool does it need, if any?';
const tool = (name, description) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } });
const TOOLS = [
  tool('tavily_search', 'Search the web for current facts and news.'),
  tool('tavily_extract', 'Read the text of a web page from its URL.'),
  tool('diary_read_month', "Read the user's own diary entries for a month."),
  tool('nc_webdav_search_files', "Find the user's own stored files and documents."),
];
const offered = new Map(TOOLS.map((t) => [t.function.name, t]));
const readOnly = () => true;

test('the question is the tuned one; the budget still counts 79 characters, as the Rust port does', () => {
  assert.equal(tg.QUESTION, QUESTION);
  assert.equal(tg.BUDGET_QUESTION_CHARS, 79);
  assert.equal('Which tool, if any, must the assistant call before answering this user message?'.length, tg.BUDGET_QUESTION_CHARS,
    'the pre-#1639 question, whose length the port budgets');
  assert.doesNotMatch(QUESTION, /\bmust\b/, '"must" made Kev-0.8B answer none (#1639)');
});

test('with the service limits the options are the pre-#1639 ones: labels cut to 44, none last', () => {
  const { question, shape } = tg.readoutOptions(offered, { boxes: tg.DEFAULT_BOXES, readOnly, bias: null, limits: SERVICE_LIMITS });
  assert.equal(question, QUESTION);
  assert.deepEqual(shape(), { trimmed: 0, options: [
    { id: 'tavily_extract', label: 'Read the text of a web page from its URL.' },
    { id: 'tavily_search', label: 'Search the web for current facts and news.' },
    { id: 'diary_read_month', label: "Read the user's own diary entries for a mont" },
    { id: 'nc_webdav_search_files', label: "Find the user's own stored files and documen" },
    { id: 'none', label: 'No tool: answer directly' },
  ] });
  assert.deepEqual(shape(), tg.shapeOptions([...offered.values()], SERVICE_LIMITS, tg.DEFAULT_BOXES, 79));
});

test('a frame hint is appended to the question and counted as the port counts it (79 + 1 + at most 160)', () => {
  for (const hint of ['The user framed this chat as a lookup.', 'h'.repeat(300)]) {
    const bias = { prefer: ['search'], hint };
    const { question, shape } = tg.readoutOptions(offered, { boxes: tg.DEFAULT_BOXES, readOnly, bias, limits: SERVICE_LIMITS });
    assert.equal(question, `${QUESTION} ${hint.slice(0, 160)}`);
    const budget = 79 + 1 + Math.min(hint.length, 160);
    const ordered = [...offered.values()];
    assert.deepEqual(shape(), tg.shapeOptions(ordered.sort((a, b) => (a.function.name === 'tavily_search' ? -1 : b.function.name === 'tavily_search' ? 1 : 0)), SERVICE_LIMITS, tg.DEFAULT_BOXES, budget, ['tavily_search', 'web_search', 'wikipedia_search']));
  }
});

test('the request sent to the decision layer carries the tuned question and fits the service limits', async () => {
  const asked = [];
  const gate = tg.createToolGate({ enabled: () => true, isWriteTool: () => false, limits: () => SERVICE_LIMITS, env: {},
    decide: async (req) => { asked.push(req); return { selected: 'none', scores: { none: 1 }, source: 'configured' }; } });
  await gate.evaluate('Synthetic: who won the match last night?', TOOLS);
  assert.equal(asked.length, 1);
  const req = asked[0];
  assert.equal(req.purpose, 'tool.gate');
  assert.equal(req.question, QUESTION);
  assert.ok(req.question.length <= SERVICE_LIMITS.maxQuestionChars);
  assert.ok(req.options.every((o) => o.label.length <= SERVICE_LIMITS.maxLabelChars));
  assert.deepEqual(req.options.map((o) => o.id), ['tavily_extract', 'tavily_search', 'diary_read_month', 'nc_webdav_search_files', 'none']);
});
