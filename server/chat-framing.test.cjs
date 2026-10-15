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
  // #1775: the kind does not wait for the embedding, so a hung embed still frames, without links.
  const hung = await hanging.suggest({ message: 'x', projects, chats });
  assert.equal(hung.reason, null);
  assert.equal(hung.frame.kind, 'question');
  assert.deepEqual(hung.frame.links, []);
  const hangingBoth = make(async () => new Promise(() => {}), { embed: () => new Promise(() => {}), deadlineMs: () => 50 });
  assert.deepEqual(await hangingBoth.suggest({ message: 'x', projects, chats }), { frame: null, reason: 'deadline' });
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
  assert.deepEqual(s.get(), { framingRouterModel: '', framingReasonerModel: '', brainContextChars: 2000 });
  assert.deepEqual(s.save({ framingRouterModel: ' router-a.gguf ', framingReasonerModel: '' }, 'u1'), { framingRouterModel: 'router-a.gguf', framingReasonerModel: '', brainContextChars: 2000 });
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

// #760: the suggest deadline aborts work still in flight.
test('at the deadline the embed and decide calls get an aborted signal', async () => {
  const signals = { embed: [], decide: [] };
  const slowEmbed = async (texts, { signal }) => { signals.embed.push(signal); await new Promise((r) => setTimeout(r, 30)); return texts.map(vec); };
  const slowDecide = async (request, { signal }) => { signals.decide.push(signal); await new Promise((r) => setTimeout(r, 200)); return { selected: 'question', source: 'stub' }; };
  const out = await make(slowDecide, { embed: slowEmbed, deadlineMs: () => 60 }).suggest({ message: 'Tomato question', projects, chats });
  assert.deepEqual(out, { frame: null, reason: 'deadline' });
  assert.equal(signals.embed.length, 1);
  assert.ok(signals.decide.length >= 1);
  for (const s of [...signals.embed, ...signals.decide]) assert.equal(s.aborted, true);
});

test('a decision is not started once the deadline has aborted the call', async () => {
  // #1775: the kind starts at once (alongside the embedding); project and tag never start after the deadline.
  const started = [];
  const slowEmbed = (texts, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(texts.map(vec))));
  const kindAfterAbort = (r, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ selected: r.purpose === 'chat.frame.kind' ? null : 'p-garden' })));
  const out = await make(async (r, o) => { started.push(r.purpose); return kindAfterAbort(r, o); }, { embed: slowEmbed, deadlineMs: () => 30 }).suggest({ message: 'Tomato', projects, chats });
  assert.equal(out.reason, 'deadline');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(started, ['chat.frame.kind']);
});

test('a decision is not started when the abort lands after the kind answered (#1778)', async () => {
  // The kind and the embedding both settle only at the abort, so run() resumes with a kind and an aborted
  // signal: project and tag must not start, and the frame keeps the kind.
  const started = [];
  const onAbort = (signal, value) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(value)));
  const decide = async (r, { signal }) => { started.push(r.purpose); return onAbort(signal, { selected: 'idea', source: 'stub' }); };
  const embed = (texts, { signal }) => onAbort(signal, texts.map(vec));
  const out = await make(decide, { embed, deadlineMs: () => 40 }).suggest({ message: 'Tomato', projects, chats });
  assert.equal(out.reason, null);
  assert.equal(out.frame.kind, 'idea');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(started, ['chat.frame.kind']);
});

test('flag off: no embed or decide call at all', async () => {
  let calls = 0;
  const out = await make(async () => { calls++; }, { enabled: () => false, embed: async () => { calls++; return []; } }).suggest({ message: 'Tomato', projects, chats });
  assert.deepEqual(out, { frame: null, reason: 'disabled' });
  assert.equal(calls, 0);
});

test('route: a burst over the per-user budget gets 429 rate-limited without calling suggest', async () => {
  const { createChatFramingRoutes } = require('./routes/chat-framing.cjs');
  // Same fixed-window contract as auth.cjs createRateLimiter (which needs better-sqlite3 to load).
  const hits = new Map();
  const limiter = { rateLimited: (key, limit) => { const n = (hits.get(key) || 0) + 1; hits.set(key, n); return n > limit; } };
  let suggested = 0;
  const routes = createChatFramingRoutes({ json: (res, status, body) => { res.status = status; res.body = body; },
    readJson: async () => ({ message: 'hi' }), settings: {}, workspace: () => ({ projects: [], chats: [] }),
    framing: { suggest: async () => { suggested++; return { frame: null, reason: 'no-kind' }; } },
    rateLimited: (userId) => limiter.rateLimited(`chat-frame:${userId}`, 10, 60000) });
  const call = async (id) => { const res = {}; await routes({ method: 'POST' }, res, { path: '/api/chat-framing/suggest', authn: { user: { id } } }); return res; };
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await call('u-a')).status);
  assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429]);
  assert.deepEqual((await call('u-a')).body, { frame: null, reason: 'rate-limited' });
  assert.equal(suggested, 10);
  assert.equal((await call('u-b')).status, 200, 'another user has their own budget');
});

