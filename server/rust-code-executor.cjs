'use strict';
// Rust port track R7: with NOEVIA_CODE_EXECUTOR=rust the Rust front runs Code tasks (start, approve, cancel, the
// harness, the job store) and this process runs none. Unset (the default), nothing here changes anything.
//
// When the front owns Code mode:
//   - code-service.cjs never recovers a tenant's code journals or worktrees (the front's own live tasks would be
//     marked interrupted) and refuses start, decide and cancel with REFUSED; reading a task list still works;
//   - the task facts bridge (rust-task-facts.cjs) answers the flag only, and the front adds its own facts;
//   - this bridge answers what only this process knows for one start:
//
//   POST /internal/code/engine {user, projectId}
//     -> {engine: {baseUrl, apiKey, model, contextTokens}|null, machine, paused, context}
//        `machine`: the Code role runs on an inference machine (the relay is not the front's yet, so it refuses);
//        `paused`: auto-tune or calibration is active; `context`: the project's shared context for Code ('' off).
//        With `role` given (R7 P4, the front's Code pipeline), also
//        `role: {baseUrl, apiKey, model, external, jsonSchema}|null`: the role engine's endpoint (index.cjs
//        `codeRoleEndpoint`: the provider as this process reaches it, not CODE_ENGINE_URL), whose key is also the
//        leak guard's `engineKey`; `jsonSchema` is the provider's `capabilities.jsonSchemaParam`. `null` on a machine.
//     -> 404 when the project is not that user's.
//
// Reached only by the front's own loopback calls (trusted-front.cjs); anything else gets the 404 of an unknown path.
const { trustedFront } = require('./trusted-front.cjs');

const PATH = '/internal/code/engine';
const REFUSED = 'Code tasks run in the native executor on this server.';

/** Whether the Rust front owns Code tasks (NOEVIA_CODE_EXECUTOR=rust). */
function frontOwnsCode(env = process.env) { return env.NOEVIA_CODE_EXECUTOR === 'rust'; }

/** The role engine's endpoint, without the provider record itself (only its JSON-schema capability). */
function roleFacts(endpoint) {
  if (!endpoint) return null;
  return { baseUrl: endpoint.baseUrl ?? null, apiKey: endpoint.apiKey ?? null, model: endpoint.model ?? null,
    external: endpoint.external === true, jsonSchema: endpoint.provider?.capabilities?.jsonSchemaParam === true };
}

function createCodeEngineBridge({ secret, json, readJson, asUser, getProject, engine, machine, paused, context, role = null, log = (m) => console.warn(m) }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const { user, projectId } = body || {};
    if (typeof user !== 'string' || !user || typeof projectId !== 'string' || !projectId) { json(res, 400, { error: 'A user and a project are required.' }); return true; }
    try {
      const answer = await asUser(user, () => {
        const project = getProject(projectId);
        if (!project) return null;
        const remote = machine() === true;
        const endpoint = remote ? null : engine();
        return {
          engine: endpoint ? { baseUrl: endpoint.baseUrl ?? null, apiKey: endpoint.apiKey ?? null, model: endpoint.model ?? null,
            contextTokens: endpoint.contextTokens ?? null } : null,
          machine: remote, paused: !remote && paused() === true, context: String(context(project) || ''),
          ...(role ? { role: roleFacts(remote ? null : role()) } : {}),
        };
      });
      if (!answer) { json(res, 404, { error: 'project not found' }); return true; }
      json(res, 200, answer);
    } catch (e) {
      log(`[code] engine facts failed: ${e?.code || e?.name || 'error'}`);
      json(res, 503, { error: 'Code engine facts are unavailable.' });
    }
    return true;
  };
}

module.exports = { PATH, REFUSED, frontOwnsCode, createCodeEngineBridge };
