'use strict';

// MCP_SERVERS_IMPL: tests/fixtures/mcp-servers.v1.json (byte-identical to noevia-rs
// crates/mcp-servers/tests/fixtures/; CI compares them) holds mcp-servers.cjs's server lists and
// warnings, box filters and toolboxOffered answers, printed by tools/gen-mcp-servers-fixtures.cjs
// from the JS itself (synthetic URLs and names only). Here every row runs through dav-parse.wasm's
// mcp_servers and through parseMcpServers with the switch on, and must agree, warnings included;
// then seeded live lists, the switch, and the fail-closed paths: a fault or a reply the JS would
// not accept configures no server. The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const mcp = require('../../server/mcp-servers.cjs');

const FILE = path.join(__dirname, '../fixtures/mcp-servers.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-mcp-servers-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

function capture(fn) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try { return { value: fn(), warnings }; } finally { console.warn = warn; }
}

function envOf(row) {
  const env = {};
  if (row.servers !== null) env.MCP_SERVERS = row.servers;
  if (row.url !== null) env.MCP_SERVER_URL = row.url;
  for (const name of row.set) env[name] = 'synthetic-token-value';
  return env;
}

/** parseMcpServers under one setting: the servers and every warning printed. */
const parseWith = (impl, env, opts) => capture(() => mcp.parseMcpServers({ ...env, MCP_SERVERS_IMPL: impl }, opts));

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('parse rows: the same servers and the same warnings through the Rust port', { skip: skipWasm }, () => {
  assert.ok(fixtures.parse.length > 100);
  fixtures.parse.forEach((row, i) => {
    const got = parseWith('wasm', envOf(row));
    assert.deepStrictEqual({ servers: got.value, warnings: got.warnings }, row.want, `row ${i}: ${JSON.stringify(row.servers)} ${JSON.stringify(row.url)}`);
    assert.deepStrictEqual(parseWith('js', envOf(row)).value, row.want.servers, `row ${i} (js)`);
  });
});

test('strict rows: the port refuses and no server is configured', { skip: skipWasm }, () => {
  fixtures.strict.forEach((row, i) => {
    assert.throws(() => davParseWasm.mcpServersParse(row.servers, row.url), { reason: 'ambiguous' }, `row ${i}`);
    const got = parseWith('wasm', envOf(row));
    assert.deepStrictEqual(got.value, [], `row ${i}`);
  });
});

test('box filter and toolboxOffered rows', { skip: skipWasm }, () => {
  fixtures.toolboxes.forEach((row, i) => {
    assert.deepStrictEqual(davParseWasm.mcpToolboxes(row.enabled || null), row.want, `row ${i}`);
    const set = mcp.parseEnabledToolboxes(row.enabled === null ? { MCP_SERVERS_IMPL: 'wasm' } : { ENABLED_TOOLBOXES: row.enabled, MCP_SERVERS_IMPL: 'wasm' });
    assert.deepStrictEqual(set === null ? null : [...set], row.want, `row ${i} (switch)`);
  });
  fixtures.offered.forEach((row, i) => {
    const offered = mcp.createToolboxOffered(row.enabled === null ? null : new Set(row.enabled), { impl: 'wasm' });
    assert.equal(offered(row.id), row.want, `row ${i}`);
  });
});

