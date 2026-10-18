'use strict';

// Tool gate (TOOL_GATE_IMPL, retired in #1071: always Rust).
// tests/fixtures/tool-gate.v1.json (byte-identical to noevia-rs crates/tool-gate/tests/fixtures/; CI compares
// them) holds the port's exact replies for synthetic rows, first printed from the former JS rules (a `strict`
// row is one where the port answers more strictly by design: a URL that is not ASCII or has an xn-- label is
// required, not prefetched). tests/fixtures/tool-gate-js.v1.json freezes what the old tool-gate.cjs answered:
//   - `cases`: 4000 seeded synthetic requests (messages, offered tools of odd shapes, custom boxes, bias,
//     limits, wordings, a decision service that answers, falls back, throws or says nothing), each with the
//     answer of the JS alone (`js`) and of the live composition (`live`, TOOL_GATE_IMPL=wasm: the stricter
//     of the JS and the port, which is what ran);
//   - `stage2`: the 400 seeded service-limit cases of the former differential test (the request sent);
//   - `shapes`: the JS option shaping for both wordings;
//   - `sweep`: the JS patterns for every UTF-16 code unit as batch hashes.
// Both files are frozen and sha256-pinned: the JS rules and their generator are gone, and neither may be
// regenerated through the Rust path (that would erase the independent reference). Provenance (also in the
// frozen file's `note`): frozen from noevia-core at 2e0f70d with the dav-parse.wasm that server/dav-parse.lock
// pins present (the freeze must have the module: isPrivateIp fails closed without it).
// Here the gate, which now applies the port's answer alone, must give for every frozen case exactly the answer
// the live composition gave (so nothing is weaker than live), and never force more than the JS alone did. What
// is counted below: how many cases the JS and live differ on (all of them live being stricter), how many the
// port faults on (nothing forced), how many the decision service is asked. The patterns are non-Unicode regular
// expressions, so the port's reading is checked for every UTF-16 code unit against the frozen JS answers; so it
// holds on the shipped Node too. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM);
// skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isDeepStrictEqual } = require('node:util');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const tg = require('../../server/tool-gate.cjs');
const { SERVICE_LIMITS } = require('../../server/decision-settings.cjs');

const FILE = path.join(__dirname, '../fixtures/tool-gate.v1.json');
const FROZEN_FILE = path.join(__dirname, '../fixtures/tool-gate-js.v1.json');
// The frozen references are pinned: changing either is a deliberate act that also changes these.
const PINS = { [FILE]: 'a3aa82bfd5d579890348c7a6643e30237889a81b45d0f970a416b413c6d59558', [FROZEN_FILE]: '3e4a1fa8621efbaebc2cae65211735b2cdf32ab4dc7d835cc7e263603be94bea' };
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const FROZEN = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const RANK = { none: 0, require: 1, prefetch: 2 };
const modeOf = (d) => (d === 'none' ? 'none' : d.mode);
// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the
// body never runs and the test reports ok): when the module is there, every guarded body must have run.
let ran = 0;
test.after(() => { if (!skipWasm) assert.equal(ran, 7, 'a wasm-guarded test body did not run'); });

async function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');

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
function gateFor(projection, boxes, now, decide = async () => ({ source: 'fallback' })) {
  const writes = new Set(projection.filter((t) => !t.readOnly).map((t) => t.name));
  return tg.createToolGate({ enabled: () => true, isWriteTool: (n) => writes.has(n), now: () => now ?? NaN, boxes, decide, unavailable: () => null, log: () => {}, warn: () => {} });
}

test('the shared fixture and the frozen JS answers are the pinned files', () => {
  for (const [file, pin] of Object.entries(PINS)) assert.equal(sha(fs.readFileSync(file)), pin, path.basename(file));
  assert.equal(FROZEN.cases.length, 4000);
  assert.equal(FROZEN.stage2.length, 400);
  assert.ok(fixtures.rows.length >= 4000);
});

test('fixture rows: the exact reply; the whole gate forces what the port\'s rule answer says', { skip: skipWasm }, async () => {
  ran++;
  let strict = 0, gated = 0;
  for (const [i, row] of fixtures.rows.entries()) {
    const args = JSON.parse(row.wire);
    const want = JSON.parse(row.want);
    assert.deepEqual(CALLS[row.op](args), want, `row ${i}`);
    if (row.strict) strict++;
    if (row.op !== 1 || i % 3) continue; // a third of the rule rows through the whole gate
    const [message, projection, now, pairs] = args;
    const tools = toolsFrom(projection);
    const sw = await gateFor(projection, boxesFrom(pairs), now).evaluate(message, tools);
    gated++;
    if (want.rule === null) {
      assert.equal(sw.decision, 'none', `row ${i}`); // no rule: the service falls back
      assert.equal(sw.source, 'none');
    } else {
      assert.deepEqual(sw.decision, want.decision, `row ${i}`);
      assert.equal(sw.source, 'rule');
    }
  }
  assert.ok(strict > 100, `${strict} strict rows`);
  assert.ok(gated > 500, `${gated} rows through the gate`);
});

