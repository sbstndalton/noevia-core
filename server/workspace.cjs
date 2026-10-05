'use strict';

const fs = require('fs');
const path = require('path');

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

function createWorkspaceStore(rootDir, defaultProvider, secrets) {
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
      return cached;
    }

    const dir = userDir(userId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const projects = readJson(path.join(dir, 'projects.json'), { projects: [] }).projects || [];
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
    for (const project of projects) if (project.provider === 'lemonade') project.provider = defaultProvider.id;
    let modesMigrated = false;
    for (const project of projects) if (require('./project-modes.cjs').migrate(project)) modesMigrated = true;
    const workspace = {
      userId, dir, projects,
      revoked: false,
      assertActive() {
        if (this.revoked) throw Object.assign(new Error('account no longer exists'), { status: 410 });
      },
      // `privateProviders` is the cached per-user truth; `providers` is the
      // merged view rebuilt from disk on every get() so it always reflects
      // the current shared set.
      privateProviders: uniqueProviders.filter(p => p.id !== defaultProvider.id),
      providers: [],
      freeChats: readJson(path.join(dir, 'free-chats.json'), []),
      autoRoles: readJson(path.join(dir, 'auto-roles.json'), null),
      // Per-user settings with no better home. defaultRouting: what new projects start as.
      preferences: readJson(path.join(dir, 'preferences.json'), {}) || {},
      saveProjects() { this.assertActive(); atomicJson(path.join(dir, 'projects.json'), { projects: this.projects }); },
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
      saveFreeChats() { this.assertActive(); atomicJson(path.join(dir, 'free-chats.json'), this.freeChats); },
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
    if (modesMigrated) workspace.saveProjects();
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
  return { get, remove, claimLegacy, userDir, isRemoved: (userId) => removed.has(userId) };
}

module.exports = { createWorkspaceStore, atomicJson };