test('the suggest list offers every live project, including once Code- or Cowork-only ones, never an archived one (#810, #1576)', async () => {
  const offered = [];
  const { decide, seen } = stubDecide({ 'chat.frame.kind': 'question', 'chat.frame.project': (r) => { offered.push(...r.options.map((o) => o.id)); return 'p-code'; }, 'chat.frame.tag': NONE });
  const mixed = [...projects, { id: 'p-code', name: 'Garden code', modes: ['code'] }, { id: 'p-cowork', name: 'Garden cowork', modes: ['cowork'] },
    { id: 'p-old', name: 'Garden archive', modes: ['chat'], archived: true }, { id: 'p-both', name: 'Garden both', modes: ['chat', 'code'] }];
  const { frame } = await make(decide).suggest({ message: 'Tomato garden plans', projects: mixed, chats });
  assert.ok(seen.length > 0);
  assert.deepEqual(offered.filter((id) => id !== NONE).sort(), ['p-both', 'p-code', 'p-cowork', 'p-garden', 'p-tax']);
  assert.equal(frame.projectId, 'p-code', 'a once Code-only project is a valid answer now');
});

test('suggest embeds at most 64 project names and 64 tags, most used tags first (#816)', async () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`, title: '', updatedAt: 0,
    frame: { kind: 'idea', tags: [`tag-${i}`, ...(i < 500 ? ['popular'] : [])], links: [], confirmed: true, source: 'user' } }));
  const lots = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` }));
  const inputs = [];
  const { decide, seen } = stubDecide({ 'chat.frame.kind': 'idea', 'chat.frame.project': NONE, 'chat.frame.tag': NONE });
  await make(decide, { embed: async (texts) => { inputs.push(texts); return texts.map(vec); } }).suggest({ message: 'Synthetic plans', projects: lots, chats: many });
  assert.equal(inputs.length, 1);
  // The message, the related-chat pool (untitled chats are not in it), then at most 64 + 64.
  assert.ok(inputs[0].length <= 1 + 64 + 64, String(inputs[0].length));
  assert.equal(inputs[0].filter((t) => t.startsWith('Project ')).length, 64);
  assert.ok(inputs[0].includes('popular'), 'the most used tag is kept');
  const tagRequest = seen.find((r) => r.purpose === 'chat.frame.tag');
  assert.equal(tagRequest.options[0].id, 'popular');
});

// #1775: a fake decision model that shares its CPU between concurrent requests (processor sharing),
// like Kev on 2 threads: each request needs `workMs` of the whole model alone; n at once each run at 1/n.
function sharedCpuBackend({ workMs = 450 } = {}) {
  const active = new Set();
  let last = Date.now(), timer = null;
  const advance = () => { const t = Date.now(), dt = t - last; last = t; for (const job of active) job.left -= dt / active.size; };
  const schedule = () => {
    clearTimeout(timer);
    for (const job of [...active]) if (job.left <= 0.5) { active.delete(job); job.done(); }
    if (!active.size) return;
    const next = Math.min(...[...active].map((j) => j.left)) * active.size;
    timer = setTimeout(() => { advance(); schedule(); }, Math.max(1, Math.ceil(next)));
  };
  const run = (signal) => new Promise((resolve, reject) => {
    advance();
    const job = { left: workMs, done: resolve };
    signal?.addEventListener('abort', () => { advance(); active.delete(job); schedule(); reject(Error('aborted')); }, { once: true });
    active.add(job); schedule();
  });
  const answers = { 'chat.frame.kind': 'question', 'chat.frame.project': 'p-garden', 'chat.frame.tag': 'plants', 'model.route': 'fast', 'tool.gate': 'none' };
  const finished = {};
  const backend = { id: 'kev', locality: 'local', supports: () => true,
    async decide(request, { signal } = {}) {
      await run(signal);
      finished[request.purpose] = Date.now();
      return { selected: answers[request.purpose], scores: { [answers[request.purpose]]: 0.9 }, confidence: 0.9 };
    } };
  const purposes = Object.keys(answers);
  return { finished, decisions: createDecisions({ log: (e) => process.env.DBG && console.log(JSON.stringify(e)), backends: { kev: backend }, chains: Object.fromEntries(purposes.map((p) => [p, ['kev']])) }) };
}

