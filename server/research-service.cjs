'use strict';
// Deep research as a project feature (docs/spec-deep-research.md §3–4, build order §9.4–5):
// plan, start, progress, cancel, explicit partial save, report files. Admin-only and behind
// features.deepResearch (D12). Every dependency is injected; nothing here reaches index.cjs.
const crypto = require('node:crypto');
const { createResearchJobs } = require('./research-jobs.cjs');
const { createResearchRunner, DEFAULTS } = require('./research-runner.cjs');
const { createPlanner, sanitizePlan } = require('./research-plan.cjs');

// D12 default budget: 12 web calls, 10 minutes, 5 sources per sub-question.
const BUDGET = Object.freeze({ maxWebCalls: 12, maxMs: 10 * 60000, resultsPerQuery: 5 });

const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: message });

function slug(text) {
  return String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'research';
}

/** The two files a report is saved as. Plain names: uploads place them in the project's Text folder. */
function reportFiles(result, when, taken = () => false) {
  const date = new Date(when).toISOString().slice(0, 10);
  const stem = `Research ${date} ${slug(result.question)}`;
  let base = stem;
  // Never overwrite an earlier report: the same question on the same day gets a numbered name.
  for (let n = 2; taken(`${base}.md`) || taken(`${base}.sources.json`); n++) base = `${stem} (${n})`;
  // Sentences carry the IDs the claims were verified against; dropped and flagged claims are kept
  // here so verification never silently loses what the model wrote (#707).
  const sources = result.sources.map(({ id, kind, url, file, title, retrievedAt, excerpts, sentences = [] }) => ({ id, kind, url, file, title, retrievedAt, excerpts, sentences }));
  const verification = { claims: result.claims || null, dropped: result.dropped || [], flagged: result.flagged || [] };
  return [
    { name: `${base}.md`, text: result.markdown },
    { name: `${base}.sources.json`, text: JSON.stringify({ question: result.question, partial: !!result.partial, citationValidity: result.citationValidity, webCalls: result.webCalls, ...verification, sources }, null, 2) + '\n' },
  ];
}

// A failed job's result is whatever the failing code attached; only a finished report (markdown and
// its sources) can be written out again.
const hasReport = (r) => typeof r.markdown === 'string' && Array.isArray(r.sources);

/** Public view of a job: no excerpts, bounded markdown. */
function view(job, project) {
  if (!job) return null;
  const r = job.result;
  const pending = job.pendingFile;
  const indexedPending = !!pending && (project?.files || []).some((f) => String(f.name).split('/').pop() === pending.name
    && f.attachment?.id === pending.hash && f.attachment?.bytes === pending.bytes);
  return { id: job.id, status: job.status, stage: job.stage, plan: job.plan, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt,
    checkpoint: job.checkpoint, artifacts: job.artifacts.map((a) => a.name),
    result: r ? { question: r.question, partial: r.partial, sections: r.sections, questions: r.questions, citationValidity: r.citationValidity,
      citations: r.citations, claims: r.claims || null, webCalls: r.webCalls, markdown: String(r.markdown || '').slice(0, 200000), sources: (r.sources || []).length } : null,
    // A cancelled job with finished sections, or a failed job that still holds its report (the save
    // threw), until the sources file, which is always written last, has been saved.
    canSavePartial: !!r && !job.pendingFile && ((job.status === 'cancelled' && r.sections > 0) || (job.status === 'failed' && hasReport(r))) && !job.artifacts.some((a) => a.name.endsWith('.sources.json')),
    // The same savePartial endpoint first reconciles an indexed exact file, then writes only
    // missing files. Keep canSavePartial false until reconciliation succeeds; expose the safe
    // retry action only after the index has the intended SHA-256 and byte length.
    saveUncertain: pending ? { name: pending.name, canReconcile: indexedPending } : null };
}

/**
 * @param {{ jobsDir:(workspace)=>string, tools:(workspace, project)=>{search, extract, projectRetrieve, complete, windowTokens?},
 *           saveFile:(project, name, text)=>Promise<void>, getProject?:(id)=>object|null, now?:()=>number }} deps
 */
