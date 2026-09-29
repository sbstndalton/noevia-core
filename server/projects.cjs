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

// The name length cap (#398) lives in one JSON file so the create/edit dialogs
// (src/project-limits.ts) enforce the same limit the server applies here and in
// routes/projects.cjs's PATCH handler.
const { nameMaxLength: PROJECT_NAME_MAX_LENGTH } = require('./project-limits.json');

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
    currentWorkspace().assertActive?.();
    for (const project of projects) require("./instruction-skills.cjs").reconcile(project);
    currentWorkspace().projects = Array.from(projects);
    currentWorkspace().saveProjects();
  }

  function getProject(id) {
    if (currentWorkspace().revoked) return null;
    const project = PROJECTS.find((p) => p.id === id) || null;
    // One-time self-heal for a standalone chat's shadow context project created before #352 was
    // fixed: it always inherited Diary's routing:'manual' template, with no person ever choosing
    // it (a real choice is only ever recorded by the routing PATCH, which now also sets
    // routingChosen). Once healed, or once a person picks a routing explicitly, this never
    // reruns — routingChosen is set either way.
    if (project && !project.routingChosen && project.routing === 'manual' && typeof project.id === 'string' && project.id.startsWith('cowork-chat-context-')) {
      project.routing = 'auto';
      currentWorkspace().saveProjects();
    }
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

  // Deleting a project deletes its chats too (#554): tombstone each so a late reply cannot write
  // it back, and drop the per-chat context meter and transcript. Tenant-scoped via currentWorkspace().
  function purgeProjectChats(project) {
    const workspace = currentWorkspace(), lists = require('./chat-lists.cjs'), context = require('./chat-context.cjs');
    for (const chat of project?.chats || []) {
      if (!chat || typeof chat.id !== 'string') continue;
      try { lists.addTombstone(workspace.dir, chat.id); } catch { /* best effort */ }
      try { context.remove(workspace.dir, chat.id); } catch { /* best effort */ }
      try { fs.unlinkSync(workspace.historyPath(chat.id)); } catch { /* no history file - fine */ }
    }
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
    const name = String(body.name || '').trim().slice(0, PROJECT_NAME_MAX_LENGTH);
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
      // Explicit choice, else the user's default (Models → Routing), else Auto (the user's call,
      // 2026-09-21). Unconfigured Auto uses the project model.
      routing: body.routing === 'manual' || body.routing === 'auto' ? body.routing : currentWorkspace()?.preferences?.defaultRouting === 'manual' ? 'manual' : 'auto',
      modes,
      toolboxes: sanitizeToolboxes(body.toolboxes) || [...defaultToolboxes()], // step 14: core only by default
      // (files normalization below is shared with the config route's RAG bookkeeping)
      chats: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // Files sent with the create call are uploads: the Project documents box comes with them
    // (#659), unless the caller chose the toolboxes itself.
    if (!Array.isArray(body.toolboxes)) {
      require('./project-docs-default.cjs').applyProjectDocsDefault(project, {
        offered: (id) => (sanitizeToolboxes([id]) || []).includes(id), defaults: defaultToolboxes(), hadUploads: false });
    }
    // Reserve (name, never create) the unique folder path now so same-named projects stay distinct.
    try {
      const conn = authService.getStorage(currentWorkspace().userId, true);
      if (storageClient.isBrowsable(conn)) project.reservedFolder = require('./project-folders.cjs').reserveProjectFolder(conn, PROJECT_ROOT_FOLDER, project, PROJECTS);
    } catch { /* no storage: the first upload allocates */ }
    // The project's own storage folder is NOT created here (#589). Every upload path creates it on
    // the first upload (ensureProjectFolder) and attaches it as a source at that moment, so a
    // project that never receives a file leaves nothing behind in the user's storage.
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
    const safe = require('./chat-lists.cjs').safeChatId(spaceId);
    // Every id that sanitizes to nothing would share one file.
    if (!safe) throw Object.assign(new Error('invalid chat id'), { status: 400 });
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
    currentWorkspace().assertActive?.();
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
  //
  // Keyed by tenant + project id, not by the project object: the workspace's project list is
  // rebuilt from disk and by saves, and a lock keyed by object identity would let an upload
  // holding the old object race one that fetched the new object for the same project (#217).
  // A nested call for a key this async context already holds runs inline (re-entrant) rather
  // than queueing behind itself, which would deadlock.
  const sourceOperations = new Map(); // key -> promise tail
  const heldSourceLocks = new (require('node:async_hooks').AsyncLocalStorage)();
  function sourceLockKey(project) {
    const workspace = currentWorkspace();
    return JSON.stringify([String(workspace?.userId ?? workspace?.dir ?? ''), String(project?.id ?? '')]);
  }
  async function withSourceLock(project, operation) {
    if (!project || typeof project.id !== 'string' || !project.id) throw new Error('withSourceLock needs a project with an id');
    const key = sourceLockKey(project);
    const held = heldSourceLocks.getStore();
    if (held && held.has(key)) { currentWorkspace().assertActive?.(); return operation(); }
    const previous = sourceOperations.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => heldSourceLocks.run(new Set([...(held || []), key]), () => {
      currentWorkspace().assertActive?.();
      return operation();
    }));
    sourceOperations.set(key, next);
    try { return await next; }
    finally {
      if (sourceOperations.get(key) === next) {
        sourceOperations.delete(key);
        pruneDocuments(project);
      }
    }
  }
  function pruneDocuments(project) {
    if (sourceOperations.has(sourceLockKey(project))) return;
    const workspace = currentWorkspace();
    // The live record for this id, not the (possibly superseded) object the caller held: a
    // rebuilt project list must not make a stale reference look deleted and prune everything.
    const live = (workspace.projects || []).find((p) => p && p.id === project.id) || { id: project.id, files: [] };
    try { documentSources.prune(workspace, live); }
    catch (err) { console.warn('[documents] cleanup failed:', err.message); }
    try { require('./uploads.cjs').prune(workspace, live); }
    catch (err) { console.warn('[uploads] cleanup failed:', err.message); }
  }
  const changedInStorage = (stored) => `"${stored}" changed in storage since noevia last read it (it was edited, moved or deleted there, or storage is now a different account). Nothing was saved. Sync this project's Sources first, then try again.`;
  // #655: each way the pre-write check can fail says what actually happened. "Changed in storage,
  // sync first" is only true for a missing file or different bytes; for the rest a sync would not help.
  const editRefusal = (stored, err) => {
    const code = err && err.code, upstream = err && err.upstream;
    if (code === 'unsupported') return `"${stored}" cannot be edited in place: in-place edits are not supported on this storage type (only WebDAV / Nextcloud). Nothing was saved. Use project_create_file to write a new file instead.`;
    if (code === 'folder') return `"${stored}" is a folder in storage, not a file, so it cannot be edited. Nothing was saved.`;
    if (upstream === 401 || upstream === 403) return `Storage refused the sign-in while checking "${stored}" (${upstream}), so it was not edited. Nothing was saved. Reconnect storage in Settings → Storage and try again.`;
    if (upstream === 404 || (err && err.status === 404)) return changedInStorage(stored);
    return `Storage is unavailable right now, so "${stored}" could not be checked before editing. Nothing was saved. Try again in a moment.`;
  };
  /** Before an in-place edit of a stored file (#648): the file must still exist in storage with
   *  exactly the bytes noevia holds (sha256 === attachment.id), and the server must report an
   *  ETag, which the write is made conditional on. Without one a change landing between this
   *  check and the PUT would be overwritten, so the edit is refused (as removeEmptyFolder refuses
   *  a DELETE without one). Returns the ETag; throws otherwise. */
  async function confirmStoredVersion(connection, stored, current) {
    if (!current || !current.attachment || !/^[a-f0-9]{64}$/.test(String(current.attachment.id || ''))) throw new Error(changedInStorage(stored));
    let version, remoteBytes;
    try {
      version = await storageClient.fileVersion(connection, stored);
      if (!version.exists) throw new Error('missing');
      remoteBytes = await storageClient.readBinaryFile(connection, stored);
    } catch (err) {
      throw new Error(err && err.message === 'missing' ? changedInStorage(stored) : editRefusal(stored, err));
    }
    const digest = require('node:crypto').createHash('sha256').update(remoteBytes).digest('hex');
    if (digest !== current.attachment.id) throw new Error(changedInStorage(stored));
    if (!version.etag) throw new Error(`"${stored}" cannot be edited in place: this storage server does not report file versions (ETags), so noevia cannot make sure a change made there meanwhile is not overwritten. Nothing was saved. Use project_create_file to write a new file instead.`);
    return version.etag;
  }
  // One write path for server-authored project text files (MCP writes, research reports), the
  // same one a browser upload takes: the file lands in the project's storage folder and is
  // re-indexed identically.
  //
  // An in-place edit (#648) passes `expectName`, the stored name of the file it read, and
  // `expectContent`, the text it read. The destination is otherwise recomputed from the storage
  // connection as it is now, so with storage disconnected an upload stored at
  // `<folder>/Text/notes.md` would be written as a second, local `notes.md` (and the reverse once
  // storage is connected). So an edit is refused, with nothing written anywhere, unless the
  // destination is exactly `expectName` and that file still holds `expectContent`.
  //
  // `expectAttachment` is the attachment id (the SHA-256 of the stored bytes) of the file the edit
  // was planned against, or null for a legacy file with no attachment record. The project folder
  // is a synced source, so noevia's copy can be older than storage: someone may have changed,
  // moved or deleted the file in Nextcloud since the last sync, or storage may now be another
  // account's. So for a stored file the edit also reads it back from storage first and refuses
  // unless it still exists with exactly those bytes, then writes with If-Match on the ETag it saw,
  // so a change landing in between is refused by the server (412) instead of overwritten.
  function writeProjectTextFile(project, name, text, { expectName, expectContent, expectAttachment } = {}) {
    return withSourceLock(project, async () => {
      if (getProject(project.id) !== project) throw new Error('the project changed while writing; nothing was saved');
      const uploads = require('./uploads.cjs');
      const bytes = Buffer.from(text, 'utf8');
      uploads.validate(name, bytes);
      const edit = expectName !== undefined;
      let current = null;
      if (edit) {
        if (typeof expectName !== 'string' || !expectName) throw new Error('an edit must name the stored file it changes; nothing was saved');
        current = (project.files || []).find((f) => f.name === expectName);
        if (!current) throw new Error(`"${expectName}" is no longer in this project; nothing was saved`);
        if (expectContent !== undefined && String(current.content || '') !== expectContent) throw new Error(`"${expectName}" changed while this edit was being made; nothing was saved. Read it again and retry.`);
        // Same stored version as planned, and still fully read text: a sync that re-read the file
        // (new bytes, or now partial) in between means the plan is stale.
        const currentId = current.attachment ? current.attachment.id : null;
        if (currentId !== (expectAttachment === undefined ? null : expectAttachment) || (current.attachment && current.attachment.state !== 'ready')) {
          throw new Error(`"${expectName}" changed since this edit was prepared; nothing was saved. Sync this project's Sources, read it again and retry.`);
        }
      }
      const connection = authService.getStorage(currentWorkspace().userId, true);
      const remote = storageClient.isBrowsable(connection) ? connection : null;
      let ifMatch;
      if (edit) {
        const destination = remote && project.projectFolder ? uploads.destinationFor(project, name, { connection: remote }) : remote ? null : name;
        if (destination !== expectName) {
          throw new Error(remote
            ? `saving now would write "${destination || name}" instead of editing "${expectName}" in place; nothing was saved`
            : `"${expectName}" is kept in this project's storage, which is not connected right now, so it cannot be edited in place; nothing was saved. Reconnect storage and try again.`);
        }
        if (remote) ifMatch = await confirmStoredVersion(remote, expectName, current);
      } else if (remote && !project.projectFolder) project.projectFolder = await ensureProjectFolder(project);
      let file;
      try {
        file = await uploads.ingest(currentWorkspace(), project, name, bytes, { connection: remote, storageImpl: storageClient, ...(edit && remote ? { ifMatch } : {}) });
      } catch (err) {
        if (err && err.code === 'changed') throw new Error(changedInStorage(expectName));
        if (edit && err && err.code === 'unknown') throw new Error(`The connection to storage failed while saving "${expectName}", so noevia cannot tell whether the edit landed. Outcome unknown: sync this project's Sources to check whether it was saved before trying again.`);
        throw err;
      }
      if (edit && file.name !== expectName) throw new Error(`the edit was stored as "${file.name}", not "${expectName}"; the project list was not changed`);
      if (getProject(project.id) !== project) throw new Error('the project was removed while writing; the project list was not changed');
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
    workspace.assertActive?.();
    if (require('./instruction-skills.cjs').inspect(file, project) || !file.content || require('./source-readability.cjs').isUnreadable(file)) {
      if (file.document) file.document.indexing = 'unavailable';
      rag.deleteProjectFile(project.id, file.name, workspace.userId);
      return;
    }
    if (file.document) file.document.indexing = 'pending';
    rag.indexProjectFile(project.id, file.name, file.content, workspace.userId).then(result => {
      if (workspace.revoked) return;
      if (!workspace.projects.includes(project) || !project.files.includes(file) || !file.document) return;
      file.document.indexing = !result?.ok ? 'unavailable' : result.direct ? 'direct' : result.embedded < result.stored ? 'partial' : 'ready';
      workspace.saveProjects();
    }).catch((error) => {
      if (workspace.revoked) return;
      console.warn(`[documents] indexing ${project.id}/${file.name} failed:`, error?.stack || error);
      if (workspace.projects.includes(project) && project.files.includes(file) && file.document) {
        file.document.indexing = 'failed';
        try { workspace.saveProjects(); } catch (err) { console.warn('[documents] could not save index state:', err.message); }
      }
    });
  }

  return {
    saveProjects, getProject, sanitizeChats, loadChats, saveChats, deleteChat, purgeProjectChats, saveFreeChats, deleteFreeChat, createProject,
    historyPath, readHistory, writeHistory,
    ownsFile, ensureProjectFolder, withSourceLock, pruneDocuments, writeProjectTextFile, sweepDeletedProject, indexSource,
  };
}

module.exports = { createProjectStore };
