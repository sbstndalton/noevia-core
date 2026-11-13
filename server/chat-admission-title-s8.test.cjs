'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// Chat port S8, risk 1 of the chat port contract: the front's admission lease is a relayed turn's one gate count.
// chat.cjs asks for a title only while the engine has no other work (engineBusy: inferenceBusy(1)), so a turn that
// entered the gate again under the front's lease would count twice and silently lose its title. Driven through
// index.cjs handleRequest exactly as the front calls it: the lease from POST /internal/inference-admission/lease
// {gate:'chat'}, then the relayed turn carrying it. The engine is a stub (global fetch); no model runs. Synthetic only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { frontTurn } = require('../tests/server/front-chat-turn.cjs');
const { createProjectAs } = require('../tests/server/front-projects.cjs');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-s8-title-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
// The front's maintenance authority and reranker settings (synthetic): after main, a turn needs both.
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir, process.env, { maintenance: true, reranker: true, admission: true });
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';
// The engine manager with its maintenance gate (engineBusy reads its counts); the engine itself is a stub address.
process.env.MODEL_MANAGER_KIND = 'llamacpp';
process.env.INFERENCE_BASE_URL = 'http://default.invalid';

const { handleRequest } = require('./index.cjs');
const { LEASE_HEADER } = require('./rust-chat-admission.cjs');
const { PREFIX } = require('./inference-admission-lease.cjs');
const crypto = require('node:crypto');
const FENCE = { 'x-noevia-admission-epoch': 'e'.repeat(32), 'x-noevia-admission-incarnation': '1' };
const { TITLE_SYSTEM } = require('./chat-title.cjs');

test.after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body = '', peer } = {}) {
  const req = Readable.from(body ? [body] : []);
  // `complete` as an IncomingMessage has it once its body arrived: a request read to its end is not a caller gone.
  Object.assign(req, { url, method, headers: { host: 'localhost', ...headers }, complete: true });
  if (peer) req.socket = { remoteAddress: peer };
  const chunks = [];
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  const out = {};
  Object.assign(res, { statusCode: 200, headersSent: false, setHeader: (n, v) => { out[n] = v; },
    writeHead(status, h = {}) { this.statusCode = status; this.headersSent = true; Object.assign(out, h); return this; } });
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handleRequest(req, res);
  await finished;
  return { status: res.statusCode, headers: out, text: Buffer.concat(chunks).toString('utf8') };
}

const adminHeaders = { authorization: 'Bearer test-cowork-token', 'content-type': 'application/json' };
let adminId = '';
let projectId = '';
test.before(() => {
  ({ id: adminId } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
  projectId = createProjectAs(testDataDir, adminId, { name: 'QA-SYNTH S8 title', model: 'model' }).id;
});

/** The front's admission call: loopback, the per-start secret. */
async function frontLease(route = 'chat') {
  const token = require('../tests/server/project-store-server.cjs').installedToken();
  const ticket = crypto.randomBytes(16).toString('hex');
  const put = () => request(`${PREFIX}/${ticket}`, { method: 'PUT', peer: '127.0.0.1', headers: { 'x-noevia-store-token': token, 'content-type': 'application/json', ...FENCE }, body: JSON.stringify({ gate: route }) });
  // The session with the stand-in's authority registers just after boot: a 503 until then. Deadline 5 s.
  let r = await put();
  for (const end = Date.now() + 5000; r.status === 503 && Date.now() < end;) { await new Promise((ok) => setTimeout(ok, 50)); r = await put(); }
  assert.equal(r.status, 201, r.text);
  return JSON.parse(r.text).lease;
}
async function giveBack(lease) {
  const token = require('../tests/server/project-store-server.cjs').installedToken();
  const r = await request(`${PREFIX}/${lease}`, { method: 'DELETE', peer: '127.0.0.1', headers: { 'x-noevia-store-token': token } });
  assert.equal(r.status, 204);
}

/** A QA-style turn against the stub engine; how many title requests it made and whether a title event came back. */
async function qaTurn(t, chatId, headers = {}) {
  let titles = 0;
  t.mock.method(global, 'fetch', async (url, opts = {}) => {
    const u = new URL(String(url));
    // The stub engine: no inference gate in front of it (turns run without a model lease), the model loaded.
    if (u.pathname.startsWith('/gate/')) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    if (u.pathname === '/models') return Response.json({ data: [{ id: 'model', status: { value: 'loaded' } }] });
    if (u.pathname === '/props') return Response.json({ default_generation_settings: { n_ctx: 32768 }, total_slots: 1, build_info: 'synthetic' });
    if (JSON.parse(opts.body).messages?.[0]?.content === TITLE_SYSTEM) { titles++; return Response.json({ choices: [{ message: { content: 'Synthetic Title' } }] }); }
    const frame = (f) => `data: ${JSON.stringify(f)}\n\n`;
    return new Response(frame({ choices: [{ delta: { content: 'QA-SYNTH answer.' } }] }) + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const result = await request(...frontTurn({ method: 'POST', headers: { ...adminHeaders, ...headers }, body: JSON.stringify({ projectId, chatId, message: 'QA-SYNTH-S8 hello' }) }, adminId));
  t.mock.restoreAll();
  assert.equal(result.status, 200);
  assert.match(result.text, /QA-SYNTH answer/);
  return { titles, titled: /"type":"title"/.test(result.text) };
}

test('a turn under the front\'s lease enters no gate of its own: its title is still asked for and sent', async (t) => {
  const lease = await frontLease();
  const out = await qaTurn(t, 'qa-s8-covered', { [LEASE_HEADER]: lease });
  await giveBack(lease);
  assert.deepEqual(out, { titles: 1, titled: true });
});

test('control: a second gate count (the double count S8 prevents) silently stops the title', async (t) => {
  const lease = await frontLease();
  const other = await frontLease();
  // Covered by `lease`, but `other` is a second count, as Node entering the gate again under the front's lease would be.
  const out = await qaTurn(t, 'qa-s8-double', { [LEASE_HEADER]: lease });
  await giveBack(lease);
  await giveBack(other);
  assert.deepEqual(out, { titles: 0, titled: false });
});

test('a turn without a live lease meets the gate as any request does, once, and keeps its title', async (t) => {
  assert.deepEqual(await qaTurn(t, 'qa-s8-no-lease'), { titles: 1, titled: true });
  const ended = await frontLease();
  await giveBack(ended);
  assert.deepEqual(await qaTurn(t, 'qa-s8-ended', { [LEASE_HEADER]: ended }), { titles: 1, titled: true });
});
