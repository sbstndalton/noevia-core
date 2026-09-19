'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createMcpOAuth } = require('./mcp-oauth.cjs');

const secrets = { encrypt: (v) => 'enc:' + Buffer.from(v).toString('base64'), decrypt: (v) => Buffer.from(v.slice(4), 'base64').toString() };
function fakeAs({ registration = true, s256 = true } = {}) {
  const seen = { codes: new Map(), requests: [] };
  const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
  const fetchImpl = async (url, init = {}) => {
    seen.requests.push(url);
    if (url === 'https://mcp.example/.well-known/oauth-protected-resource/mcp') return json({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://auth.example'], scopes_supported: ['read'] });
    if (url === 'https://auth.example/.well-known/oauth-authorization-server') return json({ issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', ...(registration ? { registration_endpoint: 'https://auth.example/register' } : {}), code_challenge_methods_supported: s256 ? ['S256'] : ['plain'] });
    if (url === 'https://auth.example/register') { const b = JSON.parse(init.body); seen.redirect = b.redirect_uris[0]; return json({ client_id: 'client-1' }, 201); }
    if (url === 'https://auth.example/token') {
      const p = new URLSearchParams(String(init.body)); seen.lastToken = Object.fromEntries(p);
      if (p.get('grant_type') === 'authorization_code') {
        const challenge = seen.codes.get(p.get('code'));
        const ok = challenge && crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url') === challenge;
        return ok ? json({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
      }
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'RT-1') return json({ access_token: 'AT-2', expires_in: 3600 });
      return json({ error: 'invalid_grant' }, 400);
    }
    return json({}, 404);
  };
  return { fetchImpl, seen };
}
const make = (as, clock = { t: 1e12 }) => ({ clock, oauth: createMcpOAuth({ db: new Database(':memory:'), secrets, fetchImpl: as.fetchImpl, urlAllowed: async (u) => u.startsWith('https://'), redirectUri: () => 'https://noevia.example/api/mcp-oauth/callback', now: () => clock.t }) });
const authorize = (as, url) => { const u = new URL(url); const code = 'CODE-' + Math.random(); as.seen.codes.set(code, u.searchParams.get('code_challenge')); return { state: u.searchParams.get('state'), code, params: u.searchParams }; };

test('full sign-in: discovery, registration, PKCE, resource indicator, per-user tokens and refresh', async () => {
  const as = fakeAs(); const { oauth, clock } = make(as);
  const url = await oauth.start({ userId: 'u1', serverId: 'dir-x', serverUrl: 'https://mcp.example/mcp' });
  const { state, code, params } = authorize(as, url);
  assert.equal(params.get('code_challenge_method'), 'S256'); assert.equal(params.get('resource'), 'https://mcp.example/mcp'); assert.equal(params.get('scope'), 'read');
  assert.equal(as.seen.redirect, 'https://noevia.example/api/mcp-oauth/callback');
  await assert.rejects(oauth.finish({ userId: 'u2', state, code }), /different account/);
  const url2 = await oauth.start({ userId: 'u1', serverId: 'dir-x', serverUrl: 'https://mcp.example/mcp' });
  const a2 = authorize(as, url2);
  await oauth.finish({ userId: 'u1', state: a2.state, code: a2.code });
  assert.equal(await oauth.tokenFor('u1', 'dir-x'), 'AT-1');
  assert.equal(await oauth.tokenFor('u2', 'dir-x'), null, 'another account has no token');
  assert.equal(oauth.connected('u1', 'dir-x'), true);
  clock.t += 3600 * 1000; // expired: refresh
  assert.equal(await oauth.tokenFor('u1', 'dir-x'), 'AT-2');
  await assert.rejects(oauth.finish({ userId: 'u1', state: a2.state, code: a2.code }), /expired or was already used/);
  oauth.disconnect('u1', 'dir-x'); assert.equal(await oauth.tokenFor('u1', 'dir-x'), null);
});

test('refuses services without registration or S256, and non-public endpoints', async () => {
  await assert.rejects(make(fakeAs({ registration: false })).oauth.start({ userId: 'u', serverId: 's', serverUrl: 'https://mcp.example/mcp' }), /registered by hand/);
  await assert.rejects(make(fakeAs({ s256: false })).oauth.start({ userId: 'u', serverId: 's', serverUrl: 'https://mcp.example/mcp' }), /PKCE/);
  const as = fakeAs();
  const blocked = createMcpOAuth({ db: new Database(':memory:'), secrets, fetchImpl: as.fetchImpl, urlAllowed: async (u) => !u.startsWith('https://auth.example'), redirectUri: () => 'https://n/cb' });
  await assert.rejects(blocked.start({ userId: 'u', serverId: 's', serverUrl: 'https://mcp.example/mcp' }), /public https|describe itself/);
  assert.ok(!as.seen.requests.some((u) => u.startsWith('https://auth.example/register')), 'never registers with a blocked service');
});

test('a wrong PKCE verifier gets no token, and tokens are stored encrypted', async () => {
  const as = fakeAs(); const db = new Database(':memory:');
  const oauth = createMcpOAuth({ db, secrets, fetchImpl: as.fetchImpl, urlAllowed: async () => true, redirectUri: () => 'https://n/cb' });
  const url = await oauth.start({ userId: 'u1', serverId: 's', serverUrl: 'https://mcp.example/mcp' });
  const { state } = authorize(as, url); as.seen.codes.set('FORGED', 'not-the-challenge');
  await assert.rejects(oauth.finish({ userId: 'u1', state, code: 'FORGED' }), /did not issue a token/);
  const url2 = await oauth.start({ userId: 'u1', serverId: 's', serverUrl: 'https://mcp.example/mcp' });
  const a = authorize(as, url2); await oauth.finish({ userId: 'u1', state: a.state, code: a.code });
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM mcp_oauth_tokens').all()).includes('AT-1'));
  oauth.forget('s'); assert.equal(oauth.connected('u1', 's'), false);
});

test('a service without self-registration uses an app an administrator registered by hand', async () => {
  const as = fakeAs({ registration: false }); const db = new Database(':memory:');
  const oauth = createMcpOAuth({ db, secrets, fetchImpl: as.fetchImpl, urlAllowed: async (u) => u.startsWith('https://'), redirectUri: () => 'https://noevia.example/api/mcp-oauth/callback' });
  const err = await oauth.start({ userId: 'u1', serverId: 's', serverUrl: 'https://mcp.example/mcp' }).catch((e) => e);
  assert.equal(err.needsClient, true); assert.equal(err.status, 409); assert.equal(err.issuer, 'https://auth.example');
  await assert.rejects(oauth.setClient({ serverId: 's', serverUrl: 'https://mcp.example/mcp', clientId: 'has space' }), /one word/);
  await oauth.setClient({ serverId: 's', serverUrl: 'https://mcp.example/mcp', clientId: 'manual-app', clientSecret: 'MANUAL-SECRET' });
  const info = oauth.clientInfo('s');
  assert.deepEqual(info, { manual: true, clientId: 'manual-app', hasSecret: true, redirectUri: 'https://noevia.example/api/mcp-oauth/callback', issuer: 'https://auth.example' });
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM mcp_oauth_clients').all()).includes('MANUAL-SECRET'), 'secret stored encrypted');
  const url = await oauth.start({ userId: 'u1', serverId: 's', serverUrl: 'https://mcp.example/mcp' });
  assert.equal(new URL(url).searchParams.get('client_id'), 'manual-app');
  const a = authorize(as, url); await oauth.finish({ userId: 'u1', state: a.state, code: a.code });
  assert.equal(await oauth.tokenFor('u1', 's'), 'AT-1');
  assert.equal(as.seen.lastToken.client_id, 'manual-app');
  // Replacing the app signs everyone out of the old one.
  await oauth.setClient({ serverId: 's', serverUrl: 'https://mcp.example/mcp', clientId: 'manual-app-2' });
  assert.equal(oauth.connected('u1', 's'), false);
  assert.equal(oauth.clientInfo('s').hasSecret, false);
});
