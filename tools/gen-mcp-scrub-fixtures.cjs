#!/usr/bin/env node
'use strict';
// The shared fixture for the credential scrub (sbstndalton/noevia#2218): one policy, two implementations, one file both read.
//   node tools/gen-mcp-scrub-fixtures.cjs > tests/fixtures/mcp-scrub.v1.json
// Expectations come from server/mcp-scrub.cjs (the reference). The same file is committed byte for byte in sbstndalton/noevia-rs
// (bins/noevia-server/tests/fixtures/mcp-scrub.v1.json), whose Secrets (mcp_scrub.rs) and tool sanitizer (mcp_tools.rs) must
// reproduce every case; noevia-core CI compares it with a fresh run (server/mcp-scrub.test.cjs). All values are synthetic.
//
// text cases: { id, headers: [[name, value]...], text, expect }  -> Secrets(headers).scrub(text) === expect
// tool cases: { id, headers, tool, expect: { tool } | { dropped } } -> sanitizeTool(tool, Secrets(headers))
const { createSecrets, sanitizeTool } = require('../server/mcp-scrub.cjs');

const basic = (s) => Buffer.from(s).toString('base64');
const H = (...pairs) => pairs;
const KEY = 'SYNTH-api-secret-1234';

const TEXT = [
  // every length, as a whole token
  ...['a', 'q7', 'q7Z', 'q7Z!', 'q7Z!2', 'q7Z!2x', 'q7Z!2xy', 'q7Z!2xyz'].map((k) => ({ id: `length-${k.length}`, headers: H(['X-Api-Key', k]), text: `bad token ${k}. (${k}) ${k}` })),
  { id: 'short-inside-words', headers: H(['X-Api-Key', 'ab']), text: 'cabin about ab ab_c ab9 9ab' },
  { id: 'seven-bytes-is-a-token', headers: H(['X-Api-Key', 'abcdefg']), text: 'xabcdefgx abcdefg' },
  { id: 'eight-bytes-anywhere', headers: H(['X-Api-Key', 'abcdefgh']), text: 'xabcdefghx abcdefgh' },
  { id: 'multibyte-length-is-bytes', headers: H(['X-Api-Key', 'éé']), text: 'aééb éé' },
  // word boundaries: letters, digits, underscore, combining marks, other scripts, emoji
  { id: 'boundary-combining-mark-before', headers: H(['X-Api-Key', 'q7']), text: 'ͅq7 q7ͅ q7' },
  { id: 'boundary-accented-letter', headers: H(['X-Api-Key', 'q7']), text: 'éq7 q7é q7' },
  { id: 'boundary-other-scripts-and-digits', headers: H(['X-Api-Key', 'q7']), text: 'дq7 q7д 5q7 q7٣ 漢q7 q7' },
  { id: 'boundary-emoji-and-punctuation', headers: H(['X-Api-Key', 'q7']), text: '😀q7 q7😀 -q7- _q7 q7_' },
  { id: 'boundary-roman-numeral-and-marks', headers: H(['X-Api-Key', 'q7']), text: 'Ⅻq7 ²q7 q7​ q7́' },
  // auth schemes and Basic
  { id: 'bearer-scheme-stripped', headers: H(['Authorization', 'Bearer t9x']), text: 'Bearer t9x t9x Bearer' },
  { id: 'scheme-only-no-rest', headers: H(['Authorization', 'Bearer']), text: 'Bearer token' },
  { id: 'scheme-with-trailing-space', headers: H(['Authorization', 'Bearer abc  ']), text: 'abc Bearer abc' },
  { id: 'basic-padded', headers: H(['Authorization', `Basic ${basic('al:pw12')}`]), text: `${basic('al:pw12')} al:pw12 al pw12` },
  { id: 'basic-unpadded', headers: H(['Authorization', 'Basic dTpwdzE']), text: 'dTpwdzE u:pw1 u pw1' },
  { id: 'basic-noncanonical-trailing-bits', headers: H(['Authorization', 'Basic dTpwdzF=']), text: 'dTpwdzF= u:pw1 u pw1' },
  { id: 'basic-too-much-padding', headers: H(['Authorization', 'Basic dTpwdzE===']), text: 'u:pw1 u pw1 dTpwdzE===' },
  { id: 'basic-impossible-length', headers: H(['Authorization', 'Basic dTpwd']), text: 'u:pw u pw dTpwd' },
  { id: 'basic-padding-in-the-middle', headers: H(['Authorization', 'Basic dT=pwdzE']), text: 'u:pw1 pw1' },
  { id: 'basic-url-safe-alphabet-is-not-base64', headers: H(['Authorization', 'Basic dT-pwd_zE']), text: 'dT-pwd_zE' },
  { id: 'basic-no-colon', headers: H(['Authorization', `Basic ${basic('justasecret')}`]), text: 'justasecret' },
  { id: 'basic-scheme-case', headers: H(['Authorization', `bAsIc ${basic('u:pw1')}`]), text: 'u pw1' },
  { id: 'basic-invalid-utf8', headers: H(['Authorization', 'Basic /+8=']), text: 'plain' },
  // trimming (JavaScript whitespace)
  { id: 'trim-nbsp-and-bom', headers: H(['Authorization', 'Bearer  tok1﻿']), text: 'tok1  tok1﻿' },
  { id: 'trim-next-line-is-not-whitespace', headers: H(['X-Api-Key', '\u0085key9\u0085']), text: 'key9 \u0085key9\u0085' },
  { id: 'blank-value-adds-nothing', headers: H(['X-Api-Key', '   '], ['X-Other', '']), text: 'nothing to hide here' },
  // spellings
  { id: 'json-escaped-spelling', headers: H(['X-Api-Key', 'k"q\\ü\n1']), text: '{"m":"k\\"q\\\\ü\\n1"} k"q\\ü\n1' },
  { id: 'percent-encoded-spelling', headers: H(['X-Api-Key', 'a b/ü~x']), text: 'a%20b%2F%C3%BC~x a b/ü~x' },
  { id: 'account-id-is-not-a-credential', headers: H(['X-Cowork-User-ID', 'user-1'], ['x-cowork-user-id', 'user-2']), text: 'user-1 user-2' },
  { id: 'overlapping-values-merge', headers: H(['A', 'abcdefghij'], ['B', 'defghijklm']), text: 'xx abcdefghijklm yy' },
  { id: 'numeric-and-boolean-words', headers: H(['X-Api-Key', '12345'], ['X-Flag', 'true']), text: 'MCP error 12345: boolean true; 123456; truest' },
  { id: 'nothing-to-scrub', headers: H(), text: 'SYNTH-api-secret-1234' },
];

