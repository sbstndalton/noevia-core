'use strict';
// #917: "Allow for this chat" is bound to the project (or space) it was given in. The same chat id
// sent under another projectId gets an approval card; the three actions and the #814 move
// revocation behave as before. Synthetic projects, chats and tools only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createDriveTools } = require('./gdrive-tools.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createApprovals } = require('./approvals.cjs');

const WRITE = 'drive_trash_file';

function harness(t, { holder = () => undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-grant-917-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = { id: 'synthetic-user' };
  // A free chat's context project (diary-extras.cjs chatProjectId) resolves without a projectId.
  const projects = new Map(['proj-a', 'proj-b', 'cowork-chat-context-chat-x'].map((id) => [id, { id, name: id, model: 'synthetic-model', routing: 'manual', toolboxes: ['core'], files: [], chats: [] }]));
  const store = { workspace: { userId: user.id }, authn: { user } };
  const requestScope = { getStore: () => store, run: (_scope, fn) => fn() };
  const definitions = createDriveTools({ accounts: { forUser: () => ({ drive: { state: () => ({ state: 'connected' }) } }) } });
  const gate = createApprovals();
  const state = { holder };
  async function turn({ projectId, chatId, decision = 'approve', spaceId }) {
    const executions = [], cards = [], events = [];
    let round = 0;
    const fetch = async () => {
      const frame = round++ === 0
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-call', function: { name: WRITE, arguments: '{}' } }] } }] }
        : { choices: [{ delta: { content: 'Done.' } }] };
      return { ok: true, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify(frame)}\n\n`); })() };
    };
    const driveTools = { ...definitions, execute: async (_user, tool) => { executions.push(tool); return 'synthetic result'; } };
    const toolbox = createToolboxes({
      boxes: [driveTools.box], driveTools, offered: (id) => id !== 'gdrive',
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
      toolPolicy: { mode: (_user, _tool, write) => (write ? 'ask' : 'allow') },
      modelManager: { enabled: true, load: async () => ({ ok: true }), health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'synthetic-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
      requestScope, currentWorkspace: () => ({ userId: user.id, dir }), json() {}, getProject: (id) => projects.get(id) || null,
      getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', label: 'Mock' }), providerHeaders: () => ({}), saveChats() {}, endpointApproved: () => true,
      diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'), autoRoles: () => null, lastLoadedModel: () => null,
      classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
      visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
      chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) },
      ...toolbox, oauthServerIds: () => new Set(), accountReady: () => true,
      chatWideApproved: gate.chatWideApproved,
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
    return { carded: events.some((e) => e.type === 'tool_pending'), executions, cards };
  }
  return { turn, gate, state, user };
}

test('a grant given in project A does not cover the same chat id sent with project B (#917)', async (t) => {
  const h = harness(t);
  const granted = await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'approve_all' });
  assert.equal(granted.carded, true, 'the first write asks');
  assert.deepEqual(granted.executions, [WRITE], 'Allow for this chat runs the call');
  const same = await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' });
  assert.equal(same.carded, false, 'same project: still auto-approved');
  assert.deepEqual(same.executions, [WRITE]);
  const other = await h.turn({ projectId: 'proj-b', chatId: 'chat-x', decision: 'deny' });
  assert.equal(other.carded, true, 'another project: the approval card is sent');
  assert.deepEqual(other.executions, [], 'and the declined write does not run');
  const back = await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' });
  assert.equal(back.carded, false, 'the grant in A is untouched by the refused requests');
});

test('a chat id another list holds gets no chat-wide grant: approve_all approves only that call (#917)', async (t) => {
  // chat-x lives in project A; requests naming it under project B are a stale tab or hand-made.
  const h = harness(t, { holder: (id) => (id === 'chat-x' ? 'proj-a' : null) });
  const first = await h.turn({ projectId: 'proj-b', chatId: 'chat-x', decision: 'approve_all' });
  assert.equal(first.carded, true);
  assert.deepEqual(first.executions, [WRITE], 'Allow for this chat still runs the call it answered');
  assert.equal(first.cards[0].chatId, null, 'no grant is created for a chat this project does not hold');
  const again = await h.turn({ projectId: 'proj-b', chatId: 'chat-x', decision: 'deny' });
  assert.equal(again.carded, true, 'the next write in B asks again');
  // In its own project the chat keeps the normal behaviour; a chat no list holds yet (first turn) too.
  await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'approve_all' });
  assert.equal((await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' })).carded, false);
  await h.turn({ projectId: 'proj-b', chatId: 'chat-new', decision: 'approve_all' });
  assert.equal((await h.turn({ projectId: 'proj-b', chatId: 'chat-new', decision: 'deny' })).carded, false);
  // A holder lookup that throws fails closed: no chat-wide grant is honoured.
  h.state.holder = () => { throw new Error('synthetic list failure'); };
  assert.equal((await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' })).carded, true);
});

test('a genuine move from A to B still revokes the grant; B can then be granted on its own (#814, #917)', async (t) => {
  const lists = { 'chat-x': 'proj-a' };
  const h = harness(t, { holder: (id) => lists[id] ?? null });
  await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'approve_all' });
  assert.equal((await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' })).carded, false);
  // What POST /api/chats/:id/move does on a list change (routes/chat-lists.cjs).
  lists['chat-x'] = 'proj-b';
  assert.equal(h.gate.revokeChatGrant(h.user.id, 'chat-x'), true);
  const moved = await h.turn({ projectId: 'proj-b', chatId: 'chat-x', decision: 'approve_all' });
  assert.equal(moved.carded, true, 'after the move the next write asks again');
  assert.equal((await h.turn({ projectId: 'proj-b', chatId: 'chat-x', decision: 'deny' })).carded, false, 'granted again in B');
  assert.equal((await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' })).carded, true, 'a stale A tab is asked');
});

test('Decline and Allow once are unaffected and never create a grant (#917)', async (t) => {
  const h = harness(t);
  const declined = await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' });
  assert.equal(declined.carded, true);
  assert.deepEqual(declined.executions, []);
  const once = await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'approve' });
  assert.equal(once.carded, true);
  assert.deepEqual(once.executions, [WRITE]);
  const next = await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' });
  assert.equal(next.carded, true, 'neither answer widens to the chat');
  assert.deepEqual(next.executions, []);
});

test('the gate honours a grant only in the scope it was given in; revoke ignores scope (#917)', async () => {
  const gate = createApprovals();
  const grant = async (scope) => {
    const ctl = new AbortController();
    const waiting = gate.awaitApproval({ id: 'g', userId: 'u1', chatId: 'c1', scope, abortSignal: ctl.signal });
    assert.equal(gate.pendingApprovals.get('g').decide('approve_all'), true);
    assert.equal(await waiting, 'approve');
  };
  await grant('project:a');
  assert.equal(gate.chatWideApproved('u1', 'c1', 'project:a'), true);
  assert.equal(gate.chatWideApproved('u1', 'c1', 'project:b'), false);
  assert.equal(gate.chatWideApproved('u1', 'c1', 'context:a'), false);
  assert.equal(gate.chatWideApproved('u1', 'c1'), false, 'a scoped grant is not honoured without a scope');
  assert.equal(gate.chatWideApproved('u2', 'c1', 'project:a'), false, 'another user still asks');
  assert.equal(gate.revokeChatGrant('u1', 'c1'), true);
  assert.equal(gate.chatWideApproved('u1', 'c1', 'project:a'), false);
});

test('a free chat granted under its context project is asked when the same chat id names a project explicitly (#917)', async (t) => {
  const h = harness(t, { holder: (id) => (id === 'chat-x' ? 'free' : null) });
  // Free chat (no projectId): the chat's own context project resolves, and the grant lives there.
  const granted = await h.turn({ chatId: 'chat-x', decision: 'approve_all' });
  assert.equal(granted.carded, true);
  assert.deepEqual(granted.executions, [WRITE]);
  assert.equal((await h.turn({ chatId: 'chat-x', decision: 'deny' })).carded, false, 'same free chat: still auto-approved');
  // The very same project id, but named explicitly: another scope, and the free list holds the chat.
  const explicit = await h.turn({ projectId: 'cowork-chat-context-chat-x', chatId: 'chat-x', decision: 'deny' });
  assert.equal(explicit.carded, true, 'explicit projectId with the same chat id asks');
  assert.deepEqual(explicit.executions, []);
  assert.equal((await h.turn({ projectId: 'proj-a', chatId: 'chat-x', decision: 'deny' })).carded, true, 'another project asks');
  // Even with no list lookup at all, the scope alone keeps the context grant out of the explicit request.
  h.state.holder = () => undefined;
  assert.equal((await h.turn({ projectId: 'cowork-chat-context-chat-x', chatId: 'chat-x', decision: 'deny' })).carded, true);
  assert.equal((await h.turn({ chatId: 'chat-x', decision: 'deny' })).carded, false, 'the free chat keeps its grant');
});

test('listHolding finds the one list that holds a chat id (#917)', () => {
  const { listHolding } = require('./chat-lists.cjs');
  const free = [{ id: 'f1' }], projects = [{ id: 'p1', chats: [{ id: 'c1' }] }, { id: 'p2' }, null, { id: 'p3', chats: [null, { id: 'c3' }] }];
  assert.equal(listHolding('f1', free, projects), 'free');
  assert.equal(listHolding('c1', free, projects), 'p1');
  assert.equal(listHolding('c3', free, projects), 'p3');
  assert.equal(listHolding('new-chat', free, projects), null, 'a chat no list holds yet');
  for (const bad of [null, undefined, '', 7]) assert.equal(listHolding(bad, free, projects), null);
  assert.equal(listHolding('c1', undefined, undefined), null);
});
