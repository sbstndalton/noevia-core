'use strict';
// Sign in with ChatGPT (#447): the device-code login, encrypted per-user storage, refresh, and the
// /chat/completions <-> Responses adapter. Every upstream is a fake at *.fixture.invalid; no real
// OpenAI account, token or network is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSecretStore } = require('./secrets.cjs');
const chatgpt = require('./chatgpt-oauth.cjs');
const { rotationTables } = require('./secrets-rotate.cjs');

const ISSUER = 'https://auth.fixture.invalid';
const CODEX = 'https://codex.fixture.invalid/backend-api/codex';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const idToken = (account, email = 'synthetic.person@example.test', plan = 'plus') => jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: plan } });
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function fakeOpenAI() {
  const seen = { calls: [], responses: [], refreshes: 0 };
  const state = { approved: false, refresh: 'ok', upstream: [], tokenSeq: 1, logins: 0, exchangeGate: null, onExchange: null, modelsDown: false };
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    seen.calls.push({ url, init });
    if (url === `${ISSUER}/api/accounts/deviceauth/usercode`) {
      assert.equal(JSON.parse(init.body).client_id, chatgpt.DEFAULTS.clientId);
      return json({ device_auth_id: 'DAID-synthetic', user_code: 'ABCD-1234', interval: '5' });
    }
    if (url === `${ISSUER}/api/accounts/deviceauth/token`) {
      const b = JSON.parse(init.body);
      assert.deepEqual(b, { device_auth_id: 'DAID-synthetic', user_code: 'ABCD-1234' });
      return state.approved ? json({ authorization_code: 'AUTHCODE', code_challenge: 'CH', code_verifier: 'VERIFIER' }) : json({ error: 'pending' }, 403);
    }
    if (url === `${ISSUER}/oauth/token`) {
      const form = String(init.headers['content-type']).includes('form');
      const b = form ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
      if (b.grant_type === 'authorization_code') {
        assert.deepEqual(b, { grant_type: 'authorization_code', code: 'AUTHCODE', redirect_uri: `${ISSUER}/deviceauth/callback`, client_id: chatgpt.DEFAULTS.clientId, code_verifier: 'VERIFIER' });
        state.logins += 1;
        state.onExchange?.();
        if (state.exchangeGate) await state.exchangeGate;
        const n = state.logins;
        const id = state.fedRampToken ? jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-F', chatgpt_account_is_fedramp: true } }) : idToken('acct-A');
        return json({ access_token: n === 1 ? 'AT-1' : `AT-L${n}`, refresh_token: n === 1 ? 'RT-1' : `RT-L${n}`, id_token: id, expires_in: 3600 });
      }
      if (b.grant_type === 'refresh_token') {
        seen.refreshes += 1;
        if (state.refreshGate) await state.refreshGate;
        if (state.refresh === 'invalid') return json({ error: 'invalid_grant' }, 400);
        if (state.refresh === 'down') return json({ error: 'server' }, 503);
        state.tokenSeq += 1;
        return json({ access_token: `AT-${state.tokenSeq}`, refresh_token: `RT-${state.tokenSeq}`, expires_in: 3600 });
      }
    }
    if (url === `${CODEX}/responses`) {
      seen.responses.push({ headers: init.headers, body: JSON.parse(init.body) });
      const next = state.upstream.shift();
      return next ? next(init) : sse([{ type: 'response.output_text.delta', delta: 'Hello' }, { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } } }]);
    }
    if (url.startsWith(`${CODEX}/models?`) && state.modelsDown) return json({ detail: 'down' }, 503);
    if (url.startsWith(`${CODEX}/models?`) && state.catalogue) return json(state.catalogue);
    if (url.startsWith(`${CODEX}/models?`)) return json({ models: [{ slug: 'gpt-synthetic', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'no-api', supported_in_api: false },
      { slug: 'gpt-thinker', default_reasoning_level: 'medium', default_reasoning_summary: 'detailed' }, { slug: 'gpt-plain', supports_reasoning_summary_parameter: false }, { slug: 'gpt-quiet', default_reasoning_summary: 'none' }] });
    return json({ error: 'unexpected ' + url }, 599);
  };
  return { fetchImpl, seen, state };
}

function make(t, fake = fakeOpenAI(), clock = { t: 1_800_000_000_000 }, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chatgpt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(':memory:');
  const secrets = createSecretStore(dir, { env: {} });
  const audits = [];
  const oauth = chatgpt.createChatGptOAuth({ db, secrets, fetchImpl: fake.fetchImpl, now: () => clock.t, audit: (a, u, d) => audits.push({ a, u, d }),
    config: { issuer: ISSUER, codexBaseUrl: CODEX, ...config } });
  return { oauth, db, secrets, fake, clock, audits, dir };
}
async function connect(f, userId = 'user-a') {
  const login = await f.oauth.startDeviceLogin(userId);
  f.fake.state.approved = true;
  f.clock.t += login.interval * 1000;
  const done = await f.oauth.pollDeviceLogin(userId, login.loginId);
  f.fake.state.approved = false;
  return { login, done };
}