const num = (v) => (v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v);
const resolveAnswer = (a) => {
  if (a.kind !== 'answer') return a;
  const v = { ...a.value };
  if ('confidence' in v) v.confidence = num(v.confidence);
  if (v.scores) v.scores = Object.fromEntries(Object.entries(v.scores).map(([k, x]) => [k, num(x)]));
  if (v.bounds) { v.metadata = { bounds: Object.fromEntries(Object.entries(v.bounds).map(([k, x]) => [k, x.map(num)])) }; delete v.bounds; }
  return v;
};
async function runFrozen(c) {
  const logs = [], requests = [];
  const writes = new Set(c.writes);
  const resolved = resolveAnswer(c.answer);
  const gate = tg.createToolGate({
    enabled: () => true, isWriteTool: (n) => writes.has(n), now: () => num(c.now), boxes: c.boxes === null ? undefined : c.boxes,
    limits: c.limits === 'service' ? () => SERVICE_LIMITS : c.limits, wording: c.wording, minConfidence: c.min === undefined ? undefined : num(c.min),
    unavailable: () => c.unavailable, deadlineMs: 50, log: (e) => logs.push(e), warn: () => {},
    decide: async (request) => {
      requests.push(request);
      if (resolved.kind === 'throw') throw new Error('synthetic fault');
      if (resolved.kind === 'fallback') return { source: 'fallback', metadata: { fellBack: 'timeout', cause: 'deadline' } };
      if (resolved.kind === 'null') return null;
      return resolved;
    },
  });
  const out = await quietly(() => gate.evaluate(c.message, c.tools, c.bias));
  const log = logs.find((e) => e.event === 'decision') || {};
  return { d: out.decision, s: out.source, c: typeof out.confidence === 'number' ? out.confidence : null, r: log.reason ?? null, ru: log.rule ?? null,
    q: requests.length ? sha(JSON.stringify([requests[0].question, requests[0].options])).slice(0, 16) : null, o: log.options ?? null, t: log.trimmed ?? null };
}

test('frozen cases: the gate gives exactly what the live composition gave, and never forces more than the JS alone', { skip: skipWasm }, async () => {
  ran++;
  const count = { total: 0, sameAsJs: 0, stricterThanJs: 0, forced: 0, fault: 0, asked: 0, rule: 0, decision: 0, restated: 0, errored: 0, errorSame: 0 };
  for (const { i, in: c, js, live } of FROZEN.cases) {
    const now = await runFrozen(c);
    const label = `case ${i}: ${JSON.stringify(c.message).slice(0, 120)}`;
    // The decision, its source, the confidence reported, the question and options sent, how many.
    assert.deepEqual(now.d, live.d, label);
    assert.equal(now.s, live.s, label);
    assert.equal(now.c, live.c, label);
    assert.equal(now.q, live.q, label);
    assert.equal(now.o, live.o, label);
    assert.equal(now.t, live.t, label);
    // The rule logged: the same, except after a fault, where the live composition still named the rule its JS had matched.
    if (live.r === 'impl-fault') assert.equal(now.ru, null, label); else assert.equal(now.ru, live.ru, label);
    // The reason logged: the same, except that a rule the port made stricter is no longer logged as such, and the
    // port-only faults are the same fault reason.
    if (live.r === 'impl-stricter') { count.restated++; assert.equal(now.r, null, label); }
    else if (live.r === 'error') { count.errored++; if (now.r === 'error') count.errorSame++; else assert.equal(now.r, 'impl-fault', label); assert.equal(now.d, 'none', label); } // an exception of the JS: nothing is forced; the port path names it a fault
    else assert.equal(now.r, live.r, label);
    assert.notEqual(live.r, 'impl-mismatch', label);
    // Nothing is weaker than the JS alone: not more forced, the same tool, the same arguments when prefetched.
    assert.ok(RANK[modeOf(now.d)] <= RANK[modeOf(js.d)], label);
    if (now.d !== 'none') {
      assert.equal(now.d.tool, js.d.tool, label);
      if (now.d.mode === 'prefetch') assert.deepEqual(now.d.args, js.d.args, label);
    }
    count.total++;
    if (isDeepStrictEqual(now.d, js.d)) count.sameAsJs++; else count.stricterThanJs++;
    if (now.d !== 'none') count.forced++;
    if (now.r === 'impl-fault') count.fault++;
    if (now.q) count.asked++;
    if (now.s === 'rule') count.rule++;
    if (now.s === 'decision') count.decision++;
  }
  assert.deepEqual(count, { total: 4000, sameAsJs: 3978, stricterThanJs: 22, forced: 1700, fault: 101, asked: 1140, rule: 1590, decision: 110, restated: 10, errored: 56, errorSame: 37 });
});

