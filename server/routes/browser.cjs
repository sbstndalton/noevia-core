'use strict';
// Browser mode routes (issue #274, spec-agent-execution §6 wired to §4's job primitive).
// Admin-only, and absent (404) unless features.browserExecutor is on — same shape as
// routes/code.cjs on purpose, so the two surfaces are easy to keep in step.
//   GET  /api/projects/:id/browser                                   -> { capabilities, network, tasks }
//   POST /api/projects/:id/browser        { domains }                -> 202 { taskId, domains }
//   GET  /api/projects/:id/browser/:task                             -> task (incl. a waiting approval)
//   POST /api/projects/:id/browser/:task/act     { type, ... }       -> action result
//   POST /api/projects/:id/browser/:task/approve { decision, approvalId } -> { ok }
//   POST /api/projects/:id/browser/:task/finish  { result }          -> { ok }
//   POST /api/projects/:id/browser/:task/cancel                      -> task
const PATTERN = /^\/api\/projects\/([^/]+)\/browser(?:\/([0-9a-f-]{36}))?(?:\/(act|approve|finish|cancel))?$/;

function createBrowserRoutes({ service, features, getProject, workspace, json, readJson }) {
  return async function browserRoutes(req, res, { path, authn }) {
    const m = path.match(PATTERN);
    if (!m) return false;
    const send = (status, body) => (json(res, status, body), true);
    if (!features.enabled('browserExecutor')) return send(404, { error: 'Browser mode is not enabled on this server.' });
    if (!authn || authn.user.role !== 'admin') return send(403, { error: 'Administrator required' });
    const project = getProject(decodeURIComponent(m[1]));
    if (!project) return send(404, { error: 'project not found' });
    const [, , taskId, action] = m;
    const ws = workspace();
    try {
      if (!taskId) {
        if (req.method === 'GET') {
          return send(200, { capabilities: service.grantable, network: typeof service.network === 'function' ? service.network() : false,
            tasks: service.list(ws, project) });
        }
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        return send(202, await service.start(ws, project, await readJson(req)));
      }
      if (!action) return req.method === 'GET' ? send(200, service.get(ws, project, taskId)) : send(405, { error: 'method not allowed' });
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
      if (action === 'cancel') return send(200, service.cancel(ws, project, taskId));
      const body = await readJson(req);
      if (action === 'act') return send(200, await service.act(ws, project, taskId, body));
      if (action === 'finish') return send(200, service.finish(ws, project, taskId, body?.result ?? null));
      return send(200, service.decide(ws, project, taskId, String(body?.decision || ''), String(body?.approvalId || '')));
    } catch (error) {
      if (error instanceof SyntaxError) return send(400, { error: 'invalid JSON' });
      return send(error.status || 500, { error: error.publicMessage || (error.status ? error.message : 'Browser request failed') });
    }
  };
}

module.exports = { createBrowserRoutes, PATTERN };
