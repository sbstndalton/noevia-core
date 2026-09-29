'use strict';
// Portable Skills (#272): requirement validation, bundled scripts, origin in the Sources list and
// revocation of a loaded skill during an exchange. Synthetic projects and a fake provider only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const skills = require('./instruction-skills.cjs');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createChatTurns } = require('./chat-turns.cjs');

const FILE = 'synthetic-helper/SKILL.md', OTHER = 'other-helper/SKILL.md';
const body = ({ name = 'synthetic-helper', requires = '', text = 'Answer in synthetic haiku.' } = {}) =>
  `---\nname: ${name}\ndescription: A synthetic fixture skill\nversion: 1.0.0\n${requires ? `requires: ${requires}\n` : ''}---\n${text}\n`;
function project({ id = 'fixture-project', content = body(), toolboxes, extraFiles = [], other = false } = {}) {
  const p = { id, name: 'Fixture', model: 'answer-model', assets: [], files: [{ name: FILE, content }, { name: 'notes.txt', content: 'plain source' }, ...extraFiles] };
  if (toolboxes) p.toolboxes = toolboxes;
  p.instructionSkills = { [FILE]: { enabled: true, reviewedHash: skills.hash(content) } };
  if (other) {
    const c = body({ name: 'other-helper' });
    p.files.push({ name: OTHER, content: c });
    p.instructionSkills[OTHER] = { enabled: true, reviewedHash: skills.hash(c) };
  }
  return p;
}
const pinOf = (p) => `${skills.skillId(p, FILE)}@${skills.hash(p.files[0].content)}`;
const disable = (p, file = FILE) => { p.instructionSkills[file] = { ...p.instructionSkills[file], enabled: false }; };
const code = (fn) => { try { fn(); } catch (e) { return [e.status, e.code]; } return null; };

// ── Manifest and resolver ──

test('bundled executable assets are listed and refuse pinned, content and automatic use', () => {
  const p = project({ extraFiles: [
    { name: 'synthetic-helper/scripts/fill.txt', content: 'under scripts/, so executable whatever the extension' },
    { name: 'synthetic-helper/tool.py', content: 'print(1)' },
    { name: 'synthetic-helper/run', content: '#!/bin/sh\necho synthetic' },
    { name: 'synthetic-helper/reference.md', content: 'plain reference text' },
    { name: 'synthetic-helper-lookalike/x.py', content: 'another directory' },
  ] });
  const [m] = skills.manifests(p, ['core']);
  assert.deepEqual(m.requirements.scripts, ['synthetic-helper/scripts/fill.txt', 'synthetic-helper/tool.py', 'synthetic-helper/run']);
  assert.deepEqual(m.assets.map((a) => [a.file, a.executable]), [
    ['synthetic-helper/scripts/fill.txt', true], ['synthetic-helper/tool.py', true], ['synthetic-helper/run', true], ['synthetic-helper/reference.md', false]]);
  assert.equal(m.assets[3].version, skills.hash('plain reference text'));
  assert.equal(m.status, 'enabled', 'enabling is still the owner\'s review; only use is refused');
  assert.equal(m.resolvable, false);
  assert.deepEqual(code(() => skills.resolvePinned(p, pinOf(p), ['core'])), [422, 'skill_scripts_unsupported']);
  assert.equal(code(() => skills.resolve(p, m.id, m.version, ['core']))[0], 422);
  const read = skills.read(p, p.files[0], p);
  assert.match(read, /Bundled scripts are never run from chat: synthetic-helper\/scripts\/fill\.txt/);
  // Only non-executable references: still usable.
  const plain = project({ extraFiles: [{ name: 'synthetic-helper/reference.md', content: 'text' }] });
  assert.equal(skills.manifests(plain, ['core'])[0].resolvable, true);
  assert.equal(skills.resolvePinned(plain, pinOf(plain), ['core']).record.file, FILE);
});

test('#567: a skill with bundled scripts cannot be enabled, and can still be disabled', () => {
  const p = project({ extraFiles: [{ name: 'synthetic-helper/scripts/run.sh', content: 'echo synthetic' }] });
  p.instructionSkills = {};
  const hash = skills.hash(p.files[0].content);
  const err = (() => { try { skills.setSelection(p, { file: FILE, enabled: true, hash }); } catch (e) { return e; } return null; })();
  assert.equal(err?.status, 422);
  assert.equal(err.code, 'skill_scripts_unsupported');
  assert.match(err.message, /chat never runs Skill scripts/i);
  assert.match(err.message, /synthetic-helper\/scripts\/run\.sh/);
  assert.notEqual(skills.list(p)[0].status, 'enabled', 'the refused enable changed nothing');
  // A skill that was enabled before scripts appeared can still be turned off.
  p.instructionSkills = { [FILE]: { enabled: true, reviewedHash: hash } };
  skills.setSelection(p, { file: FILE, enabled: false });
  assert.equal(skills.list(p)[0].status, 'disabled');
  // Without scripts the same call enables normally.
  const plain = project({ extraFiles: [{ name: 'synthetic-helper/reference.md', content: 'text' }] });
  plain.instructionSkills = {};
  skills.setSelection(plain, { file: FILE, enabled: true, hash });
  assert.equal(skills.list(plain)[0].status, 'enabled');
});

test('a root SKILL.md or single-file skill owns no directory and so no assets', () => {
  const p = { id: 'p', files: [{ name: 'SKILL.md', content: body() }, { name: 'tool.py', content: 'print(1)' }, { name: 'weekly.md', content: body({ name: 'weekly' }) }] };
  assert.deepEqual(skills.assets(p, 'SKILL.md'), []);
  assert.deepEqual(skills.assets(p, 'weekly.md'), []);
});