test('device-code login: code shown, pending until approved, then tokens stored encrypted and bound to the user', async (t) => {
  const f = make(t);
  const login = await f.oauth.startDeviceLogin('user-a');
  assert.equal(login.userCode, 'ABCD-1234');
  assert.equal(login.verificationUrl, `${ISSUER}/codex/device`);
  assert.equal(login.interval, 5);
  assert.equal('deviceAuthId' in login, false, 'the device handle stays on the server');
  assert.deepEqual(await f.oauth.pollDeviceLogin('user-a', login.loginId), { state: 'pending', interval: 5 }, 'too early: no upstream poll');
  assert.equal(f.fake.seen.calls.filter((c) => c.url.endsWith('/deviceauth/token')).length, 0);
  f.clock.t += 5000;
  assert.equal((await f.oauth.pollDeviceLogin('user-a', login.loginId)).state, 'pending');
  f.fake.state.approved = true;
  f.clock.t += 5000;
  const done = await f.oauth.pollDeviceLogin('user-a', login.loginId);
  assert.deepEqual(done, { state: 'connected', account: { email: 's…@example.test', plan: 'plus' } });
  assert.equal((await f.oauth.pollDeviceLogin('user-a', login.loginId)).state, 'expired', 'a login is used once');

  const row = f.db.prepare('SELECT * FROM chatgpt_oauth_tokens').get();
  assert.equal(row.user_id, 'user-a');
  assert.match(row.data_enc, /^enc:v2:/, 'user-bound v2 ciphertext');
  for (const secret of ['AT-1', 'RT-1', 'acct-A', 'synthetic.person']) assert.equal(row.data_enc.includes(secret), false, secret);
  assert.throws(() => f.secrets.decrypt(row.data_enc, 'user-b'), 'another account cannot open it');
  assert.equal(JSON.parse(f.secrets.decrypt(row.data_enc, 'user-a')).accessToken, 'AT-1');
  assert.deepEqual(f.oauth.status('user-a'), { state: 'connected', account: { email: 's…@example.test', plan: 'plus' } });
  assert.equal(JSON.stringify(f.oauth.status('user-a')).includes('AT-1'), false);
  assert.equal(JSON.stringify(f.audits).match(/AT-|RT-|DAID|AUTHCODE|VERIFIER/), null, 'the audit log carries no credential');
});

test('a login belongs to the account that started it: another account can neither poll, finish nor cancel it', async (t) => {
  const f = make(t);
  const login = await f.oauth.startDeviceLogin('user-a');
  f.fake.state.approved = true;
  f.clock.t += 5000;
  await assert.rejects(f.oauth.pollDeviceLogin('user-b', login.loginId), (e) => e.status === 403);
  assert.throws(() => f.oauth.cancelDeviceLogin('user-b', login.loginId), (e) => e.status === 403);
  assert.equal(f.oauth.status('user-b').state, 'disconnected');
  assert.equal((await f.oauth.pollDeviceLogin('user-a', login.loginId)).state, 'connected', 'the owner still finishes it');
  assert.equal(f.oauth.status('user-b').state, 'disconnected');
});

test('an expired login and an unknown one answer expired; start caps pending logins per account', async (t) => {
  const f = make(t);
  const login = await f.oauth.startDeviceLogin('user-a');
  f.clock.t += 16 * 60 * 1000;
  assert.equal((await f.oauth.pollDeviceLogin('user-a', login.loginId)).state, 'expired');
  assert.equal((await f.oauth.pollDeviceLogin('user-a', 'nope')).state, 'expired');
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await f.oauth.startDeviceLogin('user-a')).loginId);
  assert.equal(f.oauth.cancelDeviceLogin('user-a', ids[0]), false, 'the oldest was evicted');
  assert.equal(f.oauth.cancelDeviceLogin('user-a', ids[4]), true);
});

