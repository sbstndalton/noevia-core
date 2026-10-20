'use strict';
// The tool gate applies the Rust port's answer alone (TOOL_GATE_IMPL, retired in #1071), tested with a stand-in
// for the port (no dav-parse.wasm needed; tests/server/tool-gate-differential.test.cjs runs the real module).
// What is checked here is the host's side of the contract, the floor under the port: what the gate sends it,
// that a rule or a Stage 2 answer it gives is applied as given, and that nothing it cannot answer, answers
// badly or names a tool this request does not offer read-only is ever forced: 'none' (the gate off), reason
// impl-fault, the decision service not asked after a fault in the rules or in the options, a counted warning
// that carries no input. Synthetic messages and tools only.
const test = require('node:test'), assert = require('node:assert/strict');
const tg = require('./tool-gate.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const fn = (name, properties, required) => ({ type: 'function', function: { name, description: `${name} (synthetic)`, parameters: { type: 'object', properties, ...(required ? { required } : {}) } } });
const TOOLS = [fn('web_fetch', { url: { type: 'string' } }, ['url']), fn('tavily_search', { query: {} }, ['query']), fn('diary_read_month', { month: {} }, ['month']),
  fn('project_search', { query: {} }), fn('write_file', { path: {} })];
const isWriteTool = (n) => n === 'write_file';
const NOW = Date.UTC(2026, 8, 15, 12);
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
const NO_RULE = () => ({ rule: null });
const OPTIONS = () => ({ trimmed: 1, options: [{ id: 'project_search', label: 'search the project' }, { id: 'none', label: 'No tool: answer directly' }] });

/** A stand-in port: each toolGate* call is recorded and answered by `answers[name]` (default: a fault). */
function fakePort(answers = {}) {
  const calls = [];
  const fnOf = (name) => (...args) => { calls.push([name, args]); return (answers[name] || fault)(...args); };
  return { calls, loader: () => ({ toolGateRule: fnOf('rule'), toolGateOptions: fnOf('options'), toolGateAnswer: fnOf('answer'), toolGateQueries: fnOf('queries') }) };
}
function gate({ port, decide = async () => ({ selected: 'project_search', confidence: 0.9 }), limits = null, wording, tools, boxes } = {}) {
  const logs = [], decided = [];
  const g = tg.createToolGate({ enabled: () => true, isWriteTool, now: () => NOW, wasmLoader: port?.loader, limits, wording, boxes, unavailable: () => null,
    decide: async (r) => { decided.push(r); return decide(r); }, log: (e) => logs.push(e), warn: () => {} });
  return { g, logs, decided, tools };
}
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  return Promise.resolve().then(fn).then((value) => ({ value, seen })).finally(() => { console.warn = warn; });
}
const URL_RULE = () => ({ rule: 'url', decision: { tool: 'web_fetch', mode: 'prefetch', args: { url: 'https://example.com/a' } } });

test('TOOL_GATE_IMPL is retired: it is listed as retired, not as a switch, and the JS path and the comparison are gone', () => {
  assert.equal(davParseWasm.RETIRED_FLAGS.TOOL_GATE_IMPL, 'wasm');
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('TOOL_GATE_IMPL'));
  assert.equal(tg.toolGateImpl, undefined);
  assert.equal(tg.stricterDecision, undefined);
  assert.equal(tg.shapeOptions, undefined);
});

test('the port\'s rule decision is the answer, applied as given, and it saw projections, not tool objects', async () => {
  for (const decision of [{ tool: 'web_fetch', mode: 'prefetch', args: { url: 'https://example.com/a' } }, { tool: 'web_fetch', mode: 'require' }]) {
    const port = fakePort({ rule: () => ({ rule: 'url', decision }) });
    const { g, logs, decided } = gate({ port });
    const out = await g.evaluate('open https://example.com/a', TOOLS);
    assert.deepEqual(out.decision, decision);
    assert.equal(out.source, 'rule');
    assert.deepEqual(logs.at(-1), { event: 'decision', source: 'rule', tool: 'web_fetch', mode: decision.mode, confidence: null, offered: 5, ms: logs.at(-1).ms, rule: 'url' });
    assert.deepEqual(decided, []);
    const [, [message, tools, now, boxes]] = port.calls[0];
    assert.equal(message, 'open https://example.com/a');
    assert.equal(now, NOW);
    assert.deepEqual(tools[0], { name: 'web_fetch', readOnly: true, description: 'web_fetch (synthetic)', own: ['url'], truthy: ['url'], anyProps: true, required: ['url'] });
    assert.equal(tools[4].readOnly, false);
    assert.deepEqual(boxes[0], ['url', tg.DEFAULT_BOXES.url]);
  }
});

