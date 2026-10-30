'use strict';
// The files Node publishes for the Rust front (sbstndalton/noevia#2190 close-out): written atomically,
// mode 0600, versioned and dated; a failed build writes nothing; bursts coalesce; nothing overlaps.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { VERSION, writeSnapshot, createPublisher, intervalFrom } = require('./published-snapshot.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-published-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const leftovers = () => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a snapshot is versioned, kinded, dated and carries the interval and the state', () => {
  const file = path.join(dir, 'a.json');
  writeSnapshot(file, 'thing', 10000, { x: 1, nested: { y: [true] } }, 1800000000123);
  assert.deepEqual(read(file), { version: VERSION, kind: 'thing', writtenAt: 1800000000123, everyMs: 10000, x: 1, nested: { y: [true] } });
  assert.equal(VERSION, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(leftovers(), []);
  // Replaced, not appended.
  writeSnapshot(file, 'thing', 10000, { x: 2 }, 1800000000999);
  assert.equal(read(file).x, 2);
  assert.equal(read(file).writtenAt, 1800000000999);
});

test('the state cannot overwrite the header', () => {
  const file = path.join(dir, 'b.json');
  writeSnapshot(file, 'real', 5000, { version: 99, kind: 'forged', writtenAt: 1, everyMs: 1 }, 1800000000000);
  // Header fields come first and the state spreads after them; the publisher's states never name them,
  // and a reader checks all four. This pins the order the file has.
  const keys = Object.keys(read(file));
  assert.deepEqual(keys.slice(0, 4), ['version', 'kind', 'writtenAt', 'everyMs']);
});

test('a write that cannot complete leaves the old file and no temporary file', () => {
  const file = path.join(dir, 'c.json');
  writeSnapshot(file, 'thing', 1000, { x: 'old' }, 1800000000000);
  assert.throws(() => writeSnapshot(file, 'thing', 1000, { big: 1n }, 1800000000001), TypeError);
  assert.equal(read(file).x, 'old');
  assert.throws(() => writeSnapshot(path.join(dir, 'no-such-dir', 'd.json'), 'thing', 1000, {}, 1));
  assert.deepEqual(leftovers(), []);
});

test('a failing build writes nothing and the file keeps its age (so the front reads it as stale)', async () => {
  const file = path.join(dir, 'd.json');
  const errors = [];
  let n = 0;
  const p = createPublisher({ file, kind: 'thing', everyMs: 1000, now: () => 1800000000000 + n, onError: (e) => errors.push(e.message),
    build: () => { n += 1; if (n === 2) throw new Error('probe broke'); return { n }; } });
  await p.publish();
  assert.equal(read(file).n, 1);
  await p.publish();
  assert.equal(read(file).n, 1, 'the failed build wrote nothing');
  assert.deepEqual(errors, ['probe broke']);
  await p.publish();
  assert.equal(read(file).n, 3);
});

test('builds never overlap and a change during one is served by one more run right after', async () => {
  const file = path.join(dir, 'e.json');
  let running = 0, maxRunning = 0, runs = 0;
  const p = createPublisher({ file, kind: 'thing', everyMs: 1000,
    build: async () => { runs += 1; running += 1; maxRunning = Math.max(maxRunning, running); await wait(40); running -= 1; return { runs }; } });
  const a = p.publish();
  const b = p.publish();
  const c = p.publish();
  await Promise.all([a, b, c]);
  assert.equal(maxRunning, 1);
  assert.equal(runs, 2, 'three requests during one run are one more run');
  assert.equal(read(file).runs, 2);
});

test('changed() coalesces a burst into one publish, and stop() cancels the pending one', async () => {
  const file = path.join(dir, 'f.json');
  let runs = 0;
  const p = createPublisher({ file, kind: 'thing', everyMs: 60000, build: () => ({ runs: ++runs }) });
  for (let i = 0; i < 10; i += 1) p.changed();
  await wait(200);
  assert.equal(runs, 1);
  p.changed();
  p.stop();
  await wait(150);
  assert.equal(runs, 1);
});

test('start() publishes at once and then on the timer, and stop() ends it', async () => {
  const file = path.join(dir, 'g.json');
  let runs = 0;
  const p = createPublisher({ file, kind: 'thing', everyMs: 30, build: () => ({ runs: ++runs }) });
  p.start();
  p.start();
  await wait(20);
  assert.ok(fs.existsSync(file), 'the first publish does not wait for the timer');
  await wait(150);
  p.stop();
  const seen = runs;
  assert.ok(seen >= 3, `${seen} runs`);
  await wait(100);
  assert.equal(runs, seen);
});

test('the interval setting is an integer in range, else the default', () => {
  assert.equal(intervalFrom('15000', 10000), 15000);
  for (const bad of [undefined, '', 'abc', '999', '300001', '-5', '1e3x', null]) assert.equal(intervalFrom(bad, 10000), 10000, String(bad));
  assert.equal(intervalFrom('1000', 5), 1000);
  assert.equal(intervalFrom('300000', 5), 300000);
});