test('tenant isolation: user B has no session, cannot use A’s token, and a copied ciphertext does not open for B', async (t) => {
  const f = make(t);
  await connect(f, 'user-a');
  await assert.rejects(f.oauth.session('user-b'), (e) => e.code === 'disconnected');
  const r = await f.oauth.fetchFor('user-b')('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [], stream: false }) });
  assert.equal(r.status, 401);
  assert.equal(f.fake.seen.responses.length, 0, 'nothing was sent upstream for B');
  const row = f.db.prepare("SELECT data_enc FROM chatgpt_oauth_tokens WHERE user_id='user-a'").get();
  f.db.prepare("INSERT INTO chatgpt_oauth_tokens(user_id, data_enc, state, updated_at) VALUES('user-b', ?, 'connected', 0)").run(row.data_enc);
  assert.equal(f.oauth.status('user-b').state, 'reconnect', 'the stolen row is unreadable for B');
  await assert.rejects(f.oauth.session('user-b'), (e) => e.code === 'reconnect');
  assert.equal((await f.oauth.session('user-a')).accessToken, 'AT-1');
});

test('the adapter sends the OAuth bearer and account header, maps the request, and streams chat.completion chunks back', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => sse([
    { type: 'response.created', response: {} },
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
    { type: 'response.output_text.delta', delta: 'Hi ' },
    { type: 'response.output_text.delta', delta: 'there' },
    { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'core_time', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"tz":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"UTC"}' },
    { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'core_time', arguments: '{"tz":"UTC"}' } },
    { type: 'response.output_item.done', item: { id: 'fc_2', type: 'function_call', call_id: 'call_2', name: 'one_shot', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } } },
  ]));
  const request = {
    model: 'gpt-synthetic', stream: true, stream_options: { include_usage: true }, max_tokens: 999, temperature: 0.2, top_k: 20,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What time is it?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'core_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: '12:00' },
      { role: 'user', content: [{ type: 'text', text: 'And now?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ],
    tools: [{ type: 'function', function: { name: 'core_time', description: 'time', parameters: { type: 'object', properties: { tz: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'core_time' } },
  };
  const r = await f.oauth.fetchFor('user-a')('https://chatgpt.com/backend-api/codex/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer sk-must-not-be-used' }, body: JSON.stringify(request) });
  assert.equal(r.status, 200);
  const sent = f.fake.seen.responses[0];
  assert.equal(sent.headers.authorization, 'Bearer AT-1');
  assert.equal(sent.headers['chatgpt-account-id'], 'acct-A');
  assert.equal(JSON.stringify(sent.headers).includes('sk-must-not-be-used'), false, 'the OAuth bearer, never an apiKey');
  assert.deepEqual(sent.body, {
    model: 'gpt-synthetic', instructions: '', stream: true, store: false, include: ['reasoning.encrypted_content'],
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'Be brief.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'What time is it?' }] },
      { type: 'function_call', call_id: 'call_0', name: 'core_time', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_0', output: '12:00' },
      { role: 'user', content: [{ type: 'input_text', text: 'And now?' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    ],
    tools: [{ type: 'function', name: 'core_time', description: 'time', parameters: { type: 'object', properties: { tz: { type: 'string' } } }, strict: false }],
    tool_choice: { type: 'function', name: 'core_time' },
    reasoning: { summary: 'auto' },
  });
  const text = await r.text();
  const frames = text.trim().split('\n\n').map((l) => l.slice(6));
  assert.equal(frames.at(-1), '[DONE]');
  const events = frames.slice(0, -1).map((x) => JSON.parse(x));
  const deltas = events.flatMap((e) => e.choices.map((c) => c.delta));
  assert.deepEqual(deltas.filter((d) => d.content).map((d) => d.content), ['Hi ', 'there']);
  assert.deepEqual(deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content), ['thinking']);
  const calls = new Map();
  for (const d of deltas) for (const tc of d.tool_calls || []) {
    const s = calls.get(tc.index) || { id: '', name: '', args: '' };
    if (tc.id) s.id = tc.id; if (tc.function?.name) s.name += tc.function.name; if (tc.function?.arguments) s.args += tc.function.arguments;
    calls.set(tc.index, s);
  }
  assert.deepEqual([...calls.values()], [{ id: 'call_1', name: 'core_time', args: '{"tz":"UTC"}' }, { id: 'call_2', name: 'one_shot', args: '{"a":1}' }]);
  assert.equal(events.find((e) => e.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(events.find((e) => e.usage).usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
});

test('non-streaming requests (compaction, fallback) get one chat.completion; upstream failures become readable errors', async (t) => {
  const f = make(t);
  await connect(f);
  const call = (body) => f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [{ role: 'user', content: 'x' }], ...body }) });
  const r = await call({ stream: false });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.choices[0].message, { role: 'assistant', content: 'Hello' });
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  assert.equal(f.fake.seen.responses.at(-1).body.stream, true, 'the backend is always streamed');

  f.fake.state.upstream.push(() => json({ detail: 'You have hit your usage limit.' }, 429));
  const limited = await call({ stream: true });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('x-noevia-provider-message'), '1');
  assert.match((await limited.json()).error.message, /^ChatGPT usage limit reached\. Pick another provider/);

  f.fake.state.upstream.push(() => sse([{ type: 'response.output_text.delta', delta: 'part' }, { type: 'response.failed', response: { error: { message: 'model overloaded' } } }]));
  const failed = await (await call({ stream: true })).text();
  assert.match(failed, /"error":\{"message":"model overloaded","source":"chatgpt"\}/);

  f.fake.state.upstream.push(() => sse([{ type: 'response.output_text.delta', delta: 'cut' }]));
  assert.match(await (await call({ stream: true })).text(), /ended the reply early/);
  const wrongPath = await f.oauth.fetchFor('user-a')('https://c/v1/embeddings', { method: 'POST', body: '{}' });
  assert.equal(wrongPath.status, 404);
});

test('refresh: near expiry the token is refreshed once (single flight) and the rotated refresh token is kept', async (t) => {
  const f = make(t);
  await connect(f);
  f.clock.t += 3600 * 1000 - 60 * 1000; // inside the five-minute margin
  const [a, b] = await Promise.all([f.oauth.session('user-a'), f.oauth.session('user-a')]);
  assert.equal(f.fake.seen.refreshes, 1, 'OpenAI rotates refresh tokens; two refreshes would burn each other');
  assert.equal(a.accessToken, 'AT-2');
  assert.equal(b.accessToken, 'AT-2');
  const refreshCall = f.fake.seen.calls.filter((c) => c.url === `${ISSUER}/oauth/token`).at(-1);
  assert.deepEqual(JSON.parse(refreshCall.init.body), { grant_type: 'refresh_token', refresh_token: 'RT-1', client_id: chatgpt.DEFAULTS.clientId });
  const stored = JSON.parse(f.secrets.decrypt(f.db.prepare('SELECT data_enc FROM chatgpt_oauth_tokens').get().data_enc, 'user-a'));
  assert.equal(stored.refreshToken, 'RT-2');
  assert.equal(stored.accountId, 'acct-A', 'the account id survives a refresh without an id token');
  assert.equal(stored.email, 'synthetic.person@example.test');
});

test('refresh on 401: the request is retried once with the new bearer', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => json({ detail: 'token expired' }, 401));
  const r = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [], stream: false }) });
  assert.equal(r.status, 200);
  assert.deepEqual(f.fake.seen.responses.map((x) => x.headers.authorization), ['Bearer AT-1', 'Bearer AT-2']);
  assert.equal(f.oauth.status('user-a').state, 'connected');
});

