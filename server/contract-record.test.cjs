'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { MARKER, createContractRecorder, createNormaliser, fromEnv, parseSse } = require('./contract-record.cjs');

// Synthetic values only. Each must never appear in anything the recorder writes.
const SECRETS = {
  password: 'synthetic-Passw0rd-for-contract-tests',
  session: 'S3ssionTokenSynthetic0123456789abcdefABCDEF',
  csrf: 'CsrfTokenSynthetic9876543210zyxwvuZYXWVU_-',
  bearer: 'BearerSynthetic_aZ09aZ09aZ09aZ09aZ09',
  apiKey: 'sk-synthetic-provider-key-0001',
  envKey: 'env-inference-key-synthetic-77',
  queryToken: 'invite-token-synthetic-55',
  setupCode: 'SETUP-1234-5678',
  numericPin: 834201,
};
const PROJECT_ID = '3f2c1a9e-8b7d-4c6e-9f10-1234567890ab';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'contract-record-')); }
function readAll(dir) { return fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'); }
function records(dir) { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }

async function serve(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

// A stand-in for the real routes: sign-in sets the two cookies, a project read echoes secrets in
// several shapes, an SSE route streams JSON events.
async function app(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/auth/login/password') {
    const body = JSON.parse(await readBody(req));
    res.setHeader('Set-Cookie', [`cowork_session=${SECRETS.session}; Path=/; HttpOnly; SameSite=Lax`, `cowork_csrf=${SECRETS.csrf}; Path=/; SameSite=Lax; Expires=Wed, 21 Oct 2026 07:28:00 GMT`]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ user: { id: PROJECT_ID.replace('3f', '4a'), username: body.username }, csrfToken: SECRETS.csrf, echoedPassword: body.password }));
  }
  if (url.pathname === `/api/projects/${PROJECT_ID}`) {
    await readBody(req);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Noevia-API', '1');
    return res.end(JSON.stringify({
      project: { id: PROJECT_ID, name: 'Synthetic project', createdAt: 1760000000000, updatedAt: '2026-10-09T12:34:56.789Z' },
      provider: { apiKey: SECRETS.apiKey, label: `uses ${SECRETS.envKey} upstream` },
      setupCode: SECRETS.setupCode,
      pin: SECRETS.numericPin,
      note: `token in prose: ${SECRETS.bearer}`,
      queryEcho: url.searchParams.get('token'),
    }));
  }
  if (url.pathname === '/api/chat') {
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': ping\n\n');
    res.write(`data: ${JSON.stringify({ type: 'start', chatId: PROJECT_ID, at: '2026-10-09T00:00:00Z' })}\n\n`);
    res.write(`event: delta\ndata: ${JSON.stringify({ text: 'Hel' })}\n\n`);
    res.write(`data: ${JSON.stringify({ text: 'lo' })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html>static</html>');
}

async function exercise(base) {
  const login = await fetch(`${base}/api/auth/login/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://noevia.example' }, body: JSON.stringify({ username: 'synthetic-user', password: SECRETS.password }) });
  const loginText = await login.text();
  const cookie = `cowork_session=${SECRETS.session}; cowork_csrf=${SECRETS.csrf}`;
  const project = await fetch(`${base}/api/projects/${PROJECT_ID}?token=${SECRETS.queryToken}`, { headers: { Cookie: cookie, 'X-CSRF-Token': SECRETS.csrf, Authorization: `Bearer ${SECRETS.bearer}` } });
  const projectText = await project.text();
  const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': SECRETS.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }) });
  const chatText = await chat.text();
  const page = await (await fetch(`${base}/index.html`)).text();
  return { loginText, projectText, chatText, page, status: [login.status, project.status, chat.status] };
}

test('fromEnv is off unless NOEVIA_CONTRACT_RECORD names a directory', () => {
  assert.equal(fromEnv({}), null);
  assert.equal(fromEnv({ NOEVIA_CONTRACT_RECORD: '' }), null);
  assert.equal(fromEnv({ NOEVIA_CONTRACT_RECORD: '   ' }), null);
  assert.equal(createContractRecorder({}), null);
});

test('the wrapped handler answers byte-for-byte what the bare handler answers', async () => {
  const bare = await serve(app, exercise);
  const dir = tmp();
  const recorder = createContractRecorder({ dir, env: {} });
  const wrapped = await serve(recorder.wrap(app), exercise);
  assert.deepEqual(wrapped, bare);
});

