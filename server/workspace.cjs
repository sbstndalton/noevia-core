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
  const cache = new Map();
  const usersDir = path.join(rootDir, 'users');
  const sharedFile = path.join(rootDir, 'shared-providers.json');

  function loadShared() {
    const rows = readJson(sharedFile, { providers: [] }).providers || [];
    for (const row of rows) row.apiKey = secrets ? secrets.decrypt(row.apiKey) : row.apiKey;
    if (!rows.some(p => p.id === defaultProvider.id)) rows.unshift({ ...defaultProvider, shared: true });
    return rows;
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
    if (cache.has(userId)) return cache.get(userId);
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
    const allProviders = [...loadShared(), ...uniqueProviders.filter(p => p.id !== defaultProvider.id)];
    const workspace = {
      userId, dir, projects, providers: allProviders,
      freeChats: readJson(path.join(dir, 'free-chats.json'), []),
      autoRoles: readJson(path.join(dir, 'auto-roles.json'), null),
      saveProjects() { atomicJson(path.join(dir, 'projects.json'), { projects: this.projects }); },
      saveProviders() {
        const encode = p => ({ ...p, apiKey: secrets ? secrets.encrypt(p.apiKey) : p.apiKey });
        atomicJson(providerFile, { providers: this.providers.filter(p => !p.shared).map(encode) });
        atomicJson(sharedFile, { providers: this.providers.filter(p => p.shared).map(encode) });
      },
      saveFreeChats() { atomicJson(path.join(dir, 'free-chats.json'), this.freeChats); },
      saveAutoRoles() { atomicJson(path.join(dir, 'auto-roles.json'), this.autoRoles); },
      historyPath(id) { return path.join(dir, `history-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`); },
      ragDir() { return path.join(dir, 'rag'); },
    };
    cache.set(userId, workspace);
    if (needsEncryption) workspace.saveProviders();
    return workspace;
  }

  function remove(userId) { cache.delete(userId); fs.rmSync(userDir(userId), { recursive: true, force: true }); }
  return { get, remove, claimLegacy, userDir };
}

module.exports = { createWorkspaceStore, atomicJson };
