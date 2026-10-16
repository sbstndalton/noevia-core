'use strict';

const fs = require('fs');
const path = require('path');
const sourceText = require('./source-text.cjs');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// A stored provider key that no available secrets key opens (secrets.key restored without its
// rows, or secrets.key.previous removed after a rotation that left failures). The row stays
// usable with an empty key and `keyUnreadable: true`, so it can be re-entered, instead of the
// throw taking down every request that loads the workspace (#782). Its original ciphertext is
// kept off the enumerable row and written back unchanged on the next save, so restoring the
// right key still recovers it; typing a new key replaces it.
const UNREADABLE_CIPHERTEXT = Symbol('unreadableCiphertext');

function openProviderKey(row, secrets) {
  if (!secrets) return;
  const stored = row.apiKey;
  try { row.apiKey = secrets.decrypt(stored); delete row.keyUnreadable; }
  catch {
    row.apiKey = '';
    row.keyUnreadable = true;
    Object.defineProperty(row, UNREADABLE_CIPHERTEXT, { value: stored, enumerable: false, configurable: true, writable: true });
  }
}

/** The on-disk form of a provider row: the key encrypted, or an unreadable key kept as it was.
 *  The ciphertext is written back only while the row is still flagged keyUnreadable; a caller
 *  that clears the flag (a new key, or a move to another origin) gets the key encrypted. */
function sealProviderRow(row, secrets) {
  const { keyUnreadable, ...rest } = row;
  if (keyUnreadable && !row.apiKey && row[UNREADABLE_CIPHERTEXT]) return { ...rest, apiKey: row[UNREADABLE_CIPHERTEXT] };
  return { ...rest, apiKey: secrets ? secrets.encrypt(row.apiKey) : row.apiKey };
}

