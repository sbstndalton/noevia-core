'use strict';
// The project routes Node still answers: configure a project; its instruction skills; the Diary context.
// Every way a source reaches a project (an upload, a document, an image, a folder sync and the folder
// import's plan, with their background jobs) is the Rust front's (#2191). The store itself is
// projects.cjs; this file is the HTTP surface.
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Blocks are mounted in their original order and an unmatched method falls through, so a
// PUT on a GET/POST path still reaches the static fallback exactly as it did inline.

// An image source is bytes, not text, and needs its own limits.
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_UPLOAD_CAP = 8 * 1024 * 1024;
const { isDeepStrictEqual } = require('node:util');
const sourceLimits = require('../source-limits.cjs');
const sourceText = require('../source-text.cjs');
// Shared with projects.cjs's createProject and the create/edit dialogs (src/project-limits.ts,
// #398) so a name is capped identically everywhere it can be set.
const { nameMaxLength: PROJECT_NAME_MAX_LENGTH } = require('../../contracts/project-limits.json');
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
}) {
  const {
    getProject, saveProjects, whenSaved = (fn) => fn(), pruneDocuments, withSourceLock, ensureProjectFolder, indexSource,
  } = store;
  // #1919: a deferred index removal runs after the save it waited for; by then a source of the same
  // name may have been uploaded again, and its fresh entries must stay. The names not listed now.
  const stillGone = (projectId, names) => {
    const listed = new Set(((getProject(projectId) || {}).files || []).map((f) => f && f.name));
    return names.filter((name) => !listed.has(name));
  };

  async function handle(req, res, { path: p, authn, url }) {
    // #2191 round 8 (rust-project-source-work.cjs): the upload, the folder sync and the folder import's plan
    // are the Rust front's, in the foreground and as source jobs (rust-source-jobs.cjs); index.cjs refuses
    // them before authentication. There is no worker call any more.

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

    // DELETE .../files (a source file's delete from storage) is the Rust front's (#2191 round 3,
    // rust-project-files.cjs); its RAG rows are an `unindex` job of the index outbox, run here.

    // GET .../uploads/original (#786) is the Rust front's (#2191, rust-project-reads.cjs).

    // A project's images (POST /api/projects/{id}/assets, GET and DELETE .../assets/{assetId}) are
    // the Rust front's (sbstndalton/noevia#1071): index.cjs refuses them before this mount
    // (rust-projects.cjs refuseOwnedRoute). Chat reads the stored bytes itself (assetDir).

    // DELETE /api/projects/{id}/chats/{chatId} is the Rust front's (sbstndalton/noevia#1071 slice 6):
    // index.cjs refuses it before this mount (rust-projects.cjs refuseOwnedRoute).

    return PASS;
  }

  return async function projectRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createProjectRoutes, IMAGE_UPLOAD_CAP, IMAGE_MIME, get MAX_PROJECT_IMAGES() { return sourceLimits.limits().images; } };
