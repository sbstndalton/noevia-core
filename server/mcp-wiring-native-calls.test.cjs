'use strict';
// Track R5: with NOEVIA_RUST_MCP_CALLS on, a routed MCP tool call is the Rust front's (POST /v1/mcp/call,
// noevia-rs mcp_call.rs). This process sends the scope's facts, keeps the routing and the reducer, and falls
// back to its own transport only when the front says it runs no calls (404). Fakes only; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMcpWiring, createCredentialOriginCheck } = require('./mcp-wiring.cjs');

const SERVERS = [
  { id: 'noevia', url: 'http://127.0.0.1:9/mcp', auth: 'internal' },
  { id: 'nextcloud', url: 'http://nc.lan:8000/mcp', auth: 'nextcloud' },
  { id: 'open', url: 'http://open.lan:9/mcp', auth: 'none' },
];
const DIRECTORY = [{ id: 'dir-keys', url: 'https://keys.example.test/mcp', auth: 'personal', directory: true, title: 'QA Keys' }];
const TOOLS = { noevia: ['project_edit_file', 'project_read_file'], nextcloud: ['nc_notes_search_notes'], open: ['open_tool'], 'dir-keys': ['keys_tool'] };

function snapshot() {
  const all = [...SERVERS, ...DIRECTORY];
  const offers = [];
  for (const s of all) for (const name of TOOLS[s.id]) offers.push({ name, server: s.id, readOnly: null, tool: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, required: [] } } } });
  return { version: 1, incarnation: 'qa', generation: 1, enabled: true, error: null, discoveredAt: 1, failedAt: 0, remoteFailStreak: 0,
    servers: all.map((s) => ({ id: s.id, url: s.url, auth: s.auth, error: null, discoveredAt: 1, toolCount: TOOLS[s.id].length })), offers, boxes: [] };
}

async function build({ enabled = true, answer = () => ({ status: 200, body: { text: 'qa text', reduce: true } }) } = {}) {
  const scope = new AsyncLocalStorage();
  const asked = [];
  const transport = [];
  const mcp = {
    resultToText: (r) => r.content.map((c) => c.text).join(''),
    async connect(url, headers) { transport.push({ url, headers }); return { session: {} }; },
    async callTool(url, _s, name) { return { content: [{ type: 'text', text: `node ran ${name}` }] }; },
    async disconnect() {},
  };
  const wiring = createMcpWiring({
    servers: SERVERS.map((s) => ({ ...s })), mcp,
    discovery: { discover: async () => snapshot() },
    directoryMcp: { asServers: () => DIRECTORY.map((s) => ({ ...s })), boxFor: () => null, headersFor: () => ({}), signal: () => 's' },
    mcpOAuth: { connected: () => true, tokenFor: async () => null, session: async () => null },
    mcpKeys: { hasKey: () => true, headers: async () => ({ 'X-Api-Key': 'qa-node-key' }) },
    directoryUrlAllowed: async () => true,
    credentialOriginAllowed: createCredentialOriginCheck('https://cloud.example.test'),
    scope,
    storageFor: () => ({ kind: 'nextcloud', baseUrl: 'https://cloud.example.test', username: 'qa-user', secret: 'qa-pass' }),
    isWriteTool: (name) => name === 'project_edit_file',
    internal: { mintToken: () => 'node-minted' }, internalKey: 'k',
    reduceToolResult: (text, { maxChars }) => ({ text: `[${maxChars}] ${text}`, reduced: false }),
    resultCap: 8000,
    logger: { log() {}, warn() {} },
    directoryCheckMs: 0,
    nativeCalls: { enabled: () => enabled, async call(payload, opts) { asked.push({ payload, signal: opts.signal }); return answer(payload); } },
  });
  await wiring.discoverMcpTools(true);
  const run = (store, name, serverId, args = { q: 'qa' }, signal) => scope.run(store, () => wiring.executeMcpToolCall(name, args, signal, serverId));
  return { wiring, asked, transport, run };
}

const signedIn = (extra = {}) => ({ workspace: { userId: 'user-1' }, authn: { user: { id: 'user-1' } }, internalCallProject: null, internalEditTarget: null, ...extra });