test('seeded live lists agree, or the port refuses and configures nothing', { skip: skipWasm }, () => {
  let seed = 4242;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % m; };
  const pick = (xs) => xs[rnd(xs.length)];
  const IDS = ['a', 'b', 'nc', 'in', 'A', 'a!', '', 'x'.repeat(45), ' a '];
  const HOSTS = ['h.example', 'H.Example', '127.0.0.1', '127.1', '0x7f.0.0.1', '[::1]', '[::2]', 'localhost', '10.0.0.1', '1.2.3.4', '[0:0:0:0:0:0:0:1]', 'h.example:8080', 'a_b.example', ''];
  const url = () => pick([
    () => `${pick(['http', 'https', 'HTTP', 'ftp', 'ws', 'file'])}:${pick(['//', '///', '\\\\', '', '/'])}${pick(['', 'u@', 'u:p@', ':p@', '@'])}${pick(HOSTS)}${pick(['', '/', '/mcp', '/m?x=1#f', '/a%2F'])}`,
    () => pick(['', 'nope', 'http://', 'http://[::1', 'mailto:x@h.example', 'http://a^b/']),
  ])();
  const auth = () => pick(['', 'none', 'nextcloud', 'internal', 'internal', 'bearer:TOKEN_A', 'bearer:UNSET', 'bearer:x', 'bearer:', 'weird', 'NONE']);
  const entry = () => pick([() => `${pick(IDS)}|${url()}|${auth()}`, () => `${pick(IDS)}|${url()}`, () => pick(IDS), () => ` ${pick(IDS)} | ${url()} | ${auth()} |x`])();
  let refused = 0;
  for (let i = 0; i < 3000; i++) {
    const env = rnd(6)
      ? { MCP_SERVERS: Array.from({ length: 1 + rnd(5) }, entry).join(pick([',', ', ', ' ,'])), TOKEN_A: 'synthetic' }
      : { MCP_SERVER_URL: url() };
    const js = parseWith('js', env);
    const wasm = parseWith('wasm', env);
    let ambiguous = false;
    try { davParseWasm.mcpServersParse(env.MCP_SERVERS || null, env.MCP_SERVER_URL || null); } catch (err) { ambiguous = err.reason === 'ambiguous'; if (!ambiguous) throw err; }
    if (ambiguous) {
      refused++;
      assert.deepStrictEqual(wasm.value, [], `iteration ${i}: a refusal configures nothing`);
      continue;
    }
    assert.deepStrictEqual(wasm, js, `iteration ${i}: ${JSON.stringify(env)}`);
  }
  // Only lists that re-accept an id after a URL drop are refused here (no non-ASCII, no %, no xn--).
  assert.ok(refused < 100, `${refused} refused`);
});

test('MCP_SERVERS_IMPL: default js, wasm by name, anything else js with one warning', () => {
  assert.equal(mcp.mcpServersImpl({}), 'js');
  assert.equal(mcp.mcpServersImpl({ MCP_SERVERS_IMPL: ' WASM ' }), 'wasm');
  const seen = capture(() => [mcp.mcpServersImpl({ MCP_SERVERS_IMPL: 'rust' }), mcp.mcpServersImpl({ MCP_SERVERS_IMPL: 'rust' })]);
  assert.deepStrictEqual(seen.value, ['js', 'js']);
  assert.equal(seen.warnings.length, 1);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('MCP_SERVERS_IMPL'));
  // The JS path never touches the module.
  let loads = 0;
  const loader = () => { loads++; throw new Error('not loaded'); };
  const env = { MCP_SERVERS: 'a|http://h.example|none' };
  assert.deepStrictEqual(capture(() => mcp.parseMcpServers(env, { wasmLoader: loader })).value, [{ id: 'a', url: 'http://h.example', auth: 'none' }]);
  assert.equal(loads, 0);
});

test('fail closed: a missing module, a refusal or a reply the JS would not accept configures nothing', async () => {
  const quiet = (fn) => capture(fn).value;
  const env = { MCP_SERVERS: 'a|http://h.example|none,i|http://127.0.0.1/|internal', MCP_SERVERS_IMPL: 'wasm' };
  const saved = process.env.DAV_PARSE_WASM;
  process.env.DAV_PARSE_WASM = path.join(__dirname, 'no-such-dav-parse.wasm');
  try {
    davParseWasm.reset();
    assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(env)), []);
    assert.deepStrictEqual(quiet(() => mcp.parseEnabledToolboxes({ ENABLED_TOOLBOXES: 'a', MCP_SERVERS_IMPL: 'wasm' })), new Set());
    const offered = quiet(() => mcp.createToolboxOffered(new Set(['a']), { impl: 'wasm' }));
    assert.equal(quiet(() => offered('a')), false);
    // core and dir-* stay offered exactly as the JS offers them, whatever the port does.
    assert.equal(quiet(() => offered('core')), true);
    assert.equal(quiet(() => offered('dir-x')), true);
    assert.throws(() => davParseWasm.verifyAtStartup({ MCP_SERVERS_IMPL: 'wasm', DAV_PARSE_WASM: process.env.DAV_PARSE_WASM }), /MCP_SERVERS_IMPL/);
  } finally {
    if (saved === undefined) delete process.env.DAV_PARSE_WASM; else process.env.DAV_PARSE_WASM = saved;
    davParseWasm.reset();
  }
  // Replies the JS would never give: each one configures nothing.
  const stub = (servers, warnings = []) => ({ wasmLoader: () => ({ mcpServersParse: () => ({ servers, warnings }) }) });
  const bad = [
    [{ id: 'a', url: 'http://u:p@h.example', auth: 'nextcloud' }],
    [{ id: 'a', url: 'ftp://h.example', auth: 'none' }],
    [{ id: 'i', url: 'http://localhost/', auth: 'internal' }],
    [{ id: 'i', url: 'http://127.0.0.1/', auth: 'internal' }, { id: 'j', url: 'http://127.0.0.1/', auth: 'internal' }],
    [{ id: 'a', url: 'http://elsewhere.example', auth: 'nextcloud' }],
    [{ id: 'a b', url: 'http://h.example', auth: 'none' }],
    [{ id: 'a', url: 'http://h.example', auth: 'none' }, { id: 'a', url: 'http://h.example', auth: 'none' }],
    [{ id: 'a', url: 'http://h.example', auth: 'bearer' }],
    [{ id: 'a', url: 'http://h.example', auth: 'root' }],
  ];
  const benv = { MCP_SERVERS: 'a|http://h.example|none,i|http://127.0.0.1/|internal,j|http://localhost/|none', MCP_SERVERS_IMPL: 'wasm' };
  for (const [i, servers] of bad.entries()) assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(benv, stub(servers))), [], `bad reply ${i}`);
  // A good reply passes through, and a bearer warning is printed only when its variable is unset.
  const good = stub([{ id: 'a', url: 'http://h.example', auth: 'bearer', tokenEnv: 'TOK' }], [{ bearer: 'TOK', id: 'a' }]);
  const genv = { ...benv, MCP_SERVERS: 'a|http://h.example|bearer:TOK' };
  const unset = capture(() => mcp.parseMcpServers(genv, good));
  assert.deepStrictEqual(unset.value, [{ id: 'a', url: 'http://h.example', auth: 'bearer', tokenEnv: 'TOK' }]);
  assert.equal(unset.warnings.length, 1);
  assert.equal(capture(() => mcp.parseMcpServers({ ...genv, TOK: 'synthetic' }, good)).warnings.length, 0);
  // The same bearer reply against an operator entry that asked for none is an upgrade: nothing.
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(benv, good)), []);
  // A value that is not a string is a fault, never a guess.
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers({ MCP_SERVERS: 5, MCP_SERVERS_IMPL: 'wasm' }, good)), []);
});

