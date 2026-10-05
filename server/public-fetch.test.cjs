'use strict';
// #795: a directory MCP server's address is checked again at CONNECT time, so a
// name that passes isPublicUrl and then re-resolves to a private address (DNS
// rebinding) is refused — while the operator's own servers (a LAN Nextcloud MCP
// server, noevia's internal loopback server) keep working exactly as before.
//
// Every connection here goes to a fixture on 127.0.0.1 (tests/hermetic-network.cjs
// refuses anything else). The resolver is injected, so "resolves to 10.0.0.7"
// is simulated without any real DNS and without ever dialling that address.

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const zlib = require('node:zlib');
process.env.UI_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'cowork-public-fetch-'));
const mcp = require('./mcp.cjs');
const { createPublicFetch, createPublicOnlyLookup } = require('./public-fetch.cjs');
const { createMcpWiring } = require('./mcp-wiring.cjs');

const PRIVATE_ANSWERS = ['10.0.0.7', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1', '192.168.1.20', '::ffff:10.0.0.1'];

/** A resolver with dns.lookup's shape that answers from a list (or a function of the call count). */
function fakeResolver(answers) {
  const calls = [];
  const resolve = (hostname, options, cb) => {
    calls.push(hostname);
    const list = typeof answers === 'function' ? answers(calls.length) : answers;
    setImmediate(() => cb(null, list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))));
  };
  return { resolve, calls };
}
const lookupP = (lookup, host, opts) => new Promise((resolve, reject) => lookup(host, opts, (err, a, f) => (err ? reject(err) : resolve({ a, f }))));

// A minimal streamable-http MCP server: initialize, initialized, tools/list, tools/call, DELETE.
async function mcpFixture(t, { redirect = false } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      if (redirect) { res.writeHead(302, { location: 'http://10.0.0.7/' }); return res.end(); }
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      if (req.url === '/form') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: req.headers['content-type'], body: raw })); }
      if (req.url === '/gz') { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('{"zipped":true}')); }
      if (req.url === '/slow') return; // never answers
      const msg = JSON.parse(raw || '{}');
      if (!Object.prototype.hasOwnProperty.call(msg, 'id')) { res.writeHead(202); return res.end(); }
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: { s: { type: 'string' } } } }] }
          : msg.method === 'tools/call' ? { content: [{ type: 'text', text: `echo:${msg.params.arguments.s}` }] } : {};
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); });
  return { port: server.address().port, hits };
}

// ── the lookup ───────────────────────────────────────────────────────────

test('the lookup refuses 10.x, 127.x, 169.254.x, ::1 and fd00:: answers', async () => {
  for (const ip of PRIVATE_ANSWERS) {
    const lookup = createPublicOnlyLookup({ resolve: fakeResolver([ip]).resolve });
    await assert.rejects(lookupP(lookup, 'rebind.example', { all: true }), (e) => e.code === 'EPRIVATEADDR' && /private address/.test(e.message) && !e.message.includes(ip), ip);
    await assert.rejects(lookupP(lookup, 'rebind.example', {}), { code: 'EPRIVATEADDR' }, ip);
  }
});