test('switched off, the call is this process own and the front is never asked', async () => {
  const b = await build({ enabled: false });
  assert.equal(await b.run(signedIn(), 'open_tool', 'open'), '[8000] node ran open_tool');
  assert.equal(b.asked.length, 0);
  assert.equal(b.transport.length, 1);
});

test('switched on, the front runs the call with the scope facts and Node applies the reducer', async () => {
  const b = await build();
  const signal = new AbortController().signal;
  assert.equal(await b.run(signedIn(), 'open_tool', 'open', { q: 'qa é' }, signal), '[8000] qa text');
  assert.equal(b.transport.length, 0, 'nothing is sent from this process');
  assert.deepEqual(b.asked[0].payload, { server: 'open', name: 'open_tool', arguments: { q: 'qa é' }, user: 'user-1', workspaceUser: 'user-1', project: null, editTarget: null, write: false, nextcloud: null });
  assert.equal(b.asked[0].signal, signal, 'Stop reaches the front');
});

test('the in-process server: project, approved target and write flag travel; Node mints nothing', async () => {
  const b = await build();
  await b.run(signedIn({ internalCallProject: { id: 'proj-1' }, internalEditTarget: 'digest-1' }), 'project_edit_file', 'noevia');
  assert.deepEqual(b.asked[0].payload, { server: 'noevia', name: 'project_edit_file', arguments: { q: 'qa' }, user: 'user-1', workspaceUser: 'user-1', project: 'proj-1', editTarget: 'digest-1', write: true, nextcloud: null });
});

test('nextcloud: the pass-through is supplied, except where the edit refusal comes first', async () => {
  const b = await build();
  await b.run(signedIn(), 'nc_notes_search_notes', 'nextcloud');
  assert.deepEqual(b.asked[0].payload.nextcloud, { Authorization: `Basic ${Buffer.from('qa-user:qa-pass').toString('base64')}`, 'X-Cowork-User-ID': 'user-1' });
  await b.run(signedIn({ internalEditTarget: 'digest-1' }), 'nc_notes_search_notes', 'nextcloud');
  assert.equal(b.asked[1].payload.nextcloud, null);
  assert.equal(b.asked[1].payload.editTarget, 'digest-1');
});

test('a personal server: only the account id travels, never a key from this process', async () => {
  const b = await build();
  await b.run({ authn: { user: { id: 'user-2' } } }, 'keys_tool', 'dir-keys');
  assert.deepEqual(b.asked[0].payload, { server: 'dir-keys', name: 'keys_tool', arguments: { q: 'qa' }, user: 'user-2', workspaceUser: null, project: null, editTarget: null, write: false, nextcloud: null });
  assert.equal(JSON.stringify(b.asked).includes('qa-node-key'), false);
});

test('an answer not to reduce is returned as it is', async () => {
  const b = await build({ answer: () => ({ status: 200, body: { text: 'ERROR: keys_tool needs your own key for QA Keys: Plugins → Connected → Add key.', reduce: false } }) });
  assert.equal(await b.run(signedIn(), 'keys_tool', 'dir-keys'), 'ERROR: keys_tool needs your own key for QA Keys: Plugins → Connected → Add key.');
});

test('a front that runs no calls (404) leaves the call to this process, which then stops asking', async () => {
  const b = await build({ answer: () => ({ status: 404, body: { error: 'not found' } }) });
  assert.equal(await b.run(signedIn(), 'open_tool', 'open'), '[8000] node ran open_tool');
  assert.equal(b.transport.length, 1);
  // This process's own path, refusals included.
  assert.equal(await b.run(signedIn({ internalEditTarget: 'digest-1' }), 'open_tool', 'open'),
    'ERROR: open_tool was approved as a project file edit, but "open_tool" was offered by MCP server "open"; it was not run.');
  assert.equal(b.asked.length, 1, 'asked once, then not again for a minute');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61 * 1000;
    await b.run(signedIn(), 'open_tool', 'open');
    assert.equal(b.asked.length, 2, 'asked again after a minute');
  } finally { Date.now = realNow; }
});