test('a fault, a refusal or a bad reply in the rules: nothing is forced, the service is not asked, the warning carries no input', async () => {
  const bad = [fault, () => { throw new davParseWasm.DavParseError('bad', 'reply'); }, () => { throw new TypeError('unexpected'); }, undefined];
  for (const rule of bad) {
    const port = fakePort(rule ? { rule } : {});
    const { g, logs, decided } = gate({ port });
    const { value: out, seen } = await quietly(() => g.evaluate('open https://example.com/secret-path', TOOLS));
    assert.equal(out.decision, 'none');
    assert.equal(out.source, 'none');
    assert.equal(logs.at(-1).reason, 'impl-fault');
    assert.equal(logs.at(-1).rule, undefined);
    assert.deepEqual(decided, []);
    assert.ok(seen.every((l) => !l.includes('secret-path') && !l.includes('example.com')), 'warnings carry no input');
  }
  // A loader that fails (module missing): the same.
  const { g } = gate({ port: { loader: () => { throw new davParseWasm.DavParseError('module not found', 'load'); } } });
  assert.equal((await quietly(() => g.evaluate('open https://example.com/a', TOOLS))).value.decision, 'none');
});

test('a decision the host would not force is a fault of the port: a tool not offered, a write tool, a bad mode or arguments', async () => {
  const decisions = [
    { tool: 'not_offered', mode: 'require' }, { tool: 'write_file', mode: 'require' }, { tool: 'write_file', mode: 'prefetch', args: { path: 'x' } },
    { tool: 'web_fetch', mode: 'run' }, { tool: 'web_fetch', mode: 'prefetch' }, { tool: 'web_fetch', mode: 'prefetch', args: ['x'] }, { tool: 7, mode: 'require' }, null, undefined, 'web_fetch',
  ];
  for (const decision of decisions) {
    const port = fakePort({ rule: () => ({ rule: 'url', decision }) });
    const { g, logs, decided } = gate({ port });
    const out = (await quietly(() => g.evaluate('open https://example.com/a', TOOLS))).value;
    assert.equal(out.decision, 'none', JSON.stringify(decision));
    assert.equal(logs.at(-1).reason, 'impl-fault');
    assert.deepEqual(decided, []);
    // And the same in Stage 2.
    const port2 = fakePort({ rule: NO_RULE, options: OPTIONS, answer: () => ({ decision }) });
    const second = gate({ port: port2 });
    const out2 = (await quietly(() => second.g.evaluate('hello there', TOOLS))).value;
    assert.equal(out2.decision, 'none', JSON.stringify(decision));
    assert.equal(second.logs.at(-1).reason, 'impl-fault');
  }
});

test('prefetch requires every declared key as an own argument, in either stage; require does not need arguments', async () => {
  for (const stage of ['rule', 'answer']) {
    for (const args of [{}, { other: 'qa' }, Object.create({ url: 'https://example.com/qa' })]) {
      const decision = { tool: 'web_fetch', mode: 'prefetch', args };
      const port = fakePort(stage === 'rule' ? { rule: () => ({ rule: 'url', decision }) }
        : { rule: NO_RULE, options: OPTIONS, answer: () => ({ decision }) });
      const { g, logs, decided } = gate({ port });
      const out = (await quietly(() => g.evaluate('qa', TOOLS))).value;
      assert.equal(out.decision, 'none');
      assert.equal(logs.at(-1).reason, 'impl-fault');
      assert.equal(decided.length, stage === 'rule' ? 0 : 1);
    }
  }
  // Presence, not truthiness, is this host floor; schema/value validation remains at the tool boundary.
  for (const value of ['', false, 0, null]) {
    const decision = { tool: 'web_fetch', mode: 'prefetch', args: { url: value } };
    const { g } = gate({ port: fakePort({ rule: () => ({ rule: 'url', decision }) }) });
    assert.deepEqual((await g.evaluate('qa', TOOLS)).decision, decision);
  }
});

