'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatFraming, createFramingSettings, normalizeFrame, existingTags, KINDS, NONE } = require('./chat-framing.cjs');
const { createDecisions } = require('./decision/index.cjs');
const { mergeChats } = require('./chat-lists.cjs');
const { REGISTRY, createFeatures } = require('./features.cjs');

// Synthetic fixtures only.
const projects = [{ id: 'p-garden', name: 'Garden' }, { id: 'p-tax', name: 'Taxes' }];
const chats = [
  { id: 'c1', title: 'Tomato blight', updatedAt: 3, frame: { kind: 'question', tags: ['plants', 'garden/veg'], links: [], confirmed: true, source: 'user' } },
  { id: 'c2', title: 'Invoice totals', updatedAt: 2, frame: { kind: 'action', tags: ['money'], links: [], confirmed: true, source: 'user' } },
  { id: 'c3', title: 'Unrelated', updatedAt: 1 },
];
// A fake embedding: texts mentioning a topic share a direction.
const vec = (t) => [/tomato|garden|plant/i.test(t) ? 1 : 0, /tax|invoice|money/i.test(t) ? 1 : 0, 0.01];
const embed = async (texts) => texts.map(vec);

/** decide() over a stub backend that answers per purpose; records every request it was offered. */
function stubDecide(answers, { delayMs = 0, throws = false } = {}) {
  const seen = [];
  const backend = { id: 'stub', locality: 'local', supports: () => true,
    async decide(request) {
      seen.push(request);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (throws) throw Error('boom');
      const selected = typeof answers[request.purpose] === 'function' ? answers[request.purpose](request) : answers[request.purpose];
      return { selected, scores: { [selected]: 0.9 }, confidence: 0.9 };
    } };
  const decisions = createDecisions({ backends: { stub: backend }, chains: { 'chat.frame.kind': ['stub'], 'chat.frame.project': ['stub'], 'chat.frame.tag': ['stub'] } });
  return { decide: decisions.decide, seen };
}

const make = (decide, extra = {}) => createChatFraming({ enabled: () => true, decide, embed, deadlineMs: () => 300, ...extra });

test('suggests a frame picked only from the offered project, kind and tag options', async () => {
  const { decide, seen } = stubDecide({ 'chat.frame.kind': 'question', 'chat.frame.project': 'p-garden', 'chat.frame.tag': 'plants' });
  const { frame, reason } = await make(decide).suggest({ message: 'Why is my tomato plant wilting?', projects, chats });
  assert.equal(reason, null);
  assert.deepEqual(frame, { projectId: 'p-garden', kind: 'question', tags: ['plants'], links: ['c1'], confirmed: false, source: 'suggested' });
  const byPurpose = Object.fromEntries(seen.map((r) => [r.purpose, r.options.map((o) => o.id)]));
  assert.deepEqual(byPurpose['chat.frame.kind'], KINDS);
  assert.deepEqual(byPurpose['chat.frame.project'].sort(), ['p-garden', 'p-tax', NONE].sort());
  assert.deepEqual(byPurpose['chat.frame.tag'].sort(), ['garden/veg', 'money', 'plants', NONE].sort());
  for (const r of seen) { assert.equal(r.context.cloud, 'forbidden'); assert.ok(r.options.length <= 8); }
});

test('option constraint: an answer outside the offered options gives no project or no frame', async () => {
  const { decide } = stubDecide({ 'chat.frame.kind': 'question', 'chat.frame.project': 'someone-elses-project', 'chat.frame.tag': 'invented' });
  const { frame } = await make(decide).suggest({ message: 'tomato', projects, chats });
  assert.equal(frame.projectId, null);
  assert.deepEqual(frame.tags, []);
  const bad = stubDecide({ 'chat.frame.kind': 'gossip' });
  assert.deepEqual(await make(bad.decide).suggest({ message: 'hi', projects: [], chats: [] }), { frame: null, reason: 'no-kind' });
  // A decide that skips validation still cannot widen the options.
  const raw = make(async (r) => ({ source: 'stub', selected: r.purpose === 'chat.frame.kind' ? 'question' : 'p-other', scores: {} }));
  assert.equal((await raw.suggest({ message: 'x', projects, chats: [] })).frame.projectId, null);
});

