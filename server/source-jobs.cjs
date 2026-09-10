'use strict';
const crypto = require('node:crypto');
// Result polling keeps long OCR/refresh requests below reverse-proxy timeouts.
// Jobs contain no durable data; source originals/results use the existing store.
const workspaces = new WeakMap();
function start(workspace, projectId, operation) {
  let jobs = workspaces.get(workspace);
  if (!jobs) workspaces.set(workspace, jobs = new Map());
  for (const [id, job] of jobs) if (job.done && Date.now() - job.finished > 900000) jobs.delete(id);
  if ([...jobs.values()].filter(j => !j.done).length >= 2) throw Object.assign(new Error('Source processing is busy; wait for the current operation and retry.'), { status: 429 });
  while (jobs.size >= 16) {
    const old = [...jobs].find(([, j]) => j.done);
    if (!old) break;
    jobs.delete(old[0]);
  }
  const id = crypto.randomUUID();
  const job = { projectId, done: false };
  jobs.set(id, job);
  Promise.resolve().then(operation).then(result => Object.assign(job, result), err => Object.assign(job, { status: err.status || 500, body: { error: 'Source processing failed; refresh or re-upload to retry.' } })).finally(() => { job.done = true; job.finished = Date.now(); });
  return id;
}
function read(workspace, projectId, id) {
  const job = workspaces.get(workspace)?.get(id);
  if (!job || job.projectId !== projectId || (job.done && Date.now() - job.finished > 900000)) return null;
  return job.done ? { done: true, status: job.status, body: job.body } : { done: false };
}
module.exports = { start, read };
