'use strict';
// GET  /api/admin/offsite-backup          -> status (admin)
// POST /api/admin/offsite-backup/run      -> run a snapshot + retention now
// POST /api/admin/offsite-backup/verify   -> restore test of the newest snapshot
function createOffsiteRoutes({ service, json }) {
  return async function offsiteRoutes(req, res, { path, authn }) {
    if (path !== '/api/admin/offsite-backup' && !path.startsWith('/api/admin/offsite-backup/')) return false;
    const send = (status, body) => (json(res, status, body), true);
    if (!authn || authn.user.role !== 'admin') return send(403, { error: 'Administrator required' });
    if (path === '/api/admin/offsite-backup') return req.method === 'GET' ? send(200, service.status()) : send(405, { error: 'method not allowed' });
    const action = path.slice('/api/admin/offsite-backup/'.length);
    if (!['run', 'verify'].includes(action)) return send(404, { error: 'not found' });
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
    try { return send(200, action === 'run' ? await service.runNow() : await service.verifyNow()); }
    catch (error) { return send(error.status || 502, { error: error.publicMessage || 'The backup destination could not be reached.' }); }
  };
}
module.exports = { createOffsiteRoutes };
