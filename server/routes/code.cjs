'use strict';
// Code mode routes (spec-agent-execution §3). Admin-only, and absent (404) unless
// features.codeHarness is on.
//   GET  /api/projects/:id/code                                  -> { repositories, capabilities, tasks }
//   GET  /api/code/active                                         -> live tasks across this account's projects (admin only)
//   POST /api/projects/:id/code        { repository, prompt, capabilities?, domains?, model? } -> 202
//   GET  /api/projects/:id/code/:task                            -> task (incl. a waiting approval)
//   POST /api/projects/:id/code/:task/approve  { decision, approvalId } -> { ok }
//   POST /api/projects/:id/code/:task/cancel                      -> task
const PATTERN = /^\/api\/projects\/([^/]+)\/code(?:\/([0-9a-f-]{36}))?(?:\/(approve|cancel))?$/;

function createCodeRoutes({ service, features, getProject, projects = () => [], workspace, json, readJson }) {
  return async function codeRoutes(req, res, { path, authn }) {
    const activeSummary = path === '/api/code/active';
    const m = path.match(PATTERN);
    if (!m && !activeSummary) return false;
    const send = (status, body) => (json(res, status, body), true);
    if (!features.enabled('codeHarness')) return send(404, { error: 'Code mode is not enabled on this server.' });
    if (!authn || authn.user.role !== 'admin') return send(403, { error: 'Administrator required' });
    if (activeSummary) {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
      try {
        const ws = workspace();
        const visible = projects();
        const names = new Map(visible.map((project) => [project.id, project.name]));
        const active = service.listActive(ws, names.keys());
        const tasks = active.tasks.map((task) => ({ id: task.id, projectId: task.projectId,
          projectName: names.get(task.projectId), title: task.task, status: task.status,
          stage: task.stage, updatedAt: task.updatedAt, approvalAction: task.approval?.action || null }));
        return send(200, { tasks, total: active.total });
      } catch (error) { return send(error.status || 500, { error: error.publicMessage || 'Could not load active tasks' }); }
    }
    const project = getProject(decodeURIComponent(m[1]));
    if (!project) return send(404, { error: 'project not found' });
    const [, , taskId, action] = m;
    const ws = workspace();
    try {
      if (!taskId) {
        if (req.method === 'GET') {
          return send(200, { repositories: service.repositories(), capabilities: service.grantable,
            defaultCapabilities: service.defaultCapabilities, harnesses: service.harnesses(),
            promptPreparation: service.promptPreparation(), sandboxed: service.sandboxed(),
            network: typeof service.network === 'function' ? service.network() : false,
            tasks: service.list(ws, project) });
        }
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        return send(202, await service.start(ws, project, await readJson(req)));
      }
      if (!action) return req.method === 'GET' ? send(200, service.get(ws, project, taskId)) : send(405, { error: 'method not allowed' });
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
      if (action === 'cancel') return send(200, service.cancel(ws, project, taskId));
      const body = await readJson(req);
      return send(200, service.decide(ws, project, taskId, String(body?.decision || ''), String(body?.approvalId || '')));
    } catch (error) {
      if (error instanceof SyntaxError) return send(400, { error: 'invalid JSON' });
      return send(error.status || 500, { error: error.publicMessage || (error.status ? error.message : 'Code request failed') });
    }
  };
}

module.exports = { createCodeRoutes, PATTERN };