test('allowed-tools and compatibility are bounded; neither grants anything', () => {
  const many = Array.from({ length: 33 }, (_, i) => `tool${i}`).join(' ');
  const tooMany = skills.inspect({ name: 'a/SKILL.md', content: `---\nname: a\ndescription: d\nallowed-tools: ${many}\n---\nx` }, {});
  assert.equal(tooMany.valid, false); assert.match(tooMany.error, /32 entries/);
  const long = skills.inspect({ name: 'a/SKILL.md', content: `---\nname: a\ndescription: d\ncompatibility: ${'c'.repeat(501)}\n---\nx` }, {});
  assert.equal(long.valid, false);
  const ok = skills.inspect({ name: 'a/SKILL.md', content: `---\nname: a\ndescription: d\nallowed-tools: nc_files_delete Bash(rm:*)\n---\nx` }, {});
  assert.deepEqual(ok.allowedTools, ['nc_files_delete', 'Bash(rm:*)']);
});

test('unmetRequirements and revoked', () => {
  assert.deepEqual(skills.unmetRequirements(['core', 'web-search'], ['core']), ['web-search']);
  assert.deepEqual(skills.unmetRequirements([], []), []);
  assert.deepEqual(skills.unmetRequirements(['core'], null), ['core']);
  const p = project({ other: true });
  const loaded = new Map([[FILE, { hash: skills.hash(p.files[0].content), name: 'synthetic-helper' }]]);
  assert.deepEqual(skills.revoked(p, loaded), []);
  const otherOff = structuredClone(p); disable(otherOff, OTHER);
  assert.deepEqual(skills.revoked(otherOff, loaded), [], 'disabling another skill does not touch this one');
  const off = structuredClone(p); disable(off);
  assert.deepEqual(skills.revoked(off, loaded), [{ file: FILE, name: 'synthetic-helper' }]);
  const changed = structuredClone(p); changed.files[0].content = body({ text: 'Changed.' });
  assert.equal(skills.revoked(changed, loaded).length, 1, 'changed content awaits review, so it is revoked');
  const removed = structuredClone(p); removed.files.shift();
  assert.equal(skills.revoked(removed, loaded).length, 1);
  assert.equal(skills.revoked(null, loaded).length, 1, 'a project that is gone revokes everything');
  const record = { file: FILE, name: 'synthetic-helper', contentHash: skills.hash(p.files[0].content) };
  assert.equal(skills.pinActive(p, record), true);
  assert.equal(skills.pinActive(off, record), false);
  assert.equal(skills.pinActive(p, { ...record, contentHash: 'nope' }), false);
});

test('the Sources list carries the portable id, origin and bundled scripts', () => {
  const content = body();
  const p = project({ content, extraFiles: [{ name: 'synthetic-helper/scripts/a.sh', content: 'echo' }] });
  p.files[0].skillOrigin = { kind: 'published', publisher: 'Synthetic', repository: 'https://example.invalid/skills', sourceRef: 'main', sourcePath: 'skills/synthetic-helper/SKILL.md', digest: skills.hash(content), retrievedAt: '2026-09-01T00:00:00.000Z' };
  const [row] = skills.listForClient(p, ['core']);
  assert.equal(row.id, skills.skillId(p, FILE));
  assert.equal(row.origin.kind, 'published'); assert.equal(row.origin.publisher, 'Synthetic');
  assert.deepEqual(row.scripts, ['synthetic-helper/scripts/a.sh']);
  assert.equal(row.content, content, 'the review body is still there for Sources');
  // Edited bytes lose the published origin.
  p.files[0].content = body({ text: 'edited' });
  assert.equal(skills.listForClient(p, ['core'])[0].origin.kind, 'project-file');
});

// ── Chat loop ──

async function run(t, { reqBody = {}, fixture = project(), rounds = [], onExecute, onApproval, streamDelayMs = 0, provider, known = ['core', 'web-search'], user, stepSupervision = null, dir: sharedDir = null, userId = 'user-a', router = null } = {}) {
  // `dir` is the account's workspace, shared across runs to model several turns of one account.
  const dir = sharedDir || fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-port-')); if (!sharedDir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter(), saved = [], audits = []; let reply = null;
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [], executed = []; let approvals = 0, routerInput = null;
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const step = rounds[requests.length - 1] || { content: 'synthetic reply' };
    const delta = step.tool ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] } : { content: step.content };
    return { ok: true, body: (async function* () {
      yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
      if (streamDelayMs) {
        step.afterFirstChunk?.();
        await new Promise((r) => setTimeout(r, streamDelayMs));
        yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: ' more text after the skill was disabled' } }] }) + '\n\n');
      }
      yield Buffer.from('data: [DONE]\n\n');
    })() };
  };
  const durableChat = createChatTurns({ enabled: true });
  const workspace = { userId, dir, assetDir: () => '/synthetic-only' };
  const getProject = (id) => (id === fixture.id ? fixture : null); // the live store: edits show at once
  const writes = new Set(['synthetic_write']);
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit: (...a) => audits.push(a), diaryEnabled: () => true }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange, currentWorkspace: () => workspace, getProject,
    skillsIndexFor: (p) => skills.enabled(p), getProvider: (id) => (provider && id === provider.id ? provider : { id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null, visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async (rows) => { routerInput = rows.map((s) => s.file); if (router) return router(rows); const hit = rows.find((s) => s.file === FILE); return { loaded: hit ? [hit] : [] }; } },
    oauthServerIds: () => new Set(), accountReady: () => true,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: (_u, _n, write) => (write ? 'ask' : 'allow') }, requestScope: { getStore: () => (user ? { authn: { user } } : {}) },
    resolveTools: () => ({ tools: ['synthetic_write', 'read_project_file', 'project_read_file', 'synthetic_read'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })), dropped: [] }),
    isWriteTool: (name) => writes.has(name),
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: (_res, status, payload) => { reply = { status, payload }; }, saveChats: (...args) => saved.push(args),
    endpointApproved: () => true, diaryHeaders: () => ({}), lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [],
    modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null, allToolboxes: () => known.map((id) => ({ id })), stepSupervision,
    executeToolCall: async (_p, name, args) => { executed.push(name); return (await onExecute?.(name, args)) ?? 'synthetic result'; },
    chatWideApproved: () => false,
    awaitApproval: async () => { approvals++; await onApproval?.(); return 'approve'; }, recordUsage() {}, recordToolUse() {}, durableChat,
  });
  await handleChat({}, res, { projectId: fixture.id, chatId: 'fixture-chat', message: 'synthetic question', ...reqBody }, { user: { id: 'user-a' } });
  const job = require('./jobs.cjs').createJobs({ dir }).list({ kind: 'chat' })[0];
  const turn = job ? durableChat.restore(workspace, job.id).state : null;
  return { events, requests, reply, turn, approvals, executed, saved, audits, routerInput };
}
const errorOf = (r) => r.events.find((e) => e.type === 'error');