const UNAVAILABLE = 'ERROR calling open_tool: MCP tools are unavailable right now. Try again in a moment.';
const UNKNOWN = 'ERROR calling open_tool: the tool call did not report back, so it may or may not have run. Check before calling it again.';
const STOPPED = 'ERROR calling open_tool: This operation was aborted';

test('an answer is worded by what is known: not reached, refused, or possibly run', async () => {
  const refusedConnect = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const busy = () => { throw Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY', cause: Object.assign(new TypeError('fetch failed'), { cause: refusedConnect }) }); };
  const reset = () => { throw Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY', cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }) }); };
  const late = () => { throw Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY', cause: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }); };
  const cases = [
    [busy, UNAVAILABLE],
    [reset, UNKNOWN],
    [() => ({ status: 503, body: { error: 'unavailable' } }), UNAVAILABLE],
    [() => ({ status: 400, body: { error: 'invalid name' } }), 'ERROR calling open_tool: the tool call was refused before it ran, so nothing was changed. Do not repeat it unchanged.'],
    [() => ({ status: 500, body: { error: 'the call failed' } }), UNKNOWN],
    [() => ({ status: 200, body: { text: 5 } }), UNKNOWN],
    [() => ({ status: 200, body: null }), UNKNOWN],
    [late, STOPPED],
    [() => { throw Object.assign(new Error('The request was stopped.'), { name: 'AbortError' }); }, STOPPED],
  ];
  for (const [answer, want] of cases) {
    const b = await build({ answer });
    assert.equal(await b.run(signedIn(), 'open_tool', 'open'), want);
    assert.equal(b.transport.length, 0, 'never run here on a guess');
  }
  // A Stop that lands while the answer is read: a Stop, not an outage.
  const stop = new AbortController();
  const b = await build({ answer: () => { stop.abort(); return { status: 200, body: null }; } });
  assert.equal(await b.run(signedIn(), 'open_tool', 'open', { q: 'qa' }, stop.signal), STOPPED);
});

test('the workspace and target travel as the old path read them', async () => {
  const b = await build();
  await b.run({ authn: { user: { id: 'user-1' } } }, 'project_read_file', 'noevia');
  assert.equal(b.asked[0].payload.workspaceUser, null, 'no workspace: the front refuses the in-process server');
  await b.run({ workspace: {}, authn: { user: { id: 'user-1' } } }, 'project_read_file', 'noevia');
  assert.equal(b.asked[1].payload.workspaceUser, '', 'a workspace with no id: the token carries no user');
  await b.run(signedIn({ internalEditTarget: '' }), 'nc_notes_search_notes', 'nextcloud');
  assert.equal(b.asked[2].payload.editTarget, '');
  assert.ok(b.asked[2].payload.nextcloud, 'an empty target refuses nothing, so the pass-through is read');
  await b.run({ workspace: { userId: 'user-1' }, authn: { user: { id: 42 } } }, 'open_tool', 'open');
  assert.equal(b.asked[3].payload.user, '42');
});

test('the store client sends the call to the front and hands back its answer', async () => {
  const { createClient } = require('./project-store-client.cjs');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (JSON.parse(init.body).server === 'slow') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return new Response(JSON.stringify({ text: 'qa', reduce: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createClient({ port: 4567, token: 't'.repeat(32), fetchImpl });
  assert.deepEqual(await client.mcpCall({ server: 'open', name: 'open_tool' }), { status: 200, body: { text: 'qa', reduce: true } });
  assert.equal(seen[0].url, 'http://127.0.0.1:4567/v1/mcp/call');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['x-noevia-store-token'], 't'.repeat(32));
  const stop = new AbortController();
  const pending = client.mcpCall({ server: 'slow', name: 'x' }, { signal: stop.signal });
  stop.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
});

test('routing stays here: an unknown tool or server is refused before the front is asked', async () => {
  const b = await build();
  assert.equal(await b.run(signedIn(), 'nope', 'open'), 'ERROR: unknown tool "nope" on MCP server "open"');
  assert.equal(await b.run(signedIn(), 'nope'), 'ERROR: unknown tool "nope"');
  assert.equal(b.asked.length, 0);
});
