'use strict';
// The files Node publishes for the Rust front (sbstndalton/noevia#2190 close-out): written atomically,
// mode 0600, versioned and dated; a failed build writes nothing; bursts coalesce; nothing overlaps.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { VERSION, DEMAND_FILE, DEMAND_WINDOW_MS, writeSnapshot, createDemand, createPublisher, intervalFrom } = require('./published-snapshot.cjs');

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

test('the state cannot overwrite the header (#2190 review L3)', () => {
  const file = path.join(dir, 'b.json');
  writeSnapshot(file, 'real', 5000, { version: 99, kind: 'forged', writtenAt: 1, everyMs: 1, extra: 'kept' }, 1800000000000);
  const doc = read(file);
  // The values are the publisher's, whatever the state names, and the header stays first in the file.
  assert.equal(doc.version, 1);
  assert.equal(doc.kind, 'real');
  assert.equal(doc.writtenAt, 1800000000000);
  assert.equal(doc.everyMs, 5000);
  assert.equal(doc.extra, 'kept');
  assert.deepEqual(Object.keys(doc).slice(0, 4), ['version', 'kind', 'writtenAt', 'everyMs']);
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

test('a build that never finishes is abandoned after two intervals and the next run renews the file (#2190 review L6)', async () => {
  const file = path.join(dir, 'h.json');
  const errors = [];
  let n = 0;
  const p = createPublisher({ file, kind: 'thing', everyMs: 1000, buildDeadlineMs: 60, onError: (e) => errors.push(e.message),
    build: () => { n += 1; return n === 1 ? new Promise(() => {}) : { n }; } });
  assert.equal(createPublisher({ file, kind: 'thing', everyMs: 7000, build: () => ({}) }).buildDeadlineMs, 14000, 'the default is two intervals');
  const started = Date.now();
  // The deadline timer does not keep a process alive (as in production, where something else does): this test holds one.
  const keepAlive = setTimeout(() => {}, 5000);
  await p.publish();
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started >= 55 && Date.now() - started < 1500, `${Date.now() - started} ms`);
  assert.equal(fs.existsSync(file), false, 'nothing was written');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /did not finish within 60 ms/);
  await p.publish();
  assert.equal(read(file).n, 2, 'a stuck build does not stop the file from being renewed');
});

// ── demand-driven publishing (#2190 review M1) ──────────────────────────────────

function demandFixture(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-demand-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const marker = path.join(d, DEMAND_FILE);
  const touch = (agoMs = 0) => { fs.writeFileSync(marker, String(Date.now()), { mode: 0o600 }); const t = new Date(Date.now() - agoMs); fs.utimesSync(marker, t, t); };
  const demand = createDemand({ dir: d, windowMs: 400, pollMs: 30, ...extra });
  return { d, marker, touch, demand };
}

test('the demand marker is live only while it is a plain file under the window old, and not from the future', async () => {
  const { d, marker, touch, demand } = demandFixture();
  assert.equal(DEMAND_FILE, 'snapshot-demand');
  assert.equal(DEMAND_WINDOW_MS, 60000);
  assert.equal(demand.active(), false, 'missing');
  touch(0);
  assert.equal(demand.active(), true);
  touch(399 - 100);
  assert.equal(demand.active(), true);
  touch(450);
  assert.equal(demand.active(), false, 'older than the window');
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(marker, future, future);
  assert.equal(demand.active(), false, 'dated far ahead of the clock');
  fs.rmSync(marker);
  fs.mkdirSync(marker);
  assert.equal(demand.active(), false, 'a directory is not a marker');
  fs.rmdirSync(marker);
  fs.writeFileSync(path.join(d, 'elsewhere'), 'x');
  fs.symlinkSync(path.join(d, 'elsewhere'), marker);
  assert.equal(demand.active(), false, 'a symlink is not a marker');
});

