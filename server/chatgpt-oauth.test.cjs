'use strict';
// Sign in with ChatGPT (#447): the /chat/completions <-> Responses adapter and the token client.
// sbstndalton/noevia#2190 round 5: the device sign-in, the token store, the refresh and the model
// catalogue are the Rust front's (noevia-rs chatgpt_oauth_routes.rs, tests/chatgpt_oauth.rs); here
// a synthetic broker (tests/server/chatgpt-broker-fake.cjs) hands out access tokens and catalogue
// entries. Every upstream is a fake at *.fixture.invalid; no real OpenAI account, token or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const chatgpt = require('./chatgpt-oauth.cjs');
const { rotationTables } = require('./secrets-rotate.cjs');
const { createFakeBroker } = require('../tests/server/chatgpt-broker-fake.cjs');

const CODEX = 'https://codex.fixture.invalid/backend-api/codex';
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// The broker's catalogue projection (noevia-rs chatgpt_oauth_routes.rs fetch_catalogue, ported
// from this module): raw Codex /models rows to the entries the adapter checks.
const word = (v) => (typeof v === 'string' && /^[a-z_]{1,20}$/.test(v) ? v : null);
function project(raw) {
  return (Array.isArray(raw?.models) ? raw.models : [])
    .filter((m) => m && typeof m === 'object' && typeof m.slug === 'string' && m.slug && m.supported_in_api !== false && (m.visibility === undefined || m.visibility === 'list'))
    .map((m) => ({ slug: m.slug.slice(0, 120), effort: word(m.default_reasoning_level), summary: word(m.default_reasoning_summary), summaryParam: m.supports_reasoning_summary_parameter !== false,
      levels: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => word(l && typeof l === 'object' ? l.effort : null)).filter(Boolean).slice(0, 12) : null })).slice(0, 50);
}
const DEFAULT_RAW = { models: [{ slug: 'gpt-synthetic', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'no-api', supported_in_api: false },
  { slug: 'gpt-thinker', default_reasoning_level: 'medium', default_reasoning_summary: 'detailed' }, { slug: 'gpt-plain', supports_reasoning_summary_parameter: false }, { slug: 'gpt-quiet', default_reasoning_summary: 'none' }] };

function fakeOpenAI() {
  const seen = { calls: [], responses: [] };
  const state = { upstream: [], modelsDown: false, catalogue: null, fedRampToken: false };
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    seen.calls.push({ url, init });
    if (url === `${CODEX}/responses`) {
      seen.responses.push({ headers: init.headers, body: JSON.parse(init.body) });
      const next = state.upstream.shift();
      return next ? next(init) : sse([{ type: 'response.output_text.delta', delta: 'Hello' }, { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } } }]);
    }
    return json({ error: 'unexpected ' + url }, 599);
  };
  return { fetchImpl, seen, state };
}

function make(t, fake = fakeOpenAI(), clock = { t: 1_800_000_000_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chatgpt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(':memory:');
  const b = createFakeBroker({ db, now: () => clock.t });
  // The catalogue the broker projects from the fake account's raw /models answer.
  b.broker.chatgptCatalogue = async (user) => {
    b.calls.push({ op: 'catalogue', user });
    return fake.state.modelsDown ? { ok: false, status: 502, error: 'ChatGPT returned 503: down' } : { ok: true, models: project(fake.state.catalogue || DEFAULT_RAW) };
  };
  const oauth = chatgpt.createChatGptOAuth({ db, broker: b.broker, signal: b.signal, fetchImpl: fake.fetchImpl, now: () => clock.t, config: { codexBaseUrl: CODEX } });
  return { oauth, db, fake, clock, dir, b };
}
async function connect(f, userId = 'user-a') {
  f.b.connect(userId, { accessToken: 'AT-1', accountId: 'acct-A', fedRamp: f.fake.state.fedRampToken === true, expiresAt: f.clock.t + 3_600_000 });
}

test('tenant isolation: user B has no session and cannot use A’s token (a copied ciphertext: noevia-rs tests/chatgpt_oauth.rs)', async (t) => {
  const f = make(t);
  await connect(f, 'user-a');
  await assert.rejects(f.oauth.session('user-b'), (e) => e.code === 'disconnected');
  const r = await f.oauth.fetchFor('user-b')('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [], stream: false }) });
  assert.equal(r.status, 401);
  assert.equal(f.fake.seen.responses.length, 0, 'nothing was sent upstream for B');
  assert.ok(f.b.calls.filter((c) => c.op === 'session').every((c) => c.user === 'user-b'), 'B asked for B only');
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

test('refresh on 401: the broker is asked again with the rejected token and the request retried once with the new bearer', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => json({ detail: 'token expired' }, 401));
  const r = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [], stream: false }) });
  assert.equal(r.status, 200);
  assert.deepEqual(f.fake.seen.responses.map((x) => x.headers.authorization), ['Bearer AT-1', 'Bearer AT-2']);
  assert.equal(f.oauth.status('user-a').state, 'connected');
  assert.deepEqual(f.b.calls.filter((c) => c.op === 'session').map((c) => c.rejected), [null, 'AT-1']);
});

