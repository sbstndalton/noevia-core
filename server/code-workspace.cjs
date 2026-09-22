'use strict';
// One writer per workspace (spec-agent-execution §3, "Workspace isolation").
//
// A coding task never runs in the repository's own working tree. It gets a git worktree of its
// own on its own branch, and that worktree is the only place it may write. Two things follow:
// the user's tree is never left dirty or half-patched by a task, and containment becomes a
// question about one directory rather than about everything the harness process can reach.
//
// Containment is resolved with realpath, because the ACP spike escalated exactly here: the
// agent behaved differently once the workspace was reached through a symlink. A path that does
// not exist yet (a file about to be created) is judged by its nearest existing ancestor, so a
// symlinked parent cannot smuggle a write out of the worktree.
//
// Two shapes, because the sandbox changes what is possible:
//
//   * `worktree` (default) — a git worktree of the repository. Cheap, and right when the harness
//     runs as the same user as noevia.
//   * `clone` — a `git clone --shared`, used when the harness runs as a DIFFERENT user in its own
//     container. A worktree keeps its objects and refs in the source repository's `.git`, so a
//     harness that cannot write there can read, edit and run tests but **cannot commit**; proven
//     on DaServer, where `git commit` failed on a handed-over worktree. A shared clone gives the
//     task a repository it fully owns, leaves the source read-only to it, and still copies no
//     objects (120 KB for a clone of the scratch fixture). noevia fetches the branch back when
//     the task is released, so the work survives and the source's history stays noevia's.
//
// This module decides and records ownership. It is NOT the sandbox: the harness still runs
// unprivileged, in a container, with no credentials and no egress unless granted.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');

const TASK_ID = /^[0-9a-f-]{36}$/;
// A clone has no committer identity of its own, and the harness's is not noevia's to claim.
const COMMITTER = Object.freeze({ name: 'noevia', email: 'noevia@localhost' });
// A harness keeps state wherever HOME points, and some also drop it in the working directory.
// None of it is the task's work, and a real run committed thousands of such files — a sqlite
// database and a nested git repository among them — into the branch.
const HARNESS_LEAVINGS = ['.cache/', '.config/', '.local/', '.opencode/', '.claude/', '.codex/', '.qwen/', '.pi/',
  'opencode.json', 'opencode.jsonc', '.aider*', 'node_modules/.cache/'];
const BRANCH_PREFIX = 'noevia/task-';

/** Say what git actually refused. "Not a git repository" for anything else is a lie. */
function gitReason(error) {
  const text = String(error?.stderr || error?.message || '');
  if (/dubious ownership/i.test(text)) return 'That repository is owned by another user and git refused to read it.';
  if (/not a git repository/i.test(text)) return 'Not a git repository';
  return `git could not read that repository: ${text.split('\n')[0].slice(0, 200) || 'unknown error'}`;
}

function defaultRun(args, cwd, env = {}) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
}

/**
 * @param {{dir: string, treeRoot?: string|null, owner?: {uid: number, gid: number}|null,
 *          run?: (args: string[], cwd?: string) => string, now?: () => number, epoch?: string,
 *          chown?: (target: string, uid: number, gid: number) => void}} deps
 *
 * `treeRoot` puts the worktrees somewhere other than the tenant's own directory. That matters
 * for the sandbox: the harness runs in a different container and must see the worktree at the
 * SAME absolute path, which means a shared volume mounted identically in both. The ownership
 * records stay tenant-side either way — only the working trees move.
 *
 * `owner` hands each new worktree to the uid the sandbox runs as. noevia runs as root and the
 * sandbox deliberately does not, so without this the harness cannot write the tree it was
 * given. `epoch` identifies this process: claims from an earlier one are reported as
 * interrupted rather than silently reused.
 */
