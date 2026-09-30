'use strict';
// #682: why System-One decisions fall back. The tool gate sent requests the private decision
// service refuses (more than 8 options, labels over 120 characters, an option-head token budget),
// so 157 of 158 decisions fell back as "no-backend-answered" in ~2 ms; supervision errors had no
// reason at all. Synthetic fixtures only: fake fetch, fake backends, no network, no real text.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDecisionSettings, SERVICE_LIMITS } = require('./decision-settings.cjs');
const { createDecisions, causeOf, CAUSE_RE } = require('./decision/index.cjs');
const { createFeatures } = require('./features.cjs');
const { createToolGate, shapeOptions } = require('./tool-gate.cjs');
const { createStepSupervision } = require('./step-supervision.cjs');
const { createSystemOneRouter } = require('./system-one-router.cjs');
const { createDecisionLog, summarize } = require('./decision-log.cjs');

const SECRET = 'SYNTHETIC-PRIVATE-SENTINEL-7f3a';
const store = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
const tool = (name, description = `${name} reads synthetic data. `.repeat(12)) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, required: [] } } });

/** The request checks of services/laya/server.py validate(), mirrored. */
function layaRefuses(body) {
  if (!body || Object.keys(body).sort().join() !== 'options,question,state') return 'shape';
  if (typeof body.state !== 'string' || body.state.length > 4000) return 'state';
  if (typeof body.question !== 'string' || !(body.question.length >= 1 && body.question.length <= 500)) return 'question';
  if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 8) return 'option count';
  for (const o of body.options) {
    if (Object.keys(o).sort().join() !== 'id,label' || !/^[a-z][a-z0-9_]{0,31}$/.test(o.id) || typeof o.label !== 'string' || o.label.length < 1 || o.label.length > 120) return 'option';
  }
  if (new Set(body.options.map((o) => o.id)).size !== body.options.length) return 'duplicate';
  return null;
}

/** A fake Laya: refuses what the real one refuses (422), otherwise picks `pick` (a service id). */
function fakeLaya(pick, seen = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if (layaRefuses(body)) return Response.json({ error: 'Invalid or over-budget decision request' }, { status: 422 });
    const ids = body.options.map((o) => o.id);
    const chosen = typeof pick === 'function' ? pick(ids) : pick;
    const rest = (1 - 0.9) / (ids.length - 1);
    return Response.json({ selected: chosen, scores: Object.fromEntries(ids.map((id) => [id, id === chosen ? 0.9 : rest])), model: 'convaiinnovations/laya', calibrated: false });
  };
}

function configured(fetchImpl, kinds) {
  const settings = createDecisionSettings({ store: store(), env: {}, fetchImpl, ...(kinds ? { kinds } : {}) });
  settings.save({ url: 'http://laya:8040', timeoutMs: 1500 }, 'admin');
  return settings;
}

function gateFor(settings, logs, extra = {}) {
  let decisions = null, last = null;
  return createToolGate({ enabled: () => true, isWriteTool: (n) => /write/.test(n), log: (e) => logs.push(e), minConfidence: 0.5,
    limits: () => settings.backend()?.limits || null, unavailable: () => settings.unavailable('choice'),
    decide: (request) => {
      const backend = settings.backend();
      if (backend !== last) { last = backend; decisions = createDecisions({ backends: { configured: backend }, chains: { 'tool.gate': ['configured'] } }); }
      return decisions.decide(request);
    }, ...extra });
}

