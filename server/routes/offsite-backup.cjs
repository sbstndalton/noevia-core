'use strict';
// GET  /api/admin/offsite-backup                    -> status (admin)
// POST /api/admin/offsite-backup/run                -> run a snapshot + retention now
// POST /api/admin/offsite-backup/verify             -> restore test of the newest snapshot
// POST /api/admin/offsite-backup/copy               -> copy the store to Google Drive now
// POST /api/admin/offsite-backup/google/connect     -> start Google's device sign-in
// POST /api/admin/offsite-backup/google/disconnect  -> revoke and forget the Google connection
// GET  /api/admin/offsite-backup/recovery-key       -> the backup key as a text file download
const OTHER_ADMIN = 'Another administrator is connecting Google Drive.';

function createOffsiteRoutes({ service, json }) {
  // Another administrator's sign-in is waiting for approval: its code belongs to them alone, and
  // approving it would bind the wrong Google account to the backups (#868).
  const foreignPending = (google, user) => !!(google && google.state === 'pending' && google.owner && google.owner !== user.id);
  const publicStatus = (status, user) => {
    if (!status.google) return status;
    const { owner, ...google } = status.google;
    if (!foreignPending(status.google, user)) return { ...status, google };
    const { userCode, verificationUrl, expiresAt, ...rest } = google;
    return { ...status, google: { ...rest, message: OTHER_ADMIN } };
  };
  const refuseForeign = (authn) => {
    if (foreignPending(service.status().google, authn.user)) throw Object.assign(Error(OTHER_ADMIN), { status: 409, publicMessage: OTHER_ADMIN });
  };
  const actions = {
    run: () => service.runNow(),
    verify: () => service.verifyNow(),
    copy: () => service.copyNow(),
    'google/connect': async (authn) => {
      refuseForeign(authn);
      // Two connects can pass refuseForeign together; the later one then gets the first one's
      // pending sign-in back. Filter it like publicStatus: never another admin's code (#892).
      const google = await service.connectGoogle(authn.user.id);
      if (foreignPending(google, authn.user)) throw Object.assign(Error(OTHER_ADMIN), { status: 409, publicMessage: OTHER_ADMIN });
      if (!google || typeof google !== 'object') return google;
      const { owner, ...rest } = google;
      return rest;
    },
    'google/disconnect': (authn) => { refuseForeign(authn); return service.disconnectGoogle(); },
  };
  return async function offsiteRoutes(req, res, { path, authn }) {
    if (path !== '/api/admin/offsite-backup' && !path.startsWith('/api/admin/offsite-backup/')) return false;
    const send = (status, body) => (json(res, status, body), true);
    if (!authn || authn.user.role !== 'admin') return send(403, { error: 'Administrator required' });
    if (path === '/api/admin/offsite-backup') return req.method === 'GET' ? send(200, publicStatus(service.status(), authn.user)) : send(405, { error: 'method not allowed' });
    const action = path.slice('/api/admin/offsite-backup/'.length);
    if (action === 'recovery-key') {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
      let key;
      try { key = service.recoveryKey(); } catch (error) { return send(409, { error: error.publicMessage || 'The backup key could not be read.' }); }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="noevia-backup-recovery-key.txt"', 'Cache-Control': 'no-store' });
      res.end(`noevia backup recovery key\n\nKeep this in a password manager. Without it, no backup can be restored.\nDo not store it in the same Google Drive as the backups.\n\n${key}\n`);
      return true;
    }
    if (!actions[action]) return send(404, { error: 'not found' });
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
    try { return send(200, (await actions[action](authn)) ?? {}); }
    catch (error) { return send(error.status || 502, { error: error.publicMessage || 'The backup destination could not be reached.', ...(error.messageId ? { errorId: error.messageId, errorParams: error.messageParams || {} } : {}) }); }
  };
}
module.exports = { createOffsiteRoutes };
