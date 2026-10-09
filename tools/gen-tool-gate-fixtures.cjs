#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for TOOL_GATE_IMPL: tool-gate.cjs's Stage 1 rules, Stage 2 option
// shaping and answer reading, and its helpers. The same file is committed byte-for-byte in
// sbstndalton/noevia-rs (crates/tool-gate/tests/fixtures/tool-gate.v1.json); noevia-core CI
// compares them.
//   node tools/gen-tool-gate-fixtures.cjs > tests/fixtures/tool-gate.v1.json
//
// Each row is { op, wire, want } or { op, wire, want, strict: true }: `wire` is the JSON the host
// sends after the op byte (tool-gate.cjs's own projections of real tool objects), `want` the exact
// reply text the port must give. All messages, tools and sites are synthetic; the random ones come
// from a seeded mulberry32.
//
// Nothing recorded depends on ICU or on the dav-parse.wasm module (#1115). The patterns are
// non-Unicode regular expressions (ASCII case folding, ASCII \b, the fixed \s set); the only
// Unicode-table-dependent step is URL host parsing, and every URL the port's answer could depend
// on is ASCII without an xn-- label (a non-ASCII or xn-- URL is never a public pattern to the port,
// whatever this runtime's IDNA says); an IP literal appears only where it is private (isPrivateIp
// is the Rust port and fails closed to private without the module, so the answer is the same
// either way). A row without `strict` is the JS's own answer. A `strict` row is where the port is
// stricter by design (see noevia-rs crates/tool-gate): a URL that is not ASCII, has an xn-- label,
// or names a local host behind more than one trailing dot is required, not prefetched. Its `want`
// is computed here and the generator checks it never forces more than the JS.

const path = require('node:path');
const net = require('node:net');
const tg = require(path.join(__dirname, '..', 'server', 'tool-gate.cjs'));

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x7006a7e);
const pick = (list) => list[Math.floor(rand() * list.length)];

// ── The port's stricter URL rule, mirrored ──────────────────────────────────
const PRIVATE_LITERALS = new Set(['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:7f00:1', '127.0.0.2']);
const LOCAL = /(^|\.)(localhost|local|internal|lan|home\.arpa|intranet|corp)$/i;
let touched = false;
// A URL whose answer could depend on this runtime's IDNA tables: never public to the port, and its
// rows are always marked strict (whatever the JS says here), so the file is the same on every ICU.
const risky = (raw) => /[^\x00-\x7f]/.test(raw) || /xn--/i.test(raw);
function portPublic(raw) {
  if (risky(raw)) { touched = true; return false; }
  const js = tg.publicUrlPattern(raw);
  if (!js) return false;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const bare = host.replace(/\.+$/, '');
  const port = bare !== '' && bare.includes('.') && !LOCAL.test(bare);
  if (!port) touched = true;
  return port;
}
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;
const riskyMessage = (m) => { const u = String(m).match(URL_RE)?.[0]; return !!u && risky(u); };
/** The port's decision: the JS one, with a URL prefetch the port does not take as public required. */
function portDecision(d) {
  if (!d || d.mode !== 'prefetch') return d;
  const url = d.args.url ?? d.args.urls?.[0];
  if (url !== undefined && !portPublic(url)) return { tool: d.tool, mode: 'require' };
  return d;
}
const RANK = { none: 0, require: 1, prefetch: 2 };
const wireDecision = (d) => (d.mode === 'require' ? { tool: d.tool, mode: 'require' } : { tool: d.tool, mode: 'prefetch', args: d.args });

// ── Rows ────────────────────────────────────────────────────────────────────
const rows = [];
const seen = new Set();
function push(op, args, want, strict) {
  const wire = JSON.stringify(args);
  const key = `${op}:${wire}`;
  if (seen.has(key)) return;
  seen.add(key);
  const row = { op, wire, want: JSON.stringify(want) };
  if (strict) row.strict = true;
  rows.push(row);
}

