'use strict';
// TOOL_GATE_IMPL: the switch and its strict paths, with a stand-in for the Rust port (no
// dav-parse.wasm needed; tests/server/tool-gate-differential.test.cjs runs the real module). The
// port can only make the gate force less: prefetch only when both prefetch the same arguments,
// require when one requires, and 'none' (the gate off) for a different tool, a rule or answer only
// one side sees, different Stage 2 options, a fault or a bad reply; after a rule or option
// mismatch the decision service is not asked. Synthetic messages and tools only.
const test = require('node:test'), assert = require('node:assert/strict');
const tg = require('./tool-gate.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const fn = (name, properties, required) => ({ type: 'function', function: { name, description: `${name} (synthetic)`, parameters: { type: 'object', properties, ...(required ? { required } : {}) } } });
const TOOLS = [fn('web_fetch', { url: { type: 'string' } }, ['url']), fn('tavily_search', { query: {} }, ['query']), fn('diary_read_month', { month: {} }, ['month']),
  fn('project_search', { query: {} }), fn('write_file', { path: {} })];
const isWriteTool = (n) => n === 'write_file';
const NOW = Date.UTC(2026, 8, 15, 12);
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };

/** A stand-in port: each toolGate* call is recorded and answered by `answers[name]` (default: a fault). */
function fakePort(answers = {}) {
  const calls = [];
  const fnOf = (name) => (...args) => { calls.push([name, args]); return (answers[name] || fault)(...args); };
  return { calls, loader: () => ({ toolGateRule: fnOf('rule'), toolGateOptions: fnOf('options'), toolGateAnswer: fnOf('answer') }) };
}
function gate({ port, env = { TOOL_GATE_IMPL: 'wasm' }, decide = async () => ({ selected: 'project_search', confidence: 0.9 }), limits = null } = {}) {
  const logs = [], decided = [];
  const g = tg.createToolGate({ enabled: () => true, isWriteTool, now: () => NOW, env, wasmLoader: port?.loader, limits, unavailable: () => null,
    decide: async (r) => { decided.push(r); return decide(r); }, log: (e) => logs.push(e), warn: () => {} });
  return { g, logs, decided };
}
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  return Promise.resolve().then(fn).then((value) => ({ value, seen })).finally(() => { console.warn = warn; });
}
const sameRule = (message) => () => {
  const offered = new Map(TOOLS.map((t) => [t.function.name, t]));
  const js = tg.ruleDecisionWith(message, offered, { boxes: tg.DEFAULT_BOXES, readOnly: (n) => !isWriteTool(n), now: () => NOW });
  return js ? { rule: js.rule, decision: js.decision.mode === 'prefetch' ? { tool: js.decision.tool, mode: 'prefetch', args: js.decision.args } : js.decision } : { rule: null };
};

test('TOOL_GATE_IMPL: default js, wasm when set, anything else js with one warning', async () => {
  const { seen } = await quietly(() => {
    assert.equal(tg.toolGateImpl({}), 'js');
    assert.equal(tg.toolGateImpl({ TOOL_GATE_IMPL: '' }), 'js');
    assert.equal(tg.toolGateImpl({ TOOL_GATE_IMPL: ' WASM ' }), 'wasm');
    assert.equal(tg.toolGateImpl({ TOOL_GATE_IMPL: 'Js' }), 'js');
    assert.equal(tg.toolGateImpl({ TOOL_GATE_IMPL: 'rust' }), 'js');
    assert.equal(tg.toolGateImpl({ TOOL_GATE_IMPL: 'rust' }), 'js');
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /TOOL_GATE_IMPL="rust" is not js or wasm; using js/);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('TOOL_GATE_IMPL'), 'a missing or tampered module stops startup');
});

test('under js (the default, and an unknown value) the port is never asked', async () => {
  const port = fakePort();
  for (const env of [{}, { TOOL_GATE_IMPL: 'on' }]) {
    const { g } = gate({ port, env });
    await quietly(async () => {
      assert.equal((await g.evaluate('open https://example.com/a', TOOLS)).decision.mode, 'prefetch');
      assert.equal((await g.evaluate('hello there', TOOLS)).decision.tool, 'project_search');
    });
  }
  assert.deepEqual(port.calls, []);
});