// #934: a second 401 after the refresh marks only the sign-in that failed, never a newer one.
const chatBody = () => ({ method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [], stream: false }) });
const storedTokens = (f) => JSON.parse(f.secrets.decrypt(f.db.prepare('SELECT data_enc FROM chatgpt_oauth_tokens WHERE user_id=?').get('user-a').data_enc, 'user-a'));
function writeSignIn(f, tokens) {
  f.db.prepare("UPDATE chatgpt_oauth_tokens SET data_enc=?, state='connected', updated_at=? WHERE user_id='user-a'")
    .run(f.secrets.encrypt(JSON.stringify(tokens), 'user-a'), f.clock.t);
}

test('a 401 twice marks the signed-in row "reconnect" when nothing else changed', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => json({}, 401));
  f.fake.state.upstream.push(() => json({}, 401));
  const r = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', chatBody());
  assert.equal(r.status, 401);
  assert.equal(f.oauth.status('user-a').state, 'reconnect');
});

test('a 401 twice leaves a newer sign-in written between the calls "connected"', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => json({}, 401));
  f.fake.state.upstream.push(() => {
    // The user finishes a fresh device sign-in while the retry is in flight.
    writeSignIn(f, { ...storedTokens(f), accessToken: 'AT-NEW', refreshToken: 'RT-NEW' });
    return json({}, 401);
  });
  const r = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', chatBody());
  assert.equal(r.status, 401, 'this request still fails');
  assert.equal(f.oauth.status('user-a').state, 'connected', 'the fresh sign-in is not marked');
  assert.equal(storedTokens(f).accessToken, 'AT-NEW');
  assert.equal((await f.oauth.session('user-a')).accessToken, 'AT-NEW');
});

test('a refused refresh marks the account "reconnect"; a transient one does not; disconnect deletes the tokens', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.refresh = 'down';
  f.fake.state.upstream.push(() => json({}, 401));
  const transient = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  assert.equal(transient.status, 503);
  assert.equal(f.oauth.status('user-a').state, 'connected', 'a network blip is not a revoked sign-in');

  f.fake.state.refresh = 'invalid';
  f.fake.state.upstream.push(() => json({}, 401));
  const refused = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('x-noevia-provider-message'), '1');
  assert.match((await refused.json()).error.message, /^Reconnect needed/);
  assert.equal(f.oauth.status('user-a').state, 'reconnect');
  const before = f.fake.seen.responses.length;
  const after = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  assert.equal(after.status, 401);
  assert.equal(f.fake.seen.responses.length, before, 'a reconnect-needed account sends nothing upstream');

  f.oauth.disconnect('user-a');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM chatgpt_oauth_tokens').get().n, 0);
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
  await connect(f);
  assert.equal(f.oauth.status('user-a').state, 'connected', 'signing in again recovers');
});