// The frozen JS alone, case by case: where the live composition (and so the gate) is stricter than it, it is only
// ever the by-design URL rule or a request the port could not read (nothing forced), and never the other way.
test('frozen cases: where the JS alone and the gate differ, the gate is the stricter one', { skip: skipWasm }, () => {
  ran++;
  let urlStricter = 0, faulted = 0, other = 0;
  for (const { i, js, live } of FROZEN.cases) {
    if (isDeepStrictEqual(js.d, live.d)) continue;
    assert.ok(RANK[modeOf(live.d)] < RANK[modeOf(js.d)] || (live.d !== 'none' && js.d !== 'none' && live.d.mode === 'require' && js.d.mode === 'prefetch'), `case ${i}`);
    if (live.r === 'impl-stricter') urlStricter++; else if (live.r === 'impl-fault') faulted++; else other++;
  }
  assert.deepEqual({ urlStricter, faulted, other }, { urlStricter: 10, faulted: 12, other: 0 });
});

test('every UTF-16 code unit: \\s, \\b, /i and the URL stop set read as the former JS read them (frozen answers)', { skip: skipWasm }, () => {
  ran++;
  const units = Array.from({ length: 0x10000 }, (_, c) => String.fromCharCode(c));
  const { batches, urlAscii, urlRuns } = FROZEN.sweep;
  for (let start = 0, b = 0; start < units.length; start += 4096, b++) {
    const batch = units.slice(start, start + 4096);
    // searchQuery: whitespace collapsing and trimming, FILLER_RE's \s+, \s* and \b, /i folding.
    const messages = batch.map((c) => `${c}look${c}up${c}please${c}NEWS${c}x${c}?`);
    const q = davParseWasm.toolGateQueries(messages);
    assert.equal(sha(q.queries), batches.queries[b], `queries from U+${start.toString(16)}`);
    assert.equal(sha(q.prefetchable), batches.prefetchable[b], `prefetchable from U+${start.toString(16)}`);
    // NAMED_DATE_RE: \d, \s+, \b and month-name folding next to each unit.
    const dates = batch.map((c) => `on 3${c}March${c}2024 ${c}may${c}5`);
    assert.equal(sha(davParseWasm.toolGateMonths(dates, 0).months), batches.months[b], `months from U+${start.toString(16)}`);
  }
  // The rule stage: SEARCH_RE/DIARY_RE/DRIVE_RE boundaries and the URL pattern's [^\s<>"')\]] next to each unit.
  const offered = new Map([['web_fetch', { type: 'function', function: { name: 'web_fetch', parameters: { properties: { url: {} } } } }],
    ['tavily_search', { type: 'function', function: { name: 'tavily_search', parameters: { properties: { query: {} } } } }],
    ['project_search', { type: 'function', function: { name: 'project_search', parameters: { properties: { query: {} } } } }]]);
  const proj = tg.offeredProjection(offered, () => true);
  const boxes = tg.boxesProjection(tg.DEFAULT_BOXES);
  const rule = (message) => davParseWasm.toolGateRule(message, proj, 0, boxes);
  const per = [];
  let run = 0;
  for (let c = 0; c < 0x10000; c++) {
    const u = units[c];
    const port = rule(`see https://example.com/a${u}b`);
    if (c < 0x80) assert.deepEqual(port, urlAscii[c], `U+${c.toString(16)}`);
    else {
      // A non-ASCII unit inside the URL: never more than the JS (required, not prefetched), the same tool and arguments.
      while (urlRuns[run][1] < c) run++;
      const [, , [tool, mode, urlLength]] = urlRuns[run];
      assert.equal(port.rule, 'url');
      assert.equal(port.decision.tool, tool, `U+${c.toString(16)}`);
      assert.ok(RANK[port.decision.mode] <= RANK[mode], `U+${c.toString(16)}`);
      if (port.decision.mode === 'prefetch') assert.equal((port.decision.args.url ?? port.decision.args.urls[0]).length, urlLength);
    }
    per.push([rule(`${u}news${u}`), rule(`my${u}files`)]);
    if ((c + 1) % 4096 === 0) { assert.equal(sha(per), batches.rule2[(c + 1) / 4096 - 1], `rules up to U+${c.toString(16)}`); per.length = 0; }
  }
});

