'use strict';
// GET  /api/admin/offsite-backup                    -> status (admin)
// POST /api/admin/offsite-backup/run                -> run a snapshot + retention now
// POST /api/admin/offsite-backup/verify             -> restore test of the newest snapshot
// POST /api/admin/offsite-backup/copy               -> copy the store to Google Drive now
// POST /api/admin/offsite-backup/google/connect     -> start Google's device sign-in
// POST /api/admin/offsite-backup/google/disconnect  -> revoke and forget the Google connection
// GET  /api/admin/offsite-backup/recovery-key       -> the backup key as a text file download
function createOffsiteRoutes({ service, json }) {
  const actions = {
    run: () => service.runNow(),
    verify: () => service.verifyNow(),
    copy: () => service.copyNow(),
    'google/connect': (authn) => service.connectGoogle(authn.user.id),
    'google/disconnect': () => service.disconnectGoogle(),
  };
  return async function offsiteRoutes(req, res, { path, authn }) {
    if (path !== '/api/admin/offsite-backup' && !path.startsWith('/api/admin/offsite-backup/')) return false;
    const send = (status, body) => (json(res, status, body), true);
    if (!authn || authn.user.role !== 'admin') return send(403, { error: 'Administrator required' });
    if (path === '/api/admin/offsite-backup') return req.method === 'GET' ? send(200, service.status()) : send(405, { error: 'method not allowed' });
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
    catch (error) { return send(error.status || 502, { error: error.publicMessage || 'The backup destination could not be reached.' }); }
  };
}
module.exports = { createOffsiteRoutes };
