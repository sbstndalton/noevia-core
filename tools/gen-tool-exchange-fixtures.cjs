#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for TOOL_EXCHANGE_IMPL: tool-exchange.cjs's checks before a tool
// runs, its canonical-JSON dedupe key and a failed call's text. The same file is committed
// byte-for-byte in sbstndalton/noevia-rs (crates/tool-exchange/tests/fixtures/tool-exchange.v1.json);
// noevia-core CI compares them.
//   node tools/gen-tool-exchange-fixtures.cjs > tests/fixtures/tool-exchange.v1.json
//
// Every expectation is what the JS itself returns (checkCallJs / callErrorJs). All text is
// synthetic. Strings are JSON strings (JSON.stringify writes lone surrogates as \u escapes).
//
// Sections:
//   check: { aborted, allowed, name, args: string|null, want: { key } | { answer } }
//          `args` is what crosses: null for a falsy call.args, else String(call.args)
//   error: { name, message, want }   `message` is String(err?.message || err)
//
// The JS references (retired from production in #1071, so they live with the tests):
//   tests/server/oracle/tool-exchange.cjs

const path = require('node:path');
const server = path.join(__dirname, '..', 'server');
const { checkCallJs, callErrorJs } = require(path.join(__dirname, '..', 'tests', 'server', 'oracle', 'tool-exchange.cjs'));

const ARGS = [undefined, null, '', 0, false, NaN, 5, true, ['{"a":1}'], { toString: () => '{"z":1}' },
  '{}', '[]', 'null', '1', '"s"', 'true', 'false', '{"a":1}', '{"b":2,"a":1}', '{"a":{"d":[3,{"z":1,"y":2}],"c":null},"b":[]}',
  '{"a":1,"a":2}', '{"a":{"x":1},"a":{"y":2}}', '{"__proto__":{"x":1}}', '{"__proto__":null,"constructor":1,"toString":2}',
  '{"n":1.0}', '{"n":-0}', '{"n":-0.0}', '{"n":1e21}', '{"n":1e20}', '{"n":1e-7}', '{"n":0.000001}', '{"n":123456789012345678901234567890}',
  '{"n":0.1}', '{"n":1e400}', '{"n":-1e400}', '{"n":5e-324}', '{"n":2e-324}', '{"n":1.7976931348623157e308}', '{"n":9007199254740993}',
  '{"n":[0.30000000000000004,1E5,1e+5,-12.5e-3,100,1.5e300]}',
  '{"s":"\\u0000\\u001f\\u007f\\u2028\\u2029\\b\\f\\n\\r\\t\\"\\\\\\/"}', '{"s":"\\ud800","t":"\\udc00x","u":"\\ud83d\\ude00","v":"\\ude00\\ud83d"}',
  '{"s":"é😀 "}', '{"\\ud800":1,"\\ud83d\\ude00":2,"～":3,"￿":4}',
  '{"b":1,"a":1,"B":1,"aa":1,"":1,"10":1,"2":1,"-1":1,"1.5":1,"01":1}',
  ' {"a" : 1 } ', '\t\n\r {"a":1}\n', '﻿{}', ' {}', '{"a":1,}', '{a:1}', "{'a':1}", '{"a":01}', '{"a":1.}', '{"a":.5}',
  '{"a":+1}', '{"a":"\t"}', '{"a":"\\x"}', '{"a":"\\u12"}', '{"a":1} x', '{"a":1}{}', '{"a":tru}', '{"a":NaN}', '{"a":Infinity}',
  '{"a":[1,]}', '{"a":1', '"', `${'x'.repeat(199)}😀tail`, `{"x":"${'y'.repeat(250)}`, '\ud800{}', '{"a":"\ud800"}',
  `{"a":${'['.repeat(100)}1${']'.repeat(100)}}`, `${'{"a":'.repeat(100)}1${'}'.repeat(100)}`, '[{"a":1}]', '{"big":"' + 'z'.repeat(5000) + '"}',
];
const NAMES = ['t', 'read_file', 'x"y', '', '\ud800', 'é😀', 'a\\b\n'];

function check() {
  const rows = [];
  const push = (aborted, enabled, name, a) => {
    const call = { name, args: a };
    const allowed = new Set(enabled ? [name] : []);
    const want = checkCallJs(call, allowed, { aborted });
    rows.push({ aborted, allowed: enabled, name, args: a ? String(a) : null, want });
  };
  for (const a of ARGS) push(false, true, 't', a);
  for (const name of NAMES) for (const a of [undefined, '{"b":1,"a":2}', 'x']) for (const aborted of [false, true]) for (const enabled of [false, true]) push(aborted, enabled, name, a);
  return rows;
}

function error() {
  const rows = [];
  const messages = ['', 'boom', 'x'.repeat(400), `${'a'.repeat(299)}😀`, `${'a'.repeat(298)}😀`, '𐏿\ud800', 'line\nbreak', 'é'.repeat(301)];
  // What crosses is the host's String(err?.message || err): an empty message falls back to the error.
  const push = (name, err) => rows.push({ name, message: String(err?.message || err), want: callErrorJs(name, err) });
  for (const name of NAMES) for (const message of messages) push(name, { message });
  for (const err of [Object.assign(new Error(''), { name: 'TypeError' }), 'plain string', 42, null, undefined, { message: 0 }]) push('t', err);
  return rows;
}

process.stdout.write(`${JSON.stringify({ version: 1, check: check(), error: error() })}\n`);
