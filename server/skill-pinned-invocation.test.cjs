'use strict';
// Version-pinned Skill invocation (#272). Synthetic projects and a fake provider only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const skills = require('./instruction-skills.cjs');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { requestShapeError } = require('./chat-mode.cjs');

const FILE = 'synthetic-helper/SKILL.md';
const body = (v = '1.0.0', text = 'Answer in synthetic haiku.') => `---\nname: synthetic-helper\ndescription: A synthetic fixture skill\nversion: ${v}\n---\n${text}\n`;
function project({ id = 'fixture-project', content = body(), reviewed = true, enabled = true, reviewedHash } = {}) {
  const p = { id, name: 'Fixture', model: 'answer-model', assets: [], files: [{ name: FILE, content }, { name: 'notes.txt', content: 'plain source' }] };
  p.instructionSkills = { [FILE]: { enabled, reviewedHash: reviewed ? (reviewedHash || skills.hash(content)) : null } };
  return p;
}
const pinOf = (p) => ({ id: skills.skillId(p, FILE), version: skills.hash(p.files[0].content) });
const code = (fn) => { try { fn(); } catch (e) { return [e.status, e.code]; } return null; };

test('resolver: a reviewed, enabled exact version resolves in both pin forms', () => {
  const p = project(), pin = pinOf(p);
  const a = skills.resolvePinned(p, pin), b = skills.resolvePinned(p, `${pin.id}@${pin.version}`);
  const c = skills.resolvePinned(p, { id: pin.id, version: '1.0.0', contentHash: pin.version });
  for (const r of [a, b, c]) {
    assert.equal(r.content, p.files[0].content);
    assert.deepEqual(r.record, { id: pin.id, file: FILE, name: 'synthetic-helper', versionLabel: '1.0.0', version: pin.version, contentHash: pin.version, origin: 'project-file' });
  }
});

test('resolver: hash mismatch, unknown, changed, unreviewed, disabled and malformed pins are explicit errors', () => {
  const p = project(), pin = pinOf(p), other = 'a'.repeat(64);
  assert.deepEqual(code(() => skills.resolvePinned(p, { ...pin, contentHash: other })), [409, 'skill_hash_mismatch']);
  assert.deepEqual(code(() => skills.resolvePinned(p, { id: pin.id, version: '9.9.9', contentHash: pin.version })), [409, 'skill_hash_mismatch']);
  assert.deepEqual(code(() => skills.resolvePinned(p, { id: pin.id, version: other })), [404, 'skill_version_unknown']);
  assert.deepEqual(code(() => skills.resolvePinned(p, { id: `skill_${'0'.repeat(32)}`, version: pin.version })), [404, 'skill_not_found']);
  // The reviewed version was replaced on disk: the old pin is refused, and the new bytes await review.
  const edited = project({ content: body('1.1.0', 'Changed text.'), reviewedHash: pin.version });
  assert.deepEqual(code(() => skills.resolvePinned(edited, pin)), [409, 'skill_version_changed']);
  assert.deepEqual(code(() => skills.resolvePinned(edited, pinOf(edited))), [409, 'skill_version_unreviewed']);
  assert.deepEqual(code(() => skills.resolvePinned(project({ reviewed: false, enabled: false }), pin)), [409, 'skill_version_unreviewed']);
  assert.deepEqual(code(() => skills.resolvePinned(project({ enabled: false }), pin)), [409, 'skill_disabled']);
  for (const bad of ['nope', `${pin.id}@1.0.0`, { id: pin.id }, { id: 'x', version: pin.version }, { id: pin.id, contentHash: 'ABC' }, 7, []]) {
    assert.deepEqual(code(() => skills.resolvePinned(p, bad)), [400, 'skill_pin_invalid'], JSON.stringify(bad));
  }
  const needs = project({ content: `---\nname: n\ndescription: d\nrequires: unknown-box\n---\nx` });
  assert.deepEqual(code(() => skills.resolvePinned(needs, pinOf(needs), ['core'])), [422, 'skill_unsupported_requirements']);
});