test('no secret value is ever written, in any file, in any shape the server echoes it', async () => {
  const dir = tmp();
  const recorder = createContractRecorder({ dir, env: { INFERENCE_API_KEY: SECRETS.envKey, UI_PORT: '8021' }, origin: 'https://noevia.example' });
  await serve(recorder.wrap(app), exercise);
  await new Promise((r) => setImmediate(r));
  const all = readAll(dir);
  assert.ok(all.length > 0);
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!all.includes(String(value)), `${name} leaked into the corpus`);
  }
  // The decoded form of a URL-borne secret is covered too.
  assert.ok(!all.includes(encodeURIComponent(SECRETS.queryToken)));
  for (const f of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o077, 0, `${f} is readable by others`);
});

test('one value keeps one placeholder across cookie, header and body, so a replayer can bind it', async () => {
  const dir = tmp();
  const recorder = createContractRecorder({ dir, env: {}, origin: 'https://noevia.example' });
  await serve(recorder.wrap(app), exercise);
  const [login, project, chat] = records(dir);
  assert.equal(records(dir).length, 3, 'non-/api paths are not recorded');
  const csrf = login.response.body.json.csrfToken;
  assert.match(csrf, /^<secret:\d+>$/);
  assert.ok(login.response.headers['set-cookie'].some((c) => c.startsWith(`cowork_csrf=${csrf};`)));
  assert.ok(login.response.headers['set-cookie'][1].includes('Expires=<ts>'));
  assert.equal(project.request.headers['x-csrf-token'], csrf);
  assert.match(project.request.headers.cookie, new RegExp(`cowork_csrf=${csrf.replace(/[<>:]/g, (c) => `\\${c}`)}`));
  assert.match(project.request.headers.authorization, /^Bearer <secret:\d+>$/);
  assert.equal(login.request.headers.origin, '<origin>');
  assert.equal(login.request.body.json.password, login.response.body.json.echoedPassword);

  const pid = project.response.body.json.project.id;
  assert.match(pid, /^<id:\d+>$/);
  assert.equal(project.request.path, `/api/projects/${pid}`);
  assert.equal(chat.request.body.json.projectId, pid);
  assert.equal(project.response.body.json.project.createdAt, '<ts>');
  assert.equal(project.response.body.json.project.updatedAt, '<ts>');
  assert.equal(project.response.body.json.project.name, 'Synthetic project');
  assert.match(project.response.body.json.pin, /^<secret:\d+>$/);
  assert.deepEqual(project.request.query.map(([k]) => k), ['token']);
  assert.equal(project.response.body.json.queryEcho, project.request.query[0][1]);
  assert.equal(project.response.headers['x-noevia-api'], '1');
  assert.equal(project.response.headers.date, undefined, 'volatile headers are dropped');
  assert.equal(project.response.status, 200);
});

test('an event stream is recorded as its event sequence, keep-alive comments dropped', async () => {
  const dir = tmp();
  const recorder = createContractRecorder({ dir, env: {} });
  await serve(recorder.wrap(app), exercise);
  const chat = records(dir).find((r) => r.request.path === '/api/chat');
  assert.equal(chat.response.body.kind, 'sse');
  const events = chat.response.body.events;
  assert.equal(events.length, 4);
  assert.match(events[0].data.chatId, /^<id:\d+>$/);
  assert.equal(events[0].data.at, '<ts>');
  assert.deepEqual(events[1], { event: 'delta', data: { text: 'Hel' }, json: true });
  assert.deepEqual(events[3], { data: '[DONE]' });
});

test('parseSse joins multi-line data and keeps non-JSON data as text', () => {
  const norm = createNormaliser();
  assert.deepEqual(parseSse('data: a\ndata: b\n\nid: 7\ndata: {"x":1}\n\n', norm), [{ data: 'a\nb' }, { id: '7', data: { x: 1 }, json: true }]);
});

test('the leak check catches a raw secret the field rules missed', () => {
  const norm = createNormaliser({ envSecrets: ['env-secret-value-xyz'] });
  assert.equal(norm.leaks('{"a":"nothing here"}'), false);
  assert.equal(norm.leaks('{"a":"prefix env-secret-value-xyz suffix"}'), true);
  assert.equal(norm.text('prefix env-secret-value-xyz suffix'), 'prefix <secret:1> suffix');
});