test('with no demand the publisher writes nothing and runs no timer; a touched marker wakes it at once and an old one stops it', async () => {
  const { d, touch, demand } = demandFixture();
  const file = path.join(d, 'snap.json');
  let runs = 0;
  const p = createPublisher({ file, kind: 'thing', everyMs: 40, demand, build: () => ({ runs: ++runs }) });
  p.start();
  demand.start();
  await wait(200);
  assert.equal(runs, 0, 'idle: the build (the embedder probe) is never run');
  assert.equal(fs.existsSync(file), false);
  p.changed();
  await wait(150);
  assert.equal(runs, 0, 'a change while nobody asks republishes nothing');
  // Someone asks: the first publish does not wait for the timer.
  touch(0);
  await wait(250);
  assert.ok(runs >= 1, `${runs} runs after the marker appeared`);
  assert.ok(fs.existsSync(file));
  // It keeps going while the marker is renewed...
  touch(0);
  await wait(100);
  touch(0);
  const during = runs;
  await wait(100);
  assert.ok(runs > during, 'still publishing');
  // ...and stops once the marker is a window old.
  await wait(700);
  const stopped = runs;
  await wait(250);
  assert.equal(runs, stopped, 'idle again: no more builds');
  p.changed();
  await wait(150);
  assert.equal(runs, stopped);
  // Asked again after the idle spell: back at once.
  touch(0);
  await wait(250);
  assert.ok(runs > stopped);
  p.stop();
  demand.stop();
  const end = runs;
  touch(0);
  await wait(150);
  assert.equal(runs, end, 'stopped publishers stay stopped');
});

test('a publisher started after the marker is already live publishes at once, and without a demand source it always runs', async () => {
  const { d, touch, demand } = demandFixture();
  touch(0);
  let runs = 0;
  const p = createPublisher({ file: path.join(d, 'a.json'), kind: 'thing', everyMs: 1000, demand, build: () => ({ runs: ++runs }) });
  p.start();
  await wait(60);
  assert.equal(runs, 1);
  p.stop();
  let plain = 0;
  const q = createPublisher({ file: path.join(d, 'b.json'), kind: 'thing', everyMs: 1000, build: () => ({ plain: ++plain }) });
  q.start();
  await wait(60);
  assert.equal(plain, 1, 'no demand source: as before');
  q.stop();
});

test('the poll alone wakes a publisher when file watching is unavailable', async () => {
  const realWatch = fs.watch;
  fs.watch = () => { throw new Error('no inotify here'); };
  try {
    const { d, touch, demand } = demandFixture();
    let runs = 0;
    const p = createPublisher({ file: path.join(d, 'c.json'), kind: 'thing', everyMs: 1000, demand, build: () => ({ runs: ++runs }) });
    p.start();
    demand.start();
    await wait(80);
    assert.equal(runs, 0);
    touch(0);
    await wait(150);
    assert.equal(runs, 1);
    p.stop();
    demand.stop();
  } finally { fs.watch = realWatch; }
});

test('the demand timers and the watcher never keep the process alive', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { createDemand, createPublisher } = require(${JSON.stringify(path.join(__dirname, 'published-snapshot.cjs'))});
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-unref-'));
    fs.writeFileSync(path.join(d, 'snapshot-demand'), '1');
    const demand = createDemand({ dir: d });
    const p = createPublisher({ file: path.join(d, 's.json'), kind: 'k', everyMs: 1000, demand, build: () => ({}) });
    p.start(); demand.start(); p.changed();
    process.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 8000 });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(r.signal, null, 'the process ended by itself');
});

test('the process wires one demand source into both publishers and starts it with them (index.cjs)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(source, /createDemand\(\{ dir: DATA_DIR/);
  assert.match(source, /createRagStatusPublisher\(\{ dataDir: DATA_DIR, rag, demand \}\)/);
  assert.match(source, /machineModels: \(\) => chatMachines\.machineModels\(\), demand,/);
  assert.match(source, /ragStatus\.start\(\); autoRolesSnapshot\.start\(\); demand\.start\(\);/);
});