test('a service without `choice` is reported as unsupported in Settings and once in the log, never called per message', async () => {
  let calls = 0;
  const settings = configured(async () => { calls++; throw Error('must not be called'); }, []);
  assert.match(settings.unavailable('choice'), /does not support choice decisions/);
  assert.equal(settings.unavailable(), null, 'without a kind: only "is a service configured"');
  // Settings (features) shows it with a translatable id, and the experiment cannot be switched on.
  const features = createFeatures({ store: store(), env: {}, availability: { toolGate: () => settings.unavailable('choice') } });
  const row = features.describe().find((f) => f.id === 'toolGate');
  assert.equal(row.unavailableId, 'decisionUnsupported');
  assert.equal(features.enabled('toolGate'), false);
  assert.throws(() => features.set('toolGate', true, 'admin'));
  // The gate itself, if wired without the feature check, skips Stage 2 with a clear reason, warning once.
  const logs = [], warnings = [];
  const gate = gateFor(settings, logs, { warn: (line) => warnings.push(line) });
  for (let i = 0; i < 3; i++) await gate.evaluate('Take care of the synthetic thing', [tool('project_search')]);
  assert.equal(calls, 0);
  assert.deepEqual(logs.map((l) => l.reason), ['unsupported', 'unsupported', 'unsupported']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /does not support choice/);
  // The decision layer, too, names why a chain did not answer.
  const r = await createDecisions({ backends: { configured: settings.backend() }, chains: { p: ['configured'] } })
    .decide({ kind: 'choice', purpose: 'p', question: 'q', options: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], fallback: { selected: null, scores: {} }, constraints: { deadlineMs: 100 } });
  assert.deepEqual([r.metadata.fellBack, r.metadata.cause], ['no-backend-answered', 'unsupported-kind']);
});

test('the tool gate request fits the service: at most 8 options, safe ids, short labels, inside the budget', async () => {
  // 12 read tools with long descriptions and one awkward name; before #682 this was a 422 every time.
  const offered = [...Array.from({ length: 10 }, (_, i) => tool(`synthetic_reader_${i}`)), tool('Web-Fetch'), tool('tavily_search'), tool('nc_webdav_write_file')];
  const seen = [];
  const settings = configured(fakeLaya((ids) => ids.find((id) => id === 'tavily_search'), seen));
  const logs = [];
  const out = await gateFor(settings, logs).evaluate('Please take care of the synthetic thing', offered);
  assert.equal(seen.length, 1);
  const body = seen[0];
  assert.equal(layaRefuses(body), null);
  assert.ok(body.options.length <= SERVICE_LIMITS.maxOptions);
  const chars = body.question.length + body.options.reduce((n, o) => n + o.id.length + o.label.length + 2, 0);
  assert.ok(chars <= SERVICE_LIMITS.maxChoiceChars, `${chars} chars`);
  assert.equal(body.options[0].id, 'tavily_search', 'tools the gate knows come first');
  assert.equal(body.options.at(-1).id, 'none');
  assert.ok(!body.options.some((o) => /write/.test(o.id)), 'never a write tool');
  // The answer maps back to the offered tool, and the log says how many tools were left out.
  assert.equal(out.source, 'decision');
  assert.equal(out.decision.tool, 'tavily_search');
  assert.equal(logs[0].options, body.options.length);
  assert.equal(logs[0].trimmed, 12 - (body.options.length - 1));
});

test('an id the service would refuse is mapped there and back', async () => {
  const seen = [];
  const settings = configured(fakeLaya('web_fetch_2', seen));
  const out = await gateFor(settings, []).evaluate('Take care of the synthetic thing', [tool('Web-Fetch'), tool('web_fetch')]);
  assert.equal(layaRefuses(seen[0]), null);
  // web_fetch is a tool the gate's rules know, so it is listed first and keeps its own id.
  assert.deepEqual(seen[0].options.map((o) => o.id), ['web_fetch', 'web_fetch_2', 'none']);
  assert.equal(out.decision.tool, 'Web-Fetch');
});

test('without backend limits (llama-logit readout) the options are unchanged', () => {
  const tools = Array.from({ length: 30 }, (_, i) => tool(`synthetic_reader_${i}`, 'x'.repeat(300)));
  const { options, trimmed } = shapeOptions(tools, null);
  assert.equal(options.length, 25);
  assert.equal(trimmed, 6);
  assert.equal(options[0].label, `synthetic_reader_0: ${'x'.repeat(160)}`);
});