test('an exchange whose text still holds a secret is dropped, not written', async () => {
  const dir = tmp();
  const recorder = createContractRecorder({ dir, env: {} });
  // JSON object keys are kept verbatim (they are the schema), so a secret used as a key is the
  // shape the field rules cannot rewrite; the leak check is what keeps it off disk.
  recorder.normaliser.secret('syntheticsecretkeyname');
  await serve(recorder.wrap((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"syntheticsecretkeyname":1}'); }), async (base) => { await (await fetch(`${base}/api/leaky`)).text(); });
  const files = fs.readdirSync(dir);
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 0);
  assert.equal(files.filter((f) => f.endsWith('.dropped')).length, 1);
  assert.ok(!readAll(dir).includes('syntheticsecretkeyname'));
});

test('random-looking ids get placeholders, fixed names stay literal', () => {
  const norm = createNormaliser();
  const out = norm.value({ id: 'default', providerId: 'general', chatId: 'c_1a2b3c4d5e', ids: ['abcdef1234567890'] });
  assert.equal(out.id, 'default');
  assert.equal(out.providerId, 'general');
  assert.match(out.chatId, /^<id:\d+>$/);
  assert.match(out.ids[0], /^<id:\d+>$/);
  assert.equal(norm.text('the 1760000000000 count'), 'the 1760000000000 count', 'digit-only runs are not hex ids');
});

test('a value revealed as a secret by a later exchange is removed from the earlier file', async () => {
  const dir = tmp();
  const recorder = createContractRecorder({ dir, env: {} });
  const phrase = 'correct horse battery staple';
  await serve(recorder.wrap(async (req, res) => {
    await readBody(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(req.url === '/api/one' ? JSON.stringify({ hint: `try ${phrase}` }) : '{"ok":true}');
  }), async (base) => {
    await (await fetch(`${base}/api/one`)).text();
    await (await fetch(`${base}/api/two`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: phrase }) })).text();
  });
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files.map((f) => f.replace(/^\d+-/, '')), ['GET-api-one.dropped', 'POST-api-two.json']);
  assert.ok(!readAll(dir).includes(phrase));
});

test('the server origin is <origin> in bodies and paths too, not only in the Origin header', () => {
  const norm = createNormaliser({ origin: 'http://127.0.0.1:44345' });
  assert.deepEqual(norm.value({ publicOrigin: 'http://127.0.0.1:44345', link: 'http://127.0.0.1:44345/s/x' }), { publicOrigin: '<origin>', link: '<origin>/s/x' });
  assert.equal(norm.header('location', 'http://127.0.0.1:44345/next', { origin: 'http://127.0.0.1:44345' }), '<origin>/next');
});

test('measured timings are <num>, counts stay literal', () => {
  const norm = createNormaliser();
  assert.deepEqual(norm.value({ type: 'telemetry', timeToFirstToken: 12.5, tokensPerSecond: 40.1, durationMs: 830, promptTokens: 12, count: 3 }),
    { type: 'telemetry', timeToFirstToken: '<num>', tokensPerSecond: '<num>', durationMs: '<num>', promptTokens: 12, count: 3 });
});

test('a data dir that already has accounts is never recorded', () => {
  const dir = path.join(tmp(), 'out');
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(String(m));
  try { assert.equal(fromEnv({ NOEVIA_CONTRACT_RECORD: dir }, { accounts: 2 }), null); } finally { console.error = original; }
  assert.equal(fs.existsSync(dir), false, 'not even the directory is created');
  assert.match(errors.join('\n'), /already has 2 account/);
  const quiet = console.warn; console.warn = () => {};
  try { assert.ok(fromEnv({ NOEVIA_CONTRACT_RECORD: dir }, { accounts: 0 })); } finally { console.warn = quiet; }
});

test('upstream URLs are <url:name> and IP addresses are not ids', () => {
  const norm = createNormaliser({ upstreams: { 'http://127.0.0.1:34455': 'inference', 'http://127.0.0.1:34456/': 'diary' } });
  assert.deepEqual(norm.value({ baseUrl: 'http://127.0.0.1:34455', diary: 'http://127.0.0.1:34456/api/x', host: '127.0.0.1', hostId: '10.0.0.12' }),
    { baseUrl: '<url:inference>', diary: '<url:diary>/api/x', host: '127.0.0.1', hostId: '10.0.0.12' });
});

test('build stamps are <version>; the request user-agent is kept for the replay', async () => {
  const norm = createNormaliser();
  assert.deepEqual(norm.value({ ready: true, version: '0.2.0', name: 'noevia' }), { ready: true, version: '<version>', name: 'noevia' });
  const dir = tmp();
  const recorder = createContractRecorder({ dir, env: {} });
  await serve(recorder.wrap((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); }), async (base) => {
    await (await fetch(`${base}/api/ua`, { headers: { 'User-Agent': 'synthetic-agent/1' } })).text();
  });
  assert.equal(records(dir)[0].request.headers['user-agent'], 'synthetic-agent/1');
});

function quietly(fn) {
  const e = console.error; const w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.error = e; console.warn = w; }
}