const tool = (name, extra = {}) => ({ name, description: 'd', inputSchema: { type: 'object', properties: {} }, ...extra });
const withSchema = (properties, more = {}) => tool('t', { inputSchema: { type: 'object', properties, ...more } });
const TOOLS = [
  { id: 'clean-tool-unchanged', headers: H(['X-Api-Key', KEY]), tool: tool('search', { description: 'Searches', title: 'Search' }) },
  { id: 'name-repeats-the-credential', headers: H(['X-Api-Key', KEY]), tool: tool(KEY) },
  { id: 'name-contains-a-long-credential', headers: H(['X-Api-Key', KEY]), tool: tool(`x_${KEY}_y`) },
  { id: 'description-and-title-scrubbed', headers: H(['X-Api-Key', KEY]), tool: tool('t', { description: `Use ${KEY} to search`, title: `T ${KEY}` }) },
  { id: 'nested-description-scrubbed', headers: H(['X-Api-Key', KEY]), tool: withSchema({ query: { type: 'string', description: `Use ${KEY}` } }) },
  { id: 'deep-nested-descriptions-in-items-and-alternatives', headers: H(['X-Api-Key', KEY]), tool: withSchema({ q: { type: 'array', items: { anyOf: [{ type: 'string', description: `a ${KEY}` }, { type: 'object', properties: { z: { description: `b ${KEY}`, title: `c ${KEY}`, $comment: KEY } } }] } } }) },
  { id: 'examples-are-descriptive', headers: H(['X-Api-Key', KEY]), tool: withSchema({ q: { type: 'string', examples: [KEY, 'ok'], example: { k: KEY } } }) },
  { id: 'default-repeats-the-credential-drops-the-tool', headers: H(['X-Api-Key', KEY]), tool: withSchema({ q: { type: 'string', default: KEY } }) },
  { id: 'enum-repeats-the-credential-drops-the-tool', headers: H(['X-Api-Key', KEY]), tool: withSchema({ q: { enum: ['a', KEY] } }) },
  { id: 'property-name-repeats-the-credential-drops-the-tool', headers: H(['X-Api-Key', KEY]), tool: withSchema({ [KEY]: { type: 'string' } }) },
  { id: 'pattern-and-required-drop-the-tool', headers: H(['X-Api-Key', KEY]), tool: withSchema({ q: { type: 'string', pattern: `^${KEY}$` } }) },
  { id: 'required-entry-drops-the-tool', headers: H(['X-Api-Key', KEY]), tool: withSchema({ q: { type: 'string' } }, { required: [KEY] }) },
  { id: 'defs-key-drops-the-tool', headers: H(['X-Api-Key', KEY]), tool: withSchema({}, { $defs: { [KEY]: { type: 'string' } } }) },
  { id: 'short-credential-token-in-description', headers: H(['X-Api-Key', 'q7']), tool: withSchema({ q: { description: 'use q7 now; q7z stays' } }) },
  { id: 'short-credential-as-a-property-name-drops', headers: H(['X-Api-Key', 'q7']), tool: withSchema({ q7: { type: 'string' } }) },
  { id: 'short-credential-inside-a-name-stays', headers: H(['X-Api-Key', 'q7']), tool: tool('aq7b') },
  { id: 'numeric-credential-in-a-number-default-stays', headers: H(['X-Api-Key', '12345']), tool: withSchema({ n: { type: 'integer', default: 12345, description: 'n is 12345' } }) },
  { id: 'too-deep-drops-the-tool', headers: H(['X-Api-Key', KEY]), tool: withSchema({ a: Array.from({ length: 70 }).reduce((acc) => ({ items: acc }), { type: 'string' }) }) },
  { id: 'no-credentials-nothing-changes', headers: H(), tool: withSchema({ q: { type: 'string', description: KEY, default: KEY } }) },
  { id: 'not-an-object-passes-through', headers: H(['X-Api-Key', KEY]), tool: 'just a string' },
];

const secretsOf = (headers) => createSecrets(Object.fromEntries(headers));
const cases = {
  text: TEXT.map((c) => ({ ...c, expect: secretsOf(c.headers).scrub(c.text) })),
  tool: TOOLS.map((c) => {
    const out = sanitizeTool(c.tool, secretsOf(c.headers));
    return { ...c, expect: out.dropped ? { dropped: out.dropped } : { tool: out.tool } };
  }),
};
process.stdout.write(`${JSON.stringify({ version: 1, ...cases }, null, 1)}\n`);
