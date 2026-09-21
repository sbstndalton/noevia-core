'use strict';
// The account's HTTP surface over auth.cjs. Two mounts, because the router places them apart:
//   open      the routes a signed-out browser may call: setup status and completion, password
//             and passkey sign-in, invitation acceptance and recovery. Mounted BEFORE the
//             session check; a state-changing one still needs an allowed Origin.
//   account   everything a signed-in account does to itself — session, sign-out, appearance,
//             profile, sharing, app passwords, the Diary preference, onboarding, passkey
//             registration and management, session revocation — and /api/admin/*, which is
//             refused to members before its own routes are looked at.
//
// Each returns true when it handled the request. The session and CSRF checks stay in the
// router between the two mounts; blocks keep their original order and an unmatched method
// falls through as it did inline.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(res, result) => any} deps.authResult     writes { status, body } results from auth.cjs
 * @param {(req) => Promise<any>} deps.readJson
 * @param {object} deps.authService
 * @param {Set<string>} deps.publicAuthRoutes         the paths the router lets through unauthenticated
 * @param {object} deps.davSettings
 * @param {{ available:boolean }} deps.davConfig
 * @param {{ remove: (userId:string) => void }} deps.workspaceStore
 * @param {{ removeUser: (userId:string) => Promise<any> }} deps.driveAccounts
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<any>} deps.fetchJson
 * @param {string} deps.DIARY_BASE
 * @param {string} deps.DIARY_TOKEN
 * @param {object} deps.env                              process.env, read at call time
 */
