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
// #1864: a PDF read from storage (an attached folder, or the project's own synced folder) is not refused
// for its size alone: it is read up to PROJECT_DOCUMENT_READ_BYTES (source-limits.cjs) and extracted in page
// ranges. The 25 MB cap above stays for uploads, where it bounds an HTTP body the browser sends. Other
// types keep the storage client's 25 MB read cap. The read timeout grows with the cap (30 s plus a second
// per MiB), since a quarter-gigabyte file does not arrive in 30 s.

/** Whether a project source is still the one read before an await: the same object, or (after a
 *  project-store save took the written copy back in, which replaces file objects) the same
 *  metadata. `content` is left out: it can be a lazy reader of the source's text file. */
function sameSource(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const meta = (f) => JSON.stringify(Object.keys(f).filter((k) => k !== 'content' && f[k] !== undefined).sort().map((k) => [k, f[k]]));
  return meta(a) === meta(b);
}

function documentReadOptions(path) {
  if (!/\.pdf$/i.test(String(path || ''))) return undefined;
  const cap = sourceLimits.documentLimits().readBytes;
  return { cap, timeoutMs: 30000 + Math.ceil(cap / (1024 * 1024)) * 1000 };
}
const { isDeepStrictEqual } = require('node:util');
const sourceLimits = require('../source-limits.cjs');
const largeDocuments = require('../large-document-lock.cjs');
const sourceText = require('../source-text.cjs');
// Shared with projects.cjs's createProject and the create/edit dialogs (src/project-limits.ts,
// #398) so a name is capped identically everywhere it can be set.
const { nameMaxLength: PROJECT_NAME_MAX_LENGTH } = require('../../contracts/project-limits.json');
const { isJsonObject } = require('../http.cjs');
// #409: the composer's Manual model pick had no server-side guard at all — unlike PUT
// /api/auto-roles (#343) and benchmark/start, which both already reject an embedding,
// reranking or Laya (routing) model through this same helper.
const { isChatGenerationModel } = require('../chat-model-kind.cjs');

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
 * @param {() => object[]} deps.allToolboxes
 * @param {(id:string) => object|null} deps.getProvider
 * @param {() => void} deps.ensureRolesLoaded
 * @param {() => Promise<{name:string, labels:string[]}[]|null>} deps.servedCatalogue
 * @param {string} deps.DEFAULT_PROVIDER_ID
 * @param {object} deps.store   projects.cjs
 * @param {() => void} [deps.onToolboxesChange]  called after a project's toolbox selection changes (clears the permitted-tools cache)
 */