test('a disconnect during an in-flight refresh wins: the refreshed tokens are not written back', async (t) => {
  const f = make(t);
  await connect(f);
  let release;
  f.fake.state.refreshGate = new Promise((r) => { release = r; });
  f.clock.t += 3600 * 1000;
  const pending = f.oauth.session('user-a');
  await new Promise((r) => setImmediate(r));
  f.oauth.disconnect('user-a');
  release();
  await assert.rejects(pending, (e) => e.code === 'disconnected');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM chatgpt_oauth_tokens').get().n, 0);
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
});

test('the model list is the account’s public models; forgetUser removes a deleted account; rotation covers the table', async (t) => {
  const f = make(t);
  await connect(f);
  assert.deepEqual(await f.oauth.listModels('user-a'), ['gpt-synthetic', 'gpt-thinker', 'gpt-plain', 'gpt-quiet']);
  const modelCall = f.fake.seen.calls.find((c) => c.url.startsWith(`${CODEX}/models?`));
  assert.match(modelCall.url, /client_version=0\.155\.0/);
  assert.equal(modelCall.init.headers.authorization, 'Bearer AT-1');
  await assert.rejects(f.oauth.listModels('user-b'), (e) => e.status === 401);
  const tables = rotationTables({ db: f.db, dataDir: f.dir });
  const table = tables.find((x) => x.name === 'chatgpt_oauth_tokens');
  assert.ok(table, 'secrets rotation re-encrypts ChatGPT tokens');
  assert.deepEqual(table.rows().map((r) => r.userId), ['user-a'], 'bound rows rotate with their owner');
  f.oauth.forgetUser('user-a');
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
});

test('pure helpers: masked e-mail, account id from claims, provider row is private and external', () => {
  assert.equal(chatgpt.maskEmail('someone@example.test'), 's…@example.test');
  assert.equal(chatgpt.maskEmail('no-at-sign'), null);
  assert.equal(chatgpt.accountIdFrom(idToken('acct-Z')), 'acct-Z');
  assert.equal(chatgpt.accountIdFrom(jwt({ organizations: [{ id: 'org-1' }] })), 'org-1');
  assert.equal(chatgpt.accountIdFrom('not.a.jwt'), undefined);
  const row = chatgpt.providerRow();
  assert.deepEqual({ shared: row.shared, external: row.external, kind: row.kind, apiKey: row.apiKey }, { shared: false, external: true, kind: 'chatgpt-oauth', apiKey: '' });
});

// ── Hardening from upstream openai-oauth issues/PRs, the plgonzalezrx8 fork and the #451 review ──
const post = (f, body, user = 'user-a') => f.oauth.fetchFor(user)('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [{ role: 'user', content: 'x' }], ...body }) });
const lastSent = (f) => f.fake.seen.responses.at(-1).body;

test('upstream #44: tools stay non-strict unless the request opts in', () => {
  const tool = (strict) => ({ type: 'function', function: { name: 'Agent', parameters: { type: 'object', properties: { prompt: { type: 'string' }, isolation: { type: 'string' } }, required: ['prompt'] }, ...(strict === undefined ? {} : { strict }) } });
  const out = chatgpt.toResponsesRequest({ model: 'm', messages: [], tools: [tool(undefined), tool(false), tool(true)] });
  assert.deepEqual(out.tools.map((x) => x.strict), [false, false, true]);
});

test('upstream #9/#40: response_format json_schema and json_object become Responses text.format', () => {
  const schema = { type: 'object', properties: { explicit: { type: 'array', items: { type: 'string' } } }, required: ['explicit'] };
  const out = chatgpt.toResponsesRequest({ model: 'm', messages: [], response_format: { type: 'json_schema', json_schema: { name: 'facts', schema, strict: true } } });
  assert.deepEqual(out.text, { format: { type: 'json_schema', name: 'facts', schema, strict: true } });
  assert.deepEqual(chatgpt.toResponsesRequest({ model: 'm', messages: [], response_format: { type: 'json_object' } }).text, { format: { type: 'json_object' } });
  assert.equal(chatgpt.toResponsesRequest({ model: 'm', messages: [], response_format: { type: 'text' } }).text, undefined);
});

test('upstream #22/#38 and PR #7: fields the Codex backend rejects are never forwarded (allowlisted body)', () => {
  const out = chatgpt.toResponsesRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], safety_identifier: 'u', prompt_cache_retention: '24h', user: 'u',
    temperature: 0.2, top_p: 0.9, top_k: 20, min_p: 0.05, max_tokens: 10, max_completion_tokens: 10, max_output_tokens: 10, stream_options: { include_usage: true },
    metadata: { a: 1 }, service_tier: 'flex', seed: 1, stop: ['x'], n: 1, logprobs: true, previous_response_id: 'resp_1', store: true, parallel_tool_calls: true });
  assert.deepEqual(Object.keys(out).sort(), ['include', 'input', 'instructions', 'model', 'store', 'stream']);
  assert.equal(out.store, false, 'stateless: store:false and never previous_response_id (fork 1bc2913)');
});