test('"none of these" leaves the project and tags empty', async () => {
  const { decide } = stubDecide({ 'chat.frame.kind': 'idea', 'chat.frame.project': NONE, 'chat.frame.tag': NONE });
  const { frame } = await make(decide).suggest({ message: 'a new board game', projects, chats });
  assert.equal(frame.projectId, null);
  assert.deepEqual(frame.tags, []);
});

test('options are capped at the service limit, pre-ranked by similarity', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })).concat([{ id: 'p-garden', name: 'Garden' }]);
  const { decide, seen } = stubDecide({ 'chat.frame.kind': 'question', 'chat.frame.project': 'p-garden' });
  await make(decide).suggest({ message: 'garden question', projects: many, chats: [] });
  const offered = seen.find((r) => r.purpose === 'chat.frame.project').options.map((o) => o.id);
  assert.equal(offered.length, 8);
  assert.equal(offered[0], 'p-garden');
});

test('fails open: disabled, empty, backend error, deadline and no backend all give no frame', async () => {
  const ok = stubDecide({ 'chat.frame.kind': 'question' });
  assert.deepEqual(await make(ok.decide, { enabled: () => false }).suggest({ message: 'x' }), { frame: null, reason: 'disabled' });
  assert.equal(ok.seen.length, 0);
  assert.deepEqual(await make(ok.decide).suggest({ message: '   ' }), { frame: null, reason: 'empty' });
  assert.equal((await make(stubDecide({}, { throws: true }).decide).suggest({ message: 'x', projects, chats })).frame, null);
  const slow = stubDecide({ 'chat.frame.kind': 'question' }, { delayMs: 500 });
  const t0 = Date.now();
  assert.equal((await make(slow.decide, { deadlineMs: () => 100 }).suggest({ message: 'x', projects, chats })).frame, null);
  assert.ok(Date.now() - t0 < 450, 'returns at the deadline');
  assert.deepEqual(await make(async () => { throw Error('Decision service unavailable'); }).suggest({ message: 'x' }), { frame: null, reason: 'error' });
  const hanging = make(ok.decide, { embed: () => new Promise(() => {}), deadlineMs: () => 50 });
  assert.deepEqual(await hanging.suggest({ message: 'x', projects, chats }), { frame: null, reason: 'deadline' });
});

test('embedding failure still frames, without related chats', async () => {
  const { decide } = stubDecide({ 'chat.frame.kind': 'search' });
  const { frame } = await make(decide, { embed: async () => { throw Error('no embed model'); } }).suggest({ message: 'tomato', projects, chats, chatId: 'new' });
  assert.equal(frame.kind, 'search');
  assert.deepEqual(frame.links, []);
});

test('related chats exclude the chat itself and unrelated ones', async () => {
  const { decide } = stubDecide({ 'chat.frame.kind': 'question' });
  const { frame } = await make(decide).suggest({ message: 'tomato', projects, chats, chatId: 'c1' });
  assert.deepEqual(frame.links, []);
});

test('router role model is passed as a hint, never as a vendor default', async () => {
  const { decide, seen } = stubDecide({ 'chat.frame.kind': 'code' });
  await make(decide, { roles: () => ({ framingRouterModel: 'router-small' }) }).suggest({ message: 'x' });
  assert.equal(seen[0].context.roleModel, 'router-small');
});

test('normalizeFrame and existingTags', () => {
  assert.equal(normalizeFrame({ kind: 'gossip' }), null);
  assert.equal(normalizeFrame(null), null);
  assert.deepEqual(normalizeFrame({ kind: 'code', tags: ['#a b', 'a-b', 7, ''], links: ['x', 'x', 3], projectId: 5, confirmed: 'yes', source: 'model' }),
    { projectId: null, kind: 'code', tags: ['a-b'], links: ['x'], confirmed: false, source: 'suggested' });
  assert.deepEqual(existingTags(chats), ['garden/veg', 'money', 'plants']);
});