test('Stage 2 search prefetch is refused by the host, while Stage 1 and require retain their behavior', async () => {
  const decision = { tool: 'tavily_search', mode: 'prefetch', args: { query: 'qa' } };
  const first = gate({ port: fakePort({ rule: () => ({ rule: 'search', decision }) }) });
  assert.deepEqual((await first.g.evaluate('qa', TOOLS)).decision, decision);
  const second = gate({ port: fakePort({ rule: NO_RULE, options: OPTIONS, answer: () => ({ decision }) }) });
  assert.equal((await quietly(() => second.g.evaluate('qa', TOOLS))).value.decision, 'none');
  assert.equal(second.logs.at(-1).reason, 'impl-fault');
  const required = { tool: 'tavily_search', mode: 'require' };
  const third = gate({ port: fakePort({ rule: NO_RULE, options: OPTIONS, answer: () => ({ decision: required }) }) });
  assert.deepEqual((await third.g.evaluate('qa', TOOLS)).decision, required);
  // Caller-provided kinds follow first matching non-drive order, just as the crate does.
  const fourth = gate({ boxes: { url: ['tavily_search'], search: ['tavily_search'] },
    port: fakePort({ rule: NO_RULE, options: OPTIONS, answer: () => ({ decision }) }) });
  assert.deepEqual((await fourth.g.evaluate('qa', TOOLS)).decision, decision);
});

test('a search suitability fault warns about the query, without claiming a tool was forced', async () => {
  const { value, seen } = await quietly(() => tg.prefetchableSearch('qa private message', () => {
    throw new davParseWasm.DavParseError('qa fault', 'suitability-warning');
  }));
  assert.equal(value, false);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /the message was not used as a search query/);
  assert.doesNotMatch(seen[0], /no tool was forced|qa private message/);
});

test('Stage 2: the options are the port\'s, sent as the service\'s options; a fault or no option fitting asks nobody', async () => {
  const port = fakePort({ rule: NO_RULE, options: OPTIONS, answer: () => ({ reason: 'none' }) });
  const { g, logs, decided } = gate({ port, limits: { maxOptions: 8, maxLabelChars: 120, maxChoiceChars: 360 }, wording: 'compact' });
  await g.evaluate('hello there', TOOLS, { prefer: ['search'], hint: 'The user framed this chat as a lookup.' });
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0].options, OPTIONS().options);
  assert.equal(decided[0].question, `${tg.COMPACT_QUESTION} The user framed this chat as a lookup.`);
  assert.deepEqual(logs.at(-1).options, 2);
  assert.deepEqual(logs.at(-1).trimmed, 1);
  const [, [tools, prefer, hint, limits]] = port.calls.find(([n]) => n === 'options');
  assert.equal(tools.length, 5);
  assert.deepEqual([prefer, hint], [['search'], 'The user framed this chat as a lookup.']);
  assert.deepEqual(limits, { maxOptions: 8, maxLabelChars: 120, maxChoiceChars: 320 }, 'the choice budget lowered by the Kev question');
  // A fault in the options: nothing forced, nobody asked.
  const f = gate({ port: fakePort({ rule: NO_RULE }) });
  const out = (await quietly(() => f.g.evaluate('hello there', TOOLS))).value;
  assert.equal(out.decision, 'none');
  assert.equal(f.logs.at(-1).reason, 'impl-fault');
  assert.deepEqual(f.decided, []);
  // No option fits.
  const none = gate({ port: fakePort({ rule: NO_RULE, options: () => ({ trimmed: 4, options: [] }) }) });
  assert.equal((await none.g.evaluate('hello there', TOOLS)).decision, 'none');
  assert.equal(none.logs.at(-1).reason, 'no-options-fit');
  assert.deepEqual(none.decided, []);
  // Only write tools offered: the port is not even asked.
  const writes = fakePort({ rule: NO_RULE });
  const w = gate({ port: writes });
  assert.equal((await w.g.evaluate('hello there', [TOOLS[4]])).decision, 'none');
  assert.equal(w.logs.at(-1).reason, 'no-read-tools');
  assert.equal(writes.calls.some(([n]) => n === 'options'), false);
});

