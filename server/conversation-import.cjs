'use strict';
// A tenant-local recovery journal for conversation imports. Not a workspace transaction:
// committed groups remain visible; the next import request finishes interrupted groups.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { planImport } = require('./chat-import.cjs');
const locks = new Map();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function atomicJson(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
// Read durable lists, not the mutable workspace cache: a failed save may already
// have changed the cache. Skipping that cache entry would lose it after restart.
function persistedChatIds(dir) {
  const projects = readJson(path.join(dir, 'projects.json'), { projects: [] }).projects;
  const free = readJson(path.join(dir, 'free-chats.json'), []);
  return new Set([...free, ...projects.flatMap(p => p.chats || [])].map(c => c.id));
}
function sameFile(a, b) {
  const x = fs.statSync(a), y = fs.statSync(b);
  return x.dev === y.dev && x.ino === y.ino;
}
function requireHardLinks(directory) {
  const token = `.conversation-import-link-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const source = path.join(directory, token), target = source + '.linked';
  try {
    fs.writeFileSync(source, token, { flag: 'wx', mode: 0o600 });
    fs.linkSync(source, target);
  } catch (error) {
    if (['EPERM', 'ENOTSUP', 'EXDEV'].includes(error.code)) {
      throw Object.assign(Error('Conversation imports require hard-link support'), {
        status: 503,
        publicMessage: 'Conversation imports are unavailable because this storage does not support safe file promotion.',
      });
    }
    throw error;
  } finally {
    try { fs.unlinkSync(target); } catch {}
    try { fs.unlinkSync(source); } catch {}
  }
}
function publishStaged(staged, target) {
  try { fs.linkSync(staged, target); }
  catch (error) {
    if (error.code !== 'EEXIST' || !sameFile(staged, target)) throw error;
  }
}
function resultFor(record) {
  const capped = record.capped || [];
  return {
    imported: record.plan.imported - capped.length,
    skipped: [...record.plan.skipped, ...capped.map(c => ({ title: c.title, reason: 'conversation list is full' }))],
    projectsCreated: record.projectsCreated,
  };
}

async function applyRecord(directory, record, ctx, newId) {
  const manifest = path.join(directory, 'manifest.json');
  const save = () => atomicJson(manifest, record);
  const groups = [{ chats: record.plan.freeChats, free: true }, ...record.plan.projectChats];
  for (const group of groups) {
    const alreadySaved = ctx.persistedChatIds(), alreadyDeleted = ctx.tombstones();
    const capped = new Set((record.capped || []).map(c => c.id));
    let active = group.chats.filter(c => !alreadySaved.has(c.id) && !alreadyDeleted.has(c.id) && !capped.has(c.id));
    if (!active.length) continue;
    let projectId = group.projectId;
    if (projectId && !ctx.projects().some(p => p.id === projectId)) projectId = null;
    if (!group.free && !projectId) {
      projectId = ctx.projects().find(p => p.name.trim().toLowerCase() === group.name.toLowerCase())?.id;
      if (!projectId) {
        // External folder allocation is intentionally never rolled back.
        projectId = (await ctx.createProject({ name: group.name, toolboxes: [] })).id;
        record.projectsCreated++;
      }
      group.projectId = projectId;
      save();
    }
    // Project creation can await storage; account changes during that await win.
    const visible = ctx.persistedChatIds(), deleted = ctx.tombstones();
    active = active.filter(c => !visible.has(c.id) && !deleted.has(c.id));
    for (const chat of active) {
      const file = record.files.find(f => f.id === chat.id);
      const staged = path.join(directory, file.stage);
      let target = ctx.historyPath(chat.id);
      if (fs.existsSync(target) && !sameFile(staged, target)) {
        // Never overwrite a pre-existing unlisted transcript or a concurrent file.
        let id;
        do { id = newId(); } while (visible.has(id) || deleted.has(id) || record.files.some(f => f.id === id) || fs.existsSync(ctx.historyPath(id)));
        file.id = id; chat.id = id; target = ctx.historyPath(id); save();
      }
      publishStaged(staged, target);
    }
    // Merge-only collaborators preserve unrelated edits. Repeating these writes
    // after a crash is safe; durable membership is checked on every recovery.
    if (active.length) {
      if (group.free) ctx.addFreeChats(active);
      else ctx.addProjectChats(projectId, active);
      const committed = ctx.persistedChatIds();
      const dropped = active.filter(c => !committed.has(c.id));
      if (dropped.length) {
        record.capped = [...(record.capped || []), ...dropped.map(c => ({ id: c.id, title: c.title }))]
          .filter((c, index, rows) => rows.findIndex(row => row.id === c.id) === index);
        save();
      }
    }
  }
  // A deleted imported chat may have left a file when its own unlink failed.
  // Remove only our inode, only if tombstoned and still absent from durable lists.
  const visible = ctx.persistedChatIds(), deleted = ctx.tombstones();
  for (const file of record.files) {
    const target = ctx.historyPath(file.id), staged = path.join(directory, file.stage);
    if (deleted.has(file.id) && !visible.has(file.id) && fs.existsSync(target) && sameFile(staged, target)) fs.unlinkSync(target);
  }
  const capped = new Set((record.capped || []).map(c => c.id));
  for (const file of record.files) {
    if (!capped.has(file.id)) continue;
    const target = ctx.historyPath(file.id), staged = path.join(directory, file.stage);
    if (fs.existsSync(target) && sameFile(staged, target)) fs.unlinkSync(target);
  }
  if (record.files.some(f => !visible.has(f.id) && !deleted.has(f.id) && !capped.has(f.id))) throw Error('Import metadata was not committed');
  const result = resultFor(record);
  const removed = groups.flatMap(g => g.chats).filter(c => deleted.has(c.id) && !visible.has(c.id));
  result.imported -= removed.length;
  result.skipped = [...result.skipped, ...removed.map(c => ({ title: c.title, reason: 'deleted while import was pending' }))];
  return result;
}

async function importConversations(data, ctx, newId, onComplete = () => {}) {
  const key = ctx.directory;
  const previous = locks.get(key) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const planning = () => planImport(data, { existingChatIds: ctx.existingChatIds(), tombstones: ctx.tombstones(), projects: ctx.projects(), newId });
    planning(); // Reject invalid input before recovering or writing anything.
    requireHardLinks(ctx.directory); // Fail before creating/recovering a journal on unsupported storage.
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const root = path.join(ctx.directory, 'conversation-imports');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    let resumed;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      const record = readJson(path.join(directory, 'manifest.json'), null);
      if (!record) { fs.rmSync(directory, { recursive: true }); continue; } // No promotion before manifest.
      const result = await applyRecord(directory, record, ctx, newId);
      onComplete(result);
      fs.rmSync(directory, { recursive: true });
      if (entry.name === fingerprint) resumed = result;
    }
    if (resumed) return resumed;
    const plan = planning();
    if (!plan.imported) { const result = { imported: 0, skipped: plan.skipped, projectsCreated: 0 }; onComplete(result); return result; }
    const directory = path.join(root, fingerprint);
    fs.mkdirSync(directory, { mode: 0o700 });
    const files = Object.entries(plan.histories).map(([id, history], index) => {
      const stage = `${index}.json`;
      atomicJson(path.join(directory, stage), { history });
      return { id, stage };
    });
    delete plan.histories;
    const record = { version: 1, plan, files, projectsCreated: 0 };
    atomicJson(path.join(directory, 'manifest.json'), record);
    const result = await applyRecord(directory, record, ctx, newId);
    onComplete(result);
    fs.rmSync(directory, { recursive: true });
    return result;
  });
  locks.set(key, work);
  try { return await work; }
  finally { if (locks.get(key) === work) locks.delete(key); }
}
module.exports = { importConversations, persistedChatIds };
