'use strict';
// The project routes: create, delete and configure a project; its instruction skills; its
// chat metas; and every way a source reaches it — a pasted document, an upload into the
// project's own folder, an image asset, a folder sync — plus the asynchronous job wrapper
// around the slow ones. The store itself is projects.cjs; this file is the HTTP surface.
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Blocks are mounted in their original order and an unmatched method falls through, so a
// PUT on a GET/POST path still reaches the static fallback exactly as it did inline.

// An image source is bytes, not text, and needs its own limits.
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_UPLOAD_CAP = 8 * 1024 * 1024;
const DOCUMENT_UPLOAD_CAP = 25 * 1024 * 1024;
const MAX_PROJECT_IMAGES = 12;

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req, limit?:number) => Promise<string>} deps.readBody
 * @param {(req) => Promise<any>} deps.readJson
 * @param {object} deps.requestScope         AsyncLocalStorage: sourceProgress rides on it
 * @param {(req, res) => Promise<any>} deps.dispatch   the whole router, for background source jobs
 * @param {() => object} deps.currentWorkspace
 * @param {object} deps.authService
 * @param {object} deps.storageClient
 * @param {object} deps.documents
 * @param {object} deps.documentSources
 * @param {object} deps.rag
 * @param {object} deps.fs
 * @param {object} deps.path
 * @param {object} deps.reasoningEffort
 * @param {(body:object) => object} deps.projectAppearance
 * @param {object} deps.diaryExtras
 * @param {object[]} deps.PROJECTS
 * @param {string[]} deps.DEFAULT_TOOLBOXES
 * @param {(boxes:any) => string[]|null} deps.sanitizeToolboxes
 * @param {(id:string) => object|null} deps.getProvider
 * @param {() => void} deps.ensureRolesLoaded
 * @param {object} deps.store   projects.cjs
 */
