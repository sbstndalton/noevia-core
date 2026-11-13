// A clone the harness held is hostile input (#2528), and its tree may change under noevia while
// noevia walks it (#2529). Synthetic repositories only; every planted command touches a marker
// file, and the marker must never appear.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeWorkspaces, defaultChown, removeTree } = require('./code-workspace.cjs');

const temps = [];
const temp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const sub = (args) => { let i = 0; while (args[i] === '-c') i += 2; return args[i]; };
const ID = '00000000-0000-4000-8000-000000000001';
const quiet = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const realGit = (args, cwd, env = {}) => execFileSync('git', args, { cwd, env: { ...process.env, ...quiet, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repoWith(files = { 'a.txt': 'a' }) {
  const repo = temp('noevia-qa-repo-');
  const git = (...args) => realGit(args, repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'qa@example.invalid');
  git('config', 'user.name', 'QA');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), body);
  git('add', '.');
  git('commit', '-qm', 'first');
  return repo;
}
// A marker the planted command would create, and a script that creates it.
function planted() {
  const dir = temp('noevia-qa-marker-');
  const marker = path.join(dir, 'ran');
  const script = path.join(dir, 'planted.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  return { marker, script };
}
function clone(extra = {}) {
  const repo = repoWith();
  const ws = createCodeWorkspaces({ dir: temp('noevia-qa-ws-'), treeRoot: temp('noevia-qa-shared-'), mode: 'clone', epoch: 'test', ...extra });
  const claim = ws.claim({ taskId: ID, repoPath: repo });
  const git = (...args) => realGit(args, claim.path);
  return { repo, ws, claim, git };
}

// ── #2528 ────────────────────────────────────────────────────────────────────────────────────

test('#2528: a clone that signs its commits with a planted program is refused, and the program never runs', () => {
  const { ws, claim, git } = clone();
  const { marker, script } = planted();
  git('config', 'commit.gpgsign', 'true');
  git('config', 'gpg.program', script);
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'changed, so release would commit');
  const released = ws.release({ taskId: ID });
  assert.equal(fs.existsSync(marker), false, 'the signing program ran as noevia');
  assert.equal(released.status, 'stuck');
  assert.match(released.error, /Refused to release.*(commit\.gpgsign|gpg\.program)/);
});

test('#2528: signing planted after the check still never runs: noevia commits with signing off', () => {
  const { marker, script } = planted();
  let tree = null;
  const { repo, ws, claim } = clone({
    run: (args, cwd, env = {}) => {
      if (sub(args) === 'commit' && tree) {
        realGit(['config', 'commit.gpgsign', 'true'], tree);
        realGit(['config', 'gpg.program', script], tree);
      }
      return realGit(args, cwd, env);
    },
  });
  tree = claim.path;
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'work');
  const released = ws.release({ taskId: ID });
  assert.equal(fs.existsSync(marker), false, 'the signing program ran');
  assert.equal(released.status, 'released', released.error);
  assert.equal(realGit(['show', `${claim.branch}:a.txt`], repo), 'work');
});

test('#2528: a per-worktree config with a clean filter is refused, and the filter never runs', () => {
  const { ws, claim, git } = clone();
  const { marker, script } = planted();
  git('config', 'core.repositoryformatversion', '1');
  git('config', 'extensions.worktreeConfig', 'true');
  fs.writeFileSync(path.join(claim.path, '.git', 'config.worktree'), `[filter "x"]\n\tclean = ${script}\n`);
  // The attributes sit where the old walk could not see them: under a name that is not UTF-8.
  const hidden = Buffer.concat([Buffer.from(claim.path + '/'), Buffer.from([0x71, 0x61, 0xff, 0xfe])]);
  fs.mkdirSync(hidden);
  fs.writeFileSync(Buffer.concat([hidden, Buffer.from('/.gitattributes')]), '* filter=x\n');
  fs.writeFileSync(Buffer.concat([hidden, Buffer.from('/b.txt')]), 'b');
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'changed');
  const released = ws.release({ taskId: ID });
  assert.equal(fs.existsSync(marker), false, 'the per-worktree clean filter ran as noevia');
  assert.equal(released.status, 'stuck');
  assert.match(released.error, /Refused to release/);
});

