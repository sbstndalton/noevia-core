'use strict';
// sbstndalton/noevia#2190 round 5: a synthetic Sign in with ChatGPT token broker for Core tests.
// The real broker is the Rust front (noevia-rs chatgpt_oauth_routes.rs, tests/chatgpt_oauth.rs covers
// the device sign-in, the store, the refresh and the catalogue). This fake speaks the same protocol
// as project-store-client.cjs's chatgpt* methods, writes the token row's state the way the front
// does (so chatgpt-oauth.cjs `status` reads it), and counts every call. No real token or account.
const crypto = require('node:crypto');

const CREATE = `CREATE TABLE IF NOT EXISTS chatgpt_oauth_tokens(user_id TEXT PRIMARY KEY, data_enc TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'connected', updated_at INTEGER NOT NULL)`;

const DEFAULT_CATALOGUE = [
  { slug: 'gpt-synthetic', effort: null, summary: null, summaryParam: true, levels: null },
  { slug: 'gpt-thinker', effort: 'medium', summary: 'detailed', summaryParam: true, levels: null },
  { slug: 'gpt-plain', effort: null, summary: null, summaryParam: false, levels: null },
  { slug: 'gpt-quiet', effort: null, summary: 'none', summaryParam: true, levels: null },
];

/**
 * @param {object} o
 * @param {object} o.db   a better-sqlite3 database (the test's, unguarded: it plays the front)
 * @param {() => number} [o.now]
 */
function createFakeBroker({ db, now = () => Date.now() }) {
  db.exec(CREATE);
  const tokens = new Map(); // userId -> { accessToken, accountId, fedRamp, expiresAt, generation }
  const calls = [];
  const state = { refresh: 'ok', catalogue: DEFAULT_CATALOGUE, catalogueDown: false, seq: 1, down: false, signal: 0 };
  const bump = () => { state.signal += 1; };
  const writeRow = (userId, rowState) => {
    db.prepare(`INSERT INTO chatgpt_oauth_tokens(user_id,data_enc,state,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET data_enc=excluded.data_enc, state=excluded.state, updated_at=excluded.updated_at`)
      .run(userId, `enc:v2:synthetic-${crypto.randomUUID()}`, rowState, now());
    bump();
  };
  const refusal = (code) => ({ ok: false, status: code === 'transient' ? 503 : 401, code,
    error: { disconnected: 'ChatGPT is not connected. Sign in with ChatGPT in Settings → AI providers.',
      reconnect: 'Reconnect needed: your ChatGPT sign-in expired or was revoked. Sign in with ChatGPT again in Settings → AI providers.',
      transient: 'ChatGPT sign-in could not be refreshed right now. Try again in a moment.' }[code] });
  const rowState = (userId) => db.prepare('SELECT state FROM chatgpt_oauth_tokens WHERE user_id=?').get(userId)?.state;
  const broker = {
    async chatgptSession(user, rejected = null) {
      calls.push({ op: 'session', user, rejected });
      if (state.down) throw Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY' });
      const s = rowState(user);
      if (!s) return refusal('disconnected');
      if (s !== 'connected') return refusal('reconnect');
      const t = tokens.get(user);
      if (rejected && rejected === t.accessToken) {
        if (state.refresh === 'invalid') { writeRow(user, 'reconnect'); return refusal('reconnect'); }
        if (state.refresh === 'down') return refusal('transient');
        state.seq += 1;
        Object.assign(t, { accessToken: `AT-${state.seq}`, generation: `gen-${state.seq}` });
        bump();
      }
      return { ok: true, session: { ...t } };
    },
    async chatgptReject(user, generation) {
      calls.push({ op: 'reject', user, generation });
      const t = tokens.get(user);
      const marked = !!t && t.generation === generation && rowState(user) === 'connected';
      if (marked) writeRow(user, 'reconnect');
      return { ok: true, marked };
    },
    async chatgptCatalogue(user) {
      calls.push({ op: 'catalogue', user });
      if (state.catalogueDown) return { ok: false, status: 502, error: 'ChatGPT returned 503: down' };
      return { ok: true, models: state.catalogue };
    },
    async chatgptDisconnect(user) {
      calls.push({ op: 'disconnect', user });
      if (state.down) throw Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY' });
      db.prepare('DELETE FROM chatgpt_oauth_tokens WHERE user_id=?').run(user);
      tokens.delete(user);
      bump();
      return { ok: true };
    },
  };
  /** The front finished a device sign-in for `userId`. */
  function connect(userId, { accessToken = 'AT-1', accountId = 'acct-A', fedRamp = false, expiresAt = now() + 3_600_000 } = {}) {
    tokens.set(userId, { accessToken, accountId, fedRamp, expiresAt, generation: `gen-${accessToken}` });
    writeRow(userId, 'connected');
  }
  return { broker, connect, calls, state, signal: () => String(state.signal) };
}

module.exports = { createFakeBroker, DEFAULT_CATALOGUE };