function createCodeWorkspaces({ dir, treeRoot = null, owner = null, run = defaultRun,
  now = Date.now, epoch = String(process.pid), chown = defaultChown, mode = owner ? 'clone' : 'worktree',
  rm = (target) => fs.rmSync(target, { recursive: true, force: true }) } = {}) {
  const root = path.join(dir, 'code-workspaces');
  // git refuses to read a repository owned by another user, and that refusal is only liftable
  // from a config FILE — not `-c safe.directory`, not GIT_CONFIG_*. On a shared volume the
  // registered repository is owned by the harness user (the sandbox has to read it) while
  // noevia runs as root, so without this every task fails at `rev-parse` — and reported
  // "Not a git repository", which is not what happened. Only repositories the operator
  // registered are ever named in this file, one line each, appended as they are first used.
  const trustFile = path.join(root, 'trusted-repositories.gitconfig');
  const gitEnv = () => ({ GIT_CONFIG_GLOBAL: trustFile, GIT_CONFIG_SYSTEM: '/dev/null' });
  function trust(...paths) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    let current = '';
    try { current = fs.readFileSync(trustFile, 'utf8'); } catch { /* first use */ }
    // The work tree AND its git directory: a clone resolves the source as its `.git`, and git
    // checks ownership of whichever path it is about to open.
    const lines = paths.filter(Boolean).map((p) => `\tdirectory = ${p}\n`).filter((l) => !current.includes(l));
    if (!lines.length) return;
    fs.writeFileSync(trustFile, (current || '[safe]\n') + lines.join(''), { mode: 0o600 });
  }
  const trees = treeRoot || root;
  const recordFile = (taskId) => path.join(root, taskId + '.json');
  const treeDir = (taskId) => path.join(trees, taskId);

  const checkId = (taskId) => {
    if (!TASK_ID.test(String(taskId || ''))) throw Object.assign(Error('Invalid task id'), { status: 400 });
    return String(taskId);
  };
  function read(taskId) {
    try { return JSON.parse(fs.readFileSync(recordFile(checkId(taskId)), 'utf8')); }
    catch (e) { if (e.status) throw e; return null; }
  }
  function write(record) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(recordFile(record.taskId), JSON.stringify(record), { mode: 0o600 });
    return record;
  }
  function list() {
    try {
      return fs.readdirSync(root).filter((n) => n.endsWith('.json'))
        .map((n) => read(n.slice(0, -5))).filter(Boolean).sort((a, b) => b.claimedAt - a.claimedAt);
    } catch { return []; }
  }

  /**
   * Take the workspace for one task. Refuses a second live claim on the same repository and
   * branch — that is the "one writer" rule — and refuses to reuse a task id.
   */
  function claim({ taskId, repoPath, branch = null, capabilities = [], domains = [] }) {
    const id = checkId(taskId);
    if (read(id)) throw Object.assign(Error('This task already has a workspace'), { status: 409 });
    let repo;
    try { repo = fs.realpathSync(String(repoPath || '')); }
    catch { throw Object.assign(Error('No such repository'), { status: 400 }); }
    trust(repo, path.join(repo, '.git'));
    try { trust(run(['rev-parse', '--absolute-git-dir'], repo, gitEnv())); }
    catch (error) { throw Object.assign(Error(gitReason(error)), { status: 400 }); }

    // The whole task id, not a prefix: two tasks must never derive the same branch.
    const name = branch ? String(branch) : BRANCH_PREFIX + id;
    if (!/^[\w./-]+$/.test(name) || name.includes('..') || name.startsWith('-')) {
      throw Object.assign(Error('Invalid branch name'), { status: 400 });
    }
    // Anything that has not cleanly released still owns the branch — a stuck worktree and an
    // interrupted claim both keep it checked out, so both keep blocking until someone looks.
    const held = list().find((r) => r.status !== 'released' && r.repo === repo && r.branch === name);
    if (held) throw Object.assign(Error(`Another task already writes ${name} in this repository (${held.status})`), { status: 409 });

    const tree = treeDir(id);
    // The harness's own state directory, beside the workspace and never inside it. With HOME
    // pointing into the repository, one real run committed OpenCode's entire cache, database and
    // a nested git repo onto the task's branch.
    const home = path.join(trees, '.harness-home', id);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (trees !== root) fs.mkdirSync(trees, { recursive: true, mode: 0o755 });
    // The shared parent must be traversable by the harness user; only the task's own directory
    // inside it is private. Creating the whole path at 0700 left `.harness-home` root-owned and
    // unenterable, and the agent died with EACCES before it did anything.
    fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o755 });
    // `mkdir` leaves an existing directory's mode alone, so a volume created by an earlier
    // version keeps its 0700 and the harness still cannot enter. Correct it every time.
    try { fs.chmodSync(path.dirname(home), 0o755); } catch { /* not ours to fix; the claim still works */ }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    if (mode === 'clone') {
      // --shared: the clone reads the source's objects instead of copying them, so this costs
      // kilobytes. The source must therefore outlive the task, which it does.
      run(['clone', '--quiet', '--shared', repo, tree], undefined, gitEnv());
      run(['checkout', '--quiet', '-B', name], tree, gitEnv());
    } else {
      // -B so a branch left behind by an earlier, released task does not block a new one; the
      // worktree path itself must be new, which `git worktree add` enforces.
      run(['worktree', 'add', '-B', name, tree], repo, gitEnv());
    }
    // Hand it to whoever runs the harness. Done after the tree exists so git's own files are
    // covered. A deployment whose harness runs as noevia has nothing to hand over.
    // Belt and braces: a harness that writes into the working directory anyway is ignored
    // rather than committed. `info/exclude` is local to this clone and never travels.
    try {
      const excludeFile = path.join(tree, '.git', 'info', 'exclude');
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      fs.appendFileSync(excludeFile, `\n# noevia: harness state, not the task's work\n${HARNESS_LEAVINGS.join('\n')}\n`);
    } catch { /* a worktree keeps its exclude in the parent repo; not worth failing a claim over */ }
    if (owner) {
      try { chown(tree, owner.uid, owner.gid); chown(home, owner.uid, owner.gid); }
      catch (e) {
        // Better to refuse than to start a harness that cannot write the tree it was given.
        try { rm(tree); } catch { /* the refusal is what matters */ }
        try { rm(home); } catch { /* likewise */ }
        throw Object.assign(Error(`Could not hand the workspace to the harness user: ${e.message}`), { status: 500 });
      }
    }
    return write({ taskId: id, repo, branch: name, path: fs.realpathSync(tree), home, status: 'held', mode,
      // Who to hand the clone BACK to before reading from it: git refuses to read a repository
      // owned by someone else ("dubious ownership"), and that check ignores `-c` and the
      // GIT_CONFIG_* environment on purpose, so it cannot be worked around from the outside.
      owner: owner ? { ...owner } : null,
      noevia: typeof process.getuid === 'function' ? { uid: process.getuid(), gid: process.getgid() } : null,
      capabilities: [...capabilities], domains: [...domains], epoch, claimedAt: now() });
  }

  /**
   * Is this path inside the task's worktree? `null` when the task holds no workspace, so a
   * caller cannot mistake "unknown" for "yes".
   */
  function contains(taskId, candidate) {
    const record = read(taskId);
    if (!record || record.status !== 'held') return null;
    if (typeof candidate !== 'string' || !candidate) return false;
    // Relative paths are resolved against the worktree, as ACP paths are absolute by spec and
    // anything else is the harness deviating from it.
    const target = path.resolve(record.path, candidate);
    let resolvedRoot;
    try { resolvedRoot = fs.realpathSync(record.path); } catch { return false; }
    let probe = target, unresolved = 0;
    for (;;) {
      try { probe = fs.realpathSync(probe); break; }
      catch {
        const parent = path.dirname(probe);
        // A path whose every ancestor is missing cannot be inside anything that exists.
        if (parent === probe || ++unresolved > 64) return false;
        probe = parent;
      }
    }
    // The resolved ancestor must be the root or under it, and the unresolved remainder must not
    // climb back out with `..`.
    const rest = path.relative(probe, target);
    if (rest.split(path.sep).includes('..')) return false;
    const rel = path.relative(resolvedRoot, probe);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * Give the workspace back. The branch survives by default: the work is the point.
   *
   * For a clone that means fetching the branch into the source repository FIRST — the commits
   * live only in the clone until then, so removing it first would throw the work away. A fetch
   * that fails keeps the tree and marks the claim stuck, because a task's work is not ours to
   * discard quietly.
   */
  function release({ taskId, removeBranch = false } = {}) {
    const record = read(taskId);
    if (!record) return null;
    let removed = true, error = null;
    if ((record.mode || 'worktree') === 'clone') {
      // Take the clone back first. git refuses to read a repository owned by another user, and
      // that refusal cannot be lifted with `-c safe.directory` or GIT_CONFIG_* — only from a
      // config file — so ownership, not a git escape hatch, is the right lever. Found by running
      // a real harness: without this the fetch fails and every task's work is stranded.
      if (record.owner && record.noevia) {
        try { chown(record.path, record.noevia.uid, record.noevia.gid); }
        catch (e) {
          return write({ ...record, status: 'stuck', releasedAt: now(),
            error: `Could not take the workspace back from the harness user: ${e.message}` });
        }
      }
      // Most harnesses edit files and never commit — OpenCode edited `median.js` through
      // noevia's own file API and stopped there. Since only commits can be fetched back, an
      // uncommitted change would be deleted with the clone, which is the opposite of the point.
      // So noevia commits whatever is left, in its own name, clearly labelled.
      try {
        if (run(['status', '--porcelain'], record.path, gitEnv())) {
          run(['add', '--all'], record.path, gitEnv());
          run(['-c', `user.name=${COMMITTER.name}`, '-c', `user.email=${COMMITTER.email}`,
            'commit', '--quiet', '--no-verify', '-m',
            `noevia: work in progress from task ${record.taskId}\n\nCommitted by noevia when the task ended, because the harness left it uncommitted.`,
          ], record.path);
        }
      } catch (e) {
        return write({ ...record, status: 'stuck', releasedAt: now(),
          error: `Could not save the task\u2019s uncommitted changes: ${e.message}` });
      }
      try {
        // Never forced: a branch that would not fast-forward is a conflict for a human, not
        // something to overwrite. Nothing is fetched if the task never committed.
        run(['fetch', '--quiet', record.path, `${record.branch}:${record.branch}`], record.repo, gitEnv());
      } catch (e) {
        // "Couldn't find remote ref" simply means the task made no commits — not a failure.
        if (!/couldn't find remote ref|not found in upstream/i.test(String(e.message))) {
          return write({ ...record, status: 'stuck', releasedAt: now(), error: `Could not save the task’s branch: ${e.message}` });
        }
      }
      try { rm(record.path); } catch (e) { removed = false; error = e.message; }
      if (record.home) { try { rm(record.home); } catch { /* nothing of the task's is in there */ } }
      if (removed && removeBranch) { try { run(['branch', '-D', record.branch], record.repo, gitEnv()); } catch { /* keep going */ } }
    } else {
      try { run(['worktree', 'remove', '--force', record.path], record.repo, gitEnv()); }
      catch (e) { removed = false; error = e.message; }
      try { run(['worktree', 'prune'], record.repo, gitEnv()); } catch { /* best effort */ }
      if (removed && removeBranch) { try { run(['branch', '-D', record.branch], record.repo, gitEnv()); } catch { /* keep going */ } }
    }
    // An unremovable tree is recorded, not hidden: it may still hold the branch, so the next
    // claim on it must keep failing until someone looks.
    return write({ ...record, status: removed ? 'released' : 'stuck', releasedAt: now(), error });
  }

  /**
   * After a restart, claims made by an earlier process are interrupted: the harness that held
   * them is gone. They are reported, never reused, and never cleaned up automatically — the
   * worktree may hold work nobody has read yet.
   */
  function recover() {
    return list().filter((r) => r.status === 'held' && r.epoch !== epoch)
      .map((r) => write({ ...r, status: 'interrupted', interruptedAt: now() }));
  }

  // `owner` is public so anything else noevia writes into a workspace (the harness's own
  // config file) can be handed over the same way the worktree is.
  return { claim, release, recover, contains, get: read, list, root, owner, BRANCH_PREFIX };
}

/** Recursive chown, so the harness owns the tree and git's own files inside it. */
function defaultChown(target, uid, gid) {
  const walk = (entry) => {
    fs.lchownSync(entry, uid, gid);
    let stat; try { stat = fs.lstatSync(entry); } catch { return; }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(entry)) walk(path.join(entry, name));
  };
  walk(target);
}

module.exports = { createCodeWorkspaces, defaultChown, BRANCH_PREFIX };
