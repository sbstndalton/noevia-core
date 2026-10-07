#!/usr/bin/env node
'use strict';
// Regenerates the shared differential fixtures for the code sandbox bridge's untrusted-input rules
// (#999). Expectations come from the JS references: code-sandbox/pi-acp-bridge.cjs lines() and
// toolCallFor(), code-sandbox/supervisor.cjs parseStartJs() and containedJs(). The same file is
// committed byte-for-byte in sbstndalton/noevia-rs (crates/sandbox-bridge/tests/fixtures/
// sandbox-bridge.v1.json); noevia-core CI compares them.
//   node tools/gen-sandbox-bridge-fixtures.cjs > tests/fixtures/sandbox-bridge.v1.json
// Every command, path and name below is made up. No real prompts, code or workspace content.
//
// Shapes:
//   frame:     { name, limit, chunks: [text], expect: [{ lines: [text] } | { overflow: units }] }
//              `lines` are the exact line texts JS handed to JSON.parse and then to onLine.
//   toolCall:  { name, payload: JSON text, expect: { json: JSON.stringify(toolCallFor(payload)) }
//                                                 | { error: 'type_error' | 'range_error' } }
//   start:     { name, line, expect: JSON.stringify(parseStartJs(line)) }
//   contained: { name, root, resolved, expect: { contained, rel: path.relative(root, resolved) } }

const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { lines, toolCallFor } = require('../code-sandbox/pi-acp-bridge.cjs');
const { parseStartJs, containedJs } = require('../code-sandbox/supervisor.cjs');

let seed = 0x999;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (n) => Math.floor(rand() * n);

/** Run JS lines() over `chunks`, recording the exact text of every line it parsed and delivered. */
function runFrame(limit, chunks) {
  const realParse = JSON.parse;
  let last = null;
  const events = [];
  JSON.parse = function parse(text, reviver) { const v = realParse.call(JSON, text, reviver); last = text; return v; };
  try {
    const push = lines(() => events[events.length - 1].lines.push(last), (size) => { events[events.length - 1] = { overflow: size }; }, limit);
    for (const chunk of chunks) { events.push({ lines: [] }); push(chunk); }
  } finally { JSON.parse = realParse; }
  return events;
}