test('list mode binds every returned server to its operator entry, auth included (#1113)', () => {
  const quiet = (fn) => capture(fn).value;
  const stub = (servers) => ({ wasmLoader: () => ({ mcpServersParse: () => ({ servers, warnings: [] }) }) });
  const env = { MCP_SERVERS: ' a | http://h.example | none , b|http://k.example|bearer:TOK_A, c|http://c.example|nextcloud', MCP_SERVERS_IMPL: 'wasm' };
  const honest = [
    { id: 'a', url: 'http://h.example', auth: 'none' },
    { id: 'b', url: 'http://k.example', auth: 'bearer', tokenEnv: 'TOK_A' },
    { id: 'c', url: 'http://c.example', auth: 'nextcloud' },
  ];
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(env, stub(honest))), honest);
  // A dropped server is fine: the port may configure less, never more.
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(env, stub([honest[2]]))), [honest[2]]);
  const forged = [
    [{ id: 'a', url: 'http://h.example', auth: 'nextcloud' }], // none upgraded to the user's password
    [{ id: 'b', url: 'http://k.example', auth: 'bearer', tokenEnv: 'TOK_B' }], // another secret
    [{ id: 'b', url: 'http://k.example', auth: 'none' }], // downgraded
    [{ id: 'a', url: 'http://c.example', auth: 'nextcloud' }], // URL moved to another id
    [{ id: 'x', url: 'http://h.example', auth: 'none' }], // id invented
    [{ id: 'a', url: 'http://h.example', auth: 'none' }, { id: 'c', url: 'http://k.example', auth: 'nextcloud' }],
  ];
  for (const [i, servers] of forged.entries()) assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(env, stub(servers))), [], `forged reply ${i}`);
  // Same id and URL twice: the JS takes the first, so only the first entry's auth binds.
  const twice = { MCP_SERVERS: 'a|http://h.example|none,a|http://h.example|nextcloud', MCP_SERVERS_IMPL: 'wasm' };
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(twice, stub([{ id: 'a', url: 'http://h.example', auth: 'none' }]))), [{ id: 'a', url: 'http://h.example', auth: 'none' }]);
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(twice, stub([{ id: 'a', url: 'http://h.example', auth: 'nextcloud' }]))), []);
  // First wins by id alone: a later same-id entry with another URL cannot be substituted.
  const moved = { MCP_SERVERS: 'a|http://u1/|none,a|http://u2/|nextcloud', MCP_SERVERS_IMPL: 'wasm' };
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(moved, stub([{ id: 'a', url: 'http://u2/', auth: 'nextcloud' }]))), []);
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(moved, stub([{ id: 'a', url: 'http://u1/', auth: 'none' }]))), [{ id: 'a', url: 'http://u1/', auth: 'none' }]);
  // An earlier internal entry is skipped only when an internal server was accepted before it.
  const lone = { MCP_SERVERS: 'a|http://127.0.0.1/|internal,a|http://127.0.0.1/|nextcloud', MCP_SERVERS_IMPL: 'wasm' };
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(lone, stub([{ id: 'a', url: 'http://127.0.0.1/', auth: 'nextcloud' }]))), []);
  const second = { MCP_SERVERS: 'i|http://127.0.0.1:1/|internal,a|http://127.0.0.1:2/|internal,a|http://h.example|none', MCP_SERVERS_IMPL: 'wasm' };
  const dropped = [{ id: 'i', url: 'http://127.0.0.1:1/', auth: 'internal' }, { id: 'a', url: 'http://h.example', auth: 'none' }];
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServersJs(second)), dropped);
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(second, stub(dropped))), dropped);
  // Dropping a server is allowed; what remains must still be the JS's own for each id.
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(second, stub([dropped[1]]))), [dropped[1]]);
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(second, stub([dropped[0], { id: 'a', url: 'http://127.0.0.1:2/', auth: 'internal' }]))), []);
  // The internal-accepted state is the list's, not the reply's: dropping x cannot revive a's internal.
  const revived = { MCP_SERVERS: 'x|http://127.0.0.1:1/|internal,a|http://127.0.0.1:2/|internal', MCP_SERVERS_IMPL: 'wasm' };
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(revived, stub([{ id: 'a', url: 'http://127.0.0.1:2/', auth: 'internal' }]))), []);
  // An entry the JS drops for its URL does not claim the id.
  const badUrl = { MCP_SERVERS: 'a|ftp://x|nextcloud,a|http://h.example|none', MCP_SERVERS_IMPL: 'wasm' };
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(badUrl, stub([{ id: 'a', url: 'http://h.example', auth: 'none' }]))), [{ id: 'a', url: 'http://h.example', auth: 'none' }]);
  // An id is derived as the JS derives it (characters dropped, 40 at most).
  const long = 'q'.repeat(45);
  const derived = { MCP_SERVERS: `a.b!|http://h.example|none,${long}|http://l.example|none`, MCP_SERVERS_IMPL: 'wasm' };
  const ok = [{ id: 'ab', url: 'http://h.example', auth: 'none' }, { id: 'q'.repeat(40), url: 'http://l.example', auth: 'none' }];
  assert.deepStrictEqual(quiet(() => mcp.parseMcpServers(derived, stub(ok))), ok);
});