test('Stage 2: the port reads the answer; its decision is applied, its refusals are none, a fault is none', async () => {
  const today = { type: 'function', function: { name: 'diary_read_today', parameters: { properties: {} } } };
  const run = async (answer, decide = async () => ({ selected: 'project_search', confidence: 0.9 }), tools = TOOLS) => {
    const port = fakePort({ rule: NO_RULE, options: OPTIONS, answer });
    const { g, logs } = gate({ port, decide });
    const out = (await quietly(() => g.evaluate('hello there', tools))).value;
    return { out, log: logs.at(-1), port };
  };
  let r = await run(() => ({ decision: { tool: 'project_search', mode: 'require' } }));
  assert.deepEqual(r.out.decision, { tool: 'project_search', mode: 'require' });
  assert.equal(r.out.source, 'decision');
  assert.equal(r.out.confidence, 0.9);
  const [, args] = r.port.calls.find(([n]) => n === 'answer');
  assert.deepEqual(args.slice(4), ['project_search', null, null, 0.9, 0.6]);
  // Prefetch with the port's arguments.
  r = await run(() => ({ decision: { tool: 'diary_read_today', mode: 'prefetch', args: {} } }), async () => ({ selected: 'diary_read_today', confidence: 0.95 }), [...TOOLS, today]);
  assert.deepEqual(r.out.decision, { tool: 'diary_read_today', mode: 'prefetch', args: {} });
  // The reasons the port gives: none forced, the confidence still reported as the service gave it.
  r = await run(() => ({ reason: 'low-confidence' }), async () => ({ selected: 'project_search', scores: { project_search: 0.4 } }));
  assert.equal(r.out.decision, 'none');
  assert.equal(r.log.reason, 'low-confidence');
  assert.equal(r.out.confidence, 0.4);
  r = await run(() => ({ reason: 'not-offered' }), async () => ({ selected: 'other', confidence: 0.99 }));
  assert.equal(r.out.decision, 'none');
  assert.equal(r.log.reason, 'not-offered');
  assert.equal(r.out.confidence, undefined);
  r = await run(() => ({ reason: 'none' }), async () => ({ selected: 'none', scores: { none: 0.8 } }));
  assert.equal(r.out.decision, 'none');
  assert.equal(r.log.reason, 'none');
  assert.equal(r.out.confidence, 0.8);
  // A fault, or the service falling back: nothing forced.
  r = await run(fault);
  assert.equal(r.out.decision, 'none');
  assert.equal(r.log.reason, 'impl-fault');
  assert.equal(r.log.options, 2);
  r = await run(() => ({ decision: { tool: 'project_search', mode: 'require' } }), async () => ({ source: 'fallback', metadata: { fellBack: 'timeout' } }));
  assert.equal(r.out.decision, 'none');
  assert.equal(r.log.reason, 'timeout');
  assert.equal(r.port.calls.some(([n]) => n === 'answer'), false, 'the port is asked to read only an answer that exists');
});

