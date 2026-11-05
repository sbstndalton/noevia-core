'use strict';
// Web glue only. The Rust front is the only issuer of the proxy's control key and of the signed task
// grants (code-egress-client.cjs asks it); native also owns admission, destination policy, forwarding
// and reports. The retired Node implementations exist solely in tests/reference/code-egress.cjs and
// tests/reference/code-egress-control.cjs.
const DEFAULT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_CONNECTIONS_PER_TASK = 64;
const DEFAULT_TUNNEL_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_GRANT_LIFETIME_MS = 2 * 60 * 60 * 1000; // near a real task; a lost revoke expires soon

/**
 * The egress client for this deployment, or null when `CODE_EGRESS_PORT` is unset. The profile is
 * validated here exactly as before (a bad profile stops the boot: a configuration error, not an
 * outage); the front validates the same profile and does the issuing. `store` is the internal store
 * the front serves on loopback (port and secret from the web supervisor).
 */
function startEgressFromEnv(env = process.env, { log = () => {}, fetchImpl } = {}) {
  const rawPort = String(env.CODE_EGRESS_PORT || '').trim();
  if (!rawPort || rawPort === '0') return null;
  const unavailable = () => Object.assign(Error('Native egress configuration is unavailable.'), { code: 'EGRESS_UNAVAILABLE', status: 503 });
  if (!/^[1-9][0-9]{0,4}$/.test(rawPort) || Number(rawPort) > 65535 || String(env.CODE_EGRESS_IMPL || 'rust').trim() !== 'rust') throw unavailable();
  const host = String(env.CODE_EGRESS_RUST_HOST || 'egress-rs-code').trim();
  if (!/^[a-z0-9.-]{1,253}$/i.test(host)) throw unavailable();
  const integer = (name, zero = false) => {
    const value = String(env[name] ?? '');
    if (!/^(0|[1-9][0-9]{0,9})$/.test(value) || Number(value) >= 0xffffffff || (!zero && Number(value) === 0)) throw unavailable();
    return Number(value);
  };
  integer('CODE_EGRESS_KEY_UID', true); integer('CODE_EGRESS_KEY_GID');
  const positive = (name) => { const value = env[name]; if (value === undefined || value === '') return; const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw unavailable(); };
  positive('CODE_EGRESS_TOKEN_TTL_MS'); positive('CODE_EGRESS_GRANT_LIFETIME_MS');
  const file = String(env.CODE_EGRESS_CONTROL_KEY_FILE || '');
  const path = require('node:path');
  if (!path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0')) throw unavailable();
  const port = Number(env.NOEVIA_PROJECT_STORE_PORT), token = String(env.NOEVIA_PROJECT_STORE_TOKEN || '');
  const client = (() => {
    try { return require('./code-egress-client.cjs').createEgressClient({ port, token, endpoint: `${host}:${rawPort}`, log, ...(fetchImpl ? { fetchImpl } : {}) }); }
    catch { throw unavailable(); }
  })();
  try { log({ event: 'egress.rust_control_client', endpoint: client.endpoint }); } catch { /* diagnostics cannot change readiness */ }
  return client;
}
module.exports = { DEFAULT_TOKEN_TTL_MS, DEFAULT_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS_PER_TASK, DEFAULT_TUNNEL_IDLE_MS, DEFAULT_GRANT_LIFETIME_MS, startEgressFromEnv };