const fn = (name, parameters, description) => ({ type: 'function', function: { name, ...(description === undefined ? {} : { description }), ...(parameters === undefined ? {} : { parameters }) } });
const TOOLS = {
  tavily_extract: fn('tavily_extract', { type: 'object', properties: { urls: { type: 'array' } }, required: ['urls'] }, 'Extract the readable text of web pages.'),
  web_fetch: fn('web_fetch', { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, 'Fetch one web page.'),
  fetch_url: fn('fetch_url', { properties: { url: {}, maxChars: {} } }, '  Fetch\na   URL  '),
  browse: fn('browse', { properties: { target: {} }, required: ['target'] }, 'Open a page in the browser.'),
  tavily_search: fn('tavily_search', { properties: { query: { type: 'string' }, max_results: {} }, required: ['query'] }, 'Search the web.'),
  web_search: fn('web_search', { properties: { q: {} } }, 'Web search'),
  wikipedia_search: fn('wikipedia_search', { properties: { query: {} }, required: ['query', 'lang'] }, 'Wikipedia'),
  diary_read_month: fn('diary_read_month', { properties: { month: { type: 'string' } }, required: ['month'] }, 'Read one month of the diary.'),
  diary_read_today: fn('diary_read_today', { properties: {} }, "Read today's diary entry."),
  diary_list_months: fn('diary_list_months', undefined, 'List diary months.'),
  nc_webdav_search_files: fn('nc_webdav_search_files', { properties: { query: {} } }, 'Search files in Nextcloud.'),
  drive_search_files: fn('drive_search_files', { properties: { q: {} } }, 'Search Drive.'),
  project_search: fn('project_search', { properties: { query: {} } }, 'Search this project.'),
  write_file: fn('write_file', { properties: { path: {}, content: {} } }, 'Write a file.'),
  send_email: fn('send_email', { properties: { to: {} } }, 'Send an email.'),
  calc: fn('calc', { properties: { expr: {} } }, 'Calculator'),
  // Odd shapes the projection must carry exactly.
  url_falsy: fn('web_fetch', { properties: { url: 0 } }, 'url property is falsy'),
  urls_and_url: fn('tavily_extract', { properties: { urls: {}, url: {} }, required: ['url'] }, 'both'),
  no_props: fn('web_fetch', { required: [] }, 'no properties'),
  string_props: fn('web_fetch', { properties: 'abc' }, 'string properties'),
  required_odd: fn('diary_read_month', { properties: { month: {} }, required: ['month', 7] }, 'odd required'),
  required_not_list: fn('diary_read_month', { properties: { month: {} }, required: 'month' }, 'required not a list'),
  month_null: fn('diary_read_month', { properties: { month: null } }, 'month property null'),
  query_extra: fn('tavily_search', { properties: { query: {} }, required: ['query', 'topic'] }, 'needs topic too'),
  long_desc: fn('project_search', { properties: { query: {} } }, 'x'.repeat(400)),
  surrogate_desc: fn('calc', { properties: {} }, `${'y'.repeat(159)}😀 tail`),
  empty_desc: fn('calc', { properties: {} }, ''),
};
const WRITES = new Set(['write_file', 'send_email', 'browse']);
const readOnly = (name) => !WRITES.has(name);
const SETS = [
  ['tavily_extract', 'web_fetch', 'tavily_search', 'diary_read_month', 'nc_webdav_search_files'],
  ['web_fetch', 'web_search', 'diary_read_today'],
  ['fetch_url', 'wikipedia_search', 'diary_list_months', 'drive_search_files'],
  ['browse', 'web_search', 'project_search'],
  ['write_file', 'send_email', 'calc'],
  ['url_falsy', 'query_extra', 'month_null'],
  ['urls_and_url', 'web_search', 'required_odd'],
  ['no_props', 'tavily_search', 'required_not_list'],
  ['string_props', 'diary_read_today'],
  ['calc'],
  [],
  ['web_fetch', 'web_fetch', 'diary_read_month', 'tavily_search', 'project_search', 'nc_webdav_search_files', 'calc', 'long_desc', 'surrogate_desc', 'empty_desc'],
];
const toolsOf = (set) => set.map((k) => TOOLS[k]);
const offeredOf = (tools) => new Map(tools.filter((t) => typeof t?.function?.name === 'string').map((t) => [t.function.name, t]));

const BOXES = [tg.DEFAULT_BOXES,
  { url: ['web_fetch'], search: ['web_search', 'tavily_search'], diary: ['diary_read_today'], drive: [], extra: ['calc'] },
  { search: ['tavily_search', 7, null], url: null, diary: ['diary_read_month'] },
  { drive: ['project_search', 'calc'], url: ['tavily_extract'] }];
const NOWS = [Date.UTC(2026, 8, 15, 12), Date.UTC(2026, 0, 1, 0, 30), Date.UTC(2025, 11, 31, 23), 0, -1, 8.64e15, -8.64e15, Date.UTC(2026, 2, 1), 1.5e12 + 0.75];

const URLS = ['https://example.com/a', 'https://example.com/a.', 'https://example.com/path?q=1#h', 'http://EXAMPLE.org', 'HTTPS://Example.COM/X',
  'https://example.com/a),', 'https://example.com/"quoted"', 'https://example.com/<x>', "https://example.com/it's", 'https://example.com/[x]',
  'http://localhost:3000/', 'http://nas.local/', 'http://nas.local./', 'http://nas.local../', 'http://corp.internal../x', 'http://router.lan/',
  'http://a.home.arpa/', 'http://intranet/', 'http://corp/', 'http://single/', 'http://host.corp./', 'http://../', 'http://./', 'http://a..b.com/',
  'http://127.0.0.1/', 'http://10.0.0.5:8080/', 'http://192.168.1.1/', 'http://[::1]/', 'http://[fe80::1]/', 'http://169.254.169.254/latest',
  'http://0.0.0.0/', 'http://0x7f.1/', 'http://127.1/', 'http://user:pw@example.com/', 'http://user@example.com/', 'http://@example.com/',
  'https://ex%61mple.com/', 'https://exa%2Emple.com/', 'https://xn--exmple-cua.com/', 'https://XN--exmple-cua.com/', 'https://a.xn--p1ai/',
  'https://exämple.com/', 'https://例え.jp/', 'https://example.com/ü', 'https://ex\ud800ample.com/', 'http://example.com:99999/', 'http://exa_mple.com/',
  'http://example.com\\x', 'https://' + 'a.'.repeat(40) + 'example.com/', 'https://example.com/' + 'p'.repeat(2000), 'http://example.com.:80/',
  'http:example.com', 'http://-/', 'https://a-.example.com/', 'https://docs.python.org/3/', 'http://1.2.3.4.5/', 'http://256.0.0.1/', 'http://foo.0x10/'];

const MESSAGES = [
  'hello there', 'What is 2+2?', '', '   ', 'Can you search the web for the latest news on Rust?', 'look up the weather in Paris', 'lookup flights',
  "today's news", 'todays forecast', 'current  price of gold', 'price of bread', 'google it', 'searching for meaning', 'research topics',
  'What did I write in my diary last week?', 'in my diary', 'my Journal', 'Yesterday I went out', 'yesterday i was tired', 'last month I moved',
  'last  week   I', 'diary', 'journaling', 'the diary.', 'what happened on 2026-09-01', '2026-13-01', '2026-09-3', '2026-09-011', '2026-09', '20269-01',
  'x2026-09-01', '2026-09-01x', 'on 3 March', 'on 3rd march', 'March 3', 'march 3rd, 2025', 'March 2024', 'march, 2024', 'may I ask', 'May 5',
  'in May', '12 december', '123 march', 'marching', 'Mar 3', '31st january 2030', 'august 15th', 'june 2099', 'september 9 2001',
  'september  9  ,2001', 'yesterday', 'today', 'TODAY please', 'todayx', 'find my files', 'a file called x', 'the file', 'files', 'folder', 'folders',
  'folderx', 'document named budget', 'google drive', 'my drive', 'nextcloud', 'open my file', 'please read this',
  'please tell me who is the president', "who's there", 'what are you', "what's up", 'show me the news', 'i want to know the latest',
  'hey quickly search for cats', 'hi', 'search the web cats', 'search the webs', 'search for', 'please?!.', 'x?.?!', 'news?!?!..',
  '> quoted news', '  > latest news', 'news\nsecond line', 'news\r', '```news```', '~~~ latest', 'latest '.repeat(20), 'latest ' + 'n'.repeat(130),
  'n'.repeat(119) + ' latest', ' latest news ', 'latest﻿news', 'latest news', 'search　the　web　for　cats',
  'look up', 'news\u0085', 'news᠎', 'news' + '​', 'diary é', 'Ｎｅｗｓ', 'neſws', 'nEwS', 'NEWS', '_news', 'news_', 'news1', '1news',
];
for (const raw of URLS) {
  let host = null;
  try { host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { /* not a URL */ }
  if (host && !risky(raw) && net.isIP(host) && !PRIVATE_LITERALS.has(host)) throw Error(`a public or unlisted IP literal in a fixture: ${raw}`);
}
const withUrls = URLS.flatMap((u) => [`open ${u}`, `${u}`, `read ${u}, then search the news`, `diary ${u}`]);

// op 1: rules.
for (const set of SETS) {
  const tools = toolsOf(set);
  const offered = offeredOf(tools);
  const proj = tg.offeredProjection(offered, readOnly);
  for (const boxes of BOXES) {
    const bp = tg.boxesProjection(boxes);
    for (const message of [...MESSAGES, ...withUrls]) {
      if (rand() < 0.88 && !(set === SETS[0] && boxes === tg.DEFAULT_BOXES)) continue;
      const now = pick(NOWS);
      touched = false;
      const js = tg.ruleDecisionWith(message, offered, { boxes, readOnly, now: () => now });
      const decision = js ? portDecision(js.decision) : null;
      if (js && RANK[decision.mode] > RANK[js.decision.mode]) throw Error('port forces more than the JS');
      const want = js ? { rule: js.rule, decision: wireDecision(decision) } : { rule: null };
      push(1, [message, proj, now, bp], want, touched || riskyMessage(message));
    }
  }
}

// op 2: options.
const LIMITS = [null, { maxOptions: 8, maxLabelChars: 120, maxChoiceChars: 900 }, { maxOptions: 3.7, maxLabelChars: 50.5, maxChoiceChars: 400 },
  { maxOptions: 30, maxLabelChars: 'x', maxChoiceChars: 0 }, { maxOptions: 8, maxLabelChars: 120, maxChoiceChars: 160 }, { maxOptions: 0 },
  { maxOptions: -2 }, { maxOptions: 2, maxLabelChars: Infinity }, { maxOptions: 8, maxLabelChars: 20, maxChoiceChars: -Infinity },
  { maxOptions: '8' }, { maxOptions: Infinity }, { maxOptions: 25, maxLabelChars: 12, maxChoiceChars: 500 }, { maxOptions: 8, maxLabelChars: 0.5 }];
const BIASES = [null, { prefer: ['search'] }, { prefer: ['drive', 'url'], hint: 'The user asked for a web search.' }, { prefer: [] },
  { prefer: 'search' }, { prefer: ['nope', '__proto__', 1] }, { hint: 'h'.repeat(300) }, { hint: '' }, { noForce: true, prefer: ['diary'] }];
const MANY = Array.from({ length: 30 }, (_, i) => fn(`tool_${String(i).padStart(2, '0')}`, { properties: {} }, i % 3 ? `Tool number ${i} does a thing.` : ''));
const OPTION_SETS = [...SETS.map(toolsOf), MANY, [...MANY.slice(0, 5), TOOLS.web_search, TOOLS.tavily_search, TOOLS.project_search]];
for (const tools of OPTION_SETS) {
  const offered = offeredOf(tools);
  const proj = tg.offeredProjection(offered, readOnly);
  for (const limits of LIMITS) for (const bias of BIASES) for (const boxes of BOXES.slice(0, 3)) {
    if (rand() < 0.75 && boxes !== tg.DEFAULT_BOXES) continue;
    const { shape } = tg.readoutOptions(offered, { boxes, readOnly, bias, limits });
    const shaped = shape();
    const prefer = Array.isArray(bias?.prefer) ? bias.prefer.map((k) => (typeof k === 'symbol' ? null : String(k))) : null;
    const hint = typeof bias?.hint === 'string' && bias.hint ? bias.hint : null;
    push(2, [proj, prefer, hint, tg.limitsProjection(limits), tg.boxesProjection(boxes)], { trimmed: shaped.trimmed, options: shaped.options }, false);
  }
}

// op 3: answers.
const RESULTS = [{ selected: 'none', confidence: 0.9 }, { selected: null }, { selected: '' }, { selected: 7 }, { selected: 'missing_tool', confidence: 1 },
  { selected: 'write_file', confidence: 1 }, { selected: 'web_fetch', confidence: 0.9 }, { selected: 'web_fetch', confidence: 0.5 },
  { selected: 'web_fetch', scores: { web_fetch: 0.61 }, confidence: 0.1 }, { selected: 'web_fetch', metadata: { bounds: { web_fetch: [0.59, 0.9] } }, scores: { web_fetch: 0.9 } },
  { selected: 'tavily_search', confidence: 0.95 }, { selected: 'web_search', scores: { web_search: 0.7 } }, { selected: 'diary_read_month', confidence: 0.8 },
  { selected: 'diary_read_today', confidence: 0.8 }, { selected: 'nc_webdav_search_files', confidence: 0.99 }, { selected: 'calc', confidence: 0.99 },
  { selected: 'tavily_extract', metadata: { bounds: { tavily_extract: [NaN, 1] } }, scores: { tavily_extract: Infinity }, confidence: 0.7 },
  { selected: 'project_search', confidence: null }, { selected: 'project_search' }, { selected: 'fetch_url', confidence: 0.6 }, { selected: 'none' }];
const MINS = [0.6, 0, -1, 1, NaN, Infinity, -Infinity, '0.5', null, undefined];
for (const set of SETS) {
  const offered = offeredOf(toolsOf(set));
  const proj = tg.offeredProjection(offered, readOnly);
  for (const result of RESULTS) for (const boxes of BOXES.slice(0, 3)) {
    for (const message of ['read https://example.com/x for me', 'open http://nas.local../', 'what about 3 march', 'latest news', 'hello', 'open https://exämple.com/']) {
      if (rand() < 0.75) continue;
      const min = pick(MINS), now = pick(NOWS);
      touched = false;
      const read = tg.readAnswer(result, message, offered, { boxes, readOnly, now: () => now, minConfidence: min });
      const sel = result.selected;
      const id = typeof sel === 'string' ? sel : null;
      const finite = (v) => (Number.isFinite(v) ? v : null);
      const args = [message, proj, now, tg.boxesProjection(boxes), typeof sel === 'string' ? sel : (sel ? true : null),
        id === null ? null : finite(result?.metadata?.bounds?.[id]?.[0]), id === null ? null : finite(result?.scores?.[id]), finite(result.confidence),
        tg.numberProjection(Number(min))];
      if (!read.decision) { push(3, args, { reason: read.reason }, riskyMessage(message)); continue; }
      const decision = portDecision(read.decision);
      push(3, args, { decision: wireDecision(decision) }, touched || riskyMessage(message));
    }
  }
}

// op 4: queries; op 5: months; op 6: public URL patterns.
const QUERY_MESSAGES = [...MESSAGES, ...withUrls.slice(0, 40), 'please can you could you would you will you for me', 'whats up', 'what  is  love?',
  'who is', 'whois', 'find  out more', 'tell me', 'I WANT TO KNOW', 'search the web', 'search the web for', 'searchthe web', 'look  up', 'lookup',
  'please. ', '?', '...', 'a?b?', 'end with space? ', '\ud800 news', 'hi😀', 'x'.repeat(400)];
for (let i = 0; i < QUERY_MESSAGES.length; i += 25) {
  const batch = QUERY_MESSAGES.slice(i, i + 25);
  push(4, [batch], { queries: batch.map(tg.searchQuery), prefetchable: batch.map(tg.prefetchableSearch) }, false);
}
for (const now of NOWS) {
  const batch = MESSAGES.filter((m) => /\d|diary|yesterday|today|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(m));
  push(5, [batch, now], { months: batch.map((m) => tg.diaryMonth(m, () => now)) }, false);
}
push(5, [['on 3 march', 'yesterday', 'today', '2026-01'], null], { months: ['NaN-03', 'NaN-NaN', 'NaN-NaN', '2026-01'] }, false);
for (let i = 0; i < URLS.length; i += 10) {
  const batch = URLS.slice(i, i + 10);
  touched = false;
  const port = batch.map(portPublic);
  push(6, [batch], { public: port }, touched);
}

const counts = rows.reduce((m, r) => { const k = `${r.op}${r.strict ? 's' : ''}`; m[k] = (m[k] || 0) + 1; return m; }, {});
for (const k of ['1', '1s', '2', '3', '3s', '4', '5', '6', '6s']) if (!counts[k]) throw Error(`no ${k} rows ${JSON.stringify(counts)}`);
const modes = (mode) => rows.filter((r) => r.op === 1 && JSON.parse(r.want).decision?.mode === mode).length;
if (modes('prefetch') < 200 || modes('require') < 200 || rows.filter((r) => r.op === 1 && JSON.parse(r.want).rule === null).length < 200) {
  throw Error(`thin coverage ${JSON.stringify(counts)} prefetch ${modes('prefetch')} require ${modes('require')}`);
}
process.stderr.write(`${JSON.stringify(counts)}\n`);
process.stdout.write(`${JSON.stringify({ version: 1, rows })}\n`);
