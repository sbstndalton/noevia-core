'use strict';
// #679: reloading the page mid-reply dropped the whole turn. The client now saves the user message
// as the turn starts; when the client disconnects before the reply ends, the server appends the
// reply as stopped, keeping any write that ran. A pending approval never runs and is not recorded
// as declined. The real chat loop (createChatHandler) with a scripted synthetic model, synthetic
// tools and a temporary workspace only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createApprovals } = require('./approvals.cjs');
const { createTurnRecord, saveInterruptedTurn } = require('./chat-interrupted-turn.cjs');

const TARGET = 'noevia projects/Synthetic/Text/qa-679.md';
const APPEND = { name: 'qa-679.md', text: '\nZusatz: 3' };
const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n\n`);
const say = (text) => sse({ choices: [{ delta: { content: text } }] });
const think = (text) => sse({ choices: [{ delta: { reasoning_content: text } }] });
const toolCall = (name, args, id) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
const DISCONNECT = Symbol('disconnect');
const tick = () => new Promise((r) => setImmediate(r));

function workspaceAt(dir, userId) {
  return { userId, dir, assetDir: () => '/synthetic-only', historyPath: (id) => path.join(dir, `history-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`) };
}
const readStored = (ws, id) => { try { return JSON.parse(fs.readFileSync(ws.historyPath(id), 'utf8')).history; } catch { return null; } };
const store = (ws, id, history) => fs.writeFileSync(ws.historyPath(id), JSON.stringify({ history }));

/** One handler. Each scripted model turn is a list of chunks; DISCONNECT in it closes the client
 *  connection at that point (the stream then ends the way an aborted fetch does). */
function harness(t, { approvals = createApprovals(), onPending = null, workspaces = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-679-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'a')); fs.mkdirSync(path.join(root, 'b'));
  const a = workspaceAt(path.join(root, 'a'), 'synthetic-user-a'), b = workspaceAt(path.join(root, 'b'), 'synthetic-user-b');
  const state = { turns: [], requests: [], executed: [], res: null, workspaceCalls: 0 };
  const disconnect = () => { state.res.emit('close'); };
  const fetch = async (_url, init) => {
    state.requests.push(JSON.parse(init.body));
    const chunks = state.turns.shift() || [say('SYNTHETIC-DONE')];
    return { ok: true, body: (async function* () {
      for (const chunk of chunks) {
        if (chunk === DISCONNECT) { disconnect(); await tick(); }
        if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (chunk !== DISCONNECT) yield chunk;
      }
    })() };
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'),
    authService: { audit() {}, diaryEnabled: () => true },
    crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 40, STORED_HISTORY_CAP: 5000, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    // Tenant pinning: the first call is the requesting account (a); anything later would be b.
    currentWorkspace: () => (workspaces ? workspaces(state.workspaceCalls++, a, b) : a),
    getProject: () => ({ id: 'synthetic-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [],
    CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: (_user, _name, write) => (write ? 'ask' : 'allow') },
    requestScope: { getStore: () => ({ workspace: { userId: 'synthetic-user-a' } }) },
    resolveTools: () => ({ tools: ['synthetic_append', 'synthetic_read'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })), dropped: [] }),
    isWriteTool: (name) => name === 'synthetic_append',
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text: String(text) }),
    diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [],
    executeToolCall: async (_p, name, args) => { state.executed.push({ name, args: JSON.parse(args) }); return name === 'synthetic_read' ? 'Zahl: 1' : `Appended 10 chars to "${TARGET}".`; },
    chatWideApproved: () => false,
    awaitApproval: (card) => { const p = approvals.awaitApproval(card); if (onPending) onPending(card, state, disconnect); return p; },
    recordUsage() {}, recordToolUse() {},
    writeTargetFor: async (name) => (name === 'synthetic_append' ? { target: TARGET } : null),
  });
  async function send(body) {
    const events = [], res = new EventEmitter();
    state.res = res;
    res.writeHead = () => {}; res.write = (line) => { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); };
    res.end = () => { res.writableEnded = true; res.emit('finish'); };
    await handleChat({}, res, { projectId: 'synthetic-project', spaceId: 'synthetic-project', chatId: 'chat-679', ...body }, { user: { id: 'synthetic-user-a' } });
    return events;
  }
  return { state, send, a, b, approvals };
}

const USER = { role: 'user', content: 'Write a four-line poem about tea.' };

test('a reload mid-reply keeps the user message and the partial reply (no write involved)', async (t) => {
  const h = harness(t);
  store(h.a, 'chat-679', [USER]); // saved by the client as the turn started
  h.state.turns.push([say('Steam rises slowly,'), say(' amber'), DISCONNECT, say(' never seen')]);
  const events = await h.send({ message: USER.content });
  assert.equal(events.some((e) => e.type === 'done'), false, 'the stream never finished');
  const history = readStored(h.a, 'chat-679');
  assert.equal(history.length, 2, JSON.stringify(history));
  assert.deepEqual(history[0], USER, 'the user message stays exactly as the client saved it');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content, 'Steam rises slowly, amber', 'the text streamed before the disconnect, nothing after');
  assert.equal(history[1].paused, undefined, 'no change note without a change');
  assert.equal(history[1].toolCalls, undefined);
});

test('a reload while the model is still thinking keeps the turn as the Stopped placeholder', async (t) => {
  const h = harness(t);
  store(h.a, 'chat-679', [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'earlier answer' }, USER]);
  h.state.turns.push([think('Let me consider'), DISCONNECT]);
  await h.send({ message: USER.content });
  const history = readStored(h.a, 'chat-679');
  assert.equal(history.length, 4);
  assert.deepEqual(history.slice(0, 3).map((e) => e.content), ['earlier', 'earlier answer', USER.content]);
  assert.deepEqual({ role: history[3].role, content: history[3].content, model: history[3].model, reasoning: history[3].reasoning },
    { role: 'assistant', content: '', model: 'Stopped', reasoning: undefined }, 'the language-neutral Stopped token (#634), which keeps Regenerate');
});

test('a reload after an approved write keeps its applied record and the "1 change was saved" note', async (t) => {
  const h = harness(t, { onPending: (card, _state) => { setImmediate(() => h.approvals.pendingApprovals.get(card.id).decide('approve')); } });
  store(h.a, 'chat-679', [{ role: 'user', content: 'Append "Zusatz: 3" to qa-679.md.' }]);
  h.state.turns.push([toolCall('synthetic_append', APPEND, 'call-1')], [say('Done: the line'), DISCONNECT, say(' was added.')]);
  await h.send({ message: 'Append "Zusatz: 3" to qa-679.md.' });
  assert.equal(h.state.executed.length, 1, 'the approved write ran once');
  const history = readStored(h.a, 'chat-679');
  assert.equal(history.length, 2, JSON.stringify(history));
  const reply = history[1];
  assert.equal(reply.content, 'Done: the line');
  assert.equal(reply.toolCalls.length, 1);
  assert.deepEqual({ name: reply.toolCalls[0].name, status: reply.toolCalls[0].status, applied: reply.toolCalls[0].applied, target: reply.toolCalls[0].target },
    { name: 'synthetic_append', status: 'done', applied: true, target: TARGET });
  assert.equal(reply.toolCalls[0].args, JSON.stringify(APPEND), 'the arguments are kept, so the next turn is told this exact change is done');
  assert.deepEqual(reply.paused, { reason: 'stopped', applied: 1 });
});

test('a reload while an approval card is open: the write never runs, is not "declined", and cannot be approved later', async (t) => {
  let approvalId = null;
  const h = harness(t, { onPending: (card, _state, disconnect) => { approvalId = card.id; setImmediate(disconnect); } });
  store(h.a, 'chat-679', [{ role: 'user', content: 'Append it.' }]);
  h.state.turns.push([toolCall('synthetic_append', APPEND, 'call-1')], [say('never requested')]);
  await h.send({ message: 'Append it.' });
  assert.equal(h.state.executed.length, 0, 'the pending write did not run');
  assert.equal(h.state.requests.length, 1, 'no further model round after the disconnect');
  assert.equal(h.approvals.pendingApprovals.has(approvalId), false, 'the approval is gone: a late Allow has nothing to approve');
  const history = readStored(h.a, 'chat-679');
  assert.equal(history.length, 2);
  const call = history[1].toolCalls[0];
  assert.equal(call.status, 'stopped', 'shown as stopped, not declined and not pending');
  assert.equal(call.applied, undefined);
  assert.equal(call.approvalId, undefined, 'no dead approval card is stored');
  assert.match(call.result, /stopped before synthetic_append was approved, so it was not run/);
  assert.equal(history[1].paused, undefined, 'nothing was saved, so no change note');
  assert.equal(history[1].model, 'Stopped');
});

test('nothing is written when the reply finishes, when someone already saved past the turn, or for a deleted chat', async (t) => {
  const done = harness(t);
  store(done.a, 'chat-679', [USER]);
  done.state.turns.push([say('A whole poem.')]);
  const events = await done.send({ message: USER.content });
  assert.equal(events.at(-1).type, 'done');
  assert.deepEqual(readStored(done.a, 'chat-679'), [USER], 'a finished reply is saved by the client, not here');

  const stopped = harness(t);
  // The client pressed Stop and saved its own copy first (tab still open).
  const saved = [USER, { role: 'assistant', content: 'Steam', model: 'Stopped' }];
  store(stopped.a, 'chat-679', saved);
  stopped.state.turns.push([say('Steam'), DISCONNECT]);
  await stopped.send({ message: USER.content });
  assert.deepEqual(readStored(stopped.a, 'chat-679'), saved, 'not appended twice');

  const other = harness(t);
  store(other.a, 'chat-679', [{ role: 'user', content: 'a different message' }]);
  other.state.turns.push([say('Steam'), DISCONNECT]);
  await other.send({ message: USER.content });
  assert.equal(readStored(other.a, 'chat-679').length, 1, 'the user message never reached storage: nothing is guessed');

  const deleted = harness(t);
  store(deleted.a, 'chat-679', [USER]);
  require('./chat-lists.cjs').addTombstone(deleted.a.dir, 'chat-679');
  deleted.state.turns.push([say('Steam'), DISCONNECT]);
  await deleted.send({ message: USER.content });
  assert.deepEqual(readStored(deleted.a, 'chat-679'), [USER], 'a deleted chat is not written back');
});

test('the reply is kept in the requesting account\'s workspace only', async (t) => {
  const h = harness(t, { workspaces: (n, a, b) => (n === 0 ? a : b) });
  store(h.a, 'chat-679', [USER]);
  store(h.b, 'chat-679', [USER]);
  h.state.turns.push([say('Steam'), DISCONNECT]);
  await h.send({ message: USER.content });
  assert.equal(readStored(h.a, 'chat-679').length, 2, 'written to the account the request began as');
  assert.deepEqual(readStored(h.b, 'chat-679'), [USER], 'another account with the same chat id is untouched');
});

test('an error caused by the disconnect (an aborted round-2 compaction) does not drop the kept reply', async (t) => {
  const context = require('./chat-context.cjs');
  const realMeasure = context.measure;
  let rounds = 0, h = null;
  // Round 2 needs compacting; the client leaves during it and the compaction fails as aborted.
  t.mock.method(context, 'measure', (...args) => { const m = realMeasure(...args); return ++rounds === 2 ? { ...m, used: m.threshold + 1 } : m; });
  t.mock.method(context, 'compactContinuation', async () => { h.state.res.emit('close'); await tick(); throw new Error('This operation was aborted'); });
  h = harness(t);
  store(h.a, 'chat-679', [USER]);
  h.state.turns.push([say('I will read the notes first.'), toolCall('synthetic_read', { name: 'qa-679.md' }, 'call-r')], [say('never requested')]);
  await h.send({ message: USER.content });
  assert.equal(rounds, 2, 'the second round started');
  assert.equal(h.state.requests.length, 1, 'no second model request after the disconnect');
  const history = readStored(h.a, 'chat-679');
  assert.equal(history.length, 2, 'the reply is kept, not dropped as failed: ' + JSON.stringify(history));
  assert.equal(history[1].content, 'I will read the notes first.', 'the round-1 text is kept');
  assert.deepEqual(history[1].toolCalls.map((c) => [c.name, c.status, c.result]), [['synthetic_read', 'done', 'Zahl: 1']]);
  assert.equal(history[1].paused, undefined);
});

test('the record follows the stream the way the client does', () => {
  const r = createTurnRecord();
  r.observe({ type: 'meta', route: 'smart', routingDecision: { role: 'smart' } });
  r.observe({ type: 'delta', text: 'I will check first.' });
  r.observe({ type: 'preamble', text: 'I will check first.' });
  r.observe({ type: 'tool', index: 0, name: 'synthetic_read', args: '{}' });
  r.observe({ type: 'tool_result', index: 0, name: 'synthetic_read', text: 'x'.repeat(5000) });
  r.observe({ type: 'tool_pending', index: 1, id: 'ap-1', name: 'synthetic_append', args: '{"a":1}', target: TARGET });
  const e = r.assistantEntry();
  assert.equal(e.content, 'I will check first.', 'cut off before an answer: the narration before the tools is kept as its text');
  assert.equal(e.model, 'Assistant · Auto (smart)');
  const bare = createTurnRecord();
  bare.observe({ type: 'tool_pending', index: 0, id: 'ap-2', name: 'synthetic_append', args: '{}' });
  assert.equal(bare.assistantEntry().model, 'Stopped', 'no text at all and nothing saved: the Stopped placeholder');
  assert.equal(e.toolCalls[0].result.length, 4000, 'results are clipped as the chip clips them');
  assert.deepEqual({ status: e.toolCalls[1].status, target: e.toolCalls[1].target, approvalId: e.toolCalls[1].approvalId }, { status: 'stopped', target: TARGET, approvalId: undefined });

  const failed = createTurnRecord();
  failed.observe({ type: 'tool', index: 0, name: 'w', args: '{}' });
  failed.observe({ type: 'tool_result', index: 0, name: 'w', text: 'ok', applied: true });
  failed.observe({ type: 'delta', text: 'partial' });
  failed.observe({ type: 'error', text: 'boom' });
  assert.deepEqual(failed.assistantEntry(), { role: 'assistant', content: '', toolCalls: [{ name: 'w', args: '{}', result: 'ok', status: 'done', applied: true }], paused: { reason: 'stopped', applied: 1 } },
    'a failed reply is kept only as the record of the change it saved');
  const failedNothing = createTurnRecord();
  failedNothing.observe({ type: 'error', text: 'boom' });
  assert.equal(failedNothing.assistantEntry(), null);

  const declined = createTurnRecord();
  declined.observe({ type: 'paused', reason: 'declined', applied: 0, declined: ['synthetic_append', 'bad name"'] });
  assert.deepEqual(declined.assistantEntry().paused, { reason: 'declined', applied: 0, declined: ['synthetic_append'] });
  assert.equal(saveInterruptedTurn({ fs, workspace: null, chatId: 'x', message: 'm', entry: {} }), 'no-chat');
});
