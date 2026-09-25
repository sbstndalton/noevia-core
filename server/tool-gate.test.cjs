'use strict';
// Tool gate decisions (tool-gate.cjs). Synthetic messages and tools; the decision service is a
// fake decide() function. No network, no model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolGate, searchQuery, diaryMonth } = require('./tool-gate.cjs');

const fn = (name, properties = {}, required = [], description = '') => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const TOOLS = {
  extract: fn('tavily_extract', { urls: { type: 'array' } }, ['urls']),
  search: fn('tavily_search', { query: { type: 'string' } }, ['query']),
  month: fn('diary_read_month', { month: { type: 'string' } }, ['month']),
  today: fn('diary_read_today'),
  files: fn('nc_webdav_search_files', { path: { type: 'string' } }, ['path']),
  write: fn('nc_webdav_write_file', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  time: fn('core_time', {}, [], 'Current time'),
};
const NOW = Date.UTC(2026, 8, 1, 12); // 2026-09-01: "yesterday" is in August
const WRITES = new Set(['nc_webdav_write_file']);

function gate({ enabled = true, decide = async () => { throw Error('decide should not run'); }, minConfidence, deadlineMs, isWriteTool = (n) => WRITES.has(n) } = {}) {
  const logs = [];
  const g = createToolGate({ enabled: () => enabled, decide, isWriteTool, log: (e) => logs.push(e), now: () => NOW, minConfidence, deadlineMs });
  return { g, logs };
}
const all = Object.values(TOOLS);

test('rules: URL, search, diary date and drive map to offered tools with prefetch or require', async () => {
  const { g } = gate();
  let r = await g.evaluate('Summarise https://example.invalid/post?id=1.', all);
  assert.deepEqual(r.decision, { tool: 'tavily_extract', args: { urls: ['https://example.invalid/post?id=1'] }, mode: 'prefetch' });
  assert.equal(r.source, 'rule');
  r = await g.evaluate('Can you search for the latest synthetic widget news?', all);
  assert.equal(r.decision.tool, 'tavily_search'); assert.equal(r.decision.mode, 'prefetch');
  assert.equal(r.decision.args.query, 'the latest synthetic widget news');
  r = await g.evaluate('What did I write in my diary yesterday?', all);
  assert.deepEqual(r.decision, { tool: 'diary_read_month', args: { month: '2026-08' }, mode: 'prefetch' });
  r = await g.evaluate('What happened on 2026-03-14?', all);
  assert.deepEqual(r.decision.args, { month: '2026-03' });
  r = await g.evaluate('Find the budget spreadsheet in my Nextcloud folder', all);
  assert.deepEqual(r.decision, { tool: 'nc_webdav_search_files', mode: 'require' });
});

test('rules: a tool that is not offered is ignored, and the next offered candidate is used', async () => {
  const { g } = gate({ decide: async () => ({ selected: 'none', scores: { none: 1 }, source: 'configured' }) });
  // URL rule with no fetch tool offered: falls to Stage 2, which says none.
  let r = await g.evaluate('Read https://example.invalid/a', [TOOLS.time]);
  assert.equal(r.decision, 'none');
  // Diary without a month tool: diary_read_today (no arguments) is prefetched.
  r = await g.evaluate('Anything in my diary about the synthetic garden?', [TOOLS.today]);
  assert.deepEqual(r.decision, { tool: 'diary_read_today', args: {}, mode: 'prefetch' });
  // Diary month tool offered but no date in the message: required, not guessed.
  r = await g.evaluate('Anything in my diary about the synthetic garden?', [TOOLS.month]);
  assert.deepEqual(r.decision, { tool: 'diary_read_month', mode: 'require' });
});

test('write tools are never gated, by rule or by the decision service', async () => {
  const boxesWrite = createToolGate({ enabled: () => true, isWriteTool: () => true, boxes: { drive: ['nc_webdav_write_file'] },
    decide: async () => ({ selected: 'nc_webdav_write_file', scores: { nc_webdav_write_file: 1 }, source: 'configured' }), log() {} });
  let r = await boxesWrite.evaluate('Save this to my Nextcloud folder', [TOOLS.write]);
  assert.equal(r.decision, 'none');
  const { g } = gate({ decide: async () => ({ selected: 'nc_webdav_write_file', scores: { nc_webdav_write_file: 0.99, none: 0.01 }, source: 'configured' }) });
  r = await g.evaluate('Please take care of it', [TOOLS.write, TOOLS.time]);
  assert.equal(r.decision, 'none');
});

test('Stage 2: labels are the offered read-only tools plus none, temperature 0; accepted only above the bound', async () => {
  let seen = null;
  const decide = async (request) => { seen = request; return { selected: 'core_time', scores: { core_time: 0.8, none: 0.2 }, confidence: 0.8, source: 'configured', metadata: {} }; };
  const { g, logs } = gate({ decide });
  const r = await g.evaluate('How long until the synthetic meeting?', [TOOLS.time, TOOLS.write]);
  assert.deepEqual(seen.options.map((o) => o.id), ['core_time', 'none']);
  assert.equal(seen.kind, 'choice'); assert.equal(seen.purpose, 'tool.gate'); assert.equal(seen.constraints.temperature, 0);
  assert.deepEqual(r.decision, { tool: 'core_time', mode: 'require' });
  assert.equal(r.source, 'decision'); assert.equal(r.confidence, 0.8);
  assert.equal(logs.at(-1).source, 'decision');
  // The lower readout bound is used when reported: 0.55 < 0.6 rejects even with a 0.7 share.
  const low = gate({ decide: async () => ({ selected: 'core_time', scores: { core_time: 0.7, none: 0.3 }, source: 'configured', metadata: { bounds: { core_time: [0.55, 0.7] } } }) });
  const rejected = await low.g.evaluate('How long until the synthetic meeting?', [TOOLS.time]);
  assert.equal(rejected.decision, 'none'); assert.equal(rejected.source, 'none');
  assert.equal(low.logs.at(-1).reason, 'low-confidence');
  const custom = gate({ minConfidence: 0.5, decide: async () => ({ selected: 'core_time', scores: { core_time: 0.7 }, source: 'configured', metadata: { bounds: { core_time: [0.55, 0.7] } } }) });
  assert.equal((await custom.g.evaluate('How long until the synthetic meeting?', [TOOLS.time])).decision.tool, 'core_time');
  // "none" and a fallback answer are both none.
  const none = gate({ decide: async () => ({ selected: 'none', scores: { none: 0.9, core_time: 0.1 }, source: 'configured' }) });
  assert.equal((await none.g.evaluate('Thanks!', [TOOLS.time])).decision, 'none');
  const fell = gate({ decide: async () => ({ selected: null, scores: {}, source: 'fallback', metadata: { fellBack: 'no-backend-answered' } }) });
  assert.equal((await fell.g.evaluate('Thanks!', [TOOLS.time])).decision, 'none');
  assert.equal(fell.logs.at(-1).reason, 'no-backend-answered');
});

test('fail-open: a throwing or hanging decision service gives none and never throws', async () => {
  const thrown = gate({ decide: async () => { throw Error('synthetic outage'); } });
  let r = await thrown.g.evaluate('How long until the synthetic meeting?', [TOOLS.time]);
  assert.equal(r.decision, 'none'); assert.equal(thrown.logs.at(-1).reason, 'error');
  const hung = gate({ deadlineMs: 5, decide: () => new Promise(() => {}) });
  r = await hung.g.evaluate('How long until the synthetic meeting?', [TOOLS.time]);
  assert.equal(r.decision, 'none'); assert.equal(hung.logs.at(-1).reason, 'deadline');
  const badLog = createToolGate({ enabled: () => true, isWriteTool: () => false, decide: async () => { throw Error('x'); }, log: () => { throw Error('disk full'); } });
  assert.equal((await badLog.evaluate('Hello', [TOOLS.time])).decision, 'none');
});

test('off: the gate does nothing, calls nothing and logs nothing', async () => {
  const { g, logs } = gate({ enabled: false });
  const r = await g.evaluate('Search the latest news at https://example.invalid', all);
  assert.deepEqual(r, { decision: 'none', source: 'none', elapsedMs: 0 });
  assert.equal(logs.length, 0);
});

test('every decision is logged text-free: tool names, source, mode, confidence; never the message', async () => {
  const { g, logs } = gate();
  await g.evaluate('Search the synthetic-secret-phrase news', all);
  g.record('gate.miss', { tool: 'tavily_search' });
  assert.equal(logs.length, 2);
  assert.deepEqual({ event: logs[0].event, source: logs[0].source, tool: logs[0].tool, mode: logs[0].mode, rule: logs[0].rule },
    { event: 'decision', source: 'rule', tool: 'tavily_search', mode: 'prefetch', rule: 'search' });
  assert.deepEqual(logs[1], { event: 'gate.miss', tool: 'tavily_search' });
  assert.equal(JSON.stringify(logs).includes('synthetic-secret-phrase'), false);
});

test('helpers: query stripping and diary months', () => {
  assert.equal(searchQuery('Please look up the weather in Synthville today?'), 'the weather in Synthville today');
  assert.equal(diaryMonth('on 3 March 2025', () => NOW), '2025-03');
  assert.equal(diaryMonth('nothing dated here', () => NOW), null);
});

test('search prefetch only for a short single-line message; long, multi-line or quoted text is require', async () => {
  const { g } = gate();
  const short = await g.evaluate('latest news on synthetic widgets', all);
  assert.deepEqual(short.decision, { tool: 'tavily_search', args: { query: 'latest news on synthetic widgets' }, mode: 'prefetch' });
  const pasted = 'What is the latest on this? ' + 'Synthetic pasted paragraph with private detail. '.repeat(6);
  assert.deepEqual((await g.evaluate(pasted, all)).decision, { tool: 'tavily_search', mode: 'require' });
  assert.deepEqual((await g.evaluate('latest news\nsecond line', all)).decision, { tool: 'tavily_search', mode: 'require' });
  assert.deepEqual((await g.evaluate('latest ```code```', all)).decision, { tool: 'tavily_search', mode: 'require' });
  assert.deepEqual((await g.evaluate('> quoted latest news', all)).decision, { tool: 'tavily_search', mode: 'require' });
});

test('Stage 2 never prefetches a search, even for a short message', async () => {
  const { g } = gate({ decide: async () => ({ selected: 'tavily_search', scores: { tavily_search: 0.9, none: 0.1 }, source: 'configured' }) });
  const r = await g.evaluate('synthetic widgets', [TOOLS.search]);
  assert.deepEqual(r.decision, { tool: 'tavily_search', mode: 'require' });
  assert.equal(r.source, 'decision');
});

test('URL prefetch only for public http(s) hosts; private, loopback, link-local, .local and other schemes are require', async () => {
  const { g } = gate({ decide: async () => ({ selected: 'none', scores: { none: 1 }, source: 'configured' }) });
  for (const url of ['http://10.69.0.130/x', 'http://localhost:3000', 'http://169.254.1.1', 'http://foo.local', 'http://127.0.0.1/a', 'http://[::1]/a', 'http://192.168.1.4', 'http://laya:8040/', 'http://user:pw@example.invalid/']) {
    const r = await g.evaluate(`Summarise ${url}`, [TOOLS.extract]);
    assert.deepEqual(r.decision, { tool: 'tavily_extract', mode: 'require' }, url);
  }
  // A ftp:// link is not a URL match at all; a public host is prefetched.
  assert.equal((await g.evaluate('Summarise ftp://example.invalid/file', [TOOLS.extract])).decision, 'none');
  assert.equal((await g.evaluate('Summarise https://example.com/post', [TOOLS.extract])).decision.mode, 'prefetch');
});

test('a tool name offered by two boxes is one option and one decision', async () => {
  let seen = null;
  const { g } = gate({ decide: async (request) => { seen = request; return { selected: 'core_time', scores: { core_time: 0.9, none: 0.1 }, source: 'configured' }; } });
  const r = await g.evaluate('How long until the synthetic meeting?', [TOOLS.time, fn('core_time', {}, [], 'duplicate from another box')]);
  assert.deepEqual(seen.options.map((o) => o.id), ['core_time', 'none']);
  assert.equal(r.decision.tool, 'core_time');
});