test('the lookup passes a public answer through in both shapes net asks for', async () => {
  const lookup = createPublicOnlyLookup({ resolve: fakeResolver(['93.184.216.34', '2606:2800:220:1::1']).resolve });
  const all = await lookupP(lookup, 'public.example', { all: true });
  assert.deepEqual(all.a, [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
  const one = await lookupP(lookup, 'public.example', {});
  assert.deepEqual([one.a, one.f], ['93.184.216.34', 4]);
});

test('one private answer among public ones refuses the whole name', async () => {
  const lookup = createPublicOnlyLookup({ resolve: fakeResolver(['93.184.216.34', '10.0.0.7']).resolve });
  await assert.rejects(lookupP(lookup, 'mixed.example', { all: true }), { code: 'EPRIVATEADDR' });
});

test('no answer, or a resolver error, fails the connection', async () => {
  await assert.rejects(lookupP(createPublicOnlyLookup({ resolve: fakeResolver([]).resolve }), 'none.example', { all: true }), { code: 'ENOTFOUND' });
  const failing = (h, o, cb) => setImmediate(() => cb(Object.assign(new Error('boom'), { code: 'EAI_AGAIN' })));
  await assert.rejects(lookupP(createPublicOnlyLookup({ resolve: failing }), 'x.example', { all: true }), { code: 'EAI_AGAIN' });
});

// ── the fetch, at connect time ───────────────────────────────────────────

test('a name that resolves to a private address is refused at connect and never reaches the server', async (t) => {
  const fx = await mcpFixture(t);
  for (const ip of PRIVATE_ANSWERS) {
    const r = fakeResolver([ip]);
    const publicFetch = createPublicFetch({ resolve: r.resolve });
    await assert.rejects(publicFetch(`http://localhost:${fx.port}/mcp`, { method: 'POST', body: '{}' }), { code: 'EPRIVATEADDR' }, ip);
    assert.deepEqual(r.calls, ['localhost'], 'the name was resolved by the connect-time lookup');
  }
  assert.equal(fx.hits.length, 0);
});

test('a public answer connects, and a full MCP round trip works through it', async (t) => {
  const fx = await mcpFixture(t);
  // 127.0.0.1 stands in for a public address: the only place a hermetic test can connect to.
  const r = fakeResolver(['127.0.0.1']);
  const publicFetch = createPublicFetch({ resolve: r.resolve, isPublicAddress: (ip) => ip === '127.0.0.1' });
  const client = mcp.withFetch(publicFetch);
  const url = `http://localhost:${fx.port}/mcp`;
  const { session } = await client.connect(url, { Authorization: 'Bearer k' });
  assert.equal(session.id, 'sess-1');
  const tools = await client.listTools(url, session, { Authorization: 'Bearer k' });
  assert.deepEqual(tools.map((x) => x.name), ['echo']);
  const result = await client.callTool(url, session, 'echo', { s: 'hi' }, { Authorization: 'Bearer k' });
  assert.equal(mcp.resultToText(result), 'echo:hi');
  assert.equal(await client.disconnect(url, session, { Authorization: 'Bearer k' }), true);
  assert.deepEqual(fx.hits.map((h) => h.method), ['POST', 'POST', 'POST', 'POST', 'DELETE']);
  assert.equal(fx.hits[0].headers.authorization, 'Bearer k');
  assert.equal(fx.hits[0].headers['content-type'], 'application/json');
  assert.ok(r.calls.length >= 1 && r.calls.every((h) => h === 'localhost'));
});

test('an IP literal is judged without a lookup; only the QA flag admits 127.0.0.1', async (t) => {
  const fx = await mcpFixture(t);
  const strict = createPublicFetch({ resolve: () => assert.fail('a literal is never looked up') });
  await assert.rejects(strict(`http://127.0.0.1:${fx.port}/mcp`, { method: 'POST', body: '{}' }), { code: 'EPRIVATEADDR' });
  await assert.rejects(strict('http://10.0.0.7/mcp'), { code: 'EPRIVATEADDR' });
  await assert.rejects(strict('http://[::1]/mcp'), { code: 'EPRIVATEADDR' });
  await assert.rejects(strict('http://[fd00::1]/mcp'), { code: 'EPRIVATEADDR' });
  assert.equal(fx.hits.length, 0);
  const qa = createPublicFetch({ allowLoopbackLiteral: true });
  const res = await qa(`http://127.0.0.1:${fx.port}/form`, { method: 'POST', body: 'a=1' });
  assert.equal(res.status, 200);
  await assert.rejects(qa('http://10.0.0.7/mcp'), { code: 'EPRIVATEADDR' }, 'the QA flag admits loopback only');
});

test('redirects are refused, as redirect:"error" does with fetch', async (t) => {
  const fx = await mcpFixture(t, { redirect: true });
  const publicFetch = createPublicFetch({ allowLoopbackLiteral: true });
  await assert.rejects(publicFetch(`http://127.0.0.1:${fx.port}/x`, { redirect: 'error' }), /redirect \(302\)/);
});

test('fetch-shaped details: form bodies, gzip, other schemes, credentials in the URL, abort', async (t) => {
  const fx = await mcpFixture(t);
  const publicFetch = createPublicFetch({ allowLoopbackLiteral: true });
  const form = await (await publicFetch(`http://127.0.0.1:${fx.port}/form`, { method: 'POST', body: new URLSearchParams({ a: '1', b: 'two' }) })).json();
  assert.deepEqual(form, { type: 'application/x-www-form-urlencoded;charset=UTF-8', body: 'a=1&b=two' });
  assert.deepEqual(await (await publicFetch(`http://127.0.0.1:${fx.port}/gz`)).json(), { zipped: true });
  await assert.rejects(publicFetch('file:///etc/passwd'), /not http/);
  await assert.rejects(publicFetch(`http://u:p@127.0.0.1:${fx.port}/form`), /credentials/);
  await assert.rejects(publicFetch(`http://127.0.0.1:${fx.port}/slow`, { signal: AbortSignal.timeout(50) }), (e) => /abort|timeout/i.test(`${e.name} ${e.message}`));
});

// ── through the MCP wiring ───────────────────────────────────────────────

function wiring({ servers, publicFetch, directoryUrlAllowed = async () => true, warnings = [] }) {
  return createMcpWiring({
    servers, mcp, publicFetch, directoryUrlAllowed,
    bindBoxes: () => [], directoryMcp: { asServers: () => [], headersFor: () => ({}) }, mcpOAuth: {},
    credentialOriginAllowed: () => false,
    scope: { getStore: () => ({ workspace: { userId: 'alice' }, authn: { user: { id: 'alice' } } }) },
    storageFor: () => ({}), isWriteTool: () => false,
    internal: { mintToken: () => 'internal-token' }, internalKey: 'k',
    reduceToolResult: (text) => ({ text, reduced: false }),
    logger: { log() {}, warn: (line) => warnings.push(line) },
  });
}

test('DNS rebinding against a directory server: the check passes, the connection is refused', async (t) => {
  const fx = await mcpFixture(t);
  // First answer public (what directoryUrlAllowed sees), every later answer private.
  const r = fakeResolver((n) => (n === 1 ? ['93.184.216.34'] : ['10.0.0.7']));
  const resolveP = (host) => new Promise((ok) => r.resolve(host, { all: true }, (e, list) => ok(list.map((a) => a.address))));
  const directoryUrlAllowed = async (url) => (await resolveP(new URL(url).hostname)).every((ip) => !require('./ssrf.cjs').isPrivateIp(ip));
  const url = `http://localhost:${fx.port}/mcp`;
  const w = wiring({ servers: [], publicFetch: createPublicFetch({ resolve: r.resolve }), directoryUrlAllowed });
  await assert.rejects(w.discoverOneServer({ id: 'dir-x', url, auth: 'none', directory: true }), { code: 'EPRIVATEADDR' });
  assert.equal(r.calls.length, 2, 'checked once by directoryUrlAllowed, refused once at connect');
  assert.equal(fx.hits.length, 0);
});

test('a directory server that rebinds is refused for tool calls and the auth probe too', async (t) => {
  const fx = await mcpFixture(t);
  const url = `http://localhost:${fx.port}/mcp`;
  const server = { id: 'dir-x', url, auth: 'none', directory: true };
  const w = wiring({ servers: [server], publicFetch: createPublicFetch({ resolve: fakeResolver(['169.254.169.254']).resolve }) });
  w.state.tools.set('echo', { tool: {}, readOnly: true, serverId: 'dir-x' });
  const out = await w.executeMcpToolCall('echo', { s: 'x' });
  assert.match(out, /^ERROR calling echo: refused: localhost resolves to a private address/);
  assert.deepEqual(await w.probeMcpAuth(url), { status: 0, challenge: '' });
  assert.equal(fx.hits.length, 0);
});

test("the operator's LAN server and the internal loopback server are unaffected", async (t) => {
  const fx = await mcpFixture(t);
  // A publicFetch that would refuse every connection: if either server went through it, it would fail.
  const publicFetch = createPublicFetch({ resolve: fakeResolver(['10.0.0.7']).resolve });
  const lan = { id: 'nextcloud', url: `http://localhost:${fx.port}/mcp`, auth: 'none' }; // a name on the home network
  const internalSv = { id: 'noevia', url: `http://127.0.0.1:${fx.port}/mcp`, auth: 'internal' };
  const w = wiring({ servers: [lan, internalSv], publicFetch });
  assert.deepEqual([...(await w.discoverOneServer(lan)).keys()], ['echo']);
  assert.deepEqual([...(await w.discoverOneServer(internalSv)).keys()], ['echo']);
  w.state.tools.set('echo', { tool: {}, readOnly: true, serverId: 'noevia' });
  assert.equal(await w.executeMcpToolCall('echo', { s: 'in' }), 'echo:in');
  assert.ok(fx.hits.some((h) => h.headers.authorization === 'Bearer internal-token'));
  w.state.tools.set('echo', { tool: {}, readOnly: true, serverId: 'nextcloud' });
  assert.equal(await w.executeMcpToolCall('echo', { s: 'lan' }), 'echo:lan');
});

test('a directory server whose name stays public works end to end through the wiring', async (t) => {
  const fx = await mcpFixture(t);
  const publicFetch = createPublicFetch({ resolve: fakeResolver(['127.0.0.1']).resolve, isPublicAddress: (ip) => ip === '127.0.0.1' });
  const server = { id: 'dir-ok', url: `http://localhost:${fx.port}/mcp`, auth: 'none', directory: true };
  const w = wiring({ servers: [server], publicFetch });
  assert.deepEqual([...(await w.discoverOneServer(server)).keys()], ['echo']);
  w.state.tools.set('echo', { tool: {}, readOnly: true, serverId: 'dir-ok' });
  assert.equal(await w.executeMcpToolCall('echo', { s: 'ok' }), 'echo:ok');
});

test('wiring refuses a publicFetch it cannot use rather than silently skipping it', () => {
  assert.throws(() => createMcpWiring({
    servers: [], mcp: { convertTool() {} }, publicFetch: async () => {}, directoryMcp: { asServers: () => [] },
    logger: { log() {}, warn() {} },
  }), /withFetch/);
});

// ── OAuth endpoints of a directory server (mcp-oauth.cjs gets the same fetch) ──

async function oauthFixture(t, { tokenHost = '127.0.0.1', pad = 0 } = {}) {
  const crypto = require('node:crypto');
  const codes = new Map();
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits.push(req.url);
      const base = `http://127.0.0.1:${server.address().port}`;
      const json = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/.well-known/oauth-protected-resource/mcp') return json({ resource: `${base}/mcp`, authorization_servers: [`${base}/as`] });
      if (req.url === '/.well-known/oauth-authorization-server/as') {
        return json({ ...(pad ? { pad: 'x'.repeat(pad) } : {}), issuer: `${base}/as`, authorization_endpoint: `${base}/as/authorize`, token_endpoint: `http://${tokenHost}:${server.address().port}/as/token`, registration_endpoint: `${base}/as/register`, code_challenge_methods_supported: ['S256'] });
      }
      if (req.url === '/as/register') return json({ client_id: 'client-1' }, 201);
      if (req.url === '/as/token') {
        const q = new URLSearchParams(raw);
        const ok = req.headers['content-type'].startsWith('application/x-www-form-urlencoded')
          && crypto.createHash('sha256').update(q.get('code_verifier') || '').digest('base64url') === codes.get(q.get('code'));
        return ok ? json({ access_token: 'AT-1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
      }
      return json({}, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); });
  return { port: server.address().port, hits, codes };
}
function oauthWith(publicFetch) {
  const Database = require('better-sqlite3');
  const secrets = { encrypt: (v) => 'enc:' + Buffer.from(v).toString('base64'), decrypt: (v) => Buffer.from(v.slice(4), 'base64').toString() };
  return require('./mcp-oauth.cjs').createMcpOAuth({ db: new Database(':memory:'), secrets, fetchImpl: publicFetch, urlAllowed: async () => true, redirectUri: () => 'https://noevia.example/api/mcp-oauth/callback' });
}
async function signIn(oauth, fx) {
  const url = new URL(await oauth.start({ userId: 'u1', serverId: 'dir-x', serverUrl: `http://127.0.0.1:${fx.port}/mcp` }));
  const code = `CODE-${Math.random()}`;
  fx.codes.set(code, url.searchParams.get('code_challenge'));
  await oauth.finish({ userId: 'u1', state: url.searchParams.get('state'), code });
}

test('OAuth sign-in to a directory server works through the public fetch (QA loopback)', async (t) => {
  const fx = await oauthFixture(t);
  const oauth = oauthWith(createPublicFetch({ allowLoopbackLiteral: true }));
  await signIn(oauth, fx);
  assert.equal(await oauth.tokenFor('u1', 'dir-x'), 'AT-1');
  assert.ok(fx.hits.includes('/as/token'));
});

test('an OAuth endpoint whose name resolves privately is refused at connect', async (t) => {
  // The metadata names its token endpoint by a name ("localhost") that resolves to loopback.
  const fx = await oauthFixture(t, { tokenHost: 'localhost' });
  const oauth = oauthWith(createPublicFetch({ allowLoopbackLiteral: true }));
  await assert.rejects(signIn(oauth, fx), { code: 'EPRIVATEADDR' });
  assert.equal(fx.hits.includes('/as/token'), false);
});

// ── a hostile server cannot crash the process ────────────────────────────

async function rawServer(t, reply) {
  const net = require('node:net');
  const server = net.createServer((sock) => { sock.on('error', () => {}); sock.once('data', () => sock.end(reply)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return server.address().port;
}

test('a reason phrase Response rejects (control characters) fails the request, not the process', async (t) => {
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  // node:test installs its own handler; listen alongside it to see whether anything escaped.
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  const publicFetch = createPublicFetch({ allowLoopbackLiteral: true });
  const port = await rawServer(t, 'HTTP/1.1 200 O\x01K\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
  // Either outcome is acceptable — the phrase dropped and the body read, or a rejection — as long
  // as nothing is thrown out of the response event.
  const outcome = await publicFetch(`http://127.0.0.1:${port}/`).then(async (r) => ({ status: r.status, statusText: r.statusText, body: await r.text() }), (e) => ({ error: e }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(uncaught, []);
  if (!outcome.error) assert.deepEqual(outcome, { status: 200, statusText: '', body: '{}' });
});

test('a throw while building the Response rejects the request and is never uncaught', async (t) => {
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  const RealResponse = globalThis.Response;
  globalThis.Response = function () { throw new TypeError('synthetic Response failure'); };
  t.after(() => { globalThis.Response = RealResponse; });
  const port = await rawServer(t, 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
  await assert.rejects(createPublicFetch({ allowLoopbackLiteral: true })(`http://127.0.0.1:${port}/`), /synthetic Response failure/);
  globalThis.Response = RealResponse;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(uncaught, []);
});

test('an OAuth metadata body past the size cap is treated as no metadata', async (t) => {
  // Valid metadata in every respect except its size: under the cap it signs in, over it it does not.
  const small = await oauthFixture(t, { pad: 100 * 1024 });
  await signIn(oauthWith(createPublicFetch({ allowLoopbackLiteral: true })), small);
  const big = await oauthFixture(t, { pad: 300 * 1024 });
  await assert.rejects(oauthWith(createPublicFetch({ allowLoopbackLiteral: true })).start({ userId: 'u1', serverId: 'dir-x', serverUrl: `http://127.0.0.1:${big.port}/mcp` }), /did not describe itself/);
  assert.equal(big.hits.includes('/as/register'), false);
});
