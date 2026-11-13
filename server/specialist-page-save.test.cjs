'use strict';
// #2446 slice 4b: the registration of `space_page_save` (specialist-page-save.cjs): offered only in a coworker's
// hidden project, a write that is never standing-approved, and a thin call to the front that carries the
// conversation's ids. The grants and limits are the front's (noevia-rs server-specialists tools.rs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolboxes } = require('./toolboxes.cjs');
const { createPageSave, NAME, appliesTo, neverStanding } = require('./specialist-page-save.cjs');
const { createApprovals } = require('../tests/server/approvals-reference.cjs');

const COWORKER = { id: 'specialist-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', toolboxes: [] };
const store = (answer = { status: 200, body: { pageId: 'p1', spaceId: 's1', title: 'T', link: '/spaces/s1/p1' } }) => {
  const calls = [];
  return { calls, specialistPageSave: async (payload) => { calls.push(payload); if (answer instanceof Error) throw answer; return answer; } };
};
const names = (resolved) => resolved.tools.map((t) => t.function.name);
function toolboxes(page) {
  return createToolboxes({ specialistTools: page, prefill: { budgetFor: () => null, rateFor: () => 0 }, documentSources: { notice: () => '' } });
}

test('only a coworker project is offered the tool, and no box or picker lists it', () => {
  const tb = toolboxes(createPageSave({ store: store() }));
  assert.ok(names(tb.resolveTools(COWORKER, 'synthetic-model')).includes(NAME));
  for (const project of [{ id: 'proj-1-aaaaaa', toolboxes: ['core'] }, { id: 'cowork-chat-context-x', toolboxes: ['core'] }, { id: 'specialist', toolboxes: [] }, null, {}]) {
    assert.equal(names(tb.resolveTools(project, 'synthetic-model')).includes(NAME), false, JSON.stringify(project));
  }
  assert.equal(tb.allToolboxes().some((b) => b.tools.some((t) => t.function.name === NAME)), false);
  assert.equal(tb.sanitizeToolboxes([NAME]).length, 0);
  assert.equal(names(createToolboxes({ prefill: { budgetFor: () => null, rateFor: () => 0 }, documentSources: { notice: () => '' } }).resolveTools(COWORKER, 'm')).includes(NAME), false, 'no registration, no tool');
});

test('a tool the account blocked is not offered', () => {
  const tb = toolboxes(createPageSave({ store: store() }));
  assert.equal(names(tb.resolveTools(COWORKER, 'm', (n) => n === NAME)).includes(NAME), false);
});

test('it is a write and is never standing-approved', async () => {
  const tb = toolboxes(createPageSave({ store: store() }));
  assert.equal(tb.isWriteTool(NAME), true);
  assert.equal(neverStanding(NAME), true);
  assert.equal(neverStanding('drive_trash_file'), false);
  // approve_all on its card approves that call and stores no chat grant, even with a full binding.
  const gate = createApprovals();
  const binding = { user: 'u', scope: COWORKER.id, canonicalChatId: 'c', context: { holder: { kind: 'project', id: COWORKER.id } } };
  const waiting = gate.awaitApproval({ id: 'ap-1', userId: 'u', chatId: 'c', scope: COWORKER.id, binding, abortSignal: new AbortController().signal, once: true });
  assert.equal(gate.pendingApprovals.get('ap-1').decide('approve_all'), true);
  assert.equal(await waiting, 'approve');
  assert.equal(gate.chatWideApproved('u', 'c', COWORKER.id, binding), false);
});