test('resolver: a skill id from another project or tenant is unknown in this one', () => {
  const mine = project({ id: 'tenant-b-project' }), theirs = project({ id: 'tenant-a-project' });
  // Identical content, so only the project-scoped id differs.
  assert.deepEqual(code(() => skills.resolvePinned(mine, pinOf(theirs))), [404, 'skill_not_found']);
});

test('a Cowork request with a pin is refused rather than silently dropped', () => {
  assert.match(requestShapeError({ mode: 'cowork', skill: 'x@y' }).error, /chat turns only/);
  assert.equal(requestShapeError({ mode: 'cowork', skill: 'x@y' }).code, 'skill_pin_unsupported_mode');
  assert.equal(requestShapeError({ mode: 'chat', skill: 'x@y' }), null);
  assert.equal(requestShapeError({ mode: 'cowork' }), null);
});

// ── Chat loop integration ──
async function run(t, { reqBody = {}, owner = 'user-a', requester = owner, fixture = project(), toolCall = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-pin-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter(), saved = []; let reply = null;
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = []; let approvals = 0, executions = 0, routerCalls = 0;
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const delta = toolCall && requests.length === 1
      ? { tool_calls: [{ index: 0, id: 'call-fixture', function: { name: 'synthetic_write', arguments: '{}' } }] }
      : { content: 'synthetic reply' };
    return { ok: true, body: (async function* () { yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n'); yield Buffer.from('data: [DONE]\n\n'); })() };
  };
  const workspace = { userId: requester, dir, assetDir: () => '/synthetic-only' };
  // The tenant-scoped project store: a project is only visible to its owner.
  const getProject = (id) => (workspace.userId === owner && id === fixture.id ? fixture : null);
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange, currentWorkspace: () => workspace, getProject,
    skillsIndexFor: (p) => skills.enabled(p), getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null, visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => { routerCalls++; return { loaded: [] }; } }, oauthServerIds: () => new Set(), accountReady: () => true,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: (_u, _n, write) => (write ? 'ask' : 'allow') }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [{ type: 'function', function: { name: 'synthetic_write', parameters: { type: 'object' } } }], dropped: [] }), isWriteTool: () => true,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: (_res, status, payload) => { reply = { status, payload }; }, saveChats: (...args) => saved.push(args),
    endpointApproved: () => true, diaryHeaders: () => ({}), lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [],
    modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null, allToolboxes: () => [{ id: 'core' }],
    executeToolCall: async () => { executions++; return 'synthetic result'; }, chatWideApproved: () => false,
    awaitApproval: async () => { approvals++; return 'approve'; }, recordUsage() {}, recordToolUse() {},
  });
  await handleChat({}, res, { projectId: fixture.id, chatId: 'fixture-chat', message: 'synthetic question', ...reqBody }, { user: { id: requester } });
  return { events, requests, reply, approvals, executions, routerCalls, saved };
}
const system = (r) => r.requests[0].messages.find((m) => m.role === 'system')?.content || '';

test('chat: a pinned reviewed version is injected and recorded on meta', async (t) => {
  const fixture = project(), pin = pinOf(fixture);
  const r = await run(t, { fixture, reqBody: { skill: `${pin.id}@${pin.version}` } });
  assert.equal(r.reply, null);
  assert.equal(r.routerCalls, 0, 'an explicit pin replaces automatic selection');
  assert.match(system(r), new RegExp(`invoked skill "synthetic-helper" \\(${FILE}, SHA-256 ${pin.version}\\)`));
  assert.match(system(r), /cannot grant tool permissions/);
  assert.match(system(r), /Answer in synthetic haiku\./);
  const meta = r.events.find((e) => e.type === 'meta');
  assert.deepEqual(meta.skill, { id: pin.id, file: FILE, name: 'synthetic-helper', versionLabel: '1.0.0', version: pin.version, contentHash: pin.version, origin: 'project-file' });
  assert.equal(r.events.find((e) => e.type === 'skills_scope')?.text, 'synthetic-helper');
});

