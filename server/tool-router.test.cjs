const test = require('node:test'), assert = require('node:assert/strict');
const { route } = require('./tool-router.cjs');

const boxes = [
  { id: 'web-search', tools: ['tavily_search', 'tavily_extract'], embedding: [1, 0, 0] },
  { id: 'web-crawl', tools: ['tavily_crawl'], embedding: [0.9, 0.1, 0], autoLoad: 'never' },
  { id: 'calendar', tools: ['cal_list', 'cal_create'], embedding: [0, 1, 0], requires: ['contacts'] },
  { id: 'contacts', tools: ['contacts_find'], embedding: [0, 0.2, 1] },
  { id: 'files', tools: ['files_read', 'files_write', 'files_list'], embedding: [0, 0.95, 0.1] },
  { id: 'files-mirror', tools: ['files_read'], embedding: [0.05, 0.9, 0.1] },
  { id: 'admin-only', tools: ['admin_x'], embedding: [1, 0, 0] },
];
const offered = (id) => id !== 'admin-only';
const base = { boxes, offered, maxTools: 20, threshold: 0.3 };

test('routes to the best matches above threshold within the deployment ceiling', () => {
  const r = route({ ...base, taskEmbedding: [1, 0, 0], topK: 3 });
  assert.equal(r.routed, true);
  assert.ok(r.boxes.includes('web-search'));
  assert.ok(!r.boxes.includes('admin-only'), 'not offered by this deployment');
  assert.ok(!r.boxes.includes('web-crawl'), 'autoLoad never');
  assert.match(r.reasons['web-search'], /matched this task/);
});

test('requires is resolved transitively and missing dependencies load nothing', () => {
  const r = route({ ...base, taskEmbedding: [0, 1, 0], topK: 1 });
  assert.deepEqual(r.boxes.sort(), ['calendar', 'contacts']);
  assert.equal(r.reasons.contacts, 'required by calendar');
  const broken = route({ ...base, boxes: boxes.map((b) => b.id === 'contacts' ? { ...b, autoLoad: 'never' } : b), taskEmbedding: [0, 1, 0], topK: 1 });
  assert.deepEqual(broken.boxes, []);
  assert.equal(broken.skipped[0].reason, 'a required toolbox is unavailable');
});

test('a closure that would break the tool cap loads nothing extra, never part of a box', () => {
  const r = route({ ...base, taskEmbedding: [0, 1, 0], topK: 1, maxTools: 2 });
  assert.deepEqual(r.boxes, []);
  assert.equal(r.skipped[0].reason, 'would exceed the tool cap');
});

test('two boxes exposing the same tool name are never loaded together; the higher score wins', () => {
  const r = route({ ...base, boxes: boxes.filter((b) => !['calendar', 'contacts'].includes(b.id)), taskEmbedding: [0, 1, 0.1], topK: 3 });
  assert.ok(r.boxes.includes('files'));
  assert.ok(!r.boxes.includes('files-mirror'));
  assert.equal(r.skipped.find((s) => s.id === 'files-mirror').reason, 'duplicates a loaded tool name');
});

test("the user's own selection is always kept and wins over routing", () => {
  const r = route({ ...base, taskEmbedding: [1, 0, 0], userSelection: ['files', 'admin-only'] });
  assert.ok(r.boxes.includes('files'));
  assert.equal(r.reasons.files, 'selected by you');
  assert.ok(!r.boxes.includes('admin-only'), 'a user selection still cannot exceed the deployment ceiling');
});

test('without embeddings the router falls back to the project selection', () => {
  const r = route({ ...base, taskEmbedding: null, fallback: ['web-search', 'admin-only'] });
  assert.equal(r.routed, false);
  assert.deepEqual(r.boxes, ['web-search']);
  assert.match(r.reasons['web-search'], /router unavailable/);
});

test('nothing above threshold loads nothing', () => {
  assert.deepEqual(route({ ...base, taskEmbedding: [-1, -1, -1] }).boxes, []);
});