test('chat: a pin whose required toolbox this request does not carry is refused before anything starts', async (t) => {
  const fixture = project({ content: body({ requires: 'web-search' }), toolboxes: ['core'] });
  const r = await run(t, { fixture, reqBody: { chatId: undefined, skill: pinOf(fixture) } });
  assert.equal(r.reply.status, 422);
  assert.equal(r.reply.payload.code, 'skill_requirements_unmet');
  assert.deepEqual(r.reply.payload.missing, ['web-search']);
  assert.equal(r.requests.length, 0); assert.equal(r.turn, null); assert.deepEqual(r.saved, []);
  // Selected for the project, or added for this one message: the pin resolves. The skill never adds it.
  const selected = project({ content: body({ requires: 'web-search' }), toolboxes: ['core', 'web-search'] });
  assert.equal((await run(t, { fixture: selected, reqBody: { skill: pinOf(selected) } })).reply, null);
  const turnOnly = await run(t, { fixture, reqBody: { skill: pinOf(fixture), turnToolboxes: ['web-search'] } });
  assert.equal(turnOnly.reply, null); assert.equal(turnOnly.requests.length, 1);
});

test('chat: a pin whose required toolbox the provider strips stops before any model request', async (t) => {
  const fixture = project({ content: body({ requires: 'diary' }), toolboxes: ['diary'] });
  fixture.provider = 'external-fixture';
  const provider = { id: 'external-fixture', external: true, label: 'External fixture', baseUrl: 'http://fixture.invalid' };
  const r = await run(t, { fixture, provider, known: ['core', 'diary'], user: { id: 'user-a' }, reqBody: { skill: pinOf(fixture) } });
  assert.equal(r.reply, null, 'passed the early check: the project does carry diary');
  assert.equal(errorOf(r)?.code, 'skill_requirements_unmet');
  assert.match(errorOf(r).text, /External fixture cannot use: diary/);
  assert.equal(r.requests.length, 0); assert.equal(r.turn, null);
});

test('chat: automatic loading offers the router only skills whose requirements and assets are usable', async (t) => {
  const fixture = project({ content: body({ requires: 'web-search' }), toolboxes: ['core'], other: true });
  const r = await run(t, { fixture });
  assert.deepEqual(r.routerInput, [OTHER], 'the skill needing an unselected toolbox is not a candidate');
  assert.doesNotMatch(r.requests[0].messages[0].content, /Answer in synthetic haiku/);
  const scripted = project({ extraFiles: [{ name: 'synthetic-helper/scripts/x.py', content: 'print(1)' }], other: true });
  assert.deepEqual((await run(t, { fixture: scripted })).routerInput, [OTHER]);
  const fine = await run(t, { fixture: project({ other: true }) });
  assert.deepEqual(fine.routerInput, [FILE, OTHER]);
  assert.match(fine.requests[0].messages[0].content, /Answer in synthetic haiku/);
});

test('chat: disabling the pinned skill while its write waits for approval stops the write and the exchange', async (t) => {
  const fixture = project();
  const r = await run(t, { fixture, reqBody: { skill: pinOf(fixture) }, rounds: [{ tool: 'synthetic_write' }], onApproval: () => disable(fixture) });
  assert.equal(r.approvals, 1, 'the approval card was still shown; the gate is unchanged');
  assert.deepEqual(r.executed, [], 'an approval does not outlive the skill that asked for it');
  assert.equal(r.requests.length, 1, 'no further model round');
  assert.equal(errorOf(r)?.code, 'skill_revoked');
  assert.match(errorOf(r).text, /"synthetic-helper" was disabled or changed/);
  assert.equal(r.events.some((e) => e.type === 'done'), false);
  assert.match(r.events.find((e) => e.type === 'tool_result').text, /^ERROR: .*synthetic_write was not run/);
  assert.equal(r.turn.phase, 'interrupted'); assert.match(r.turn.failure, /Skill revoked: synthetic-helper\/SKILL\.md/);
  assert.ok(r.audits.some(([kind, , , detail]) => kind === 'tool.denied' && detail.reason === 'skill-revoked'));
});

test('chat: disabling a skill this exchange did not load changes nothing', async (t) => {
  const fixture = project({ other: true });
  const r = await run(t, { fixture, reqBody: { skill: pinOf(fixture) }, rounds: [{ tool: 'synthetic_write' }], onApproval: () => disable(fixture, OTHER) });
  assert.deepEqual(r.executed, ['synthetic_write']);
  assert.equal(r.requests.length, 2);
  assert.equal(errorOf(r), undefined);
  assert.ok(r.events.some((e) => e.type === 'done'));
});

