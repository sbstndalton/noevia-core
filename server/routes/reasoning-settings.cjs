'use strict';
// GET /api/reasoning-settings[?projectId]  -> the server default, the effort this project
//                                             resolves to, and how the provider will be asked
// PUT /api/reasoning-settings               -> the Rust front's (sbstndalton/noevia#1071; noevia-rs
//                                             crates/server-reasoning-settings): refused here
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// The resolution and the request shape are reasoning-effort.cjs; the default lives in the
// settings table.

const PASS = Symbol('unhandled');
const PUT_REFUSAL = Object.freeze({ error: 'Reasoning settings are owned by the Rust front.' });

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {object} deps.authService        db
 * @param {(id:string) => object|null} deps.getProject
 * @param {(id:string) => object|null} deps.getProvider
 * @param {object} deps.reasoningEffort
 * @param {string} deps.DEFAULT_PROVIDER_ID
 */
function createReasoningSettingsRoutes({ json, authService, getProject, getProvider, reasoningEffort, DEFAULT_PROVIDER_ID }) {
  async function handle(req, res, { path: p, authn, url }) {
    if (p === '/api/reasoning-settings') {
      // The front answers PUT; one that reaches Node is a bypass, refused before anything is read.
      if (req.method === 'PUT') return json(res, 503, PUT_REFUSAL);
      const globalDefault = () => authService.db.prepare("SELECT value FROM settings WHERE key='reasoning_effort_default'").get()?.value || 'default';
      if (req.method === 'GET') {
        const project = url.searchParams.has('projectId') ? getProject(url.searchParams.get('projectId')) : null;
        if (url.searchParams.has('projectId') && !project) return json(res,404,{error:'no such project'});
        const effort = reasoningEffort.resolveEffort(project,globalDefault());
        const provider = getProvider(project?.provider || DEFAULT_PROVIDER_ID);
        return json(res,200,{default:globalDefault(),effort,mode:reasoningEffort.modeFor(provider,project?.model || '',effort),admin:authn.user.role === 'admin'});
      }
      return json(res,405,{error:'Method not allowed'});
    }
    return PASS;
  }

  return async function reasoningSettingsRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createReasoningSettingsRoutes, PUT_REFUSAL };