function createResearchService({ tools, saveFile, getProject, now = Date.now, jobsFactory = createResearchJobs }) {
  const stores = new WeakMap();
  const currentProject = (project) => getProject ? getProject(project.id) : project;
  const publicView = (job, project) => view(job, currentProject(project));
  const storeFor = (workspace) => {
    let store = stores.get(workspace);
    if (!store) {
      store = jobsFactory(workspace);
      stores.set(workspace, store);
    }
    return store;
  };
  const owned = async (workspace, project, id) => {
    const job = await storeFor(workspace).get(id, project.id);
    if (!job || job.kind !== 'deep_research' || job.projectId !== project.id) throw fail(404, 'No such research job.');
    return job;
  };
  // Jobs whose report is being written right now. The artifact is recorded only after its file is
  // written (a failed write must not leave an artifact that does not exist), so this in-memory guard,
  // not the journal, is what stops two concurrent callers (natural finish, a double-clicked or
  // retried save) from writing the same report twice.
  const saving = new Set();
  async function save(workspace, project, id, result) {
    const jobs = storeFor(workspace);
    if (saving.has(id)) throw fail(409, 'This report is already being saved.');
    saving.add(id);
    try {
      let job = await jobs.get(id, project.id);
      // Keep the complete result before any external PUT, so a lost terminal response or
      // store outage cannot turn a partially written report into an unrecoverable journal.
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) await jobs.report(id, result);
      // The project object held by the worker may have been replaced or deleted meanwhile.
      const current = getProject ? getProject(project.id) : project;
      if (!current) throw fail(410, 'The project was deleted while this research was running; the report could not be saved.');
      if (job.pendingFile) {
        const pending = job.pendingFile;
        // A storage PUT or journal acknowledgement may have landed. Only the current project's
        // indexed attachment with the exact intended bytes can prove it; absence is not proof
        // that remote storage has no file. Never reissue an ordinary PUT on that assumption.
        const indexed = (current.files || []).find((f) => String(f.name).split('/').pop() === pending.name
          && f.attachment?.id === pending.hash && f.attachment?.bytes === pending.bytes);
        if (!indexed) throw fail(409, `The save of "${pending.name}" has an unknown outcome. Sync this project's Sources and review that file before trying again.`);
        await jobs.artifact(id, project.id, pending.name, pending.hash, pending.bytes);
        job = await jobs.get(id, project.id);
      }
      const names = new Set((current.files || []).map((f) => String(f.name).split('/').pop()));
      const files = reportFiles(result, now(), (name) => names.has(name));
      const first = job.artifacts.find((a) => a.name.endsWith('.md'));
      if (first) { const base = first.name.slice(0, -3); files[0].name = `${base}.md`; files[1].name = `${base}.sources.json`; }
      for (const file of files) {
        job = await jobs.get(id, project.id);
        if (job.artifacts.some((a) => a.name === file.name)) continue;
        const bytes = Buffer.from(file.text, 'utf8');
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        // This intent must be durable before invoking writeProjectTextFile: it can fail after
        // a remote PUT, a project-list save, or an indexing side effect.
        await jobs.prepareFile(id, project.id, file.name, hash, bytes.length);
        try { await saveFile(current, file.name, file.text); }
        catch (error) {
          // Only a proven pre-write refusal may clear the intent. The production file API does
          // not give that guarantee for a generic failure, even if it reports ENOSPC.
          if (error.definitelyNotWritten === true) await jobs.clearFile(id, project.id, file.name, hash);
          else error.publicMessage = `The save of "${file.name}" has an unknown outcome. Sync this project's Sources and review that file before trying again.`;
          throw error;
        }
        await jobs.artifact(id, project.id, file.name, hash, bytes.length);
      }
    } catch (error) {
      if (!error.status && !error.publicMessage) error.publicMessage = 'The report was finished but could not be saved. Use the save button to try again.';
      error.result = result;
      throw error;
    } finally { saving.delete(id); }
  }
  return {
    budget: BUDGET,
    async plan(workspace, project, question, { signal } = {}) {
      const t = tools(workspace, project);
      return createPlanner({ complete: t.complete, windowTokens: t.windowTokens || DEFAULTS.windowTokens }).plan(question, { signal });
    },
    async start(workspace, project, body) {
      const question = String(body?.question || '').trim();
      if (!question) throw fail(400, 'Write a research question first.');
      if (question.length > 2000) throw fail(400, 'Keep the research question under 2000 characters.');
      const mode = body?.plan === 'proposed' || body?.plan === 'edited' ? body.plan : 'skipped';
      let subQuestions = null;
      try { subQuestions = mode === 'skipped' ? null : sanitizePlan(body.subQuestions); }
      catch (error) { throw fail(400, error.publicMessage || error.message); }
      const jobs = storeFor(workspace);
      if ((await jobs.list({ projectId: project.id, active: true })).length) throw fail(409, 'A research job is already running in this project. Wait for it or cancel it.');
      const t = tools(workspace, project);
      const runner = createResearchRunner({ jobs, search: t.search, extract: t.extract, projectRetrieve: t.projectRetrieve, complete: t.complete, now,
        options: { ...BUDGET, ...(t.windowTokens ? { windowTokens: t.windowTokens } : {}) } });
      const { id, done } = await runner.start({ question, projectId: project.id, subQuestions, plan: mode,
        finish: async (result, ctx) => { ctx.progress('Saving the report'); await ctx.flush?.(); return save(workspace, project, ctx.id, result); } });
      done.catch(() => undefined);
      return publicView(await jobs.get(id, project.id), project);
    },
    async list(workspace, project) {
      return (await storeFor(workspace).list({ projectId: project.id })).slice(0, 20).map((job) => publicView(job, project));
    },
    async get(workspace, project, id) { return publicView(await owned(workspace, project, id), project); },
    async cancel(workspace, project, id) {
      await owned(workspace, project, id);
      return publicView(await storeFor(workspace).cancel(id, project.id), project);
    },
    async savePartial(workspace, project, id) {
      const job = await owned(workspace, project, id);
      const eligible = !!job.result && ((job.status === 'cancelled' && job.result.sections > 0) || (job.status === 'failed' && hasReport(job.result)))
        && !job.artifacts.some((a) => a.name.endsWith('.sources.json'));
      if (!eligible) throw fail(409, job.artifacts.length ? 'This report is already saved.' : 'Only a cancelled job with finished sections, or a report that failed to save, can be saved.');
      await save(workspace, project, id, job.result);
      return publicView(await storeFor(workspace).get(id, project.id), project);
    },
  };
}

module.exports = { createResearchService, reportFiles, slug, view, BUDGET };
