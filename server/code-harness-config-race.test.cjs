// The tree a configuration is pinned into belongs to the harness user, and a process of that user
// may change it while noevia (root) writes (#2527). Synthetic key and paths only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { writeHarnessConfig } = require('./code-harness-config.cjs');

const base = { harness: 'claude-code', model: 'QA-model', engine: 'http://engine.invalid/v1', apiKey: 'synthetic-key' };
function dirs(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-qa-pin-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-qa-pin-outside-'));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  // The repository already has the directory, so the harness owns it like the rest of the tree.
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(outside, 'settings.local.json'), 'untouched');
  const home = path.join(cwd, '.home'); fs.mkdirSync(home);
  return { cwd, outside, home };
}
const swap = ({ cwd, outside }) => {
  fs.renameSync(path.join(cwd, '.claude'), path.join(cwd, '.claude.moved'));
  fs.symlinkSync(outside, path.join(cwd, '.claude'));
};

test('#2527: a directory swapped for a link between the check and the open is refused, and nothing lands outside', (t) => {
  const d = dirs(t);
  const lstat = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, 'lstatSync', (p, ...rest) => {
    const st = lstat(p, ...rest);
    if (!swapped && String(p).endsWith('/.claude')) { swapped = true; swap(d); }
    return st;
  });
  assert.throws(() => writeHarnessConfig({ ...base, cwd: d.cwd, home: d.home }), (e) => e.status === 409 && /\.claude it was replaced/.test(e.message));
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(d.outside, 'settings.local.json'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(d.outside), ['settings.local.json']);
});

test('#2527: a directory swapped after it was opened still receives the file, never the link target', (t) => {
  const d = dirs(t);
  fs.writeFileSync(path.join(d.cwd, '.claude', 'settings.local.json'), '{"old":true}');
  const unlink = fs.unlinkSync;
  let swapped = false;
  // After the directory was checked and opened, between the check of the old file and its removal.
  t.mock.method(fs, 'unlinkSync', (p, ...rest) => {
    if (!swapped && String(p).endsWith('/settings.local.json')) { swapped = true; swap(d); }
    return unlink(p, ...rest);
  });
  writeHarnessConfig({ ...base, cwd: d.cwd, home: d.home });
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(d.outside, 'settings.local.json'), 'utf8'), 'untouched', 'the file behind the link was replaced');
  const written = JSON.parse(fs.readFileSync(path.join(d.cwd, '.claude.moved', 'settings.local.json'), 'utf8'));
  assert.equal(written.env.ANTHROPIC_API_KEY, 'synthetic-key');
});

test('#2527: a directory noevia makes is handed over only after the file is in it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-qa-pin-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'tree'), home = path.join(root, 'home'); fs.mkdirSync(cwd); fs.mkdirSync(home);
  const order = [];
  t.mock.method(fs, 'fchownSync', (fd) => { order.push(path.relative(root, fs.readlinkSync(`/proc/self/fd/${fd}`))); });
  writeHarnessConfig({ ...base, harness: 'pi', cwd, home, owner: { uid: 1000, gid: 1000 } });
  // Every pinned file before the directories noevia made for it, innermost directory first.
  assert.deepEqual(order, ['home/.pi/agent/models.json', 'home/.pi/agent', 'home/.pi', 'home/.pi/agent/settings.json',
    'home/.pi/agent/extensions/noevia-gate.js', 'home/.pi/agent/extensions']);
});
