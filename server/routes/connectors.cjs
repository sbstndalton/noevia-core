'use strict';
// Settings → Connectors, for every signed-in account (each sees and changes only its own).
// GET  /api/connectors                          -> the account's connectors and tool permissions
// POST /api/connectors/gdrive/connect           -> start Google's device sign-in for this account
// POST /api/connectors/gdrive/disconnect        -> revoke and forget this account's connection
// PUT  /api/connectors/gdrive/policy            -> {tools:[name…], mode:'allow'|'ask'|'block'}
// PUT  /api/connectors/gdrive/backup-copy       -> {enabled} (the administrator whose Drive holds backups)
function createConnectorRoutes({ accounts, driveTools, policy, offsite, isWrite, json, readBody }) {
  function view(user) {
    const { drive, backup } = accounts.forUser(user);
    const s = drive.state();
    const status = backup ? offsite.status() : null;
    return {
      id: 'gdrive', name: 'Google Drive',
      configured: s.configured, state: s.state, email: s.email || null, connectedAt: s.connectedAt || null,
      userCode: s.userCode, verificationUrl: s.verificationUrl, expiresAt: s.expiresAt, message: s.message,
      backup: backup && status?.google ? { enabled: status.enabled, copyEnabled: status.google.copyEnabled, copy: status.google.copy, lastBackup: status.lastBackup } : null,
      tools: [...driveTools.names].map((name) => ({ name, label: driveTools.labels[name], write: isWrite(name), mode: policy.mode(user.id, name, isWrite(name)) })),
    };
  }
  return async function connectorRoutes(req, res, { path, authn }) {
    if (path !== '/api/connectors' && !path.startsWith('/api/connectors/')) return false;
    const send = (status, body) => (json(res, status, body), true);
    if (!authn?.user) return send(401, { error: 'Sign in first.' });
    const user = authn.user;
    try {
      if (path === '/api/connectors') return req.method === 'GET' ? send(200, { connectors: [view(user)] }) : send(405, { error: 'method not allowed' });
      const action = path.slice('/api/connectors/gdrive/'.length);
      if (!path.startsWith('/api/connectors/gdrive/')) return send(404, { error: 'not found' });
      if (action === 'connect' && req.method === 'POST') {
        const { drive, backup } = accounts.forUser(user);
        await (backup ? offsite.connectGoogle(user.id) : drive.connect(() => {}, { owner: user.id }));
        return send(200, view(user));
      }
      if (action === 'disconnect' && req.method === 'POST') { await accounts.forUser(user).drive.disconnect(); return send(200, view(user)); }
      if (action === 'policy' && req.method === 'PUT') {
        const body = await readBody(req);
        const tools = [].concat(body.tools || []).filter((t) => driveTools.names.has(t));
        policy.set(user.id, tools, body.mode, isWrite);
        return send(200, view(user));
      }
      if (action === 'backup-copy' && req.method === 'PUT') {
        if (!accounts.forUser(user).backup) return send(403, { error: 'Only the administrator whose Drive holds the backups can change this.' });
        offsite.setDriveCopy((await readBody(req)).enabled === true);
        return send(200, view(user));
      }
      return send(404, { error: 'not found' });
    } catch (error) {
      return send(error.status || 502, { error: error.publicMessage || 'Google Drive could not be reached.' });
    }
  };
}
module.exports = { createConnectorRoutes };