function createAuthRoutes({ json, authResult, readJson, authService, publicAuthRoutes, davSettings, davConfig, workspaceStore, driveAccounts, fetchJson, DIARY_BASE, DIARY_TOKEN, env }) {
  async function open(req, res, { path: p }) {
    if (p === '/api/setup/status' && req.method === 'GET') {
      return json(res, 200, { configured: authService.userCount() > 0, publicOrigin: authService.origin || env.PUBLIC_ORIGIN || '' });
    }
    if (publicAuthRoutes.has(p) && req.method !== 'GET' && !authService.originValid(req)) {
      return json(res, 403, { error: 'origin not allowed' });
    }
    if (p === '/api/setup/complete' && req.method === 'POST') return authResult(res, await authService.setup(req, res, await readJson(req)));
    if (p === '/api/auth/login/password' && req.method === 'POST') return authResult(res, await authService.passwordLogin(req, res, await readJson(req)));
    if (p === '/api/auth/login/passkey/options' && req.method === 'POST') {
      return json(res, 200, await authService.authenticationOptions((await readJson(req)).username));
    }
    if (p === '/api/auth/login/passkey/verify' && req.method === 'POST') {
      try { return json(res, 200, await authService.authenticationVerify(req, res, await readJson(req))); }
      catch { return json(res, 401, { error: 'sign-in failed' }); }
    }
    if (p === '/api/auth/invitations/accept' && req.method === 'POST') return authResult(res, await authService.acceptInvite(req, res, await readJson(req)));
    if (p === '/api/auth/recovery/complete' && req.method === 'POST') {
      try { const ok = await authService.completeRecovery(await readJson(req)); return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: 'recovery link is invalid or expired' }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    return PASS;
  }

  async function account(req, res, { path: p, authn }) {
    if (p === '/api/auth/session' && req.method === 'GET') {
      const csrfCookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('cowork_csrf='));
      return json(res, 200, { user: authn.user, csrfToken: authn.legacy ? null : decodeURIComponent((csrfCookie || '').slice(12)), legacy: authn.legacy });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') return authResult(res, authService.logout(req, res, authn));
    if (p === '/api/profile/appearance') {
      if(req.method==='GET')return json(res,200,authService.getAppearance(authn.user.id));
      if(req.method==='PUT') {
        const body=await readJson(req);
        try { return json(res,200,authService.setAppearance(authn.user.id,body)); }
        catch(error) { return json(res,400,{error:error.message}); }
      }
      return json(res,405,{error:'method not allowed'});
    }
    if (p === '/api/profile' && req.method === 'GET') return json(res, 200, { user: authn.user, passkeys: authService.listPasskeys(authn.user.id), sessions: authService.listSessions(authn.user.id) });
    if (p === '/api/profile/sharing' && req.method === 'GET') return json(res, 200, davSettings.get(authn.user));
    if (p === '/api/profile/sharing' && req.method === 'PUT') {
      try { return json(res, 200, davSettings.save(authn.user, await readJson(req))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/profile/app-passwords' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 200, { appPasswords: authService.appPasswords.list(authn.user.id), sharingAvailable: davConfig.available });
    }
    if (p === '/api/profile/app-passwords' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      try { return json(res, 201, await authService.appPasswords.create(authn.user.id, await readJson(req))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    const appPasswordRoute = p.match(/^\/api\/profile\/app-passwords\/([a-f0-9]{32})$/);
    if (appPasswordRoute && req.method === 'DELETE') {
      return json(res, authService.appPasswords.revoke(authn.user.id, appPasswordRoute[1]) ? 200 : 404, { ok: true });
    }
    if (p === '/api/profile' && req.method === 'PATCH') {
      const body = await readJson(req); authService.updateProfile(authn.user.id, body.displayName);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/profile/features' && req.method === 'PUT') {
      return json(res, 200, authService.setDiaryEnabled(authn.user.id, !!(await readJson(req)).diaryEnabled));
    }
    if (p === '/api/profile/onboarding' && req.method === 'POST') {
      return json(res, 200, authService.markOnboarded(authn.user.id));
    }
    if (p === '/api/auth/passkeys/register/options' && req.method === 'POST') return json(res, 200, await authService.registrationOptions(authn.user.id));
    if (p === '/api/auth/passkeys/register/verify' && req.method === 'POST') {
      try { return json(res, 200, await authService.registrationVerify(authn.user.id, await readJson(req))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    const passkeyRoute = p.match(/^\/api\/auth\/passkeys\/([^/]+)$/);
    if (passkeyRoute && req.method === 'DELETE') return json(res, authService.deletePasskey(authn.user.id, decodeURIComponent(passkeyRoute[1])) ? 200 : 404, { ok: true });
    if (passkeyRoute && req.method === 'PATCH') {
      const ok = authService.renamePasskey(authn.user.id, decodeURIComponent(passkeyRoute[1]), (await readJson(req)).name);
      return json(res, ok ? 200 : 404, { ok });
    }
    const sessionRoute = p.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (sessionRoute && req.method === 'DELETE') return json(res, authService.revokeSession(authn.user.id, decodeURIComponent(sessionRoute[1])) ? 200 : 404, { ok: true });
    if (p.startsWith('/api/admin/')) {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required' });
      if (p === '/api/admin/users' && req.method === 'GET') return json(res, 200, { users: authService.listUsers() });
      if (p === '/api/admin/invitations' && req.method === 'POST') return json(res, 201, authService.createInvite(authn.user.id, (await readJson(req)).role));
      const disabledRoute = p.match(/^\/api\/admin\/users\/([^/]+)\/disabled$/);
      if (disabledRoute && req.method === 'PUT') {
        try { return json(res, authService.setDisabled(authn.user.id, decodeURIComponent(disabledRoute[1]), !!(await readJson(req)).disabled) ? 200 : 404, { ok: true }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      const recoveryRoute = p.match(/^\/api\/admin\/users\/([^/]+)\/recovery$/);
      if (recoveryRoute && req.method === 'POST') {
        const result = authService.createRecovery(authn.user.id, decodeURIComponent(recoveryRoute[1]));
        return json(res, result ? 201 : 404, result || { error: 'no such user' });
      }
      const userRoute = p.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userRoute && req.method === 'DELETE') {
        try {
          const id = decodeURIComponent(userRoute[1]); const ok = authService.deleteUser(authn.user.id, id, (await readJson(req)).username);
          if (ok) {
            workspaceStore.remove(id);
            await driveAccounts.removeUser(id);
            const headers = { 'X-Cowork-User-ID': id };
            if (DIARY_TOKEN) headers.Authorization = `Bearer ${DIARY_TOKEN}`;
            await fetchJson(`${DIARY_BASE}/api/internal/tenant`, { method: 'DELETE', headers }, 15000).catch(() => null);
          }
          return json(res, ok ? 200 : 400, { ok });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 404, { error: 'not found' });
    }
    return PASS;
  }

  const mount = (fn) => async (req, res, ctx) => (await fn(req, res, ctx)) !== PASS;
  return { open: mount(open), account: mount(account) };
}

module.exports = { createAuthRoutes };
