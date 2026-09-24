'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
// Each test file gets its own data dir so parallel runs never race on the
// default server/ui-data/secrets.key (EEXIST).
process.env.UI_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'cowork-mcp-test-'));
const mcp = require('./mcp.cjs');
const { convertTool, parseRpcBody, resultToText, readOnlyHint } = mcp;
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
  assert.deepEqual(parseRpcBody('text/event-stream', sse, 2), { jsonrpc: '2.0', id: 2, result: { tools: [] } });
  assert.deepEqual(parseRpcBody('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}', 1),
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
  assert.deepEqual(parseRpcBody('text/event-stream', sse, 7).result, { ok: true });
});

test('a server-initiated request on the stream is never mistaken for the reply', () => {
  // The parser used to take the last frame carrying an `id`. Notifications
  // have no id, so that worked by luck — but a spec-compliant server doing
  // sampling or elicitation sends a REQUEST, which does have one, before the
  // result. Taking that frame would hand the server's own question back to the
  // model as the tool's output.
  const sse = [
    'event: message',
    'data: {"jsonrpc":"2.0","id":9,"result":{"ok":true}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":99,"method":"sampling/createMessage","params":{"messages":[]}}',
    '',
  ].join('\n');
  assert.deepEqual(parseRpcBody('text/event-stream', sse, 9).result, { ok: true });
});

test('a stream with no reply to THIS request is an error naming the request', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":99,"method":"elicitation/create"}\n\n';
  assert.throws(() => parseRpcBody('text/event-stream', sse, 9), /no reply to request 9/);
});

test('a plain-JSON reply for a different request is rejected rather than used', () => {
  assert.throws(() => parseRpcBody('application/json', '{"jsonrpc":"2.0","id":41,"result":{}}', 40),
    /does not match request 40/);
});

