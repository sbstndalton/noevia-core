'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createResearchService, reportFiles, slug } = require('./research-service.cjs');
const { sanitizePlan, parsePlan, createPlanner } = require('./research-plan.cjs');

const PAGE = '<h1>Zephyr cell</h1><p>The Zephyr cell stores 410 Wh per kilogram at room temperature.</p>';
const model = (calls, { hang } = {}) => async (messages, { signal } = {}) => {
  calls.push(messages[0].content.slice(0, 30));
  if (messages[0].content.startsWith('You plan')) return '```json\n{"subQuestions":["What is the Zephyr cell?","How much energy does it store?","Who makes it?"]}\n```';
  if (hang && calls.filter((c) => c.startsWith('You write one section')).length >= hang) {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))));
  }
  const user = messages[1].content;
  if (messages[0].content.startsWith('You write research notes')) { const id = user.match(/<SOURCE id="(\d+)">/)[1]; return `- The Zephyr cell stores 410 Wh per kilogram [${id}]`; }
  const [, id] = user.match(/Note \[(\d+)\]/);
  return `The Zephyr cell stores 410 Wh per kilogram [${id}].`;
};

function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-research-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = { dir }, project = { id: 'p1' }, other = { id: 'p2' };
  const saved = [], calls = [];
  const service = createResearchService({
    now: () => Date.parse('2026-09-17T10:00:00Z') + calls.length,
    saveFile: async (p, name, text) => { saved.push({ project: p.id, name, text }); },
    tools: () => ({ search: async () => [{ url: 'https://fixture.test/z', title: 'Zephyr' }], extract: async () => PAGE, projectRetrieve: async () => [], complete: model(calls, opts) }),
  });
  return { service, workspace, project, other, saved, calls };
}
const settle = async (service, w, p, id, status) => { for (let i = 0; i < 200; i++) { const j = service.get(w, p, id); if (!status ? !['queued', 'running'].includes(j.status) : j.status === status) return j; await new Promise((r) => setTimeout(r, 5)); } throw Error('job did not settle'); };

test('plan proposes 3–7 sanitized questions; edits are validated', async (t) => {
  const { service, workspace, project } = setup(t);
  assert.deepEqual(await service.plan(workspace, project, 'Zephyr cell?'), ['What is the Zephyr cell?', 'How much energy does it store?', 'Who makes it?']);
  assert.deepEqual(sanitizePlan(['  a  b ', 'A B', '', 'c']), ['a b', 'c']);
  assert.throws(() => sanitizePlan([]), /at least one/);
  assert.throws(() => sanitizePlan(Array.from({ length: 8 }, (_, i) => `q${i}`)), /at most 7/);
  assert.throws(() => sanitizePlan(['x'.repeat(201)]), /under 200/);
  assert.throws(() => parsePlan('{"subQuestions":["only one"]}'), /at least 3/);
  assert.throws(() => parsePlan('not json'), /usable plan/);
  await assert.rejects(() => createPlanner({ complete: async () => '', windowTokens: 10 }).plan('question'), /tokens/);
});

test('a completed job saves the report and sources as project files, once', async (t) => {
  const { service, workspace, project, saved } = setup(t);
  const started = await service.start(workspace, project, { question: 'What is the Zephyr cell?', plan: 'edited', subQuestions: ['What is the Zephyr cell?', 'Energy?'] });
  const job = await settle(service, workspace, project, started.id);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.plan, { status: 'edited', subQuestions: ['What is the Zephyr cell?', 'Energy?'] });
  assert.deepEqual(saved.map((f) => f.name), ['Research 2026-09-17 what-is-the-zephyr-cell.md', 'Research 2026-09-17 what-is-the-zephyr-cell.sources.json']);
  assert.match(saved[0].text, /410 Wh per kilogram \[1\]/);
  assert.equal(JSON.parse(saved[1].text).sources[0].url, 'https://fixture.test/z');
  assert.deepEqual(job.artifacts, saved.map((f) => f.name));
  assert.equal(job.canSavePartial, false);
  await assert.rejects(() => service.savePartial(workspace, project, started.id), /already saved|cancelled/);
});

test('cancel keeps finished sections, never auto-saves, and partial save is explicit', async (t) => {
  const { service, workspace, project, saved } = setup(t, { hang: 2 });
  const started = await service.start(workspace, project, { question: 'Zephyr', plan: 'proposed', subQuestions: ['One?', 'Two?', 'Three?'] });
  await assert.rejects(() => service.start(workspace, project, { question: 'second' }), /already running/);
  for (let i = 0; i < 200 && !(service.get(workspace, project, started.id).checkpoint?.step >= 1); i++) await new Promise((r) => setTimeout(r, 5));
  service.cancel(workspace, project, started.id);
  const job = await settle(service, workspace, project, started.id, 'cancelled');
  assert.equal(saved.length, 0, 'cancel must not save');
  assert.equal(job.result.partial, true);
  assert.equal(job.result.sections, 1);
  assert.match(job.result.markdown, /Partial report: 1 of 3/);
  assert.equal(job.canSavePartial, true);
  const after = await service.savePartial(workspace, project, started.id);
  assert.equal(saved.length, 2);
  assert.equal(after.canSavePartial, false);
  await assert.rejects(() => service.savePartial(workspace, project, started.id), /already saved/);
});

test('jobs are project-scoped and inputs are validated', async (t) => {
  const { service, workspace, project, other } = setup(t);
  const started = await service.start(workspace, project, { question: 'Zephyr' });
  await settle(service, workspace, project, started.id);
  assert.throws(() => service.get(workspace, other, started.id), /No such research job/);
  assert.throws(() => service.cancel(workspace, other, started.id), /No such research job/);
  assert.throws(() => service.get(workspace, project, '../../etc/passwd'), /No such research job/);
  assert.deepEqual(service.list(workspace, other), []);
  assert.equal(service.list(workspace, project).length, 1);
  await assert.rejects(() => service.start(workspace, project, { question: '' }), /question first/);
  await assert.rejects(() => service.start(workspace, project, { question: 'q', plan: 'edited', subQuestions: [] }), /at least one/);
});

test('report files and slugs', () => {
  assert.equal(slug('Ünïcode: what?!'), 'unicode-what');
  assert.equal(slug('!!!'), 'research');
  const files = reportFiles({ question: 'Q', markdown: '# Q', sources: [], citationValidity: 1, webCalls: 0 }, Date.parse('2026-01-02T00:00:00Z'));
  assert.deepEqual(files.map((f) => f.name), ['Research 2026-01-02 q.md', 'Research 2026-01-02 q.sources.json']);
});
