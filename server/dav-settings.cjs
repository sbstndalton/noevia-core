'use strict';
// A dedicated listener has one operator-selected transport boundary. Per-user
// opt-in never publishes a port or turns a LAN credential into a public one.
function configuration(env = process.env, publicOrigin = '') {
  const port = Number(env.COWORK_DAV_PORT || 0);
  if (!port) return { available: false, reason: 'The operator has not configured a file-sharing endpoint.' };
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === Number(env.UI_PORT || 8021)) throw Error('Invalid separate COWORK_DAV_PORT');
  const scope = env.COWORK_DAV_SCOPE;
  if (!['lan', 'public'].includes(scope)) throw Error('Set COWORK_DAV_SCOPE to lan or public');
  const raw = env.COWORK_DAV_ORIGIN || (scope === 'public' ? publicOrigin : '');
  let url; try { url = new URL(raw); } catch { throw Error('Configure COWORK_DAV_ORIGIN'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('COWORK_DAV_ORIGIN must be a clean HTTP(S) origin');
  if (scope === 'public' && url.protocol !== 'https:') throw Error('Public DAV requires HTTPS');
  if (scope === 'lan' && publicOrigin && url.origin === new URL(publicOrigin).origin) throw Error('LAN DAV requires an authority separate from the public app origin');
  const proxyToken = env.COWORK_DAV_PROXY_TOKEN || '';
  if (url.protocol === 'https:' && !/^[a-f0-9]{64,128}$/.test(proxyToken)) throw Error('HTTPS DAV requires a 32-byte or longer hex COWORK_DAV_PROXY_TOKEN');
  return { available: true, port, scope, origin: url.origin, host: url.host, cleartext: url.protocol === 'http:', proxyToken };
}
function createDavSettings({ auth, config }) {
  auth.db.exec(`CREATE TABLE IF NOT EXISTS dav_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK(scope IN ('off','lan','public')), acknowledged_at INTEGER, updated_at INTEGER NOT NULL);`);
  const scope = userId => auth.db.prepare('SELECT scope FROM dav_settings WHERE user_id=?').get(userId)?.scope || 'off';
  return {
    scope,
    get(user) {
      return { available: config.available, reason: config.reason, scope: scope(user.id), endpointScope: config.scope,
        cleartext: config.cleartext || false, port: config.port,
        url: config.available ? `${config.origin}/dav/${encodeURIComponent(user.username)}/` : '',
        eligible: auth.diaryEnabled(user.id) && auth.getStorage(user.id).kind === 'local' };
    },
    save(user, value) {
      if (!['off','lan','public'].includes(value.scope)) throw Error('Choose a sharing scope.');
      if (value.scope !== 'off' && (!config.available || value.scope !== config.scope)) throw Error('This sharing scope is not configured by the operator.');
      if (value.scope !== 'off' && (!auth.diaryEnabled(user.id) || auth.getStorage(user.id).kind !== 'local')) throw Error('Sharing requires enabled Diary with server-held local storage.');
      if (value.scope !== 'off' && config.cleartext && value.acknowledgeCleartext !== true) throw Error('Acknowledge that plain HTTP sends device credentials unencrypted.');
      auth.db.prepare(`INSERT INTO dav_settings VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET scope=excluded.scope,acknowledged_at=excluded.acknowledged_at,updated_at=excluded.updated_at`)
        .run(user.id,value.scope,value.acknowledgeCleartext === true ? Date.now() : null,Date.now());
      auth.audit('dav.sharing',user.id,user.id,{ scope:value.scope });
      return this.get(user);
    },
  };
}
module.exports = { configuration, createDavSettings };