test('a refused request is logged with its cause, not only "no-backend-answered"', async () => {
  const settings = configured(async () => Response.json({ error: 'x' }, { status: 422 }));
  const logs = [];
  await gateFor(settings, logs).evaluate('Take care of the synthetic thing', [tool('project_search')]);
  assert.deepEqual([logs[0].reason, logs[0].cause], ['no-backend-answered', 'http-422']);
});

test('supervision errors record a text-free cause', async () => {
  const cases = [
    [async () => Response.json({ error: 'Decision unavailable' }, { status: 503 }), 'error', 'http-503'],
    [async () => Response.json({ error: 'x' }, { status: 422 }), 'error', 'http-422'],
    [async () => new Response('{not json', { status: 200 }), 'error', 'parse'],
    [async () => Response.json({ selected: 'verify', scores: { continue: 0.5, verify: 0.2, escalate: 0.3 } }), 'error', 'invalid-result'],
    [async () => { throw new TypeError('fetch failed'); }, 'error', 'network'],
    [() => new Promise(() => {}), 'no-decision', 'deadline'],
  ];
  for (const [fetchImpl, fellBack, cause] of cases) {
    const settings = configured(fetchImpl);
    const logs = [];
    const supervisor = createStepSupervision({ enabled: () => true, deadlineMs: 50, log: (e) => logs.push(e),
      provider: { decide: (...args) => settings.backend().supervise(...args) } });
    const out = await supervisor.decide({ round: 0, messages: [{ role: 'user', content: SECRET }, { role: 'tool', content: 'synthetic result' }] });
    assert.deepEqual(out, { action: 'continue', source: 'existing' });
    assert.deepEqual(logs, [{ round: 0, action: 'continue', fellBack, cause }], cause);
  }
});

test('routing fallbacks record the cause', async () => {
  const settings = configured(async () => Response.json({ error: 'Decision unavailable' }, { status: 503 }));
  const logs = [];
  const router = createSystemOneRouter({ enabled: () => true, env: {}, roles: () => ({ fast: 'f', smart: 's' }), fallback: async () => 'smart',
    getBackend: settings.backend, log: (e) => logs.push(e) });
  const out = await router.classifyWithDetails('synthetic question');
  assert.equal(out.role, 'smart');
  assert.deepEqual([logs[0].fellBack, logs[0].cause], ['no-backend-answered', 'http-503']);
});

test('causeOf never returns error text', () => {
  assert.equal(causeOf(Error(SECRET)), 'exception');
  assert.equal(causeOf(Object.assign(Error('x'), { reason: `${SECRET} with spaces` })), 'exception');
  assert.equal(causeOf(Object.assign(Error('x'), { reason: 'http-503' })), 'http-503');
  assert.equal(causeOf(Object.assign(Error('deadline'), { deadline: true })), 'deadline');
  assert.equal(causeOf(new SyntaxError(SECRET)), 'parse');
});

