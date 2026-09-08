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

function createWorkspaceStore(rootDir, defaultProvider, secrets) {
  // Per-user workspaces are cached, but shared providers are NEVER baked
  // into the cached object: the shared file is re-read and re-merged on
  // every workspace access. This closes the load-time-merge race where a
  // user with a long-cached workspace could rewrite shared-providers.json
  // from a stale snapshot and silently erase an admin's shared provider.
  const cache = new Map();
  const usersDir = path.join(rootDir, 'users');
  const sharedFile = path.join(rootDir, 'shared-providers.json');

  function loadShared() {
    const rows = readJson(sharedFile, { providers: [] }).providers || [];
    for (const row of rows) row.apiKey = secrets ? secrets.decrypt(row.apiKey) : row.apiKey;
    if (!rows.some(p => p.id === defaultProvider.id)) rows.unshift({ ...defaultProvider, shared: true });
    return rows;
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
    if (fs.existsSync(target) || !hasLegacy) return false;
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
      provider.apiKey = secrets ? secrets.decrypt(provider.apiKey) : provider.apiKey;
    }
    for (const provider of savedProviders) {
      if (provider.id === 'lemonade') { provider.id = defaultProvider.id; provider.label = defaultProvider.label; }
    }
    const uniqueProviders = savedProviders.filter((provider, index, all) => all.findIndex(p => p.id === provider.id) === index);
    for (const project of projects) if (project.provider === 'lemonade') project.provider = defaultProvider.id;
    const workspace = {
      userId, dir, projects,
      // `privateProviders` is the cached per-user truth; `providers` is the
      // merged view rebuilt from disk on every get() so it always reflects
      // the current shared set.
      privateProviders: uniqueProviders.filter(p => p.id !== defaultProvider.id),
      providers: [],
      freeChats: readJson(path.join(dir, 'free-chats.json'), []),
      autoRoles: readJson(path.join(dir, 'auto-roles.json'), null),
      saveProjects() { atomicJson(path.join(dir, 'projects.json'), { projects: this.projects }); },
      saveProviders() {
        const encode = p => ({ ...p, apiKey: secrets ? secrets.encrypt(p.apiKey) : p.apiKey });
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
      // Admin path for shared-provider changes: persists the shared rows
      // from the (freshly merged) current view, then re-merges from disk.
      saveShared() {
        const encode = p => ({ ...p, apiKey: secrets ? secrets.encrypt(p.apiKey) : p.apiKey });
        atomicJson(sharedFile, { providers: this.providers.filter(p => p.shared && p.id !== defaultProvider.id).map(encode) });
        this.providers = mergeProviders(this.privateProviders);
      },
      removeProvider(id) {
        const selected = this.providers.find(p => p.id === id);
        if (!selected || id === defaultProvider.id) return false;
        if (selected.shared) {
          const encode = p => ({ ...p, apiKey: secrets ? secrets.encrypt(p.apiKey) : p.apiKey });
          atomicJson(sharedFile, { providers: loadShared().filter(p => p.id !== id).map(encode) });
        } else {
          this.privateProviders = this.privateProviders.filter(p => p.id !== id);
          this.providers = this.providers.filter(p => p.id !== id);
          this.saveProviders();
        }
        this.providers = mergeProviders(this.privateProviders);
        return true;
      },
      saveFreeChats() { atomicJson(path.join(dir, 'free-chats.json'), this.freeChats); },
      saveAutoRoles() { atomicJson(path.join(dir, 'auto-roles.json'), this.autoRoles); },
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
    return workspace;
  }

  function remove(userId) { cache.delete(userId); fs.rmSync(userDir(userId), { recursive: true, force: true }); }
  return { get, remove, claimLegacy, userDir };
}

module.exports = { createWorkspaceStore, atomicJson };