test('agreement: the JS decision stands, and the port saw projections, not tool objects', async () => {
  const port = fakePort({ rule: sameRule('open https://example.com/a') });
  const { g, logs } = gate({ port });
  const out = await g.evaluate('open https://example.com/a', TOOLS);
  assert.deepEqual(out.decision, { tool: 'web_fetch', args: { url: 'https://example.com/a' }, mode: 'prefetch' });
  assert.equal(logs.at(-1).reason, undefined);
  const [, [message, tools, now, boxes]] = port.calls[0];
  assert.equal(message, 'open https://example.com/a');
  assert.equal(now, NOW);
  assert.deepEqual(tools[0], { name: 'web_fetch', readOnly: true, description: 'web_fetch (synthetic)', own: ['url'], truthy: ['url'], anyProps: true, required: ['url'] });
  assert.equal(tools[4].readOnly, false);
  assert.deepEqual(boxes[0], ['url', tg.DEFAULT_BOXES.url]);
});

test('a prefetch the port only requires, or prefetches with other arguments, is required', async () => {
  for (const decision of [{ tool: 'web_fetch', mode: 'require' }, { tool: 'web_fetch', mode: 'prefetch', args: { url: 'https://example.com/b' } }]) {
    const port = fakePort({ rule: () => ({ rule: 'url', decision }) });
    const { g, logs } = gate({ port });
    const { value: out, seen } = await quietly(() => g.evaluate('open https://example.com/a', TOOLS));
    assert.deepEqual(out.decision, { tool: 'web_fetch', mode: 'require' });
    assert.equal(out.source, 'rule');
    assert.equal(logs.at(-1).reason, 'impl-stricter');
    assert.ok(seen.every((l) => !l.includes('example.com')), 'warnings carry no input');
  }
});

test('a JS require stays required when the port would prefetch', async () => {
  // The diary tool needs a month and the message names none: the JS requires it.
  const port = fakePort({ rule: () => ({ rule: 'diary', decision: { tool: 'diary_read_month', mode: 'prefetch', args: { month: '2026-09' } } }) });
  const { g } = gate({ port });
  const out = await g.evaluate('what is in my diary', TOOLS);
  assert.deepEqual(out.decision, { tool: 'diary_read_month', mode: 'require' });
});

test('a different tool, a rule only one side sees, a fault or a bad reply: none, and the service is not asked', async () => {
  const cases = [
    [{ rule: () => ({ rule: 'url', decision: { tool: 'tavily_search', mode: 'require' } }) }, 'open https://example.com/a', 'impl-mismatch'],
    [{ rule: () => ({ rule: 'search', decision: { tool: 'web_fetch', mode: 'require' } }) }, 'open https://example.com/a', 'impl-mismatch'],
    [{ rule: () => ({ rule: null }) }, 'open https://example.com/a', 'impl-mismatch'],
    [{ rule: () => ({ rule: 'search', decision: { tool: 'tavily_search', mode: 'require' } }) }, 'hello there', 'impl-mismatch'],
    [{}, 'open https://example.com/a', 'impl-fault'],
    [{ rule: () => { throw new davParseWasm.DavParseError('bad', 'reply'); } }, 'hello there', 'impl-fault'],
  ];
  for (const [answers, message, reason] of cases) {
    const port = fakePort(answers);
    const { g, logs, decided } = gate({ port });
    const { value: out } = await quietly(() => g.evaluate(message, TOOLS));
    assert.equal(out.decision, 'none', message);
    assert.equal(logs.at(-1).reason, reason);
    assert.deepEqual(decided, [], 'no decision service call after a rule mismatch or fault');
  }
});

test('Stage 2: options must match exactly, or the service is not asked', async () => {
  const shaped = (offered) => tg.readoutOptions(offered, { boxes: tg.DEFAULT_BOXES, readOnly: (n) => !isWriteTool(n), bias: null, limits: null }).shape();
  const offered = new Map(TOOLS.map((t) => [t.function.name, t]));
  const good = shaped(offered);
  const variants = [{ ...good, trimmed: good.trimmed + 1 }, { ...good, options: good.options.slice(1) },
    { ...good, options: good.options.map((o, i) => (i === 0 ? { ...o, label: `${o.label}!` } : o)) }];
  for (const v of variants) {
    const port = fakePort({ rule: () => ({ rule: null }), options: () => v });
    const { g, logs, decided } = gate({ port });
    const { value: out } = await quietly(() => g.evaluate('hello there', TOOLS));
    assert.equal(out.decision, 'none');
    assert.equal(logs.at(-1).reason, 'impl-mismatch');
    assert.deepEqual(decided, []);
  }
  const port = fakePort({ rule: () => ({ rule: null }) }); // options faults
  const { g, logs, decided } = gate({ port });
  await quietly(() => g.evaluate('hello there', TOOLS));
  assert.equal(logs.at(-1).reason, 'impl-fault');
  assert.deepEqual(decided, []);
});

