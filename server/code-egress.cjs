'use strict';
// Web glue only. Native owns admission, destination policy, forwarding and reports.
// The retired Node implementation exists solely in tests/reference/code-egress.cjs.
const crypto = require('node:crypto');
const DEFAULT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_CONNECTIONS_PER_TASK = 64;
const DEFAULT_TUNNEL_IDLE_MS = 10 * 60 * 1000;
const GRANT_KEY_LABEL = 'code-egress-grant';
const GRANT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRANT_LIFETIME_MS = 2 * 60 * 60 * 1000; // near a real task; a lost revoke expires soon
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A task's domains as the contract carries them: lowercased, outer dots dropped, deduplicated. */
function grantHosts(domains) {
  const hosts = [];
  for (const d of domains || []) {
    const h = String(d || '').toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!h) continue;
    if (h.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h)) throw Object.assign(Error(`"${d}" is not a domain the egress proxy can grant`), { status: 400 });
    if (!hosts.includes(h)) hosts.push(h);
  }
  if (hosts.length > 64) throw Object.assign(Error('at most 64 domains per task'), { status: 400 });
  return hosts;
}

/** `ngr1.` + base64url(canonical JSON) + `.` + base64url(HMAC-SHA256(key, everything before it)). */
function mintGrant(key, { act = 'grant', task, hosts = [], iat, exp, idle, nonce }) {
  const payload = `{"v":1,"act":${JSON.stringify(act)},"task":${JSON.stringify(task)},"hosts":${JSON.stringify(hosts)},`
    + `"iat":${iat},"exp":${exp},"idle":${idle},"nonce":${JSON.stringify(nonce)}}`;
  const signed = `ngr1.${b64url(payload)}`;
  return `${signed}.${b64url(crypto.createHmac('sha256', key).update(signed).digest())}`;
}


function startEgressFromEnv(env = process.env, { log = () => {}, secrets = null, transport } = {}) {
  const rawPort = String(env.CODE_EGRESS_PORT || '').trim();
  if (!rawPort || rawPort === '0') return null;
  const unavailable = () => Object.assign(Error('Native egress configuration is unavailable.'), { code: 'EGRESS_UNAVAILABLE', status: 503 });
  if (!/^[1-9][0-9]{0,4}$/.test(rawPort) || Number(rawPort) > 65535 || String(env.CODE_EGRESS_IMPL || 'rust').trim() !== 'rust') throw unavailable();
  const host = String(env.CODE_EGRESS_RUST_HOST || 'egress-rs-code').trim();
  if (!/^[a-z0-9.-]{1,253}$/i.test(host) || !secrets || typeof secrets.derive !== 'function') throw unavailable();
  const integer = (name, zero = false) => {
    const value = String(env[name] ?? '');
    if (!/^(0|[1-9][0-9]{0,9})$/.test(value) || Number(value) >= 0xffffffff || (!zero && Number(value) === 0)) throw unavailable();
    return Number(value);
  };
  const uid = integer('CODE_EGRESS_KEY_UID', true), gid = integer('CODE_EGRESS_KEY_GID');
  const positive = (name, fallback) => { const value = env[name]; if (value === undefined || value === '') return fallback; const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw unavailable(); return n; };
  const ttlMs = positive('CODE_EGRESS_TOKEN_TTL_MS', DEFAULT_TOKEN_TTL_MS);
  const lifetimeMs = positive('CODE_EGRESS_GRANT_LIFETIME_MS', DEFAULT_GRANT_LIFETIME_MS);
  // Lazy import avoids a cycle with the unchanged pure grant byte helpers above.
  const { publishWebKey, republishMissingKey, createControlClient } = require('./code-egress-control.cjs');
  const file = String(env.CODE_EGRESS_CONTROL_KEY_FILE || '');
  let fileKey;
  try { fileKey = publishWebKey({ masterKey: secrets.derive(GRANT_KEY_LABEL, 32), file, uid, gid }); }
  catch { throw unavailable(); }
  const client = createControlClient({ fileKey, endpoint: `${host}:${rawPort}`, ttlMs, lifetimeMs, log, republishKey: () => republishMissingKey({ fileKey, file, uid, gid }), ...(transport ? { transport } : {}) });
  try { log({ event: 'egress.rust_control_client', endpoint: client.endpoint }); } catch { /* diagnostics cannot change readiness */ }
  return client;
}
module.exports = { DEFAULT_TOKEN_TTL_MS, DEFAULT_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS_PER_TASK, DEFAULT_TUNNEL_IDLE_MS,
  GRANT_KEY_LABEL, grantHosts, mintGrant, startEgressFromEnv };