test('an event stream carrying no JSON-RPC message is an error, not a silent empty', () => {
  assert.throws(() => parseRpcBody('text/event-stream', 'event: ping\n\n', 1), /no JSON-RPC message/);
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
  // ~2,700 marginal tokens each at chars/3.6, i.e. a realistic create_event.
  const box = { id: 'test-fat', label: 'Fat', description: 'd', source: 'mcp', tools: [fat('a', 9700), fat('b', 9700), fat('c', 9700)] };
  const { TOOLBOXES } = require('./index.cjs');
  TOOLBOXES.push(box);
  try {
    const r = resolveTools({ toolboxes: ['test-fat'] }, 'Qwen3.5-9B');
    assert.equal(r.budget, 5000);
    assert.equal(r.cap, 12); // the count cap would have admitted all three
    assert.equal(r.tools.length, 1); // the budget admits one
    assert.equal(r.dropped.length, 2);
    assert.match(r.dropped[0], /over 5000 budget/);
    assert.ok(r.estTokens <= r.budget, `spent ${r.estTokens} over budget ${r.budget}`);
    // The fixed preamble is charged once, so the total exceeds the tools alone.
    assert.ok(r.estTokens > 2700, `preamble not charged: ${r.estTokens}`);
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
  assert.equal(toolTokenBudgetFor('Qwen3.5-9B-GGUF'), 5000);
  assert.equal(toolTokenBudgetFor('Gemma-4-E4B-it-GGUF-4b'), 5000);
  assert.equal(toolTokenBudgetFor('claude-sonnet-4-5'), 8000);
});

// ── curation ─────────────────────────────────────────────────────────────

test('a box fits entirely on the smallest supported model, or it is not atomic', () => {
  // A box is the unit of selection, so it has to be all-or-nothing: if it
  // exceeds the count cap, the user picks it and silently receives part of it.
  // Asserted against the cap the code actually uses rather than a literal, so
  // this tracks the cap instead of encoding one model generation's limits.
  const { estimateToolTokens, toolCapFor } = require('./index.cjs');
  const smallestCap = toolCapFor('some-4B-model');
  for (const box of MCP_TOOLBOX_MANIFEST) {
    assert.ok(box.tools.length > 0, `${box.id} is empty`);
    assert.ok(box.tools.length <= smallestCap, `${box.id}: ${box.tools.length} tools exceeds the ${smallestCap} cap`);
    assert.ok(box.id && box.label && box.description && box.server, `${box.id} is missing metadata`);
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

// ── $ref / $defs inlining ────────────────────────────────────────────────
//
// Regression for a defect that shipped in 3cb9305 and broke the calendar box
// completely. llama.cpp builds a grammar per tool and cannot resolve $ref; it
// answers HTTP 400 for the WHOLE request rather than skipping the tool, so one
// such tool silently takes out every other tool in the box and the user gets a
// chat that never replies. Confirmed against the live endpoint 2026-09-08:
// the six-tool calendar box returned 400, and the same box minus
// nc_calendar_create_event/_update_event returned 200.

test('a local $defs ref is inlined and the $defs block removed', () => {
  const r = convertTool({
    name: 'nc_calendar_create_event',
    description: 'Create an event.',
    inputSchema: {
      type: 'object',
      properties: { reminders: { anyOf: [{ items: { $ref: '#/$defs/Reminder' }, type: 'array' }, { type: 'null' }] } },
      required: [],
      $defs: { Reminder: { type: 'object', properties: { action: { type: 'string', enum: ['DISPLAY'] } } } },
    },
  });
  assert.equal(r.ok, true);
  const p = r.tool.function.parameters;
  assert.deepEqual(p.properties.reminders.anyOf[0].items, {
    type: 'object', properties: { action: { type: 'string', enum: ['DISPLAY'] } },
  });
  // Nothing may survive that llama.cpp cannot parse.
  assert.equal(JSON.stringify(p).includes('$ref'), false);
  assert.equal(JSON.stringify(p).includes('$defs'), false);
});

test('sibling keys beside a $ref are preserved', () => {
  const r = convertTool({
    name: 'x',
    inputSchema: {
      type: 'object',
      properties: { a: { $ref: '#/$defs/T', description: 'the a field' } },
      $defs: { T: { type: 'string' } },
    },
  });
  assert.equal(r.tool.function.parameters.properties.a.type, 'string');
  assert.equal(r.tool.function.parameters.properties.a.description, 'the a field');
});

test('legacy "definitions" is resolved as well as "$defs"', () => {
  const r = convertTool({
    name: 'x',
    inputSchema: { type: 'object', properties: { a: { $ref: '#/definitions/T' } }, definitions: { T: { type: 'number' } } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.tool.function.parameters.properties.a.type, 'number');
});

test('a ref that cannot be inlined drops the tool rather than shipping it broken', () => {
  const cases = [
    // Circular: inlining would expand forever.
    [{ type: 'object', properties: { a: { $ref: '#/$defs/T' } }, $defs: { T: { properties: { b: { $ref: '#/$defs/T' } } } } }, /circular ref/],
    // Points at nothing.
    [{ type: 'object', properties: { a: { $ref: '#/$defs/Missing' } }, $defs: {} }, /not present/],
    // External refs are not ours to fetch.
    [{ type: 'object', properties: { a: { $ref: 'https://example.com/s.json' } } }, /non-local ref/],
  ];
  for (const [inputSchema, re] of cases) {
    const r = convertTool({ name: 'x', inputSchema });
    assert.equal(r.ok, false, `expected ${JSON.stringify(inputSchema).slice(0, 60)} to drop`);
    assert.match(r.reason, re);
  }
});

test('an ordinary deeply-nested schema is NOT mistaken for a runaway ref', () => {
  // The first cut of the depth guard counted structural nesting rather than
  // ref expansion, so it dropped all four calendar tools as "too deep" — a
  // fix that silently reintroduced the bug it was meant to solve.
  let deep = { type: 'string' };
  for (let i = 0; i < 20; i++) deep = { type: 'object', properties: { nested: deep } };
  const r = convertTool({ name: 'x', inputSchema: { type: 'object', properties: { a: deep }, required: [] } });
  assert.equal(r.ok, true, r.reason);
});

// ── session lifecycle ────────────────────────────────────────────────────
// Every tool call opened a session and nothing ever closed one, so a server
// holding per-session state accumulated an entry per call for as long as
// noevia ran.

test('a session is terminated with DELETE, carrying its id and auth', async () => {
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options) => { seen.push({ url, ...options }); return { ok: true, status: 200 }; };
  try {
    const session = { id: 'sess-abc' };
    assert.equal(await mcp.disconnect('https://server.invalid/mcp', session, { Authorization: 'Basic x' }), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'DELETE');
    assert.equal(seen[0].headers['mcp-session-id'], 'sess-abc');
    assert.equal(seen[0].headers.Authorization, 'Basic x');
    assert.equal(seen[0].redirect, 'error', 'the SSRF policy applies here too');
    assert.equal(session.id, null, 'the closed session is not reusable');
  } finally { global.fetch = realFetch; }
});

test('closing is best-effort: no session id is a no-op, and a refusal never throws', async () => {
  const realFetch = global.fetch;
  let called = 0;
  global.fetch = async () => { called++; throw new Error('connection reset'); };
  try {
    assert.equal(await mcp.disconnect('https://server.invalid/mcp', { id: null }), false);
    assert.equal(called, 0, 'nothing to close means nothing is sent');
    // A server that does not implement DELETE answers 405; that is not an error
    // worth surfacing, because the call it belongs to has already answered.
    assert.equal(await mcp.disconnect('https://server.invalid/mcp', { id: 'sess-x' }), false);
    assert.equal(called, 1);
  } finally { global.fetch = realFetch; }
});

test('failed handshakes close issued sessions and preserve the original error', async (t) => {
  for (const failure of ['notification', 'status', 'malformed', 'rpc', 'mismatched', 'no-session']) {
    for (const cleanup of ['ok', 'refused', 'network', 'timeout']) {
      await t.test(`${failure}; DELETE ${cleanup}`, async () => {
        const requests = [];
        const original = new Error('notification failed');
        const realFetch = global.fetch;
        global.fetch = async (url, options) => {
          requests.push({ url, ...options });
          if (options.method === 'DELETE') {
            if (cleanup === 'network') throw new Error('cleanup failed');
            if (cleanup === 'timeout') return new Promise((resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(new Error('cleanup aborted')), { once: true });
            });
            return { ok: cleanup === 'ok', status: cleanup === 'ok' ? 200 : 405 };
          }
          const body = JSON.parse(options.body);
          if (body.method === 'notifications/initialized') throw original;
          const text = failure === 'malformed' ? '{' : JSON.stringify({
            jsonrpc: '2.0', id: failure === 'mismatched' ? -1 : body.id,
            ...(failure === 'rpc' ? { error: { code: -1, message: 'initialize failed' } } : { result: { serverInfo: { name: 'fixture' } } }),
          });
          return new Response(failure === 'status' || failure === 'no-session' ? 'initialize denied' : text, {
            status: failure === 'status' || failure === 'no-session' ? 500 : 200,
            headers: { 'content-type': 'application/json', ...(failure === 'no-session' ? {} : { 'mcp-session-id': 'issued-session' }) },
          });
        };
        try {
          const expected = {
            notification: (error) => error === original,
            status: /MCP 500: initialize denied/,
            malformed: (error) => error instanceof SyntaxError,
            rpc: /MCP error -1: initialize failed/,
            mismatched: /does not match request/,
            'no-session': /MCP 500: initialize denied/,
          }[failure];
          await assert.rejects(mcp.connect('https://server.invalid/mcp', { Authorization: 'Bearer synthetic' }, 15), expected);
          const deletes = requests.filter((r) => r.method === 'DELETE');
          assert.equal(deletes.length, failure === 'no-session' ? 0 : 1);
          if (deletes.length) {
            assert.equal(deletes[0].headers['mcp-session-id'], 'issued-session');
            assert.equal(deletes[0].headers.Authorization, 'Bearer synthetic');
            assert.equal(deletes[0].headers['MCP-Protocol-Version'], '2025-06-18');
            assert.equal(deletes[0].redirect, 'error');
            assert.equal(deletes[0].signal.aborted, cleanup === 'timeout');
          }
        } finally { global.fetch = realFetch; }
      });
    }
  }
});

test('a successful handshake leaves cleanup to its caller', async () => {
  const methods = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (options.method === 'DELETE') { methods.push('DELETE'); return { ok: true }; }
    const body = JSON.parse(options.body);
    methods.push(body.method);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'fixture' } } }), {
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'successful-session' },
    });
  };
  try {
    const result = await mcp.connect('https://server.invalid/mcp');
    assert.deepEqual(result, { session: { id: 'successful-session' }, serverInfo: { name: 'fixture' } });
    assert.deepEqual(methods, ['initialize', 'notifications/initialized']);
    await mcp.disconnect('https://server.invalid/mcp', result.session);
    assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'DELETE']);
  } finally { global.fetch = realFetch; }
});

