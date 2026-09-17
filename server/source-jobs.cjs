'use strict';
// Result polling keeps long OCR/refresh requests below reverse-proxy timeouts. Built on the
// durable job store, so a poll after a restart gets a clear answer instead of "no such job".
// Source originals and results still live in the existing store; jobs hold status only.
const { createJobs } = require('./jobs.cjs');
const stores = new WeakMap();
function storeFor(workspace) {
  let store = stores.get(workspace);
  if (!store) {
    store = createJobs({ dir: workspace.dir, retainMs: 15 * 60000, maxJobs: 16 });
    store.recover();
    stores.set(workspace, store);
  }
  return store;
}
function start(workspace, projectId, operation) {
  const jobs = storeFor(workspace);
  if (jobs.list({ kind: 'source', active: true }).length >= 2) throw Object.assign(new Error('Source processing is busy; wait for the current operation and retry.'), { status: 429 });
  const id = jobs.create({ kind: 'source', projectId, capabilities: ['project.sources.write'] });
  jobs.run(id, async (ctx) => {
    try { return await operation((stage) => ctx.progress(stage)); }
    catch (err) { throw Object.assign(new Error('Source processing failed; refresh or re-upload to retry.'), { result: { status: err.status || 500 } }); }
  }).catch(() => undefined);
  return id;
}
function read(workspace, projectId, id) {
  let job;
  try { job = storeFor(workspace).get(id); } catch { return null; }
  if (!job || job.kind !== 'source' || job.projectId !== projectId) return null;
  if (job.status === 'completed') return { done: true, status: job.result?.status, body: job.result?.body };
  if (job.status === 'failed') return { done: true, status: job.result?.status || 500, body: { error: job.error } };
  if (job.status === 'interrupted' || job.status === 'cancelled') return { done: true, status: 503, body: { error: 'The server restarted before processing finished; refresh or re-upload to retry.' } };
  return { done: false, ...(job.stage ? { stage: job.stage } : {}) };
}
module.exports = { start, read };
