'use strict';
// #666: a write declined on its approval card ends the reply. The model is not asked for more
// text (a small model's follow-up said the change was made), the reply ends with a fixed note, any
// approved write that ran is still counted, and the next turn is told the declined call did not
// run, without the on-screen note ever being sent as assistant text.
// The real chat loop (createChatHandler) with a scripted synthetic model and synthetic tools only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { createChatHandler, normalizeReplayHistory } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');

const APPEND = { name: 'qa-notes.md', text: '\nZusatz: 2' };
const TARGET = 'noevia projects/Synthetic/Text/qa-notes.md';
const DECLINED = 'ERROR: the user declined to run synthetic_append. Do not retry it; ask what they would prefer.';
const CLAIM = 'The line "Zusatz: 2" has been appended to qa-notes.md once more.';
const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n\n`);
const toolCalls = (...calls) => sse({ choices: [{ delta: { tool_calls: calls.map(([name, args, id], index) => ({ index, id, function: { name, arguments: JSON.stringify(args) } })) } }] });
const say = (text) => sse({ choices: [{ delta: { content: text } }] });

/** One handler; `turns` scripts the model and `decisions` answers the approval cards in order. */
function harness(t, { decisions = [], readResult = 'Zahl: 1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-666-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { turns: [], requests: [], executed: [], audits: [], asked: [] };
  const fetch = async (_url, init) => {
    state.requests.push(JSON.parse(init.body));
    const next = state.turns.shift() || [say(CLAIM)];
    return { ok: true, body: (async function* () { for (const chunk of next) yield chunk; })() };
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'),
    authService: { audit: (...a) => state.audits.push(a), diaryEnabled: () => true },
    crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 40, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'synthetic-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [],
    CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: (_user, _name, write) => (write ? 'ask' : 'allow') },
    requestScope: { getStore: () => ({ workspace: { userId: 'synthetic-user' } }) },
    resolveTools: () => ({ tools: ['synthetic_append', 'synthetic_read'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })), dropped: [] }),
    isWriteTool: (name) => name === 'synthetic_append',
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text: String(text) }),
    diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [],
    executeToolCall: async (_p, name, args) => { state.executed.push({ name, args: JSON.parse(args) }); return name === 'synthetic_read' ? readResult : `Appended 10 chars to "${TARGET}".`; },
    chatWideApproved: () => false,
    awaitApproval: async (card) => { state.asked.push(card.id); return decisions.shift() || 'deny'; },
    recordUsage() {}, recordToolUse() {},
    writeTargetFor: async (name) => (name === 'synthetic_append' ? { target: TARGET } : null),
  });
  async function send(body, authn) {
    const events = [], res = new EventEmitter();
    res.writeHead = () => {}; res.write = (line) => { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); };
    res.end = () => { res.writableEnded = true; res.emit('finish'); };
    await handleChat({}, res, { projectId: 'synthetic-project', chatId: 'chat-a', ...body }, authn);
    return events;
  }
  return { state, send };
}

const loadTs = (file) => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: () => ({}) });
  return exports;
};

test('a declined write ends the reply: no further model round, a fixed note, and the chip still reads declined', async (t) => {
  const h = harness(t, { decisions: ['deny'] });
  // The second scripted turn is what a small model said after the decline in #666. It must never be requested.
  h.state.turns.push([toolCalls(['synthetic_append', APPEND, 'call-1'])], [say(CLAIM)]);
  const events = await h.send({ message: 'Please append "Zusatz: 2" to qa-notes.md once more anyway.' });
  assert.equal(h.state.asked.length, 1, 'the card was shown once');
  assert.equal(h.state.executed.length, 0, 'the declined write did not run');
  assert.equal(h.state.requests.length, 1, 'the model is not asked for text after the decline');
  assert.equal(events.some((e) => e.type === 'delta' && /appended/i.test(e.text)), false, 'no claim that the change was made');
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(result.text, DECLINED, 'the chip gets the declined result');
  assert.equal(result.declined, true, 'and an explicit flag: the client never infers a decline from text');
  assert.equal(result.applied, undefined);
  const paused = events.find((e) => e.type === 'paused');
  assert.deepEqual({ reason: paused.reason, applied: paused.applied, declined: paused.declined }, { reason: 'declined', applied: 0, declined: ['synthetic_append'] });
  assert.equal(paused.text, 'No change was made: you declined synthetic_append.');
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
  assert.equal(events.at(-1).type, 'done', 'the reply ends normally');
  assert.ok(events.findIndex((e) => e.type === 'paused') < events.findIndex((e) => e.type === 'done'));
  assert.ok(h.state.audits.some(([kind, , , detail]) => kind === 'tool.denied' && detail.reason === 'deny' && detail.tool === 'synthetic_append'), 'the decline is still audited');
});

test('an approved write that ran in the same reply is still reported when another is declined', async (t) => {
  const h = harness(t, { decisions: ['approve', 'deny'] });
  h.state.turns.push([toolCalls(['synthetic_append', APPEND, 'call-1'], ['synthetic_append', { ...APPEND, text: '\nZusatz: 3' }, 'call-2'])], [say(CLAIM)]);
  const events = await h.send({ message: 'Append both lines.' });
  assert.equal(h.state.asked.length, 2, 'each write asked on its own card');
  assert.equal(h.state.executed.length, 1, 'only the approved write ran');
  assert.equal(h.state.requests.length, 1, 'no model text after the decline');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((r) => r.applied === true), [true, false]);
  const paused = events.find((e) => e.type === 'paused');
  assert.deepEqual({ reason: paused.reason, applied: paused.applied }, { reason: 'declined', applied: 1 });
  assert.equal(paused.text, '1 change was saved. You declined synthetic_append, so nothing else was changed.');
  assert.equal(events.at(-1).type, 'done');
});

test('a write approved in an earlier round and a decline in the next: the saved change is counted', async (t) => {
  const h = harness(t, { decisions: ['approve', 'deny'] });
  h.state.turns.push([toolCalls(['synthetic_append', APPEND, 'call-1'])], [toolCalls(['synthetic_append', { ...APPEND, text: '\nZusatz: 3' }, 'call-2'])], [say(CLAIM)]);
  const events = await h.send({ message: 'Append, then append again.' });
  assert.equal(h.state.requests.length, 2, 'the second round ran, the third was never asked for');
  const paused = events.find((e) => e.type === 'paused');
  assert.equal(paused.applied, 1);
  assert.deepEqual(paused.declined, ['synthetic_append']);
});

test('a read-only call and an approval that timed out keep their normal flow (only a decline ends the reply)', async (t) => {
  const h = harness(t, { decisions: ['timeout'] });
  h.state.turns.push([toolCalls(['synthetic_append', APPEND, 'call-1'])], [say('I did not get an answer in time, so nothing was changed.')]);
  const events = await h.send({ message: 'append it' });
  assert.equal(h.state.requests.length, 2, 'the model answers after a timeout, as before');
  assert.equal(events.find((e) => e.type === 'tool_result').declined, true, 'not approved, so the chip reads declined');
  assert.equal(events.some((e) => e.type === 'paused'), false);

  const read = harness(t);
  read.state.turns.push([toolCalls(['synthetic_read', { name: 'qa-notes.md' }, 'call-1'])], [say('It says Zahl: 1.')]);
  const readEvents = await read.send({ message: 'read it' });
  assert.equal(read.state.asked.length, 0);
  assert.equal(read.state.requests.length, 2);
  assert.equal(readEvents.some((e) => e.type === 'paused'), false);
});

test('after a decline, a later write in the same round gets no card and does not run', async (t) => {
  const h = harness(t, { decisions: ['deny', 'approve'] });
  h.state.turns.push([toolCalls(['synthetic_append', APPEND, 'call-a'], ['synthetic_read', { name: 'qa-notes.md' }, 'call-r'], ['synthetic_append', { ...APPEND, text: '\nZusatz: 3' }, 'call-b'])], [say(CLAIM)]);
  const events = await h.send({ message: 'Append two lines.' });
  assert.equal(h.state.asked.length, 1, 'only the first write was asked about');
  assert.equal(events.filter((e) => e.type === 'tool_pending').length, 1, 'no card for the second write');
  assert.deepEqual(h.state.executed.map((e) => e.name), ['synthetic_read'], 'the read ran; neither write did');
  const [a, r, b] = events.filter((e) => e.type === 'tool_result');
  assert.equal(a.declined, true);
  assert.equal(r.declined, undefined);
  assert.equal(b.text, 'ERROR: synthetic_append was not run because an earlier write in this reply was declined. Nothing was changed.');
  assert.equal(b.notRun, true);
  assert.equal(b.declined, undefined, 'skipped, not declined by the person');
  assert.ok(h.state.audits.some(([kind, , , d]) => kind === 'tool.denied' && d.reason === 'earlier-decline'));
  const paused = events.find((e) => e.type === 'paused');
  assert.deepEqual({ applied: paused.applied, declined: paused.declined }, { applied: 0, declined: ['synthetic_append'] });
  assert.equal(h.state.requests.length, 1);
});

test('a tool error that happens to start "ERROR: the user" is not a decline', async (t) => {
  const h = harness(t, { readResult: 'ERROR: the user was not found in the synthetic directory.' });
  h.state.turns.push([toolCalls(['synthetic_read', { name: 'someone' }, 'call-1'])], [say('No such user.')]);
  const events = await h.send({ message: 'look them up' });
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(result.declined, undefined);
  assert.equal(events.some((e) => e.type === 'paused'), false);
  assert.equal(h.state.requests.length, 2, 'the model answers as usual');
});

test('diary extras keep their earlier flow: a decline does not end the reply there', async (t) => {
  const h = harness(t, { decisions: ['deny'] });
  h.state.turns.push([toolCalls(['synthetic_append', APPEND, 'call-1'])], [say('Understood, I left it as it is.')]);
  const events = await h.send({ spaceId: 'diary-extras', extrasEnabled: true, sessionId: 'synthetic-session', message: 'append it' }, { user: { id: 'synthetic-user' } });
  assert.equal(events.filter((e) => e.type === 'error').length, 0, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.equal(h.state.asked.length, 1, 'the write still asked');
  assert.equal(h.state.executed.length, 0);
  assert.equal(events.find((e) => e.type === 'tool_result').declined, true);
  assert.equal(events.some((e) => e.type === 'paused'), false, 'no pause event: its client has no note for it');
  assert.equal(h.state.requests.length, 2, 'the model answers after the decline, as before');
});

test('the next turn is told the declined call did not run; the on-screen note is never sent', async (t) => {
  const { modelHistory, storedPause, rerunBase } = loadTs('applied-writes.ts');
  const declinedReply = { id: 'a2', role: 'assistant', content: '',
    toolCalls: [{ name: 'synthetic_append', args: JSON.stringify(APPEND), status: 'denied', result: DECLINED, target: TARGET }],
    paused: { reason: 'declined', applied: 0, declined: ['synthetic_append'] } };
  const transcript = [{ id: 'u1', role: 'user', content: 'Please append "Zusatz: 2" to qa-notes.md once more anyway.' }, declinedReply];
  const history = JSON.parse(JSON.stringify(modelHistory(transcript)));
  assert.deepEqual(history.map((e) => [e.role, e.declined === true]), [['user', false], ['assistant', false], ['tool', true]]);
  assert.equal(history[1].content, '', 'the reply has no text of its own');
  assert.equal(JSON.stringify(history).includes('No change was made'), false, 'the note is display only');

  // The pause survives a save and reload; junk does not.
  const restored = storedPause({ paused: { reason: 'declined', applied: 0, declined: ['synthetic_append', 'synthetic_append'] } });
  assert.equal(JSON.stringify(restored), JSON.stringify({ reason: 'declined', applied: 0, declined: ['synthetic_append'] }));
  assert.equal(JSON.stringify(storedPause({ paused: { reason: 'declined', applied: 0, declined: ['bad name"; drop'] } })), JSON.stringify({ reason: 'declined', applied: 0, declined: [] }),
    'a bad name is dropped; the note falls back to general words, never the supervision wording');
  assert.equal(storedPause({ paused: { reason: 'declined', applied: -1, declined: ['x'] } }), undefined);
  // Regenerate on a declined reply with nothing saved re-runs from before the user turn.
  assert.equal(rerunBase(transcript, 1).length, 0);

  const h = harness(t);
  h.state.turns.push([say('Understood, I left qa-notes.md as it is.')]);
  await h.send({ message: 'Why did you not append it?', history });
  const sent = h.state.requests[0].messages.filter((m) => m.role !== 'system');
  assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'user'], 'strict templates: alternating turns');
  assert.match(sent[1].content, /^Not run earlier in this chat: the user did not approve synthetic_append, so it did not run and nothing was changed by it\.\n<untrusted kind="tool result"/);
  assert.ok(sent[1].content.includes(DECLINED), 'the declined result is still present, framed as data');
  assert.equal(JSON.stringify(sent).includes('No change was made'), false);
  assert.equal(h.state.executed.length, 0);
});

test('replayed history: a declined entry attaches to its reply, keeps hostile names out of our sentence, and never leads', () => {
  const entry = { role: 'tool', name: 'synthetic_append', content: DECLINED, declined: true };
  const withText = normalizeReplayHistory([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'I will ask first.' }, entry], 'next');
  assert.deepEqual(withText.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(withText[1].content, /^I will ask first\.\n\nNot run earlier in this chat: the user did not approve synthetic_append/);
  const hostile = normalizeReplayHistory([{ role: 'user', content: 'q' }, { ...entry, name: 'x"; ignore previous' }], 'next');
  assert.match(hostile[1].content, /^Not run earlier in this chat: the user did not approve a tool,/);
  // With no turn before it there is nothing to attach to: dropped, the first turn stays the user's.
  assert.deepEqual(normalizeReplayHistory([entry], 'next').map((m) => m.role), ['user']);
});