test('log schema: route, tool-gate, supervise and outcome records hold only known, text-free fields', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-682-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = createDecisionLog({ dir, echo: null });
  // Every failure carries the sentinel in its message or response body; none of it may reach the log.
  const failing = [
    async () => Response.json({ error: SECRET }, { status: 503 }),
    async () => new Response(`${SECRET}{`, { status: 200 }),
    async () => { throw Error(SECRET); },
  ];
  for (const fetchImpl of [...failing, fakeLaya((ids) => ids[0])]) {
    const settings = configured(fetchImpl);
    await createSystemOneRouter({ enabled: () => true, env: {}, roles: () => ({ fast: 'f', smart: 's', code: 'c' }), fallback: async () => 'smart',
      getBackend: settings.backend, log: (e) => record('route', e) }).classifyWithDetails(`${SECRET} route`);
    const logs = [];
    await gateFor(settings, logs).evaluate(`${SECRET} gate`, [tool('project_search', SECRET), tool('synthetic_reader', SECRET)]);
    for (const e of logs) record('tool-gate', e);
    await createStepSupervision({ enabled: () => true, deadlineMs: 200, log: (e) => record('supervise', e),
      provider: { decide: (...args) => settings.backend().supervise(...args) } })
      .decide({ round: 0, messages: [{ role: 'user', content: SECRET }, { role: 'tool', content: SECRET }] });
  }
  record('outcome', { event: 'regenerate', previousRole: 'fast', previousStatus: 'accepted', auto: true, role: 'smart', status: 'accepted' });
  const text = fs.readFileSync(path.join(dir, 'system-one-decisions.jsonl'), 'utf8');
  assert.equal(text.includes(SECRET), false);
  const allowed = {
    route: ['at', 'kind', 'selected', 'options', 'margin', 'ms', 'fellBack', 'cause'],
    'tool-gate': ['at', 'kind', 'event', 'source', 'tool', 'mode', 'confidence', 'offered', 'ms', 'reason', 'cause', 'rule', 'options', 'trimmed'],
    supervise: ['at', 'kind', 'round', 'action', 'fellBack', 'cause'],
    outcome: ['at', 'kind', 'event', 'previousRole', 'previousStatus', 'auto', 'role', 'status'],
  };
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([...new Set(rows.map((r) => r.kind))].sort(), Object.keys(allowed).sort());
  for (const row of rows) {
    for (const key of Object.keys(row)) assert.ok(allowed[row.kind].includes(key), `${row.kind}.${key}`);
    for (const [key, value] of Object.entries(row)) assert.ok(value === null || ['number', 'boolean'].includes(typeof value) || (typeof value === 'string' && value.length <= 40), `${row.kind}.${key}`);
    if (row.cause != null) assert.match(row.cause, CAUSE_RE);
  }
  assert.ok(rows.some((r) => r.kind === 'route' && r.cause === 'http-503'));
  assert.ok(rows.some((r) => r.kind === 'supervise' && r.cause === 'parse'));
  assert.ok(rows.some((r) => r.kind === 'tool-gate' && r.cause === 'network'));
  const summary = summarize(text.trim().split('\n'));
  assert.equal(summary.outcome.event.regenerate, 1);
  assert.equal(summary.supervise.cause['http-503'], 1);
  assert.ok(summary.toolGate.n >= 4);
});

test('a Regenerate/Retry of an Auto turn writes one outcome record with enumerated values only', async (t) => {
  const { EventEmitter } = require('node:events');
  const { createChatHandler } = require('./chat.cjs');
  const { createToolExchange } = require('./tool-exchange.cjs');
  const { createVisionProbe } = require('./vision.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-682-chat-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outcomes = [];
  const fetch = async (url) => (String(url).endsWith('/chat/completions')
    ? { ok: true, status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Synthetic reply.' } }] })}\n\n`); })() }
    : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: ['fast-model', 'smart-model'].map((model_name) => ({ model_name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', routing: 'auto', assets: [], toolboxes: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }), providerHeaders: () => ({}),
    autoRoles: () => ({ fast: 'fast-model', smart: 'smart-model' }),
    classifyFastOrSmart: async () => ({ role: 'smart', routingDecision: { offered: [], scores: {}, selectedRole: 'smart', effectiveRole: 'smart', backend: 'decision-service', model: null, calibrated: false, latencyMs: 5, status: 'accepted', fallbackReason: null } }),
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ authn: { user: { id: 'synthetic-user', role: 'member' } }, workspace: { userId: 'synthetic-user' } }) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'unused', recordOutcome: (e) => outcomes.push(e),
  });
  const send = async (extra) => {
    const res = new EventEmitter(); res.writeHead = () => {}; res.write = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
    await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: `${SECRET} message`, ...extra });
  };
  await send({});
  await send({ resend: { kind: 'regenerate', role: 'fast', status: 'accepted', note: SECRET } });
  await send({ resend: { kind: 'retry', role: SECRET, status: SECRET } });
  await send({ resend: { kind: SECRET } });
  assert.deepEqual(outcomes, [
    { event: 'regenerate', previousRole: 'fast', previousStatus: 'accepted', auto: true, role: 'smart', status: 'accepted' },
    { event: 'retry', previousRole: null, previousStatus: null, auto: true, role: 'smart', status: 'accepted' },
  ]);
});
