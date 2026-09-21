'use strict';
// Settings → Connectors, for every signed-in account (each sees and changes only its own).
// GET  /api/connectors                          -> the account's connectors and tool permissions
// POST /api/connectors/gdrive/connect           -> start Google's device sign-in for this account
// POST /api/connectors/gdrive/disconnect        -> revoke and forget this account's connection
// PUT  /api/connectors/gdrive/policy            -> {tools:[name…], mode:'allow'|'ask'|'block'}
// PUT  /api/connectors/gdrive/backup-copy       -> {enabled} (the administrator whose Drive holds backups)
// PUT  /api/connectors/nextcloud/policy         -> {tools:[name…], mode} for the Nextcloud toolboxes
//
// Nextcloud has no connect button of its own: its tools use the account's storage connection
// (Settings → Diary & storage), which is where it is connected and disconnected. This page says
// whether that credential can be used, and owns what each of its tools may do.
function createConnectorRoutes({ accounts, driveTools, policy, offsite, isWrite, json, readBody, nextcloud = null }) {
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
  function nextcloudView(user) {
    const s = nextcloud.state(user);
    const tools = nextcloud.tools();
    return {
      id: 'nextcloud', name: 'Nextcloud',
      configured: s.configured, state: s.state, account: s.account || null, baseUrl: s.baseUrl || null, message: s.message || '',
      boxes: s.configured ? nextcloud.boxes() : [],
      tools: tools.map((name) => ({ name, label: name, write: isWrite(name), mode: policy.mode(user.id, name, isWrite(name)) })),
    };
  }

  return async function connectorRoutes(req, res, { path, authn }) {
    if (path !== '/api/connectors' && !path.startsWith('/api/connectors/')) return false;
    const send = (status, body) => (json(res, status, body), true);
    if (!authn?.user) return send(401, { error: 'Sign in first.' });
    const user = authn.user;
    try {
      if (path === '/api/connectors') return req.method === 'GET' ? send(200, { connectors: [view(user), ...(nextcloud ? [nextcloudView(user)] : [])] }) : send(405, { error: 'method not allowed' });
      if (path === '/api/connectors/nextcloud/policy' && req.method === 'PUT') {
        if (!nextcloud) return send(404, { error: 'not found' });
        const body = await readBody(req);
        const offered = new Set(nextcloud.tools());
        policy.set(user.id, [].concat(body.tools || []).filter((t) => offered.has(t)), body.mode, isWrite);
        return send(200, nextcloudView(user));
      }
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