// #934: a second 401 after the refresh marks only the sign-in that failed, never a newer one.
const chatBody = () => ({ method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [], stream: false }) });

test('a 401 twice marks the signed-in row "reconnect" when nothing else changed', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => json({}, 401));
  f.fake.state.upstream.push(() => json({}, 401));
  const r = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', chatBody());
  assert.equal(r.status, 401);
  assert.equal(f.oauth.status('user-a').state, 'reconnect');
  assert.deepEqual(f.b.calls.filter((c) => c.op === 'reject').map((c) => c.generation), ['gen-2'], 'the generation that failed, never a token');
});

test('a 401 twice leaves a newer sign-in written between the calls "connected"', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.upstream.push(() => json({}, 401));
  f.fake.state.upstream.push(() => {
    // The user finishes a fresh device sign-in while the retry is in flight.
    f.b.connect('user-a', { accessToken: 'AT-NEW', accountId: 'acct-A' });
    return json({}, 401);
  });
  const r = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', chatBody());
  assert.equal(r.status, 401, 'this request still fails');
  assert.equal(f.oauth.status('user-a').state, 'connected', 'the fresh sign-in is not marked');
  assert.equal((await f.oauth.session('user-a')).accessToken, 'AT-NEW');
});

test('a refused refresh marks the account "reconnect"; a transient one does not; disconnect deletes the tokens', async (t) => {
  const f = make(t);
  await connect(f);
  f.b.state.refresh = 'down';
  f.fake.state.upstream.push(() => json({}, 401));
  const transient = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  assert.equal(transient.status, 503);
  assert.equal(f.oauth.status('user-a').state, 'connected', 'a network blip is not a revoked sign-in');

  f.b.state.refresh = 'invalid';
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

  await f.oauth.disconnect('user-a');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM chatgpt_oauth_tokens').get().n, 0);
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
  await connect(f);
  assert.equal(f.oauth.status('user-a').state, 'connected', 'signing in again recovers');
});

test('rotation covers the table; forgetting a deleted account is the front\'s (no forgetUser here)', async (t) => {
  const f = make(t);
  await connect(f);
  const tables = rotationTables({ db: f.db, dataDir: f.dir });
  const table = tables.find((x) => x.name === 'chatgpt_oauth_tokens');
  assert.ok(table, 'secrets rotation re-encrypts ChatGPT tokens');
  assert.deepEqual(table.rows().map((r) => r.userId), ['user-a'], 'bound rows rotate with their owner');
  assert.equal(f.oauth.forgetUser, undefined);
  await f.b.broker.chatgptDisconnect('user-a'); // the front\'s own removal of the row
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
});

