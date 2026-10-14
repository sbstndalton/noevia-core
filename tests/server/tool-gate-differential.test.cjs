'use strict';

// TOOL_GATE_IMPL: tests/fixtures/tool-gate.v1.json (byte-identical to noevia-rs
// crates/tool-gate/tests/fixtures/; CI compares them) holds tool-gate.cjs's answers, printed by
// tools/gen-tool-gate-fixtures.cjs from the JS itself (synthetic rows only). Here every row runs
// through dav-parse.wasm's tool_gate, and the rule rows also through the switched gate; a seeded
// property checks that the switched gate never forces more than the JS (rules and Stage 2 answers
// over random messages, tools and service answers). The patterns are non-Unicode regular
// expressions, so the port's reading of them is checked for every UTF-16 code unit against this
// runtime's own engine: \s (searchQuery's collapsing, trimming and FILLER_RE runs), \b and the
// ASCII-only /i folding (SEARCH_RE, NAMED_DATE_RE), and the URL pattern's stop set. So it holds on
// the shipped Node too. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM);
// skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const tg = require('../../server/tool-gate.cjs');

const FILE = path.join(__dirname, '../fixtures/tool-gate.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-tool-gate-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const RANK = { none: 0, require: 1, prefetch: 2 };
const modeOf = (d) => (d === 'none' ? 'none' : d.mode);

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

const CALLS = {
  1: (a) => davParseWasm.toolGateRule(...a),
  2: (a) => davParseWasm.toolGateOptions(...a),
  3: (a) => davParseWasm.toolGateAnswer(...a),
  4: ([m]) => davParseWasm.toolGateQueries(m),
  5: ([m, now]) => davParseWasm.toolGateMonths(m, now),
  6: ([u]) => davParseWasm.toolGatePublic(u),
};

/** Real tool objects a projection stands for (own but falsy: 0; any key but none of ours: zz). */
function toolsFrom(projection) {
  return projection.map((t) => {
    const properties = {};
    for (const k of t.own) properties[k] = t.truthy.includes(k) ? { type: 'string' } : 0;
    if (t.anyProps && !t.own.length) properties.zz = {};
    return { type: 'function', function: { name: t.name, description: t.description, parameters: { properties, required: t.required.map((k) => (k === null ? Symbol('k') : k)) } } };
  });
}
const boxesFrom = (pairs) => Object.fromEntries(pairs);
function gateFor(projection, boxes, now, impl, decide = async () => ({ source: 'fallback' })) {
  const writes = new Set(projection.filter((t) => !t.readOnly).map((t) => t.name));
  return tg.createToolGate({ enabled: () => true, isWriteTool: (n) => writes.has(n), now: () => now ?? NaN, boxes, decide, unavailable: () => null,
    env: { TOOL_GATE_IMPL: impl }, log: () => {}, warn: () => {} });
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('fixture rows: the exact reply; the switched rules equal the JS, or (strict rows) force less', { skip: skipWasm }, async () => {
  assert.ok(fixtures.rows.length >= 4000);
  let strict = 0;
  for (const [i, row] of fixtures.rows.entries()) {
    const args = JSON.parse(row.wire);
    assert.deepEqual(CALLS[row.op](args), JSON.parse(row.want), `row ${i}`);
    if (row.strict) strict++;
    if (row.op !== 1 || i % 3) continue; // a third of the rule rows through the whole gate
    const [message, projection, now, pairs] = args;
    const tools = toolsFrom(projection);
    const js = await gateFor(projection, boxesFrom(pairs), now, 'js').evaluate(message, tools);
    const sw = await quietly(() => gateFor(projection, boxesFrom(pairs), now, 'wasm').evaluate(message, tools));
    if (!row.strict) assert.deepEqual(sw.decision, js.decision, `row ${i}`);
    else assert.ok(RANK[modeOf(sw.decision)] <= RANK[modeOf(js.decision)], `row ${i}`);
  }
  assert.ok(strict > 100, `${strict} strict rows`);
});

test('property: the switched gate never forces more than the JS (seeded rules and Stage 2 answers)', { skip: skipWasm }, async () => {
  const rand = mulberry32(0x6a7e);
  const pick = (l) => l[Math.floor(rand() * l.length)];
  const WORDS = ['search', 'latest', 'news', 'look up', 'weather', 'my diary', 'journal', 'yesterday I', 'on 3 March', 'march 2024', '2026-09-01', 'today',
    'my files', 'folder', 'drive', 'please', 'can you', 'what is', 'https://example.com/a.', 'http://nas.local../x', 'https://xn--exmple-cua.com/',
    'https://exämple.com/', 'http://10.0.0.1/', 'http://user@example.com/', '\n', '```', '>', '?!', ' ', 'x', 'hello', '42'];
  const NAMES = ['tavily_extract', 'web_fetch', 'fetch_url', 'tavily_search', 'web_search', 'wikipedia_search', 'diary_read_month', 'diary_read_today',
    'diary_list_months', 'nc_webdav_search_files', 'project_search', 'write_file', 'calc'];
  const KEYS = ['urls', 'url', 'query', 'q', 'month', 'lang'];
  let forced = 0;
  for (let n = 0; n < 1500; n++) {
    const message = Array.from({ length: 1 + Math.floor(rand() * 7) }, () => pick(WORDS)).join(pick([' ', ', ', '  ']));
    const tools = Array.from({ length: Math.floor(rand() * 7) }, () => {
      const properties = {};
      for (const k of KEYS) if (rand() < 0.3) properties[k] = rand() < 0.85 ? {} : 0;
      return { type: 'function', function: { name: pick(NAMES), description: 'synthetic', parameters: { properties, required: KEYS.filter((k) => properties[k] && rand() < 0.4) } } };
    });
    const selected = pick([...NAMES, 'none', null]);
    const answer = { selected, confidence: rand(), scores: { [selected]: rand() } }; // the same answer for both runs
    const decide = async () => answer;
    const isWriteTool = (name) => name === 'write_file' || name === 'calc';
    const now = pick([Date.UTC(2026, 8, 15), 0, Date.UTC(2025, 11, 31, 23, 59)]);
    const make = (impl) => tg.createToolGate({ enabled: () => true, isWriteTool, now: () => now, decide, unavailable: () => null,
      env: { TOOL_GATE_IMPL: impl }, log: () => {}, warn: () => {} });
    const js = await make('js').evaluate(message, tools);
    const sw = await quietly(() => make('wasm').evaluate(message, tools));
    assert.ok(RANK[modeOf(sw.decision)] <= RANK[modeOf(js.decision)], JSON.stringify([message, js.decision, sw.decision]));
    if (sw.decision !== 'none') {
      assert.equal(sw.decision.tool, js.decision.tool);
      if (sw.decision.mode === 'prefetch') assert.deepEqual(sw.decision.args, js.decision.args);
      forced++;
    }
    // Only the URL rule is stricter by design: elsewhere the two agree exactly.
    if (!/https?:\/\//.test(message)) assert.deepEqual(sw.decision, js.decision, message);
  }
  assert.ok(forced > 300, `${forced} forced`);
});

test('every UTF-16 code unit: \\s, \\b, /i and the URL stop set read as this runtime reads them', { skip: skipWasm }, () => {
  const units = Array.from({ length: 0x10000 }, (_, c) => String.fromCharCode(c));
  for (let start = 0; start < units.length; start += 4096) {
    const batch = units.slice(start, start + 4096);
    // searchQuery: whitespace collapsing and trimming, FILLER_RE's \s+, \s* and \b, /i folding.
    const messages = batch.map((c) => `${c}look${c}up${c}please${c}NEWS${c}x${c}?`);
    const q = davParseWasm.toolGateQueries(messages);
    assert.deepEqual(q.queries, messages.map(tg.searchQuery), `queries from U+${start.toString(16)}`);
    assert.deepEqual(q.prefetchable, messages.map(tg.prefetchableSearch));
    // NAMED_DATE_RE: \d, \s+, \b and month-name folding next to each unit.
    const dates = batch.map((c) => `on 3${c}March${c}2024 ${c}may${c}5`);
    assert.deepEqual(davParseWasm.toolGateMonths(dates, 0).months, dates.map((m) => tg.diaryMonth(m, () => 0)), `months from U+${start.toString(16)}`);
  }
  // The rule stage: SEARCH_RE/DIARY_RE/DRIVE_RE boundaries and the URL pattern's [^\s<>"')\]] next to each unit.
  const offered = new Map([['web_fetch', { type: 'function', function: { name: 'web_fetch', parameters: { properties: { url: {} } } } }],
    ['tavily_search', { type: 'function', function: { name: 'tavily_search', parameters: { properties: { query: {} } } } }],
    ['project_search', { type: 'function', function: { name: 'project_search', parameters: { properties: { query: {} } } } }]]);
  const proj = tg.offeredProjection(offered, () => true);
  const boxes = tg.boxesProjection(tg.DEFAULT_BOXES);
  for (let c = 0; c < 0x10000; c += 1) {
    const u = String.fromCharCode(c);
    for (const message of [`see https://example.com/a${u}b`, `${u}news${u}`, `my${u}files`]) {
      const js = tg.ruleDecisionWith(message, offered, { boxes: tg.DEFAULT_BOXES, readOnly: () => true, now: () => 0 });
      const port = davParseWasm.toolGateRule(message, proj, 0, boxes);
      if (c >= 0x80 && js?.rule === 'url') {
        // A non-ASCII unit inside the URL: never more than the JS (required, not prefetched).
        assert.equal(port.rule, 'url');
        assert.equal(port.decision.tool, js.decision.tool);
        if (port.decision.mode === 'prefetch') assert.deepEqual(port.decision.args, js.decision.args);
        continue;
      }
      assert.deepEqual(port, js ? { rule: js.rule, decision: js.decision.mode === 'prefetch' ? { tool: js.decision.tool, mode: 'prefetch', args: js.decision.args } : js.decision } : { rule: null },
        `U+${c.toString(16)} in ${JSON.stringify(message)}`);
    }
  }
});

test('a long adversarial message is linear under the switch (the JS strip is quadratic)', { skip: skipWasm }, async () => {
  const tools = [{ type: 'function', function: { name: 'web_fetch', parameters: { properties: { url: {} } } } }];
  const message = `see http://a.com/${'.,'.repeat(150_000)}x`;
  const portStart = Date.now();
  const port = davParseWasm.toolGateRule(message, tg.offeredProjection(new Map([['web_fetch', tools[0]]]), () => true), 0, tg.boxesProjection(tg.DEFAULT_BOXES));
  // Shared runners: loose. The JS path on the same message takes tens of seconds.
  assert.ok(Date.now() - portStart < 10_000);
  assert.equal(port.decision.mode, 'prefetch');
});

// #1740: the lowered choice budget (#1639) is exercised through the gate itself: service limits from
// decision-settings (SERVICE_LIMITS, what production passes as `limits`), a frame hint, and both
// wordings. With the Kev question the gate lowers maxChoiceChars by 40 for the JS shaping AND the port
// (confirmOptions); a one-sided change would turn every Stage 2 answer into impl-mismatch here.
test('#1740: service limits plus a hint, both wordings: the port shapes the options the JS sends, so the answer is used', { skip: skipWasm }, async () => {
  const { SERVICE_LIMITS } = require('../../server/decision-settings.cjs');
  const rand = mulberry32(0x1740);
  const pick = (l) => l[Math.floor(rand() * l.length)];
  const NAMES = ['tavily_extract', 'web_fetch', 'tavily_search', 'web_search', 'wikipedia_search', 'diary_read_month', 'diary_list_months',
    'nc_webdav_search_files', 'project_search', 'synthetic_reader_a', 'synthetic_reader_b', 'Web-Fetch', 'notes.lookup'];
  const HINTS = [null, 'The user framed this chat as a lookup.', 'h'.repeat(300), 'A tool is expected for this action.'];
  const sizes = { laya: new Set(), kev: new Set() };
  let asked = 0;
  for (let n = 0; n < 400; n++) {
    const names = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 10) }, () => pick(NAMES)))];
    const tools = names.map((name) => ({ type: 'function', function: { name, description: `${name} reads synthetic data. `.repeat(1 + Math.floor(rand() * 8)), parameters: { properties: {} } } }));
    const hint = pick(HINTS);
    const bias = { prefer: rand() < 0.5 ? ['search'] : [], ...(hint ? { hint } : {}) };
    const wording = n % 2 ? 'kev' : 'laya';
    const selected = pick([...names, 'none']);
    const run = async (impl) => {
      const requests = [];
      const gate = tg.createToolGate({ enabled: () => true, isWriteTool: () => false, now: () => 0, boxes: tg.DEFAULT_BOXES, unavailable: () => null,
        limits: () => SERVICE_LIMITS, wording, env: { TOOL_GATE_IMPL: impl }, log: () => {}, warn: () => {},
        decide: async (r) => { requests.push(r); return { selected, scores: { [selected]: 0.9 }, confidence: 0.9 }; } });
      // A message no rule answers, so Stage 2 runs.
      return { out: await gate.evaluate('Please take care of the synthetic thing', tools, bias), requests };
    };
    const js = await run('js');
    const sw = await quietly(() => run('wasm'));
    const label = JSON.stringify({ n, wording, names, hint: hint && hint.length });
    assert.equal(js.requests.length, 1, label);
    assert.deepEqual(sw.requests, js.requests, `the port agreed on the options, so the same request was sent: ${label}`);
    assert.deepEqual(sw.out.decision, js.out.decision, label);
    const req = js.requests[0];
    assert.equal(req.question.startsWith(tg.questionFor(wording)), true, label);
    const chars = req.question.length + req.options.reduce((s, o) => s + o.id.length + o.label.length + 2, 0);
    assert.ok(chars <= SERVICE_LIMITS.maxChoiceChars, `${chars} chars: ${label}`);
    sizes[wording].add(req.options.map((o) => o.label.length).join());
    asked++;
  }
  assert.equal(asked, 400);
  assert.ok(sizes.laya.size > 20 && sizes.kev.size > 20, 'varied trimming in both wordings');
});

