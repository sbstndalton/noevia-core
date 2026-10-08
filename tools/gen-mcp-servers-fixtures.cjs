#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for MCP_SERVERS_IMPL: mcp-servers.cjs's server list, curated-box
// filter and toolboxOffered. The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/mcp-servers/tests/fixtures/mcp-servers.v1.json); noevia-core CI compares them.
//   node tools/gen-mcp-servers-fixtures.cjs > tests/fixtures/mcp-servers.v1.json
//
// Every expectation is what the JS itself returns (parseMcpServersJs and friends) and the warnings
// it prints, in order. All URLs, ids and token names are synthetic; token values never appear.
//
// Sections:
//   parse:     { servers, url, set, wire, want: { servers, warnings } }
//              servers/url: MCP_SERVERS / MCP_SERVER_URL (string or null); set: the token variable
//              names that are set; wire: the JSON body that crosses (op 1)
//   strict:    { servers, url, set, wire, want }  rows the port refuses as ambiguous (see the
//              mcp-servers crate docs). Rows whose JS answer depends on the Node/ICU version (an
//              xn-- label, '%' or a non-ASCII character in the host; #1115) record no JS answer:
//              want is { refused: 'ambiguous' }. The other rows keep the JS's answer, for the record
//   toolboxes: { enabled, wire, want: null | [ids] }
//   offered:   { enabled: null | [ids], id, wire, want: bool }

const path = require('node:path');
const server = path.join(__dirname, '..', 'server');
const { parseMcpServersJs, parseEnabledToolboxesJs, createToolboxOfferedJs } = require(path.join(server, 'mcp-servers.cjs'));

function capture(fn) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try { return { value: fn(), warnings }; } finally { console.warn = warn; }
}

function parseRow(servers, url, set = []) {
  const env = {};
  if (servers !== null) env.MCP_SERVERS = servers;
  if (url !== null) env.MCP_SERVER_URL = url;
  for (const name of set) env[name] = 'synthetic-token-value';
  const { value, warnings } = capture(() => parseMcpServersJs(env));
  return { servers, url, set, wire: JSON.stringify([servers || null, url || null]), want: { servers: value, warnings } };
}

const ONE = [
  'a|http://h.example/mcp|none', 'a|https://h.example:8443/x?y=1#z|nextcloud', 'a|http://h.example|', 'a|http://h.example',
  'a|HTTP://H.EXAMPLE/|none', 'a|http:h.example|none', 'a|http:\\\\h.example\\x|none', 'a|http:///h.example|none',
  'a|ftp://h.example/|none', 'a|file:///etc/passwd|none', 'a|javascript:alert(1)|none', 'a|mailto:x@h.example|none', 'a|data:text/plain,x|none',
  'a|ws://h.example/|none', 'a|h.example/mcp|none', 'a|//h.example/|none', 'a|http://|none', 'a|http://[::1|none', 'a|http://a^b/|none',
  'a|http://user@h.example/|nextcloud', 'a|http://user:pw@h.example/|nextcloud', 'a|http://:pw@h.example/|none', 'a|http://@h.example/|none',
  'a|http://:@h.example/|none', 'a|http://h.example/@x|none', 'a|http://h.example:99999/|none', 'a|http://h.example:0/|none',
  'a|http://1.2.3.4/|none', 'a|http://0x7f.1/|none', 'a|http://[fe80::1]/|none', 'a|http://h.example/%2F|none',
  'a|http://127.0.0.1/|internal', 'a|http://127.0.0.1:8099/mcp|internal', 'a|http://127.1/|internal', 'a|http://0x7f000001/|internal',
  'a|http://2130706433/|internal', 'a|http://127.255.255.255/|internal', 'a|http://[::1]:9/|internal', 'a|http://[0:0:0:0:0:0:0:1]/|internal',
  'a|http://[::ffff:127.0.0.1]/|internal', 'a|http://localhost/|internal', 'a|http://LOCALHOST:9/|internal', 'a|http://128.0.0.1/|internal',
  'a|http://10.0.0.1/|internal', 'a|http://127.0.0.1.nip.example/|internal', 'a|https://127.0.0.1/|internal', 'a|ftp://127.0.0.1/|internal',
  'a|http://h.example|bearer:TOKEN_A', 'a|http://h.example|bearer:UNSET_B', 'a|http://h.example|bearer: TOKEN_A ', 'a|http://h.example|bearer:',
  'a|http://h.example|bearer:lower', 'a|http://h.example|bearer:A-B', 'a|http://h.example|bearer:A B', 'a|http://h.example|bearer:__proto__',
  'a|http://h.example|Bearer:TOKEN_A', 'a|http://h.example|bearer', 'a|http://h.example|NONE', 'a|http://h.example|Nextcloud', 'a|http://h.example|weird',
  'a|http://h.example|none|extra', 'a|http://h.example|nextcloud|x|y', '|http://h.example|none', 'a||none', 'a', '!!!|http://h.example|none',
  'a.b/c d|http://h.example|none', `${'x'.repeat(50)}|http://h.example|none`, '\u00e9-\u00e9_\u00e9|http://h.example|none', '\u00a0a\u00a0|\u00a0http://h.example\u00a0|\u00a0none\u00a0',
  '\ufeffa\ufeff|\ufeffhttp://h.example\ufeff|\ufeffnone', '\u0085a|http://h.example|none', ' a | http://h.example | none ', 'a\ud800|http://h.example|none',
  '\ud800|http://h.example|none', 'a|http://h.example|\ud800',
];
const LISTS = [
  '', '   ', ',', ' , , ', ...ONE,
  'a|http://h1.example|none,a|http://h2.example|nextcloud',
  'a|http://h1.example|none, b|http://h2.example|nextcloud, c|http://127.0.0.1/|internal, d|http://h4.example|bearer:TOKEN_A',
  'i1|http://127.0.0.1/|internal,i2|http://127.0.0.2/|internal',
  'i1|http://127.0.0.1/|internal,i1|http://127.0.0.2/|internal',
  'x|http://h.example|none,X|http://h.example|none',
  `${'y'.repeat(40)}a|http://h1.example|none,${'y'.repeat(40)}b|http://h2.example|none`,
  'a||none,a|http://h.example|none',
  'a!|http://h1.example|none,a|http://h2.example|none',
  'a|ftp://h.example|none,b|http://h.example|none',
  'b|http://localhost/|internal,c|http://h.example|none',
  'a|http://h.example|bearer:TOKEN_A,b|http://h.example|bearer:UNSET_B,c|http://h.example|bearer:TOKEN_A',
  'a|http://h.example|none,,b|http://h.example|none,',
  'a|http://h.example|none\n,\tb|http://h.example|none\r\n',
  '\u2028a|http://h.example|none\u2029',
];