test('chat: a skill the model read itself is revoked before the next round when it is disabled', async (t) => {
  const fixture = project();
  // Routed nothing automatically, so the only way this skill is loaded is the model's own read.
  const r = await run(t, { fixture, rounds: [{ tool: 'read_project_file', args: { name: FILE } }, { tool: 'read_project_file', args: { name: 'notes.txt' } }],
    onExecute: (name, args) => { if (JSON.parse(args).name === FILE) { const out = skills.read(fixture, fixture.files[0], fixture); disable(fixture); return out; } return null; },
    reqBody: { message: 'synthetic question' } });
  // The router fake auto-loads FILE, so this also covers auto-loaded skills.
  assert.equal(r.requests.length, 1);
  assert.equal(errorOf(r)?.code, 'skill_revoked');
  const onlyRead = await run(t, { fixture: project({ other: true }), rounds: [{ tool: 'read_project_file', args: { name: OTHER } }] });
  assert.equal(onlyRead.requests.length, 2, 'reading and keeping a skill enabled continues normally');
});

test('chat: a skill loaded only through read_project_file is tracked too', async (t) => {
  const fixture = project({ other: true });
  const r = await run(t, { fixture, rounds: [{ tool: 'read_project_file', args: { name: OTHER } }, { tool: 'synthetic_write' }],
    onExecute: (name, args) => { if (name === 'read_project_file' && JSON.parse(args).name === OTHER) { disable(fixture, OTHER); return 'Loaded instruction skill "other-helper"'; } return null; } });
  assert.equal(r.requests.length, 1, 'the read skill was disabled, so round two never started');
  assert.deepEqual(r.executed, ['read_project_file']);
  assert.match(errorOf(r).text, /"other-helper"/);
});

test('chat: a SKILL.md stored under the upload folder and read by its bare name is tracked (#642)', async (t) => {
  const stored = 'noevia projects/Fixture/Text/SKILL.md', content = body({ name: 'uploaded-helper' });
  const fixture = { id: 'fixture-project', name: 'Fixture', model: 'answer-model', assets: [], projectFolder: 'noevia projects/Fixture',
    files: [{ name: stored, content }, { name: 'notes.txt', content: 'plain source' }],
    instructionSkills: { [stored]: { enabled: true, reviewedHash: skills.hash(content) } } };
  // The result carries no SHA-256, so only the name can tie the read to the skill.
  const r = await run(t, { fixture, router: () => ({ loaded: [] }), rounds: [{ tool: 'read_project_file', args: { name: 'SKILL.md' } }, { tool: 'synthetic_write' }],
    onExecute: (name, args) => { if (name === 'read_project_file' && JSON.parse(args).name === 'SKILL.md') { disable(fixture, stored); return 'Loaded instruction skill "uploaded-helper"'; } return null; } });
  assert.deepEqual(r.executed, ['read_project_file'], 'the bare-name read loaded the skill, so its revocation stopped the write');
  assert.equal(r.requests.length, 1);
  assert.match(errorOf(r).text, /"uploaded-helper"/);
});

test('chat: a reply streaming under a skill that is disabled mid-stream is cut off', async (t) => {
  const fixture = project();
  const r = await run(t, { fixture, reqBody: { skill: pinOf(fixture) }, streamDelayMs: 1100, rounds: [{ content: 'first words', afterFirstChunk: () => disable(fixture) }] });
  const text = r.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.equal(text, 'first words');
  assert.equal(errorOf(r)?.code, 'skill_revoked');
  assert.equal(r.turn.phase, 'interrupted');
});

test('durable continuation of a pinned turn requires the pin to be still active', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-resume-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = { dir, userId: 'tenant-a' }, service = createChatTurns({ enabled: true });
  const fixture = project();
  const record = { id: skills.skillId(fixture, FILE), file: FILE, name: 'synthetic-helper', versionLabel: '1.0.0', version: skills.hash(fixture.files[0].content), contentHash: skills.hash(fixture.files[0].content), origin: 'project-file' };
  const start = () => { const turn = service.start(workspace, { projectId: fixture.id, conversationId: 'c', messages: [{ role: 'user', content: 'synthetic' }], model: { id: 'm' }, skill: record }); turn.interrupt('model died'); return turn.id; };
  const opts = (skillActive) => ({ model: { id: 'm' }, project: (s) => s.messages, provider: async () => ({ content: 'resumed' }), ...(skillActive ? { skillActive } : {}) });
  const noCheck = start();
  await assert.rejects(service.resumeGeneration(workspace, noCheck, opts()), /continuation refused/);
  assert.equal(service.restore(workspace, noCheck).state.retries.remaining, 1, 'refused before any attempt was spent');
  const ok = start();
  assert.equal((await service.resumeGeneration(workspace, ok, opts((r) => skills.pinActive(fixture, r)))).phase, 'completed');
  disable(fixture);
  const off = start();
  await assert.rejects(service.resumeGeneration(workspace, off, opts((r) => skills.pinActive(fixture, r))), /continuation refused/);
});

// ── Review follow-ups ──

test('chat: a skill read through the Project documents box (project_read_file) is tracked and revoked', async (t) => {
  const fixture = project({ other: true });
  const r = await run(t, { fixture, rounds: [{ tool: 'project_read_file', args: { name: OTHER } }, { tool: 'synthetic_write' }],
    onExecute: (name, args) => { if (name === 'project_read_file' && JSON.parse(args).name === OTHER) { disable(fixture, OTHER); return '{"content":[{"type":"text","text":"Loaded instruction skill"}]}'; } return null; } });
  assert.deepEqual(r.executed, ['project_read_file']);
  assert.equal(r.requests.length, 1, 'no further model request');
  assert.equal(errorOf(r)?.code, 'skill_revoked');
  assert.match(errorOf(r).text, /"other-helper"/);
});