test('upstream #11: a reply sent only as a finished item, or only in response.completed.output, is not lost', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => sse([
    { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'From the item.' }] } },
    { type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 3 } } },
  ]));
  assert.equal((await (await post(f, { stream: false })).json()).choices[0].message.content, 'From the item.');
  f.fake.state.upstream.push(() => sse([{ type: 'response.completed', response: { output: [{ id: 'msg_2', type: 'message', content: [{ type: 'output_text', text: 'Only in output.' }] }] } }]));
  assert.equal((await (await post(f, { stream: false })).json()).choices[0].message.content, 'Only in output.');
  f.fake.state.upstream.push(() => sse([
    { type: 'response.output_text.delta', item_id: 'msg_3', delta: 'Streamed once.' },
    { type: 'response.output_item.done', item: { id: 'msg_3', type: 'message', content: [{ type: 'output_text', text: 'Streamed once.' }] } },
    { type: 'response.completed', response: { output: [{ id: 'msg_3', type: 'message', content: [{ type: 'output_text', text: 'Streamed once.' }] }] } },
  ]));
  assert.equal((await (await post(f, { stream: false })).json()).choices[0].message.content, 'Streamed once.', 'no duplicate when it did stream');
});

test('fork 3b04587: an incomplete terminal response is a finished reply with its reason', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => sse([{ type: 'response.output_text.delta', item_id: 'm1', delta: 'Partial' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }]));
  const body = await (await post(f, { stream: false })).json();
  assert.deepEqual([body.choices[0].message.content, body.choices[0].finish_reason], ['Partial', 'content_filter']);
  f.fake.state.upstream.push(() => sse([{ type: 'response.output_text.delta', item_id: 'm2', delta: 'Long' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]));
  assert.equal((await (await post(f, { stream: false })).json()).choices[0].finish_reason, 'length');
});

test('upstream #39: an error before any output is a real HTTP error, not 200 plus a cut-off stream', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => sse([{ type: 'error', error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: 1_800_003_600 } }]));
  const r = await post(f, { stream: true });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('x-noevia-provider-message'), '1');
  assert.equal((await r.json()).error.message, 'ChatGPT usage limit reached on your Plus plan. It resets at 2027-01-15 09:00 UTC. Pick another provider in the model popup until then.');
  f.fake.state.upstream.push(() => sse([{ type: 'response.output_text.delta', item_id: 'm', delta: 'Hi' }, { type: 'error', code: 'usage_limit_reached', message: 'The usage limit has been reached' }]));
  const mid = await (await post(f, { stream: true })).text();
  assert.match(mid, /"error":\{"message":"ChatGPT usage limit reached\. Pick another provider in the model popup until then\.","source":"chatgpt"\}/);
  assert.match(mid, /data: \[DONE\]\n\n$/, 'closed cleanly after the explicit error frame');
});

test('usage limits (issue #35) read clearly, with the reset time when OpenAI gives one', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => json({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 120 } }, 429));
  assert.match((await (await post(f, {})).json()).error.message, /^ChatGPT usage limit reached\. It resets at \d{4}-\d\d-\d\d \d\d:\d\d UTC\./);
  f.fake.state.upstream.push(() => json({ error: { type: 'usage_not_included' } }, 429));
  assert.match((await (await post(f, {})).json()).error.message, /does not include the Codex usage/);
  f.fake.state.upstream.push(() => json({ detail: 'Too Many Requests' }, 429));
  assert.match((await (await post(f, {})).json()).error.message, /rate-limiting this account/);
});

test('upstream #31: the adapter never calls an images route', async (t) => {
  const f = make(t);
  await connect(f);
  const r = await f.oauth.fetchFor('user-a')('https://c/v1/images/generations', { method: 'POST', body: '{}' });
  assert.equal(r.status, 404);
  assert.equal(f.fake.seen.calls.some((c) => /images/.test(c.url)), false);
});

test('fork allowlist: a model the account does not have is refused before anything is sent; a broken catalogue does not block', async (t) => {
  const f = make(t);
  await connect(f);
  const before = f.fake.seen.responses.length;
  const r = await post(f, { model: 'gpt-imaginary' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /gpt-imaginary is not available on your ChatGPT account\. Choose one of: gpt-synthetic, gpt-thinker, gpt-plain, gpt-quiet\./);
  assert.equal(f.fake.seen.responses.length, before);
  const g = make(t);
  g.fake.state.modelsDown = true;
  await connect(g);
  assert.equal((await post(g, { model: 'gpt-anything' })).status, 200);
});

test('fork 3b04587 / review: a transient refresh failure inside the early window keeps the still-valid token', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.refresh = 'down';
  f.clock.t += 3600 * 1000 - 60 * 1000; // four minutes early, token still valid
  assert.equal((await f.oauth.session('user-a')).accessToken, 'AT-1');
  f.clock.t += 120 * 1000; // now expired
  await assert.rejects(f.oauth.session('user-a'), (e) => e.code === 'transient');
  assert.equal(f.oauth.status('user-a').state, 'connected');
});

