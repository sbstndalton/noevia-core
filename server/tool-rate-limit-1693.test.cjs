'use strict';
// #1693: a tool provider answering 429 gives the model a retryable error and is not called again inside its
// backoff; a per-account key never pauses another account. Fake MCP client, synthetic server, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMcpWiring } = require('./mcp-wiring.cjs');
const { createToolRateLimit, isRateLimitedText, parseRetryAfter, BASE_MS, MAX_MS } = require('./tool-rate-limit.cjs');

const rawTool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });

function build({ auth = 'bearer', answer }) {
  const calls = [];
  let clock = 1_000_000;
  const mcp = {
    async connect() { return { session: 0 }; },
    async disconnect() {},
    async listTools() { return [rawTool('synthetic_search')]; },
    async callTool(url, _s, name, args, headers) { calls.push({ name, headers }); return answer(calls.length); },
    convertTool(t) { return { ok: true, tool: { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } } }; },
    readOnlyHint() { return true; },
    resultToText(r) { const t = r.content.map((c) => c.text).join(''); return r.isError ? `ERROR from tool: ${t}` : t; },
  };
  const scope = new AsyncLocalStorage();
  const server = { id: 'synthetic-search', url: 'http://search.invalid/mcp', auth, tokenEnv: 'SYNTH_TOKEN' };
  const wiring = createMcpWiring({
    servers: [server], manifest: [{ id: 'web-search', server: 'synthetic-search' }], mcp,
    bindBoxes: ({ manifest, perServer }) => manifest.map((m) => ({ id: m.id, tools: [...(perServer.get(m.server) || new Map()).values()].map((e) => e.tool), server: m.server })),
    directoryMcp: { asServers: () => [], headersFor: () => ({}), userHeadersFor: (uid) => ({ 'X-Key': `key-${uid}` }), hasUserKey: () => true },
    mcpOAuth: { connected: () => false, tokenFor: async () => null },
    directoryUrlAllowed: async () => true, credentialOriginAllowed: () => true,
    scope, storageFor: (uid) => ({ kind: 'nextcloud', username: `synthetic-${uid}`, secret: 'synthetic-secret', baseUrl: 'https://cloud.example.invalid' }), isWriteTool: () => false,
    internal: { mintToken: () => 'cap' }, internalKey: 'k', reduceToolResult: (text) => ({ text, reduced: false }),
    env: { SYNTH_TOKEN: 'synthetic' }, logger: { log() {}, warn() {} },
    toolRateLimit: createToolRateLimit({ now: () => clock }),
  });
  const call = (userId = 'user-a') => scope.run({ workspace: { userId }, authn: { user: { id: userId } } }, () => wiring.executeMcpToolCall('synthetic_search', { query: 'q' }));
  return { wiring, calls, call, advance: (ms) => { clock += ms; } };
}

const LIMITED = { isError: true, content: [{ type: 'text', text: 'Request failed with status code 429: rate limit exceeded' }] };
const OK = { content: [{ type: 'text', text: 'synthetic result https://example.invalid/a' }] };

test('#1693: a 429 tool error is a retryable error, and the next call inside the backoff is not sent', async () => {
  const b = build({ answer: () => LIMITED });
  await b.wiring.discoverMcpTools();
  const first = await b.call();
  assert.match(first, /^ERROR: synthetic_search was rate limited by its provider \(HTTP 429\)\. This is retryable/);
  assert.match(first, /wait about 15 s/);
  const second = await b.call();
  assert.match(second, /^ERROR: synthetic_search was not called: its provider is rate limiting requests \(HTTP 429\)/);
  assert.equal(b.calls.length, 1, 'the provider got one request, not two');
});

test('#1693: the backoff doubles on repeated 429s, and a success clears it', async () => {
  let mode = 'limited';
  const b = build({ answer: () => (mode === 'limited' ? LIMITED : OK) });
  await b.wiring.discoverMcpTools();
  await b.call();
  b.advance(BASE_MS + 1);
  assert.match(await b.call(), /wait about 30 s/, 'second strike waits twice as long');
  b.advance(2 * BASE_MS + 1);
  mode = 'ok';
  assert.match(await b.call(), /synthetic result/);
  mode = 'limited';
  assert.match(await b.call(), /wait about 15 s/, 'a success reset the strikes');
});

test('#1693: an HTTP 429 honours Retry-After within the cap', async () => {
  const b = build({ answer: () => { throw Object.assign(new Error('MCP 429: slow down'), { httpStatus: 429, retryAfter: '42' }); } });
  await b.wiring.discoverMcpTools();
  assert.match(await b.call(), /HTTP 429\)\. This is retryable, but not now: wait about 42 s/);
  b.advance(41_000);
  assert.match(await b.call(), /was not called/);
  b.advance(2_000);
  await b.call();
  assert.equal(b.calls.length, 2);
});

test('#1693: a per-account key in backoff does not pause another account', async () => {
  const b = build({ auth: 'personal', answer: () => LIMITED });
  await b.wiring.discoverMcpTools();
  await b.call('user-a');
  assert.match(await b.call('user-a'), /was not called/);
  assert.match(await b.call('user-b'), /was rate limited by its provider/, 'user-b is called with its own key');
  assert.equal(b.calls.length, 2);
});

test('#1693: rate-limit helpers', () => {
  assert.equal(isRateLimitedText('HTTP 429 Too Many Requests'), true);
  assert.equal(isRateLimitedText('Too Many Requests'), true);
  assert.equal(isRateLimitedText('usage limit reached for this key'), true);
  assert.equal(isRateLimitedText('Rust 1.99.0 released'), false);
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(''), null);
  const rl = createToolRateLimit({ now: () => 0 });
  for (let i = 0; i < 20; i++) rl.hit('k');
  assert.equal(rl.remaining('k'), MAX_MS, 'the backoff is capped');
});

test('#1701: a Nextcloud-credential server is throttled per account: one account never pauses another', async () => {
  const b = build({ auth: 'nextcloud', answer: () => LIMITED });
  await b.wiring.discoverMcpTools();
  assert.match(await b.call('user-a'), /was rate limited by its provider/);
  assert.match(await b.call('user-a'), /was not called/);
  assert.match(await b.call('user-b'), /was rate limited by its provider/, 'user-b is called with its own credentials');
  assert.equal(b.calls.length, 2);
});

test('#1701: a bare 429 in a tool error is not a rate limit; HTTP 429 or status 429 is', () => {
  assert.equal(isRateLimitedText('ERROR: note 429 not found'), false);
  assert.equal(isRateLimitedText('ERROR from tool: issue #429 is closed'), false);
  assert.equal(isRateLimitedText('Request failed with status code 429'), true);
  assert.equal(isRateLimitedText('upstream answered HTTP 429'), true);
  assert.equal(isRateLimitedText('status 429'), true);
});

test('#1701: expired entries are pruned', () => {
  let clock = 0;
  const rl = createToolRateLimit({ now: () => clock });
  rl.hit('a'); rl.hit('b');
  assert.equal(rl.size(), 2);
  clock = BASE_MS + MAX_MS + 1;
  assert.equal(rl.remaining('a'), 0);
  assert.equal(rl.size(), 0, 'both stale keys are gone, not only the one looked up');
});