test('chat: any tool whose result carries a skill\'s SHA-256 loads that skill', async (t) => {
  const fixture = project({ other: true });
  const otherHash = skills.hash(fixture.files.find((f) => f.name === OTHER).content);
  const r = await run(t, { fixture, rounds: [{ tool: 'synthetic_read', args: { query: 'x' } }],
    onExecute: (name) => { if (name === 'synthetic_read') { disable(fixture, OTHER); return `excerpt ... SHA-256 ${otherHash}`; } return null; } });
  assert.equal(r.requests.length, 1);
  assert.equal(errorOf(r)?.code, 'skill_revoked');
});

test('chat: every loaded skill is journaled on the durable turn, including ones read mid-exchange', async (t) => {
  const fixture = project({ other: true });
  const r = await run(t, { fixture, rounds: [{ tool: 'project_read_file', args: { name: OTHER } }] });
  assert.equal(r.requests.length, 2);
  assert.deepEqual(r.turn.skills.map((s) => s.file).sort(), [FILE, OTHER].sort(), 'the auto-loaded skill and the read one');
  for (const s of r.turn.skills) assert.match(s.contentHash, /^[a-f0-9]{64}$/);
  const unloaded = await run(t, { fixture: project({ content: body({ requires: 'web-search' }), toolboxes: ['core'] }) });
  assert.equal('skills' in unloaded.turn, false, 'absent when the exchange loaded no skill');
});

test('chat: after a revocation-refused tool, step supervision is not consulted and there is one error', async (t) => {
  const fixture = project();
  let supervisorCalls = 0;
  const stepSupervision = { decide: async () => { supervisorCalls++; return { action: 'escalate' }; } };
  const r = await run(t, { fixture, stepSupervision, reqBody: { skill: pinOf(fixture) }, rounds: [{ tool: 'synthetic_write' }], onApproval: () => disable(fixture) });
  assert.equal(supervisorCalls, 0);
  assert.deepEqual(r.events.filter((e) => e.type === 'error').map((e) => e.code), ['skill_revoked']);
  assert.equal(r.requests.length, 1);
});

test('chat: tool calls already streamed when a mid-stream revocation cuts the round get an error result', async (t) => {
  const fixture = project();
  const r = await run(t, { fixture, reqBody: { skill: pinOf(fixture) }, streamDelayMs: 1100,
    rounds: [{ tool: 'synthetic_write', afterFirstChunk: () => disable(fixture) }] });
  assert.ok(r.events.some((e) => e.type === 'tool' && e.index === 0), 'the chip was streamed');
  const result = r.events.find((e) => e.type === 'tool_result' && e.index === 0);
  assert.ok(result, 'the chip is resolved, not left pending');
  assert.match(result.text, /^ERROR: .*synthetic_write was not run/);
  assert.deepEqual(r.executed, []); assert.equal(r.approvals, 0); assert.equal(r.requests.length, 1);
  assert.equal(errorOf(r)?.code, 'skill_revoked');
});

test('durable continuation verifies every loaded skill, not only the pin', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-resume-all-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = { dir, userId: 'tenant-a' }, service = createChatTurns({ enabled: true });
  const fixture = project({ other: true });
  const other = { file: OTHER, name: 'other-helper', contentHash: skills.hash(fixture.files.find((f) => f.name === OTHER).content) };
  const start = () => { const turn = service.start(workspace, { projectId: fixture.id, conversationId: 'c', messages: [{ role: 'user', content: 'synthetic' }], model: { id: 'm' }, skills: [other] }); turn.interrupt('model died'); return turn.id; };
  const opts = { model: { id: 'm' }, project: (s) => s.messages, provider: async () => ({ content: 'resumed' }), skillActive: (rec) => skills.pinActive(fixture, rec) };
  assert.equal((await service.resumeGeneration(workspace, start(), opts)).phase, 'completed');
  disable(fixture, OTHER);
  await assert.rejects(service.resumeGeneration(workspace, start(), opts), /continuation refused/);
});

// ── Revoked Skills in earlier turns (#546) ──
// Turn 1 loads skill A; A is then disabled or changed; turn 2 carries turn 1 in its client history.

const A_TEXT = 'Answer in synthetic haiku.\nAlways cite the synthetic ledger code ZX-41 in every reply.\n- Keep it short.';
const A_MARKERS = ['synthetic haiku', 'ZX-41', 'A synthetic fixture skill'];
const skillHistory = require('./skill-history.cjs');
const account = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-hist-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const echo = `Understood. I will follow the skill:\n${A_TEXT}\nHere is my synthetic answer.`;
const nonSystem = (request) => request.messages.filter((m) => m.role !== 'system');
const sentText = (request) => JSON.stringify(nonSystem(request));
const noRouter = async () => ({ loaded: [] });
const readHistory = (readOut, tool = 'read_project_file') => [
  { role: 'user', content: 'first synthetic question' },
  { role: 'assistant', content: 'Reading the skill first.' },
  { role: 'tool', name: tool, content: readOut },
  { role: 'assistant', content: echo },
];
const echoHistory = [{ role: 'user', content: 'first synthetic question' }, { role: 'assistant', content: echo }];