test('chat: a refused pin on a new project chat creates no chat entry; a resolved one still does', async (t) => {
  const fixture = project(), pin = pinOf(fixture);
  for (const skill of [{ ...pin, contentHash: 'b'.repeat(64) }, { id: pin.id, version: 'c'.repeat(64) }, 'garbage']) {
    const r = await run(t, { fixture, reqBody: { chatId: undefined, skill } });
    assert.ok(r.reply?.status >= 400);
    assert.deepEqual(r.saved, [], 'no empty "New task" chat left behind');
  }
  const ok = await run(t, { fixture, reqBody: { chatId: undefined, skill: pin } });
  assert.equal(ok.reply, null);
  assert.equal(ok.saved.length, 1);
  assert.equal(ok.saved[0][0], fixture.id);
  assert.equal(ok.saved[0][1][0].title, 'New task');
  const unpinned = await run(t, { fixture, reqBody: { chatId: undefined } });
  assert.equal(unpinned.saved.length, 1, 'unpinned new chats are created as before');
});

test('chat: an unpinned request behaves as before and records no skill', async (t) => {
  const r = await run(t);
  assert.equal(r.reply, null);
  assert.equal(r.routerCalls, 1, 'automatic selection still runs');
  assert.doesNotMatch(system(r), /invoked skill/);
  assert.equal('skill' in r.events.find((e) => e.type === 'meta'), false, 'absent on the wire');
  assert.equal(r.events.some((e) => e.type === 'skills_scope'), false);
  const nullPin = await run(t, { reqBody: { skill: null } });
  assert.equal(nullPin.reply, null); assert.equal(nullPin.routerCalls, 1);
});

test('chat: refused pins answer with an explicit code before any model request', async (t) => {
  const fixture = project(), pin = pinOf(fixture);
  const cases = [
    [{ ...pin, contentHash: 'b'.repeat(64) }, project(), 409, 'skill_hash_mismatch'],
    [pin, project({ reviewed: false, enabled: false }), 409, 'skill_version_unreviewed'],
    [{ id: pin.id, version: 'c'.repeat(64) }, project(), 404, 'skill_version_unknown'],
    [pin, project({ enabled: false }), 409, 'skill_disabled'],
    ['garbage', project(), 400, 'skill_pin_invalid'],
  ];
  for (const [skill, f, status, errorCode] of cases) {
    const r = await run(t, { fixture: f, reqBody: { skill } });
    assert.equal(r.reply?.status, status, errorCode);
    assert.equal(r.reply.payload.code, errorCode);
    assert.equal(r.requests.length, 0, `${errorCode}: no model request`);
  }
  const free = await run(t, { reqBody: { projectId: undefined, spaceId: 'free', chatId: undefined, skill: pin } });
  assert.equal(free.reply.status, 400); assert.equal(free.reply.payload.code, 'skill_pin_requires_project');
  const compact = await run(t, { reqBody: { skill: pin, compactOnly: true } });
  assert.equal(compact.reply.status, 400); assert.equal(compact.requests.length, 0);
});

test('chat: another tenant cannot pin a skill from a project it cannot see', async (t) => {
  const fixture = project({ id: 'tenant-a-project' }), pin = pinOf(fixture);
  const r = await run(t, { fixture, owner: 'user-a', requester: 'user-b', reqBody: { skill: pin } });
  assert.equal(r.reply.status, 404);
  assert.equal(r.requests.length, 0);
  // Tenant B's own project with the same bytes still does not resolve tenant A's id.
  const own = await run(t, { fixture: project({ id: 'tenant-b-project' }), owner: 'user-b', requester: 'user-b', reqBody: { skill: pin } });
  assert.equal(own.reply.status, 404); assert.equal(own.reply.payload.code, 'skill_not_found'); assert.equal(own.requests.length, 0);
});

test('chat: a pinned skill never bypasses the write approval gate', async (t) => {
  const fixture = project(), pin = pinOf(fixture);
  const r = await run(t, { fixture, reqBody: { skill: pin }, toolCall: true });
  assert.equal(r.approvals, 1, 'the write still asked for approval');
  assert.equal(r.executions, 1);
});
