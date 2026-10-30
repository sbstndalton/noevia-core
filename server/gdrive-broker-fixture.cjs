'use strict';
// TEST ONLY. A stand-in for the Rust front's Google Drive broker (noevia-rs gdrive.rs), so the Node tests
// of the Drive tools can run against the fake Google server (qa/fake-google.cjs) without the front. It does
// what the broker's internal ops do for the tools: signs an account in through the fake's device flow
// (kept here, as the front keeps it, never given to the caller), hands out access tokens from the refresh
// grant, and publishes gdrive-connections.json for the sync `connected(user)`. The real broker is tested in
// noevia-rs (tests/gdrive.rs); nothing here is used outside tests.
const fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto');
const { SIGNAL_FILE } = require('./rust-google-drive.cjs');
const { readCappedJson } = require('./http.cjs');

async function form(url, fields) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  return { status: r.status, body: await readCappedJson(r, 64 * 1024).catch(() => ({})) };
}

function startBrokerFixture({ google, dataDir, usable = false }) {
  const refresh = new Map(); // userId -> refresh token
  const calls = { session: [], reject: [], forget: [], disconnect: [] };
  const publish = () => {
    const doc = { version: 1, at: Date.now(), nonce: crypto.randomBytes(4).toString('hex'), backup: { usable, state: 'disconnected', owner: null, expiresAt: null },
      personal: Object.fromEntries([...refresh.keys()].map((id) => [id, 'connected'])) };
    fs.writeFileSync(path.join(dataDir, SIGNAL_FILE), JSON.stringify(doc));
  };
  publish();
  const broker = {
    async gdriveSession(user, admin, rejected = null) {
      calls.session.push({ user, admin, rejected });
      const token = refresh.get(user);
      if (!token) return { ok: false, status: 409, error: 'Google Drive is not connected.', code: 'disconnected' };
      const r = await form(`${google.base}/token`, { client_id: 'fake-client', client_secret: 'fake-secret', refresh_token: token, grant_type: 'refresh_token' });
      if (r.status !== 200) return { ok: false, status: 409, error: 'Google no longer accepts this connection.', code: 'reconnect' };
      return { ok: true, session: { accessToken: r.body.access_token, expiresAt: Date.now() + 3_000_000, generation: crypto.createHash('sha256').update(token).digest('hex') } };
    },
    async gdriveReject(user, admin, generation) { calls.reject.push({ user, admin, generation }); return { ok: true, dropped: true }; },
    async gdriveForget(user) {
      calls.forget.push(user);
      const token = refresh.get(user);
      if (token) await form(`${google.base}/revoke`, { token });
      refresh.delete(user); publish();
      return { ok: true };
    },
    async gdriveDisconnect(user) { calls.disconnect.push(user); return this.gdriveForget(user); },
  };
  /** Signs the account in through the fake's device flow (the fake is started with autoApprove). */
  async function connect(user) {
    const code = await form(`${google.base}/device/code`, { client_id: 'fake-client', scope: 'https://www.googleapis.com/auth/drive.file openid email' });
    const t = await form(`${google.base}/token`, { client_id: 'fake-client', client_secret: 'fake-secret', device_code: code.body.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (t.status !== 200) throw new Error('the fake Google did not approve');
    refresh.set(user.id, t.body.refresh_token);
    publish();
  }
  return { broker, connect, calls, refresh, publish };
}

module.exports = { startBrokerFixture };
