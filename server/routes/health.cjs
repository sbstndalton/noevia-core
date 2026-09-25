'use strict';
// GET /api/health -> whether the default provider answers, whether the Diary sidecar answers
// (null when the add-on is off for this account), and whether project-file retrieval can run.
//
// Returns true when it handled the request. Auth runs before routes are mounted. Both probes
// are short and settle independently, so one sidecar being down never hides the other.
//
// GET /api/ready (#297) is separate and unauthenticated: it answers only whether the process has
// finished startup wiring, as {ready, version}. No tenant data, no upstream detail — a caller
// needs this before a session exists to check it with.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<{ok:boolean}>} deps.fetchJson
 * @param {(id:string) => object|null} deps.getProvider
 * @param {(provider:object) => object} deps.providerHeaders
 * @param {string} deps.DEFAULT_PROVIDER_ID
 * @param {string} deps.DIARY_BASE
 * @param {() => object} deps.diaryHeaders
 * @param {{ diaryEnabled: (userId:string) => boolean }} deps.authService
 * @param {{ ragAvailable: () => boolean }} deps.rag
 */
function createHealthRoutes({ json, fetchJson, getProvider, providerHeaders, DEFAULT_PROVIDER_ID, DIARY_BASE, diaryHeaders, authService, rag }) {
  async function handle(req, res, { path: p, authn }) {
    if (p === '/api/health') {
      const defaultProvider = getProvider(DEFAULT_PROVIDER_ID);
      const diaryEnabled = authService.diaryEnabled(authn.user.id);
      const [inference, diary] = await Promise.allSettled([
        fetchJson(`${defaultProvider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`, { headers: providerHeaders(defaultProvider) }, 5000),
        diaryEnabled ? fetchJson(`${DIARY_BASE}/api/health`, { headers: diaryHeaders('GET', `${DIARY_BASE}/api/health`) }, 5000) : Promise.resolve({ ok: false }),
      ]);
      return json(res, 200, {
        inferenceUp: inference.status === 'fulfilled' && inference.value.ok,
        lemonadeUp: inference.status === 'fulfilled' && inference.value.ok,
        diaryUp: diaryEnabled ? diary.status === 'fulfilled' && diary.value.ok : null,
        // True when project-file retrieval can run (native deps present).
        // False means RAG is silently degraded to keyword-only context.
        ragAvailable: rag.ragAvailable(),
      });
    }
    return PASS;
  }

  return async function healthRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

/**
 * GET /api/ready, mounted unauthenticated before the session gate (like the sign-in routes).
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {() => boolean} deps.isReady   true once startup wiring has finished
 * @param {string} deps.version          reported as-is; no upstream or tenant detail
 */
function createReadyRoutes({ json, isReady, version }) {
  return async function readyRoutes(req, res, { path: p }) {
    if (p === '/api/ready' && req.method === 'GET') {
      json(res, 200, { ready: !!isReady(), version: String(version || '') });
      return true;
    }
    return false;
  };
}

module.exports = { createHealthRoutes, createReadyRoutes };
