'use strict';
// Deep research as a project feature (docs/spec-deep-research.md §3–4, build order §9.4–5):
// plan, start, progress, cancel, explicit partial save, report files. Admin-only and behind
// features.deepResearch (D12). Every dependency is injected; nothing here reaches index.cjs.
const { createJobs } = require('./jobs.cjs');
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
  const sources = result.sources.map(({ id, kind, url, file, title, retrievedAt, excerpts }) => ({ id, kind, url, file, title, retrievedAt, excerpts }));
  return [
    { name: `${base}.md`, text: result.markdown },
    { name: `${base}.sources.json`, text: JSON.stringify({ question: result.question, partial: !!result.partial, citationValidity: result.citationValidity, webCalls: result.webCalls, sources }, null, 2) + '\n' },
  ];
}

/** Public view of a job: no excerpts, bounded markdown. */
function view(job) {
  if (!job) return null;
  const r = job.result;
  return { id: job.id, status: job.status, stage: job.stage, plan: job.plan, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt,
    checkpoint: job.checkpoint, artifacts: job.artifacts.map((a) => a.name),
    result: r ? { question: r.question, partial: r.partial, sections: r.sections, questions: r.questions, citationValidity: r.citationValidity,
      citations: r.citations, webCalls: r.webCalls, markdown: String(r.markdown || '').slice(0, 200000), sources: (r.sources || []).length } : null,
    canSavePartial: job.status === 'cancelled' && !!r && r.sections > 0 && !job.artifacts.length };
}

/**
 * @param {{ jobsDir:(workspace)=>string, tools:(workspace, project)=>{search, extract, projectRetrieve, complete, windowTokens?},
 *           saveFile:(project, name, text)=>Promise<void>, getProject?:(id)=>object|null, now?:()=>number }} deps
 */
function createResearchService({ tools, saveFile, getProject, now = Date.now }) {
  const stores = new WeakMap();
  const storeFor = (workspace) => {
    let store = stores.get(workspace);
    if (!store) {
      store = createJobs({ dir: workspace.dir, kinds: ['deep_research'], maxJobs: 50, retainMs: 30 * 86400000, now });
      store.recover();
      stores.set(workspace, store);
    }
    return store;
  };
  const owned = (workspace, project, id) => {
    let job;
    try { job = storeFor(workspace).get(id); } catch { job = null; }
    if (!job || job.kind !== 'deep_research' || job.projectId !== project.id) throw fail(404, 'No such research job.');
    return job;
  };
  async function save(workspace, project, id, result) {
    const jobs = storeFor(workspace);
    // The job holds the `project` object from when it started, minutes before the report is
    // ready; PROJECTS may have replaced or deleted it meanwhile. Look it up by id at save time
    // instead of trusting the stale reference, so a rename/edit elsewhere doesn't lose the report.
    const current = getProject ? getProject(project.id) : project;
    if (!current) throw fail(410, 'The project was deleted while this research was running; the report could not be saved.');
    const names = new Set((current.files || []).map((f) => String(f.name).split('/').pop()));
    for (const file of reportFiles(result, now(), (name) => names.has(name))) {
      // A natural finish and an explicit savePartial (or a retried request) can race to save
      // the same job. jobs.append/get are synchronous, so reserving the artifact name here,
      // before the async write below, makes the second concurrent caller see it already
      // recorded and skip its write instead of saving the same report twice.
      if (jobs.get(id).artifacts.some((a) => a.name === file.name)) continue;
      jobs.append(id, 'artifact.created', { name: file.name, bytes: Buffer.byteLength(file.text) });
      await saveFile(current, file.name, file.text);
    }
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
      if (jobs.list({ projectId: project.id, kind: 'deep_research', active: true }).length) throw fail(409, 'A research job is already running in this project. Wait for it or cancel it.');
      const t = tools(workspace, project);
      const runner = createResearchRunner({ jobs, search: t.search, extract: t.extract, projectRetrieve: t.projectRetrieve, complete: t.complete, now,
        options: { ...BUDGET, ...(t.windowTokens ? { windowTokens: t.windowTokens } : {}) } });
      const { id, done } = await runner.start({ question, projectId: project.id, subQuestions, plan: mode,
        finish: (result, ctx) => { ctx.progress('Saving the report'); return save(workspace, project, ctx.id, result); } });
      done.catch(() => undefined);
      return view(jobs.get(id));
    },
    list(workspace, project) {
      return storeFor(workspace).list({ projectId: project.id, kind: 'deep_research' }).slice(0, 20).map(view);
    },
    get(workspace, project, id) { return view(owned(workspace, project, id)); },
    cancel(workspace, project, id) {
      owned(workspace, project, id);
      return view(storeFor(workspace).cancel(id));
    },
    async savePartial(workspace, project, id) {
      const job = owned(workspace, project, id);
      if (!view(job).canSavePartial) throw fail(409, job.artifacts.length ? 'This report is already saved.' : 'Only a cancelled job with finished sections can be saved.');
      await save(workspace, project, id, job.result);
      return view(storeFor(workspace).get(id));
    },
  };
}

module.exports = { createResearchService, reportFiles, slug, view, BUDGET };
