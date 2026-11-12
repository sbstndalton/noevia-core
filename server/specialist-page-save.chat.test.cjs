'use strict';
// #2446 slice 4b: the coworker conversation's `space_page_save` through the real chat handler: it is offered in a
// coworker's hidden project only, is asked about every time ("Allow for this chat" never covers it), and
// reaches the Rust front with the ids of the conversation, never ids the model supplied. Synthetic only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createPageSave } = require('./specialist-page-save.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { binding: permissionBinding } = require('../tests/server/chat-grant-fixture.cjs');
const { createApprovals } = require('./approvals.cjs');

const WRITE = 'space_page_save';
const COWORKER = 'specialist-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION = 'specialist-chat-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function harness(t, { holder = () => undefined, policy = null, notWrite = false, gate: toolGateOverride = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-grant-917-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = { id: 'synthetic-user' };
  // A free chat's context project (diary-extras.cjs chatProjectId) resolves without a projectId.
  const projects = new Map(['proj-a', COWORKER].map((id) => [id, { id, name: id, model: 'synthetic-model', routing: 'manual', toolboxes: [], files: [], chats: [] }]));
  const store = { workspace: { userId: user.id }, authn: { user } };
  const requestScope = { getStore: () => store, run: (_scope, fn) => fn() };
  const gate = createApprovals();
  const state = { holder };
  async function turn({ projectId, chatId, decision = 'approve', spaceId, args = { title: 'QA plan', content: '# QA\nbody' }, answer = { status: 200, body: { pageId: 'page-1', spaceId: 'space-1', title: 'QA plan', link: '/spaces/space-1/page-1' } } }) {
    const executions = [], cards = [], events = [], saves = [];
    let round = 0;
    const fetch = async () => {
      const frame = round++ === 0
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-call', function: { name: WRITE, arguments: JSON.stringify(args) } }] } }] }
        : { choices: [{ delta: { content: 'Done.' } }] };
      return { ok: true, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify(frame)}\n\n`); })() };
    };
    const specialistTools = createPageSave({ store: { specialistPageSave: async (payload) => { saves.push(payload); executions.push(WRITE); return answer; } } });
    const toolbox = createToolboxes({
      boxes: [], specialistTools, offered: () => true,
      mcpBoxes: () => [], mcpTools: () => new Map(), prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope,
      scope: requestScope, documentSources: { notice: () => '' }, workspace: () => ({ dir }),
    });
    const res = new EventEmitter();
    res.writeHead = () => {};
    res.write = (line) => events.push(JSON.parse(line.slice(6)));
    res.end = () => { res.writableEnded = true; res.emit('finish'); };
    const handler = createChatHandler({
      fs, path, crypto, fetch, reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange,
      rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: require('./tool-result-reduce.cjs').reduceToolResult,
      HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000,
      authService: { audit() {} },
      toolPolicy: { mode: policy || ((_user, _tool, write) => (write ? 'ask' : 'allow')) },
      modelManager: { enabled: true, load: async () => ({ ok: true }), health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'synthetic-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
      requestScope, currentWorkspace: () => ({ userId: user.id, dir }), json() {}, getProject: (id) => projects.get(id) || null,
      getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', label: 'Mock' }), providerHeaders: () => ({}), saveChats() {}, endpointApproved: () => true,
      diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'), autoRoles: () => null, lastLoadedModel: () => null,
      classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
      visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
      chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) },
      ...(toolGateOverride ? { toolGate: toolGateOverride } : {}),
      ...toolbox, ...(notWrite ? { isWriteTool: (name) => (name === WRITE ? false : toolbox.isWriteTool(name)) } : {}), oauthServerIds: () => new Set(), accountReady: () => true,
      grantContext: async raw => {
        const actual = state.holder(raw);
        const owner = actual === undefined ? (projectId || 'free') : actual;
        return require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: owner === null ? { kind:'absent' } : owner === 'free' ? { kind:'free' } : {kind:'project',id:owner} });
      }, chatWideApproved: gate.chatWideApproved,
      // The card's button press, through the real gate: approve | deny | approve_all.
      awaitApproval: (request) => {
        cards.push(request);
        const waiting = gate.awaitApproval(request);
        assert.equal(gate.pendingApprovals.get(request.id).decide(decision), true);
        return waiting;
      },
      chatListHolder: (id) => state.holder(id),
      recordUsage() {}, recordToolUse() {},
    });
    await handler.handleChat({}, res, { message: 'Synthetic write request', spaceId: spaceId || projectId || 'free', ...(projectId ? { projectId } : {}), chatId, history: [] });
    assert.equal(events.some((e) => e.type === 'error'), false, JSON.stringify(events.filter((e) => e.type === 'error')));
    return { carded: events.some((e) => e.type === 'tool_pending'), pending: events.find((e) => e.type === 'tool_pending') || null, executions, cards, saves, events };
  }
  return { turn, gate, state, user };
}

test('a coworker conversation offers the tool, asks with the card, and sends the conversation ids to the front', async (t) => {
  const h = harness(t);
  const r = await h.turn({ projectId: COWORKER, chatId: CONVERSATION });
  assert.equal(r.carded, true);
  assert.equal(r.pending.name, WRITE);
  assert.equal(r.pending.once, true, 'the card says it is a one-call approval');
  assert.deepEqual(JSON.parse(r.pending.args), { title: 'QA plan', content: '# QA\nbody' });
  assert.deepEqual(r.saves, [{ user: h.user.id, projectId: COWORKER, chatId: CONVERSATION, title: 'QA plan', content: '# QA\nbody' }]);
  const done = r.events.find((e) => e.type === 'tool_result' || (e.type === 'tool' && e.result));
  assert.ok(JSON.stringify(r.events).includes('/spaces/space-1/page-1'), `the link reaches the stream: ${JSON.stringify(done)}`);
});

test('"Allow for this chat" never covers it: the next call asks again, and nothing is remembered', async (t) => {
  const h = harness(t);
  const first = await h.turn({ projectId: COWORKER, chatId: CONVERSATION, decision: 'approve_all' });
  assert.deepEqual(first.executions, [WRITE], 'approve_all still approves the call on the card');
  const second = await h.turn({ projectId: COWORKER, chatId: CONVERSATION, decision: 'deny' });
  assert.equal(second.carded, true, 'the second call is asked about');
  assert.deepEqual(second.executions, [], 'declined: the front is not called');
});

test('ids the model puts in the arguments are not the grant: the conversation\'s own are sent', async (t) => {
  const h = harness(t);
  const r = await h.turn({ projectId: COWORKER, chatId: CONVERSATION, args: { title: 'QA t', content: 'x', user: 'other', projectId: 'proj-a', chatId: 'chat-z', spaceId: 'space-9' } });
  assert.equal(r.saves.length, 1);
  assert.equal(r.saves[0].user, h.user.id);
  assert.equal(r.saves[0].projectId, COWORKER);
  assert.equal(r.saves[0].chatId, CONVERSATION);
  assert.equal(r.saves[0].spaceId, 'space-9', 'the Space is the model\'s ask; the front decides whether it is granted');
});

test('any other project is not offered the tool: a call for it is refused before anyone is asked', async (t) => {
  const h = harness(t);
  const r = await h.turn({ projectId: 'proj-a', chatId: 'chat-x' });
  assert.equal(r.carded, false);
  assert.deepEqual(r.saves, []);
  assert.ok(JSON.stringify(r.events).includes('is not enabled for this project'), 'the loop refuses a tool it did not offer');
});

test('the front refusing a Space reaches the model as an ERROR result', async (t) => {
  const h = harness(t);
  const r = await h.turn({ projectId: COWORKER, chatId: CONVERSATION, answer: { status: 400, body: { error: 'That Space is not one this coworker may save to; nothing was saved.', code: 'invalid_request' } } });
  assert.ok(JSON.stringify(r.events).includes('ERROR: That Space is not one this coworker may save to; nothing was saved.'));
});

test('an account policy of allow still shows the card, once, and nothing is saved before approval', async (t) => {
  const h = harness(t, { policy: () => 'allow' });
  const r = await h.turn({ projectId: COWORKER, chatId: CONVERSATION, decision: 'deny' });
  assert.equal(r.carded, true, 'allow does not skip the card');
  assert.equal(r.pending.once, true);
  assert.deepEqual(r.saves, [], 'declined: nothing reached the store');
});

test('a tool the loop does not count as a write still shows the card, once, before any save', async (t) => {
  const h = harness(t, { policy: (_u, _t, write) => (write ? 'ask' : 'allow'), notWrite: true });
  const r = await h.turn({ projectId: COWORKER, chatId: CONVERSATION, decision: 'deny' });
  assert.equal(r.carded, true, 'not-a-write does not skip the card');
  assert.equal(r.pending.once, true);
  assert.deepEqual(r.saves, []);
});

test('a block policy stays a block: no card, no save', async (t) => {
  const h = harness(t, { policy: () => 'block' });
  const r = await h.turn({ projectId: COWORKER, chatId: CONVERSATION });
  assert.equal(r.carded, false);
  assert.deepEqual(r.saves, []);
});

test('the tool gate can never pre-run it: a prefetch decision for it sends nothing to the store', async (t) => {
  const h = harness(t, { policy: () => 'allow', gate: { evaluate: async () => ({ decision: { tool: WRITE, mode: 'prefetch', args: { title: 'QA gate', content: 'x' } } }) } });
  const r = await h.turn({ projectId: COWORKER, chatId: CONVERSATION, decision: 'deny' });
  assert.equal(r.saves.length, 0, 'nothing saved without the card being approved');
  assert.equal(r.events.some((e) => e.type === 'tool' && e.name === WRITE && !r.carded), false);
});