// The chat's own abort signal (browser disconnect) must stop an in-flight
// MCP call immediately rather than letting it run out its internal timeout.
test('an external abort signal cancels an in-flight call rather than waiting out the timeout', async () => {
  const realFetch = global.fetch;
  const external = new AbortController();
  let sawAbort = false;
  global.fetch = (url, options) => {
    if (options.method === 'DELETE') return Promise.resolve({ ok: true }); // best-effort session cleanup after the abort
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')); });
    });
  };
  try {
    const run = mcp.connect('https://server.invalid/mcp', {}, 30000, external.signal);
    await new Promise((r) => setTimeout(r, 5));
    external.abort();
    await assert.rejects(run, /aborted/);
    assert.equal(sawAbort, true);
  } finally { global.fetch = realFetch; }
});

// A remote MCP server is not trusted: nothing stops it from streaming an
// unbounded body instead of a real JSON-RPC reply. The client must cap what
// it buffers rather than growing memory until the timeout fires.
test('an oversized remote response body is capped, not buffered whole', async () => {
  const realFetch = global.fetch;
  const chunkSize = 1024 * 1024;
  const chunk = new Uint8Array(chunkSize).fill(97); // 'a' * 1MB, synthetic filler, well over the 8MB cap when repeated
  let aborted = false;
  global.fetch = async (url, options) => {
    options.signal.addEventListener('abort', () => { aborted = true; });
    const body = new ReadableStream({
      async pull(controller) {
        if (options.signal.aborted) { controller.error(new Error('aborted')); return; }
        controller.enqueue(chunk);
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  };
  try {
    await assert.rejects(
      mcp.connect('https://server.invalid/mcp'),
      /exceeded the 8 MB limit/,
    );
    assert.equal(aborted, true, 'the oversized fetch is aborted rather than left to finish');
  } finally { global.fetch = realFetch; }
});

// ── #202: credential headers never replace protocol headers ─────────────
test('user/key headers cannot override Content-Type, Accept, protocol version or the session id', async () => {
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    seen.push(options);
    if (options.method === 'DELETE') return { ok: true, status: 200 };
    const body = JSON.parse(options.body);
    return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
      status: body.id === undefined ? 202 : 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'real-session' },
    });
  };
  const hostile = { 'X-Api-Key': 'synthetic-key', 'mcp-session-id': 'forged', accept: 'text/html', 'CONTENT-TYPE': 'text/plain', 'Mcp-Protocol-Version': '1999-01-01' };
  try {
    const { session } = await mcp.connect('https://server.invalid/mcp', hostile, 1000);
    await mcp.callTool('https://server.invalid/mcp', session, 'synthetic_tool', {}, hostile, 1000);
    await mcp.disconnect('https://server.invalid/mcp', session, hostile);
    for (const { headers } of seen) {
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      assert.equal(Object.keys(headers).length, Object.keys(lower).length, 'no duplicate header names in different case');
      assert.equal(lower['x-api-key'], 'synthetic-key', 'the key itself is still sent');
      assert.equal(lower['mcp-protocol-version'], mcp.PROTOCOL_VERSION);
      assert.notEqual(lower['mcp-session-id'], 'forged');
      assert.notEqual(lower.accept, 'text/html');
      assert.notEqual(lower['content-type'], 'text/plain');
    }
    assert.equal(seen.at(-1).headers['mcp-session-id'], 'real-session');
  } finally { global.fetch = realFetch; }
});