test('merge keeps a stored frame and createdAt when a stale client omits them', () => {
  const frame = { projectId: 'p-garden', kind: 'question', tags: ['plants'], links: [], confirmed: true, source: 'user' };
  const current = [{ id: 'c1', title: 'old', updatedAt: 1, createdAt: 100, frame }];
  const [kept] = mergeChats(current, [{ id: 'c1', title: 'renamed', updatedAt: 2, createdAt: 999 }]);
  assert.equal(kept.title, 'renamed');
  assert.deepEqual(kept.frame, frame);
  assert.equal(kept.createdAt, 100);
  const [updated] = mergeChats(current, [{ id: 'c1', title: 't', updatedAt: 3, frame: { ...frame, tags: ['x'] } }]);
  assert.deepEqual(updated.frame.tags, ['x']);
  const [cleared] = mergeChats(current, [{ id: 'c1', title: 't', updatedAt: 3, frame: null }]);
  assert.equal(cleared.frame, null);
  const [invalid] = mergeChats(current, [{ id: 'c1', title: 't', updatedAt: 3, frame: { kind: 'nope' } }]);
  assert.deepEqual(invalid.frame, frame);
  const [fresh] = mergeChats([], [{ id: 'n', title: 'n', updatedAt: 1, createdAt: 5, frame: { kind: 'bad' } }]);
  assert.equal(fresh.createdAt, 5);
  assert.equal('frame' in fresh, false);
  assert.equal(mergeChats(current, [{ id: 'c1', title: 't', updatedAt: 3 }], new Set(['c1'])).length, 0);
});

test('chatFraming flag exists and defaults off', () => {
  assert.ok(REGISTRY.chatFraming);
  assert.equal(createFeatures({ env: {} }).enabled('chatFraming'), false);
});

test('framing settings: model-agnostic role ids, validated and audited', () => {
  const data = new Map(), audits = [];
  const s = createFramingSettings({ store: { get: (k) => data.get(k), set: (k, v) => data.set(k, v) }, audit: (...a) => audits.push(a) });
  assert.deepEqual(s.get(), { framingRouterModel: '', framingReasonerModel: '' });
  assert.deepEqual(s.save({ framingRouterModel: ' router-a.gguf ', framingReasonerModel: '' }, 'u1'), { framingRouterModel: 'router-a.gguf', framingReasonerModel: '' });
  assert.throws(() => s.save({ framingRouterModel: 'bad model; rm' }, 'u1'), /model id/);
  assert.equal(audits.length, 1);
  assert.equal(createFramingSettings({ store: { get: (k) => data.get(k), set() {} } }).get().framingRouterModel, 'router-a.gguf');
});

test('framing preferences live in the user directory, default off, and refuse non-booleans (#738)', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { readPreferences, writePreferences } = require('./chat-framing.cjs');
  const one = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-framing-a-')), two = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-framing-b-'));
  const off = { autoAccept: false, keepReasoningTraces: false };
  assert.deepEqual(readPreferences(one), off);
  assert.deepEqual(writePreferences(one, { autoAccept: true, extra: 'dropped' }), { autoAccept: true, keepReasoningTraces: false });
  assert.deepEqual(readPreferences(one), { autoAccept: true, keepReasoningTraces: false });
  // #740: a partial update keeps the other choice.
  assert.deepEqual(writePreferences(one, { keepReasoningTraces: true }), { autoAccept: true, keepReasoningTraces: true });
  assert.deepEqual(readPreferences(two), off, 'another user directory is unaffected');
  assert.throws(() => writePreferences(one, { autoAccept: 1 }), (e) => e.status === 400);
  assert.throws(() => writePreferences(one, { keepReasoningTraces: 'yes' }), (e) => e.status === 400);
  assert.throws(() => writePreferences(one, {}), (e) => e.status === 400);
  assert.throws(() => writePreferences(one, null), (e) => e.status === 400);
  assert.deepEqual(readPreferences(one), { autoAccept: true, keepReasoningTraces: true }, 'a refused write changes nothing');
  fs.writeFileSync(path.join(two, 'chat-framing.json'), '{not json');
  assert.deepEqual(readPreferences(two), off, 'an unreadable file reads as off');
});