// `rustProjects`: M4 of the full-Rust migration (rust-projects.cjs). While it is on, projects.json
// is shared with the Rust front: read again when it changed, saved by a merge under a shared lock.
// `rustFreeChats` (the free-chat slice, rust-projects.cjs freeChatsEnabledFrom): free-chats.json is
// shared the same way, under its own lock.
// `onProjectsChanged(userId)` is called when a request start took in the front's changes (to
// projects.json or free-chats.json): a write Node used to make itself (and follow with its own
// nudges, such as the chat vault mirror's) was made by the front instead.
// `projectStore` (#1264, project-store-client.cjs createClient): both files are written through the
// Rust store instead of under flock (needs rustProjects and rustFreeChats). Each workspace gets its
// own save queue; `pendingStoreWrites()` is a promise for the saves still in flight, or null.
// `onStoreSave(promise)` is told of every such save, so the request that caused it can wait for it
// and answer its failure (index.cjs). A failed save leaves memory ahead of the disk: the workspace
// is then dropped from the cache (the next request reads the files again) and every save still
// queued on it fails too, so nothing of the failed change reaches the disk later.
function createWorkspaceStore(rootDir, defaultProvider, secrets, { rustProjects = false, rustFreeChats = false, projectStore = null, onStoreSave = () => {}, onProjectsChanged = () => {} } = {}) {
  // Per-user workspaces are cached, but shared providers are NEVER baked
  // into the cached object: the shared file is re-read and re-merged on
  // every workspace access. This closes the load-time-merge race where a
  // user with a long-cached workspace could rewrite shared-providers.json
  // from a stale snapshot and silently erase an admin's shared provider.
  const cache = new Map();
  // An authenticated request may still hold its workspace after the account
  // has been deleted. Keep the revocation for that process lifetime so a
  // later get() cannot create a fresh directory for the same deleted id.
  const removed = new Set();
  const usersDir = path.join(rootDir, 'users');
  const sharedFile = path.join(rootDir, 'shared-providers.json');

  function loadShared() {
    const rows = readJson(sharedFile, { providers: [] }).providers || [];
    for (const row of rows) openProviderKey(row, secrets);
    // A stale default row may exist in the file from before this fix. Prefer
    // the current env-derived defaultProvider values for that id (dropped on
    // the next saveShared()/removeProvider() write since both now exclude it).
    const filtered = rows.filter(p => p.id !== defaultProvider.id);
    filtered.unshift({ ...defaultProvider, shared: true });
    return filtered;
  }

  // Merge order mirrors the original load-time merge: shared rows first,
  // then the user's private providers, de-duplicated against the default.
  function mergeProviders(privateProviders) {
    return [...loadShared(), ...privateProviders.filter(p => !p.shared && p.id !== defaultProvider.id)];
  }

  function userDir(userId) {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('invalid user id');
    return path.join(usersDir, userId);
  }

  function claimLegacy(userId) {
    const target = userDir(userId);
    const hasLegacy = fs.existsSync(path.join(rootDir, 'projects.json')) || fs.existsSync(path.join(rootDir, 'providers.json')) || fs.readdirSync(rootDir).some(name => /^history-.*\.json$/.test(name));
    if (!hasLegacy) return false;
    // Legacy files remain for recovery. They are not a template for every
    // later administrator: claiming twice copies another tenant's data and
    // credentials and can mark the new account as the diary's legacy owner.
    const ownerFile = path.join(rootDir, 'legacy-owner.json');
    if (!fs.existsSync(ownerFile)) {
      const previous = fs.existsSync(usersDir) && fs.readdirSync(usersDir).find(id =>
        /^[0-9a-f-]{36}$/i.test(id) && fs.existsSync(path.join(usersDir, id, 'migration.json')));
      const ownerId = previous || userId;
      try { fs.writeFileSync(ownerFile, JSON.stringify({ userId: ownerId }), { mode: 0o600, flag: 'wx' }); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    if (readJson(ownerFile, {}).userId !== userId || fs.existsSync(target)) return false;
    const backup = path.join(rootDir, 'migration-backups', `legacy-${Date.now()}`);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const names = fs.readdirSync(rootDir).filter(name =>
      /^(projects|providers|free-chats|auto-roles)\.json$/.test(name) || /^history-.*\.json$/.test(name) || name === 'rag');
    for (const name of names) {
      const source = path.join(rootDir, name);
      fs.cpSync(source, path.join(backup, name), { recursive: true, errorOnExist: true });
      fs.cpSync(source, path.join(target, name), { recursive: true, errorOnExist: true });
    }
    atomicJson(path.join(target, 'migration.json'), { version: 1, source: 'legacy-root', backup, migratedAt: Date.now() });
    return true;
  }

  function get(userId, { claim = false } = {}) {
    if (removed.has(userId)) throw Object.assign(new Error('account no longer exists'), { status: 410 });
    if (claim) claimLegacy(userId);
    const cached = cache.get(userId);
    if (cached) {
      cached.providers = mergeProviders(cached.privateProviders);
      const projectsChanged = cached.projectsFile ? cached.projectsFile.refresh(cached.projects) : false;
      const freeChatsChanged = cached.freeChatsFile ? cached.freeChatsFile.refresh(cached) : false;
      if (projectsChanged || freeChatsChanged) onProjectsChanged(userId);
      return cached;
    }

    const dir = userDir(userId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const storeQueue = projectStore && rustProjects && rustFreeChats ? require('./project-store-client.cjs').createQueue() : null;
    const remote = storeQueue ? { client: projectStore, user: userId, queue: storeQueue } : null;
    const sharedProjectsFile = rustProjects ? require('./rust-projects.cjs').createProjectsFile(path.join(dir, 'projects.json'), { atomicJson, remote }) : null;
    // #1806: a project's sources come back from projects.json as metadata; their text is read from
    // its own file on demand (source-text.cjs). What the other writer's changes bring in is given
    // the same reader.
    const projectsFile = sharedProjectsFile && Object.assign(Object.create(sharedProjectsFile), {
      refresh(list) { const changed = sharedProjectsFile.refresh(list); if (changed) sourceText.attachAll(dir, list); return changed; },
      save(list, afterWrite) {
        const saved = sharedProjectsFile.save(list, afterWrite);
        if (saved && typeof saved.then === 'function') return saved.then(() => { sourceText.attachAll(dir, list); });
        sourceText.attachAll(dir, list);
        return undefined;
      },
    });
    // #1806 review: a projects.json that exists but does not parse loads as an empty list. Its
    // sources' text files must survive that: the source-text collection is off for this
    // workspace (until a restart reads a good file), and never runs over an empty list.
    const projectsPath = path.join(dir, 'projects.json');
    let loadCorrupt = false;
    if (fs.existsSync(projectsPath)) {
      try { const v = JSON.parse(fs.readFileSync(projectsPath, 'utf8')); loadCorrupt = !v || typeof v !== 'object' || (v.projects != null && !Array.isArray(v.projects)); }
      catch { loadCorrupt = true; }
      if (loadCorrupt) console.warn('[sources] projects.json did not load; unused source text will not be removed until it does');
    }
    const loaded = projectsFile ? projectsFile.load() : (readJson(path.join(dir, 'projects.json'), { projects: [] }) || {}).projects;
    const projects = Array.isArray(loaded) ? loaded : [];
    const freeChatsFile = rustFreeChats ? require('./rust-projects.cjs').createFreeChatsFile(path.join(dir, 'free-chats.json'), { atomicJson, remote }) : null;
    const providerFile = path.join(dir, 'providers.json');
    const savedProviders = readJson(providerFile, { providers: [] }).providers || [];
    let needsEncryption = false;
    for (const provider of savedProviders) {
      if (provider.apiKey && !String(provider.apiKey).startsWith('enc:v1:')) needsEncryption = true;
      openProviderKey(provider, secrets);
    }
    for (const provider of savedProviders) {
      if (provider.id === 'lemonade') { provider.id = defaultProvider.id; provider.label = defaultProvider.label; }
    }
    const uniqueProviders = savedProviders.filter((provider, index, all) => all.findIndex(p => p.id === provider.id) === index);
    // #1236: a null entry in project.files (a damaged projects.json) is dropped on load, so no reader
    // (uploads.prune, instruction-skills reconcile, the edit planner) meets a null and throws a TypeError.
    for (const project of projects) if (project && Array.isArray(project.files)) project.files = project.files.filter((f) => f && typeof f === 'object');
    for (const project of projects) if (project.provider === 'lemonade') project.provider = defaultProvider.id;
    let modesMigrated = false;
    // #1839: what a project's `modes` was before the #1576 migration, kept until the backup exists.
    const modesHeld = new Map();
    for (const project of projects) {
      const had = project && Array.isArray(project.modes) ? project.modes : undefined;
      if (require('./project-modes.cjs').migrate(project)) { modesMigrated = true; modesHeld.set(project, { had, now: project.modes.slice() }); }
    }
    // #1576: projects.json is copied aside before the modes migration is written back (a stored
    // Cowork- or Code-only project gains Chat; nothing else changes). Same backup folder as #1806.
    if (modesMigrated && !loadCorrupt) {
      // Without a backup the file is not rewritten now, and no later save (this load's #1806 one
      // included) writes the migrated `modes` either: saveProjects() retries the backup and, until
      // it succeeds, writes the original `modes`. The migration still applies in memory.
      try { sourceText.backupProjectsFile(dir, '1576'); modesHeld.clear(); } catch (e) { modesMigrated = false; console.warn('[projects] could not back up projects.json before the #1576 migration:', e.message); }
    } else modesHeld.clear();
    // #1806: inline source text from before is moved to its files (backup first); see source-text.cjs.
    const textMigrated = sourceText.migrateOnLoad(dir, projects);
    const workspace = {
      userId, dir, projects,
      projectsFile,
      freeChatsFile,
      revoked: false,
      /** #1264: the project-store saves still in flight (a promise), or null. */
      pendingStoreWrites() { return storeQueue ? storeQueue.pending() : null; },
      /** #1264: the error of a store save that failed on this view (it is then dropped), or null. */
      storeFailed() { return (remote && remote.failed) || null; },
      /** #1917: the live view of this account: this one, or, once this one was dropped after a
       *  failed save, the one read again from disk. For writers that hold a view across awaits. */
      current() { return cache.get(userId) === this || !remote || !remote.failed ? this : get(userId); },
      /** #1264: a store save this workspace made: reported, and on failure the workspace is
       *  invalidated (see the header). Background writers get the rejection logged; they retry on
       *  their next pass against the re-read files. */
      storeSaved(promise, name) {
        const done = promise.catch((e) => {
          if (remote) remote.failed = e;
          if (cache.get(userId) === this) cache.delete(userId);
          console.warn(`[projects] could not save ${name} through the project store; this workspace is read again from disk:`, e.message);
          throw e;
        });
        done.catch(() => {});
        try { onStoreSave(done); } catch { /* the hook never breaks a save */ }
        return done;
      },
      assertActive() {
        if (this.revoked) throw Object.assign(new Error('account no longer exists'), { status: 410 });
      },
      // `privateProviders` is the cached per-user truth; `providers` is the
      // merged view rebuilt from disk on every get() so it always reflects
      // the current shared set.
      privateProviders: uniqueProviders.filter(p => p.id !== defaultProvider.id),
      providers: [],
      // #1420: free-chats.json holding null (or any non-list) is an empty list, never a null the routes trip on.
      freeChats: (() => { const list = freeChatsFile ? freeChatsFile.load() : readJson(path.join(dir, 'free-chats.json'), []); return Array.isArray(list) ? list : []; })(),
      autoRoles: readJson(path.join(dir, 'auto-roles.json'), null),
      // Per-user settings with no better home. defaultRouting: what new projects start as.
      preferences: readJson(path.join(dir, 'preferences.json'), {}) || {},
      saveProjects() {
        this.assertActive();
        // #1806: new or changed source text goes to its file first, so projects.json never points
        // at a text that is not on disk; text no source points at any more is removed after.
        // #1839: while the #1576 backup is missing the migrated `modes` stay off the disk.
        let restoreModes = () => {};
        if (modesHeld.size) {
          let backedUp = false;
          try { sourceText.backupProjectsFile(dir, '1576'); backedUp = true; } catch (e) { console.warn('[projects] could not back up projects.json before the #1576 migration:', e.message); }
          if (backedUp) modesHeld.clear();
          else {
            const reverted = [];
            for (const [project, { had, now }] of modesHeld) {
              const same = Array.isArray(project.modes) && project.modes.length === now.length && project.modes.every((m, i) => m === now[i]);
              if (!same || !this.projects.includes(project)) continue;
              if (had === undefined) delete project.modes; else project.modes = had;
              reverted.push([project, now]);
            }
            restoreModes = () => { for (const [project, now] of reverted) project.modes = now; };
          }
        }
        try {
        sourceText.externalize(dir, this.projects);
        // The collection runs right after the write, under the same flock when projects.json is
        // shared with the Rust front, and never after a corrupt load or over an empty list.
        const gc = (list) => {
          if (loadCorrupt || !Array.isArray(list) || list.length === 0) return;
          try { sourceText.collect(dir, list); } catch (e) { console.warn('[sources] could not remove unused source text:', e.message); }
        };
        const saved = projectsFile ? projectsFile.save(this.projects, gc) : (atomicJson(path.join(dir, 'projects.json'), { projects: this.projects }), gc(this.projects), undefined);
        // #1264: through the Rust store the save is async. The #1839 modes stay reverted until it
        // is written; a failure is logged here and the change, still in memory, goes with the next save.
        if (saved && typeof saved.then === 'function') {
          const restore = restoreModes; restoreModes = () => {};
          return this.storeSaved(saved.finally(restore), 'projects.json');
        }
        } finally { restoreModes(); }
      },
      saveProviders() {
        this.assertActive();
        const encode = p => sealProviderRow(p, secrets);
        // Adopt rows a consumer pushed directly onto the merged `providers`
        // view (the historical push-then-save contract). Existing rows are
        // shared by reference between the view and privateProviders, so
        // edits to them are already visible here.
        const sharedIds = new Set(loadShared().map(p => p.id));
        for (const p of this.providers) {
          if (!p.shared && !sharedIds.has(p.id) && p.id !== defaultProvider.id &&
              !this.privateProviders.some(q => q.id === p.id)) {
            this.privateProviders.push(p);
          }
        }
        // Writes ONLY this user's private provider file. Never touches
        // shared-providers.json — shared rows are managed exclusively via
        // saveShared(), so a stale private save can't erase another
        // admin's shared provider.
        atomicJson(providerFile, { providers: this.privateProviders.map(encode) });
        this.providers = mergeProviders(this.privateProviders);
      },
      // Admin path for shared-provider changes. The change is applied BY ID onto a fresh read
      // of shared-providers.json, never by writing this view's whole shared set: the view was
      // merged when the request started, and another admin may have saved a shared provider
      // while this request awaited its body (#785).
      //   saveShared(id)  upserts this view's row `id`, or removes `id` when the view no longer
      //                   holds it as a shared row
      //   saveShared()    upserts every shared row of this view; never removes a row
      saveShared(id) {
        this.assertActive();
        const encode = p => sealProviderRow(p, secrets);
        const viewShared = this.providers.filter(p => p.shared && p.id !== defaultProvider.id);
        const changes = id === undefined ? viewShared : viewShared.filter(p => p.id === id);
        let rows = loadShared().filter(p => p.id !== defaultProvider.id);
        if (id !== undefined && !changes.length) rows = rows.filter(p => p.id !== id);
        for (const row of changes) {
          const at = rows.findIndex(p => p.id === row.id);
          if (at === -1) rows.push(row); else rows[at] = row;
        }
        atomicJson(sharedFile, { providers: rows.map(encode) });
        this.providers = mergeProviders(this.privateProviders);
      },
      removeProvider(id) {
        this.assertActive();
        const selected = this.providers.find(p => p.id === id);
        if (!selected || id === defaultProvider.id) return false;
        if (selected.shared) {
          const encode = p => sealProviderRow(p, secrets);
          // Mirror saveShared(): never persist the built-in default row back
          // to shared-providers.json, or its env-sourced key gets baked into
          // the file and the env value is ignored from then on.
          atomicJson(sharedFile, { providers: loadShared().filter(p => p.id !== id && p.id !== defaultProvider.id).map(encode) });
        } else {
          this.privateProviders = this.privateProviders.filter(p => p.id !== id);
          this.providers = this.providers.filter(p => p.id !== id);
          this.saveProviders();
        }
        this.providers = mergeProviders(this.privateProviders);
        return true;
      },
      saveFreeChats() {
        this.assertActive();
        const saved = freeChatsFile ? freeChatsFile.save(this) : atomicJson(path.join(dir, 'free-chats.json'), this.freeChats);
        if (saved && typeof saved.then === 'function') return this.storeSaved(saved, 'free-chats.json');
      },
      savePreferences() { this.assertActive(); atomicJson(path.join(dir, 'preferences.json'), this.preferences); },
      saveAutoRoles() { this.assertActive(); atomicJson(path.join(dir, 'auto-roles.json'), this.autoRoles); },
      historyPath(id) { return path.join(dir, `history-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`); },
      usagePath() { return path.join(dir, 'usage.json'); },
      ragDir() { return path.join(dir, 'rag'); },
      // Image sources live on disk, not in projects.json: base64 in the
      // workspace file would be re-read and re-parsed on every request that
      // touches a project, for bytes nothing but the model ever looks at.
      assetDir(projectId) {
        return path.join(dir, 'project-assets', String(projectId).replace(/[^a-zA-Z0-9_-]/g, ''));
      },
    };
    workspace.providers = mergeProviders(workspace.privateProviders);
    cache.set(userId, workspace);
    if (needsEncryption) workspace.saveProviders();
    if (modesMigrated || textMigrated) workspace.saveProjects();
    return workspace;
  }

  function remove(userId) {
    const dir = userDir(userId);
    removed.add(userId);
    const workspace = cache.get(userId);
    if (workspace) workspace.revoked = true;
    cache.delete(userId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // #1806: at startup, every workspace whose projects.json still holds source text inline is loaded,
  // which moves the text to its files (source-text.cjs migrateOnLoad, backup first) before the
  // first request, and before the Rust front reads the file. Returns the user ids migrated.
  function migrateSourceText(userIds) {
    const done = [];
    for (const userId of userIds) {
      try {
        if (removed.has(userId) || cache.has(userId)) continue;
        const projects = readJson(path.join(userDir(userId), 'projects.json'), { projects: [] }).projects;
        if (!Array.isArray(projects) || !sourceText.hasInline(projects)) continue;
        get(userId);
        done.push(userId);
      } catch (e) { console.warn(`[sources] could not move source text out of projects.json for ${userId}: ${e.message}`); }
    }
    return done;
  }
  return { get, remove, claimLegacy, userDir, migrateSourceText, isRemoved: (userId) => removed.has(userId) };
}

module.exports = { createWorkspaceStore, atomicJson };
