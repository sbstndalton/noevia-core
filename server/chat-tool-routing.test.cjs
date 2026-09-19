const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatToolRouter } = require('./chat-tool-routing.cjs');

// Tiny deterministic "embedding": one axis per keyword.
const AXES = ['file', 'calendar', 'wiki', 'diary'];
const vec = (text) => AXES.map((k) => (String(text).toLowerCase().includes(k) ? 1 : 0)).concat([0.01]);
const boxes = [
  { id: 'nextcloud-files', label: 'Files', description: 'List and read file contents', tools: [{ function: { name: 'nc_list', description: 'list file' } }] },
  { id: 'calendar', label: 'Calendar', description: 'Calendar events', tools: [{ function: { name: 'cal_list', description: 'calendar events' } }] },
  { id: 'offline-wikipedia', label: 'Wikipedia', description: 'Search the offline wiki', tools: [{ function: { name: 'wiki_search', description: 'wiki search' } }] },
];
const make = (over = {}) => {
  const calls = [];
  const router = createChatToolRouter({ enabled: () => true, boxes: () => boxes, embed: async (texts) => { calls.push(texts.length); return texts.map(vec); }, ...over });
  return { router, calls };
};

test('narrows a multi-box selection to the boxes that match the message', async () => {
  const { router } = make();
  const out = await router.select(['nextcloud-files', 'calendar', 'offline-wikipedia'], 'Search the wiki for Alan Turing');
  assert.deepEqual(out.ids, ['offline-wikipedia']);
  assert.equal(out.routed, true);
});

test('never adds a box the project did not select', async () => {
  const { router } = make();
  const out = await router.select(['nextcloud-files', 'calendar'], 'Search the wiki');
  assert.ok(out.ids.every((id) => ['nextcloud-files', 'calendar'].includes(id)));
});

test('fails open to the whole selection when nothing matches, embeddings fail, or the flag is off', async () => {
  assert.deepEqual((await make().router.select(['nextcloud-files', 'calendar'], 'hello there')).ids, ['nextcloud-files', 'calendar']);
  const broken = make({ embed: async () => { throw Error('embeddings 503'); } }).router;
  const out = await broken.select(['nextcloud-files', 'calendar'], 'open the file');
  assert.deepEqual(out.ids, ['nextcloud-files', 'calendar']);
  assert.equal(out.routed, false);
  assert.deepEqual((await make({ enabled: () => false }).router.select(['nextcloud-files', 'calendar'], 'open the file')).ids, ['nextcloud-files', 'calendar']);
});

test('one or zero selected boxes skip the embedding call entirely', async () => {
  const { router, calls } = make();
  assert.deepEqual((await router.select(['calendar'], 'calendar please')).ids, ['calendar']);
  assert.deepEqual((await router.select([], 'x')).ids, []);
  assert.deepEqual(calls, []);
});

test('box embeddings are cached; later turns embed only the message', async () => {
  const { router, calls } = make();
  await router.select(['nextcloud-files', 'calendar'], 'file one');
  await router.select(['nextcloud-files', 'calendar'], 'file two');
  assert.deepEqual(calls, [2, 1, 1]);
});

test('unknown selected ids are ignored, not fatal', async () => {
  const { router } = make();
  const out = await router.select(['gone-box', 'calendar', 'nextcloud-files'], 'my calendar');
  assert.deepEqual(out.ids, ['calendar']);
});

test('routed ids come back best match first, so the token budget keeps the best box', async () => {
  // Occurrence-count embedding: "file" twice beats "calendar" once; both clear the threshold.
  const counts = (text) => AXES.map((k) => (String(text).toLowerCase().match(new RegExp(k, 'g')) || []).length).concat([0.01]);
  const { router } = make({ embed: async (texts) => texts.map(counts) });
  const out = await router.select(['calendar', 'nextcloud-files'], 'file file, and the calendar');
  assert.equal(out.routed, true);
  assert.deepEqual(out.ids, ['nextcloud-files', 'calendar']);
});

test('narrowed is true only when some selected toolbox was left out', async () => {
  const { createChatToolRouter } = require('./chat-tool-routing.cjs');
  const boxes = [{ id: 'a', label: 'Alpha', tools: [{ function: { name: 'a1' } }] }, { id: 'b', label: 'Beta', tools: [{ function: { name: 'b1' } }] }];
  const vec = (t) => (/alpha/i.test(t) ? [1, 0] : /beta/i.test(t) ? [0, 1] : [0.7, 0.7]);
  const router = createChatToolRouter({ enabled: () => true, boxes: () => boxes, embed: async (texts) => texts.map(vec), threshold: 0.5 });
  const one = await router.select(['a', 'b'], 'alpha please');
  assert.deepEqual([one.ids, one.narrowed], [['a'], true]);
  const both = await router.select(['a', 'b'], 'something general');
  assert.equal(both.narrowed, false);
});