async function twoTurns(t, variant, revoke = disable) {
  const dir = account(t);
  const fixture = project({ content: body({ text: A_TEXT }) });
  const readOut = skills.read(fixture, fixture.files[0], fixture);
  const first = variant === 'pinned' ? { reqBody: { skill: pinOf(fixture) }, router: noRouter, rounds: [{ content: echo }] }
    : variant === 'auto' ? { rounds: [{ content: echo }] }
      : { router: noRouter, rounds: [{ tool: variant, args: { name: FILE } }, { content: echo }], onExecute: (name) => (name === variant ? readOut : null) };
  const turn1 = await run(t, { fixture, dir, ...first });
  assert.equal(errorOf(turn1), undefined);
  const history = variant === 'pinned' || variant === 'auto' ? echoHistory : readHistory(readOut, variant);
  revoke(fixture);
  const turn2 = await run(t, { fixture, dir, router: noRouter, reqBody: { message: 'second synthetic question', history } });
  return { turn1, turn2, fixture, dir, history, readOut };
}

for (const variant of ['pinned', 'auto', 'read_project_file', 'project_read_file']) {
  test(`history (#546): a ${variant} skill disabled after turn 1 leaves none of its body in turn 2's model request`, async (t) => {
    const { turn1, turn2 } = await twoTurns(t, variant);
    if (variant === 'pinned' || variant === 'auto') assert.match(turn1.requests[0].messages[0].content, /ZX-41/, 'turn 1 did load the skill');
    assert.equal(turn2.requests.length, 1);
    const all = JSON.stringify(turn2.requests[0].messages);
    for (const marker of A_MARKERS) assert.equal(all.includes(marker), false, `no "${marker}" anywhere in turn 2`);
    assert.match(sentText(turn2.requests[0]), /\[Skill \\"synthetic-helper\\" was disabled or changed, and its instructions were removed\]/);
    assert.match(sentText(turn2.requests[0]), /Here is my synthetic answer\./, 'the rest of the earlier reply is kept');
    assert.match(sentText(turn2.requests[0]), /first synthetic question/);
    const warning = turn2.events.find((e) => e.type === 'warning');
    assert.match(warning?.text || '', /Earlier replies in this chat used Skill "synthetic-helper", which is now disabled or changed/);
    assert.ok(turn2.events.some((e) => e.type === 'done'), 'the new reply runs normally');
  });
}

test('history (#546): a skill that is still enabled at the same hash is kept exactly', async (t) => {
  const { turn2, history } = await twoTurns(t, 'read_project_file', () => {});
  const sent = nonSystem(turn2.requests[0]);
  assert.match(JSON.stringify(sent), /ZX-41/);
  assert.equal(sent.find((m) => m.role === 'assistant').content.includes(history[2].content.slice(0, 200)), true, 'the read result is replayed as before');
  assert.equal(turn2.events.some((e) => e.type === 'warning'), false);
});

test('history (#546): a changed hash is treated as revoked, even when the new version is enabled', async (t) => {
  const { turn2 } = await twoTurns(t, 'read_project_file', (fixture) => {
    const next = body({ text: 'Answer in plain synthetic prose.\n- Keep it short.' });
    fixture.files[0].content = next;
    fixture.instructionSkills[FILE] = { enabled: true, reviewedHash: skills.hash(next) };
  });
  const all = JSON.stringify(nonSystem(turn2.requests[0]));
  for (const marker of ['synthetic haiku', 'ZX-41']) assert.equal(all.includes(marker), false, `no "${marker}" from the old version`);
  assert.match(all, /was disabled or changed/);
});

test('history (#546): a skill removed from the project is revoked through the ledger', async (t) => {
  const { turn2 } = await twoTurns(t, 'auto', (fixture) => { fixture.files.shift(); delete fixture.instructionSkills[FILE]; });
  assert.equal(JSON.stringify(turn2.requests[0].messages).includes('ZX-41'), false);
});

test('history (#546): a disabled skill loaded before the ledger existed is recognised by its SHA-256 only', async (t) => {
  const fixture = project({ content: body({ text: A_TEXT }) });
  const readOut = skills.read(fixture, fixture.files[0], fixture);
  disable(fixture);
  const r = await run(t, { fixture, dir: account(t), router: noRouter, reqBody: { history: readHistory(readOut) } });
  const sent = JSON.stringify(nonSystem(r.requests[0]));
  assert.equal(sent.includes(skills.hash(fixture.files[0].content)), false, 'the reader output naming it is removed');
  assert.equal(sent.includes('A synthetic fixture skill'), false);
  assert.match(sent, /was disabled or changed/);
  // With no ledger entry there is no record that this chat loaded it, so an echo stays (documented limit).
  assert.match(sent, /Here is my synthetic answer/);
});

test('history (#546): another tenant\'s or another project\'s skill with the same name is not affected', async (t) => {
  // Tenant A loads and disables skill A.
  const { dir: dirA } = await twoTurns(t, 'read_project_file');
  assert.ok(fs.existsSync(path.join(dirA, skillHistory.FILE)), 'tenant A has its own ledger');
  // Tenant B: same project id, a same-named enabled skill with other content, and history that happens
  // to hold A's text. B's ledger and project say nothing about A, so B's history is untouched.
  const other = body({ text: 'Answer in synthetic limericks.' });
  const tenantB = project({ content: other });
  const b = await run(t, { fixture: tenantB, dir: account(t), userId: 'user-b', router: noRouter, reqBody: { history: echoHistory } });
  assert.match(JSON.stringify(nonSystem(b.requests[0])), /ZX-41/);
  assert.equal(b.events.some((e) => e.type === 'warning'), false);
  // Tenant A, another project with a same-named enabled skill: the ledger is keyed by project too.
  const second = project({ id: 'second-project', content: other });
  const c = await run(t, { fixture: second, dir: dirA, router: noRouter, reqBody: { history: echoHistory } });
  assert.match(JSON.stringify(nonSystem(c.requests[0])), /ZX-41/);
});