// ── #185: the HTTP status travels separately from the server's body ──────
test('an HTTP failure exposes its status as httpStatus', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => new Response('synthetic server secret detail', { status: 503 });
  try {
    await assert.rejects(mcp.connect('https://server.invalid/mcp', {}, 1000), (e) => e.httpStatus === 503 && /synthetic server secret/.test(e.message));
  } finally { global.fetch = realFetch; }
});

// ── #149: an aborted caller waits at most ~1 s for session cleanup ──────
test('disconnect honours an abort signal: cleanup is capped at about a second', async () => {
  const realFetch = global.fetch;
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    const aborted = new AbortController(); aborted.abort();
    let started = Date.now();
    assert.equal(await mcp.disconnect('https://server.invalid/mcp', { id: 's1' }, {}, 5000, aborted.signal), false);
    let took = Date.now() - started;
    assert.ok(took >= 900 && took < 2500, `already-aborted cleanup took ${took} ms`);

    const later = new AbortController();
    started = Date.now();
    setTimeout(() => later.abort(), 50);
    assert.equal(await mcp.disconnect('https://server.invalid/mcp', { id: 's2' }, {}, 5000, later.signal), false);
    took = Date.now() - started;
    assert.ok(took >= 900 && took < 2500, `abort mid-cleanup took ${took} ms`);
  } finally { global.fetch = realFetch; }
});

