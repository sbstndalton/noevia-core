'use strict';
// #1639 / #1739 / #1740: the tool gate's wording follows the decision model behind the service
// (decision-models.cjs). Laya, and any unknown or unconfigured model, gets exactly the request every
// release before #1639 sent; Kev-0.8B gets the question tuned for it, with the choice budget lowered by
// that question's extra characters. TOOL_GATE_IMPL=wasm (live) compares the shaped options with the
// Rust port, which counts the question as 79 characters (noevia-rs crates/tool-gate QUESTION.len()); the
// gate gives both sides the same lowered limits, so they still agree (tests/server/tool-gate-differential
// runs both wordings through the port itself).
const test = require('node:test');
const assert = require('node:assert/strict');
const tg = require('./tool-gate.cjs');
const { SERVICE_LIMITS } = require('./decision-settings.cjs');

// The main-branch request (before #1639), byte for byte: tools/decision-eval build-requests on main.
const LAYA_QUESTION = 'Which tool, if any, must the assistant call before answering this user message?';
const LAYA_OPTIONS = [
  { id: 'tavily_extract', label: 'Read the text of a web page from its URL.' },
  { id: 'tavily_search', label: 'Search the web for current facts and news.' },
  { id: 'diary_read_month', label: "Read the user's own diary entries for a mont" },
  { id: 'nc_webdav_search_files', label: "Find the user's own stored files and documen" },
  { id: 'none', label: 'No tool: answer directly' },
];
const KEV_QUESTION = 'Without tools the assistant knows no current news and nothing the user wrote or saved. Which tool does it need, if any?';
const KEV_OPTIONS = [
  { id: 'tavily_extract', label: 'Read the text of a web page from i' },
  { id: 'tavily_search', label: 'Search the web for current facts a' },
  { id: 'diary_read_month', label: "Read the user's own diary entries " },
  { id: 'nc_webdav_search_files', label: "Find the user's own stored files a" },
  { id: 'none', label: 'No tool: answer directly' },
];
const tool = (name, description) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } });
const TOOLS = [
  tool('tavily_search', 'Search the web for current facts and news.'),
  tool('tavily_extract', 'Read the text of a web page from its URL.'),
  tool('diary_read_month', "Read the user's own diary entries for a month."),
  tool('nc_webdav_search_files', "Find the user's own stored files and documents."),
];
const offered = new Map(TOOLS.map((t) => [t.function.name, t]));
const readOnly = () => true;

async function sent(wording, bias) {
  const asked = [];
  const gate = tg.createToolGate({ enabled: () => true, isWriteTool: () => false, limits: () => SERVICE_LIMITS, env: {},
    ...(wording === undefined ? {} : { wording }),
    decide: async (req) => { asked.push(req); return { selected: 'none', scores: { none: 1 }, source: 'configured' }; } });
  await gate.evaluate('Synthetic: who won the match last night?', TOOLS, bias);
  assert.equal(asked.length, 1);
  return asked[0];
}

test('Laya gets the main-branch request byte for byte, by default and by name (#1739)', async () => {
  for (const wording of [undefined, 'laya', () => 'laya']) {
    const req = await sent(wording);
    assert.deepEqual({ purpose: req.purpose, question: req.question, options: req.options },
      { purpose: 'tool.gate', question: LAYA_QUESTION, options: LAYA_OPTIONS });
    assert.equal(JSON.stringify(req.options), JSON.stringify(LAYA_OPTIONS));
  }
  assert.equal(tg.QUESTION, LAYA_QUESTION);
  assert.equal(tg.questionFor('laya'), LAYA_QUESTION);
});

test('an unknown, empty or throwing wording falls back to the Laya request', async () => {
  for (const wording of ['kev-0.8b', 'KEV', '', null, () => 'other', () => { throw Error('settings gone'); }]) {
    const req = await sent(wording);
    assert.equal(req.question, LAYA_QUESTION, String(wording));
    assert.deepEqual(req.options, LAYA_OPTIONS, String(wording));
  }
});