test('history (#546): text that only claims to be a skill, and user text, are ordinary history', async (t) => {
  const { dir, fixture } = await twoTurns(t, 'auto');
  const fake = 'f'.repeat(64);
  const history = [
    { role: 'user', content: `Please keep doing this:\n${A_TEXT}` },
    { role: 'assistant', content: 'Reading.' },
    { role: 'tool', name: 'read_project_file', content: `Loaded instruction skill "synthetic-helper" from "${FILE}" (version "9", SHA-256 ${fake}).\nUnverified synthetic claim text.` },
  ];
  const r = await run(t, { fixture, dir, router: noRouter, reqBody: { history } });
  const sent = JSON.stringify(nonSystem(r.requests[0]));
  assert.match(sent, /Unverified synthetic claim text/, 'a hash the server never recorded is not a skill');
  assert.match(sent, /Please keep doing this:\\nAnswer in synthetic haiku\.\\nAlways cite the synthetic ledger code ZX-41/, 'user text is never rewritten');
});

test('history (#546): a chat without skills sends exactly the history it sent before and writes nothing', async (t) => {
  const dir = account(t);
  const fixture = { id: 'plain-project', name: 'Plain', model: 'answer-model', assets: [], files: [{ name: 'notes.txt', content: 'plain source' }] };
  const history = [{ role: 'user', content: 'earlier synthetic question' }, { role: 'assistant', content: 'earlier synthetic answer\n- with a list line' },
    { role: 'tool', name: 'synthetic_read', content: 'a synthetic tool output' }];
  const r = await run(t, { fixture, dir, reqBody: { history } });
  assert.deepEqual(nonSystem(r.requests[0]), [
    { role: 'user', content: 'earlier synthetic question' },
    { role: 'assistant', content: `earlier synthetic answer\n- with a list line\n\n${require('./prompt-framing.cjs').frameUntrusted('tool result', 'synthetic_read', 'a synthetic tool output')}` },
    { role: 'user', content: 'synthetic question' },
  ]);
  assert.equal(r.events.some((e) => e.type === 'warning'), false);
  assert.equal(fs.existsSync(path.join(dir, skillHistory.FILE)), false, 'no ledger for a chat that loaded no skill');
});