function frameCases() {
  const cases = [];
  const add = (name, chunks, limit = 16 * 1024 * 1024) => cases.push({ name, limit, chunks, expect: runFrame(limit, chunks) });
  const ev = (o) => JSON.stringify(o);
  // ── framing ──
  add('one message', [ev({ type: 'agent_settled' }) + '\n']);
  add('two in one chunk', [ev({ a: 1 }) + '\n' + ev({ b: 2 }) + '\n']);
  add('partial line across chunks', ['{"type":"mess', 'age_update","x":', '1}\n']);
  add('no newline yet', ['{"a":1}']);
  add('newline arrives alone', ['{"a":1}', '\n']);
  add('CRLF', ['{"a":1}\r\n{"b":2}\r\n']);
  add('only one CR stripped', ['{"a":1}\r\r\n']);
  add('CR inside a line', ['{"a":\r1}\n']);
  add('CR then LF across chunks', ['{"a":1}\r', '\n']);
  add('bare CR is not a line end', ['{"a":1}\r{"b":2}\n']);
  add('empty lines', ['\n\n\r\n{"a":1}\n\n']);
  add('whitespace-only lines', [' \t \n\u00a0\n\u3000\n\ufeff\n\u2028\n\u0085\n{"ok":true}\n']);
  add('invalid JSON skipped', ['nope\n{"a":1}\n{bad}\n[1,]\n{"b":2}\n']);
  add('JSON primitives', ['1\n"s"\nnull\ntrue\nfalse\n-0\n[]\n{}\n']);
  add('numbers', ['[1.0, 1e400, -1e400, 0.1e-999, 123456789012345678901234567890, 5e-324, 1E+2]\n', '01\n', '+1\n', '.5\n', '1.\n', '-\n']);
  add('duplicate keys and __proto__', ['{"type":"a","type":"b","__proto__":{"x":1},"constructor":2}\n']);
  add('BOM before JSON is not whitespace', ['\ufeff{"a":1}\n']);
  add('leading JSON whitespace', [' \t\r{"a":1} \t\n']);
  add('unicode and escapes', ['{"t":"é😀\\u00e9\\ud83d\\ude00\\n\\/","u":"\u2028\u2029"}\n']);
  add('lone surrogate escapes', ['{"t":"\\ud800","u":"\\udc00x"}\n']);
  add('raw control character in a string', ['{"t":"a\tb"}\n', '{"t":"a\u0001b"}\n', '{"t":"a\u007fb"}\n']);
  add('bad escapes', ['{"t":"\\x"}\n{"t":"\\u12"}\n{"t":"\\U0041"}\n{"t":"\\u0041"}\n']);
  add('single quotes and bare words', ["{'a':1}\n{a:1}\nNaN\nInfinity\nundefined\n"]);
  add('trailing data', ['{"a":1} x\n{"a":1}{}\n[1]]\n']);
  add('deep nesting', ['['.repeat(2000) + ']'.repeat(2000) + '\n', '['.repeat(300) + ']'.repeat(299) + '\n']);
  const decoded = new StringDecoder('utf8');
  add('invalid UTF-8, as the stream decodes it', [decoded.write(Buffer.from([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xff, 0xc3, 0x28, 0xe2, 0x82, 0x22, 0x7d, 0x0a]))]);
  add('pi-shaped stream', [
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }) + '\n'
      + ev({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls -la' } }) + '\n',
    ev({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', message: ev({ noevia: 'tool_call', toolName: 'write', input: { path: 'a.txt' } }) }).slice(0, 30),
    ev({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', message: ev({ noevia: 'tool_call', toolName: 'write', input: { path: 'a.txt' } }) }).slice(30) + '\n',
  ]);
  // ── the line-buffer cap (in UTF-16 code units, checked after each chunk is appended) ──
  add('at the limit is fine', ['{"a":"1234567"}'.slice(0, 16), '\n'], 16);
  add('over the limit by one', ['{"a":"12345678"}\n'], 16);
  add('overflow drops complete lines in the same chunk', ['{"a":1}\n{"b":2}\n{"c":3}\n'], 16);
  add('overflow, then framing resumes empty', ['{"a":"', 'xxxxxxxxxxxxxxxx', '{"b":1}\n', '"}\n{"c":2}\n'], 16);
  add('overflow counts UTF-16 units', ['😀😀😀😀😀😀😀😀', '😀\n'], 16);
  add('a chunk longer than the limit by itself', ['{"a":1', 'x'.repeat(40) + '\n{"b":2}\n', '{"c":3}\n'], 16);
  add('limit zero', ['\n', 'a', '\n'], 0);
  add('buffered remainder counts', ['{"a":1}\n{"b":"', '1234567', '8"}\n'], 16);

  // ── seeded random ──
  const pieces = ['{"type":"x"}', '{"a":[1,2,{"b":null}]}', '"str"', '1', '-0.5e3', '[]', '{', '}', '[', ']', ',', ':', '"',
    '\\', '\\u00', 'e9', 'true', 'nul', 'l', '\n', '\r', '\r\n', '\n\n', ' ', '\t', '\u00a0', '\ufeff', 'é', '😀', '\u2028',
    '{"__proto__":1}', '{"k":1,"k":2}', '01', '1e400', 'x'];
  for (let n = 0; n < 300; n++) {
    let text = '';
    const parts = 1 + int(30);
    for (let i = 0; i < parts; i++) text += pick(pieces);
    const chunks = [];
    for (let at = 0; at < text.length;) {
      let len = 1 + int(12);
      // Never split a surrogate pair: a utf8 stream does not.
      if (/[\ud800-\udbff]/.test(text[at + len - 1] || '')) len++;
      chunks.push(text.slice(at, at + len));
      at += len;
    }
    add(`random ${n}`, chunks, pick([8, 16, 40, 16 * 1024 * 1024]));
  }
  return cases;
}

function toolCallCases() {
  const cases = [];
  const add = (name, payloadText) => {
    let expect;
    try { expect = { json: JSON.stringify(toolCallFor(JSON.parse(payloadText))) }; } catch (err) {
      expect = { error: err instanceof TypeError ? 'type_error' : err instanceof RangeError ? 'range_error' : String(err?.name) };
    }
    cases.push({ name, payload: payloadText, expect });
  };
  const p = (o) => JSON.stringify(o);
  add('bash', p({ toolCallId: 'c1', toolName: 'bash', input: { command: 'ls -la' } }));
  add('bash without a string command', p({ toolCallId: 'c1', toolName: 'bash', input: { command: ['ls'] } }));
  add('bash with an empty command', p({ toolName: 'bash', input: { command: '' } }));
  add('read with path', p({ toolCallId: 'c2', toolName: 'read', input: { path: 'src/a.js' } }));
  add('write with file_path', p({ toolCallId: 'c3', toolName: 'write', input: { file_path: 'b.txt', content: 'x' } }));
  add('path wins over file_path', p({ toolName: 'edit', input: { path: 'a', file_path: 'b' } }));
  add('non-string path falls to file_path', p({ toolName: 'edit', input: { path: 1, file_path: 'b' } }));
  add('empty path has no locations', p({ toolName: 'edit', input: { path: '' } }));
  add('outside the workspace', p({ toolCallId: 'c4', toolName: 'read', input: { path: '/etc/hosts' }, outsideWorkspace: true }));
  add('outside, bash keeps its command title', p({ toolName: 'bash', input: { command: 'cat /x' }, outsideWorkspace: true }));
  add('outside must be exactly true', p({ toolName: 'read', input: {}, outsideWorkspace: 'true' }));
  add('outside overrides an existing flag in place', p({ toolName: 'read', input: { a: 1, noeviaOutsideWorkspace: false, b: 2 }, outsideWorkspace: true }));
  add('array input', p({ toolName: 'grep', input: ['a', { path: 'p' }] }));
  add('array input outside', p({ toolName: 'grep', input: ['a', 'b'], outsideWorkspace: true }));
  for (const input of [null, 'text', 5, true, false, 0]) add(`input ${JSON.stringify(input)}`, p({ toolName: 'ls', input }));
  add('no input', p({ toolName: 'find' }));
  add('no toolName', p({ toolCallId: 'c5' }));
  add('empty payload', '{}');
  for (const name of [0, -0, 1, 1.5, 1e21, 1e-7, 123456789012345680000, true, false, null, '', [], [1, [2, null, [true]]], [[]], {}, { a: 1 }])
    add(`toolName ${JSON.stringify(name)}`, p({ toolName: name, input: {} }));
  add('toolName -0 lexeme', '{"toolName":-0,"input":{}}');
  add('toolName 1.0 lexeme', '{"toolName":1.0}');
  add('toolName 1e400 lexeme', '{"toolName":1e400}');
  add('toolName object with own toString', '{"toolName":{"toString":"x"}}');
  add('toolName object with own valueOf', '{"toolName":{"valueOf":1}}');
  add('toolName array holding an object with toString', '{"toolName":[1,{"toString":1}]}');
  add('toolCallId object with own toString', '{"toolName":"bash","toolCallId":{"toString":1}}');
  for (const id of [0, '', null, false, 7, [1, 2], { x: 1 }, 'pi-x']) add(`toolCallId ${JSON.stringify(id)}`, p({ toolCallId: id, toolName: 'bash' }));
  for (const name of ['bash', 'write', 'edit', 'read', 'grep', 'find', 'ls', 'Bash', 'other', 'constructor', '__defineGetter__',
    '__defineSetter__', 'hasOwnProperty', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable',
    'toString', 'valueOf', '__proto__', 'toLocaleString', 'prototype', 'length', 'name'])
    add(`kind for ${name}`, p({ toolName: name, input: { path: 'p' } }));
  add('kind for __proto__ outside', p({ toolName: '__proto__', outsideWorkspace: true }));
  add('duplicate keys', '{"toolName":"read","toolName":"bash","input":{"command":"a","command":"b"},"input":{"command":"c","x":1,"command":"d"}}');
  add('__proto__ keys stay own data', '{"toolName":"read","input":{"__proto__":{"path":"evil"},"x":1}}');
  add('__proto__ input outside', '{"toolName":"read","input":{"__proto__":{"a":1},"path":"/x"},"outsideWorkspace":true}');
  add('integer-like keys reorder', '{"toolName":"read","input":{"b":1,"2":2,"1":3,"a":4,"4294967295":5,"4294967294":6,"01":7}}');
  add('integer-like keys outside', '{"toolName":"read","input":{"b":1,"2":2,"1":3},"outsideWorkspace":true}');
  add('numbers in input', '{"toolName":"read","input":{"a":1.0,"b":1e400,"c":-0,"d":0.1e-999,"e":12345678901234567890,"f":5e-324}}');
  add('lone surrogates', '{"toolName":"bash\\ud800","toolCallId":"\\udc00","input":{"command":"x\\ud800","path":"\\udfff"}}');
  add('bash with lone surrogate command', '{"toolName":"bash","input":{"command":"\\ud800"}}');
  add('unicode', p({ toolName: 'write', input: { path: 'ü/😀.txt', content: '\u2028\u0000\u001f"\\' } }));
  add('deep input', `{"toolName":"read","input":{"x":${'['.repeat(500)}${']'.repeat(500)}}}`);
  add('deep input outside', `{"toolName":"read","input":{"x":${'{"a":'.repeat(200)}1${'}'.repeat(200)}},"outsideWorkspace":true}`);
  add('deep toolName array', `{"toolName":${'['.repeat(200)}"x"${']'.repeat(200)}}`);
  add('extra payload keys', p({ noevia: 'tool_call', toolName: 'bash', input: { command: 'ls' }, extra: [1, 2] }));

  // ── seeded random ──
  const scalars = [null, true, false, 0, -1, 2.5, 1e21, '', 'a', 'bash', 'read', 'toString', '__proto__', 'é😀', 'p/q', '/abs'];
  const keys = ['toolName', 'toolCallId', 'input', 'outsideWorkspace', 'path', 'file_path', 'command', 'noeviaOutsideWorkspace', '__proto__', '0', '1', 'x'];
  const value = (d) => {
    const r = rand();
    if (d > 3 || r < 0.55) return pick(scalars);
    if (r < 0.75) return Array.from({ length: int(4) }, () => value(d + 1));
    const o = {}; for (let i = int(5); i > 0; i--) o[pick(keys)] = value(d + 1); return o;
  };
  for (let n = 0; n < 400; n++) {
    const parts = [];
    if (rand() < 0.9) parts.push(`"toolName":${JSON.stringify(rand() < 0.6 ? pick(['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'valueOf', '__proto__', 'x']) : value(1))}`);
    if (rand() < 0.6) parts.push(`"toolCallId":${JSON.stringify(rand() < 0.7 ? `c${n}` : value(1))}`);
    if (rand() < 0.8) {
      const fields = [];
      for (let i = int(5); i > 0; i--) fields.push(`${JSON.stringify(pick(keys))}:${JSON.stringify(value(1))}`);
      parts.push(rand() < 0.15 ? `"input":${JSON.stringify(value(1))}` : `"input":{${fields.join(',')}}`);
    }
    if (rand() < 0.4) parts.push(`"outsideWorkspace":${JSON.stringify(rand() < 0.7 ? true : value(1))}`);
    if (rand() < 0.1) parts.push(`"toolName":${JSON.stringify(value(1))}`); // a duplicate key
    add(`random ${n}`, `{${parts.join(',')}}`);
  }
  return cases;
}

function startCases() {
  const cases = [];
  const add = (name, line) => cases.push({ name, line, expect: JSON.stringify(parseStartJs(line)) });
  const s = (o) => JSON.stringify(o);
  add('ordinary', s({ noevia: 'start', cwd: '/workspaces/trees/t1', env: { HOME: '/workspaces/.home/t1', PATH: '/usr/bin', LANG: 'C.UTF-8' } }));
  add('not JSON', 'hello');
  add('empty', '');
  add('JSON null', 'null');
  add('JSON array', '["start"]');
  add('JSON string', '"start"');
  add('wrong noevia', s({ noevia: 'Start', cwd: '/w' }));
  add('noevia not a string', s({ noevia: ['start'], cwd: '/w' }));
  add('no cwd', s({ noevia: 'start' }));
  for (const cwd of [null, 0, -0, 1.5, 1e21, true, false, '', [], ['/w', 'x'], [['/w']], {}, '/w/../x', 'relative/x'])
    add(`cwd ${JSON.stringify(cwd)}`, s({ noevia: 'start', cwd }));
  add('cwd object with own toString', '{"noevia":"start","cwd":{"toString":"/w"}}');
  add('cwd array holding an object with toString', '{"noevia":"start","cwd":[{"toString":1}]}');
  add('cwd lexemes', '{"noevia":"start","cwd":1.0}');
  add('cwd lone surrogate', '{"noevia":"start","cwd":"/w/\\ud800"}');
  add('env allowlist', s({ noevia: 'start', cwd: '/w', env: { HOME: '/h', PATH: '/p', LANG: 'C', TMPDIR: '/t', HTTP_PROXY: 'http://proxy.invalid:3128',
    HTTPS_PROXY: 'x', http_proxy: 'x', https_proxy: 'x', NO_PROXY: 'localhost', CURL_HOME: '/c', WGETRC: '/w/rc', SECRET: 'no', LD_PRELOAD: '/x.so',
    home: 'lower', NODE_OPTIONS: '--require x' } }));
  add('env non-string values', s({ noevia: 'start', cwd: '/w', env: { HOME: 1, PATH: null, LANG: ['C'], TMPDIR: { a: 1 }, NO_PROXY: true } }));
  add('env value length 4095 and 4096', s({ noevia: 'start', cwd: '/w', env: { HOME: 'h'.repeat(4095), PATH: 'p'.repeat(4096) } }));
  add('env value length counts UTF-16', s({ noevia: 'start', cwd: '/w', env: { HOME: '😀'.repeat(2047) + 'x', PATH: '😀'.repeat(2048) } }));
  for (const env of [null, 'HOME=/x', ['HOME'], 5, true]) add(`env ${JSON.stringify(env)}`, s({ noevia: 'start', cwd: '/w', env }));
  add('env duplicate keys', '{"noevia":"start","cwd":"/w","env":{"HOME":"/a","PATH":"/p","HOME":"/b"}}');
  add('env __proto__', '{"noevia":"start","cwd":"/w","env":{"__proto__":{"HOME":"/evil"},"PATH":"/p"}}');
  add('env lone surrogate value', '{"noevia":"start","cwd":"/w","env":{"HOME":"/h\\udc00"}}');
  add('duplicate noevia, last wins', '{"noevia":"start","noevia":"stop","cwd":"/w"}');
  add('duplicate noevia, last is start', '{"noevia":"stop","noevia":"start","cwd":"/w"}');
  add('__proto__ start', '{"__proto__":{"noevia":"start"},"cwd":"/w"}');
  add('CR at the end', s({ noevia: 'start', cwd: '/w' }) + '\r');
  add('BOM', '\ufeff' + s({ noevia: 'start', cwd: '/w' }));
  add('deep extra field', `{"noevia":"start","cwd":"/w","x":${'['.repeat(3000)}${']'.repeat(3000)}}`);
  add('unicode cwd', s({ noevia: 'start', cwd: '/w/é/😀/\u2028' }));
  // ── seeded random ──
  const vals = [null, true, 0, 1, '', '/w', '/w/a', 'start', 'Start', [], ['/w'], {}, { toString: 1 }, 'é'];
  const envKeys = ['HOME', 'PATH', 'LANG', 'SECRET', 'NO_PROXY', '__proto__', 'http_proxy', '0'];
  for (let n = 0; n < 200; n++) {
    const parts = [];
    if (rand() < 0.8) parts.push(`"noevia":${JSON.stringify(rand() < 0.75 ? 'start' : pick(vals))}`);
    if (rand() < 0.8) parts.push(`"cwd":${JSON.stringify(pick(vals))}`);
    if (rand() < 0.7) {
      const fields = [];
      for (let i = int(5); i > 0; i--) fields.push(`${JSON.stringify(pick(envKeys))}:${JSON.stringify(rand() < 0.7 ? pick(['/x', 'C', '']) : pick(vals))}`);
      parts.push(`"env":{${fields.join(',')}}`);
    }
    let line = `{${parts.join(',')}}`;
    if (rand() < 0.1) line = line.slice(0, int(line.length));
    add(`random ${n}`, line);
  }
  return cases;
}

function containedCases() {
  const cases = [];
  const add = (name, root, resolved) => cases.push({ name, root, resolved, expect: { contained: containedJs(root, resolved), rel: path.relative(root, resolved) } });
  add('same', '/workspaces', '/workspaces');
  add('child', '/workspaces', '/workspaces/trees/t1');
  add('sibling with a common prefix', '/workspaces', '/workspaces2/x');
  add('parent', '/workspaces/trees', '/workspaces');
  add('root of the filesystem as root', '/', '/anything/at/all');
  add('filesystem root as candidate', '/workspaces', '/');
  add('dot-dot segment', '/workspaces', '/workspaces/../etc');
  add('dot-dot at the end', '/workspaces', '/workspaces/a/..');
  add('dot-dot past the root', '/workspaces', '/workspaces/a/../../etc');
  add('dot segments', '/workspaces', '/workspaces/./a/./b');
  add('child named ..x is refused as JS does', '/workspaces', '/workspaces/..x');
  add('child named ...', '/workspaces', '/workspaces/...');
  add('child named .x', '/workspaces', '/workspaces/.x');
  add('trailing dot', '/workspaces', '/workspaces/a.');
  add('trailing slash on root', '/workspaces/', '/workspaces/a');
  add('trailing slash on candidate', '/workspaces', '/workspaces/a/');
  add('double slashes', '//workspaces//', '/workspaces///a//b');
  add('backslash is a name character', '/workspaces', '/workspaces/..\\etc');
  add('backslash parent', '/workspaces', '/workspaces\\..\\etc');
  add('NFC vs NFD', '/w/caf\u00e9', '/w/cafe\u0301/x');
  add('NFD vs NFD', '/w/cafe\u0301', '/w/cafe\u0301/x');
  add('fullwidth dots', '/workspaces', '/workspaces/\uff0e\uff0e/etc');
  add('one-dot leader', '/workspaces', '/workspaces/\u2024\u2024/etc');
  add('astral', '/w/😀', '/w/😀/a');
  add('astral prefix only', '/w/😀', '/w/😀😀');
  add('root with dot-dot', '/workspaces/../workspaces', '/workspaces/a');
  add('root is a prefix but not a segment', '/work', '/workspaces');
  add('candidate equals root plus slash dot', '/w', '/w/.');
  // ── seeded random ──
  const segs = ['w', 'a', 'b', '.', '..', '...', '..x', '.x', 'x.', '', 'é', 'e\u0301', '😀', '\\', '..\\', ' ', '%2e%2e'];
  const mk = () => { let p = ''; for (let i = 1 + int(5); i > 0; i--) p += '/' + pick(segs); return p + (rand() < 0.2 ? '/' : ''); };
  for (let n = 0; n < 500; n++) {
    const root = mk();
    const resolved = rand() < 0.5 ? root + mk() : mk();
    add(`random ${n}`, root, resolved);
  }
  return cases;
}

const out = {
  version: 1,
  generator: 'noevia-core tools/gen-sandbox-bridge-fixtures.cjs (expectations from code-sandbox/pi-acp-bridge.cjs lines/toolCallFor and code-sandbox/supervisor.cjs parseStartJs/containedJs)',
  frame: frameCases(),
  toolCall: toolCallCases(),
  start: startCases(),
  contained: containedCases(),
};
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