test('#1775 timing: framing frames within the deadline while the chat turn shares the decision model', async () => {
  // The 2026-10-15 turn: framing starts, the route decision arrives ~150 ms later, the tool gate after
  // the route. Embedding (its own server) takes ~300 ms. Deadline 2000 ms (decision timeoutMs).
  const { decisions, finished } = sharedCpuBackend({ workMs: 450 });
  const slowEmbed = async (texts) => { await new Promise((r) => setTimeout(r, 300)); return texts.map(vec); };
  const framing = createChatFraming({ enabled: () => true, decide: decisions.decide, embed: slowEmbed, deadlineMs: () => 2000 });
  const option = (id) => ({ id, label: id });
  const turn = (async () => {
    await new Promise((r) => setTimeout(r, 150));
    await decisions.decide({ kind: 'choice', purpose: 'model.route', question: 'q', options: ['fast', 'smart', 'code'].map(option), context: { cloud: 'forbidden' }, constraints: { deadlineMs: 2000 }, fallback: { selected: null, scores: {} } });
    await decisions.decide({ kind: 'choice', purpose: 'tool.gate', question: 'q', options: ['none', 'web'].map(option), context: { cloud: 'forbidden' }, constraints: { deadlineMs: 2000 }, fallback: { selected: null, scores: {} } });
  })();
  const t0 = Date.now();
  const out = await framing.suggest({ message: 'Why is my tomato plant wilting?', projects, chats });
  const ms = Date.now() - t0;
  await turn;
  assert.equal(out.reason, null, `framing fell back (${out.reason}) after ${ms} ms`);
  assert.equal(out.frame.kind, 'question');
  assert.ok(finished['chat.frame.kind'] - t0 < 1900, `kind answered in ${finished['chat.frame.kind'] - t0} ms`);
  assert.ok(ms <= 3000, `suggest took ${ms} ms`); // project/tag may use the rest of the budget; the kind is kept
});

test('#1775: a deadline during project/tag keeps the kind (and related chats)', async () => {
  const decide = async (r) => {
    if (r.purpose !== 'chat.frame.kind') await new Promise(() => {});
    return { source: 'stub', selected: 'idea', scores: {} };
  };
  const out = await make(decide, { deadlineMs: () => 150 }).suggest({ message: 'tomato garden', projects, chats, chatId: 'new' });
  assert.equal(out.reason, null);
  assert.deepEqual(out.frame, { projectId: null, kind: 'idea', tags: [], links: ['c1'], confirmed: false, source: 'suggested' });
});

test('#1778: a hung embedding does not hold a kind that already answered until the deadline', async () => {
  const { decide } = stubDecide({ 'chat.frame.kind': 'idea', 'chat.frame.project': 'p-garden' });
  const t0 = Date.now();
  const out = await make(decide, { embed: () => new Promise(() => {}), deadlineMs: () => 5000 }).suggest({ message: 'tomato garden', projects, chats });
  assert.equal(out.reason, null);
  assert.deepEqual(out.frame, { projectId: null, kind: 'idea', tags: [], links: [], confirmed: false, source: 'suggested' });
  assert.ok(Date.now() - t0 < 3000, `returned after ${Date.now() - t0} ms, well before the 5000 ms deadline`);
});

test('#1778: a project/tag decision that throws after the kind answered keeps the kind', async () => {
  const decide = async (r) => {
    if (r.purpose !== 'chat.frame.kind') throw Error('boom');
    return { source: 'stub', selected: 'idea', scores: {} };
  };
  const out = await make(decide, { deadlineMs: () => 2000 }).suggest({ message: 'tomato garden', projects, chats, chatId: 'new' });
  assert.equal(out.reason, null);
  assert.deepEqual(out.frame, { projectId: null, kind: 'idea', tags: [], links: ['c1'], confirmed: false, source: 'suggested' });
});

test('#1778: the kind-only early return aborts the hung embedding request', async () => {
  const { decide } = stubDecide({ 'chat.frame.kind': 'idea' });
  let embedSignal = null;
  const embed = (texts, { signal }) => { embedSignal = signal; return new Promise(() => {}); };
  const out = await make(decide, { embed, deadlineMs: () => 5000 }).suggest({ message: 'tomato garden', projects, chats });
  assert.equal(out.frame.kind, 'idea');
  assert.equal(embedSignal.aborted, true, 'the embedding request was told to stop');
});

test('#1778: a project/tag error that is not a deadline is logged once', async () => {
  const logged = [];
  const decide = async (r) => { if (r.purpose !== 'chat.frame.kind') throw Error('boom'); return { source: 'stub', selected: 'idea', scores: {} }; };
  await make(decide, { deadlineMs: () => 2000, log: (e) => logged.push(e) }).suggest({ message: 'tomato garden', projects, chats });
  assert.equal(logged.filter((e) => e.failed === 'project-tag').length, 1);
});