test('skill-history scrub: short lines extend a match, lines of an enabled skill and other text stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-hist-unit-'));
  try {
    const ledger = skillHistory.createSkillHistory({ fs, path });
    const revokedBody = body({ text: 'Always cite the synthetic ledger code ZX-41 in every reply.\nBe terse.\nNever mention the synthetic weather service.\nShared line kept by the enabled skill.' });
    const p = project({ content: revokedBody, other: true });
    const otherFile = p.files.find((f) => f.name === OTHER);
    otherFile.content = body({ name: 'other-helper', text: 'Shared line kept by the enabled skill.' });
    p.instructionSkills[OTHER] = { enabled: true, reviewedHash: skills.hash(otherFile.content) };
    const version = { file: FILE, name: 'synthetic-helper', hash: skills.hash(revokedBody), content: revokedBody };
    assert.equal(ledger.record(dir, p, version, { chatId: 'chat-1' }), true);
    assert.equal(ledger.record(dir, p, version, { chatId: 'chat-1' }), false, 'idempotent');
    assert.equal(fs.readFileSync(path.join(dir, skillHistory.FILE), 'utf8').includes('ZX-41'), false, 'the ledger keeps fingerprints, not text');
    const messages = [{ role: 'assistant', content: 'Intro.\n\nAlways cite the synthetic ledger code ZX-41 in every reply.\nBe terse.\nNever mention the synthetic weather service.\n\nShared line kept by the enabled skill.\nBe terse.\nOutro.' }];
    assert.equal(ledger.scrub({ dir, project: p, messages, chatId: 'chat-1' }).messages, messages, 'enabled: nothing to do, same array back');
    disable(p);
    const out = ledger.scrub({ dir, project: p, messages, chatId: 'chat-1' });
    assert.deepEqual(out.removed, ['synthetic-helper']);
    assert.equal(out.messages[0].content, `Intro.\n\n${skillHistory.placeholder(['synthetic-helper'])}\n\nShared line kept by the enabled skill.\nBe terse.\nOutro.`);
    assert.equal(messages[0].content.includes('ZX-41'), true, 'the input is not mutated');
    assert.equal(ledger.scrub({ dir, project: p, messages, chatId: 'chat-2' }).messages, messages, 'a chat that never loaded it: its text is not matched');
    // A fresh handler reads the same ledger from disk.
    const reloaded = skillHistory.createSkillHistory({ fs, path });
    const removed = structuredClone(p); removed.files.shift(); delete removed.instructionSkills[FILE];
    assert.deepEqual(reloaded.scrub({ dir, project: removed, messages, chatId: 'chat-1' }).removed, ['synthetic-helper']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── #546 review follow-ups ──

const CODE_SKILL = 'Always cite the synthetic ledger code ZX-41 in every reply.\nNever mention the synthetic weather service.\n```python\nimport numpy as np\n```\nLet me know if you have any questions.';

test('history (#546 review): one common line and a code fence shared with a revoked skill stay, with no warning', async (t) => {
  const dir = account(t);
  const fixture = project({ content: body({ text: CODE_SKILL }) });
  await run(t, { fixture, dir, reqBody: { skill: pinOf(fixture) }, router: noRouter }); // this chat loaded it
  disable(fixture);
  const code = 'Here is the synthetic script:\n```python\nimport numpy as np\nprint(np.zeros(3))\n```\nLet me know if you have any questions.';
  const history = [{ role: 'user', content: 'write synthetic code' }, { role: 'assistant', content: code }];
  const r = await run(t, { fixture, dir, router: noRouter, reqBody: { history } });
  assert.equal(nonSystem(r.requests[0])[1].content, code, 'the code block reaches the model unchanged');
  assert.equal(r.events.some((e) => e.type === 'warning'), false);
  // A real echo (two identifying lines) in another chat that never loaded the skill is not matched either.
  const echoOf = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Always cite the synthetic ledger code ZX-41 in every reply.\nNever mention the synthetic weather service.' }];
  const other = await run(t, { fixture, dir, router: noRouter, reqBody: { chatId: 'another-chat', history: echoOf } });
  assert.match(JSON.stringify(nonSystem(other.requests[0])), /ZX-41/);
  assert.equal(other.events.some((e) => e.type === 'warning'), false);
  // The same echo in the chat that loaded it is removed.
  const same = await run(t, { fixture, dir, router: noRouter, reqBody: { history: echoOf } });
  assert.equal(JSON.stringify(same.requests[0].messages).includes('ZX-41'), false);
});

test('history (#546 review): switching off a skill that was never enabled leaves history unchanged', async (t) => {
  const content = body({ text: A_TEXT });
  const fixture = project({ content });
  fixture.instructionSkills[FILE] = { enabled: false, reviewedHash: null }; // awaiting review
  skills.setSelection(fixture, { file: FILE, enabled: false }); // switched off from review
  assert.equal(skills.list(fixture)[0].status, 'disabled');
  const r = await run(t, { fixture, dir: account(t), router: noRouter, reqBody: { history: echoHistory } });
  assert.equal(nonSystem(r.requests[0])[1].content, echo);
  assert.equal(r.events.some((e) => e.type === 'warning'), false);
});

test('history (#546 review): a skill disabled while the request is prepared is removed before the first model request', async (t) => {
  const dir = account(t);
  const fixture = project({ content: body({ text: A_TEXT }) });
  await run(t, { fixture, dir, reqBody: { skill: pinOf(fixture) }, router: noRouter, rounds: [{ content: echo }] });
  // Enabled when the history is first checked; disabled by the time routing finishes.
  const r = await run(t, { fixture, dir, router: async () => { disable(fixture); return { loaded: [] }; }, reqBody: { history: echoHistory } });
  assert.equal(r.requests.length, 1);
  assert.equal(JSON.stringify(r.requests[0].messages).includes('ZX-41'), false);
  assert.match(r.events.filter((e) => e.type === 'warning').at(-1)?.text || '', /Skill "synthetic-helper", which is now disabled or changed/);
});

test('skill-history (#546 review): an inactive account records nothing and its folder is not recreated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-hist-gone-'));
  try {
    const dir = path.join(root, 'deleted-account');
    const ledger = skillHistory.createSkillHistory({ fs, path });
    const p = project();
    const ok = ledger.record(dir, p, { file: FILE, name: 'synthetic-helper', hash: skills.hash(p.files[0].content), content: p.files[0].content },
      { chatId: 'c', assertActive: () => { throw Error('Workspace was deleted'); } });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(dir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('skill-history (#546 review): a corrupt ledger is moved aside, and malformed entries are dropped without breaking chat', async (t) => {
  const dir = account(t);
  fs.writeFileSync(path.join(dir, skillHistory.FILE), '{not json');
  const p = project({ content: body({ text: A_TEXT }) });
  const version = { file: FILE, name: 'synthetic-helper', hash: skills.hash(p.files[0].content), content: p.files[0].content };
  assert.equal(skillHistory.createSkillHistory({ fs, path }).record(dir, p, version, { chatId: 'fixture-chat' }), true);
  assert.equal(fs.readFileSync(path.join(dir, `${skillHistory.FILE}.corrupt`), 'utf8'), '{not json', 'the unreadable file is kept');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, skillHistory.FILE), 'utf8')).projects[p.id].length === 1);
  // Structurally bad entries next to a good one.
  const good = JSON.parse(fs.readFileSync(path.join(dir, skillHistory.FILE), 'utf8')).projects[p.id][0];
  fs.writeFileSync(path.join(dir, skillHistory.FILE), JSON.stringify({ v: 1, projects: { [p.id]: [null, 7, { file: 3 }, { file: FILE, hash: 'short' }, good], other: 'x' } }));
  disable(p);
  const r = await run(t, { fixture: p, dir, router: noRouter, reqBody: { history: echoHistory } });
  assert.equal(r.reply, null, 'chat still runs');
  assert.equal(JSON.stringify(r.requests[0].messages).includes('ZX-41'), false, 'the valid entry still applies');
});

test('skill-history (#546 review): at the cap, versions still enabled are evicted before revoked ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-hist-cap-'));
  try {
    const ledger = skillHistory.createSkillHistory({ fs, path, maxVersions: 3 });
    const files = ['a', 'b', 'c', 'd'].map((n) => ({ name: `${n}/SKILL.md`, content: body({ name: n, text: `Synthetic instruction line for ${n}.\nSecond synthetic line for skill ${n}.` }) }));
    const p = { id: 'cap-project', files, instructionSkills: Object.fromEntries(files.map((f) => [f.name, { enabled: true, reviewedHash: skills.hash(f.content) }])) };
    p.instructionSkills['a/SKILL.md'].enabled = false; // a: recorded first, now revoked
    for (const f of files) ledger.record(dir, p, { file: f.name, name: f.name[0], hash: skills.hash(f.content), content: f.content }, { chatId: 'c' });
    const kept = JSON.parse(fs.readFileSync(path.join(dir, skillHistory.FILE), 'utf8')).projects[p.id].map((e) => e.name);
    assert.deepEqual(kept, ['a', 'c', 'd'], 'the oldest enabled version went, the revoked one stayed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
