'use strict';
// GET /api/reasoning-settings[?projectId]  -> the server default, the effort this project
//                                             resolves to, and how the provider will be asked
// PUT /api/reasoning-settings { default }   -> the server default, administrators only
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// The resolution and the request shape are reasoning-effort.cjs; the default lives in the
// settings table.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<string>} deps.readBody
 * @param {object} deps.authService        db and audit
 * @param {(id:string) => object|null} deps.getProject
 * @param {(id:string) => object|null} deps.getProvider
 * @param {object} deps.reasoningEffort
 * @param {string} deps.DEFAULT_PROVIDER_ID
 */
function createReasoningSettingsRoutes({ json, readBody, authService, getProject, getProvider, reasoningEffort, DEFAULT_PROVIDER_ID }) {
  async function handle(req, res, { path: p, authn, url }) {
    if (p === '/api/reasoning-settings') {
      const globalDefault = () => authService.db.prepare("SELECT value FROM settings WHERE key='reasoning_effort_default'").get()?.value || 'default';
      if (req.method === 'GET') {
        const project = url.searchParams.has('projectId') ? getProject(url.searchParams.get('projectId')) : null;
        if (url.searchParams.has('projectId') && !project) return json(res,404,{error:'no such project'});
        const effort = reasoningEffort.resolveEffort(project,globalDefault());
        const provider = getProvider(project?.provider || DEFAULT_PROVIDER_ID);
        return json(res,200,{default:globalDefault(),effort,mode:reasoningEffort.modeFor(provider,project?.model || '',effort),admin:authn.user.role === 'admin'});
      }
      if (req.method === 'PUT') {
        if (authn.user.role !== 'admin') return json(res,403,{error:'Administrator required'});
        let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res,400,{error:'invalid JSON'}); }
        if (!reasoningEffort.validEffort(body.default)) return json(res,400,{error:'default must be default, low or high'});
        authService.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('reasoning_effort_default',?)").run(body.default);
        authService.audit('reasoning.default',authn.user.id,null,{effort:body.default});
        return json(res,200,{default:body.default});
      }
      return json(res,405,{error:'Method not allowed'});
    }
    return PASS;
  }

  return async function reasoningSettingsRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createReasoningSettingsRoutes };
