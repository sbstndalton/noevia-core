'use strict';
// The account's HTTP surface over auth.cjs that is still Node's. Sign-in, the session, sign-out,
// appearance, profile, app passwords, the Diary preference, onboarding, passkeys, session
// revocation, invitations, recovery, Settings -> Sharing and the user list/disable/recovery admin routes are the Rust
// front's (sbstndalton/noevia#1071; rust-auth.cjs OWNED_ROUTES refuses them before this module
// runs). What stays:
// (The signed-out "open" mount went with them: every signed-out route here is the front's.)
//   account   /api/admin/*: refused to members before its own
//             routes are looked at; the secrets rotation and deleting an account (its clean-up
//             spans Node's own stores, a rust-auth.cjs exemption) are Node's.
//
// It returns true when it handled the request. The session and CSRF checks stay in the
// router between the two mounts; an unmatched method falls through as it did inline.

const { requireJsonObject } = require('../http.cjs');

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<any>} deps.readJson
 * @param {object} deps.authService
 * @param {{ remove: (userId:string) => void }} deps.workspaceStore
 * @param {{ removeUser: (userId:string) => Promise<any> }} deps.driveAccounts
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<any>} deps.fetchJson
 * @param {string} deps.DIARY_BASE
 * @param {string} deps.DIARY_TOKEN
 * @param {(userId:string, method:string, url:string) => object} [deps.diaryTenantHeaders]  diary.cjs tenantHeaders (signed)
 * @param {{ forgetUser: (userId:string) => void }} [deps.mcpOAuth]      OAuth sign-ins, keyed per (user, server)
 * @param {{ forgetUser: (userId:string) => void }} [deps.directoryMcp]  directory server keys, keyed per (user, server)
 * @param {{ forgetUser: (userId:string) => Promise<void> }} [deps.chatgptOAuth]  Sign in with ChatGPT tokens (the Rust broker's), keyed per user
 * @param {(actorId:string) => object|Promise<object>} [deps.rotateSecrets]  re-encrypts stored credentials under the current key
 */
function createAuthRoutes({ json, readJson: readAnyJson, authService, workspaceStore, driveAccounts, fetchJson, DIARY_BASE, DIARY_TOKEN, diaryTenantHeaders = null, mcpOAuth, directoryMcp, chatgptOAuth = null, rotateSecrets }) {
  // Every body these routes read is a JSON object; `null`, an array or a number is a 400 (#786).
  const readJson = requireJsonObject(readAnyJson);
  async function account(req, res, { path: p, authn }) {
    if (p.startsWith('/api/admin/')) {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required' });
      if (p === '/api/admin/secrets/rotate' && req.method === 'POST') {
        if (!rotateSecrets) return json(res, 501, { error: 'secrets rotation is not available' });
        try { return json(res, 200, await rotateSecrets(authn.user.id)); } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
      }
      const userRoute = p.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userRoute && req.method === 'DELETE') {
        try {
          const id = decodeURIComponent(userRoute[1]); const ok = authService.deleteUser(authn.user.id, id, (await readJson(req)).username);
          if (ok) {
            workspaceStore.remove(id);
            await driveAccounts.removeUser(id);
            mcpOAuth?.forgetUser(id);
            directoryMcp?.forgetUser(id);
            // The broker deletes the account's ChatGPT tokens (sbstndalton/noevia#2190 round 5); a
            // failure is reported without detail and does not undo the deletion.
            await Promise.resolve(chatgptOAuth?.forgetUser(id)).catch((e) => console.warn(`ChatGPT tokens of a deleted account were not removed (${e?.code || e?.status || 'error'}).`));
            const target = `${DIARY_BASE}/api/internal/tenant`;
            // Signed with DIARY_TENANT_KEY when set: the sidecar refuses an unasserted delete.
            let headers = diaryTenantHeaders ? diaryTenantHeaders(id, 'DELETE', target) : null;
            if (!headers) { headers = { 'X-Cowork-User-ID': id }; if (DIARY_TOKEN) headers.Authorization = `Bearer ${DIARY_TOKEN}`; }
            await fetchJson(target, { method: 'DELETE', headers }, 15000).catch(() => null);
          }
          return json(res, ok ? 200 : 400, { ok });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 404, { error: 'not found' });
    }
    return PASS;
  }

  const mount = (fn) => async (req, res, ctx) => (await fn(req, res, ctx)) !== PASS;
  return { account: mount(account) };
}

module.exports = { createAuthRoutes };
