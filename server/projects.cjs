'use strict';
// ── Projects: the per-user store and everything that changes it ───────────
// A project is instructions, files, memories and a model; its chats are
// history keys. This module owns the accessors (getProject, the chat metas,
// the free-chat list, the transcript files) and the source pipeline: the
// project folder in the user's storage, the per-project source lock, the RAG
// bookkeeping and the cleanup that follows a delete.
//
// PROJECTS and FREE_CHATS are the request-scoped array views index.cjs
// builds over the current workspace; everything else is injected so the
// store can be exercised with fakes (projects.test.cjs).

/**
 * @param {object} deps
 * @param {object} deps.fs
 * @param {object} deps.path
 * @param {object} deps.reasoningEffort
 * @param {(body:object) => object} deps.projectAppearance
 * @param {object} deps.rag
 * @param {object} deps.storageClient
 * @param {object} deps.documentSources
 * @param {object} deps.authService
 * @param {() => object} deps.currentWorkspace
 * @param {object[]} deps.PROJECTS       request-scoped view of the workspace's projects
 * @param {object[]} deps.FREE_CHATS     request-scoped view of the workspace's free chats
 * @param {(boxes:any) => string[]|null} deps.sanitizeToolboxes
 * @param {() => string[]} deps.defaultToolboxes
 * @param {string} deps.PROJECT_ROOT_FOLDER
 * @param {(storage, connection, root, project) => Promise<string>} deps.createProjectFolder
 * @param {{ afterDelete: (args:object) => Promise<any> }} deps.projectSweep
 */
