'use strict';
// Deep research routes (D12). Admin-only, and absent (404) unless features.deepResearch is on.
//   POST /api/projects/:id/research/plan        { question }                     -> { subQuestions }
//   GET  /api/projects/:id/research                                              -> { budget, jobs }
//   POST /api/projects/:id/research              { question, plan?, subQuestions? } -> 202 job
//   GET  /api/projects/:id/research/:job                                         -> job
//   POST /api/projects/:id/research/:job/cancel                                  -> job
//   POST /api/projects/:id/research/:job/save                                    -> job (partial save)
const PATTERN = /^\/api\/projects\/([^/]+)\/research(?:\/(plan|[0-9a-f-]{36}))?(?:\/(cancel|save))?$/;

function createResearchRoutes({ service, features, getProject, workspace, available, json, readJson }) {
  return async function researchRoutes(req, res, { path, authn }) {
    const m = path.match(PATTERN);
    if (!m) return false;
    const send = (status, body) => (json(res, status, body), true);
    if (!features.enabled('deepResearch')) return send(404, { error: 'Deep research is not enabled on this server.' });
    if (!authn || authn.user.role !== 'admin') return send(403, { error: 'Administrator required' });
    const project = getProject(decodeURIComponent(m[1]));
    if (!project) return send(404, { error: 'project not found' });
    const [, , target, action] = m;
    const ws = workspace();
    try {
      if (target === 'plan') {
        if (req.method !== 'POST' || action) return send(405, { error: 'method not allowed' });
        const reason = available(project);
        if (reason) return send(409, { error: reason });
        const body = await readJson(req);
        return send(200, { subQuestions: await service.plan(ws, project, body?.question) });
      }
      if (!target) {
        if (req.method === 'GET') return send(200, { budget: service.budget, available: !available(project), reason: available(project) || null, jobs: service.list(ws, project) });
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        const reason = available(project);
        if (reason) return send(409, { error: reason });
        return send(202, await service.start(ws, project, await readJson(req)));
      }
      if (!action) return req.method === 'GET' ? send(200, service.get(ws, project, target)) : send(405, { error: 'method not allowed' });
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
      if (action === 'cancel') return send(200, service.cancel(ws, project, target));
      return send(200, await service.savePartial(ws, project, target));
    } catch (error) {
      if (error instanceof SyntaxError) return send(400, { error: 'invalid JSON' });
      return send(error.status || 500, { error: error.publicMessage || (error.status ? error.message : 'Research request failed') });
    }
  };
}

/** Pull {url,title} results out of a search tool's text output (JSON or "Title:/URL:" lines). */
function parseSearchResults(text) {
  const raw = String(text || '');
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.results;
    if (Array.isArray(list)) return list.filter((r) => r && typeof r.url === 'string').map((r) => ({ url: r.url, title: String(r.title || r.url) }));
  } catch { /* text form */ }
  const out = [];
  let title = '';
  for (const line of raw.split('\n')) {
    const t = line.match(/^\s*Title:\s*(.+)$/i);
    if (t) { title = t[1].trim(); continue; }
    const u = line.match(/^\s*URL:\s*(https?:\/\/\S+)/i);
    if (u) { out.push({ url: u[1], title: title || u[1] }); title = ''; }
  }
  return out;
}

module.exports = { createResearchRoutes, parseSearchResults, PATTERN };