test('#453: a stale refresh cannot overwrite a newer sign-in (compare-and-set)', async (t) => {
  const f = make(t);
  await connect(f);
  let release;
  f.fake.state.refreshGate = new Promise((r) => { release = r; });
  f.clock.t += 3600 * 1000;
  const stale = f.oauth.session('user-a');
  await new Promise((r) => setImmediate(r));
  await connect(f); // the person signs in again while the old refresh is in flight
  release();
  const got = await stale;
  const stored = JSON.parse(f.secrets.decrypt(f.db.prepare('SELECT data_enc FROM chatgpt_oauth_tokens').get().data_enc, 'user-a'));
  assert.equal(stored.accessToken, 'AT-L2', 'the re-sign-in survives');
  assert.equal(got.accessToken, 'AT-L2', 'the caller gets the current sign-in, not the stale refresh');
});

test('#454: Cancel or Disconnect during the token exchange wins; nothing is stored', async (t) => {
  for (const how of ['cancel', 'disconnect']) {
    const f = make(t);
    const login = await f.oauth.startDeviceLogin('user-a');
    f.fake.state.approved = true;
    let release, entered;
    const inExchange = new Promise((r) => { entered = r; });
    f.fake.state.exchangeGate = new Promise((r) => { release = r; });
    f.fake.state.onExchange = entered;
    f.clock.t += 5000;
    const polled = f.oauth.pollDeviceLogin('user-a', login.loginId);
    await inExchange;
    if (how === 'cancel') assert.equal(f.oauth.cancelDeviceLogin('user-a', login.loginId), true);
    else f.oauth.disconnect('user-a');
    release();
    assert.deepEqual(await polled, { state: 'cancelled' }, how);
    assert.equal(f.oauth.status('user-a').state, 'disconnected', how);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM chatgpt_oauth_tokens').get().n, 0, how);
  }
});

test('review: starting a sign-in is rate-limited per account (5 per 10 minutes)', async (t) => {
  const f = make(t);
  for (let i = 0; i < 5; i++) await f.oauth.startDeviceLogin('user-a');
  await assert.rejects(f.oauth.startDeviceLogin('user-a'), (e) => e.status === 429);
  await f.oauth.startDeviceLogin('user-b');
  f.clock.t += 10 * 60 * 1000 + 1;
  await f.oauth.startDeviceLogin('user-a');
});

test('forks YangKeao@d72dec5 / twaldin@b471a45: reasoning summaries are requested, following the model’s catalogue defaults', async (t) => {
  const f = make(t);
  await connect(f);
  assert.deepEqual(chatgpt.toResponsesRequest({ model: 'm', messages: [], reasoning_effort: 'high' }).reasoning, { effort: 'high', summary: 'auto' });
  await post(f, { model: 'gpt-thinker' });
  assert.deepEqual(lastSent(f).reasoning, { effort: 'medium', summary: 'detailed' });
  await post(f, { model: 'gpt-thinker', reasoning_effort: 'low' });
  assert.deepEqual(lastSent(f).reasoning, { effort: 'low', summary: 'detailed' });
  await post(f, { model: 'gpt-plain', reasoning_effort: 'high' });
  assert.deepEqual(lastSent(f).reasoning, { effort: 'high' }, 'a model that rejects the summary parameter does not get it');
  await post(f, { model: 'gpt-quiet' });
  assert.equal(lastSent(f).reasoning, undefined);
  f.fake.state.upstream.push(() => sse([{ type: 'response.reasoning_summary_text.delta', delta: 'Thinking about it.' }, { type: 'response.output_text.delta', item_id: 'm', delta: 'Done.' }, { type: 'response.completed', response: {} }]));
  const body = await (await post(f, { model: 'gpt-thinker', stream: false })).json();
  assert.equal(body.choices[0].message.reasoning_content, 'Thinking about it.');
});

