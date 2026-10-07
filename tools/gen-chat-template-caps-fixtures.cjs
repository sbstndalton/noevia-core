#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for chat-template capabilities and provider-error
// classification (#1002, #1003). The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/chat-template-caps/tests/fixtures/chat-template-caps.v1.json); noevia-core CI compares
// them.
//   node tools/gen-chat-template-caps-fixtures.cjs > tests/fixtures/chat-template-caps.v1.json
//
// Sections:
//   templates:  { name, source, template, expect: caps }   real public chat templates, read from
//               tests/fixtures/chat-templates/*.jinja (sources below), plus made-up adversarial
//               ones. `expect` is the capability table this change specifies (there is no JS
//               reference: the analysis is new).
//   errors:     { name, status, body, expect: { kind, reason? } }  synthetic upstream errors;
//               every host, key and path in them is made up.
//   context:    { text, jsContextFull }  jsContextFull is the JS reference itself: whether
//               chat-context.cjs providerErrorJs(text) returns its context-full sentence.
//   verdicts:   { name, status, body, expect: { passed, kind } }  autotune's serving check.

const fs = require('node:fs');
const path = require('node:path');
const { providerErrorJs, CONTEXT_FULL_TEXT } = require('../server/chat-context.cjs');

const DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'chat-templates');
// Public chat templates (short, quoted as test data only). llama.cpp's copies are from
// https://github.com/ggml-org/llama.cpp/tree/master/models/templates (MIT; the templates
// themselves come from the model repositories named); the others are the `chat_template` field
// of the tokenizer_config.json / chat_template.json of the Hugging Face repository named.
const SOURCES = {
  'google-gemma-3-12b-it': 'huggingface.co/unsloth/gemma-3-12b-it chat_template.json (Google Gemma 3)',
  'gguf-gemma-3-12b-it-qat-Q4_0': 'tokenizer.chat_template of the GGUF file in noevia#1002 (gemma-3-12b-it-qat-Q4_0.gguf; general.architecture gemma3), read with gguf-meta; no other metadata kept',
  'google-gemma-4-31B-it': 'llama.cpp models/templates (google/gemma-4-31B-it)',
  'google-gemma-4-31B-it-interleaved': 'llama.cpp models/templates (google/gemma-4-31B-it, interleaved thinking)',
  'google-gemma-2-2b-it': 'llama.cpp models/templates (google/gemma-2-2b-it)',
  'Qwen-Qwen2.5-7B-Instruct': 'llama.cpp models/templates (Qwen/Qwen2.5-7B-Instruct)',
  'Qwen-Qwen3-0.6B': 'llama.cpp models/templates (Qwen/Qwen3-0.6B)',
  'meta-llama-Meta-Llama-3-8B-Instruct': 'huggingface.co/NousResearch/Meta-Llama-3-8B-Instruct tokenizer_config.json (Meta Llama 3)',
  'meta-llama-Llama-3.1-8B-Instruct': 'llama.cpp models/templates (meta-llama/Llama-3.1-8B-Instruct)',
  'meta-llama-Llama-3.2-3B-Instruct': 'llama.cpp models/templates (meta-llama/Llama-3.2-3B-Instruct)',
  'mistralai-Mistral-7B-Instruct-v0.3': 'huggingface.co/unsloth/mistral-7b-instruct-v0.3 tokenizer_config.json (Mistral 7B v0.3)',
  'mistralai-Mistral-Nemo-Instruct-2407': 'llama.cpp models/templates (mistralai/Mistral-Nemo-Instruct-2407)',
  'microsoft-Phi-3.5-mini-instruct': 'llama.cpp models/templates (microsoft/Phi-3.5-mini-instruct)',
  'microsoft-Phi-4-mini-instruct': 'huggingface.co/unsloth/Phi-4-mini-instruct tokenizer_config.json (Microsoft Phi-4-mini)',
};

