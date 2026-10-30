'use strict';
// Settings → Connectors, for every signed-in account (each sees and changes only its own).
// GET  /api/connectors                          -> the account's connectors and tool permissions
// PUT  /api/connectors/nextcloud/policy         -> {tools:[name…], mode} for the Nextcloud toolboxes
//
// The Google Drive writes are the Rust front's since sbstndalton/noevia#2190 round 7 (rust-google-drive.cjs
// refuses them, 503 RUST_GOOGLE_DRIVE_OWNED, before anything else runs): POST …/gdrive/connect and
// …/disconnect, PUT …/gdrive/policy and …/gdrive/backup-copy. What stays here needs the live MCP servers:
// the Nextcloud half lists the toolbox tools they offer and which of them write, so this route builds that
// half itself and asks the front for the Google Drive half (`accounts.view`), and for the one write of
// tool_policies (`toolPolicy.set`), whose only writer is the front.
//
// Nextcloud has no connect button of its own: its tools use the account's storage connection
// (Settings → Diary & storage), which is where it is connected and disconnected. This page says
// whether that credential can be used, and owns what each of its tools may do.
// onPolicyChange clears the cached permitted-tools view after a write (the cache also re-reads by the
// table's fingerprint, so the front's own writes reach it too).
function createConnectorRoutes({ accounts, policy, toolPolicy, isWrite, json, readBody, nextcloud = null, onPolicyChange = () => {} }) {
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
      if (path === '/api/connectors') return req.method === 'GET' ? send(200, { connectors: [await accounts.view(user), ...(nextcloud ? [nextcloudView(user)] : [])] }) : send(405, { error: 'method not allowed' });
      if (path === '/api/connectors/nextcloud/policy' && req.method === 'PUT') {
        if (!nextcloud) return send(404, { error: 'not found' });
        const body = await readBody(req);
        const offered = new Set(nextcloud.tools());
        const tools = [].concat(body.tools || []).filter((t) => offered.has(t));
        const r = await toolPolicy.set(user.id, tools, tools.map((t) => !!isWrite(t)), body.mode);
        if (!r || !r.ok) return send(Number.isInteger(r?.status) ? r.status : 502, { error: typeof r?.error === 'string' ? r.error : 'The tool permission could not be saved. Try again in a moment.' });
        onPolicyChange();
        return send(200, nextcloudView(user));
      }
      return send(404, { error: 'not found' });
    } catch (error) {
      return send(error.status || 502, { error: error.publicMessage || 'The connectors could not be loaded.' });
    }
  };
}
module.exports = { createConnectorRoutes };