test('Stage 2: the answer stands when both read it the same; a stricter port requires; anything else is none', async () => {
  const offered = new Map(TOOLS.map((t) => [t.function.name, t]));
  const options = () => tg.readoutOptions(offered, { boxes: tg.DEFAULT_BOXES, readOnly: (n) => !isWriteTool(n), bias: null, limits: null }).shape();
  const run = async (answer, decide, message = 'hello there') => {
    const port = fakePort({ rule: () => ({ rule: null }), options, answer });
    const { g, logs } = gate({ port, decide });
    const { value } = await quietly(() => g.evaluate(message, TOOLS));
    return { out: value, log: logs.at(-1), port };
  };
  // project_search is a drive tool: always required.
  let r = await run(() => ({ decision: { tool: 'project_search', mode: 'require' } }));
  assert.deepEqual(r.out.decision, { tool: 'project_search', mode: 'require' });
  assert.equal(r.out.source, 'decision');
  const [, args] = r.port.calls.find(([n]) => n === 'answer');
  assert.deepEqual(args.slice(4), ['project_search', null, null, 0.9, 0.6]);
  // A diary tool that needs no month, chosen by the service: prefetched ({}) by the JS.
  const decide = async () => ({ selected: 'diary_read_today', confidence: 0.95 });
  const today = { type: 'function', function: { name: 'diary_read_today', parameters: { properties: {} } } };
  const runToday = async (answer) => {
    const port = fakePort({ rule: () => ({ rule: null }), options: () => tg.readoutOptions(new Map([...TOOLS, today].map((t) => [t.function.name, t])),
      { boxes: tg.DEFAULT_BOXES, readOnly: (n) => !isWriteTool(n), bias: null, limits: null }).shape(), answer });
    const { g } = gate({ port, decide });
    return (await quietly(() => g.evaluate('hello there', [...TOOLS, today]))).value;
  };
  assert.deepEqual((await runToday(() => ({ decision: { tool: 'diary_read_today', mode: 'prefetch', args: {} } }))).decision,
    { tool: 'diary_read_today', args: {}, mode: 'prefetch' });
  assert.deepEqual((await runToday(() => ({ decision: { tool: 'diary_read_today', mode: 'require' } }))).decision, { tool: 'diary_read_today', mode: 'require' });
  assert.equal((await runToday(() => ({ reason: 'not-offered' }))).decision, 'none');
  r = await run(() => ({ decision: { tool: 'tavily_search', mode: 'require' } }));
  assert.equal(r.out.decision, 'none');
  assert.equal(r.log.reason, 'impl-mismatch');
  r = await run(() => ({ reason: 'low-confidence' }));
  assert.equal(r.out.decision, 'none');
  r = await run(fault);
  assert.equal(r.out.decision, 'none');
  assert.equal(r.log.reason, 'impl-fault');
  // The JS gives no decision: the port cannot add one.
  r = await run(() => ({ decision: { tool: 'project_search', mode: 'require' } }), async () => ({ selected: 'none', confidence: 0.99 }));
  assert.equal(r.out.decision, 'none');
  assert.equal(r.log.reason, 'none');
});

test('stricterDecision never forces more than either side', () => {
  const p = (tool, args) => ({ tool, mode: 'prefetch', args }), q = (tool) => ({ tool, mode: 'require' });
  const RANK = { require: 1, prefetch: 2 };
  const cases = [[p('a', { url: 'x' }), p('a', { url: 'x' })], [p('a', { url: 'x' }), p('a', { url: 'y' })], [p('a', {}), q('a')], [q('a'), p('a', {})],
    [q('a'), q('a')], [p('a', {}), p('b', {})], [q('a'), q('b')], [p('a', {}), null], [null, q('a')]];
  for (const [js, port] of cases) {
    const m = tg.stricterDecision(js, port);
    if (!js || !port || js.tool !== port.tool) { assert.equal(m, undefined); continue; }
    assert.equal(m.tool, js.tool);
    assert.ok(RANK[m.mode] <= RANK[js.mode] && RANK[m.mode] <= RANK[port.mode]);
    if (m.mode === 'prefetch') assert.deepEqual(m.args, js.args);
  }
});

test('projections: what the rules read, as the JS reads it', () => {
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
