const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const r = require('./chat-retention.cjs');
const DAY = 86400000, NOW = Date.UTC(2026, 8, 17);

test('settings default to off, accept only the offered periods, and survive damage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  try {
    assert.deepEqual(r.read(dir), { days: 0, lastSweep: 0 });
    assert.deepEqual(r.write(dir, 90), { days: 90, lastSweep: 0 });
    assert.throws(() => r.write(dir, 7), /30, 90 or 365/);
    r.markSwept(dir, NOW);
    assert.deepEqual(r.read(dir), { days: 90, lastSweep: NOW });
    assert.equal(r.write(dir, 0).days, 0);
    fs.writeFileSync(path.join(dir, 'chat-retention.json'), 'nope');
    assert.deepEqual(r.read(dir), { days: 0, lastSweep: 0 }, 'damage means off, never delete');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('expired: older than the period, never pinned, never undated, across free and project chats', () => {
  const freeChats = [
    { id: 'old', updatedAt: NOW - 100 * DAY },
    { id: 'old-pinned', updatedAt: NOW - 400 * DAY, pinned: true },
    { id: 'recent', updatedAt: NOW - 10 * DAY },
    { id: 'undated' },
    { id: 'edge', updatedAt: NOW - 90 * DAY },
  ];
  const projects = [{ id: 'p1', chats: [{ id: 'p-old', updatedAt: NOW - 91 * DAY, archived: true }, { id: 'p-new', updatedAt: NOW - DAY }] }];
  assert.deepEqual(r.expired({ freeChats, projects, days: 90, now: NOW }), [{ projectId: null, id: 'old' }, { projectId: 'p1', id: 'p-old' }]);
  assert.deepEqual(r.expired({ freeChats, projects, days: 0, now: NOW }), []);
});

test('a sweep is due at most hourly and only when on', () => {
  assert.equal(r.sweepDue({ days: 0, lastSweep: 0 }, NOW), false);
  assert.equal(r.sweepDue({ days: 30, lastSweep: 0 }, NOW), true);
  assert.equal(r.sweepDue({ days: 30, lastSweep: NOW - 59 * 60000 }, NOW), false);
  assert.equal(r.sweepDue({ days: 30, lastSweep: NOW - 61 * 60000 }, NOW), true);
});