test('a long adversarial message is linear (the JS strip was quadratic)', { skip: skipWasm }, () => {
  ran++;
  const tools = [{ type: 'function', function: { name: 'web_fetch', parameters: { properties: { url: {} } } } }];
  const message = `see http://a.com/${'.,'.repeat(150_000)}x`;
  const portStart = Date.now();
  const port = davParseWasm.toolGateRule(message, tg.offeredProjection(new Map([['web_fetch', tools[0]]]), () => true), 0, tg.boxesProjection(tg.DEFAULT_BOXES));
  // Shared runners: loose. The JS path on the same message took tens of seconds.
  assert.ok(Date.now() - portStart < 10_000);
  assert.equal(port.decision.mode, 'prefetch');
});

// #1740: the lowered choice budget (#1639) is exercised through the gate itself: service limits from
// decision-settings (SERVICE_LIMITS, what production passes as `limits`), a frame hint, and both wordings. The
// request the former gate sent is frozen (its hash and option count), and the gate still sends exactly it.
test('#1740: service limits plus a hint, both wordings: the request sent is the one the JS gate sent, within the budget', { skip: skipWasm }, async () => {
  ran++;
  const sizes = { laya: new Set(), kev: new Set() };
  for (const [n, f] of FROZEN.stage2.entries()) {
    const tools = f.names.map((name) => ({ type: 'function', function: { name, description: `${name} reads synthetic data. `.repeat(f.rep), parameters: { properties: {} } } }));
    const requests = [];
    const gate = tg.createToolGate({ enabled: () => true, isWriteTool: () => false, now: () => 0, boxes: tg.DEFAULT_BOXES, unavailable: () => null,
      limits: () => SERVICE_LIMITS, wording: f.wording, log: () => {}, warn: () => {},
      decide: async (r) => { requests.push(r); return { selected: f.selected, scores: { [f.selected]: 0.9 }, confidence: 0.9 }; } });
    // A message no rule answers, so Stage 2 runs.
    const out = await quietly(() => gate.evaluate('Please take care of the synthetic thing', tools, f.bias));
    const label = JSON.stringify({ n, wording: f.wording, names: f.names });
    assert.equal(requests.length, 1, label);
    assert.equal(sha(JSON.stringify(requests[0])).slice(0, 16), f.q, label);
    assert.equal(requests[0].options.length, f.n, label);
    assert.deepEqual(out.decision, f.d, label);
    const req = requests[0];
    assert.equal(req.question.startsWith(tg.questionFor(f.wording)), true, label);
    const chars = req.question.length + req.options.reduce((s, o) => s + o.id.length + o.label.length + 2, 0);
    assert.ok(chars <= SERVICE_LIMITS.maxChoiceChars, `${chars} chars: ${label}`);
    sizes[f.wording].add(req.options.map((o) => o.label.length).join());
  }
  assert.ok(sizes.laya.size > 20 && sizes.kev.size > 20, 'varied trimming in both wordings');
});

test('#1740: the port given the gate\'s limits shapes exactly what the JS shaped, for both questions', { skip: skipWasm }, () => {
  ran++;
  const tool = (name, d) => ({ type: 'function', function: { name, description: d, parameters: { properties: {} } } });
  const offered = new Map([tool('tavily_search', 'Search the web for current facts and news.'), tool('tavily_extract', 'Read the text of a web page from its URL.'),
    tool('diary_read_month', "Read the user's own diary entries for a month."), tool('nc_webdav_search_files', "Find the user's own stored files and documents.")].map((t) => [t.function.name, t]));
  const seen = {};
  for (const wording of ['laya', 'kev']) {
    for (const hint of [null, 'The user framed this chat as a lookup.']) {
      const lim = tg.budgetLimits(SERVICE_LIMITS, tg.questionFor(wording));
      const port = davParseWasm.toolGateOptions(tg.offeredProjection(offered, () => true), null, hint, tg.limitsProjection(lim), tg.boxesProjection(tg.DEFAULT_BOXES));
      const got = { trimmed: port.trimmed, options: port.options.map((o) => ({ id: o.id, label: o.label })) };
      assert.deepEqual(got, FROZEN.shapes[`${wording} ${hint ? 'hint' : '-'}`], `${wording} ${hint}`);
      seen[`${wording} ${hint ? 'hint' : '-'}`] = Math.max(...got.options.slice(0, -1).map((o) => o.label.length));
    }
  }
  // The longest label: 44 with Laya's question (main), 34 with Kev's (40 characters less over 4 tools).
  assert.equal(seen['laya -'], 44);
  assert.equal(seen['kev -'], 34);
  assert.ok(seen['kev hint'] < seen['laya hint']);
});

test('the frozen file records its provenance: the freeze script and the module it was frozen with', () => {
  assert.match(FROZEN.note, /freeze script \(sha256 [0-9a-f]{64}\)/);
  assert.match(FROZEN.note, /dav-parse\.wasm that server\/dav-parse\.lock pins \(sha256 [0-9a-f]{64}\)/);
  assert.equal(FROZEN.seed, 0x1071a);
});