test('wasm toolboxOffered: core and dir-* survive setup and per-id faults, never asking the port (#1114)', () => {
  const quiet = (fn) => capture(fn).value;
  let calls = 0;
  const throwing = { wasmLoader: () => { calls++; throw Object.assign(new Error('boom'), { reason: 'throws' }); } };
  const perId = quiet(() => mcp.createToolboxOffered(new Set(['a']), { impl: 'wasm', ...throwing }));
  assert.equal(perId('core'), true);
  assert.equal(perId('dir-anything'), true);
  assert.equal(calls, 0);
  assert.equal(quiet(() => perId('a')), false);
  assert.equal(calls, 1);
  // A setup fault (ENABLED_TOOLBOXES not a set of strings) still offers core and dir-*, and nothing else.
  const setup = quiet(() => mcp.createToolboxOffered(new Set([5]), { impl: 'wasm', ...throwing }));
  assert.equal(setup('core'), true);
  assert.equal(setup('dir-x'), true);
  assert.equal(quiet(() => setup('a')), false);
  assert.equal(quiet(() => setup(5)), false);
  assert.equal(calls, 1);
  // Same answers as the JS for core and dir-* under any filter.
  const js = mcp.createToolboxOfferedJs(new Set(['a']));
  for (const id of ['core', 'dir-', 'dir-x']) assert.equal(perId(id), js(id), id);
});

test('reply checks and caps', { skip: skipWasm }, () => {
  assert.throws(() => davParseWasm.mcpServersParse(5, null), { reason: 'input' });
  assert.throws(() => davParseWasm.mcpToolboxOffered(null, 5), { reason: 'input' });
  assert.throws(() => davParseWasm.mcpServersParse('x'.repeat(davParseWasm.MAX_MCP_SERVERS_BYTES), null), { reason: 'too_large' });
  // Within the cap, a long list is answered (and identically).
  const env = { MCP_SERVERS: Array.from({ length: 20000 }, (_, i) => `s${i % 15000}|http://h${i}.example|none`).join(',') };
  assert.deepStrictEqual(parseWith('wasm', env), parseWith('js', env));
});
