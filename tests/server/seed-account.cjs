'use strict';
// Synthetic accounts and signed-in sessions, written straight into UI_DATA_DIR/cowork.db.
//
// Sign-in is the Rust front's (sbstndalton/noevia#1071): Node no longer answers first-run setup,
// password or passkey sign-in, or invitations, and it refuses to write the account tables
// (server/rust-auth.cjs). Tests and harnesses that need a signed-in browser for the routes Node
// still answers seed one here instead, through their own database connection (the guard is on
// Node's connection only), the way the front would have written it. Call it after the server
// module has opened the database (index.cjs or createAuth runs the migrations).
//
// Synthetic values only: the session and CSRF tokens are random, and the stored password hash is a
// marker no password verifies against.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const Database = createRequire(path.join(__dirname, '../../server/package.json'))('better-sqlite3');

const DAY = 24 * 60 * 60 * 1000;
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/**
 * Seeds `username` (created once, reused after) and a fresh session for it.
 * @param {string} dataDir  the server's UI_DATA_DIR
 * @param {object} [opts]
 * @param {string} [opts.username]       default 'synthetic-admin'
 * @param {string} [opts.displayName]
 * @param {'admin'|'member'} [opts.role] default 'admin'
 * @param {boolean} [opts.diaryEnabled]  default false
 * @param {boolean} [opts.onboarded]     default true
 * @param {string} [opts.publicOrigin]   saved as the setup address (settings public_origin) when given
 * @param {string} [opts.userAgent]
 * @param {string} [opts.ip]
 * @param {number} [opts.now]
 * @returns {{ id: string, username: string, session: string, csrf: string, cookie: string,
 *   headers: (origin?: string) => object }}
 */
function seedAccount(dataDir, opts = {}) {
  const {
    username = 'synthetic-admin', displayName = username, role = 'admin', diaryEnabled = false, onboarded = true,
    publicOrigin = '', userAgent = 'synthetic-test-agent', ip = '127.0.0.1', now = Date.now(),
  } = opts;
  const db = new Database(path.join(dataDir, 'cowork.db'));
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const session = token();
    const csrf = token();
    const id = db.transaction(() => {
      let userId = db.prepare('SELECT id FROM users WHERE username_norm=?').get(username.toLowerCase())?.id;
      if (!userId) {
        userId = crypto.randomUUID();
        db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(userId, username, username.toLowerCase(), displayName, role, 'synthetic-no-password', token(), now, now);
        db.prepare('INSERT INTO user_features(user_id,diary_enabled,onboarded,updated_at) VALUES(?,?,?,?)')
          .run(userId, diaryEnabled ? 1 : 0, onboarded ? 1 : 0, now);
      }
      // First-run setup is done once an account exists: the setup code goes, as the front's setup removes it.
      db.prepare("DELETE FROM settings WHERE key='setup_code_hash'").run();
      if (publicOrigin) db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin',?)").run(publicOrigin);
      db.prepare('INSERT INTO sessions(id_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at,user_agent,ip) VALUES(?,?,?,?,?,?,?,?)')
        .run(digest(session), userId, digest(csrf), now, now, now + 30 * DAY, userAgent, ip);
      return userId;
    })();
    fs.rmSync(path.join(dataDir, 'first-run-setup-code'), { force: true });
    const cookie = `cowork_session=${session}; cowork_csrf=${csrf}`;
    return {
      id, username, session, csrf, cookie,
      /** Headers for a signed-in write (or read) from `origin`. */
      headers: (origin) => ({ cookie, 'x-csrf-token': csrf, ...(origin ? { origin } : {}) }),
    };
  } finally {
    db.close();
  }
}

/** Sets a user's user_features flags directly (the Rust front's PUT /api/profile/features). */
function setUserFeatures(dataDir, userId, { diaryEnabled, onboarded } = {}) {
  const db = new Database(path.join(dataDir, 'cowork.db'));
  try {
    db.pragma('busy_timeout = 5000');
    if (diaryEnabled !== undefined) db.prepare('UPDATE user_features SET diary_enabled=?,updated_at=? WHERE user_id=?').run(diaryEnabled ? 1 : 0, Date.now(), userId);
    if (onboarded !== undefined) db.prepare('UPDATE user_features SET onboarded=?,updated_at=? WHERE user_id=?').run(onboarded ? 1 : 0, Date.now(), userId);
  } finally {
    db.close();
  }
}

/**
 * A native-client device grant for `userId` with one access and one refresh token, as the Rust
 * front's device flow (POST /api/auth/device/token) would have written them.
 * @returns {{ grantId: string, access: string, refresh: string }}
 */
function seedDeviceToken(dataDir, userId, { clientName = 'Synthetic device', now = Date.now() } = {}) {
  const db = new Database(path.join(dataDir, 'cowork.db'));
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const grantId = crypto.randomBytes(16).toString('hex');
    const access = `nva_${token()}`;
    const refresh = `nvr_${token()}`;
    db.transaction(() => {
      db.prepare('INSERT INTO device_grants(id,user_id,client_name,created_at,last_used_at,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?,?,?)')
        .run(grantId, userId, clientName, now, now, now + 30 * DAY, '127.0.0.1', 'synthetic-device');
      db.prepare('INSERT INTO device_tokens(token_hash,grant_id,kind,created_at,expires_at) VALUES(?,?,?,?,?)').run(digest(access), grantId, 'access', now, now + 60 * 60 * 1000);
      db.prepare('INSERT INTO device_tokens(token_hash,grant_id,kind,created_at,expires_at) VALUES(?,?,?,?,?)').run(digest(refresh), grantId, 'refresh', now, now + 7 * DAY);
    })();
    return { grantId, access, refresh };
  } finally {
    db.close();
  }
}

module.exports = { seedAccount, setUserFeatures, seedDeviceToken, digest };
