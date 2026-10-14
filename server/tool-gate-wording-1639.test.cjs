'use strict';
// #1639: the tool gate's question was tuned for Kev-0.8B. TOOL_GATE_IMPL=wasm (live) compares the shaped
// options with the Rust port, which counts the question as 79 characters (noevia-rs crates/tool-gate
// QUESTION.len()); a mismatch would turn every Stage 2 answer into "none" (impl-mismatch). The gate gives
// both sides the same choice budget, lowered by the longer question's excess, so they still agree and the
// request stays within the service's maxChoiceChars. tests/fixtures/tool-gate.v1.json (byte-identical with
// the port's copy) covers the shaping broadly; this pins the request itself.
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

test('budgetLimits lowers the choice budget by the question\'s excess over 79, and only that', () => {
  assert.deepEqual(tg.budgetLimits(SERVICE_LIMITS), { ...SERVICE_LIMITS, maxChoiceChars: SERVICE_LIMITS.maxChoiceChars - (QUESTION.length - 79) });
  assert.equal(QUESTION.length - 79, 40);
  assert.equal(tg.budgetLimits(null), null);
  const noBudget = { maxOptions: 8, maxLabelChars: 120 };
  assert.equal(tg.budgetLimits(noBudget), noBudget, 'no finite choice budget: unchanged');
  assert.equal(SERVICE_LIMITS.maxChoiceChars, 360, 'the service limit itself is unchanged');
});

test('the gate shapes with the lowered budget: labels cut to 34 here, none last, as the port shapes them', () => {
  const lim = tg.budgetLimits(SERVICE_LIMITS);
  const { question, shape } = tg.readoutOptions(offered, { boxes: tg.DEFAULT_BOXES, readOnly, bias: null, limits: lim });
  assert.equal(question, QUESTION);
  const shaped = shape();
  assert.deepEqual(shaped, { trimmed: 0, options: [
    { id: 'tavily_extract', label: 'Read the text of a web page from i' },
    { id: 'tavily_search', label: 'Search the web for current facts a' },
    { id: 'diary_read_month', label: "Read the user's own diary entries " },
    { id: 'nc_webdav_search_files', label: "Find the user's own stored files a" },
    { id: 'none', label: 'No tool: answer directly' },
  ] });
  // The port gets limitsProjection(lim) and counts 79 characters: the same call as shapeOptions(..., 79).
  assert.deepEqual(shaped, tg.shapeOptions([...offered.values()], lim, tg.DEFAULT_BOXES, 79));
  assert.ok(QUESTION.length + shaped.options.reduce((n, o) => n + o.id.length + o.label.length + 2, 0) <= SERVICE_LIMITS.maxChoiceChars);
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

test('question plus options stay within the service choice budget, also with 12 long tools and a long hint', async () => {
  const long = (name) => tool(name, `${name} reads synthetic data. `.repeat(12));
  const many = [...Array.from({ length: 10 }, (_, i) => long(`synthetic_reader_${i}`)), long('Web-Fetch'), long('tavily_search')];
  for (const bias of [undefined, { prefer: ['search'], hint: 'h'.repeat(300) }]) {
    const asked = [];
    const gate = tg.createToolGate({ enabled: () => true, isWriteTool: () => false, limits: () => SERVICE_LIMITS, env: {},
      decide: async (req) => { asked.push(req); return { selected: 'none', scores: { none: 1 }, source: 'configured' }; } });
    await gate.evaluate('Please take care of the synthetic thing', many, bias);
    const req = asked[0];
    const chars = req.question.length + req.options.reduce((n, o) => n + o.id.length + o.label.length + 2, 0);
    assert.ok(chars <= SERVICE_LIMITS.maxChoiceChars, `${chars} chars`);
    assert.ok(req.options.length <= SERVICE_LIMITS.maxOptions && req.options.at(-1).id === 'none');
  }
});
