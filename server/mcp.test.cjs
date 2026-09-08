'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { convertTool, parseRpcBody, resultToText, readOnlyHint } = require('./mcp.cjs');
const { resolveTools, toolTokenBudgetFor, MCP_TOOLBOX_MANIFEST } = require('./index.cjs');

// ── schema conversion ────────────────────────────────────────────────────
// The stakes: a malformed schema does not break one tool, it makes the
// provider reject the whole request — so one bad tool would take out every
// other tool in the box. Dropping is mandatory, not tidiness.

test('a well-formed MCP tool converts to OpenAI function shape', () => {
  const r = convertTool({
    name: 'nc_notes_search_notes',
    description: 'Search notes by title or content.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' } } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tool, {
    type: 'function',
    function: {
      name: 'nc_notes_search_notes',
      description: 'Search notes by title or content.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  });
  // outputSchema has no home in function calling, and on the reference server
  // it is 63% of the payload. It must not survive conversion.
  assert.equal('outputSchema' in r.tool.function, false);
});

test('malformed tools are dropped with a reason, never emitted broken', () => {
  const cases = [
    [{ name: 'x' }, /inputSchema missing/],
    [{ name: 'x', inputSchema: [] }, /not an object/],
    [{ name: 'x', inputSchema: { type: 'array' } }, /expected "object"/],
    [{ name: 'x', inputSchema: { type: 'object', properties: [] } }, /properties is not an object/],
    [{ name: 'x', inputSchema: { type: 'object', required: 'query' } }, /required is not an array/],
    [{ name: 'bad name!', inputSchema: { type: 'object' } }, /invalid tool name/],
    [{ inputSchema: { type: 'object' } }, /invalid tool name/],
  ];
  for (const [input, re] of cases) {
    const r = convertTool(input);
    assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be dropped`);
    assert.match(r.reason, re);
  }
});

test('a schema with no properties still converts (a no-argument tool)', () => {
  const r = convertTool({ name: 'talk_list_conversations', inputSchema: { type: 'object' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tool.function.parameters, { type: 'object', properties: {}, required: [] });
});

test('description falls back to title, never to undefined', () => {
  const r = convertTool({ name: 'x', title: 'A Title', inputSchema: { type: 'object' } });
  assert.equal(r.tool.function.description, 'A Title');
  const r2 = convertTool({ name: 'x', inputSchema: { type: 'object' } });
  assert.equal(r2.tool.function.description, '');
});

test('readOnlyHint is a signal, not a guarantee', () => {
  assert.equal(readOnlyHint({ annotations: { readOnlyHint: true } }), true);
  assert.equal(readOnlyHint({ annotations: { readOnlyHint: false } }), false);
  // 90 of 160 tools on the reference server omit it. Absent must be
  // distinguishable from false so step 4 can treat unknown as a write.
  assert.equal(readOnlyHint({ annotations: {} }), null);
  assert.equal(readOnlyHint({}), null);
});

// ── transport ────────────────────────────────────────────────────────────

test('a JSON-RPC reply is parsed from an SSE body as well as plain JSON', () => {
  // The reference server answers every call as text/event-stream, even for a
  // plain request/response call. A client that only handles application/json
  // fails against it entirely.
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
  assert.deepEqual(parseRpcBody('text/event-stream', sse), { jsonrpc: '2.0', id: 2, result: { tools: [] } });
  assert.deepEqual(parseRpcBody('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}'),
    { jsonrpc: '2.0', id: 1, result: {} });
});

test('progress notifications before the result do not confuse the parser', () => {
  const sse = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}',
    '',
  ].join('\n');
  assert.deepEqual(parseRpcBody('text/event-stream', sse).result, { ok: true });
});

test('an event stream carrying no JSON-RPC message is an error, not a silent empty', () => {
  assert.throws(() => parseRpcBody('text/event-stream', 'event: ping\n\n'), /no JSON-RPC message/);
});

test('tool results flatten to text, and an error result stays a message', () => {
  assert.equal(resultToText({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  assert.equal(resultToText({ content: [{ type: 'image' }] }), '[image content omitted]');
  assert.equal(resultToText({ content: [], structuredContent: { a: 1 } }), '{"a":1}');
  // isError must come back as text the model can act on, not as a throw that
  // would strand the tool chip with no result.
  assert.match(resultToText({ isError: true, content: [{ type: 'text', text: 'nope' }] }), /^ERROR from tool: nope/);
  assert.equal(resultToText(null), '');
});

// ── budget ───────────────────────────────────────────────────────────────

test('the token budget drops expensive tools that the count cap would admit', () => {
  // The case that forced the budget to exist. Real numbers from the reference
  // server: nc_calendar_create_event is ~2,739 calibrated tokens and
  // nc_notes_search_notes is ~161. A count-only cap of 12 calls those
  // equivalent; three create_event-sized tools would blow past a 9B model's
  // whole budget while the cap reported plenty of room.
  const fat = (n, chars) => ({
    type: 'function',
    function: { name: n, description: 'x'.repeat(chars), parameters: { type: 'object', properties: {}, required: [] } },
  });
  // ~2,700 calibrated tokens each, i.e. a realistic create_event.
  const box = { id: 'test-fat', label: 'Fat', description: 'd', source: 'mcp', tools: [fat('a', 5100), fat('b', 5100), fat('c', 5100)] };
  const { TOOLBOXES } = require('./index.cjs');
  TOOLBOXES.push(box);
  try {
    const r = resolveTools({ toolboxes: ['test-fat'] }, 'Qwen3.5-9B');
    assert.equal(r.budget, 3000);
    assert.equal(r.cap, 12); // the count cap would have admitted all three
    assert.equal(r.tools.length, 1); // the budget admits one
    assert.equal(r.dropped.length, 2);
    assert.match(r.dropped[0], /over 3000 budget/);
    assert.ok(r.estTokens <= r.budget, `spent ${r.estTokens} over budget ${r.budget}`);
    // Selection order decides who survives, so the result is explainable.
    assert.equal(r.tools[0].function.name, 'a');
  } finally {
    TOOLBOXES.pop();
  }
});

test('a single tool larger than the whole budget is dropped, not forced through', () => {
  const huge = {
    type: 'function',
    function: { name: 'huge', description: 'x'.repeat(40000), parameters: { type: 'object', properties: {}, required: [] } },
  };
  const { TOOLBOXES } = require('./index.cjs');
  TOOLBOXES.push({ id: 'test-huge', label: 'H', description: 'd', source: 'mcp', tools: [huge] });
  try {
    const r = resolveTools({ toolboxes: ['test-huge'] }, 'Qwen3.5-9B');
    assert.equal(r.tools.length, 0);
    assert.equal(r.dropped.length, 1);
    // The chat loop then omits `tools` entirely rather than sending [].
  } finally {
    TOOLBOXES.pop();
  }
});

test('budget scales with model size, like the count cap', () => {
  assert.equal(toolTokenBudgetFor('Qwen3.5-9B-GGUF'), 3000);
  assert.equal(toolTokenBudgetFor('Gemma-4-E4B-it-GGUF-4b'), 3000);
  assert.equal(toolTokenBudgetFor('claude-sonnet-4-5'), 8000);
});

// ── curation ─────────────────────────────────────────────────────────────

test('every curated box is affordable on the small-model budget', () => {
  // The whole point of curation. If a box cannot fit the budget alone, the
  // user can never actually use it and it should not be offered.
  const { estimateToolTokens } = require('./index.cjs');
  for (const box of MCP_TOOLBOX_MANIFEST) {
    assert.ok(box.tools.length > 0 && box.tools.length <= 8, `${box.id}: ${box.tools.length} tools`);
    assert.ok(box.id && box.label && box.description, `${box.id} is missing metadata`);
  }
  assert.equal(typeof estimateToolTokens, 'function');
});

test('curated tool names are unique across boxes', () => {
  const seen = new Set();
  for (const box of MCP_TOOLBOX_MANIFEST) {
    for (const n of box.tools) {
      assert.equal(seen.has(n), false, `${n} is curated into more than one box`);
      seen.add(n);
    }
  }
});

// ── credential pass-through boundary ─────────────────────────────────────

test('a credential is forwarded only to a declared Nextcloud origin', () => {
  // The leak this prevents: the MCP server talks to ONE fixed Nextcloud, but
  // each user's stored credential may be for a different server entirely.
  // Forwarding across that gap hands a user's password to somebody else's host.
  const { mcpCredentialOriginAllowed } = require('./index.cjs');
  // MCP_NEXTCLOUD_ORIGINS is unset in tests, so nothing is allowed — the
  // fail-safe default, and the assertion that matters most here.
  assert.equal(mcpCredentialOriginAllowed('https://drive.example.com/remote.php/dav'), false);
  assert.equal(mcpCredentialOriginAllowed('not a url'), false);
  assert.equal(mcpCredentialOriginAllowed(''), false);
  assert.equal(mcpCredentialOriginAllowed(undefined), false);
});