function createProjectRoutes({
  json, readBody, readJson, requestScope, dispatch, currentWorkspace, authService, storageClient, documents, documentSources, rag, fs, path,
  reasoningEffort, projectAppearance, diaryExtras, PROJECTS, DEFAULT_TOOLBOXES, sanitizeToolboxes, getProvider, ensureRolesLoaded, store,
}) {
  const {
    getProject, saveProjects, createProject, pruneDocuments, sweepDeletedProject, withSourceLock, ensureProjectFolder, indexSource, ownsFile,
    loadChats, saveChats, deleteChat,
  } = store;

  async function handle(req, res, { path: p, authn, url }) {
    // Opt-in asynchronous source processing; the synchronous API remains compatible.
    const sourceJob = p.match(/^\/api\/projects\/([^/]+)\/source-jobs\/([^/]+)$/);
    if (sourceJob && req.method === 'GET') {
      const projectId = decodeURIComponent(sourceJob[1]);
      if (!getProject(projectId)) return json(res, 404, { error: 'project not found' });
      const job = require('../source-jobs.cjs').read(currentWorkspace(), projectId, sourceJob[2]);
      return json(res, job ? 200 : 404, job || { error: 'Processing status expired or the server restarted; refresh or re-upload to retry.' });
    }
    const backgroundSource = p.match(/^\/api\/projects\/([^/]+)\/(upload|documents|sources\/sync)$/);
    if (backgroundSource && req.method === 'POST' && url.searchParams.get('background') === '1') {
      const projectId = decodeURIComponent(backgroundSource[1]);
      if (!getProject(projectId)) return json(res, 404, { error: 'project not found' });
      const body = JSON.parse(await readBody(req, Math.ceil((backgroundSource[2] === 'upload' ? require('../pdf-reduce.cjs').INPUT_CAP : DOCUMENT_UPLOAD_CAP) / 3) * 4 + 512 * 1024));
      const jobId = require('../source-jobs.cjs').start(currentWorkspace(), projectId, async (progress) => {
        const inner = require('node:stream').Readable.from([Buffer.from(JSON.stringify(body))]);
        Object.assign(inner, { method: req.method, url: p, headers: req.headers, socket: req.socket });
        let status = 500, data = '';
        await requestScope.run({ ...requestScope.getStore(), sourceProgress: progress }, () => dispatch(inner, { setHeader() {}, writeHead(code) { status = code; }, end(value) { data = String(value || '{}'); } }));
        return { status, body: JSON.parse(data) };
      });
      return json(res, 202, { poll: `/api/projects/${encodeURIComponent(projectId)}/source-jobs/${jobId}` });
    }

    const freeContext = /^\/api\/chats\/([^/]+)\/context$/.exec(p);
    if (freeContext && ['GET', 'POST'].includes(req.method)) {
      const id = diaryExtras.chatProjectId(decodeURIComponent(freeContext[1]));
      if (!id) return json(res, 400, { error: 'Invalid chat identifier' });
      let project = getProject(id);
      if (!project && req.method === 'POST') {
        project = { ...diaryExtras.newProject(), id, name: 'Chat attachments ' + freeContext[1], instructions: '', toolboxes: [...DEFAULT_TOOLBOXES] };
        PROJECTS.push(project); saveProjects(PROJECTS);
      }
      return json(res, 200, { project });
    }

    if (p === '/api/diary/context' && ['GET', 'POST'].includes(req.method)) {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      let project = getProject(diaryExtras.PROJECT_ID);
      if (!project && req.method === 'POST') {
        // Publish synchronously before awaiting storage to prevent duplicate contexts.
        project = diaryExtras.newProject();
        PROJECTS.push(project); saveProjects(PROJECTS);
      }
      return json(res, 200, { project });
    }

    if (p === '/api/projects' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      try { return json(res, 200, await createProject(body)); }
      catch (e) { if (e.status === 400) return json(res, 400, { error: e.message }); throw e; }
    }

    const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);
    if (projMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(projMatch[1]);
      const removedProject = getProject(id);
      const before = PROJECTS.length;
      const keptProjects = Array.from(PROJECTS).filter((pr) => pr.id !== id);
      PROJECTS.splice(0, PROJECTS.length, ...keptProjects);
      if (PROJECTS.length === before) return json(res, 404, { error: 'no such project' });
      if (removedProject) pruneDocuments(removedProject);
      saveProjects(PROJECTS);
      // Drop the project's RAG index too (best-effort).
      try {
        for (const suffix of ['.db', '.db-wal', '.db-shm']) {
          fs.rmSync(path.join(currentWorkspace().ragDir(), `${id}${suffix}`), { force: true });
        }
      } catch { /* best effort */ }
      if (removedProject) sweepDeletedProject(removedProject);
      return json(res, 200, { ok: true });
    }

    const skillRoute = p.match(/^\/api\/projects\/([^/]+)\/instruction-skills$/);
    if (skillRoute && ['GET', 'PUT'].includes(req.method)) {
      const project = getProject(decodeURIComponent(skillRoute[1]));
      if (!project) return json(res, 404, {error: 'No such project'});
      const skills = require('../instruction-skills.cjs');
      if (req.method === 'PUT') {
        try { skills.setSelection(project, await readJson(req)); }
        catch (err) { return json(res, err.status || 400, {error: err.message}); }
        project.updatedAt = Date.now();
        saveProjects(PROJECTS);
      }
      return json(res, 200, {skills: skills.list(project)});
    }

    // Plugins → Skills → Add to project: copy one published SKILL.md into the project. It lands
    // as "Review required" and stays off until the owner reviews and enables it.
    const skillInstall = p.match(/^\/api\/projects\/([^/]+)\/skills\/install$/);
    if (skillInstall && req.method === 'POST') {
      const project = getProject(decodeURIComponent(skillInstall[1]));
      if (!project) return json(res, 404, { error: 'no such project' });
      let body; try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      let content;
      try { content = await require('./plugin-directory.cjs').fetchPublishedSkill(body?.skill); } catch (e) { return json(res, e.status || 502, { error: e.message }); }
      const skills = require('../instruction-skills.cjs');
      const file = { name: `${body.skill}/SKILL.md`, content };
      const inspected = skills.inspect(file, project);
      if (!inspected?.valid) return json(res, 422, { error: `This skill cannot be used as a project skill: ${inspected?.error || 'no skill frontmatter'}` });
      const files = Array.isArray(project.files) ? project.files : [];
      if (files.filter((f) => !f.source).length >= 60 && !files.some((f) => f.name === file.name)) return json(res, 409, { error: 'This project already has the maximum of 60 files.' });
      project.files = [...files.filter((f) => f.name !== file.name), file];
      if (project.instructionSkills) delete project.instructionSkills[file.name]; // a replaced skill needs review again
      skills.reconcile(project);
      project.updatedAt = Date.now();
      currentWorkspace().saveProjects();
      return json(res, 201, { file: file.name, skills: skills.list(project).map(({ content: _c, ...rest }) => rest) });
    }
    const projCfg = p.match(/^\/api\/projects\/([^/]+)\/config$/);
    if (projCfg && req.method === 'POST') {
      const id = decodeURIComponent(projCfg[1]);
      const raw = await readBody(req);
      let patch;
      try {
        patch = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      const storedProject = getProject(id);
      if (!storedProject) return json(res, 404, { error: 'no such project' });
      let appearance;
      try { appearance = projectAppearance(patch); } catch (e) { return json(res, 400, { error: e.message }); }
      if (patch.reasoningEffort !== undefined && patch.reasoningEffort !== null && !reasoningEffort.validEffort(patch.reasoningEffort)) return json(res,400,{error:'Invalid reasoning effort'});
      const project = { ...storedProject, ...appearance };
      if (patch.reasoningEffort === null) delete project.reasoningEffort;
      else if (patch.reasoningEffort !== undefined) project.reasoningEffort = patch.reasoningEffort;
      if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim().slice(0, 120);
      if (typeof patch.goal === 'string') project.goal = patch.goal.slice(0, 2000);
      if (typeof patch.instructions === 'string') project.instructions = patch.instructions.slice(0, 8000);
      if (typeof patch.model === 'string' && patch.model) project.model = patch.model;
      // Pin and archive are plain booleans rather than a status enum: a project
      // can be both pinned and archived, and collapsing them would lose that.
      if (typeof patch.pinned === 'boolean') project.pinned = patch.pinned;
      if (Array.isArray(patch.sourceFolders)) {
        project.sourceFolders = patch.sourceFolders
          .filter((f) => typeof f === 'string' && f.trim())
          .map((f) => storageClient.safeRelativePath(f))
          .filter(Boolean)
          .slice(0, 10);
      }
      if (typeof patch.archived === 'boolean') project.archived = patch.archived;
      if (patch.modes !== undefined) {
        try { project.modes = require('../project-modes.cjs').sanitize(patch.modes); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (typeof patch.routing === 'string') {
        if (patch.routing !== 'auto' && patch.routing !== 'manual') {
          return json(res, 400, { error: "routing must be 'auto' or 'manual'" });
        }
        project.routing = patch.routing;
        if (patch.routing === 'auto') ensureRolesLoaded(); // no-op if unconfigured
      }
      if (typeof patch.provider === 'string' && patch.provider) {
        if (!getProvider(patch.provider)) return json(res, 400, { error: 'no such provider' });
        project.provider = patch.provider;
      }
      if (patch.toolboxes !== undefined) {
        const boxes = sanitizeToolboxes(patch.toolboxes);
        if (!boxes) return json(res, 400, { error: 'toolboxes must be an array of toolbox ids' });
        project.toolboxes = boxes;
      }
      if (Array.isArray(patch.memories)) {
        project.memories = patch.memories.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim().slice(0, 500)).slice(0, 50);
      }
      if (Array.isArray(patch.files)) {
        const prevFiles = Array.isArray(project.files) ? project.files : [];
        // Folder-derived files belong to the sync, not to this patch. The
        // client only ever sends uploads, and a patch that dropped the
        // folder-derived ones would silently detach every synced source (or,
        // if the client echoed them back with empty content, blank them).
        const fromFolders = prevFiles.filter((f) => f && f.source);
        const uploads = patch.files
          .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string' && !f.source)
          .slice(0, Math.max(0, 60 - fromFolders.length))
          .map((f) => {
            const existing = prevFiles.find(p => !p.source && p.name === f.name);
            return existing?.document || existing?.attachment ? existing : { name: f.name.slice(0, 200), content: f.content.slice(0, 200000) };
          });
        project.files = [...fromFolders, ...uploads];
        // RAG bookkeeping (step 10): drop chunks for removed files; index
        // new/changed ones. Fire-and-forget — upload latency must not depend
        // on embedding round-trips.
        const prevByName = new Map(prevFiles.map((f) => [f.name, f]));
        const nextNames = new Set(project.files.map((f) => f.name));
        project.assets = (project.assets || []).filter(a => !a.sourceName || nextNames.has(a.sourceName));
        for (const prev of prevFiles) {
          if (!nextNames.has(prev.name)) rag.deleteProjectFile(id, prev.name, currentWorkspace().userId);
        }
        for (const next of project.files) {
          const prev = prevByName.get(next.name);
          if (!prev || prev.content !== next.content) {
            indexSource(project, next);
          }
        }
      }
      project.updatedAt = Date.now();
      Object.assign(storedProject, project);
      saveProjects(PROJECTS);
      pruneDocuments(storedProject);
      return json(res, 200, { ok: true });
    }

    const projChats = p.match(/^\/api\/projects\/([^/]+)\/chats$/);
    if (projChats) {
      const id = decodeURIComponent(projChats[1]);
      if (req.method === 'GET') return json(res, 200, { chats: loadChats(id) });
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          const body = JSON.parse(raw);
          if (!Array.isArray(body.chats)) return json(res, 400, { error: 'chats array required' });
          saveChats(
            id,
            body.chats
              .filter((c) => c && typeof c.id === 'string')
              .slice(0, require('../chat-lists.cjs').LIST_CAP)
              .map((c) => ({
                id: c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
                title: String(c.title || 'New task').slice(0, 120),
                updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
                preview: String(c.preview || '').slice(0, 200),
                pinned: c.pinned === true,
                archived: c.archived === true,
              })),
          );
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
    }

    // Re-read every attached storage folder and refresh the project's sources
    // from it. Folder-derived files carry `source`; uploaded ones do not, so a
    // sync replaces what came from folders and never touches an upload. This
    // is what makes an attached folder live rather than a one-time copy.
    // ── Image sources ────────────────────────────────────────────────────
    //
    // A project source is otherwise text, because that is all a chat could
    // ever read. Images are different: the model can genuinely see them, so
    // they are stored as bytes and attached to the conversation as image
    // parts rather than being decoded into replacement characters.
    // A document uploaded from disk. It is converted to text on arrival and
    // stored as an ordinary source, so everything downstream — RAG, the
    // read_project_file tool, the manifest — treats it like any other file.
    const projDocs = p.match(/^\/api\/projects\/([^/]+)\/documents$/);
    if (projDocs && req.method === 'POST') {
      const id = decodeURIComponent(projDocs[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      let body;
      try {
        body = JSON.parse(await readBody(req, Math.ceil(DOCUMENT_UPLOAD_CAP / 3) * 4 + 512 * 1024));
      } catch (e) {
        if (e && e.status === 413) return json(res, 413, { error: `That document is larger than the ${Math.round(DOCUMENT_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
        return json(res, 400, { error: 'invalid JSON' });
      }
      const name = String(body.name || '').slice(0, 200);
      if (!documents.isDocument(name)) return json(res, 400, { error: `${name || 'that file'} is not a supported document (PDF).` });
      let bytes;
      try { bytes = Buffer.from(String(body.dataBase64 || ''), 'base64'); } catch { bytes = null; }
      if (!bytes || !bytes.length) return json(res, 400, { error: 'document data was empty' });
      if (bytes.length > DOCUMENT_UPLOAD_CAP) {
        return json(res, 413, { error: `That document is ${Math.round(bytes.length / 1024 / 1024)} MB, over the ${Math.round(DOCUMENT_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
      }
      return await withSourceLock(project, async () => {
        if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
        const uploads = (project.files || []).filter(f => !f.source);
        if (uploads.length >= 20 && !uploads.some(f => f.name === name)) return json(res, 400, { error: 'A project holds at most 20 uploaded sources.' });
        const previous = uploads.find(f => f.name === name);
        const file = await documentSources.ingest(currentWorkspace(), id, name, bytes, previous);
        if (getProject(id) !== project || project.files.find(f => !f.source && f.name === name) !== previous) return json(res, 409, { error: 'Project changed; retry.' });
        project.files = [...(project.files || []).filter(f => f.source || f.name !== name), file];
        indexSource(project, file); saveProjects(PROJECTS);
        return json(res, 200, { name, pages: file.document.pages, characters: file.content.length, truncated: file.document.truncated, document: file.document });
      });
    }

    const docRead = p.match(/^\/api\/projects\/([^/]+)\/documents\/(pages|original)$/);
    if (docRead && req.method === 'GET') {
      const id = decodeURIComponent(docRead[1]);
      const project = getProject(id);
      const file = project?.files?.find(f => f.name === url.searchParams.get('name'));
      if (!file?.document) return json(res, 404, { error: 'no such document' });
      try {
        if (docRead[2] === 'pages') {
          const start = Number(url.searchParams.get('startPage') || 1);
          return json(res, 200, documentSources.readPages(currentWorkspace(), id, file, start,
            Number(url.searchParams.get('endPage') || start), Number(url.searchParams.get('offset') || 0)));
        }
        const bytes = documentSources.readOriginal(currentWorkspace(), id, file);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name.split('/').pop()),
          'Content-Length': bytes.length, 'Cache-Control': 'private, no-store' });
        return res.end(bytes);
      } catch (err) { return json(res, err.status || 422, { error: err.status ? err.message : 'Saved document data is unavailable; upload or refresh again.' }); }
    }

    // Upload a file into the project's own folder. Text and PDFs both land as
    // real files in the user's storage; the sync that follows converts them
    // into sources, so there is exactly one path from a file to a source
    // regardless of whether it arrived from this machine or was dropped into
    // the folder from anywhere else.
    const projUpload = p.match(/^\/api\/projects\/([^/]+)\/upload$/);
    if (projUpload && req.method === 'POST') {
      const id = decodeURIComponent(projUpload[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      let body;
      try {
        body = JSON.parse(await readBody(req, Math.ceil(require('../pdf-reduce.cjs').INPUT_CAP / 3) * 4 + 512 * 1024));
      } catch (e) {
        if (e && e.status === 413) return json(res, 413, { error: `That file is larger than the ${Math.round(DOCUMENT_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
        return json(res, 400, { error: 'invalid JSON' });
      }
      const rawName = String(body.name || '').split('/').pop().slice(0, 200);
      if (!rawName) return json(res, 400, { error: 'a filename is required' });
      const isText = storageClient.TEXT_EXTENSIONS.has((rawName.slice(rawName.lastIndexOf('.')) || '').toLowerCase());
      if (body.organized === true) {
        const uploads = require('../uploads.cjs');
        const inputName = String(body.name || '');
        const inputBytes = Buffer.from(String(body.dataBase64 || ''), 'base64');
        // Validate the filename before contacting the document processor.
        uploads.validate(inputName, inputBytes.subarray(0,1));
        return await withSourceLock(project, async () => {
          if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
          const connection = authService.getStorage(authn.user.id, true);
          const remote = storageClient.isBrowsable(connection) ? connection : null;
          const progress = requestScope.getStore()?.sourceProgress || (() => {});
          const {name,bytes,reduction} = await require('../pdf-reduce.cjs').prepare(inputName,inputBytes,{progress});
          uploads.validate(name,bytes);
          if (remote && !project.projectFolder) {
            progress('Creating upload folder');
            project.projectFolder = await ensureProjectFolder(project);
            if (!project.projectFolder) return json(res, 502, { error: 'Could not create the storage folder; retry.' });
          }
          const file = await uploads.ingest(currentWorkspace(), project, name, bytes, { connection: remote, progress });
          if(reduction){file.attachment.reduction=reduction;file.attachment.reason=[file.attachment.reason,reduction.note].filter(Boolean).join(' ');}
          if (getProject(id) !== project) return json(res, 409, { error: 'Project removed during upload.' });
          if (remote) project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
          project.files = [...(project.files || []).filter(f => f.name !== file.name), file];
          project.updatedAt = Date.now();
          progress('Indexing extracted text');
          indexSource(project, file);
          saveProjects(PROJECTS);
          return json(res, 200, { name, path: file.name, bytes: bytes.length, document: file.document, attachment: file.attachment });
        });
      }
      if (!isText && !documents.isDocument(rawName)) {
        return json(res, 400, { error: `${rawName} is not a supported source (text file or PDF).` });
      }
      let bytes;
      try { bytes = Buffer.from(String(body.dataBase64 || ''), 'base64'); } catch { bytes = null; }
      if (!bytes || !bytes.length) return json(res, 400, { error: 'file was empty' });
      if (bytes.length > DOCUMENT_UPLOAD_CAP) return json(res, 413, { error: 'File exceeds the 25 MB limit.' });
      return await withSourceLock(project, async () => {
        if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
        const connection = authService.getStorage(authn.user.id, true);
        if (!storageClient.isBrowsable(connection)) {
          // Remote storage is optional. Keep local uploads as project sources,
          // including PDF extraction, for installations without a cloud account.
          const uploads = (project.files || []).filter((f) => !f.source);
          if (uploads.length >= 20 && !uploads.some((f) => f.name === rawName)) {
            return json(res, 400, { error: 'A project holds at most 20 uploaded sources.' });
          }
          const previous = uploads.find(f => f.name === rawName);
          const file = documents.isDocument(rawName)
            ? await documentSources.ingest(currentWorkspace(), id, rawName, bytes, previous)
            : { name: rawName, content: bytes.toString('utf8').slice(0, 200000) };
          if (getProject(id) !== project || (project.files || []).find(f => !f.source && f.name === rawName) !== previous) return json(res, 409, { error: 'Source changed; retry.' });
          project.files = [...(project.files || []).filter(f => f.source || f.name !== rawName), file];
          project.updatedAt = Date.now();
          indexSource(project, file); saveProjects(PROJECTS);
          return json(res, 200, { name: rawName, path: rawName, bytes: bytes.length, document: file.document });
        }
        if (!project.projectFolder) {
          const folder = await ensureProjectFolder(project);
          if (!folder) return json(res, 502, { error: 'Could not create the project storage folder. Check your storage connection and retry.' });
          project.projectFolder = folder;
        }
        project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
        saveProjects(PROJECTS);
        try {
          await storageClient.writeFile(connection, `${project.projectFolder}/${rawName}`, bytes);
        } catch (e) {
          return json(res, (e && e.status) || 502, { error: (e && e.message) || 'could not save the file' });
        }
        let file;
        if (documents.isDocument(rawName)) {
          const name = `${project.projectFolder}/${rawName}`;
          const previous = project.files.find(f => f.name === name && f.source === project.projectFolder);
          file = await documentSources.ingest(currentWorkspace(), id, name, bytes, previous);
          file.source = project.projectFolder;
          if (getProject(id) !== project || !project.sourceFolders.includes(file.source)) return json(res, 409, { error: 'Source changed; refresh again.' });
          project.files = [...project.files.filter(f => f.name !== name || f.source !== file.source), file];
          indexSource(project, file); saveProjects(PROJECTS);
        }
        return json(res, 200, { name: rawName, path: `${project.projectFolder}/${rawName}`, bytes: bytes.length, document: file?.document });
      });
    }

    // Delete one source file from the project's folder. This removes the file
    // from the user's storage, not merely from the project, so it is confined
    // to the project's OWN folder: a source pulled from a folder the user
    // attached for reading must never be deletable from here.
    const projFileDel = p.match(/^\/api\/projects\/([^/]+)\/files$/);
    if (projFileDel && req.method === 'DELETE') {
      const id = decodeURIComponent(projFileDel[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      const body = await readJson(req);
      const target = String(body.path || '');
      if (!target) return json(res, 400, { error: 'a path is required' });
      if (!ownsFile(project, target)) {
        return json(res, 400, { error: 'That file is not in any folder attached to this project, so it cannot be deleted from here.' });
      }
      return await withSourceLock(project, async () => {
        if (getProject(id) !== project || !ownsFile(project, target)) return json(res, 409, { error: 'Source changed; retry.' });
        const connection = authService.getStorage(authn.user.id, true);
        if (!storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connected' });
        try {
          await storageClient.deleteFile(connection, target);
        } catch (e) {
          return json(res, (e && e.status) || 502, { error: (e && e.message) || 'could not delete the file' });
        }
        project.files = (project.files || []).filter((f) => f.name !== target);
        pruneDocuments(project);
        require('../uploads.cjs').prune(currentWorkspace(), project);
        saveProjects(PROJECTS);
        rag.deleteProjectFile(id, target, currentWorkspace().userId);
        return json(res, 200, { ok: true, path: target });
      });
    }

    const originalUpload = p.match(/^\/api\/projects\/([^/]+)\/uploads\/original$/);
    if (originalUpload && req.method === 'GET') {
      const project = getProject(decodeURIComponent(originalUpload[1]));
      const file = project?.files.find(f => f.name === url.searchParams.get('name') && f.attachment);
      if (!file) return json(res, 404, { error: 'No such original' });
      const bytes = fs.readFileSync(require('../uploads.cjs').original(currentWorkspace(), project.id, file));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name.split('/').pop())}`, 'Cache-Control': 'private, no-store', 'Content-Length': bytes.length });
      return res.end(bytes);
    }

    const projAssets = p.match(/^\/api\/projects\/([^/]+)\/assets$/);
    if (projAssets && req.method === 'POST') {
      const id = decodeURIComponent(projAssets[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      let body;
      try {
        // Images do not fit the 1 MB default that text sources live under.
        body = JSON.parse(await readBody(req, Math.ceil(IMAGE_UPLOAD_CAP / 3) * 4 + 512 * 1024));
      } catch (e) {
        if (e && e.status === 413) return json(res, 413, { error: `That image is larger than the ${Math.round(IMAGE_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
        return json(res, 400, { error: 'invalid JSON' });
      }
      const name = String(body.name || '').slice(0, 200);
      const mime = String(body.mime || '').toLowerCase();
      if (!IMAGE_MIME.has(mime)) {
        return json(res, 400, { error: `${mime || 'that file'} is not a supported image (png, jpeg, webp or gif).` });
      }
      let bytes;
      try {
        bytes = Buffer.from(String(body.dataBase64 || ''), 'base64');
      } catch {
        return json(res, 400, { error: 'image data was not valid base64' });
      }
      if (!bytes.length) return json(res, 400, { error: 'image data was empty' });
      if (bytes.length > IMAGE_UPLOAD_CAP) {
        return json(res, 413, { error: `That image is ${Math.round(bytes.length / 1024)} KB, over the ${Math.round(IMAGE_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
      }
      const assets = Array.isArray(project.assets) ? project.assets : [];
      if (assets.length >= MAX_PROJECT_IMAGES) {
        return json(res, 400, { error: `A project holds at most ${MAX_PROJECT_IMAGES} images.` });
      }
      const assetId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const dir = currentWorkspace().assetDir(id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, assetId), bytes, { mode: 0o600 });
      project.assets = [...assets, { id: assetId, name, mime, bytes: bytes.length }];
      saveProjects(PROJECTS);
      return json(res, 200, { asset: { id: assetId, name, mime, bytes: bytes.length } });
    }

    const projAssetOne = p.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
    if (projAssetOne) {
      const id = decodeURIComponent(projAssetOne[1]);
      const assetId = decodeURIComponent(projAssetOne[2]).replace(/[^a-zA-Z0-9_-]/g, '');
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      const asset = (project.assets || []).find((a) => a.id === assetId);
      if (!asset) return json(res, 404, { error: 'no such image' });
      const file = path.join(currentWorkspace().assetDir(id), assetId);
      if (req.method === 'GET') {
        let bytes;
        try { bytes = fs.readFileSync(file); } catch { return json(res, 404, { error: 'image data is missing' }); }
        res.writeHead(200, {
          'Content-Type': asset.mime,
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=86400',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(bytes);
      }
      if (req.method === 'DELETE') {
        project.assets = (project.assets || []).filter((a) => a.id !== assetId);
        saveProjects(PROJECTS);
        try { fs.unlinkSync(file); } catch { /* already gone */ }
        return json(res, 200, { ok: true });
      }
    }

    const projSync = p.match(/^\/api\/projects\/([^/]+)\/sources\/sync$/);
    if (projSync && req.method === 'POST') {
      const id = decodeURIComponent(projSync[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      return await withSourceLock(project, async () => {
        if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
        const connection = authService.getStorage(authn.user.id, true);
        const fromFolders = [];
        const sourceLimit = Math.max(0, 60 - (project.files || []).filter(f => !f.source).length);
        const skipped = [];
        if (storageClient.isBrowsable(connection) && (project.assets || []).some(a => !a.sourceName)) {
          if (!project.projectFolder) project.projectFolder = await ensureProjectFolder(project);
          if (project.projectFolder) {
            for (const asset of [...(project.assets || [])].filter(a => !a.sourceName)) {
              try {
                const bytes = fs.readFileSync(path.join(currentWorkspace().assetDir(id), asset.id));
                // A stable suffix prevents overwriting a file already placed there outside noevia.
                const dot = asset.name.lastIndexOf('.');
                const name = dot > 0 ? `${asset.name.slice(0,dot)}-${asset.id}${asset.name.slice(dot)}` : `${asset.name}-${asset.id}`;
                const file = await require('../uploads.cjs').ingest(currentWorkspace(), project, name, bytes, { connection, progress: requestScope.getStore()?.sourceProgress });
                project.files = [...(project.files || []).filter(f => f.name !== file.name), file];
                project.assets = project.assets.filter(a => a.id !== asset.id);
                project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
                saveProjects(PROJECTS);
              } catch (err) { skipped.push({ folder: project.projectFolder, file: asset.name, reason: 'Image remains in noevia: ' + err.message, retained: true }); }
            }
          }
        }
        const folders = Array.isArray(project.sourceFolders) ? project.sourceFolders : [];
        if (folders.length && !storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connection is configured' });

        for (const folder of folders) {
          let entries;
          try {
            entries = await storageClient.listFiles(connection, folder);
          } catch (e) {
            const reason = e?.message || 'could not list folder';
            const previous = (project.files || []).filter(f => f.source === folder);
            fromFolders.push(...previous.map(f => documents.isDocument(f.name) ? { ...documentSources.failed(f, f.name, reason), source: folder } : f));
            skipped.push({ folder, reason, retained: previous.some(f => !!f.content) });
            continue;
          }
          if (folder === project.projectFolder) {
            for (const entry of [...entries]) {
              if (entry.isDir && require('../uploads.cjs').GROUPS.includes(entry.name)) {
                try { entries.push(...await storageClient.listFiles(connection, entry.path)); }
                catch (err) { fromFolders.push(...(project.files || []).filter(f => f.source === folder && f.name.startsWith(entry.path + '/'))); skipped.push({ folder, file: entry.path, reason: 'Could not refresh this category; previous sources retained.', retained: true }); }
              }
            }
          }
          for (const entry of entries) {
            if (entry.isDir) continue; // one level: recursing could pull a whole drive in
            const ext = (entry.ext || '').toLowerCase();
            const isText = storageClient.TEXT_EXTENSIONS.has(ext);
            const isDoc = documents.isDocument(entry.name);
            const isDocx = /\.docx$/i.test(entry.name);
            const managed = folder === project.projectFolder && require('../uploads.cjs').GROUPS.some(g => entry.path.startsWith(`${folder}/${g}/`));
            if (!isText && !isDoc && !isDocx && !managed) continue;
            if (fromFolders.length >= sourceLimit) { skipped.push({ folder, file: entry.path, reason: '60-source project limit reached; this file was not read.', retained: false }); continue; } // a cap, so one big folder cannot blow up a project
            try {
              if (managed || isDocx) {
                const bytes = await storageClient.readBinaryFile(connection, entry.path);
                const file = await require('../uploads.cjs').ingest(currentWorkspace(), project, entry.name, bytes, { source: folder, remotePath: entry.path, progress: requestScope.getStore()?.sourceProgress });
                fromFolders.push(file);
                if (file.document && file.document.state !== 'ready') skipped.push({ folder, file: entry.path, reason: documentSources.problem(file), retained: file.document.stale });
              } else if (isDoc) {
                // A document is converted to text here, so a PDF in an attached
                // folder becomes a readable source rather than being skipped.
                const bytes = await storageClient.readBinaryFile(connection, entry.path);
                const previous = (project.files || []).find(f => f.source === folder && f.name === entry.path);
                const file = await documentSources.ingest(currentWorkspace(), id, entry.path, bytes, previous);
                fromFolders.push({ ...file, source: folder });
                if (file.document.state !== 'ready') skipped.push({ folder, file: entry.path, reason: documentSources.problem(file), retained: file.document.stale });
              } else {
                const file = await storageClient.readTextFile(connection, entry.path);
                fromFolders.push({ name: entry.path, content: file.content, source: folder });
              }
            } catch (e) {
              const previous = (project.files || []).find((f) => f.source === folder && f.name === entry.path);
              const reason = e?.message || 'could not read';
              if (isDoc) fromFolders.push({ ...documentSources.failed(previous, entry.path, reason), source: folder });
              else if (previous) fromFolders.push(previous);
              skipped.push({ folder, file: entry.path, reason, retained: !!previous?.content });
            }
          }
        }
        if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
        const prev = Array.isArray(project.files) ? project.files : [];
        // An upload or folder edit may have completed while storage was being
        // read. Preserve current uploads and never reattach a detached folder.
        const currentFolders = new Set(project.sourceFolders || []);
        const uploaded = prev.filter((f) => !f.source);
        const untouched = prev.filter((f) => f.source && currentFolders.has(f.source) && !folders.includes(f.source));
        const synced = fromFolders.filter((f) => currentFolders.has(f.source));
        project.files = [...uploaded, ...untouched, ...synced].slice(0, 60);
        require('../uploads.cjs').prune(currentWorkspace(), project);
        saveProjects(PROJECTS);
        // Same RAG bookkeeping the config patch does: drop chunks for files that
        // are gone, re-index the ones that arrived or changed.
        const prevByName = new Map(prev.map((f) => [f.name, f]));
        const nextNames = new Set(project.files.map((f) => f.name));
        for (const old of prev) {
          if (!nextNames.has(old.name)) rag.deleteProjectFile(id, old.name, currentWorkspace().userId);
        }
        for (const next of project.files) {
          const before = prevByName.get(next.name);
          if (!before || before.content !== next.content || (next.document && ['pending', 'failed', 'unavailable', 'partial'].includes(next.document.indexing))) {
            indexSource(project, next);
          }
        }
        return json(res, 200, {
          files: project.files.map((f) => ({ name: f.name, source: f.source || null, bytes: f.content.length, document: f.document })),
          skipped,
        });
      });
    }

    const chatDel = p.match(/^\/api\/projects\/([^/]+)\/chats\/([^/]+)$/);
    if (chatDel && req.method === 'DELETE') {
      const projectId = decodeURIComponent(chatDel[1]);
      const chatId = decodeURIComponent(chatDel[2]);
      const removed = deleteChat(projectId, chatId);
      return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no such chat' });
    }

    return PASS;
  }

  return async function projectRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createProjectRoutes, DOCUMENT_UPLOAD_CAP, IMAGE_UPLOAD_CAP, IMAGE_MIME, MAX_PROJECT_IMAGES };