const caps = (o = {}) => ({ known: true, tools: false, toolCalls: false, toolRole: false, systemRole: true, strictAlternation: false, raises: false, thinking: false, sendTools: true, ...o });
const nativeTools = { tools: true, toolCalls: true, toolRole: true };
const EXPECT = {
  // The #1002 model: no tools, raises on role order, so tools must not be sent.
  'google-gemma-3-12b-it': caps({ raises: true, strictAlternation: true, sendTools: false }),
  'gguf-gemma-3-12b-it-qat-Q4_0': caps({ raises: true, strictAlternation: true, sendTools: false }),
  'google-gemma-4-31B-it': caps({ ...nativeTools, thinking: true }),
  'google-gemma-4-31B-it-interleaved': caps({ ...nativeTools, thinking: true }),
  'google-gemma-2-2b-it': caps({ raises: true, strictAlternation: true, systemRole: false, sendTools: false }),
  'Qwen-Qwen2.5-7B-Instruct': caps(nativeTools),
  'Qwen-Qwen3-0.6B': caps({ ...nativeTools, thinking: true }),
  'meta-llama-Meta-Llama-3-8B-Instruct': caps(),
  'meta-llama-Llama-3.1-8B-Instruct': caps({ ...nativeTools, raises: true }),
  'meta-llama-Llama-3.2-3B-Instruct': caps({ ...nativeTools, raises: true }),
  'mistralai-Mistral-7B-Instruct-v0.3': caps({ ...nativeTools, raises: true, strictAlternation: true }),
  'mistralai-Mistral-Nemo-Instruct-2407': caps({ ...nativeTools, raises: true, strictAlternation: true }),
  'microsoft-Phi-3.5-mini-instruct': caps(),
  'microsoft-Phi-4-mini-instruct': caps(),
};

const ADVERSARIAL = [
  ['empty', '', { ...caps(), known: false, systemRole: false }],
  ['whitespace only', ' \n\t ', { ...caps(), known: false, systemRole: false }],
  ['tools only in text', 'You can use tools. {{ messages[0].content }}', caps()],
  ['tools only in a comment', '{# {% if tools %} #}{{ raise_exception("Roles must alternate") }}', caps({ raises: true, strictAlternation: true, sendTools: false })],
  ['tools only in a string literal', "{{ 'tools' }}{{ raise_exception('x') }}", caps({ raises: true, sendTools: false })],
  ['tools as an attribute', '{{ message.tools }}{{ raise_exception("x") }}', caps({ raises: true, sendTools: false })],
  ['close delimiter inside a string', '{{ "}} {% if tools %}" }}{{ raise_exception("y") }}', caps({ raises: true, sendTools: false })],
  ['raise_exception as an attribute', '{{ foo.raise_exception("no") }}', caps()],
  ['raise in text only', 'raise_exception("Conversation roles must alternate")', caps()],
  ['unterminated tag', '{% if tools', caps({ tools: true })],
  ['unterminated string', "{{ raise_exception('System role not supported", caps({ raises: true, systemRole: false, sendTools: false })],
  ['alternation by index only', "{% if (message['role'] == 'user') != (loop.index0 % 2 == 0) %}{{ raise_exception('bad order') }}{% endif %}", caps({ raises: true, strictAlternation: true, sendTools: false })],
  ['native tools despite raising', '{% if tools %}{% for t in tools %}{{ t | tojson }}{% endfor %}{% endif %}{{ raise_exception("roles must alternate") }}', caps({ tools: true, raises: true, strictAlternation: true })],
  ['nested braces and unicode', '{{ {"a": {"b": "ü}}"}} }}{% set x = "ツール" %}{{ x }}', caps()],
  ['many open braces', '{'.repeat(2000) + '{% if tools %}', caps({ tools: true })],
  ['thinking switch', '{% if enable_thinking is defined and not enable_thinking %}<think></think>{% endif %}', caps({ thinking: true })],
];

const templates = [];
for (const name of Object.keys(EXPECT)) {
  templates.push({ name, source: SOURCES[name], template: fs.readFileSync(path.join(DIR, `${name}.jinja`), 'utf8'), expect: EXPECT[name] });
}
for (const [name, template, expect] of ADVERSARIAL) templates.push({ name: `adversarial: ${name}`, source: 'synthetic', template, expect });