test('every fault is counted, logged at the 1st, 10th, 100th and 1000th time, and bounded', async () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (m) => lines.push(String(m));
  try {
    const { g } = gate({ port: fakePort({ rule: () => { throw new davParseWasm.DavParseError('x', 'count-test'); } }) });
    for (let i = 0; i < 1100; i++) await g.evaluate('open https://example.com/a', TOOLS);
  } finally { console.warn = warn; }
  assert.deepEqual(lines.map((l) => l.match(/\((\d+) times so far\)/)?.[1] ?? '1'), ['1', '10', '100', '1000']);
  assert.ok(lines.every((l) => /^\[tool-gate\] tool_gate\.wasm_fault \(count-test\); no tool was forced/.test(l) && !l.includes('example.com')));
  // A flood of distinct reasons stays bounded.
  console.warn = () => {};
  try {
    for (let i = 0; i < 300; i++) {
      const { g } = gate({ port: fakePort({ rule: () => { throw new davParseWasm.DavParseError('x', `bound-${i}`); } }) });
      await g.evaluate('hello', TOOLS);
    }
  } finally { console.warn = warn; }
});

test('prefetchableSearch asks the port; when it cannot answer the message is not prefetchable (the stricter answer)', async () => {
  const yes = fakePort({ queries: (messages) => ({ queries: messages, prefetchable: messages.map(() => true) }) });
  assert.equal(tg.prefetchableSearch('latest news', yes.loader), true);
  assert.deepEqual(yes.calls[0][1], [['latest news']]);
  assert.equal(tg.prefetchableSearch(undefined, yes.loader), true);
  assert.deepEqual(yes.calls[1][1], [['']]);
  const no = fakePort({ queries: () => ({ queries: [''], prefetchable: [false] }) });
  assert.equal(tg.prefetchableSearch('latest news', no.loader), false);
  const { value, seen } = await quietly(() => [tg.prefetchableSearch('latest news secret', fakePort({ queries: fault }).loader),
    tg.prefetchableSearch('latest news', fakePort({ queries: () => ({ prefetchable: 'yes' }) }).loader), tg.prefetchableSearch('x', () => { throw Error('no module'); })]);
  assert.deepEqual(value, [false, false, false]);
  assert.ok(seen.every((l) => !l.includes('secret')));
});

test('projections: what the port reads of the request', () => {
  const odd = { type: 'function', function: { name: 'x', parameters: { properties: { url: 0, urls: {}, month: null }, required: ['url', 7, Symbol('s')] } } };
  const sym = tg.toolProjection(odd, () => true);
  assert.deepEqual(sym, { name: 'x', readOnly: true, description: '', own: ['urls', 'url', 'month'], truthy: ['urls'], anyProps: true, required: ['url', '7', null] });
  assert.deepEqual(tg.toolProjection({ function: { name: 'y', parameters: { properties: 'ab' } } }, () => false).anyProps, true);
  assert.deepEqual(tg.boxesProjection({ a: ['x', 7], b: null }), [['a', ['x', null]], ['b', []]]);
  assert.throws(() => tg.boxesProjection({ a: 'x' }), /not a list/);
  assert.equal(tg.limitsProjection({ maxOptions: '8' }), null);
  assert.deepEqual(tg.limitsProjection({ maxOptions: 8, maxLabelChars: 'x', maxChoiceChars: 0 }), { maxOptions: 8, maxLabelChars: 120, maxChoiceChars: 'Infinity' });
  assert.deepEqual([NaN, -Infinity, 2].map(tg.numberProjection), ['NaN', '-Infinity', 2]);
});

test('boxes that cannot be projected, or a clock that is not a number: nothing is forced', async () => {
  const run = async (opts) => {
    const logs = [];
    const port = fakePort({ rule: URL_RULE });
    const g = tg.createToolGate({ enabled: () => true, isWriteTool, wasmLoader: port.loader, unavailable: () => null, decide: async () => ({}), log: (e) => logs.push(e), warn: () => {}, ...opts });
    return { out: (await quietly(() => g.evaluate('open https://example.com/a', TOOLS))).value, logs };
  };
  let r = await run({ boxes: { url: 'web_fetch' }, now: () => NOW });
  assert.equal(r.out.decision, 'none');
  assert.equal(r.logs.at(-1).reason, 'impl-fault');
  r = await run({ now: () => 'noon' });
  assert.equal(r.out.decision, 'none');
  assert.equal(r.logs.at(-1).reason, 'impl-fault');
  r = await run({ now: () => NaN });
  assert.equal(r.out.decision.mode, 'prefetch', 'a clock that is NaN is sent as null, as before');
});
