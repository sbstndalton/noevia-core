'use strict';
const skipWasm = !require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the body never runs and the
// test reports ok): when the module is there, every guarded body must have run.
let ran = 0;
// #1639 / #1739 / #1740: the tool gate's wording follows the decision model behind the service
// (decision-models.cjs). The default wording, used for any unknown or unconfigured model, is exactly the request every
// release before #1639 sent; the tuned wording is the question tuned for a small decision model, with the choice budget lowered by
// that question's extra characters. The Rust port shapes the options (TOOL_GATE_IMPL, retired in #1071),
// and counts the question as 79 characters (noevia-rs crates/tool-gate QUESTION.len()); the gate gives it the
// lowered limits for the longer question (tests/server/tool-gate-differential runs both wordings against the
// frozen JS shaping).
const test = require('node:test');
const assert = require('node:assert/strict');
const tg = require('./tool-gate.cjs');
const { SERVICE_LIMITS } = require('./decision-settings.cjs');

// The main-branch request (before #1639), byte for byte: tools/decision-eval build-requests on main.
const DEFAULT_QUESTION = 'Which tool, if any, must the assistant call before answering this user message?';
const DEFAULT_OPTIONS = [
  { id: 'tavily_extract', label: 'Read the text of a web page from its URL.' },
  { id: 'tavily_search', label: 'Search the web for current facts and news.' },
  { id: 'diary_read_month', label: "Read the user's own diary entries for a mont" },
  { id: 'nc_webdav_search_files', label: "Find the user's own stored files and documen" },
  { id: 'none', label: 'No tool: answer directly' },
];
const KEV_QUESTION = 'Without tools the assistant knows no current news and nothing the user wrote or saved. Which tool does it need, if any?';
const TUNED_OPTIONS = [
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
// What the former JS shaping (shapeOptions, frozen in tests/fixtures/tool-gate-js.v1.json) gave for a frame hint:
// the default wording with the question's real length as the budget, the tuned wording with 79 + hint in a choice budget lowered by 40.
const DEFAULT_HINT_OPTIONS = [
  { id: 'tavily_search', label: 'Search the web for current facts a' },
  { id: 'tavily_extract', label: 'Read the text of a web page from i' },
  { id: 'diary_read_month', label: "Read the user's own diary entries " },
  { id: 'nc_webdav_search_files', label: "Find the user's own stored files a" },
  { id: 'none', label: 'No tool: answer directly' },
];
const TUNED_HINT_OPTIONS = [
  { id: 'tavily_search', label: 'Search the web for curre' },
  { id: 'tavily_extract', label: 'Read the text of a web p' },
  { id: 'diary_read_month', label: "Read the user's own diar" },
  { id: 'nc_webdav_search_files', label: "Find the user's own stor" },
  { id: 'none', label: 'No tool: answer directly' },
];

async function sent(wording, bias) {
  const asked = [];
  const gate = tg.createToolGate({ enabled: () => true, isWriteTool: () => false, limits: () => SERVICE_LIMITS,
    ...(wording === undefined ? {} : { wording }),
    decide: async (req) => { asked.push(req); return { selected: 'none', scores: { none: 1 }, source: 'configured' }; } });
  await gate.evaluate('Synthetic: who won the match last night?', TOOLS, bias);
  assert.equal(asked.length, 1);
  return asked[0];
}

test('the default wording gets the main-branch request byte for byte, by default and by name (#1739)', { skip: skipWasm }, async () => {
  ran++;
  for (const wording of [undefined, 'laya', () => 'laya']) {
    const req = await sent(wording);
    assert.deepEqual({ purpose: req.purpose, question: req.question, options: req.options },
      { purpose: 'tool.gate', question: DEFAULT_QUESTION, options: DEFAULT_OPTIONS });
    assert.equal(JSON.stringify(req.options), JSON.stringify(DEFAULT_OPTIONS));
  }
  assert.equal(tg.QUESTION, DEFAULT_QUESTION);
  assert.equal(tg.questionFor('laya'), DEFAULT_QUESTION);
});

test('an unknown, empty or throwing wording falls back to the default request', { skip: skipWasm }, async () => {
  ran++;
  for (const wording of ['tuned-0.8b', 'KEV', '', null, () => 'other', () => { throw Error('settings gone'); }]) {
    const req = await sent(wording);
    assert.equal(req.question, DEFAULT_QUESTION, String(wording));
    assert.deepEqual(req.options, DEFAULT_OPTIONS, String(wording));
  }
});

test('the tuned wording gets the tuned question and the lowered budget: labels cut to 34 for this tool set', { skip: skipWasm }, async () => {
  ran++;
  for (const wording of ['kev', () => 'kev']) {
    const req = await sent(wording);
    assert.equal(req.question, KEV_QUESTION);
    assert.deepEqual(req.options, TUNED_OPTIONS);
    assert.ok(req.question.length + req.options.reduce((n, o) => n + o.id.length + o.label.length + 2, 0) <= SERVICE_LIMITS.maxChoiceChars);
  }
  assert.equal(tg.KEV_QUESTION, KEV_QUESTION);
  assert.doesNotMatch(KEV_QUESTION, /\bmust\b/, '"must" made the tuned model answer none (#1639)');
});

test('a frame hint is appended to either question and counted in the budget the same way', { skip: skipWasm }, async () => {
  ran++;
  const bias = { prefer: ['search'], hint: 'The user framed this chat as a lookup.' };
  const dflt = await sent('laya', bias);
  const tuned = await sent('kev', bias);
  assert.equal(dflt.question, `${DEFAULT_QUESTION} ${bias.hint}`);
  assert.equal(tuned.question, `${KEV_QUESTION} ${bias.hint}`);
  // Default wording: shaped exactly as main shaped it, with the question's real length as the budget.
  assert.deepEqual(dflt.options, DEFAULT_HINT_OPTIONS);
  // Tuned wording: 79 + hint, in a choice budget lowered by 40 (what the port counts given the same limits).
  assert.deepEqual(tuned.options, TUNED_HINT_OPTIONS);
});

test('budgetLimits: the 40-character cut only for the tuned question, whatever maxOptions is (#1740 D3)', () => {
  assert.equal(tg.BUDGET_QUESTION_CHARS, 79);
  assert.equal(DEFAULT_QUESTION.length, 79, 'the question the port budgets');
  assert.equal(KEV_QUESTION.length - 79, 40);
  assert.deepEqual(tg.budgetLimits(SERVICE_LIMITS), { ...SERVICE_LIMITS, maxChoiceChars: 320 });
  assert.deepEqual(tg.budgetLimits(SERVICE_LIMITS, KEV_QUESTION), { ...SERVICE_LIMITS, maxChoiceChars: 320 });
  assert.equal(tg.budgetLimits(SERVICE_LIMITS, DEFAULT_QUESTION), SERVICE_LIMITS, 'default wording: the limits object itself');
  assert.equal(tg.budgetLimits(null), null);
  const noBudget = { maxOptions: 8, maxLabelChars: 120 };
  assert.equal(tg.budgetLimits(noBudget), noBudget, 'no finite choice budget: unchanged');
  // D3: no finite maxOptions no longer skips the cut, so the budget can never be 40 characters over.
  for (const maxOptions of [undefined, Infinity, NaN, null]) {
    assert.deepEqual(tg.budgetLimits({ maxOptions, maxChoiceChars: 360 }), { maxOptions, maxChoiceChars: 320 }, String(maxOptions));
  }
  assert.equal(SERVICE_LIMITS.maxChoiceChars, 360, 'the service limit itself is unchanged');
});

test('question plus options stay within the service choice budget for both wordings, with 12 long tools and a long hint', { skip: skipWasm }, async () => {
  ran++;
  const long = (name) => tool(name, `${name} reads synthetic data. `.repeat(12));
  const many = [...Array.from({ length: 10 }, (_, i) => long(`synthetic_reader_${i}`)), long('Web-Fetch'), long('tavily_search')];
  for (const wording of ['laya', 'kev']) {
    for (const bias of [undefined, { prefer: ['search'], hint: 'h'.repeat(300) }]) {
      const asked = [];
      const gate = tg.createToolGate({ enabled: () => true, isWriteTool: () => false, limits: () => SERVICE_LIMITS, wording,
        decide: async (req) => { asked.push(req); return { selected: 'none', scores: { none: 1 }, source: 'configured' }; } });
      await gate.evaluate('Please take care of the synthetic thing', many, bias);
      const req = asked[0];
      const chars = req.question.length + req.options.reduce((n, o) => n + o.id.length + o.label.length + 2, 0);
      assert.ok(chars <= SERVICE_LIMITS.maxChoiceChars, `${wording}: ${chars} chars`);
      assert.ok(req.options.length <= SERVICE_LIMITS.maxOptions && req.options.at(-1).id === 'none');
    }
  }
});

test.after(() => { if (!skipWasm) assert.equal(ran, 5, 'a wasm-guarded test body did not run'); });