test('a public deployment is never recorded unless its data dir carries the synthetic marker', () => {
  const out = () => path.join(tmp(), 'out');
  assert.equal(quietly(() => fromEnv({ NOEVIA_CONTRACT_RECORD: out(), PUBLIC_ORIGIN: 'https://x.example' })), null);
  assert.equal(quietly(() => fromEnv({ NOEVIA_CONTRACT_RECORD: out(), UI_HOST: '0.0.0.0' })), null);
  assert.equal(quietly(() => fromEnv({ NOEVIA_CONTRACT_RECORD: out(), UI_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'not a url' })), null);
  assert.ok(quietly(() => fromEnv({ NOEVIA_CONTRACT_RECORD: out(), UI_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://localhost:8021' })));
  assert.ok(quietly(() => fromEnv({ NOEVIA_CONTRACT_RECORD: out() })), 'unset host and origin are loopback');
  const dataDir = tmp();
  const env = { NOEVIA_CONTRACT_RECORD: out(), UI_HOST: '0.0.0.0', PUBLIC_ORIGIN: 'https://x.example', UI_DATA_DIR: dataDir };
  assert.equal(quietly(() => fromEnv(env)), null, 'no marker yet');
  fs.writeFileSync(path.join(dataDir, MARKER), 'synthetic\n');
  assert.ok(quietly(() => fromEnv(env)), 'the marker allows a synthetic non-loopback run');
});

test('a non-empty record directory is refused', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '000001-GET-api-old.json'), '{}');
  assert.throws(() => createContractRecorder({ dir }), /not empty/);
  assert.equal(quietly(() => fromEnv({ NOEVIA_CONTRACT_RECORD: dir })), null);
  assert.deepEqual(fs.readdirSync(dir), ['000001-GET-api-old.json'], 'the stale file is untouched');
  assert.ok(createContractRecorder({ dir: tmp() }), 'an empty directory is fine');
});

test('the leak check also finds percent-encoded, base64 and JSON-escaped secrets and short ones', () => {
  const norm = createNormaliser();
  const raw = 'pa ss"w/ord&1';
  norm.secret(raw);
  assert.equal(norm.leaks('{"a":"nothing"}'), false);
  assert.equal(norm.leaks(`{"a":"${encodeURIComponent(raw)}"}`), true, 'percent-encoded');
  assert.equal(norm.leaks(`{"a":"${JSON.stringify(raw).slice(1, -1)}"}`), true, 'JSON-escaped');
  assert.equal(norm.leaks(`{"a":"${Buffer.from(raw).toString('base64')}"}`), true, 'base64');
  assert.equal(norm.leaks(`{"a":"${Buffer.from(raw).toString('base64url')}"}`), true, 'base64url');
  const short = createNormaliser();
  short.secret('xK9z');
  assert.equal(short.leaks('{"pin":"xK9z"}'), true, 'a 4-character secret is scanned');
  assert.equal(short.leaks('{"word":"xK9zebra"}'), false, 'not inside a longer word');
  assert.equal(short.leaks('{"a":"<secret:12>","b":"<id:3>","c":"<ts>"}'), false, 'placeholders never match');
  const tiny = createNormaliser();
  tiny.secret('ab');
  assert.equal(tiny.leaks('{"a":"ab"}'), false, 'below the minimum nothing is scanned');
  assert.equal(norm.text('x'), 'x');
});

test('a short secret echoed in a body is dropped, not written', async () => {
  const dir = tmp();
  const recorder = createContractRecorder({ dir });
  recorder.normaliser.secret('qZ7!');
  await serve(recorder.wrap((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"note":"pin qZ7! given"}'); }), async (base) => { await (await fetch(`${base}/api/short`)).text(); });
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.dropped')).length, 1);
});

test('generate.cjs refuses an --out that holds anything but a previous corpus, and deletes nothing', () => {
  const { spawnSync } = require('node:child_process');
  const gen = path.join(__dirname, '..', 'tools', 'contract-corpus', 'generate.cjs');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'keep');
  fs.mkdirSync(path.join(dir, 'exchanges'));
  fs.writeFileSync(path.join(dir, 'exchanges', 'a.json'), '{}');
  const r = spawnSync(process.execPath, [gen, '--out', dir], { encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing --out/);
  assert.ok(fs.existsSync(path.join(dir, 'precious.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'exchanges', 'a.json')));
  const file = path.join(tmp(), 'f');
  fs.writeFileSync(file, 'x');
  assert.match(spawnSync(process.execPath, [gen, '--out', file], { encoding: 'utf8', timeout: 20000 }).stderr, /not a directory/);
});
