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

async function run(t, { reqBody = {}, fixture = project(), rounds = [], onExecute, onApproval, streamDelayMs = 0, provider, known = ['core', 'web-search'], user, stepSupervision = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-skill-port-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  const workspace = { userId: 'user-a', dir, assetDir: () => '/synthetic-only' };
  const getProject = (id) => (id === fixture.id ? fixture : null); // the live store: edits show at once
  const writes = new Set(['synthetic_write']);
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit: (...a) => audits.push(a), diaryEnabled: () => true }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange, currentWorkspace: () => workspace, getProject,
    skillsIndexFor: (p) => skills.enabled(p), getProvider: (id) => (provider && id === provider.id ? provider : { id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null, visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async (rows) => { routerInput = rows.map((s) => s.file); const hit = rows.find((s) => s.file === FILE); return { loaded: hit ? [hit] : [] }; } },
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