const GEMMA_400 = JSON.stringify({ error: { code: 400, message: 'Unable to generate parser for this template. Automatic parser generation failed: \n------------\nWhile executing CallExpression at line 19, column 12 in source:\n...ndif -%}\n    {%- if (message[\'role\'] == \'user\') != (loop.index0 % 2 == 0) -%}\n        {{ raise_exception("Conversation roles must alternate user/assistant/user/assistant/...") }}\n           ^\nError: Jinja Exception: Conversation roles must alternate user/assistant/user/assistant/...', type: 'invalid_request_error' } });
const errors = [
  { name: 'template refuses tools, 400 (#1002)', status: 400, body: GEMMA_400, expect: { kind: 'template_or_tools_unsupported', reason: 'Unable to generate parser for this template. Automatic parser generation failed (template: Conversation roles must alternate user/assistant/user/assistant/...)' } },
  { name: 'tools need --jinja', status: 500, body: '{"error":{"code":500,"message":"tools param requires --jinja flag","type":"server_error"}}', expect: { kind: 'template_or_tools_unsupported', reason: 'tools param requires --jinja flag' } },
  { name: 'system role refused', status: 400, body: '{"error":"System role not supported"}', expect: { kind: 'template_or_tools_unsupported', reason: 'System role not supported' } },
  { name: 'context exceeded', status: 400, body: '{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}', expect: { kind: 'context_full', reason: 'the request exceeds the available context size, try increasing it' } },
  { name: 'loading', status: 503, body: '{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}', expect: { kind: 'backend_down', reason: 'Loading model' } },
  { name: 'no response', status: 0, body: '', expect: { kind: 'backend_down', reason: '' } },
  { name: 'gateway html', status: 502, body: '<html><body>502 Bad Gateway</body></html>', expect: { kind: 'backend_down', reason: '' } },
  { name: 'plain 422', status: 422, body: '{"detail":"temperature must be <= 2"}', expect: { kind: 'bad_request', reason: 'temperature must be <= 2' } },
  { name: 'unknown model', status: 404, body: '{"error":{"message":"model not found: synthetic-model"}}', expect: { kind: 'bad_request', reason: 'model not found: synthetic-model' } },
  { name: 'secrets and internals are redacted', status: 500, body: '{"error":{"message":"upstream http://10.9.8.7:8080/v1/chat failed for Bearer synthetic.token.value with api_key=sk-synthetic0000 at /srv/models/synthetic/x.gguf via llama:8080 (198.51.100.4) ghp_000000000000syntheticxx"}}', expect: { kind: 'other', reason: 'upstream [url] failed for Bearer [redacted] with api_key=[redacted] at [path] via [address] [address] [redacted]' } },
  { name: 'a provider cannot put a link in the chat (#455)', status: 400, body: '{"error":{"message":"Visit evil.example to fix this"}}', expect: { kind: 'bad_request', reason: 'Visit [host] to fix this' } },
  { name: 'markdown link and image syntax (#1017)', status: 400, body: '{"error":{"message":"Fix it [here](javascript:alert) or ![x](tracker) or [a][b]; [plain] stays"}}', expect: { kind: 'bad_request', reason: 'Fix it [link] or [link] or [link] [plain] stays' } },
  { name: 'non-JSON body', status: 500, body: 'segfault in worker\n\tat frame 3', expect: { kind: 'other', reason: '' } },
  { name: 'JSON without a message', status: 500, body: '{"code":7}', expect: { kind: 'other', reason: '' } },
  { name: 'long message is capped', status: 500, body: JSON.stringify({ error: 'x'.repeat(10) + ' word'.repeat(80) }), expect: { kind: 'other' } },
];

// The JS context test, over generated text: fragments, separators (incl. JS line terminators)
// and case changes. Deterministic.
let seed = 0x1002;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const FRAG = ['context', 'CONTEXT', 'Context', 'exceed', 'EXCEEDED', 'full', 'length', 'too many tokens', 'TOO MANY tokens', 'maximum context', 'maximum  context', 'contxt', 'conte xt', 'ful', 'lengt', 'size', 'window', 'tokens', 'maxımum context', 'ſize', 'K', 'error', ' ', '.', ':'];
const SEP = [' ', '', '\n', '\r', ' ', ' ', '\t', '\u0085', ' ', ' - '];
const context = [];
for (let i = 0; i < 400; i++) {
  let text = '';
  const n = 1 + Math.floor(rand() * 6);
  for (let j = 0; j < n; j++) text += pick(FRAG) + pick(SEP);
  context.push({ text, jsContextFull: providerErrorJs(text) === CONTEXT_FULL_TEXT });
}

const verdicts = [
  { name: 'text reply', status: 200, body: '{"choices":[{"message":{"role":"assistant","content":"Done."}}]}', expect: { passed: true, kind: null } },
  { name: 'tool call reply', status: 200, body: '{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"search_files","arguments":"{}"}}]}}]}', expect: { passed: true, kind: null } },
  { name: 'no choices', status: 200, body: '{"choices":[]}', expect: { passed: false, kind: 'other' } },
  { name: 'not JSON', status: 200, body: 'ok', expect: { passed: false, kind: 'other' } },
  { name: 'template 400', status: 400, body: GEMMA_400, expect: { passed: false, kind: 'template_or_tools_unsupported' } },
  { name: 'down', status: 503, body: 'Loading model', expect: { passed: false, kind: 'backend_down' } },
];

process.stdout.write(`${JSON.stringify({ version: 1, limits: { maxReasonChars: 200, maxTemplateBytes: 256 * 1024 }, templates, errors, context, verdicts }, null, 1)}\n`);
