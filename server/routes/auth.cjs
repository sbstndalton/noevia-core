'use strict';
// The account's HTTP surface over auth.cjs that is still Node's. Sign-in, the session, sign-out,
// appearance, profile, app passwords, the Diary preference, onboarding, passkeys, session
// revocation, invitations, recovery, Settings -> Sharing and the user list/disable/recovery admin routes are the Rust
// front's (sbstndalton/noevia#1071; rust-auth.cjs OWNED_ROUTES refuses them before this module
// runs), and since #2190/#2191 round 9 so is deleting an account (rust-admin-users.cjs).
// What stays:
// (The signed-out "open" mount went with them: every signed-out route here is the front's.)
//   account   /api/admin/*: refused to members before its own routes are looked at; the secrets rotation
//             (it re-encrypts Node's own stores) is Node's.
//
// It returns true when it handled the request. The session and CSRF checks stay in the
// router between the two mounts; an unmatched method falls through as it did inline.

const { requireJsonObject } = require('../http.cjs');

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<any>} deps.readJson
 * @param {(actorId:string) => object|Promise<object>} [deps.rotateSecrets]  re-encrypts stored credentials under the current key
 */
function createAuthRoutes({ json, readJson: readAnyJson, rotateSecrets }) {
  // Every body these routes read is a JSON object; `null`, an array or a number is a 400 (#786).
  const readJson = requireJsonObject(readAnyJson);
  async function account(req, res, { path: p, authn }) {
    if (p.startsWith('/api/admin/')) {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required' });
      if (p === '/api/admin/secrets/rotate' && req.method === 'POST') {
        if (!rotateSecrets) return json(res, 501, { error: 'secrets rotation is not available' });
        try { return json(res, 200, await rotateSecrets(authn.user.id)); } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
      }
      return json(res, 404, { error: 'not found' });
    }
    return PASS;
  }

  const mount = (fn) => async (req, res, ctx) => (await fn(req, res, ctx)) !== PASS;
  return { account: mount(account) };
}

module.exports = { createAuthRoutes };