function parse() {
  const rows = [];
  for (const list of LISTS) rows.push(parseRow(list, null, ['TOKEN_A']));
  for (const [list, set] of [['a|http://h.example|bearer:TOKEN_A', []], ['a|http://h.example|bearer:UNSET_B', ['UNSET_B']]]) rows.push(parseRow(list, null, set));
  // MCP_SERVER_URL: only when MCP_SERVERS is unset or blank.
  for (const url of ['', '  ', 'http://nc.example/mcp', ' https://nc.example ', 'http://u:p@nc.example/', 'ftp://nc.example/', 'notaurl',
    'http://127.0.0.1/', '\u00a0http://nc.example\u00a0']) {
    rows.push(parseRow(null, url));
    rows.push(parseRow('   ', url));
  }
  rows.push(parseRow('a|http://h.example|none', 'http://nc.example/mcp'));
  rows.push(parseRow(null, null));
  return rows;
}

// A host with an xn-- label (any case), '%' or non-ASCII: what the JS makes of it varies by Node.
const hostDependsOnNode = (list) => /^[^|]*\|[a-z]+:\/\/[^/|]*(xn--|%|[^\x00-\x7f])/i.test(list);
function refused(row) { return { ...row, want: { refused: 'ambiguous' } }; }

function strict() {
  const single = ['not a url', 'http://nc.example/a b'].map((url) => parseRow(null, url));
  return single.concat([
    'a|http://h.example/a b|none',
    'a|http://ex\u00e4mple.example/|none', 'a|http://h.example/\u00e9|none', 'a|http://xn--exmple-cua.example/|none', 'a|http://XN--a.example/|none',
    'a|http://%68.example/|none', 'a|http://h.example\t/|none', 'a|http://h.example/\u0000|none',
    'a|ftp://h1.example|none,a|http://h2.example|none', 'a|http://u@h1.example|none,a|http://h2.example|nextcloud',
    'i1|http://localhost/|internal,i2|http://127.0.0.1/|internal',
  ].map((list) => (hostDependsOnNode(list) ? refused(parseRow(list, null)) : parseRow(list, null))));
}

function toolboxes() {
  return [null, '', ' ', ',', ' , ,', 'web-search', ' web-search , cookbook ', 'a,b,a,c,b', 'a,,b', '\u00a0a\u00a0,\ufeffb', '\u00e9,\ud83d\ude00,\ud800', 'core,dir-x']
    .map((enabled) => {
      const set = parseEnabledToolboxesJs(enabled === null ? {} : { ENABLED_TOOLBOXES: enabled });
      return { enabled, wire: JSON.stringify(enabled || null), want: set === null ? null : [...set] };
    });
}

function offered() {
  const rows = [];
  for (const enabled of [null, ['web-search'], ['a', 'b'], ['dir-x'], ['\u00e9']]) {
    const fn = createToolboxOfferedJs(enabled === null ? null : new Set(enabled));
    for (const id of ['core', 'Core', 'dir-', 'dir-anything', 'dir', 'web-search', 'a', 'b', 'c', '', '\u00e9', ' a']) {
      rows.push({ enabled, id, wire: JSON.stringify([enabled, id]), want: fn(id) });
    }
  }
  return rows;
}

process.stdout.write(`${JSON.stringify({ version: 1, parse: parse(), strict: strict(), toolboxes: toolboxes(), offered: offered() })}\n`);
