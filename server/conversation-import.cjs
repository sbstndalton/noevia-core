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
// sbstndalton/noevia#1071 slice 4: a staged transcript is published through the Rust store (its only
// writer; ctx.transcripts, the account's own), never by linking or writing the file here. The store
// writes it only if no transcript is there (`ifAbsent`), under its lock, and answers what is there
// otherwise: the same transcript (`revision === proposedRevision`: this import's own, published before
// a crash) counts as published; anything else keeps its file and the chat gets a new id. Taking one
// back (a chat deleted, or over the list cap, meanwhile) removes it only while it is still exactly what
// this import published (`removeIf`), never a transcript saved since.
const MAX_ID_ATTEMPTS = 100;
function stagedHistory(directory, file) {
  const value = readJson(path.join(directory, file.stage), null);
  return Array.isArray(value?.history) ? value.history : [];
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
      const history = stagedHistory(directory, file);
      let published = await ctx.transcripts.write(chat.id, history, { ifAbsent: true, origin: 'import' });
      for (let attempt = 0; published.conflict && published.revision !== published.proposedRevision; attempt++) {
        // Never overwrite a pre-existing unlisted transcript or a concurrent file.
        if (attempt >= MAX_ID_ATTEMPTS) throw Error('Could not find a free conversation id');
        let id;
        do { id = newId(); } while (visible.has(id) || deleted.has(id) || record.files.some(f => f.id === id));
        file.id = id; chat.id = id; save();
        published = await ctx.transcripts.write(id, history, { ifAbsent: true, origin: 'import' });
      }
      // `deleted`: tombstoned meanwhile; nothing was written, and the final pass reports it.
    }
    // Merge-only collaborators preserve unrelated edits. Repeating these writes
    // after a crash is safe; durable membership is checked on every recovery.
    if (active.length) {
      if (group.free) ctx.addFreeChats(active);
      else ctx.addProjectChats(projectId, active);
      // The lists are saved through the Rust project store (#1264, the only writer since #1071):
      // the save is written later, so wait for it before reading what is on disk. A failed save
      // rejects here, and the import answers retry, as a failed synchronous save did.
      await ctx.whenSaved();
      const committed = ctx.persistedChatIds();
      // A chat deleted in another tab while the save was pending is not "list is full": the final
      // pass below reports it as deleted (#1953).
      const deletedNow = ctx.tombstones();
      const dropped = active.filter(c => !committed.has(c.id) && !deletedNow.has(c.id));
      if (dropped.length) {
        record.capped = [...(record.capped || []), ...dropped.map(c => ({ id: c.id, title: c.title }))]
          .filter((c, index, rows) => rows.findIndex(row => row.id === c.id) === index);
        save();
      }
    }
  }
  // A deleted imported chat may have left a file when its own unlink failed.
  // Remove only what this import published, only if tombstoned and still absent from durable lists.
  const visible = ctx.persistedChatIds(), deleted = ctx.tombstones();
  for (const file of record.files) {
    if (deleted.has(file.id) && !visible.has(file.id)) await ctx.transcripts.removeIf(file.id, stagedHistory(directory, file), { origin: 'remove' });
  }
  const capped = new Set((record.capped || []).map(c => c.id));
  for (const file of record.files) {
    if (capped.has(file.id)) await ctx.transcripts.removeIf(file.id, stagedHistory(directory, file), { origin: 'remove' });
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
    if (typeof ctx.transcripts?.write !== 'function') throw Error('the transcript store is not available: nothing is imported (Node never writes a transcript itself)');
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