// ── #202 (second half): paged discovery has a total budget ──────────────
test('listTools stops a server that pages forever at the page and byte budgets, keeping what it has', async () => {
  const realFetch = global.fetch, realWarn = console.warn;
  const env = { pages: process.env.MCP_LIST_TOOLS_MAX_PAGES, bytes: process.env.MCP_LIST_TOOLS_MAX_BYTES };
  let requests = 0; const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  global.fetch = async (_url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    const tools = [{ name: `t${requests}`, description: 'x'.repeat(1000), inputSchema: { type: 'object' } }];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools, nextCursor: `c${requests}` } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    delete process.env.MCP_LIST_TOOLS_MAX_PAGES; delete process.env.MCP_LIST_TOOLS_MAX_BYTES;
    let tools = await mcp.listTools('https://server.invalid/mcp', { id: 's' }, {}, 1000);
    assert.equal(requests, 20); assert.equal(tools.length, 20);
    assert.match(warnings.at(-1), /stopped after 20 pages; keeping 20 tools/);

    requests = 0; process.env.MCP_LIST_TOOLS_MAX_PAGES = '1000'; process.env.MCP_LIST_TOOLS_MAX_BYTES = '5000';
    tools = await mcp.listTools('https://server.invalid/mcp', { id: 's' }, {}, 1000);
    assert.equal(tools.length, 4, 'four ~1.1 kB definitions fit in 5000 bytes');
    assert.equal(requests, 5);
    assert.match(warnings.at(-1), /reached its 5000-byte budget; keeping 4 tools/);
  } finally {
    global.fetch = realFetch; console.warn = realWarn;
    for (const [k, v] of [['MCP_LIST_TOOLS_MAX_PAGES', env.pages], ['MCP_LIST_TOOLS_MAX_BYTES', env.bytes]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the per-page response cap still applies inside listTools', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => new Response('x'.repeat(mcp.MAX_RESPONSE_BYTES + 10), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(mcp.listTools('https://server.invalid/mcp', { id: 's' }, {}, 1000), /response body exceeded the 8 MB limit/);
  } finally { global.fetch = realFetch; }
});
