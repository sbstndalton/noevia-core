'use strict';

const fs = require('fs');
const path = require('path');
const sourceText = require('./source-text.cjs');
const legacyClaim = require('./legacy-claim.cjs');
const { createReread, fileSignal } = require('./shared-reread.cjs');

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
// throw taking down every request that loads the workspace (#782). The front, which writes the
// file, keeps the original ciphertext as it was, so restoring the right key still recovers it.
function openProviderKey(row, secrets) {
  if (!secrets) return;
  const stored = row.apiKey;
  try { row.apiKey = secrets.decrypt(stored); delete row.keyUnreadable; }
  catch {
    row.apiKey = '';
    row.keyUnreadable = true;
  }
}

// providers.json and shared-providers.json are the Rust front's (sbstndalton/noevia#2190 round 6,
// rust-providers.cjs): its provider routes, and the ChatGPT row its token broker writes, are their
// only writers. Node keeps no copy of the private rows: `privateProviders` re-reads the file by its
// change signal (shared-reread.cjs) on every use, failing closed to no private providers, and the
// shared rows are read again on every access (loadShared). Its one write is the seal-on-load
// migration of a plaintext key (sealLegacyProviders), saved through the project store like
// projects.json is.
// projects.json and free-chats.json are the Rust front's (M4, rust-projects.cjs; permanent since
// sbstndalton/noevia#1071): each workspace reads them again when they changed and saves by a merge
// through the front's project store, never by writing either file itself.
// `onProjectsChanged(userId)` is called when a request start took in the front's changes (to
// projects.json or free-chats.json): a write Node used to make itself (and follow with its own
// nudges, such as the chat vault mirror's) was made by the front instead.
// `projectStore` (#1264, project-store-client.cjs createClient), required: both files are written
// through the Rust store, and a store without it refuses to be made. Each workspace gets its
// own save queue; `pendingStoreWrites()` is a promise for the saves still in flight, or null.
// `onStoreSave(promise)` is told of every such save, so the request that caused it can wait for it
// and answer its failure (index.cjs). A failed save leaves memory ahead of the disk: the workspace
// is then dropped from the cache (the next request reads the files again) and every save still
// queued on it fails too, so nothing of the failed change reaches the disk later.
function createWorkspaceStore(rootDir, defaultProvider, secrets, { projectStore = null, onStoreSave = () => {}, onProjectsChanged = () => {} } = {}) {
  // #1071: there is no local writer of projects.json or free-chats.json to fall back to.
  if (!projectStore) throw new Error('createWorkspaceStore needs the Rust project store (projectStore): Node never writes projects.json or free-chats.json itself');
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
    // the front's next write of that file, which excludes it).
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
    return legacyClaim.claimLegacyRoot(rootDir, userId);
  }

  function get(userId, { claim = false, claimTransaction = null } = {}) {
    if (removed.has(userId)) throw Object.assign(new Error('account no longer exists'), { status: 410 });
    if (claim && legacyClaim.needsClaim(rootDir, userId)) {
      const runClaim = () => claimLegacy(userId);
      if (claimTransaction) claimTransaction(runClaim);
      else runClaim();
    }
    const cached = cache.get(userId);
    if (cached) {
      cached.providers = mergeProviders(cached.privateProviders);
      if (cached.needsKeySeal()) cached.sealLegacyProviders();
      const projectsChanged = cached.projectsFile.refresh(cached.projects);
      const freeChatsChanged = cached.freeChatsFile.refresh(cached);
      if (projectsChanged || freeChatsChanged) onProjectsChanged(userId);
      return cached;
    }

    const dir = userDir(userId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const storeQueue = require('./project-store-client.cjs').createQueue();
    const remote = { client: projectStore, user: userId, queue: storeQueue };
    const sharedProjectsFile = require('./rust-projects.cjs').createProjectsFile(path.join(dir, 'projects.json'), { atomicJson, remote });
    // #1806: a project's sources come back from projects.json as metadata; their text is read from
    // its own file on demand (source-text.cjs). What the other writer's changes bring in is given
    // the same reader.
    const projectsFile = Object.assign(Object.create(sharedProjectsFile), {
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
    const loaded = projectsFile.load();
    const projects = Array.isArray(loaded) ? loaded : [];
    const freeChatsFile = require('./rust-projects.cjs').createFreeChatsFile(path.join(dir, 'free-chats.json'), { atomicJson, remote });
    const providerFile = path.join(dir, 'providers.json');
    // The private rows as the file holds them now (keys opened, the legacy `lemonade` id read as the
    // default, the first row of each id). `legacyKeys` notes a plaintext key left in the file, which
    // the migration below seals through the store.
    let legacyKeys = false;
    const privateRows = createReread({
      signal: () => fileSignal(providerFile),
      load: () => {
        const stored = readJson(providerFile, { providers: [] }).providers || [];
        let plaintext = false;
        for (const provider of stored) {
          if (provider.apiKey && !String(provider.apiKey).startsWith('enc:v1:')) plaintext = true;
          openProviderKey(provider, secrets);
        }
        for (const provider of stored) {
          if (provider.id === 'lemonade') { provider.id = defaultProvider.id; provider.label = defaultProvider.label; }
        }
        legacyKeys = plaintext;
        const unique = stored.filter((provider, index, all) => all.findIndex(p => p.id === provider.id) === index);
        return unique.filter(p => p.id !== defaultProvider.id);
      },
      // A file that cannot be read means no private providers (chat falls back to the default),
      // never the last rows Node happened to read.
      fallback: () => { legacyKeys = false; return []; },
    });
    let sealing = null, sealFailedAt = 0;
    /** Seals the plaintext keys of this account's providers.json under the current key, through the
     *  Rust project store (compare-and-swap on the file's version, merged again on a conflict). */
    function sealLegacyProviders() {
      // After a failure, not again for half a minute (every request would retry and log).
      if (sealing || Date.now() - sealFailedAt < 30000) return sealing || Promise.resolve();
      sealing = (async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const { version, text } = await projectStore.read(userId, 'providers.json');
          if (text === null) return;
          let doc;
          try { doc = JSON.parse(text); } catch { return; }
          if (!doc || !Array.isArray(doc.providers)) return;
          let changed = false;
          for (const row of doc.providers) {
            if (row && typeof row.apiKey === 'string' && row.apiKey && !/^enc:v\d+:/.test(row.apiKey)) { row.apiKey = secrets ? secrets.encrypt(row.apiKey) : row.apiKey; changed = true; }
          }
          if (!changed) return;
          const saved = await projectStore.write(userId, 'providers.json', version, JSON.stringify(doc, null, 2));
          if (saved.ok) return;
        }
      })().catch((e) => { sealFailedAt = Date.now(); console.warn('[providers] could not seal legacy provider keys through the project store:', e.message); })
        .finally(() => { sealing = null; });
      return sealing;
    }
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
      pendingStoreWrites() { return storeQueue.pending(); },
      /** #1264: the error of a store save that failed on this view (it is then dropped), or null. */
      storeFailed() { return remote.failed || null; },
      /** #1917: the live view of this account: this one, or, once this one was dropped after a
       *  failed save, the one read again from disk. For writers that hold a view across awaits. */
      current() {
        if (cache.get(userId) === this || !remote.failed) return this;
        // #1919: never brings back an account removed meanwhile (by Node: get() answers 410; by the
        // Rust front: its directory is gone, and get() would make it again).
        if (!fs.existsSync(dir)) throw Object.assign(new Error('account no longer exists'), { status: 410 });
        return get(userId);
      },
      /** #1264: a store save this workspace made: reported, and on failure the workspace is
       *  invalidated (see the header). Background writers get the rejection logged; they retry on
       *  their next pass against the re-read files. */
      storeSaved(promise, name) {
        const done = promise.catch((e) => {
          remote.failed = e;
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
      // `privateProviders` is the file's rows as of now (re-read when it changed); `providers` is the
      // merged view rebuilt on every get() so it always reflects the current shared set.
      get privateProviders() { return privateRows.current(); },
      /** A plaintext key was left in the file the last time it was read (see sealLegacyProviders). */
      needsKeySeal() { return legacyKeys; },
      sealLegacyProviders,
      providers: [],
      // #1420: free-chats.json holding null (or any non-list) is an empty list, never a null the routes trip on.
      freeChats: (() => { const list = freeChatsFile.load(); return Array.isArray(list) ? list : []; })(),
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
        const saved = projectsFile.save(this.projects, gc);
        // #1264: through the Rust store the save is async. The #1839 modes stay reverted until it
        // is written; a failure is logged here and the change, still in memory, goes with the next save.
        if (saved && typeof saved.then === 'function') {
          const restore = restoreModes; restoreModes = () => {};
          return this.storeSaved(saved.finally(restore), 'projects.json');
        }
        } finally { restoreModes(); }
      },
      saveFreeChats() {
        this.assertActive();
        const saved = freeChatsFile.save(this);
        if (saved && typeof saved.then === 'function') return this.storeSaved(saved, 'free-chats.json');
      },
      savePreferences() { this.assertActive(); atomicJson(path.join(dir, 'preferences.json'), this.preferences); },
      saveAutoRoles() { this.assertActive(); atomicJson(path.join(dir, 'auto-roles.json'), this.autoRoles); },
      historyPath(id) { return path.join(dir, `history-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`); },
      // sbstndalton/noevia#1071 slice 4: the transcript is written by the Rust store only, for this
      // account only (project-store-client.cjs transcriptsFor). historyPath is for reads.
      chatPermissions: {
        context: (chat) => { workspace.assertActive(); return projectStore.grantContext(userId, chat); },
        move: (chat, projectId, patch) => { workspace.assertActive(); return projectStore.chatMove(userId, chat, projectId, patch); },
      },
      // Refresh only after a durable store move, never save a stale pre-move snapshot.
      refreshChatLists() {
        this.assertActive();
        projectsFile.refresh(this.projects);
        freeChatsFile.refresh(this);
      },
      transcripts: require('./project-store-client.cjs').transcriptsFor(projectStore, userId),
      researchJobs: projectStore.researchJobsFor?.(userId) || null,
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
    if (workspace.needsKeySeal()) sealLegacyProviders();
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