test('#2528: .git/config.worktree or .git/commondir alone is refused', () => {
  for (const name of ['config.worktree', 'commondir']) {
    const { ws, claim } = clone();
    fs.writeFileSync(path.join(claim.path, '.git', name), name === 'commondir' ? '../elsewhere\n' : '');
    const released = ws.release({ taskId: ID });
    assert.equal(released.status, 'stuck', name);
    assert.match(released.error, new RegExp(`\\.git/${name.replace('.', '\\.')}`), name);
  }
});

test('#2528: a .gitattributes under a directory whose name is not UTF-8 is still seen', () => {
  const { ws, claim } = clone();
  const hidden = Buffer.concat([Buffer.from(claim.path + '/'), Buffer.from([0x71, 0xff])]);
  fs.mkdirSync(hidden);
  fs.writeFileSync(Buffer.concat([hidden, Buffer.from('/.gitattributes')]), '*.txt filter=x\n');
  const released = ws.release({ taskId: ID });
  assert.equal(released.status, 'stuck');
  assert.match(released.error, /\.gitattributes names a filter driver/);
});

test('#2528: a nested repository is refused, and its own filter never runs on `git add`', () => {
  const { ws, claim, git } = clone();
  const { marker, script } = planted();
  const inner = path.join(claim.path, 'inner');
  fs.mkdirSync(inner);
  const igit = (...args) => realGit(args, inner);
  igit('init', '-q'); igit('config', 'user.email', 'qa@example.invalid'); igit('config', 'user.name', 'QA');
  fs.writeFileSync(path.join(inner, 's.txt'), 's'); igit('add', '.'); igit('commit', '-qm', 's');
  igit('config', 'filter.x.clean', script);
  fs.mkdirSync(path.join(inner, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(inner, '.git', 'info', 'attributes'), '* filter=x\n');
  git('add', 'inner'); git('-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'gitlink');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(inner, 's.txt'), later, later);
  const released = ws.release({ taskId: ID });
  assert.equal(fs.existsSync(marker), false, 'the nested repository’s filter ran as noevia');
  assert.equal(released.status, 'stuck');
  assert.match(released.error, /inner\/\.git is a nested repository/);
});

test('#2528: a tree too deep to check is refused rather than half-checked', () => {
  const { ws, claim } = clone();
  let dir = claim.path;
  for (let i = 0; i < 70; i++) { dir = path.join(dir, 'd'); fs.mkdirSync(dir); }
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
  const released = ws.release({ taskId: ID });
  assert.equal(released.status, 'stuck');
  assert.match(released.error, /nested too deeply to check/);
});

// One per newly refused family: each names a program, more configuration or another repository.
for (const [key, value] of [
  ['gpg.program', 'sh'], ['gpg.ssh.program', 'sh'], ['gpg.x509.program', 'sh'], ['gpg.format', 'ssh'],
  ['gpg.ssh.defaultKeyCommand', 'sh'], ['commit.gpgSign', 'true'], ['tag.gpgSign', 'true'], ['push.gpgSign', 'true'],
  ['tag.forceSignAnnotated', 'true'], ['extensions.worktreeConfig', 'true'],
  ['core.alternateRefsCommand', 'sh'], ['core.fsmonitorHookVersion', '2'], ['fsmonitor.socketDir', '/tmp'],
  ['sequence.editor', 'sh'], ['diff.external', 'sh'], ['diff.tool', 'x'], ['difftool.x.cmd', 'sh'],
  ['merge.tool', 'x'], ['mergetool.x.cmd', 'sh'], ['guitool.x.cmd', 'sh'], ['interactive.diffFilter', 'sh'],
  ['pager.status', 'sh'], ['browser.x.cmd', 'sh'], ['man.x.cmd', 'sh'], ['web.browser', 'x'], ['instaweb.browser', 'x'],
  ['gitcvs.dbDriver', 'x'], ['trailer.x.command', 'sh'], ['maintenance.gc.enabled', 'true'], ['submodule.x.update', '!sh'],
  ['url.ext::sh.insteadOf', '/'], ['protocol.ext.allow', 'always'], ['gc.recentObjectsHook', 'sh'], ['gc.repackFilterTo', '/tmp/x'],
  ['remote.origin.uploadpack', 'sh'], ['remote.origin.receivepack', 'sh'], ['remote.origin.proxy', 'http://x.invalid'],
  ['remote.origin.vcs', 'x'],
]) {
  test(`#2528: a clone whose config sets ${key} is refused`, () => {
    const { ws, claim } = clone();
    // Written with `--file`, as git itself refuses some of these in a v0 repository.
    realGit(['config', '--file', path.join(claim.path, '.git', 'config'), key, value], claim.path);
    const released = ws.release({ taskId: ID });
    assert.equal(released.status, 'stuck');
    assert.match(released.error, new RegExp(`\\.git/config sets .*${key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
}

test('#2528: a config the harness rewrites through a descriptor it kept open is not what git reads', () => {
  // The harness opened .git/config and a harmless .gitattributes for writing while it owned the
  // tree, and keeps both descriptors past the take-back and the check.
  const { marker, script } = planted();
  const self = { uid: process.getuid(), gid: process.getgid() };
  let held = null;
  const { repo, ws, claim } = clone({
    owner: self, chown: defaultChown,
    run: (args, cwd, env = {}) => {
      if (sub(args) === 'status' && held) {
        fs.writeSync(held.config, `[filter "x"]\n\tclean = ${script}\n`);
        fs.writeSync(held.attributes, '* filter=x\n');
        fs.closeSync(held.config); fs.closeSync(held.attributes); held = null;
      }
      return realGit(args, cwd, env);
    },
  });
  fs.writeFileSync(path.join(claim.path, '.gitattributes'), '*.txt text\n');
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'work');
  held = { config: fs.openSync(path.join(claim.path, '.git', 'config'), 'a'),
    attributes: fs.openSync(path.join(claim.path, '.gitattributes'), 'a') };
  const released = ws.release({ taskId: ID });
  assert.equal(fs.existsSync(marker), false, 'a filter written after the check ran as noevia');
  assert.equal(released.status, 'released', released.error);
  assert.equal(realGit(['show', `${claim.branch}:a.txt`], repo), 'work');
});

// ── #2529 ────────────────────────────────────────────────────────────────────────────────────

test('#2529: a link to a directory whose name is not UTF-8 is outside, and so is anything under it', () => {
  const repo = repoWith();
  const ws = createCodeWorkspaces({ dir: temp('noevia-qa-ws-'), epoch: 'test' });
  const claim = ws.claim({ taskId: ID, repoPath: repo });
  const outside = Buffer.concat([Buffer.from(temp('noevia-qa-outside-') + '/'), Buffer.from([0x6f, 0xff, 0xfe])]);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(claim.path, 'link'));
  assert.equal(ws.contains(ID, path.join(claim.path, 'link')), false);
  assert.equal(ws.contains(ID, path.join(claim.path, 'link', 'new.txt')), false);
  assert.equal(ws.contains(ID, 'link/new.txt'), false);
  // A plain new file beside it is still inside.
  assert.equal(ws.contains(ID, path.join(claim.path, 'new.txt')), true);
});

// Swap `name` (a directory) for a link to `outside` the first time the walk looks at it.
function swapOnLook(t, dirOf, name, outside) {
  const lstat = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, 'lstatSync', (p, ...rest) => {
    const st = lstat(p, ...rest);
    if (!swapped && String(p).endsWith('/' + name) && st.isDirectory()) {
      swapped = true;
      fs.renameSync(path.join(dirOf, name), path.join(dirOf, name + '.moved'));
      fs.symlinkSync(outside, path.join(dirOf, name));
    }
    return st;
  });
  return () => swapped;
}
// Every inode a chown landed on.
function watchChowns(t) {
  const touched = new Set();
  const lstat = fs.lstatSync, fstat = fs.fstatSync;
  const lchown = fs.lchownSync, fchown = fs.fchownSync;
  t.mock.method(fs, 'lchownSync', (p, ...rest) => { touched.add(lstat(p).ino); return lchown(p, ...rest); });
  t.mock.method(fs, 'fchownSync', (fd, ...rest) => { touched.add(fstat(fd).ino); return fchown(fd, ...rest); });
  return touched;
}

test('#2529: the chown walk refuses a directory swapped for a link between the look and the open', (t) => {
  const tree = temp('noevia-qa-tree-'), outside = temp('noevia-qa-outside-');
  fs.mkdirSync(path.join(tree, 'src'));
  fs.writeFileSync(path.join(tree, 'src', 'a.txt'), 'a');
  fs.writeFileSync(path.join(outside, 'victim'), 'v');
  const victim = fs.lstatSync(path.join(outside, 'victim')).ino;
  const touched = watchChowns(t);
  const swapped = swapOnLook(t, tree, 'src', outside);
  assert.throws(() => defaultChown(tree, process.getuid(), process.getgid()), /src: it was replaced/);
  assert.equal(swapped(), true, 'the swap happened');
  assert.equal(touched.has(victim), false, 'a file behind the link was chowned');
  assert.equal(touched.has(fs.lstatSync(outside).ino), false, 'the link target was chowned');
});

test('#2529: taking a tree back seals it: owned by noevia, and no group or other write anywhere', () => {
  const tree = temp('noevia-qa-tree-');
  fs.mkdirSync(path.join(tree, 'src'), { mode: 0o777 }); fs.chmodSync(path.join(tree, 'src'), 0o777);
  fs.writeFileSync(path.join(tree, 'src', 'a.txt'), 'a'); fs.chmodSync(path.join(tree, 'src', 'a.txt'), 0o666);
  fs.chmodSync(tree, 0o777);
  fs.symlinkSync('/nonexistent', path.join(tree, 'src', 'dangling'));
  defaultChown(tree, process.getuid(), process.getgid(), { seal: true });
  assert.equal(fs.statSync(tree).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(tree, 'src')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(tree, 'src', 'a.txt')).mode & 0o777, 0o644);
  // Handing over leaves the modes alone.
  fs.chmodSync(path.join(tree, 'src'), 0o775);
  defaultChown(tree, process.getuid(), process.getgid());
  assert.equal(fs.statSync(path.join(tree, 'src')).mode & 0o777, 0o775);
});

test('#2529: taking a tree back never leaves a setuid or setgid file or directory behind', () => {
  // The kernel clears setuid/setgid on chown; the seal must not put them back on what is then
  // noevia's (review finding: a root-owned setuid program made of the harness's bytes).
  const tree = temp('noevia-qa-tree-');
  const payload = path.join(tree, 'payload'), dir = path.join(tree, 'shared');
  fs.writeFileSync(payload, '#!/bin/sh\n'); fs.chmodSync(payload, 0o6755);
  fs.mkdirSync(dir); fs.chmodSync(dir, 0o3777);
  defaultChown(tree, process.getuid(), process.getgid(), { seal: true });
  assert.equal(fs.statSync(payload).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(dir).mode & 0o7777, 0o755);
});

test('#2529: removing a tree never deletes through a directory swapped for a link', (t) => {
  const tree = temp('noevia-qa-tree-'), outside = temp('noevia-qa-outside-');
  fs.mkdirSync(path.join(tree, 'cache'));
  fs.writeFileSync(path.join(tree, 'cache', 'x'), 'x');
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  swapOnLook(t, tree, 'cache', outside);
  assert.throws(() => removeTree(tree), /replaced/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep', 'a file behind the link was deleted');
  t.mock.restoreAll();
  removeTree(tree);
  assert.equal(fs.existsSync(tree), false, 'once nothing races it, the tree goes');
  assert.equal(fs.existsSync(path.join(outside, 'keep')), true);
});