function createProjectStore({
  fs, path, reasoningEffort, projectAppearance, rag, storageClient, documentSources, authService, currentWorkspace,
  PROJECTS, FREE_CHATS, sanitizeToolboxes, defaultToolboxes, PROJECT_ROOT_FOLDER, createProjectFolder, projectSweep,
}) {
  // ── Projects config: instructions, files, memories, model ─────────────────

  function saveProjects(projects) {
    for (const project of projects) require("./instruction-skills.cjs").reconcile(project);
    currentWorkspace().projects = Array.from(projects);
    currentWorkspace().saveProjects();
  }

  function getProject(id) {
    const project = PROJECTS.find((p) => p.id === id) || null;
    if (project && require('./instruction-skills.cjs').reconcile(project)) currentWorkspace().saveProjects();
    return project;
  }

  // Chats are history keys; each project holds ordered chat metadata.
  // Self-heal orphaned placeholder entries: a bare chat-id string (or any
  // non-object) can land in chats[] if the follow-up POST /chats never fires
  // (tab closed mid-send). Every path that hands chat metas to a client must go
  // through this — the client spreads these into objects and reads .title, so a
  // bare string reaches the sidebar as a title-less record and throws, blanking
  // the whole app. The next saveChats drops them from disk for good.
  function sanitizeChats(chats) {
    return (chats || []).filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
  }

  // Each meta: { id, title, updatedAt } — the title is the first user message.
  function loadChats(projectId) {
    const p = getProject(projectId);
    if (!p) return [];
    return sanitizeChats(p.chats);
  }

  function saveChats(projectId, chats) {
    const p = getProject(projectId);
    if (!p) return;
    const lists = require('./chat-lists.cjs');
    p.chats = lists.mergeChats(p.chats, chats, lists.readTombstones(currentWorkspace().dir));
    saveProjects(PROJECTS);
  }

  function deleteChat(projectId, chatId) {
    const p = getProject(projectId);
    if (!p) return false;
    const before = (p.chats || []).length;
    p.chats = (p.chats || []).filter((c) => c.id !== chatId);
    if (p.chats.length === before) return false;
    require('./chat-lists.cjs').addTombstone(currentWorkspace().dir, chatId);
    saveProjects(PROJECTS);
    try {
      require('./chat-context.cjs').remove(currentWorkspace().dir,chatId);
      fs.unlinkSync(currentWorkspace().historyPath(chatId));
    } catch {
      /* no history file — fine */
    }
    return true;
  }

  // Free (non-project) chat metas — persisted server-side so recent chats
  // survive across browsers/devices (localStorage was the only home before).
  function saveFreeChats(list) {
    currentWorkspace().freeChats = Array.from(list);
    currentWorkspace().saveFreeChats();
  }

  function deleteFreeChat(chatId) {
    const before = FREE_CHATS.length;
    const filtered = Array.from(FREE_CHATS).filter((c) => c.id !== chatId);
    FREE_CHATS.splice(0, FREE_CHATS.length, ...filtered);
    if (FREE_CHATS.length === before) return false;
    require('./chat-lists.cjs').addTombstone(currentWorkspace().dir, chatId);
    saveFreeChats(FREE_CHATS);
    try {
      require('./chat-context.cjs').remove(currentWorkspace().dir,chatId);
      fs.unlinkSync(currentWorkspace().historyPath(chatId));
    } catch {
      /* no history file — fine */
    }
    return true;
  }

  // Creates, saves and indexes a project from a create request body. Throws { status: 400 } on
  // invalid input. Shared by POST /api/projects and conversation import.
  async function createProject(body) {
    if (body.reasoningEffort !== undefined && !reasoningEffort.validEffort(body.reasoningEffort)) throw Object.assign(Error('Invalid reasoning effort'), { status: 400 });
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) throw Object.assign(Error('name required'), { status: 400 });
    let modes = ['chat'];
    if (body.modes !== undefined) { try { modes = require('./project-modes.cjs').sanitize(body.modes); } catch (e) { throw Object.assign(Error(e.message), { status: 400 }); } }
    let appearance;
    try { appearance = projectAppearance(body); } catch (e) { throw Object.assign(Error(e.message), { status: 400 }); }
    const project = {
      ...appearance,
      id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      goal: String(body.goal || '').slice(0, 2000),
      instructions: String(body.instructions || '').slice(0, 8000),
      pinned: false,
      archived: false,
      sourceFolders: [],
      memories: [],
      files: Array.isArray(body.files)
        ? body.files
            .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string')
            .slice(0, 20)
            .map((f) => ({ name: f.name.slice(0, 200), content: f.content.slice(0, 200000) }))
        : [],
      model: typeof body.model === 'string' && body.model ? body.model : undefined,
      provider: typeof body.provider === 'string' && body.provider ? body.provider : undefined,
      reasoningEffort: body.reasoningEffort,
      routing: body.routing === 'manual' ? 'manual' : 'auto', // default Auto (the user's call, 2026-09-21); unconfigured Auto uses the project model
      modes,
      toolboxes: sanitizeToolboxes(body.toolboxes) || [...defaultToolboxes()], // step 14: core only by default
      // (files normalization below is shared with the config route's RAG bookkeeping)
      chats: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // Its own folder in the user's storage, and attached as a source so
    // anything dropped in it — by noevia or by the user, from any device —
    // is picked up on the next sync.
    const ownFolder = await ensureProjectFolder(project);
    if (ownFolder) {
      project.projectFolder = ownFolder;
      project.sourceFolders = [ownFolder];
    }
    PROJECTS.unshift(project);
    saveProjects(PROJECTS);
    // Index any files that arrived with the create call (same RAG bookkeeping
    // as the config route).
    for (const f of project.files) {
      indexSource(project, f);
    }
    return project;
  }

  // ── History persistence (atomic write, JSON per space) ─────────────────────

  function historyPath(spaceId) {
    const safe = String(spaceId).replace(/[^a-zA-Z0-9_-]/g, '');
    return currentWorkspace().historyPath(safe);
  }

  function readHistory(spaceId) {
    try {
      return JSON.parse(fs.readFileSync(historyPath(spaceId), 'utf8')).history || [];
    } catch {
      return [];
    }
  }

  function writeHistory(spaceId, history) {
    fs.mkdirSync(currentWorkspace().dir, { recursive: true });
    const file = historyPath(spaceId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ history }, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Whether `target` is a file this project may delete: one sitting directly in
   *  a folder the project has attached, including its own.
   *
   *  Bounded to attached folders rather than the project's own, because an
   *  attached folder's files are the user's and deleting them is their call —
   *  but a project must not be a way to delete a path it was never given.
   *  Sub-paths are refused, so a nested directory cannot be reached through a
   *  folder that merely contains it. */
  function ownsFile(project, target) {
    if (!project || typeof target !== 'string' || !target) return false;
    if ((project.files || []).some(f => f.name === target && f.attachment && f.source === project.projectFolder && require('./uploads.cjs').GROUPS.some(g => target.startsWith(`${project.projectFolder}/${g}/`) && !target.slice(`${project.projectFolder}/${g}/`.length).includes('/')))) return true;
    const folders = [
      ...(project.projectFolder ? [project.projectFolder] : []),
      ...(Array.isArray(project.sourceFolders) ? project.sourceFolders : []),
    ];
    return folders.some((folder) => {
      if (!folder) return false;
      const prefix = `${folder}/`;
      if (!target.startsWith(prefix)) return false;
      const rel = target.slice(prefix.length);
      return !!rel && !rel.includes('/') && rel !== '.' && rel !== '..';
    });
  }

  /** Create this project's folder, returning its path, or null when there is no
   *  browsable storage to put it in. Never throws: a project must still be
   *  creatable when storage is down or unconfigured. */
  async function ensureProjectFolder(project) {
    let connection;
    try {
      connection = authService.getStorage(currentWorkspace().userId, true);
    } catch {
      return null;
    }
    if (!storageClient.isBrowsable(connection)) return null;
    try {
      return await createProjectFolder(storageClient, connection, PROJECT_ROOT_FOLDER, project);
    } catch (err) {
      console.warn(`[projects] could not create folder for project ${project.id}: ${String((err && err.message) || err)}`);
      return null;
    }
  }

  // Serialize source operations within one authenticated project. Config edits
  // and deletion can still happen while waiting; recheck ownership before commit.
  const sourceOperations = new WeakMap();
  async function withSourceLock(project, operation) {
    const previous = sourceOperations.get(project) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    sourceOperations.set(project, next);
    try { return await next; }
    finally {
      if (sourceOperations.get(project) === next) {
        sourceOperations.delete(project);
        pruneDocuments(project);
      }
    }
  }
  function pruneDocuments(project) {
    if (sourceOperations.has(project)) return;
    const workspace = currentWorkspace();
    try { documentSources.prune(workspace, workspace.projects.includes(project) ? project : { id: project.id, files: [] }); }
    catch (err) { console.warn('[documents] cleanup failed:', err.message); }
    try { require('./uploads.cjs').prune(workspace, workspace.projects.includes(project) ? project : { id: project.id, files: [] }); }
    catch (err) { console.warn('[uploads] cleanup failed:', err.message); }
  }
  // One write path for server-authored project text files (MCP writes, research reports), the
  // same one a browser upload takes: the file lands in the project's storage folder and is
  // re-indexed identically.
  function writeProjectTextFile(project, name, text) {
    return withSourceLock(project, async () => {
      if (getProject(project.id) !== project) throw new Error('the project changed while writing; nothing was saved');
      const uploads = require('./uploads.cjs');
      const bytes = Buffer.from(text, 'utf8');
      uploads.validate(name, bytes);
      const connection = authService.getStorage(currentWorkspace().userId, true);
      const remote = storageClient.isBrowsable(connection) ? connection : null;
      if (remote && !project.projectFolder) project.projectFolder = await ensureProjectFolder(project);
      const file = await uploads.ingest(currentWorkspace(), project, name, bytes, { connection: remote });
      if (remote) project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
      project.files = [...(project.files || []).filter((f) => f.name !== file.name), file];
      project.updatedAt = Date.now();
      indexSource(project, file);
      saveProjects(PROJECTS);
      return file;
    });
  }
  // D8: runs after the delete is saved; empty-only, tenant-scoped, never recursive.
  function sweepDeletedProject(project) {
    const workspace = currentWorkspace();
    let connection = null;
    try { connection = project.projectFolder ? authService.getStorage(workspace.userId, true) : null; } catch { connection = null; }
    projectSweep.afterDelete({
      projectId: project.id,
      tenantRoot: workspace.dir,
      localDirs: [require('./uploads.cjs').directory(workspace, project.id), documentSources.directory(workspace, project.id), workspace.assetDir(project.id)],
      connection, folder: project.projectFolder || '', root: PROJECT_ROOT_FOLDER, groups: require('./uploads.cjs').GROUPS,
    }).catch(error => console.warn('[projects] sweep failed:', error.message));
  }
  function indexSource(project, file) {
    const workspace = currentWorkspace();
    if (require('./instruction-skills.cjs').inspect(file, project) || !file.content) {
      if (file.document) file.document.indexing = 'unavailable';
      rag.deleteProjectFile(project.id, file.name, workspace.userId);
      return;
    }
    if (file.document) file.document.indexing = 'pending';
    rag.indexProjectFile(project.id, file.name, file.content, workspace.userId).then(result => {
      if (!workspace.projects.includes(project) || !project.files.includes(file) || !file.document) return;
      file.document.indexing = !result?.ok ? 'unavailable' : result.direct ? 'direct' : result.embedded < result.stored ? 'partial' : 'ready';
      workspace.saveProjects();
    }).catch(() => {
      if (workspace.projects.includes(project) && project.files.includes(file) && file.document) {
        file.document.indexing = 'failed';
        try { workspace.saveProjects(); } catch (err) { console.warn('[documents] could not save index state:', err.message); }
      }
    });
  }

  return {
    saveProjects, getProject, sanitizeChats, loadChats, saveChats, deleteChat, saveFreeChats, deleteFreeChat, createProject,
    historyPath, readHistory, writeHistory,
    ownsFile, ensureProjectFolder, withSourceLock, pruneDocuments, writeProjectTextFile, sweepDeletedProject, indexSource,
  };
}

module.exports = { createProjectStore };
