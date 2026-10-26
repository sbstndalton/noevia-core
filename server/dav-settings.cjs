'use strict';
const net = require('net');
// A dedicated listener has one operator-selected transport boundary. Per-user
// opt-in never publishes a port or turns a LAN credential into a public one.
function configuration(env = process.env, publicOrigin = '') {
  const port = Number(env.COWORK_DAV_PORT || 0);
  // `reasonId` is what the client translates (sharing.reason.<id>); `reason` stays as the English fallback for a
  // client that does not know the id.
  if (!port) return { available: false, reasonId: 'not-configured', reason: 'The operator has not configured a file-sharing endpoint.' };
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
  // Only an explicit COWORK_DAV_HOST is checked as an IP; UI_HOST keeps whatever form it always had.
  if (env.COWORK_DAV_HOST && !net.isIP(env.COWORK_DAV_HOST)) throw Error('COWORK_DAV_HOST must be an IP address');
  const bindHost = env.COWORK_DAV_HOST || env.UI_HOST || '0.0.0.0';
  return { available: true, port, scope, origin: url.origin, host: url.host, bindHost, cleartext: url.protocol === 'http:', proxyToken };
}
// Settings -> Sharing (GET/PUT /api/profile/sharing) is the Rust front's (sbstndalton/noevia#1071,
// noevia-rs crates/server-account `sharing`): it writes dav_settings, rust-auth.cjs refuses Node's
// writes to it. This module creates the table at boot and the DAV listener reads the opt-in.
function createDavSettings({ auth }) {
  auth.db.exec(`CREATE TABLE IF NOT EXISTS dav_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK(scope IN ('off','lan','public')), acknowledged_at INTEGER, updated_at INTEGER NOT NULL);`);
  const scope = userId => auth.db.prepare('SELECT scope FROM dav_settings WHERE user_id=?').get(userId)?.scope || 'off';
  return { scope };
}
module.exports = { configuration, createDavSettings };