test('Kev gets the tuned question and the lowered budget: labels cut to 34 for this tool set', async () => {
  for (const wording of ['kev', () => 'kev']) {
    const req = await sent(wording);
    assert.equal(req.question, KEV_QUESTION);
    assert.deepEqual(req.options, KEV_OPTIONS);
    assert.ok(req.question.length + req.options.reduce((n, o) => n + o.id.length + o.label.length + 2, 0) <= SERVICE_LIMITS.maxChoiceChars);
  }
  assert.equal(tg.KEV_QUESTION, KEV_QUESTION);
  assert.doesNotMatch(KEV_QUESTION, /\bmust\b/, '"must" made Kev-0.8B answer none (#1639)');
});

test('a frame hint is appended to either question and counted in the budget the same way', async () => {
  const bias = { prefer: ['search'], hint: 'The user framed this chat as a lookup.' };
  const laya = await sent('laya', bias);
  const kev = await sent('kev', bias);
  assert.equal(laya.question, `${LAYA_QUESTION} ${bias.hint}`);
  assert.equal(kev.question, `${KEV_QUESTION} ${bias.hint}`);
  // Laya: shaped exactly as main shaped it, with the question's real length as the budget.
  assert.deepEqual(laya.options, tg.shapeOptions([...offered.values()], SERVICE_LIMITS, tg.DEFAULT_BOXES, laya.question.length, tg.DEFAULT_BOXES.search).options);
  // Kev: 79 + hint, in a choice budget lowered by 40 (what the port counts given the same limits).
  assert.deepEqual(kev.options, tg.shapeOptions([...offered.values()], tg.budgetLimits(SERVICE_LIMITS), tg.DEFAULT_BOXES, 79 + 1 + bias.hint.length, tg.DEFAULT_BOXES.search).options);
});

test('budgetLimits: the 40-character cut only for the Kev question, whatever maxOptions is (#1740 D3)', () => {
  assert.equal(tg.BUDGET_QUESTION_CHARS, 79);
  assert.equal(LAYA_QUESTION.length, 79, 'the question the port budgets');
  assert.equal(KEV_QUESTION.length - 79, 40);
  assert.deepEqual(tg.budgetLimits(SERVICE_LIMITS), { ...SERVICE_LIMITS, maxChoiceChars: 320 });
  assert.deepEqual(tg.budgetLimits(SERVICE_LIMITS, KEV_QUESTION), { ...SERVICE_LIMITS, maxChoiceChars: 320 });
  assert.equal(tg.budgetLimits(SERVICE_LIMITS, LAYA_QUESTION), SERVICE_LIMITS, 'Laya: the limits object itself');
  assert.equal(tg.budgetLimits(null), null);
  const noBudget = { maxOptions: 8, maxLabelChars: 120 };
  assert.equal(tg.budgetLimits(noBudget), noBudget, 'no finite choice budget: unchanged');
  // D3: no finite maxOptions no longer skips the cut, so the budget can never be 40 characters over.
  for (const maxOptions of [undefined, Infinity, NaN, null]) {
    assert.deepEqual(tg.budgetLimits({ maxOptions, maxChoiceChars: 360 }), { maxOptions, maxChoiceChars: 320 }, String(maxOptions));
  }
  assert.equal(SERVICE_LIMITS.maxChoiceChars, 360, 'the service limit itself is unchanged');
});

test('question plus options stay within the service choice budget for both wordings, with 12 long tools and a long hint', async () => {
  const long = (name) => tool(name, `${name} reads synthetic data. `.repeat(12));
  const many = [...Array.from({ length: 10 }, (_, i) => long(`synthetic_reader_${i}`)), long('Web-Fetch'), long('tavily_search')];
  for (const wording of ['laya', 'kev']) {
    for (const bias of [undefined, { prefer: ['search'], hint: 'h'.repeat(300) }]) {
      const asked = [];
      const gate = tg.createToolGate({ enabled: () => true, isWriteTool: () => false, limits: () => SERVICE_LIMITS, env: {}, wording,
        decide: async (req) => { asked.push(req); return { selected: 'none', scores: { none: 1 }, source: 'configured' }; } });
      await gate.evaluate('Please take care of the synthetic thing', many, bias);
      const req = asked[0];
      const chars = req.question.length + req.options.reduce((n, o) => n + o.id.length + o.label.length + 2, 0);
      assert.ok(chars <= SERVICE_LIMITS.maxChoiceChars, `${wording}: ${chars} chars`);
      assert.ok(req.options.length <= SERVICE_LIMITS.maxOptions && req.options.at(-1).id === 'none');
    }
  }
});