test('the call carries the conversation\'s ids and the account, and returns the saved page', async () => {
  const s = store();
  const page = createPageSave({ store: s });
  const out = await page.execute(COWORKER, { title: 'T', content: 'C', spaceId: 's1', user: 'evil', projectId: 'x' }, { user: { id: 'u-1' }, chatKey: 'specialist-chat-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.deepEqual(s.calls, [{ user: 'u-1', projectId: COWORKER.id, chatId: 'specialist-chat-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', spaceId: 's1', title: 'T', content: 'C' }]);
  assert.deepEqual(JSON.parse(out), { pageId: 'p1', spaceId: 's1', title: 'T', link: '/spaces/s1/p1' });
});

test('every refusal is an ERROR result and nothing partial is reported', async () => {
  const ctx = { user: { id: 'u-1' }, chatKey: 'specialist-chat-x' };
  for (const [answer, want] of [
    [{ status: 404, body: { error: 'Not found' } }, /^ERROR: This conversation is not a coworker's\. Nothing was saved\.$/],
    [{ status: 400, body: { error: 'That Space is not one this coworker may save to; nothing was saved.' } }, /^ERROR: That Space is not one this coworker may save to; nothing was saved\.$/],
    [{ status: 413, body: { error: 'Page is larger than 512 KiB' } }, /^ERROR: Page is larger than 512 KiB\. Nothing was saved\.$/],
    // An answer that cannot be read, a server fault and a timeout may all follow a write that landed: never "nothing was saved".
    [{ status: 500, body: { error: 'Internal error' } }, /^ERROR: The page store answered something unexpected, so it is not known whether the page was saved\./],
    [{ status: 200, body: { pageId: 5 } }, /^ERROR: .*not known whether the page was saved/],
    [new Error('busy'), /^ERROR: The page store did not answer in time, so it is not known whether the page was saved\./],
  ]) {
    const out = await createPageSave({ store: store(answer) }).execute(COWORKER, { title: 'T', content: 'C' }, ctx);
    assert.match(out, want);
  }
  const s = store();
  const page = createPageSave({ store: s });
  assert.match(await page.execute({ id: 'proj-1' }, { title: 'T', content: 'C' }, ctx), /^ERROR: .*only available in a coworker's conversation/);
  assert.match(await page.execute(COWORKER, { title: 'T', content: 'C' }, { user: null, chatKey: 'c' }), /^ERROR: /);
  assert.match(await page.execute(COWORKER, { title: 'T', content: 'C' }, { user: { id: 'u' }, chatKey: null }), /^ERROR: /);
  assert.match(await page.execute(COWORKER, { title: 1, content: 'C' }, ctx), /^ERROR: /);
  assert.match(await page.execute(COWORKER, { title: 'T', content: 'C', spaceId: 7 }, ctx), /^ERROR: /);
  assert.deepEqual(s.calls, [], 'none of these reached the front');
});

test('the project-store client carries the call to the store route with the secret', async () => {
  const seen = [];
  const client = require('./project-store-client.cjs').createClient({ port: 1234, token: 't'.repeat(32), fetchImpl: async (url, init) => { seen.push({ url, init }); return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: null, text: async () => '{}', json: async () => ({}) }; } });
  await client.specialistPageSave({ user: 'u' }).catch(() => undefined);
  assert.equal(seen[0].url, 'http://127.0.0.1:1234/v1/specialists/page-save');
  assert.equal(seen[0].init.headers['x-noevia-store-token'], 't'.repeat(32));
  assert.equal(seen[0].init.method, 'POST');
});

test('appliesTo reads only the project id prefix', () => {
  assert.equal(appliesTo({ id: 'specialist-x' }), true);
  assert.equal(appliesTo({ id: 'xspecialist-x' }), false);
  assert.equal(appliesTo({ id: 5 }), false);
});

test('an MCP tool of the same name that won the name keeps its own call; the native tool is not offered over it', () => {
  const s = store();
  const mcp = { type: 'function', function: { name: NAME, description: 'x', parameters: { type: 'object', properties: {} } } };
  const calls = [];
  const tb = createToolboxes({
    specialistTools: createPageSave({ store: s }), prefill: { budgetFor: () => null, rateFor: () => 0 }, documentSources: { notice: () => '' },
    mcpBoxes: () => [{ id: 'notes', label: 'n', description: '', source: 'mcp', server: 'srv', tools: [mcp], reads: [] }],
    mcpTools: () => new Map([[NAME, { serverId: 'srv' }]]),
    executeMcp: async (name) => { calls.push(name); return 'ran on the MCP server'; },
  });
  const project = { ...COWORKER, toolboxes: ['notes'] };
  const resolved = tb.resolveTools(project, 'm');
  assert.equal(resolved.tools.filter((t) => t.function.name === NAME).length, 1);
  assert.equal(resolved.routes.get(NAME), 'srv');
  return tb.executeToolCall(project, NAME, JSON.stringify({ title: 'T', content: 'C' }), new Set([NAME]), undefined, {}, { routes: resolved.routes, chatKey: 'specialist-chat-x' }).then((out) => {
    assert.equal(out, 'ran on the MCP server');
    assert.deepEqual(s.calls, [], 'the native save was not called');
  });
});