function createProjectRoutes({
  json, readBody, readJson, requestScope, dispatch, currentWorkspace, authService, storageClient, documents, documentSources, rag, fs, path,
  reasoningEffort, projectAppearance, diaryExtras, PROJECTS, DEFAULT_TOOLBOXES, sanitizeToolboxes, allToolboxes = () => [{ id: 'core' }], getProvider, ensureRolesLoaded, servedCatalogue, DEFAULT_PROVIDER_ID, store,
  onToolboxesChange = () => {},
  storageLatch = require('../storage-latch.cjs').createStorageLatch(),
}) {
  const {
    getProject, saveProjects, whenSaved = (fn) => fn(), pruneDocuments, withSourceLock, ensureProjectFolder, indexSource,
  } = store;
  // #849: a rejected storage login is its own answer, not "could not create the folder". The
  // wording is the one the refresh toast and the Settings save already use (#770); `code` lets the
  // client word it in the interface language. 502, never 401, which the client reads as "your
  // noevia session expired".
  const STORAGE_LOGIN_REJECTED_ERROR = 'Storage login rejected. Check your storage credentials in Settings → Diary & storage.';
  const storageLoginRejected = (res) => json(res, 502, { error: STORAGE_LOGIN_REJECTED_ERROR, code: 'storageLoginRejected' });
  // #1428: each way storage can fail gets its own status, code and words. A 429 is a wait (503 with
  // Retry-After), a timeout is 504, an unreachable server 502; only a 401 says the login was refused.
  const STORAGE_FAILURE = {
    login: { status: 502, code: 'storageLoginRejected', error: STORAGE_LOGIN_REJECTED_ERROR },
    forbidden: { status: 502, code: 'storageForbidden', error: 'Storage refused access to this folder. Check its sharing and permissions in your storage app, then retry.' },
    throttled: { status: 503, code: 'storageThrottled', error: 'Storage is limiting logins from noevia after too many failed attempts. Wait a few minutes, then retry.' },
    timeout: { status: 504, code: 'storageTimeout', error: 'Storage did not answer in time. Try again shortly.' },
    unreachable: { status: 502, code: 'storageUnreachable', error: 'Storage could not be reached. Check the server address and that it is online, then retry.' },
  };
  // Answers a storage failure (storageClient.storageFailure) and returns true; false when `failure` is null.
  const replyStorageFailure = (res, failure) => {
    if (!failure || !STORAGE_FAILURE[failure.kind]) return false;
    const m = STORAGE_FAILURE[failure.kind];
    const wait = failure.kind === 'throttled' ? (failure.retryAfter || 60) : null;
    json(res, m.status, { error: m.error, code: m.code, ...(wait ? { retryAfter: wait } : {}) }, wait ? { 'Retry-After': String(wait) } : undefined);
    return true;
  };
  // A storage error's words for a skipped source (the refresh toast shows them).
  const storageReason = (err, fallback) => { const f = storageClient.storageFailure?.(err); return f ? STORAGE_FAILURE[f.kind].error : (err?.message || fallback); };
  const storageCode = (err) => { const f = storageClient.storageFailure?.(err); return f ? STORAGE_FAILURE[f.kind].code : undefined; };
  // #1429: an automatic source refresh waits while this account's saved login is refused or
  // throttled, so it does not keep feeding Nextcloud's brute-force protection. An explicit Retry
  // press carries X-Cowork-Storage-Retry: 1 (the same contract as the Diary, #1168) and always runs;
  // it re-latches on another refusal.
  const automaticHold = (authn, req) => {
    if (req.headers?.['x-cowork-storage-retry'] === '1' || !authn?.user) return null;
    let connection;
    try { connection = authService.getStorage(authn.user.id, true); } catch { return null; }
    return storageLatch.blocked(authn.user.id, connection);
  };
  // A folder step's failure: its kind (#1428), or the older loginRejected flag (a 401) when that is all it says.
  const folderFailure = (made) => made.failure || (made.loginRejected ? { kind: 'login' } : null);
  const holdReply = (res, hold) => (hold.kind === 'login' ? storageLoginRejected(res) : replyStorageFailure(res, { kind: 'throttled', retryAfter: hold.retryAfter }));
  // #1454: an upload never replaces an existing source unless the request says `replace: true`.
  // The refusal is a 409 with a stable code, so the client can save a numbered copy or ask the person.
  const sourceExistsReply = (res, name) => json(res, 409, {
    code: 'sourceExists', name,
    error: `A source named "${name}" already exists in this project, so it was not replaced. Upload it under another name, or choose to replace it.`,
  });
  // True when the write error is storage saying the path is already taken (a create-only PUT met a 412).
  const pathTaken = (e) => !!e && e.code === 'changed' && e.status === 409;
  const ensureFolder = (project) => typeof store.ensureProjectFolderDetailed === 'function'
    ? store.ensureProjectFolderDetailed(project)
    : Promise.resolve(ensureProjectFolder(project)).then((folder) => ({ folder, loginRejected: false, failure: null }));
  // #659: when uploads first appear in a project, its Project documents box is turned on
  // (project-docs-default.cjs). `hadUploads` is taken under the source lock before the change,
  // so a project that already had uploads is never changed by a later upload or sync. Not for
  // noevia's internal projects (the Diary extras project, a free chat's attachments).
  const { hasUploads } = require('../project-docs-default.cjs');
  const defaultProjectDocs = (project, hadUploads) => project.id !== diaryExtras?.PROJECT_ID
    && !(typeof diaryExtras?.internalProject === 'function' && diaryExtras.internalProject(project))
    && require('../project-docs-default.cjs').applyProjectDocsDefault(project, {
      offered: (id) => allToolboxes().some((b) => b.id === id), defaults: DEFAULT_TOOLBOXES || ['core'], hadUploads });

  // #1815: the workspace folder source work is registered under (none when unknown: no registration).
  const sourceWorkDir = () => { try { return (typeof currentWorkspace === 'function' && currentWorkspace()?.dir) || null; } catch { return null; } };

  // #1919: a deferred index removal runs after the save it waited for; by then a source of the same
  // name may have been uploaded again, and its fresh entries must stay. The names not listed now.
  const stillGone = (projectId, names) => {
    const listed = new Set(((getProject(projectId) || {}).files || []).map((f) => f && f.name));
    return names.filter((name) => !listed.has(name));
  };

  async function handle(req, res, { path: p, authn, url }) {
    // #2191 round 6 (rust-source-jobs.cjs): the asynchronous source routes (`?background=1` and
    // GET .../source-jobs/{jobId}) are the Rust front's, which owns the source-job store. It runs
    // the operation here by sending the synchronous route with `X-Noevia-Source-Work: 1`; the
    // answer is NDJSON: `{"accepted":true}` once the request is taken (a refusal before that is a
    // plain JSON answer, which the front passes on and starts no work for), one `{"stage":...}`
    // per progress step, then `{"done":{status,body}}` or `{"failed":{status}}`.
    const sourceWork = p.match(/^\/api\/projects\/([^/]+)\/(upload|sources\/sync)$/);
    if (sourceWork && req.method === 'POST' && req.headers?.['x-noevia-source-work'] === '1') {
      const projectId = decodeURIComponent(sourceWork[1]);
      if (!getProject(projectId)) return json(res, 404, { error: 'project not found' });
      const hold = sourceWork[2] === 'sources/sync' ? automaticHold(authn, req) : null;
      if (hold) return holdReply(res, hold);
      const body = await readJson(req, Math.ceil((sourceWork[2] === 'upload' ? require('../pdf-reduce.cjs').INPUT_CAP : DOCUMENT_UPLOAD_CAP) / 3) * 4 + 512 * 1024);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const line = (value) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(value)}\n`); };
      line({ accepted: true });
      const headers = { ...req.headers };
      delete headers['x-noevia-source-work'];
      const operation = async () => {
        const inner = require('node:stream').Readable.from([Buffer.from(JSON.stringify(body))]);
        Object.assign(inner, { method: req.method, url: p, headers, socket: req.socket });
        let status = 500, data = '';
        const progress = (stage) => line({ stage: String(stage) });
        await requestScope.run({ ...requestScope.getStore(), sourceProgress: progress }, () => dispatch(inner, { setHeader() {}, writeHead(code) { status = code; }, end(value) { data = String(value || '{}'); } }));
        // The result is final only once the list change it made is on disk: the front persists it
        // and the client reads the workspace next (the old background job could report done first).
        // A save that failed throws, as the synchronous answer would have been that failure.
        await whenSaved(() => undefined);
        return { status, body: JSON.parse(data) };
      };
      try {
        const done = await require('../source-work.cjs').track(currentWorkspace(), projectId, operation,
          { name: sourceWork[2] === 'sources/sync' ? null : String(body?.name || '').split('/').pop() });
        line({ done });
      } catch (err) {
        line({ failed: { status: err?.status || 500 } });
      }
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
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

    // POST /api/projects and DELETE /api/projects/{projectId} are the Rust front's (#2191 round 2,
    // rust-project-lifecycle.cjs, refused before authentication); so is the conversation import
    // (round 4, rust-conversation-import.cjs), and a chat's attachments project is still deleted
    // through store.deleteProject.

    const skillManifestRoute = p.match(/^\/api\/projects\/([^/]+)\/instruction-skills\/manifests$/);
    const skillContentRoute = p.match(/^\/api\/projects\/([^/]+)\/instruction-skills\/manifests\/([^/]+)\/content$/);
    if (req.method === 'GET' && (skillManifestRoute || skillContentRoute)) {
      const project = getProject(decodeURIComponent((skillManifestRoute || skillContentRoute)[1]));
      if (!project) return json(res, 404, { error: 'No such project' });
      const skills = require('../instruction-skills.cjs');
      const known = allToolboxes().map(box => box.id);
      if (skillManifestRoute) return json(res, 200, { schemaVersion: 1, skills: skills.manifests(project, known) });
      try { return json(res, 200, skills.resolve(project, skillContentRoute[2], url.searchParams.get('version'), known)); }
      catch (err) { return json(res, err.status || 400, { error: err.message }); }
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
      // Origin, portable id and bundled scripts ride along so Sources shows provenance (#272).
      return json(res, 200, {skills: skills.listForClient(project, allToolboxes().map(box => box.id))});
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
      const file = { name: `${body.skill}/SKILL.md`, content, skillOrigin: {
        kind: 'published', publisher: 'Anthropic', repository: 'https://github.com/anthropics/skills',
        sourceRef: 'main', sourcePath: `skills/${body.skill}/SKILL.md`,
        digest: skills.hash(content), retrievedAt: new Date().toISOString(),
      } };
      const inspected = skills.inspect(file, project);
      if (!inspected?.valid) return json(res, 422, { error: `This skill cannot be used as a project skill: ${inspected?.error || 'no skill frontmatter'}` });
      const files = Array.isArray(project.files) ? project.files : [];
      const full = !files.some((f) => f.name === file.name) && sourceLimits.refusal(files, file.name);
      if (full) return json(res, 409, { error: full.message, code: full.code });
      project.files = [...files.filter((f) => f.name !== file.name), file];
      if (project.instructionSkills) delete project.instructionSkills[file.name]; // a replaced skill needs review again
      skills.reconcile(project);
      project.updatedAt = Date.now();
      currentWorkspace().saveProjects();
      return json(res, 201, { file: file.name, skills: skills.list(project).map(({ content: _c, ...rest }) => rest) });
    }
    const projCfg = p.match(/^\/api\/projects\/([^/]+)\/config$/);
    if (projCfg && req.method === 'POST') {
      let dropIndexAfterSave = null;
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
      // #1079: Context: Low (the default, stored as absent) or High, served by the model's
      // `<model>-long` profile when it has one. null clears it, like 'low'.
      let clearContextProfile = false;
      if (patch.contextProfile !== undefined) {
        if (patch.contextProfile !== null && patch.contextProfile !== 'low' && patch.contextProfile !== 'high') return json(res, 400, { error: 'Invalid context profile' });
        if (patch.contextProfile === 'high') project.contextProfile = 'high'; else { delete project.contextProfile; clearContextProfile = true; }
      }
      if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim().slice(0, PROJECT_NAME_MAX_LENGTH);
      if (typeof patch.goal === 'string') project.goal = patch.goal.slice(0, 2000);
      if (typeof patch.instructions === 'string') project.instructions = patch.instructions.slice(0, 8000);
      if (typeof patch.model === 'string' && patch.model) {
        // Embedding, reranking and Laya (the internal routing model) cannot answer a chat
        // prompt — pinning one as the project's manual model would save successfully and send
        // every subsequent message to it (#409). Only checked against the local catalogue: a
        // model on another provider (cloud) is not in it, and modelChoiceLabel's own comment on
        // this same caveat is why (src/model-guidance.ts) — never flag what this server cannot see.
        const patchProviderId = typeof patch.provider === 'string' && patch.provider ? patch.provider : undefined;
        const effectiveProviderId = patchProviderId || storedProject.provider || DEFAULT_PROVIDER_ID;
        const isLocalProvider = effectiveProviderId === DEFAULT_PROVIDER_ID || effectiveProviderId === 'lemonade';
        if (isLocalProvider) {
          const catalogue = await servedCatalogue();
          const entry = Array.isArray(catalogue) ? catalogue.find((m) => m.name === patch.model) : null;
          if (!isChatGenerationModel(patch.model, entry?.labels)) {
            return json(res, 400, { error: `${patch.model} is an embedding, reranking or routing model and cannot be used as a chat model — pick a chat model instead.` });
          }
        }
        project.model = patch.model;
      }
      // Picking a model is a manual choice even when the caller only sent `model` — the picker
      // row itself now sends `routing: 'manual'` alongside it (#384), but older/other callers
      // that patch `model` alone must not have the pick silently auto-routed away on the next
      // send. An explicit `routing` in the same patch is a deliberate combination (e.g. picking
      // a model while staying on Auto) and always wins — handled by the block below, which runs
      // after this one.
      if (typeof patch.model === 'string' && patch.model && typeof patch.routing !== 'string') {
        project.routing = 'manual';
        project.routingChosen = true;
      }
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
      if (patch.sharedContext !== undefined) {
        try { project.sharedContext = require('../shared-context.cjs').sanitize(patch.sharedContext); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (typeof patch.routing === 'string') {
        if (patch.routing !== 'auto' && patch.routing !== 'manual') {
          return json(res, 400, { error: "routing must be 'auto' or 'manual'" });
        }
        project.routing = patch.routing;
        // Marks this value as a person's own choice, never the template default a project or
        // shadow chat-context object was created with (#352). getProject()'s migration only
        // self-heals a stale 'manual' when this is absent.
        project.routingChosen = true;
        if (patch.routing === 'auto') ensureRolesLoaded(); // no-op if unconfigured
      }
      let clearRoutingMode = false;
      // #1007: this chat's or project's own routing mode; null goes back to the account's.
      if (patch.routingMode !== undefined) {
        let next;
        try { next = require('../routing-modes.cjs').projectOverride(patch.routingMode, true); } catch (e) { return json(res, 400, { error: e.message }); }
        if (next) project.routingMode = next; else { delete project.routingMode; clearRoutingMode = true; }
      }
      // #1006: tools picked automatically (the default set, narrowed per message when tool routing
      // is on) or by hand from `toolboxes`. The hand-picked list is kept either way.
      if (patch.toolsMode !== undefined) {
        if (patch.toolsMode !== 'auto' && patch.toolsMode !== 'manual') return json(res, 400, { error: "toolsMode must be 'auto' or 'manual'" });
        project.toolsMode = patch.toolsMode;
        onToolboxesChange();
      }
      if (typeof patch.provider === 'string' && patch.provider) {
        // getProvider also resolves unknown IDs to the default for chat. An explicit
        // selection must match its registered ID (or the legacy lemonade alias).
        const selectedProvider = getProvider(patch.provider);
        const selectedId = patch.provider === 'lemonade' ? DEFAULT_PROVIDER_ID : patch.provider;
        if (!selectedProvider || selectedProvider.id !== selectedId) return json(res, 400, { error: 'no such provider' });
        project.provider = patch.provider;
      }
      // Explicit sampling override (issue #194): null clears it, back to the automatic preset
      // (or engine defaults, if automatic sampling presets are off). Unknown/out-of-range keys
      // are dropped rather than rejecting the whole request — sanitizeExplicitSampling mirrors
      // the same validation selectSamplingParams applies at request time.
      let clearSampling = false;
      if (patch.sampling === null) { delete project.sampling; clearSampling = true; }
      else if (patch.sampling !== undefined) {
        const cleaned = require('../sampling-presets.cjs').sanitizeExplicitSampling(patch.sampling);
        if (cleaned) project.sampling = cleaned;
        else { delete project.sampling; clearSampling = true; }
      }
      if (patch.toolboxes !== undefined) {
        const boxes = sanitizeToolboxes(patch.toolboxes);
        if (!boxes) return json(res, 400, { error: 'toolboxes must be an array of toolbox ids' });
        project.toolboxes = boxes;
        onToolboxesChange();
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
        // #1806: the client lists sources without their text (GET /api/workspace sends metadata
        // only), so an entry with no `content` names an upload this project already holds, kept as
        // it is; an entry with no `content` and no such upload is dropped.
        const uploads = patch.files
          .filter((f) => f && typeof f.name === 'string' && !f.source && (typeof f.content === 'string'
            || (f.content === undefined && prevFiles.some(p => !p.source && p.name === f.name))))
          .slice(0, Math.max(0, sourceLimits.limits().sources - fromFolders.length))
          .map((f) => {
            const existing = prevFiles.find(p => !p.source && p.name === f.name);
            if (f.content === undefined) return existing;
            return existing?.document || existing?.attachment ? existing : {
              name: f.name.slice(0, 200), content: f.content.slice(0, 200000),
              // Preserve published provenance only while the exact copied bytes survive.
              ...(existing?.content === f.content && existing?.skillOrigin ? { skillOrigin: existing.skillOrigin } : {}),
            };
          });
        project.files = [...fromFolders, ...uploads];
        // RAG bookkeeping (step 10): drop chunks for removed files; index
        // new/changed ones. Fire-and-forget — upload latency must not depend
        // on embedding round-trips.
        const prevByName = new Map(prevFiles.map((f) => [f.name, f]));
        const nextNames = new Set(project.files.map((f) => f.name));
        project.assets = (project.assets || []).filter(a => !a.sourceName || nextNames.has(a.sourceName));
        // #1914: the index entries of removed files go once the list without them is on disk.
        const goneNames = prevFiles.filter((prev) => !nextNames.has(prev.name)).map((prev) => prev.name);
        if (goneNames.length) dropIndexAfterSave = () => { const userId = currentWorkspace().userId; for (const name of stillGone(id, goneNames)) rag.deleteProjectFile(id, name, userId); };
        for (const next of project.files) {
          const prev = prevByName.get(next.name);
          if (!prev || !sourceText.sameText(prev, next)) {
            indexSource(project, next);
          }
        }
      }
      // #1886: a patch that leaves every field as stored (the client's "Refresh from storage" used to
      // re-send the folder list) is a read: no write, no timestamp bump, no store lock.
      if (isDeepStrictEqual(project, storedProject)) return json(res, 200, { ok: true, unchanged: true });
      project.updatedAt = Date.now();
      Object.assign(storedProject, project);
      if (clearSampling) delete storedProject.sampling;
      if (clearRoutingMode) delete storedProject.routingMode;
      // The merge above cannot remove a key, so Low is removed here.
      if (clearContextProfile) delete storedProject.contextProfile;
      // #1090: null clears the stored effort the same way; the merge above never removes a key.
      if (patch.reasoningEffort === null) delete storedProject.reasoningEffort;
      saveProjects(PROJECTS);
      pruneDocuments(storedProject);
      if (dropIndexAfterSave) Promise.resolve().then(() => whenSaved(dropIndexAfterSave)).catch(() => { /* not saved: kept */ });
      return json(res, 200, { ok: true });
    }

    // GET and POST /api/projects/{id}/chats (a project's chat list) are the Rust front's
    // (sbstndalton/noevia#1071): index.cjs refuses them before this mount (rust-projects.cjs
    // refuseOwnedRoute).

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
    // POST .../documents (a document uploaded from disk) is the Rust front's (#2191 round 5,
    // rust-project-documents.cjs), read by Docling through its durable extraction queue.

    // GET .../documents/original (#2191, rust-project-reads.cjs) and GET .../documents/pages (#2191
    // round 4, rust-project-document-pages.cjs) are the Rust front's, refused before authentication.

    // #1805: plan a folder import. The client sends the folder's manifest (relative path, size,
    // SHA-256 of each file); the answer says which files will be uploaded, which are unchanged since
    // the last import (same content at the same path) and which are skipped and why, and opens an
    // import id that only the accepted paths can be uploaded under. Nothing is written here.
    const folderPlan = p.match(/^\/api\/projects\/([^/]+)\/folder-import\/plan$/);
    if (folderPlan && req.method === 'POST') {
      const id = decodeURIComponent(folderPlan[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      // Never the Diary or a free chat's attachment context: those are not projects a person imports into.
      if (id === diaryExtras?.PROJECT_ID || (typeof diaryExtras?.internalProject === 'function' && diaryExtras.internalProject(project))) {
        return json(res, 400, { error: 'Folders can be imported into a project only.' });
      }
      let body;
      try { body = await readJson(req, 4 * 1024 * 1024); }
      catch (e) { return json(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? 'That folder lists too many files to import at once.' : 'invalid JSON' }); }
      if (!isJsonObject(body)) return json(res, 400, { error: 'request body must be a JSON object' });
      const folderImport = require('../folder-import.cjs');
      const uploads = require('../uploads.cjs');
      const connection = authService.getStorage(authn.user.id, true);
      const remote = storageClient.isBrowsable(connection);
      const destination = (rel) => {
        const slash = rel.lastIndexOf('/');
        const name = rel.slice(slash + 1), folderPath = slash > 0 ? rel.slice(0, slash) : '';
        if (remote && !project.projectFolder) return '';
        return uploads.destinationFor(project, name, { connection: remote ? connection : null, folderPath });
      };
      const perFileCap = (rel) => (/\.pdf$/i.test(rel) ? require('../pdf-reduce.cjs').INPUT_CAP : uploads.CAP);
      try {
        return json(res, 200, folderImport.plan({ userId: authn.user.id, project, entries: body.entries, destination, perFileCap }));
      } catch (e) {
        if (e.status === 400 || e.status === 429) return json(res, e.status, { error: e.message });
        throw e;
      }
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
        let inputName = String(body.name || '');
        const inputBytes = Buffer.from(String(body.dataBase64 || ''), 'base64');
        // #1805: a file of a folder import carries its path inside the folder and the import's id.
        // Only a path that import's plan accepted is taken (the caps hold here, not only in the
        // browser); it is stored under that path inside its type group, and an unchanged file
        // (same content hash at the same path) is left as it is.
        const folderImport = body.relativePath === undefined ? null : require('../folder-import.cjs');
        let folderPath = '', importRel = '';
        if (folderImport) {
          try { importRel = folderImport.relativePath(body.relativePath); }
          catch (e) { return json(res, 400, { error: e.message, code: 'invalidPath' }); }
          const why = folderImport.skipReason(importRel);
          if (why) return json(res, 400, { error: folderImport.REASONS[why.code], code: why.code });
          // The ticket holds the size the plan accepted for this path and the import's running byte
          // total, so a manifest that declared 1 byte cannot carry a 60 MB body past the caps.
          const refused = folderImport.admit(body.importId, authn.user.id, id, importRel, inputBytes.length);
          if (refused) return json(res, refused.status, { error: refused.error, code: refused.code });
          const slash = importRel.lastIndexOf('/');
          inputName = importRel.slice(slash + 1);
          folderPath = slash > 0 ? importRel.slice(0, slash) : '';
        }
        // Validate the filename before contacting the document processor.
        uploads.validate(inputName, inputBytes.subarray(0,1));
        // #1815: a folder import file holds no source-text collection in this workspace while it runs.
        return await sourceText.whileSourceWork(folderImport && sourceWorkDir(), () => withSourceLock(project, async () => {
          if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
          const hadUploads = hasUploads(project); // #659: the box is added only when uploads first appear
          const connection = authService.getStorage(authn.user.id, true);
          const remote = storageClient.isBrowsable(connection) ? connection : null;
          const progress = requestScope.getStore()?.sourceProgress || (() => {});
          // A folder import updates the file at its path: re-importing a folder never makes a "(2)" copy.
          const replace = body.replace === true || !!folderImport;
          // #1454: refuse before any work when the name is taken; checked again for a reduced file's new name.
          const destinationOf = (n) => (remote && project.projectFolder ? uploads.destinationFor(project, n, { connection: remote, folderPath }) : remote ? null : uploads.destinationFor(project, n, { folderPath }));
          const exists = (n) => (project.files || []).some(f => f.name === destinationOf(n));
          if (!replace && exists(inputName)) return sourceExistsReply(res, inputName);
          if (folderImport) {
            const dest = destinationOf(inputName);
            const clash = dest && (project.files || []).find(f => f.name !== dest && folderImport.foldKey(f.name) === folderImport.foldKey(dest));
            if (clash) return json(res, 409, { error: folderImport.REASONS.caseCollision, code: 'caseCollision', existing: clash.name });
            const previous = (project.files || []).find(f => f.name === dest);
            if (previous?.attachment?.id && previous.attachment.id === require('node:crypto').createHash('sha256').update(inputBytes).digest('hex')) {
              folderImport.consume(body.importId, importRel, inputBytes.length);
              return json(res, 200, { name: inputName, path: previous.name, bytes: inputBytes.length, unchanged: true, attachment: previous.attachment, document: previous.document });
            }
          }
          const {name,bytes,reduction} = await require('../pdf-reduce.cjs').prepare(inputName,inputBytes,{progress});
          uploads.validate(name,bytes);
          if (!replace && name !== inputName && exists(name)) return sourceExistsReply(res, name);
          if (remote && !project.projectFolder) {
            progress('Creating upload folder');
            const made = await ensureFolder(project);
            project.projectFolder = made.folder;
            if (!project.projectFolder) return replyStorageFailure(res, folderFailure(made)) || json(res, 502, { error: 'Could not create the storage folder; retry.' });
          }
          let file;
          // #1664: filled by ingest only after a create-only write; any failure before the record is
          // saved removes that file again (conditional on its ETag), so a retry is not a 409 / "(2)".
          const created = {};
          try { file = await uploads.ingest(currentWorkspace(), project, name, bytes, { connection: remote, progress, folderPath, ...(remote && !replace ? { ifNoneMatch: '*', created } : {}) }); }
          catch (e) {
            if (!replace && remote && pathTaken(e)) return sourceExistsReply(res, name);
            if (replyStorageFailure(res, storageClient.storageFailure?.(e))) return;
            // A project limit (source-limits.cjs) is the person's answer, with its code, not a server error.
            if (e && e.status === 400 && e.code) return json(res, 400, { error: e.message, code: e.code });
            throw e;
          }
          let recorded = false;
          const filesBefore = project.files;
          try {
            if(reduction){file.attachment.reduction=reduction;file.attachment.reason=[file.attachment.reason,reduction.note].filter(Boolean).join(' ');}
            if (getProject(id) !== project) return json(res, 409, { error: 'Project removed during upload.' });
            if (remote) project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
            project.files = [...(project.files || []).filter(f => f.name !== file.name), file];
            project.updatedAt = Date.now();
            progress('Indexing extracted text');
            indexSource(project, file);
            defaultProjectDocs(project, hadUploads);
            saveProjects(PROJECTS);
            recorded = true;
            if (folderImport) folderImport.consume(body.importId, importRel, inputBytes.length);
          } finally {
            // The unsaved record goes with the file, so the retry is not refused as a same-name source.
            if (!recorded && created.etag && (await uploads.discardCreated(created)).deleted && project.files !== filesBefore) project.files = filesBefore;
          }
          return json(res, 200, { name, path: file.name, bytes: bytes.length, document: file.document, attachment: file.attachment });
        }));
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
        const hadUploads = hasUploads(project); // #659: the box is added only when uploads first appear
        const connection = authService.getStorage(authn.user.id, true);
        if (!storageClient.isBrowsable(connection)) {
          // Remote storage is optional. Keep local uploads as project sources,
          // including PDF extraction, for installations without a cloud account.
          const uploads = (project.files || []).filter((f) => !f.source);
          if (uploads.length >= 20 && !uploads.some((f) => f.name === rawName)) {
            return json(res, 400, { error: 'A project holds at most 20 uploaded sources.' });
          }
          const previous = uploads.find(f => f.name === rawName);
          if (previous && body.replace !== true) return sourceExistsReply(res, rawName);
          const file = documents.isDocument(rawName)
            ? await documentSources.ingest(currentWorkspace(), id, rawName, bytes, previous)
            : { name: rawName, content: bytes.toString('utf8').slice(0, 200000) };
          if (getProject(id) !== project || !sameSource((project.files || []).find(f => !f.source && f.name === rawName), previous)) return json(res, 409, { error: 'Source changed; retry.' });
          project.files = [...(project.files || []).filter(f => f.source || f.name !== rawName), file];
          project.updatedAt = Date.now();
          indexSource(project, file); defaultProjectDocs(project, hadUploads); saveProjects(PROJECTS);
          return json(res, 200, { name: rawName, path: rawName, bytes: bytes.length, document: file.document });
        }
        if (!project.projectFolder) {
          const made = await ensureFolder(project);
          if (!made.folder) return replyStorageFailure(res, folderFailure(made)) || json(res, 502, { error: 'Could not create the project storage folder. Check your storage connection and retry.' });
          project.projectFolder = made.folder;
        }
        project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
        saveProjects(PROJECTS);
        const replace = body.replace === true;
        if (!replace && (project.files || []).some(f => f.name === `${project.projectFolder}/${rawName}`)) return sourceExistsReply(res, rawName);
        // #1653: a PDF is read BEFORE the write, so a failure while reading leaves nothing in storage (an
        // unrecorded remote file would make the retry meet a 409 and the client save a "(2)" copy). The PUT stays
        // create-only (If-None-Match), so no-overwrite is unchanged; the read is cached by content, so a 409 costs nothing twice.
        const name = `${project.projectFolder}/${rawName}`;
        let file;
        if (documents.isDocument(rawName)) {
          const previous = (project.files || []).find(f => f.name === name && f.source === project.projectFolder);
          file = await documentSources.ingest(currentWorkspace(), id, name, bytes, previous);
          file.source = project.projectFolder;
        }
        let written;
        try {
          written = await (replace ? storageClient.writeFile(connection, name, bytes)
            : storageClient.writeFile(connection, name, bytes, { ifNoneMatch: '*' }));
        } catch (e) {
          if (!replace && pathTaken(e)) return sourceExistsReply(res, rawName);
          if (replyStorageFailure(res, storageClient.storageFailure?.(e))) return;
          return json(res, (e && e.status) || 502, { error: (e && e.message) || 'could not save the file' });
        }
        if (file) {
          // #1664: a PDF needs its record; if that fails after a create-only write, remove the file again
          // (If-Match on the write's ETag) so a retry is not a 409 / "(2)". A replace never deletes.
          let recorded = false;
          const filesBefore = project.files;
          try {
            if (getProject(id) !== project || !project.sourceFolders.includes(file.source)) return json(res, 409, { error: 'Source changed; refresh again.' });
            project.files = [...(project.files || []).filter(f => f.name !== name || f.source !== file.source), file];
            indexSource(project, file); defaultProjectDocs(project, hadUploads); saveProjects(PROJECTS);
            recorded = true;
          } finally {
            if (!recorded && !replace && written?.created === true && written?.etag
              && (await require('../uploads.cjs').discardCreated({ connection, path: name, etag: written.etag, storageImpl: storageClient })).deleted
              && project.files !== filesBefore) project.files = filesBefore;
          }
        }
        return json(res, 200, { name: rawName, path: `${project.projectFolder}/${rawName}`, bytes: bytes.length, document: file?.document });
      });
    }

    // DELETE .../files (a source file's delete from storage) is the Rust front's (#2191 round 3,
    // rust-project-files.cjs); its RAG rows are an `unindex` job of the index outbox, run here.

    // GET .../uploads/original (#786) is the Rust front's (#2191, rust-project-reads.cjs).

    // A project's images (POST /api/projects/{id}/assets, GET and DELETE .../assets/{assetId}) are
    // the Rust front's (sbstndalton/noevia#1071): index.cjs refuses them before this mount
    // (rust-projects.cjs refuseOwnedRoute). Chat reads the stored bytes itself (assetDir).

    const projSync = p.match(/^\/api\/projects\/([^/]+)\/sources\/sync$/);
    if (projSync && req.method === 'POST') {
      const id = decodeURIComponent(projSync[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      const hold = automaticHold(authn, req);
      if (hold) return holdReply(res, hold);
      // #1815: no source-text collection in this workspace while the sync runs.
      // #1885 follow-up: one content-free line per sync: counts and a short tag of the project, never a
      // file name, folder or text. `seen` counts the files read or attempted; `ingested` those read from
      // storage; of those, `reopened` were stored results completed or reopened, `unchanged` reused as they
      // were; `reopenedStored` were reopened from the stored original after the storage read failed.
      const startedAt = Date.now();
      const stats = { seen: 0, ingested: 0, extracted: 0, reopened: 0, unchanged: 0, reopenedStored: 0, errors: 0, skipped: 0 };
      const onOutcome = (kind) => { if (kind in stats) stats[kind] += 1; };
      let logged = false;
      const logSync = (status) => {
        if (logged) return;
        logged = true;
        console.log(`[sources] sync project=${largeDocuments.refHash(id)} status=${status} ` +
          Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ') + ` ms=${Date.now() - startedAt}`);
      };
      return await sourceText.whileSourceWork(sourceWorkDir(), () => withSourceLock(project, async () => {
        if (getProject(id) !== project) { logSync(409); return json(res, 409, { error: 'Project changed; retry.' }); }
        const hadUploads = hasUploads(project); // #659: the box is added only when uploads first appear
        const connection = authService.getStorage(authn.user.id, true);
        const fromFolders = [];
        const skipped = [];
        const SOURCE_LIMIT = sourceLimits.limits().sources;
        const LIMIT_REASON = `${SOURCE_LIMIT}-source project limit reached; this file was not read.`;
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
        if (folders.length && !storageClient.isBrowsable(connection)) { logSync(400); return json(res, 400, { error: 'no browsable storage connection is configured' }); }
        // Room left for the folders being re-read: every source that is NOT
        // from one of them (uploads, images just moved into storage, files of
        // other attached folders) stays, so it counts against the source limit (and documents against theirs).
        const kept = (project.files || []).filter(f => !f.source || !folders.includes(f.source));
        const sourceLimit = Math.max(0, SOURCE_LIMIT - kept.length);
        const DOCUMENT_LIMIT = sourceLimits.limits().documents;
        const documentRoom = Math.max(0, DOCUMENT_LIMIT - sourceLimits.counts(kept).documents);
        let documentsRead = 0;
        // #1871: the OCR retry pages this sync may spend, across all its documents (PROJECT_SYNC_OCR_PAGES).
        const syncOcrBudget = require('../documents.cjs').ocrBudget();

        // #1429: a refused or throttled login stops every further storage call in this refresh; the
        // rest of the folders and files keep what they had and say why, with no more attempts made.
        let halted = null;
        const haltFor = (err) => {
          const failure = storageClient.storageFailure?.(err);
          if (!failure) return;
          storageLatch.note(authn.user.id, connection, failure);
          if (failure.kind === 'login' || failure.kind === 'throttled') halted = { reason: storageReason(err), code: storageCode(err) };
        };
        for (const folder of folders) {
          if (halted) {
            const previous = (project.files || []).filter(f => f.source === folder);
            fromFolders.push(...previous.map(f => documents.isDocument(f.name) ? { ...documentSources.failed(f, f.name, halted.reason), source: folder } : f));
            skipped.push({ folder, reason: halted.reason, code: halted.code, retained: previous.some(f => sourceText.textLength(f) > 0) });
            continue;
          }
          // #1805: every subfolder is read, not only the top level: breadth-first, skipping the shared
          // system/hidden names (contracts/folder-import.json), bounded by depth and folder count, and
          // leaving a subfolder that is itself attached to its own entry so no file is synced twice.
          // A subfolder whose listing fails keeps its previous sources and says so. The source limit
          // below still bounds what is read.
          const folderImport = require('../folder-import.cjs');
          let entries;
          try {
            const tree = await folderImport.listTree((dir) => (halted ? Promise.reject(new Error(halted.reason)) : storageClient.listFiles(connection, dir)), folder, {
              exclude: new Set(folders.filter((other) => other !== folder && other.startsWith(`${folder}/`))),
              onDirError: (dir, err) => {
                haltFor(err);
                fromFolders.push(...(project.files || []).filter(f => f.source === folder && f.name.startsWith(dir + '/')));
                skipped.push({ folder, file: dir, reason: halted ? halted.reason : 'Could not read this subfolder; previous sources retained.', code: halted ? halted.code : storageCode(err), retained: true });
              },
            });
            entries = tree.files;
            for (const cut of tree.limited) {
              fromFolders.push(...(project.files || []).filter(f => f.source === folder && f.name.startsWith(cut.path + '/')));
              skipped.push({ folder, file: cut.path, code: cut.code, retained: true,
                reason: cut.code === 'depthLimit' ? `Folders more than ${folderImport.contract.maxDepth} levels deep are not read.` : `Only the first ${folderImport.contract.maxFolders} subfolders are read.` });
            }
            storageLatch.clear(authn.user.id);
          } catch (e) {
            haltFor(e);
            const reason = storageReason(e, 'could not list folder');
            const previous = (project.files || []).filter(f => f.source === folder);
            fromFolders.push(...previous.map(f => documents.isDocument(f.name) ? { ...documentSources.failed(f, f.name, reason), source: folder } : f));
            skipped.push({ folder, reason, code: storageCode(e), retained: previous.some(f => sourceText.textLength(f) > 0) });
            continue;
          }
          for (const entry of entries) {
            const ext = (entry.ext || '').toLowerCase();
            const isText = storageClient.TEXT_EXTENSIONS.has(ext);
            const isDoc = documents.isDocument(entry.name);
            const isDocx = /\.docx$/i.test(entry.name);
            const managed = folder === project.projectFolder && require('../uploads.cjs').GROUPS.some(g => entry.path.startsWith(`${folder}/${g}/`));
            if (!isText && !isDoc && !isDocx && !managed) continue;
            if (fromFolders.length >= sourceLimit) { skipped.push({ folder, file: entry.path, reason: LIMIT_REASON, code: 'limit', retained: false }); continue; } // a cap, so one big folder cannot blow up a project
            if ((isDoc || isDocx || (managed && sourceLimits.kindOf(entry.name) === 'document')) && documentsRead >= documentRoom) {
              skipped.push({ folder, file: entry.path, reason: `${DOCUMENT_LIMIT}-document project limit reached; this file was not read.`, code: 'documentLimit', retained: false }); continue;
            }
            if (isDoc || isDocx || (managed && sourceLimits.kindOf(entry.name) === 'document')) documentsRead += 1;
            const previous = (project.files || []).find((f) => f.source === folder && f.name === entry.path);
            stats.seen += 1;
            if (halted) {
              if (isDoc) fromFolders.push({ ...documentSources.failed(previous, entry.path, halted.reason), source: folder });
              else if (previous) fromFolders.push(previous);
              skipped.push({ folder, file: entry.path, reason: halted.reason, code: halted.code, retained: !!previous && sourceText.textLength(previous) > 0 });
              continue;
            }
            try {
              if (managed || isDocx) {
                // #1871: a PDF that is (or may be) over 25 MiB holds the process-wide large-document lock from
                // its storage read to the end of its extraction.
                // #1872: the listed size is not trusted: the response's own Content-Length decides too, before the body.
                const file = await largeDocuments.readThenUse(documentReadOptions(entry.path) ? entry.size : 0,
                  (beforeBody) => storageClient.readBinaryFile(connection, entry.path, { ...documentReadOptions(entry.path), ...(documentReadOptions(entry.path) ? { beforeBody } : {}) }),
                  (bytes) => require('../uploads.cjs').ingest(currentWorkspace(), project, entry.name, bytes, { source: folder, remotePath: entry.path, progress: requestScope.getStore()?.sourceProgress, ocrBudget: syncOcrBudget }));
                fromFolders.push(file);
                if (file.document && file.document.state !== 'ready') skipped.push({ folder, file: entry.path, reason: documentSources.problem(file), ...documentSources.problemNotes(file), retained: file.document.stale });
              } else if (isDoc) {
                // A document is converted to text here, so a PDF in an attached
                // folder becomes a readable source rather than being skipped.
                const file = await largeDocuments.readThenUse(documentReadOptions(entry.path) ? entry.size : 0,
                  (beforeBody) => storageClient.readBinaryFile(connection, entry.path, { ...documentReadOptions(entry.path), ...(documentReadOptions(entry.path) ? { beforeBody } : {}) }),
                  (bytes) => documentSources.ingest(currentWorkspace(), id, entry.path, bytes, previous, { ocrBudget: syncOcrBudget, onOutcome }));
                fromFolders.push({ ...file, source: folder });
                if (file.document.state !== 'ready') skipped.push({ folder, file: entry.path, reason: documentSources.problem(file), ...documentSources.problemNotes(file), retained: file.document.stale });
              } else {
                const file = await storageClient.readTextFile(connection, entry.path);
                fromFolders.push({ name: entry.path, content: file.content, source: folder });
              }
              stats.ingested += 1;
            } catch (e) {
              stats.errors += 1;
              haltFor(e);
              const reason = storageReason(e, 'could not read');
              // #1885 follow-up: the read failed, so ingest (and its reopen) never ran. A previous result that is
              // reopenable is reopened from its stored original instead (documentSources.reopenStored: once, under
              // the large-document lock, within this sync's OCR budget). The refresh is still reported as failed.
              let reopened = null;
              if (isDoc && !managed && !isDocx && !halted && e?.code !== 'large-document-busy' && previous?.document) {
                try {
                  reopened = await documentSources.reopenStored(currentWorkspace(), id, entry.path, previous, { ocrBudget: syncOcrBudget, onOutcome: (kind) => { if (kind === 'reopened') stats.reopenedStored += 1; } });
                } catch (err) { console.warn(`[sources] reopening a stored result failed: project=${largeDocuments.refHash(id)} (${String(err?.name || 'Error').slice(0, 40)})`); }
              }
              if (reopened) {
                const file = { ...reopened, source: folder, document: { ...reopened.document, state: 'failed', stale: !!reopened.content, error: reason } };
                fromFolders.push(file);
                skipped.push({ folder, file: entry.path, reason: documentSources.problem(file), ...documentSources.problemNotes(file), code: storageCode(e), retained: !!file.content });
                continue;
              }
              if (isDoc) fromFolders.push({ ...documentSources.failed(previous, entry.path, reason), source: folder });
              else if (previous) fromFolders.push(previous);
              skipped.push({ folder, file: entry.path, reason, code: storageCode(e), retained: !!previous && sourceText.textLength(previous) > 0 });
            }
          }
        }
        if (getProject(id) !== project) { logSync(409); return json(res, 409, { error: 'Project changed; retry.' }); }
        const prev = Array.isArray(project.files) ? project.files : [];
        // An upload or folder edit may have completed while storage was being
        // read. Preserve current uploads and never reattach a detached folder.
        const currentFolders = new Set(project.sourceFolders || []);
        const uploaded = prev.filter((f) => !f.source);
        const untouched = prev.filter((f) => f.source && currentFolders.has(f.source) && !folders.includes(f.source));
        const synced = fromFolders.filter((f) => currentFolders.has(f.source));
        // Existing uploads and other folders' sources are never dropped here;
        // only newly synced files beyond the cap are, and each is reported.
        const room = Math.max(0, SOURCE_LIMIT - uploaded.length - untouched.length);
        for (const f of synced.slice(room)) skipped.push({ folder: f.source, file: f.name, reason: LIMIT_REASON, code: 'limit', retained: false });
        project.files = [...uploaded, ...untouched, ...synced.slice(0, room)];
        require('../uploads.cjs').prune(currentWorkspace(), project);
        // A file dropped into the project's own upload folder elsewhere is an upload too (#659).
        defaultProjectDocs(project, hadUploads);
        saveProjects(PROJECTS);
        // Same RAG bookkeeping the config patch does: drop chunks for files that
        // are gone, re-index the ones that arrived or changed.
        const prevByName = new Map(prev.map((f) => [f.name, f]));
        const nextNames = new Set(project.files.map((f) => f.name));
        // #1914: once the list without them is on disk.
        const goneNames = prev.filter((old) => !nextNames.has(old.name)).map((old) => old.name);
        if (goneNames.length) { const userId = currentWorkspace().userId; Promise.resolve().then(() => whenSaved(() => { for (const name of stillGone(id, goneNames)) rag.deleteProjectFile(id, name, userId); })).catch(() => { /* not saved: kept */ }); }
        for (const next of project.files) {
          const before = prevByName.get(next.name);
          if (!before || !sourceText.sameText(before, next) || (next.document && ['pending', 'failed', 'unavailable', 'partial'].includes(next.document.indexing))) {
            indexSource(project, next);
          }
        }
        stats.skipped = skipped.length;
        logSync(200);
        return json(res, 200, {
          files: project.files.map((f) => ({ name: f.name, source: f.source || null, bytes: sourceText.textLength(f), document: f.document })),
          skipped,
        });
      })).catch((err) => { stats.errors += 1; logSync('error'); throw err; });
    }

    // DELETE /api/projects/{id}/chats/{chatId} is the Rust front's (sbstndalton/noevia#1071 slice 6):
    // index.cjs refuses it before this mount (rust-projects.cjs refuseOwnedRoute).

    return PASS;
  }

  return async function projectRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createProjectRoutes, sameSource, DOCUMENT_UPLOAD_CAP, IMAGE_UPLOAD_CAP, IMAGE_MIME, get MAX_PROJECT_IMAGES() { return sourceLimits.limits().images; } };