test('fork QuartzWarrior@7100902, checked against openai/codex: per-conversation session headers and cache key, honest UA, FedRAMP header kept', async (t) => {
  const f = make(t);
  await connect(f);
  await f.oauth.fetchFor('user-a', { conversation: 'chat-1' })('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  const a = f.fake.seen.responses.at(-1);
  assert.match(a.headers['session-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.headers['x-client-request-id'], a.headers['session-id']);
  assert.equal(a.body.prompt_cache_key, a.headers['session-id']);
  assert.equal(a.headers['session-id'].includes('chat-1'), false, 'the internal chat id does not leave');
  await f.oauth.fetchFor('user-a', { conversation: 'chat-1' })('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  assert.equal(f.fake.seen.responses.at(-1).headers['session-id'], a.headers['session-id'], 'stable per conversation');
  await f.oauth.fetchFor('user-a', { conversation: 'chat-2' })('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  assert.notEqual(f.fake.seen.responses.at(-1).headers['session-id'], a.headers['session-id']);
  assert.match(a.headers['user-agent'], /^noevia\/\S+ \(chatgpt-oauth; \+https:\/\/github\.com\/sbstndalton\/noevia\)$/);
  assert.equal('originator' in a.headers, false, 'noevia does not claim to be the Codex CLI');
  const tokenCall = f.fake.seen.calls.find((c) => c.url.endsWith('/oauth/token'));
  assert.equal(tokenCall.init.headers['user-agent'], a.headers['user-agent']);
  // FedRAMP: the Codex client itself sends X-OpenAI-Fedramp for such accounts (bearer_auth_provider.rs L43-44).
  const g = make(t);
  g.fake.state.fedRampToken = true;
  const login = await g.oauth.startDeviceLogin('user-f');
  g.fake.state.approved = true; g.clock.t += 5000;
  await g.oauth.pollDeviceLogin('user-f', login.loginId);
  await g.oauth.fetchFor('user-f')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  assert.equal(g.fake.seen.responses.at(-1).headers['x-openai-fedramp'], 'true');
  assert.equal('x-openai-fedramp' in a.headers, false);
});


// Public OpenAI metadata only: this tests protocol compatibility with a wholly fake account,
// not entitlement, model availability on any real account, or actual model inference.
const publicCatalogue1310 = require('./fixtures/chatgpt-public-catalogue-1310.json');
test('catalogue compatibility #1310: published GPT-6 metadata uses the exact new default and filters private/disabled rows', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.catalogue = { unknownTopLevel: { ignored: true }, models: [
    ...publicCatalogue1310.models.map((row) => ({ ...row, unknownFutureField: { ignored: true } })),
    { slug: 'synthetic-hidden', visibility: 'hide', supported_in_api: true },
    { slug: 'synthetic-api-disabled', visibility: 'list', supported_in_api: false },
  ] };
  assert.equal(publicCatalogue1310.source.revision, 'cc7ba33601286a751477832b01de7b6f8de0dd9c');
  assert.equal(chatgpt.DEFAULTS.codexClientVersion, '0.155.0');
  const ids = await f.oauth.listModels('user-a');
  assert.deepEqual(ids, ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']);
  const call = f.fake.seen.calls.find((c) => c.url.startsWith(`${CODEX}/models?`));
  assert.equal(call.url, `${CODEX}/models?client_version=0.155.0`);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'error');
  assert.ok(ids.every((id) => typeof id === 'string'));
  assert.doesNotMatch(JSON.stringify({ ids, status: f.oauth.status('user-a'), audits: f.audits }), /AT-1|RT-1|AUTHCODE|VERIFIER/);
  await assert.rejects(f.oauth.listModels('user-b'), (e) => e.status === 401);

  // Exercise the existing catalogue-default adapter with fake Response objects only.
  for (const row of publicCatalogue1310.models) {
    assert.ok(row.supported_reasoning_levels.some((level) => level.effort === 'max'));
    const response = await post(f, { model: row.slug });
    assert.equal(response.status, 200);
    assert.deepEqual(lastSent(f).reasoning, { effort: row.default_reasoning_level });
    assert.equal(lastSent(f).model, row.slug);
    assert.equal('unknownFutureField' in lastSent(f), false);
    // Metadata assurance only: explicit max/ultra forwarding is a separate inherited adapter
    // limitation, not changed or claimed by this compatibility-default repair.
    assert.deepEqual(row.supported_reasoning_levels.map((level) => level.effort),
      row.slug === 'gpt-6-luna' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(row.minimal_client_version, ['gpt-6-astra', 'gpt-6.1-sol'].includes(row.slug) ? '0.153.0' : '0.155.0');
  }
  assert.equal(publicCatalogue1310.models.find((row) => row.slug === 'gpt-6-luna').supported_reasoning_levels.some((level) => level.effort === 'ultra'), false);
});

test('catalogue compatibility #1310: the existing configured version override remains authoritative', async (t) => {
  const f = make(t, fakeOpenAI(), { t: 1_800_000_000_000 }, { codexClientVersion: '0.199.2-fixture' });
  await connect(f);
  f.fake.state.catalogue = { models: publicCatalogue1310.models };
  assert.deepEqual(await f.oauth.listModels('user-a'), publicCatalogue1310.models.map((row) => row.slug));
  assert.equal(f.fake.seen.calls.find((c) => c.url.startsWith(`${CODEX}/models?`)).url, `${CODEX}/models?client_version=0.199.2-fixture`);
});