test('#1740: the port given the gate\'s limits shapes exactly what readoutOptions shapes, for both questions', { skip: skipWasm }, () => {
  const { SERVICE_LIMITS } = require('../../server/decision-settings.cjs');
  const tool = (name, d) => ({ type: 'function', function: { name, description: d, parameters: { properties: {} } } });
  const offered = new Map([tool('tavily_search', 'Search the web for current facts and news.'), tool('tavily_extract', 'Read the text of a web page from its URL.'),
    tool('diary_read_month', "Read the user's own diary entries for a month."), tool('nc_webdav_search_files', "Find the user's own stored files and documents.")].map((t) => [t.function.name, t]));
  const seen = {};
  for (const wording of ['laya', 'kev']) {
    for (const hint of [null, 'The user framed this chat as a lookup.']) {
      const lim = tg.budgetLimits(SERVICE_LIMITS, tg.questionFor(wording));
      const js = tg.readoutOptions(offered, { boxes: tg.DEFAULT_BOXES, readOnly: () => true, bias: hint ? { hint } : null, limits: lim, wording }).shape();
      const port = davParseWasm.toolGateOptions(tg.offeredProjection(offered, () => true), null, hint, tg.limitsProjection(lim), tg.boxesProjection(tg.DEFAULT_BOXES));
      assert.deepEqual({ trimmed: port.trimmed, options: port.options.map((o) => ({ id: o.id, label: o.label })) }, js, `${wording} ${hint}`);
      seen[`${wording} ${hint ? 'hint' : '-'}`] = Math.max(...js.options.slice(0, -1).map((o) => o.label.length));
    }
  }
  // The longest label: 44 with Laya's question (main), 34 with Kev's (40 characters less over 4 tools).
  assert.equal(seen['laya -'], 44);
  assert.equal(seen['kev -'], 34);
  assert.ok(seen['kev hint'] < seen['laya hint']);
});