test('the provider row is private and external', () => {
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
  // FedRAMP: the Codex client itself sends X-OpenAI-Fedramp for such accounts (bearer_auth_provider.rs L43-44).
  const g = make(t);
  g.fake.state.fedRampToken = true;
  await connect(g, 'user-f');
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
  const ids = (await f.b.broker.chatgptCatalogue('user-a')).models.map((m) => m.slug);
  assert.deepEqual(ids, ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']);
  assert.ok(ids.every((id) => typeof id === 'string'));
  assert.doesNotMatch(JSON.stringify({ ids, status: f.oauth.status('user-a') }), /AT-1/);

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

test('#1311: explicit xhigh/max/ultra reach upstream only when the model publishes them; others are refused, not dropped', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.catalogue = { models: [
    { slug: 'gpt-levels', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
    { slug: 'gpt-basic', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
  ] };
  const before = f.fake.seen.responses.length;

  // A published level is forwarded as the explicit choice (not the model default).
  let r = await post(f, { model: 'gpt-levels', reasoning_effort: 'max' });
  assert.equal(r.status, 200);
  assert.equal(lastSent(f).reasoning.effort, 'max');
  assert.equal(lastSent(f).reasoning.summary, 'auto');

  // A level the model does not publish is a clear 400 that names what it does offer; nothing is sent.
  r = await post(f, { model: 'gpt-basic', reasoning_effort: 'xhigh' });
  assert.equal(r.status, 400);
  const message = (await r.json()).error.message;
  assert.match(message, /does not offer "xhigh" reasoning for gpt-basic/);
  assert.match(message, /low, medium/);
  assert.equal(f.fake.seen.responses.length, before + 1, 'the refused request never reached ChatGPT');

  // The basic levels and Default behave as before.
  r = await post(f, { model: 'gpt-basic', reasoning_effort: 'low' });
  assert.equal(lastSent(f).reasoning.effort, 'low');
  r = await post(f, { model: 'gpt-basic', reasoning_effort: 'default' });
  assert.equal(r.status, 200);
  assert.equal(lastSent(f).reasoning.effort, 'medium', 'Default takes the model default, as before');
});

test('#1311: when the model list cannot be read, an explicit level that needs it is refused with the basic choices', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.modelsDown = true;
  const before = f.fake.seen.responses.length;
  const r = await post(f, { model: 'gpt-synthetic', reasoning_effort: 'ultra' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /could not be read, so "ultra" reasoning cannot be checked.*Default, Low, Medium or High/);
  assert.equal(f.fake.seen.responses.length, before);
});

// #1592: a basic level is checked against a published list too, and a model whose loaded entry has no
// levels is refused for that reason, not as an unreadable list.
test('#1592: a basic level the model does not publish is refused; a model without levels says so', async (t) => {
  const f = make(t);
  await connect(f);
  f.fake.state.catalogue = { models: [
    { slug: 'gpt-basic', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
    { slug: 'gpt-nolevels', default_reasoning_level: 'medium' },
  ] };
  const before = f.fake.seen.responses.length;
  let r = await post(f, { model: 'gpt-basic', reasoning_effort: 'high' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /does not offer "high" reasoning for gpt-basic\. It offers low, medium, or Default/);
  r = await post(f, { model: 'gpt-nolevels', reasoning_effort: 'xhigh' });
  assert.equal(r.status, 400);
  const message = (await r.json()).error.message;
  assert.match(message, /"xhigh" reasoning is not in your account's list for gpt-nolevels/);
  assert.doesNotMatch(message, /could not be read/);
  assert.equal(f.fake.seen.responses.length, before, 'nothing refused reached ChatGPT');
  r = await post(f, { model: 'gpt-nolevels', reasoning_effort: 'high' });
  assert.equal(r.status, 200, 'with no published list a basic level goes through as before');
  assert.equal(lastSent(f).reasoning.effort, 'high');
});


// ── sbstndalton/noevia#2190 round 5: the token client ──

test('the access token is cached briefly: re-asked when the broker signals a change, never inside the refresh margin', async (t) => {
  const f = make(t);
  await connect(f);
  const sessions = () => f.b.calls.filter((c) => c.op === 'session').length;
  assert.equal((await f.oauth.session('user-a')).accessToken, 'AT-1');
  await f.oauth.session('user-a');
  assert.equal(sessions(), 1, 'cached');
  f.clock.t += 61_000;
  await f.oauth.session('user-a');
  assert.equal(sessions(), 2, 'at most a minute');
  f.b.state.signal += 1; // the broker changed a token row (refresh, reconnect, disconnect)
  await f.oauth.session('user-a');
  assert.equal(sessions(), 3, 'the change signal drops the cache');
  // A token inside the broker's five-minute refresh margin is never cached: the broker refreshes it.
  f.b.connect('user-a', { accessToken: 'AT-short', expiresAt: f.clock.t + 4 * 60_000 });
  await f.oauth.session('user-a');
  await f.oauth.session('user-a');
  assert.equal(sessions(), 5);
  // A signal that cannot be read is no cache at all.
  const g = make(t);
  await connect(g);
  const blind = chatgpt.createChatGptOAuth({ db: g.db, broker: g.b.broker, signal: () => { throw new Error('EACCES'); }, fetchImpl: g.fake.fetchImpl, now: () => g.clock.t });
  await blind.session('user-a'); await blind.session('user-a');
  assert.equal(g.b.calls.filter((c) => c.op === 'session').length, 2);
});

test('the broker unreachable is "try again" (503 transient), never a disconnect', async (t) => {
  const f = make(t);
  await connect(f);
  f.b.state.down = true;
  await assert.rejects(f.oauth.session('user-a'), (e) => e.status === 503 && e.code === 'transient');
  const r = await f.oauth.fetchFor('user-a')('https://c/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-synthetic', messages: [] }) });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('x-noevia-provider-message'), '1');
  assert.equal(f.fake.seen.responses.length, 0);
  assert.equal(f.oauth.status('user-a').state, 'connected');
  await assert.rejects(f.oauth.disconnect('user-a'), (e) => e.status === 503);
});

test('this process holds no refresh token, writes no token row and keeps no device sign-in', (t) => {
  const source = fs.readFileSync(require.resolve('./chatgpt-oauth.cjs'), 'utf8');
  assert.doesNotMatch(source, /refresh_token|refreshToken|deviceauth|secrets\.(en|de)crypt|INSERT INTO chatgpt_oauth_tokens|UPDATE chatgpt_oauth_tokens|DELETE FROM chatgpt_oauth_tokens/);
  const f = make(t);
  assert.deepEqual(Object.keys(f.oauth).sort(), ['disconnect', 'fetchFor', 'session', 'status']);
  assert.equal(f.oauth.status('nobody').state, 'disconnected');
  f.db.prepare("INSERT INTO chatgpt_oauth_tokens(user_id,data_enc,state,updated_at) VALUES('user-r','enc:v2:x','reconnect',1)").run();
  assert.equal(f.oauth.status('user-r').state, 'reconnect');
});
